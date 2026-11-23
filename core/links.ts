import { randomBytes } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { connect, type Socket } from "node:net"
import { join } from "node:path"
import { FIN_QUIET_MS, validPort } from "./forwards"
import { listManifests, readConfig, validName, type Dirs } from "./state"
import { AsideeError, privateThere, type CheckResult, type LinkSupport, type Manifest, type Provider, type Session } from "./types"

// A link lets programs in one sandbox (from) connect to one port on another's loopback (to), on this machine. Inside
// `from`, a listener on a loopback address of the link's own, which /etc/hosts there names `to`, hands each connection
// to the daemon; the daemon relays it to `to` the way a forward does. No network is shared, the guard is not touched and
// nothing listens on this machine, so every network check keeps its meaning. A link is bound to both sandboxes' ids,
// and while open to both sandboxes' runs. A link can instead name an IPv4 address outside Asidee (to.address): the
// daemon then dials that address from this machine, and the link is bound to `from` only. Or it can name a public sandbox
// on a connected host (to.host): the daemon then relays over SSH through a lease the host's daemon holds for that
// sandbox's run and port, as a forward from this machine does, and the link is bound to `from` and to that machine's and
// sandbox's identities.

// Open at once per link; each costs `from` five processes, `to` one relay process and the daemon three engine sessions
// (docs/architecture.md says what that came to in tasks).
export const LINK_CONNECTIONS = 64
// Links from and to one sandbox, together.
export const LINKS_PER_SANDBOX = 16
// Open link connections in the whole daemon.
export const LINK_CONNECTIONS_TOTAL = 512
// New connections per second per link; past it they are refused.
export const OPENS_PER_SECOND = 20
// Lines per second from a listener past which it is treated as hostile and closed.
const LINES_PER_SECOND = 200
const HEARTBEAT_MS = 5000
// A link that failed to open, or whose listener stopped within STEADY_MS of opening, is tried again after RETRY_MS,
// doubling each time in a row up to RETRY_MAX_MS: each try runs the test, so `from` could otherwise keep the daemon
// working on the engine by ending its listener.
export const RETRY_MS = 30_000
export const RETRY_MAX_MS = 30 * 60_000
const STEADY_MS = 10 * 60_000
const READY_MS = 10_000
const WATCH_MS = 2000
// The loopback range links listen on inside `from`; gVisor answers on all of 127.0.0.0/8 without configuring it.
const ADDRESSES = "127.77.0."
const MARK = "# asidee-link"

type End = { name: string; sandboxId: string }
// An address outside Asidee, called `name` inside `from`.
type Outside = { name: string; address: string }
// A public sandbox on a connected host, bound to that machine's identity and the sandbox's.
type Hosted = { name: string; host: string; machineId: string; sandboxId: string }
type To = End | Outside | Hosted
const outside = (to: To): to is Outside => "address" in to
const hosted = (to: To): to is Hosted => "host" in to
const local = (to: To): to is End => !outside(to) && !hosted(to)
// The sandbox on this machine a link goes to, if it goes to one.
const toId = (link: LinkRecord) => local(link.to) ? link.to.sandboxId : undefined
export type LinkRecord = { id: string; from: End; to: To; port: number; address: string; createdAt: string; cut?: { at: string; reason: string } }
// fromOnly: the failure was seen only by what ran inside `from`, with nothing `from` could not have made up itself.
// unavailable: the link does not carry what it names (as opposed to reaching what it does not name).
export type Measure = { at: string; status: "pass" | "fail" | "unknown"; detail: string; fromOnly?: boolean; unavailable?: boolean }
export type LinkView = {
  // toAddress: the address outside Asidee a link to one dials; to is then only its name inside `from`. toHost: the
  // connected host whose sandbox `to` is.
  from: string; to: string; toAddress?: string; toHost?: string; port: number; address: string; createdAt: string
  state: "open" | "opening" | "waiting" | "closed" | "cut"; reason?: string; measured?: Measure; connections: number
  // The trust consequence, said with every link.
  trust: string
}

export const linkTrust = (from: string, to: string) => `${to} sees these connections as local (from 127.0.0.1 inside ${to}), so a service in ${to} that trusts local connections trusts ${from}.`
export const addressTrust = (from: string, address: string, port: number) => `${from} can open connections to ${address}:${port} as this machine, so whatever there trusts this machine trusts ${from}; and what that address can reach (the internet, the local network) is outside Asidee's checks.`
export const hostedTrust = (from: string, to: string, host: string) => `${to} on ${host} sees these connections as local (from 127.0.0.1 inside ${to}), so a service in ${to} that trusts local connections trusts ${from}. The connections go from this machine to ${host} over Asidee's SSH link to it.`
export const LINK_LIMITS = `A link carries TCP only, up to ${LINK_CONNECTIONS} connections at once, and is down while the daemon is not running.`

type Conn = { pid: number; sessions: Session[]; done: boolean }
// relayed: connections the daemon joined to their destination.
// What links to a sandbox on a connected host need from the machines this one routes to (core/machines.ts); tests
// replace it. linkMachine: the host's machine identity in this machine's records, undefined when it has none.
// linkIdentity: a sandbox's identity there, read with the routed `get`, which refuses a private one. linkRelay: a held
// relay to one port of the run of that sandbox now running there, refused if it is not the sandbox named; onEnd hears
// why it ended. linkAddresses: this machine's addresses for the host.
export type RemoteRelay = { generation: string; dial: () => Promise<Session>; close: (reason: string) => void }
export type RemoteLinks = {
  linkMachine(host: string): Promise<string | undefined>
  linkIdentity(host: string, name: string): Promise<{ machineId: string; sandboxId: string; running: boolean }>
  linkRelay(to: Hosted, port: number, onEnd: (reason: string) => void): Promise<RemoteRelay>
  linkAddresses(host: string): Promise<string[]>
}

// remote: for a link to a sandbox on a host, the relay its connections go through.
type Route = { record: LinkRecord; port: number; relayed: number; remote?: RemoteRelay; fromGen: string; toGen: string; listener: Session; conns: Map<number, Conn>; opens: number[]; lines: number[]; ended: boolean; gone: boolean
  finished: Promise<void>; markFinished: () => void; heartbeat: ReturnType<typeof setInterval> }

export class Links {
  private records?: LinkRecord[]
  private queue: Promise<unknown> = Promise.resolve()
  // Open links by id, and why each closed one is not open.
  private readonly live = new Map<string, Route>()
  private readonly why = new Map<string, string>()
  private readonly measured = new Map<string, Measure>()
  private readonly opening = new Set<string>()
  private readonly retries = new Map<string, { failures: number; at: number }>()
  // Why a link to a sandbox on a host waits (the host unreachable, the sandbox stopped or private there), and when it
  // is next tried: each try contacts the host, so not on every pass.
  private readonly waits = new Map<string, { why: string; at: number }>()
  // Other /etc/hosts lines that name a linked sandbox, per `from`.
  private readonly shadowed = new Map<string, string[]>()
  private total = 0
  private watch?: ReturnType<typeof setInterval>
  opensPerSecond = OPENS_PER_SECOND
  now = () => Date.now()
  // How the daemon reaches an address outside Asidee; tests replace it.
  dialAddress: (address: string, port: number) => Promise<Session> = dialTcp
  // How the daemon reaches sandboxes on connected hosts; the daemon sets it.
  remote?: RemoteLinks
  constructor(private readonly dirs: Dirs, private readonly providerOf: (manifest: Manifest) => Provider) {}

  private get file() { return join(this.dirs.state, "links.json") }
  private queued<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  private async load(): Promise<LinkRecord[]> {
    if (this.records) return this.records
    let text: string
    try { text = await readFile(this.file, "utf8") } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.records = []
      throw error
    }
    const damaged = (why: string) => new AsideeError("conflict", `${this.file} cannot be read (${why}). No link opens until it is fixed or deleted.`)
    let data: unknown
    try { data = JSON.parse(text) } catch { throw damaged("it is not JSON") }
    const end = (value: unknown): value is End => typeof value === "object" && value !== null && !("address" in value) && !("host" in value) && typeof (value as End).name === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test((value as End).name) && typeof (value as End).sandboxId === "string" && /^[0-9a-f]{32}$/.test((value as End).sandboxId)
    const address = (value: unknown): value is Outside => typeof value === "object" && value !== null && !("sandboxId" in value) && typeof (value as Outside).name === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test((value as Outside).name)
      && (() => { try { return validAddress((value as Outside).address) === (value as Outside).address } catch { return false } })()
    const remote = (value: unknown): value is Hosted => typeof value === "object" && value !== null && !("address" in value) && typeof (value as Hosted).name === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test((value as Hosted).name)
      && typeof (value as Hosted).host === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test((value as Hosted).host) && (value as Hosted).host !== "local"
      && typeof (value as Hosted).machineId === "string" && /^[0-9a-f]{32}$/.test((value as Hosted).machineId) && typeof (value as Hosted).sandboxId === "string" && /^[0-9a-f]{32}$/.test((value as Hosted).sandboxId)
    const links = (data as { version?: unknown; links?: unknown })?.links
    if ((data as { version?: unknown })?.version !== 1 || !Array.isArray(links)) throw damaged("unknown version")
    for (const link of links as LinkRecord[]) {
      if (typeof link !== "object" || link === null || typeof link.id !== "string" || !/^[0-9a-f]{8}$/.test(link.id) || !end(link.from) || !(end(link.to) || address(link.to) || remote(link.to)) || !Number.isInteger(link.port) || link.port < 1 || link.port > 65_535
        || typeof link.address !== "string" || !new RegExp(`^${ADDRESSES.replaceAll(".", "\\.")}\\d{1,3}$`).test(link.address) || typeof link.createdAt !== "string")
        throw damaged("a link record is malformed")
    }
    return this.records = links as LinkRecord[]
  }

  private async save(records: LinkRecord[]): Promise<void> {
    await mkdir(this.dirs.state, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp-${process.pid}`
    await writeFile(temp, `${JSON.stringify({ version: 1, links: records }, null, 2)}\n`, { mode: 0o600 }); await rename(temp, this.file)
    this.records = records
  }

  private support(manifest: Manifest): LinkSupport {
    if (manifest.spec.gpu) throw new AsideeError("usage", `${manifest.name} is a GPU container, and links to or from one are refused for now: a link's listener runs as root, which has no capabilities there, and the link checks were measured on sandboxes only.`)
    const support = this.providerOf(manifest).links
    if (!support || manifest.engine.capabilities?.loopbackRelay === false || manifest.engine.capabilities?.execStream === false) throw new AsideeError("dependency", `${manifest.engine.label} cannot link ${manifest.name} to another sandbox.`)
    return support
  }
  private generation(manifest: Manifest): Promise<string | undefined> { return this.providerOf(manifest).generation(manifest).catch(() => undefined) }

  // Records whose sandboxes still exist with the ids they were linked with (for a link to an address, `from` only), and
  // whose host is still the machine it was linked on; the rest are dropped, so a sandbox made again under a name, or a
  // machine enrolled again under an alias, never inherits a link. A host record that cannot be read drops nothing.
  private async current(): Promise<{ records: LinkRecord[]; manifests: Map<string, Manifest> }> {
    const manifests = new Map((await listManifests(this.dirs)).map((manifest) => [manifest.name, manifest]))
    const records = await this.load()
    const machines = new Map<string, string | undefined | null>()
    for (const link of records) if (hosted(link.to) && !machines.has(link.to.host))
      machines.set(link.to.host, this.remote ? await this.remote.linkMachine(link.to.host).catch(() => null) : null)
    const kept = records.filter((link) => manifests.get(link.from.name)?.id === link.from.sandboxId && (outside(link.to)
      || (hosted(link.to) ? [null, link.to.machineId].includes(machines.get(link.to.host)!) : manifests.get(link.to.name)?.id === link.to.sandboxId)))
    if (kept.length !== records.length) {
      for (const link of records) if (!kept.includes(link)) this.forgetRuntime(link.id, hosted(link.to) && manifests.get(link.from.name)?.id === link.from.sandboxId ? `The link ended: ${link.to.host} was removed from this machine's hosts.` : "The link ended: one of its sandboxes was removed.")
      await this.save(kept)
    }
    return { records: kept, manifests }
  }

  // Drops the links of a host that was removed, now rather than at the next pass.
  async prune(): Promise<void> { await this.queued(() => this.current()) }

  // With an address, `to` is the name `from` uses for it, and the daemon dials address:port from this machine. With a
  // host, `to` is a public sandbox on that connected host, reached through its daemon over SSH.
  async add(fromName: unknown, toName: unknown, portValue: unknown, addressValue?: unknown, hostValue?: unknown): Promise<LinkView> {
    const from = validName(fromName); const to = validName(toName); const port = validPort(portValue, "The port")
    const address = addressValue === undefined || addressValue === null || addressValue === "" ? undefined : validAddress(addressValue)
    const host = hostValue === undefined || hostValue === null || hostValue === "" ? undefined : validName(hostValue)
    if (address && host) throw new AsideeError("usage", "A link goes to an address or to a sandbox on another machine: give --address or --to-host, not both.")
    if (host === "local") throw new AsideeError("usage", "local is this machine: leave out --to-host to link two sandboxes here.")
    if (from === to) throw new AsideeError("usage", address ? `A link's name cannot be ${from}'s own name.` : host ? `Inside ${from}, ${to} means ${from} itself, so a sandbox of that name on ${host} cannot be linked to from it.` : "A sandbox cannot be linked to itself; its own loopback already reaches its ports.")
    if (to === "localhost") throw new AsideeError("usage", address ? "localhost cannot name a link: inside the sandbox that name means its own loopback." : "A sandbox named localhost cannot be linked to: inside the other sandbox that name means its own loopback.")
    // The host is asked before the records are held: it may be slow, and other links need not wait for it.
    let remote: Hosted | undefined
    if (host) {
      if (!this.remote) throw new AsideeError("dependency", "This daemon cannot reach other machines.")
      const machineId = await this.remote.linkMachine(host)
      if (!machineId) throw new AsideeError("not-found", `There is no host ${host}. See \`asd host list\`.`)
      const found = await this.remote.linkIdentity(host, to).catch((error: AsideeError) => {
        if (error.message === privateThere(to)) throw new AsideeError("not-found", `${to} is private on ${host}, so it cannot be linked to from this machine. To allow it, make it public on its own machine: run \`asd share ${to}\` on ${host}.`)
        throw new AsideeError(error.code ?? "runtime", `${to} on ${host} could not be looked up, so nothing was added: ${error.message}`)
      })
      if (found.machineId !== machineId) throw new AsideeError("identity-changed", `${host} answered as another machine than its record names. Nothing was added.`)
      remote = { name: to, host, machineId, sandboxId: found.sandboxId }
    }
    return this.queued(async () => {
      const { records, manifests } = await this.current()
      const fromManifest = manifests.get(from); const toManifest = address || host ? undefined : manifests.get(to)
      if (!fromManifest || (!address && !host && !toManifest)) throw new AsideeError("not-found", `There is no sandbox named ${!fromManifest ? from : to}.`)
      if (address && manifests.has(to)) throw new AsideeError("usage", `${to} is the name of a sandbox. Give the address another name, so that inside ${from} ${to} means one thing.`)
      if (host && manifests.has(to)) throw new AsideeError("usage", `${to} is also the name of a sandbox on this machine, so inside ${from} it would not mean one thing. A sandbox on ${host} can be linked to only under a name no sandbox here has.`)
      const ends = toManifest ? [fromManifest, toManifest] : [fromManifest]
      // A GPU container is refused first, whichever end it is.
      for (const manifest of ends) if (manifest.spec.gpu) this.support(manifest)
      for (const manifest of ends) this.support(manifest)
      const target: To = address ? { name: to, address } : remote ?? { name: to, sandboxId: toManifest!.id }
      const same = (other: To) => outside(other) ? outside(target) && other.address === target.address
        : hosted(other) ? hosted(target) && other.host === target.host && other.machineId === target.machineId && other.sandboxId === target.sandboxId
        : local(target) && other.sandboxId === target.sandboxId
      // Inside `from` one name is one place: /etc/hosts there has one line for it.
      const named = records.find((link) => link.from.sandboxId === fromManifest.id && link.to.name === to && !same(link.to))
      if (named) throw new AsideeError("conflict", `Inside ${from}, ${to} already names ${outside(named.to) ? `the address ${named.to.address}` : hosted(named.to) ? `the sandbox ${to} on ${named.to.host}` : `the sandbox ${to}`} (a link on port ${named.port}). Remove that link first with \`asd link remove ${from} ${to} --port ${named.port}\`.`)
      const existing = records.find((link) => link.from.sandboxId === fromManifest.id && link.to.name === to && same(link.to) && link.port === port)
      const others = records.filter((link) => link !== existing)
      for (const manifest of ends) {
        if (others.filter((link) => link.from.sandboxId === manifest.id || toId(link) === manifest.id).length >= LINKS_PER_SANDBOX)
          throw new AsideeError("conflict", `${manifest.name} already has ${LINKS_PER_SANDBOX} links, the most a sandbox may have. Remove one with \`asd link remove FROM TO --port PORT\`.`)
      }
      if (existing && !existing.cut && this.live.has(existing.id)) return this.view(existing, manifests)
      const used = new Set(others.filter((link) => link.from.sandboxId === fromManifest.id).map((link) => link.address))
      const listenAddress = others.find((link) => link.from.sandboxId === fromManifest.id && link.to.name === to)?.address
        ?? Array.from({ length: 250 }, (_, at) => `${ADDRESSES}${at + 2}`).find((candidate) => !used.has(candidate))!
      const record: LinkRecord = { id: existing?.id ?? randomBytes(4).toString("hex"), from: { name: from, sandboxId: fromManifest.id }, to: target, port, address: listenAddress, createdAt: existing?.createdAt ?? new Date().toISOString() }
      await this.save([...others, record])
      this.why.delete(record.id); this.retries.delete(record.id); this.waits.delete(record.id)
      const outcome = await this.open(record, manifests)
      if (outcome === "open" || outcome === "waiting") return this.view(record, manifests)
      // A link that was refused is not kept: nothing of it stays.
      const reason = this.measured.get(record.id)?.detail ?? this.why.get(record.id) ?? "it did not open"
      await this.save((await this.load()).filter((link) => link.id !== record.id))
      this.forgetRuntime(record.id)
      await this.writeHosts(fromManifest).catch(() => {})
      const refused = `The link from ${from} to ${to}:${port}${address ? ` (${address}:${port})` : host ? ` on ${host}` : ""} was not added`
      if (outcome === "cut") throw new AsideeError("check-failed", `${refused}: its test found that ${reason}`)
      if (outcome === "unmeasured") throw new AsideeError("probes-required", `${refused}: it could not be measured (${reason}). Only to allow links without that measurement: \`asd config set require-probes off\`.`)
      throw new AsideeError("runtime", `${refused}: ${reason}`)
    })
  }

  async list(name?: unknown): Promise<LinkView[]> {
    const only = name === undefined || name === null || name === "" ? undefined : validName(name)
    const { records, manifests } = await this.queued(() => this.current())
    if (only && !manifests.has(only)) throw new AsideeError("not-found", `There is no sandbox named ${only}.`)
    return Promise.all(records.filter((link) => !only || link.from.name === only || (!hosted(link.to) && link.to.name === only)).map((link) => this.view(link, manifests)))
  }

  async remove(fromName: unknown, toName: unknown, portValue: unknown): Promise<{ removed: { from: string; to: string; port: number }; measured: string }> {
    const from = validName(fromName); const to = validName(toName); const port = validPort(portValue, "The port")
    return this.queued(async () => {
      const { records, manifests } = await this.current()
      const record = records.find((link) => link.from.name === from && link.to.name === to && link.port === port)
      if (!record) throw new AsideeError("not-found", `There is no link from ${from} to ${to}:${port}. See \`asd link list\`.`)
      await this.save(records.filter((link) => link !== record))
      await this.closeRoute(this.live.get(record.id), "The link was removed.")
      this.forgetRuntime(record.id)
      const fromManifest = manifests.get(from)!
      if (!await this.generation(fromManifest)) return { removed: { from, to, port }, measured: `Not measured: ${from} is stopped, so nothing listens for the link there.` }
      await this.writeHosts(fromManifest).catch(() => {})
      // The listener ends with its input; give it a moment before calling an answer a failure.
      const closed = await retry(async () => !(await this.support(fromManifest).dial(fromManifest, record.address, port)).connected, 10)
      return { removed: { from, to, port }, measured: closed ? `Measured: ${record.address}:${port} now refuses connections inside ${from}.` : `${record.address}:${port} still accepted a connection inside ${from} after the link closed; something else in ${from} may listen there.` }
    })
  }

  // A removed sandbox takes its links with it, whichever end it was, and its links to addresses.
  forget(manifest: Manifest): Promise<void> {
    return this.queued(async () => {
      const records = await this.load()
      const gone = records.filter((link) => link.from.sandboxId === manifest.id || toId(link) === manifest.id)
      if (!gone.length) return
      for (const link of gone) this.forgetRuntime(link.id, `The link ended: ${manifest.name} was removed.`)
      await this.save(records.filter((link) => !gone.includes(link)))
      const manifests = new Map((await listManifests(this.dirs)).map((entry) => [entry.name, entry]))
      for (const link of gone) {
        const other = manifests.get(link.from.name)
        if (other && other.id === link.from.sandboxId && await this.generation(other)) await this.writeHosts(other).catch(() => {})
      }
    })
  }

  // A sandbox is stopping or being removed: every link touching it closes now. They open again at the next sync.
  end(name: string, reason: string): void {
    for (const route of [...this.live.values()]) {
      if (route.record.from.name !== name && (!local(route.record.to) || route.record.to.name !== name)) continue
      this.live.delete(route.record.id); this.why.set(route.record.id, `${name} stopped`)
      void this.closeRoute(route, reason)
    }
  }

  close(): void { for (const route of [...this.live.values()]) { this.live.delete(route.record.id); void this.closeRoute(route, "The link ended: the Asidee daemon stopped.") } }

  // Makes the running links match the records: drops links of removed sandboxes, restores each running `from`'s
  // /etc/hosts lines, and opens (and measures) each link whose two sandboxes run and that is not waiting to be tried
  // again. A start through Asidee (`only`) tries that sandbox's links now.
  sync(only?: string): Promise<void> {
    return this.queued(async () => {
      const { records, manifests } = await this.current()
      const touched = records.filter((link) => !only || link.from.name === only || (local(link.to) && link.to.name === only))
      if (only) for (const link of touched) { this.retries.delete(link.id); const wait = this.waits.get(link.id); if (wait) wait.at = 0 }
      for (const name of new Set(touched.map((link) => link.from.name))) {
        const from = manifests.get(name)!
        if (await this.generation(from)) await this.writeHosts(from).catch(() => {})
      }
      for (const link of touched) await this.open(link, manifests).catch(() => {})
    })
  }

  private async open(record: LinkRecord, manifests: Map<string, Manifest>): Promise<"open" | "waiting" | "cut" | "unmeasured" | "failed"> {
    if (record.cut) return "cut"
    if (this.live.has(record.id)) return "open"
    const end = record.to
    const from = manifests.get(record.from.name)!; const to = local(end) ? manifests.get(end.name)! : undefined
    const [fromGen, toGen] = await Promise.all([this.generation(from), to ? this.generation(to) : ""])
    if (!fromGen || toGen === undefined) { this.why.set(record.id, `${!fromGen ? from.name : to!.name} is stopped`); return "waiting" }
    if (this.now() < (this.retries.get(record.id)?.at ?? 0)) return "failed"
    if (hosted(end) && this.now() < (this.waits.get(record.id)?.at ?? 0)) return "waiting"
    this.opening.add(record.id)
    let remote: RemoteRelay | undefined; let kept = false
    try {
      if (hosted(end)) {
        const reached = await this.reach(record, end, from)
        if (typeof reached === "string") return reached
        remote = reached
      }
      await this.providerOf(from).prepareLoopback(from); if (to) await this.providerOf(to).prepareLoopback(to)
      await this.writeHosts(from)
      const measured = to ? await this.measure(record, from, to, fromGen, toGen) : remote ? await this.measureHosted(record, from, fromGen, remote) : await this.measureOutside(record, from, fromGen)
      this.measured.set(record.id, measured)
      if (measured.status === "fail") { await this.cut(record, measured.detail, from); return "cut" }
      if (measured.status === "unknown" && (await readConfig(this.dirs)).requireProbes) { this.failed(record.id, `it could not be measured: ${measured.detail}`); return "unmeasured" }
      const route = await this.route(record, from, to, fromGen, remote?.generation ?? toGen, record.port, remote)
      const opened = this.now()
      route.finished.then(() => {
        if (this.live.get(record.id) === route) {
          this.live.delete(record.id)
          if (this.now() - opened >= STEADY_MS) { this.retries.delete(record.id); this.why.set(record.id, "its listener stopped; it opens again within 30 seconds") }
          else this.failed(record.id, "its listener stopped soon after it opened")
        }
        // After the above: the relay's end, heard back, then finds the link no longer open.
        remote?.close("The link closed.")
      })
      kept = true
      this.live.set(record.id, route); this.why.delete(record.id)
      this.watching()
      return "open"
    } catch (error) {
      this.failed(record.id, (error as Error).message)
      return "failed"
    } finally {
      this.opening.delete(record.id)
      if (!kept) remote?.close("The link did not open.")
    }
  }

  // The relay a link to a sandbox on a host goes through, or why it waits. A link whose host record was removed or
  // replaced, or whose sandbox was removed or made again there, is dropped: it never follows a name.
  private async reach(record: LinkRecord, end: Hosted, from: Manifest): Promise<RemoteRelay | "waiting" | "failed"> {
    const wait = (why: string) => { this.waits.set(record.id, { why, at: this.now() + RETRY_MS }); return "waiting" as const }
    const drop = async (why: string) => {
      await this.save((await this.load()).filter((link) => link.id !== record.id))
      this.forgetRuntime(record.id); this.why.set(record.id, why)
      await this.writeHosts(from).catch(() => {})
      return "failed" as const
    }
    if (!this.remote) return wait("this daemon cannot reach other machines")
    let machineId: string | undefined
    try { machineId = await this.remote.linkMachine(end.host) } catch (error) { return wait((error as Error).message) }
    if (machineId !== end.machineId) return drop(`the link ended: ${end.host} is no longer the machine it was made for`)
    let relay: RemoteRelay | undefined
    try {
      relay = await this.remote.linkRelay(end, record.port, (reason) => {
        const route = this.live.get(record.id)
        if (!route || route.remote !== relay) return
        this.live.delete(record.id); this.why.set(record.id, `its relay to ${end.host} ended (${reason}); it opens again within 30 seconds of ${end.name} running there`)
        void this.closeRoute(route, `The link ended: ${reason}`)
      })
    } catch (error) {
      const { code, message } = error as AsideeError
      if (code === "identity-changed") return drop(`the link ended: ${message}`)
      if (message === `There is no sandbox named ${end.name}.`) return drop(`the link ended: ${end.name} was removed on ${end.host}`)
      if (message === privateThere(end.name)) return wait(`${end.name} is private on ${end.host}; it opens once it is made public there (\`asd share ${end.name}\` on ${end.host})`)
      if (message.startsWith(`${end.name} is not running.`)) return wait(`${end.name} is stopped on ${end.host}`)
      return wait(`${end.host} cannot be used now: ${message}`)
    }
    this.waits.delete(record.id)
    return relay
  }

  private failed(id: string, why: string): void {
    const failures = (this.retries.get(id)?.failures ?? 0) + 1
    const wait = Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS)
    this.retries.set(id, { failures, at: this.now() + wait })
    this.why.set(id, `${why}; it is tried again in ${wait < 60_000 ? `${wait / 1000} seconds` : `${Math.round(wait / 60_000)} minutes`}${failures > 1 ? ` (${failures} failures in a row)` : ""}`)
  }

  private async cut(record: LinkRecord, reason: string, from: Manifest): Promise<void> {
    const records = await this.load()
    record.cut = { at: new Date().toISOString(), reason }
    await this.save(records.map((link) => link.id === record.id ? record : link))
    const route = this.live.get(record.id); this.live.delete(record.id)
    await this.closeRoute(route, "The link was cut: its test failed.")
    if (await this.generation(from)) await this.writeHosts(from).catch(() => {})
  }

  private forgetRuntime(id: string, reason = "The link was removed."): void {
    const route = this.live.get(id); this.live.delete(id)
    void this.closeRoute(route, reason)
    this.why.delete(id); this.measured.delete(id); this.retries.delete(id); this.waits.delete(id)
  }

  // One line per linked sandbox, for every link from this sandbox that is not cut; nothing else in the file changes.
  private async writeHosts(from: Manifest): Promise<void> {
    const records = (await this.load()).filter((link) => link.from.sandboxId === from.id && !link.cut)
    const names = new Map(records.map((link) => [link.to.name, link.address]))
    const content = await this.support(from).hosts(from, [...names].map(([name, address]) => `${address}\t${name}\t${MARK}`))
    const shadowed = content.split("\n").filter((line) => !line.endsWith(MARK) && line.trim().split(/\s+/).slice(1).some((word) => names.has(word)))
    this.shadowed.set(from.id, shadowed.flatMap((line) => line.trim().split(/\s+/).slice(1).filter((word) => names.has(word))))
  }

  // The live test of one link, on two ports of `to` the link does not name. A test value must come through a route the
  // link opens for the test, and stop coming once that route closes; and `to`'s other port must not answer from `from`,
  // through the link's address or at `to`'s network address, while it answers `to`'s own loopback and the engine's host.
  private async measure(record: LinkRecord, from: Manifest, to: Manifest, fromGen: string, toGen: string): Promise<Measure> {
    const at = new Date().toISOString()
    const unknown = (detail: string): Measure => ({ at, status: "unknown", detail: `Not checked: ${detail}, so a blocked attempt would prove nothing.` })
    const fromSupport = this.support(from); const toSupport = this.support(to)
    // Not a port any link from `from` or to `to` names: one answering through another link is not this link reaching it.
    const named = new Set((await this.load()).filter((link) => link.from.sandboxId === from.id || toId(link) === to.id).map((link) => link.port))
    const [near, far] = randomPorts(named)
    const [one, two] = [randomBytes(8).toString("hex"), randomBytes(8).toString("hex")]
    const canaries: Session[] = []
    try {
      canaries.push(await toSupport.canary(to, near, one, false), await toSupport.canary(to, far, two, true))
      const loopback = (port: number, value: string) => retry(async () => (await collect(await this.providerOf(to).dialLoopback(to, port))).includes(value))
      if (!await loopback(near, one) || !await loopback(far, two)) return unknown(`a test listener in ${to.name} did not answer on its own loopback`)
      const ip = await toSupport.address(to)
      if (!ip) return unknown(`${to.name}'s network address could not be read`)
      if (!await retry(async () => (await toSupport.hostDial(to, ip, far)).includes(two))) return unknown(`${to.name}'s network address did not answer a test connection from the engine's host`)
      const route = await this.route(record, from, to, fromGen, toGen, near)
      let carried: boolean
      try { carried = await retry(async () => (await fromSupport.dial(from, to.name, near)).received.includes(one)) }
      finally { await this.closeRoute(route, "The link's test ended.") }
      // Its controls answered, so a value that does not come through is the link failing, not the test.
      if (!carried) {
        const shadowed = this.shadowed.get(from.id)?.includes(to.name) ? ` (another line of /etc/hosts in ${from.name} names ${to.name} first)` : ""
        return { at, status: "fail", unavailable: true, detail: `a test value on ${to.name}'s port ${near} did not come through the link from ${from.name} by the name ${to.name}${shadowed}, though it answered ${to.name}'s own loopback.` }
      }
      // The first value already came through to `from`, so `from` could repeat it; the second it has never been given.
      const reached: string[] = []
      const stale = (await fromSupport.dial(from, record.address, near)).received.includes(one)
      if (stale) reached.push(`after its test route closed, ${from.name} still reached ${to.name}'s port ${near}`)
      if ((await fromSupport.dial(from, to.name, far)).received.includes(two)) reached.push(`${from.name} reached ${to.name}'s port ${far} through the link's address, which the link does not name`)
      if ((await fromSupport.dial(from, ip, far)).received.includes(two)) reached.push(`${from.name} reached ${to.name} at its network address ${ip}:${far}`)
      if (reached.length) return { at, status: "fail", fromOnly: stale && reached.length === 1, detail: `${reached.join("; ")}.` }
      return { at, status: "pass", detail: `A test value on ${to.name}'s port ${near} came through the link from ${from.name}, and stopped once that test route closed; ${to.name}'s port ${far} answered ${to.name}'s own loopback and the engine's host, and did not answer from ${from.name} through the link's address or at ${ip}. The attempts from ${from.name} used programs inside it, which its root could replace. Independently, the daemon dials only the link's own port, and the guard drops traffic between sandbox networks (Cannot reach other sandboxes).` }
    } catch (error) {
      return unknown(`the test could not run (${(error as Error).message})`)
    } finally { for (const canary of canaries) canary.close("The link's test ended.") }
  }

  // The test of a link to an address outside Asidee, where no test listener can run. The daemon must reach the address
  // (else a blocked attempt from `from` proves nothing); `from` must not reach it directly; and a connection made in
  // `from` through a test route, by the link's name, must be relayed by the daemon to the address.
  private async measureOutside(record: LinkRecord, from: Manifest, fromGen: string): Promise<Measure> {
    const at = new Date().toISOString()
    const { name, address } = record.to as Outside; const port = record.port
    const unknown = (detail: string): Measure => ({ at, status: "unknown", detail: `Not checked: ${detail}.` })
    const fromSupport = this.support(from)
    try {
      try { (await this.dialAddress(address, port)).close("The link's test ended.") }
      catch (error) { return unknown(`the daemon could not open a TCP connection to ${address}:${port} from this machine (${(error as Error).message}), so a blocked attempt from ${from.name} would prove nothing`) }
      if ((await fromSupport.dial(from, address, port)).connected) return { at, status: "fail", detail: `${from.name} opened a connection to ${address}:${port} directly, not through the link.` }
      // A test route on a port no link from `from` names, relayed to the link's own address and port.
      const [near] = randomPorts(new Set((await this.load()).filter((link) => link.from.sandboxId === from.id).map((link) => link.port)))
      const route = await this.route(record, from, undefined, fromGen, "", near)
      let carried: boolean
      try { carried = await retry(async () => { await fromSupport.dial(from, name, near); return route.relayed > 0 }) }
      finally { await this.closeRoute(route, "The link's test ended.") }
      if (!carried) {
        const shadowed = this.shadowed.get(from.id)?.includes(name) ? ` (another line of /etc/hosts in ${from.name} names ${name} first)` : ""
        return { at, status: "fail", unavailable: true, detail: `a test connection from ${from.name} to ${name}:${near} was not relayed to ${address}:${port}${shadowed}, though the daemon reached ${address}:${port} itself.` }
      }
      return { at, status: "pass", detail: `The daemon opened a connection to ${address}:${port} from this machine; a test connection from ${from.name} to ${name}:${near} was relayed by the daemon to ${address}:${port}; and ${from.name} could not connect to ${address}:${port} directly. The attempts from ${from.name} used programs inside it, which its root could replace, and the direct one shows only that it failed, not why. Independently, the daemon dials only the link's own address and port. Not checked: what the service at ${address}:${port} does with the connections, and what that address can reach (the internet, the local network); that is outside Asidee's checks.` }
    } catch (error) {
      return unknown(`the test could not run (${(error as Error).message})`)
    }
  }

  // The test of a link to a sandbox on a host, where no test listener can run: the host's daemon offers none. The relay
  // is open, so the host's daemon holds a lease on the sandbox's run and port; a connection made in `from` through a
  // test route, by the link's name, must be relayed through it; and `from` must not reach the host directly at the
  // addresses this machine reaches it at.
  private async measureHosted(record: LinkRecord, from: Manifest, fromGen: string, remote: RemoteRelay): Promise<Measure> {
    const at = new Date().toISOString()
    const { name, host } = record.to as Hosted; const port = record.port
    const fromSupport = this.support(from)
    try {
      let addresses: string[] = []; let unread = ""
      try { addresses = (await this.remote!.linkAddresses(host)).filter((address) => { try { return validAddress(address) === address } catch { return false } }) }
      catch (error) { unread = (error as Error).message }
      if (!addresses.length && !unread) unread = "it has no IPv4 address this machine could use"
      const ports = [...new Set([port, 22])]
      const reached: string[] = []
      for (const address of addresses) for (const each of ports) if ((await fromSupport.dial(from, address, each)).connected) reached.push(`${address}:${each}`)
      if (reached.length) return { at, status: "fail", detail: `${from.name} opened a connection to ${host} directly (${reached.join(", ")}), not through the link.` }
      // A test route on a port no link from `from` names, relayed through the link's own relay to its port.
      const [near] = randomPorts(new Set((await this.load()).filter((link) => link.from.sandboxId === from.id).map((link) => link.port)))
      const route = await this.route(record, from, undefined, fromGen, remote.generation, near, remote)
      let carried: boolean
      try { carried = await retry(async () => { await fromSupport.dial(from, name, near); return route.relayed > 0 }) }
      finally { await this.closeRoute(route, "The link's test ended.") }
      if (!carried) {
        const shadowed = this.shadowed.get(from.id)?.includes(name) ? ` (another line of /etc/hosts in ${from.name} names ${name} first)` : ""
        return { at, status: "fail", unavailable: true, detail: `a test connection from ${from.name} to ${name}:${near} was not relayed to ${name} on ${host}${shadowed}, though ${host}'s daemon holds a relay to ${name}'s port ${port}.` }
      }
      const direct = unread ? `Not checked: whether ${from.name} can reach ${host} directly, since this machine's address for ${host} could not be read (${unread}).`
        : `${from.name} could not connect to ${host} directly at ${addresses.join(" or ")} on port ${ports.join(" or ")}, the addresses this machine's SSH reaches it at.`
      return { at, status: "pass", detail: `A test connection from ${from.name} to ${name}:${near} was carried by the daemon over SSH to ${host}, whose daemon opened a relay to port ${port} on ${name}'s loopback for the run of ${name} the link holds. ${direct} The attempts from ${from.name} used programs inside it, which its root could replace, and the direct ones show only that they failed, not why. Independently, ${host}'s daemon relays the link's connections only to that port of that run. Not checked: ${name}'s address on ${host}'s engine network (${host}'s daemon does not report it); whether a service answers on ${name}'s port ${port}; and that ${name}'s other ports do not answer through the link: no test listener can run in ${name} through what ${host}'s daemon offers.` }
    } catch (error) {
      return { at, status: "unknown", detail: `Not checked: the test could not run (${(error as Error).message}).` }
    }
  }

  // A listener in `from` whose connections are relayed to `port` on `to`'s loopback, for one run of each. The listener's
  // output is treated as hostile: it may only say "r", "e REASON" and "o PID", in short lines, at a bounded rate, and
  // the destination is never taken from it.
  // For a link to an address (no `to`), they are relayed to the link's own address and port, whatever `port` is; for
  // one to a sandbox on a host, through its relay (remote), which goes only to the link's own port.
  private async route(record: LinkRecord, from: Manifest, to: Manifest | undefined, fromGen: string, toGen: string, port: number, remote?: RemoteRelay): Promise<Route> {
    const support = this.support(from)
    const dir = `/.asidee/links/${record.id}.${port}`
    const listener = await support.listen(from, dir, record.address, port)
    let markFinished: () => void = () => {}
    const finished = new Promise<void>((resolve) => { markFinished = resolve })
    const route: Route = { record, port, relayed: 0, remote, fromGen, toGen, listener, conns: new Map(), opens: [], lines: [], ended: false, gone: false, finished, markFinished,
      heartbeat: setInterval(() => { if (!route.ended) listener.write(Buffer.from("p\n")) }, HEARTBEAT_MS) }
    route.heartbeat.unref?.()
    let ready = false; let buffer = ""
    let settle: (error?: string) => void = () => {}
    const started = new Promise<string | undefined>((resolve) => { settle = resolve })
    const timer = setTimeout(() => settle(`its listener in ${from.name} did not start within ${READY_MS / 1000} seconds`), READY_MS)
    const hostile = (why: string) => { settle(why); void this.closeRoute(route, `The link's listener was closed: ${why}.`) }
    listener.on("output", (stream, bytes) => {
      if (stream !== "stdout" || route.ended) return
      buffer += Buffer.from(bytes).toString("latin1")
      for (let at = buffer.indexOf("\n"); at >= 0 && !route.ended; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1)
        const now = Date.now(); route.lines = route.lines.filter((time) => now - time < 1000); route.lines.push(now)
        if (route.lines.length > LINES_PER_SECOND) return hostile("it printed more lines than a link accepts")
        if (!ready) {
          if (line === "r") { ready = true; settle(); continue }
          const failed = /^e ([a-z ]{1,24})$/.exec(line)
          return failed ? hostile(`its listener could not start (${failed[1]}${failed[1] === "bind" ? `: ${record.address}:${port} may be in use inside ${from.name}` : ""})`) : hostile("it printed a line a link does not accept")
        }
        const opened = /^o ([1-9]\d{0,9})$/.exec(line)
        if (!opened || route.conns.has(Number(opened[1]))) return hostile("it printed a line a link does not accept")
        this.accept(route, Number(opened[1]), from, to)
      }
      if (buffer.length > 32) hostile("it printed a line a link does not accept")
    })
    // Its input waits for the deny lines it has not read yet; until then its lines are not read either.
    listener.on("drain", () => listener.resume())
    listener.on("end", () => { route.gone = true; settle(`its listener in ${from.name} ended`); void this.closeRoute(route, "The link's listener ended.") })
    const failed = await started
    clearTimeout(timer)
    if (failed) { await this.closeRoute(route, failed); throw new AsideeError("runtime", failed) }
    return route
  }

  private accept(route: Route, pid: number, from: Manifest, to: Manifest | undefined): void {
    const now = Date.now(); route.opens = route.opens.filter((time) => now - time < 1000)
    if (route.conns.size >= LINK_CONNECTIONS || this.total >= LINK_CONNECTIONS_TOTAL || route.opens.length >= this.opensPerSecond) return this.deny(route, pid)
    route.opens.push(now)
    const conn: Conn = { pid, sessions: [], done: false }
    route.conns.set(pid, conn); this.total++
    void (async () => {
      // As a forward does, each connection first checks that `to` is still the run the link was opened for.
      if (to && await this.generation(to) !== route.toGen) return this.finish(route, conn)
      // Each half is held as it arrives, so what it prints, or its end, while the other is still connecting waits for the pump.
      const end = route.record.to
      const [halves, target] = await Promise.allSettled([this.support(from).attach(from, `/.asidee/links/${route.record.id}.${route.port}`, pid),
        outside(end) ? this.dialAddress(end.address, route.record.port) : route.remote ? route.remote.dial() : this.providerOf(to!).dialLoopback(to!, route.port, true)])
      if (halves.status === "fulfilled") conn.sessions.push(halves.value.fromClient, halves.value.toClient)
      if (target.status === "fulfilled") conn.sessions.push(target.value)
      if (halves.status !== "fulfilled" || target.status !== "fulfilled" || conn.done || route.ended) return this.finish(route, conn)
      route.relayed++
      pump(halves.value.fromClient, halves.value.toClient, target.value, () => this.finish(route, conn))
    })().catch(() => this.finish(route, conn))
  }

  private finish(route: Route, conn: Conn): void {
    if (conn.done) return
    conn.done = true; route.conns.delete(conn.pid); this.total--
    for (const session of conn.sessions) session.close("The link connection ended.")
    this.deny(route, conn.pid)
  }

  // Ends a connection inside `from` (its processes and its waiting files), whether or not it was relayed.
  private deny(route: Route, pid: number): void {
    if (!route.ended && !route.listener.write(Buffer.from(`x ${pid}\n`))) route.listener.pause()
  }

  // Ends a listener and every connection it carries. Its input is closed first, so it ends its own processes and the
  // port stops answering before this returns; the session is closed after that, or after five seconds.
  private async closeRoute(route: Route | undefined, reason: string): Promise<void> {
    if (!route || route.ended) return
    route.ended = true; clearInterval(route.heartbeat)
    for (const conn of [...route.conns.values()]) this.finish(route, conn)
    if (!route.gone) {
      const ended = new Promise<void>((resolve) => { route.listener.on("end", () => resolve()); setTimeout(resolve, 5000).unref?.() })
      route.listener.end()
      await ended
    }
    route.listener.close(reason)
    route.markFinished()
  }

  // Every two seconds, an open link whose sandboxes' runs changed closes; the next sync opens it for the new runs.
  private watching(): void {
    if (this.watch) return
    let checking = false
    this.watch = setInterval(async () => {
      if (checking) return
      if (!this.live.size) { clearInterval(this.watch); this.watch = undefined; return }
      checking = true
      try {
        const manifests = new Map((await listManifests(this.dirs).catch(() => [])).map((manifest) => [manifest.name, manifest]))
        for (const route of [...this.live.values()]) {
          const end = route.record.to
          // A link to a sandbox on a host ends with its relay instead (reach).
          const from = manifests.get(route.record.from.name); const to = local(end) ? manifests.get(end.name) : undefined
          const current = from?.id === route.record.from.sandboxId && (!local(end) || to?.id === end.sandboxId)
            && await this.generation(from) === route.fromGen && (!local(end) || await this.generation(to!) === route.toGen)
          if (current || this.live.get(route.record.id) !== route) continue
          this.live.delete(route.record.id); this.why.set(route.record.id, "a sandbox it joins stopped or restarted; it opens again within 30 seconds of both running")
          void this.closeRoute(route, "The link ended: a sandbox it joins stopped or restarted.")
        }
      } finally { checking = false }
    }, WATCH_MS)
    this.watch.unref?.()
  }

  private async view(record: LinkRecord, manifests: Map<string, Manifest>): Promise<LinkView> {
    const end = record.to
    const base = { from: record.from.name, to: end.name, ...(outside(end) ? { toAddress: end.address } : {}), ...(hosted(end) ? { toHost: end.host } : {}), port: record.port, address: record.address, createdAt: record.createdAt, measured: this.measured.get(record.id),
      trust: outside(end) ? addressTrust(record.from.name, end.address, record.port) : hosted(end) ? hostedTrust(record.from.name, end.name, end.host) : linkTrust(record.from.name, end.name) }
    const route = this.live.get(record.id)
    if (record.cut) return { ...base, state: "cut", reason: `cut ${record.cut.at}: ${record.cut.reason}`, connections: 0 }
    if (route) return { ...base, state: "open", connections: route.conns.size }
    if (this.opening.has(record.id)) return { ...base, state: "opening", connections: 0 }
    const stopped = [] as string[]
    for (const end of local(record.to) ? [record.from, record.to] : [record.from]) { const manifest = manifests.get(end.name); if (!manifest || !await this.generation(manifest)) stopped.push(end.name) }
    if (stopped.length) return { ...base, state: "waiting", reason: `${stopped.join(" and ")} ${stopped.length > 1 ? "are" : "is"} stopped`, connections: 0 }
    const wait = this.waits.get(record.id)
    if (wait) return { ...base, state: "waiting", reason: wait.why, connections: 0 }
    return { ...base, state: "closed", reason: this.why.get(record.id) ?? "it opens within 30 seconds", connections: 0 }
  }

  // The disclosure on both ends' checklists, from the records and the links open now.
  async check(manifest: Manifest): Promise<CheckResult> {
    let records: LinkRecord[]
    try { records = (await this.load()).filter((link) => link.from.sandboxId === manifest.id || toId(link) === manifest.id) }
    catch (error) { return { id: "links", status: "info", evidence: "inspected", detail: (error as Error).message } }
    if (!records.length) return { id: "links", status: "info", evidence: "none", detail: "None. `asd link add FROM TO --port PORT` lets programs in one sandbox reach one port on another's loopback through the daemon, `--address` one port of an address outside Asidee, and `--to-host` one port of a public sandbox on a connected host; no network is shared." }
    const manifests = new Map((await listManifests(this.dirs)).map((entry) => [entry.name, entry]))
    const lines = await Promise.all(records.map(async (link) => {
      const view = await this.view(link, manifests)
      const state = view.state === "open" ? "open" : `${view.state}, ${view.reason}`
      return link.from.sandboxId === manifest.id
        ? `To ${link.to.name}${outside(link.to) ? ` (${link.to.address}, outside Asidee)` : hosted(link.to) ? ` on ${link.to.host}` : ""} on port ${link.port}: ${state}; inside ${manifest.name}, ${link.to.name} is ${link.address}.${this.shadowed.get(manifest.id)?.includes(link.to.name) ? ` Another line in /etc/hosts also names ${link.to.name}; programs may resolve it there first.` : ""} ${view.trust}`
        : `From ${link.from.name} on port ${link.port}: ${state}. ${view.trust}`
    }))
    return { id: "links", status: "info", evidence: "inspected", detail: `${lines.join(" ")} ${LINK_LIMITS}` }
  }

  // The blocking check: each open link touching this sandbox is tested live, and a link that fails is cut. Only a link
  // that reaches what it does not name fails the check, which stops the sandbox being verified. One that does not carry
  // what it names is reported and stops neither sandbox, whichever is verified: either end can break it (`from` by its
  // /etc/hosts or its relay, `to` by its relay or its service), so counting it would let one sandbox have the other
  // stopped. Of the reaching failures, one seen only inside `from` (the closed test route, whose value `from` was
  // given) does not fail `to`'s check either. The others need the second test value, which only `to`'s test listener
  // holds.
  scope(manifest: Manifest): Promise<CheckResult> {
    return this.queued(async () => {
      let records: LinkRecord[]; let manifests: Map<string, Manifest>
      try { ({ records, manifests } = await this.current()) }
      catch (error) { return { id: "link-scope", status: "unknown", evidence: "none", detail: (error as Error).message } as CheckResult }
      const mine = records.filter((link) => (link.from.sandboxId === manifest.id || toId(link) === manifest.id) && !link.cut)
      if (!mine.length) return { id: "link-scope", status: "info", evidence: "none", detail: "No links: nothing to measure. Other sandboxes are covered by \"Cannot reach other sandboxes\"." }
      const open = mine.filter((link) => this.live.has(link.id))
      if (!open.length) return { id: "link-scope", status: "info", evidence: "none", detail: `No open links to measure now: ${(await Promise.all(mine.map((link) => this.view(link, manifests)))).map((view) => `${view.from} to ${view.to}:${view.port} is ${view.state} (${view.reason})`).join("; ")}. Each is measured when it opens.` }
      const results: Array<{ link: LinkRecord; measured: Measure }> = []
      for (const link of open) {
        const route = this.live.get(link.id)!
        const from = manifests.get(link.from.name)!; const to = local(link.to) ? manifests.get(link.to.name)! : undefined
        // Puts back Asidee's lines in `from`'s /etc/hosts if they were changed, and notes any other line naming `to`.
        await this.writeHosts(from).catch(() => {})
        const measured = to ? await this.measure(link, from, to, route.fromGen, route.toGen) : route.remote ? await this.measureHosted(link, from, route.fromGen, route.remote) : await this.measureOutside(link, from, route.fromGen)
        this.measured.set(link.id, measured)
        if (measured.status === "fail") await this.cut(link, measured.detail, from)
        results.push({ link, measured })
      }
      const excused = ({ link, measured }: { link: LinkRecord; measured: Measure }) => measured.status === "fail" && !measured.unavailable && measured.fromOnly === true && toId(link) === manifest.id
      const blocking = (entry: { link: LinkRecord; measured: Measure }) => entry.measured.status === "fail" && !entry.measured.unavailable && !excused(entry)
      const status = results.some(blocking) ? "fail" : results.some((entry) => entry.measured.status === "unknown") ? "unknown"
        : results.some((entry) => entry.measured.status === "pass") ? "pass" : "info"
      const detail = results.map((entry) => `${entry.link.from.name} to ${entry.link.to.name}:${entry.link.port}: ${entry.measured.detail}${entry.measured.status === "fail" ? " The link was cut." : ""}${entry.measured.unavailable ? " A link that does not carry what it names stops neither sandbox." : ""}${excused(entry) ? ` This was seen only inside ${entry.link.from.name}, so ${manifest.name} is not stopped for it.` : ""}`).join(" ")
      return { id: "link-scope", status, evidence: status === "unknown" ? "none" : "probed", detail } as CheckResult
    })
  }

  // For the net-peers detail: links are paths through the daemon, not network paths.
  async peers(manifest: Manifest): Promise<string> {
    const records = (await this.load().catch(() => [])).filter((link) => !link.cut && (link.from.sandboxId === manifest.id || toId(link) === manifest.id))
    if (!records.length) return ""
    return ` Links are not network paths: through the daemon, ${records.map((link) => link.from.sandboxId === manifest.id ? outside(link.to) ? `this sandbox reaches ${link.to.address} (named ${link.to.name}, outside Asidee) on port ${link.port}` : hosted(link.to) ? `this sandbox reaches ${link.to.name} on ${link.to.host} on port ${link.port}` : `this sandbox reaches ${link.to.name} on port ${link.port}` : `${link.from.name} reaches this sandbox on port ${link.port}`).join(", ")}; see "Links reach only the sandboxes and ports they name".`
  }
}

// Bytes between one accepted connection's two halves in `from` and its relay in `to`, each direction waiting for the
// other side to take what it was given. The client's end of input reaches `to` as a half-close, and the connection then
// ends once `to` has been silent for quietMs; when `to`'s side ends, the client's connection closes. Exported for tests.
export function pump(fromClient: Session, toClient: Session, target: Session, finish: () => void, quietMs = FIN_QUIET_MS): void {
  let quiet: ReturnType<typeof setTimeout> | undefined
  const waitQuietly = () => { clearTimeout(quiet); quiet = setTimeout(finish, quietMs); quiet.unref?.() }
  const clean = (exit: { code?: number; error?: string }) => exit.error === undefined && exit.code === 0
  fromClient.on("output", (stream, bytes) => { if (stream === "stdout" && !target.write(bytes)) fromClient.pause() })
  target.on("drain", () => fromClient.resume())
  fromClient.on("end", (exit) => { if (clean(exit)) { waitQuietly(); target.end() } else { clearTimeout(quiet); finish() } })
  target.on("output", (stream, bytes) => {
    if (stream !== "stdout") return
    if (quiet) waitQuietly()
    if (!toClient.write(bytes)) target.pause()
  })
  toClient.on("drain", () => target.resume())
  target.on("end", (exit) => { if (clean(exit)) toClient.end(); else { clearTimeout(quiet); finish() } })
  toClient.on("end", () => { clearTimeout(quiet); finish() })
  for (const session of [fromClient, toClient, target]) session.resume()
}

// What a session prints within three seconds, or until it ends.
function collect(session: Session, ms = 3000): Promise<string> {
  return new Promise((resolve) => {
    let text = ""
    const done = () => { clearTimeout(timer); session.close(); resolve(text) }
    const timer = setTimeout(done, ms)
    session.on("output", (stream, bytes) => { if (stream === "stdout" && text.length < 4096) text += Buffer.from(bytes).toString("utf8") })
    session.on("end", done)
    session.end()
  })
}

async function retry(attempt: () => Promise<boolean>, attempts = 6): Promise<boolean> {
  for (let at = 0; at < attempts; at++) { if (await attempt().catch(() => false)) return true; await Bun.sleep(400) }
  return false
}

function randomPorts(avoid: Set<number>): [number, number] {
  const pick = () => 20_000 + Math.floor(Math.random() * 40_000)
  let near = pick(); while (avoid.has(near)) near = pick()
  let far = pick(); while (avoid.has(far) || far === near) far = pick()
  return [near, far]
}

// An IPv4 literal a link may dial. Host names are refused, so nothing can re-point a link through DNS.
export function validAddress(value: unknown): string {
  const parts = typeof value === "string" ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)?.slice(1) : undefined
  if (!parts || parts.some((part) => Number(part) > 255 || (part.length > 1 && part.startsWith("0"))))
    throw new AsideeError("usage", "The address must be an IPv4 address such as 192.168.64.5. Host names are refused, so DNS cannot point a link somewhere else.")
  const first = Number(parts[0])
  if (first === 0) throw new AsideeError("usage", `${value} is in 0.0.0.0/8, which no connection can go to.`)
  if (first === 127) throw new AsideeError("usage", `${value} is this machine's own loopback. A link there would hand the sandbox this machine's local services; whether to allow that is not decided yet, so it is refused.`)
  if (first >= 224) throw new AsideeError("usage", `${value} is a multicast, reserved or broadcast address (224.0.0.0 and up); a link goes to one machine.`)
  return value as string
}

// A TCP connection from this machine to address:port, as a session the pump can use: it comes back paused, and ending
// its input half-closes the connection. Exported for tests.
export function dialTcp(address: string, port: number, timeoutMs = 10_000): Promise<Session> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port, allowHalfOpen: true })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer within ${timeoutMs / 1000} seconds`)) }, timeoutMs)
    socket.once("error", (error) => { clearTimeout(timer); reject(error) })
    socket.once("connect", () => { clearTimeout(timer); socket.removeAllListeners("error"); resolve(new SocketSession(socket)) })
  })
}

class SocketSession extends EventEmitter implements Session {
  readonly tty = false
  private ended = false
  constructor(private readonly socket: Socket) {
    super()
    socket.pause()
    socket.on("data", (bytes) => this.emit("output", "stdout", bytes))
    socket.on("drain", () => this.emit("drain"))
    socket.on("end", () => this.finish({ code: 0 }))
    socket.on("error", (error) => this.finish({ error: error.message }))
    socket.on("close", () => this.finish({ error: "The connection closed." }))
  }
  private finish(exit: { code?: number; error?: string }) { if (this.ended) return; this.ended = true; this.emit("end", exit) }
  write(bytes: Uint8Array) { return this.socket.write(bytes) }
  end() { this.socket.end() }
  async resize() {}
  pause() { this.socket.pause() }
  resume() { this.socket.resume() }
  close(reason = "The connection was closed.") { this.socket.destroy(); this.finish({ error: reason }) }
}
