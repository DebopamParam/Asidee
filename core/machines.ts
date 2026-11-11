import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Server } from "node:net"
import type { SandboxView } from "./core"
import { boundPort, listenLoopback, relay, validPort, type ForwardView } from "./forwards"
import { validName, validSpec, type Dirs } from "./state"
import type { OpenRequest } from "./stream"
import { addInclude, alias, editorKey, included, includeLine, parseSshSetup, remoteAliases, updateRemoteAlias, userConfig } from "./ssh"
import { absolutePath, HttpPeer, object, PROTOCOL, RemoteSession, sshDestination, type Endpoint } from "./transport"
import { PaddockError, type CheckResult } from "./types"

export const CATALOG = {
  version: ["dashboard", "read"], hello: ["socket", "read"], checklist: ["dashboard", "read"], summary: ["dashboard", "read"],
  engines: ["dashboard", "read"], list: ["dashboard", "read"], get: ["dashboard", "read"], create: ["dashboard", "write"],
  start: ["dashboard", "write"], stop: ["dashboard", "write"], remove: ["dashboard", "write"], verify: ["dashboard", "write"],
  resize: ["dashboard", "write"], snapshot: ["dashboard", "write"], templateList: ["dashboard", "read"], templateRemove: ["dashboard", "write"],
  exec: ["dashboard", "write"], extensions: ["dashboard", "read"], action: ["dashboard", "write"],
  forwardAdd: ["dashboard", "primary"], forwardList: ["dashboard", "primary"], forwardRemove: ["dashboard", "primary"],
  sshAccess: ["dashboard", "primary"], sshSetup: ["socket", "primary"], shutdown: ["socket", "write"],
  hostList: ["dashboard", "primary"], fleet: ["dashboard", "primary"], hostAttach: ["socket", "primary"], hostRemove: ["socket", "primary"],
  sessionTarget: ["socket", "read"],
  sshPrepare: ["socket", "write"],
} as const
export type MethodName = keyof typeof CATALOG
export const isMethod = (method: string): method is MethodName => Object.hasOwn(CATALOG, method)
export const mutates = (method: MethodName) => CATALOG[method][1] === "write"

export type Hello = { machineId: string; bootId: string; version: string; buildDigest: string; protocols: number[]; methods: string[]; features: string[] }
export type HostRecord = Endpoint & { name: string; machineId: string; addedAt: string; diskPolicy: "watched"; service: "prepared" }
export type HostView = { host: HostRecord; state: "connecting" | "online" | "offline" | "incompatible" | "identity-changed"; receivedAt?: string; hello?: Hello; error?: string }
export type MachineSummary = { hello: Hello; sandboxes: SandboxView[]; checkedAt: string }
export type FleetView = { machines: Array<{ machine: HostView | { host: { name: "local"; machineId: string }; state: "online" }; cached?: MachineSummary; stale: boolean }> }

export function hostName(value: unknown): string {
  const name = validName(value)
  if (name === "local") throw new PaddockError("usage", "local is reserved for this daemon's machine.")
  return name
}

export function hostOption(argv: string[]): { host?: string; argv: string[] } {
  const args: string[] = []; let host: string | undefined; let command = false
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!
    if (arg === "--") command = true
    if (!command && (arg === "--host" || arg.startsWith("--host="))) {
      if (host !== undefined) throw new PaddockError("usage", "Give --host only once.")
      const value = arg === "--host" ? argv[++at] : arg.slice(7)
      host = value === "local" ? value : hostName(value)
    } else args.push(arg)
  }
  return { host, argv: args }
}

const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
export async function machineIdentity(dirs: Dirs): Promise<string> {
  const path = join(dirs.state, "machine-id")
  await mkdir(dirs.state, { recursive: true, mode: 0o700 })
  const candidate = randomBytes(16).toString("hex")
  try { await writeFile(path, `${candidate}\n`, { flag: "wx", mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  const value = (await readFile(path, "utf8")).trim()
  if (!id(value)) throw new PaddockError("conflict", `${path} is damaged. Restore its machine identity; Paddock will not silently replace it.`)
  return value
}

export function parseHello(value: unknown): Hello {
  if (!object(value) || !id(value.machineId) || !id(value.bootId) || typeof value.version !== "string" || typeof value.buildDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.buildDigest)
    || !Array.isArray(value.protocols) || !value.protocols.every(Number.isSafeInteger) || !Array.isArray(value.methods) || !value.methods.every((entry) => typeof entry === "string")
    || !Array.isArray(value.features) || !value.features.every((entry) => typeof entry === "string")) throw new PaddockError("incompatible", "The remote daemon has no valid Machines handshake.")
  return { machineId: value.machineId, bootId: value.bootId, version: value.version, buildDigest: value.buildDigest, protocols: value.protocols, methods: value.methods, features: value.features }
}

export function compatible(hello: Hello, version: string, expected?: string): void {
  if (hello.version !== version || !hello.protocols.includes(PROTOCOL)) throw new PaddockError("incompatible", `Remote Paddock ${hello.version} (protocols ${hello.protocols.join(", ")}) is incompatible with ${version}, protocol ${PROTOCOL}. Review an explicit host upgrade; nothing was replaced.`)
  if (expected && expected !== hello.machineId) throw new PaddockError("identity-changed", `The machine identity changed from ${expected} to ${hello.machineId}. Nothing was sent to its sandboxes. Remove and enroll it explicitly.`)
}

export function parseHosts(value: unknown): HostRecord[] {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.hosts)) throw new PaddockError("usage", "hosts.json must contain {version:1, hosts:[…]}.")
  const seen = new Set<string>(); const identities = new Set<string>()
  return value.hosts.map((entry): HostRecord => {
    if (!object(entry) || !id(entry.machineId) || typeof entry.addedAt !== "string" || !Number.isFinite(Date.parse(entry.addedAt)) || entry.diskPolicy !== "watched" || entry.service !== "prepared") throw new PaddockError("usage", "hosts.json contains an invalid host record.")
    const name = hostName(entry.name)
    if (seen.has(name) || identities.has(entry.machineId)) throw new PaddockError("usage", "hosts.json repeats a host alias or machine identity.")
    seen.add(name); identities.add(entry.machineId)
    return { name, ssh: sshDestination(entry.ssh), binary: absolutePath(entry.binary), stateDir: absolutePath(entry.stateDir), machineId: entry.machineId, addedAt: entry.addedAt, diskPolicy: "watched", service: "prepared" }
  })
}

export async function readHosts(dirs: Dirs): Promise<HostRecord[]> {
  const path = join(dirs.config, "hosts.json")
  try { return parseHosts(JSON.parse(await readFile(path, "utf8"))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw new PaddockError("usage", `${path} could not be read: ${(error as Error).message}`)
  }
}
async function writeHosts(dirs: Dirs, hosts: HostRecord[]): Promise<void> {
  await mkdir(dirs.config, { recursive: true, mode: 0o700 })
  const file = join(dirs.config, "hosts.json"); const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify({ version: 1, hosts }, null, 2)}\n`, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, file)
}

// Validate the summary at the remote boundary before it can replace any cached evidence.
export function parseSummary(value: unknown, hello: Hello): MachineSummary {
  const invalid = (): never => { throw new PaddockError("incompatible", "The remote daemon returned a malformed machine summary.") }
  if (!object(value) || !Array.isArray(value.sandboxes) || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return invalid()
  const reported = parseHello(value.hello)
  if (reported.machineId !== hello.machineId || reported.bootId !== hello.bootId || reported.buildDigest !== hello.buildDigest) return invalid()
  const sandboxes = value.sandboxes.map((entry): SandboxView => {
    if (!object(entry) || typeof entry.name !== "string" || !["running", "stopped", "missing", "damaged"].includes(String(entry.status)) || typeof entry.engine !== "string" || typeof entry.createdAt !== "string"
      || entry.machineId !== hello.machineId || (entry.status !== "damaged" && !id(entry.sandboxId)) || !object(entry.spec)) return invalid()
    const name = validName(entry.name)
    if (entry.spec.name !== name) return invalid()
    let lastVerify: SandboxView["lastVerify"]
    if (entry.lastVerify !== undefined) {
      if (!object(entry.lastVerify) || typeof entry.lastVerify.at !== "string" || !Array.isArray(entry.lastVerify.results)) return invalid()
      const results = entry.lastVerify.results.map((check): CheckResult => {
        if (!object(check) || typeof check.id !== "string" || !["pass", "weak", "fail", "unsupported", "unknown", "info"].includes(String(check.status))
          || !["probed", "inspected", "none"].includes(String(check.evidence)) || typeof check.detail !== "string") return invalid()
        // The checklist catalog can grow independently. Keep unknown check IDs and their evidence visible.
        return check as CheckResult
      })
      lastVerify = { at: entry.lastVerify.at, results }
    }
    const spec = entry.status === "damaged" ? entry.spec as SandboxView["spec"] : validSpec(entry.spec.template ? { ...entry.spec, image: undefined } : entry.spec)
    if (entry.spec.template && typeof entry.spec.image === "string") spec.image = entry.spec.image
    for (const key of ["stopReason", "activity"]) if (entry[key] !== undefined && typeof entry[key] !== "string") return invalid()
    return { name, status: entry.status as SandboxView["status"], machineId: hello.machineId, ...(id(entry.sandboxId) ? { sandboxId: entry.sandboxId } : {}), engine: entry.engine, createdAt: entry.createdAt, spec,
      lastVerify, ...(typeof entry.stopReason === "string" ? { stopReason: entry.stopReason } : {}), ...(typeof entry.activity === "string" ? { activity: entry.activity } : {}) }
  })
  return { hello: reported, sandboxes, checkedAt: value.checkedAt }
}

export const staleSummary = (summary: MachineSummary): MachineSummary => ({ ...summary, sandboxes: summary.sandboxes.map((sandbox) => ({ ...sandbox, status: "unknown",
  lastVerify: sandbox.lastVerify && { ...sandbox.lastVerify, results: sandbox.lastVerify.results.map((check) => ({ ...check, status: "unknown", evidence: "none", detail: `Last contact lost. Previous result at ${sandbox.lastVerify!.at}: ${check.detail}` })) } })) })

type Cached = { view: HostView; summary?: MachineSummary; pending?: Promise<void>; failures: number; retryAt: number }
export class Machines {
  private readonly cache = new Map<string, Cached>()
  private registryWrite: Promise<unknown> = Promise.resolve()
  private readonly forwards = new Map<string, { host: string; view: ForwardView & { host: string; machineId: string }; server: Server; lease: RemoteSession; connections: Set<RemoteSession>; timer: ReturnType<typeof setInterval> }>()
  private readonly sessions = new Set<RemoteSession>()
  constructor(readonly dirs: Dirs, readonly hello: Hello, private readonly localSummary: () => Promise<MachineSummary>, private readonly connectPeer: (endpoint: Endpoint) => Pick<HttpPeer, "call" | "close"> = (endpoint) => new HttpPeer(endpoint)) {}

  async resolve(host: unknown): Promise<HostRecord> {
    const name = hostName(host)
    const found = (await readHosts(this.dirs)).find((entry) => entry.name === name)
    if (!found) throw new PaddockError("not-found", `There is no host ${name}. See \`paddock host list\`. No local fallback was attempted.`)
    return found
  }

  private async peer<T>(host: Endpoint & { machineId?: string }, run: (peer: Pick<HttpPeer, "call" | "close">, hello: Hello) => Promise<T>): Promise<T> {
    const peer = this.connectPeer(host)
    try {
      const hello = parseHello(await peer.call("hello", {}, { timeoutMs: 10_000 }))
      compatible(hello, this.hello.version, host.machineId)
      return await run(peer, hello)
    } finally { await peer.close() }
  }

  async route(method: MethodName, body: Record<string, unknown>): Promise<unknown> {
    const { host: selected, ...payload } = body
    if (selected === undefined || selected === "local") return undefined
    const host = await this.resolve(selected)
    if (method === "forwardAdd") return this.forwardAdd(host, body)
    if (method === "forwardList") return this.forwardList(host.name, body.name)
    if (method === "forwardRemove") return this.forwardRemove(body.id, host.name)
    if (method === "sshSetup") return this.sshSetup(host, body)
    if (method === "sshAccess") return this.sshAccess(host, body.name)
    if (CATALOG[method][1] === "primary") throw new PaddockError("dependency", `${method} has no remote implementation yet.`)
    return this.peer(host, async (peer, hello) => {
      if (!hello.methods.includes(method)) throw new PaddockError("incompatible", `The daemon on ${host.name} does not offer ${method}.`)
      const result = await peer.call(method, payload, { mutation: mutates(method), machineId: host.machineId, version: this.hello.version, ...(!mutates(method) ? { timeoutMs: 10_000 } : {}) })
      if (method === "remove") await updateRemoteAlias(this.dirs, host.name, validName(body.name))
      return result
    })
  }

  private async sshSetup(host: HostRecord, body: Record<string, unknown>) {
    const name = validName(body.name); const key = await editorKey(this.dirs)
    const result = await this.peer(host, async (peer) => peer.call("sshPrepare", { name, publicKey: key.publicKey }, { mutation: true, machineId: host.machineId, version: this.hello.version }))
    if (!object(result) || !id(result.sandboxId)) throw new PaddockError("incompatible", "Invalid remote SSH identity.")
    const setup = parseSshSetup(result.setup)
    if (setup.editorKey !== key.fingerprint) throw new PaddockError("incompatible", "The remote daemon prepared another editor key.")
    await updateRemoteAlias(this.dirs, host.name, name, { host: host.name, name, machineId: host.machineId, sandboxId: result.sandboxId, setup })
    if (body.writeConfig === true) await addInclude(this.dirs)
    return { ...await this.sshAccess(host, name), config: userConfig(), include: includeLine(this.dirs), included: await included(this.dirs), editorKey: key.fingerprint, keyFile: key.path }
  }
  private async sshAccess(host: HostRecord, input: unknown) {
    const name = validName(input); const setup = (await remoteAliases(this.dirs)).find((entry) => entry.host === host.name && entry.machineId === host.machineId && entry.name === name)
    const current = await this.peer(host, (peer) => peer.call("get", { name }, { timeoutMs: 10_000, machineId: host.machineId, version: this.hello.version }))
    const same = object(current) && current.sandboxId === setup?.sandboxId
    return { alias: alias(name, host.name), user: same ? setup?.setup.user ?? "" : "", home: same ? setup?.setup.home ?? "" : "", loopbackForwarding: Boolean(same && setup),
      batchReady: Boolean(same && setup && current.status === "running" && await included(this.dirs)) }
  }

  private async target(peer: Pick<HttpPeer, "call">, host: HostRecord, name: unknown) {
    const value = await peer.call("sessionTarget", { name: validName(name) }, { timeoutMs: 10_000, machineId: host.machineId, version: this.hello.version })
    if (!object(value) || value.name !== name || value.machineId !== host.machineId || !id(value.sandboxId) || typeof value.generation !== "string" || value.generation.length > 128) throw new PaddockError("incompatible", "Invalid remote sandbox identity.")
    return { name: validName(name), machineId: host.machineId, sandboxId: value.sandboxId, generation: value.generation }
  }

  private async remoteSession(host: HostRecord, hello: Hello, request: OpenRequest): Promise<RemoteSession> {
    const session = await RemoteSession.open(host, { ...request, host: undefined, machineId: host.machineId, bootId: hello.bootId, protocol: PROTOCOL, version: this.hello.version })
    this.sessions.add(session); void session.closed.finally(() => this.sessions.delete(session))
    return session
  }

  async openSession(request: OpenRequest, local: (request: OpenRequest) => Promise<import("./types").Session>): Promise<import("./types").Session> {
    if (request.host === undefined || request.host === "local") {
      if (request.bootId !== undefined && request.bootId !== this.hello.bootId) throw new PaddockError("identity-changed", "The daemon restarted before this session opened.")
      if (request.protocol !== undefined && (request.protocol !== PROTOCOL || request.version !== this.hello.version)) throw new PaddockError("incompatible", "The stream protocol or daemon version differs.")
      return local(request)
    }
    const host = await this.resolve(request.host)
    return this.peer(host, async (peer, hello) => {
      if (!hello.features.includes("remote-streams")) throw new PaddockError("dependency", "The remote daemon does not offer hosted streams.")
      const target = await this.target(peer, host, request.name)
      if (request.sandboxId && request.sandboxId !== target.sandboxId) throw new PaddockError("identity-changed", "The sandbox was recreated; set up its alias again.")
      return this.remoteSession(host, hello, { ...request, ...target })
    })
  }

  private async forwardAdd(host: HostRecord, body: Record<string, unknown>): Promise<ForwardView> {
    const port = validPort(body.port, "The port"); const local = body.localPort === undefined ? undefined : validPort(body.localPort, "The local port")
    return this.peer(host, async (peer, hello) => {
      if (!hello.features.includes("remote-forwards")) throw new PaddockError("dependency", "The remote daemon does not offer hosted forwards.")
      const target = await this.target(peer, host, body.name); const leaseId = randomBytes(16).toString("hex")
      const lease = await this.remoteSession(host, hello, { kind: "lease", ...target, port, leaseId })
      let server: Server
      try { server = await listenLoopback(local) } catch (error) { lease.close(); await lease.closed; throw error }
      const forwardId = randomBytes(4).toString("hex"); let heard = Date.now()
      const forward = { host: host.name, view: { id: forwardId, ...target, host: host.name, localAddress: "127.0.0.1" as const, localPort: boundPort(server), port, createdAt: new Date().toISOString(), connections: 0 }, server, lease, connections: new Set<RemoteSession>(),
        timer: setInterval(() => { if (Date.now() - heard >= 15_000) this.endForward(forwardId, "The SSH control stream was silent for 15 seconds; add a new forward explicitly.") }, 1000) }
      forward.timer.unref()
      this.forwards.set(forwardId, forward)
      lease.on("output", () => { heard = Date.now() }); lease.on("end", () => this.endForward(forwardId, "The remote daemon, sandbox run or SSH control link ended.")); lease.resume()
      server.on("connection", async (socket) => {
        socket.on("error", () => {})
        if (!this.forwards.has(forwardId) || Date.now() - heard >= 15_000) { this.endForward(forwardId, "The SSH control stream expired."); return socket.destroy() }
        let session: RemoteSession
        try { session = await this.remoteSession(host, hello, { kind: "dial", ...target, port, leaseId }) } catch { return socket.destroy() }
        if (!this.forwards.has(forwardId) || socket.destroyed) { session.close(); socket.destroy(); return }
        forward.connections.add(session)
        // A service closing normally ends only that connection. Transport failure ends the listener as well.
        session.on("end", (exit) => { forward.connections.delete(session); if (session.linkLost) this.endForward(forwardId, exit.error ?? "The SSH relay was lost.") })
        relay(socket, session); session.resume()
      })
      return forward.view
    })
  }

  private endForward(id: string, reason: string): void {
    const forward = this.forwards.get(id)
    if (!forward) return
    this.forwards.delete(id); clearInterval(forward.timer); forward.server.close(); forward.lease.close(reason)
    for (const session of forward.connections) session.close(reason)
  }
  forwardList(host: string, name?: unknown): ForwardView[] {
    const only = name === undefined ? undefined : validName(name)
    return [...this.forwards.values()].filter((forward) => forward.host === host && (!only || forward.view.name === only)).map((forward) => ({ ...forward.view, connections: forward.connections.size }))
  }
  forwardRemove(id: unknown, host?: string): { closed: string } | undefined {
    if (typeof id !== "string" || !this.forwards.has(id) || (host && this.forwards.get(id)!.host !== host)) {
      if (host) throw new PaddockError("not-found", "No such primary forward for this host.")
      return undefined
    }
    this.endForward(id, "The forward was removed."); return { closed: id }
  }
  async close(): Promise<void> {
    for (const id of [...this.forwards.keys()]) this.endForward(id, "The primary daemon stopped.")
    const sessions = [...this.sessions]; for (const session of sessions) session.close("The primary daemon stopped.")
    await Promise.all(sessions.map((session) => session.closed))
  }

  // Serializes only registry writes; a slow or unreachable machine never holds another machine's refresh.
  private edit<T>(task: () => Promise<T>): Promise<T> {
    const next = this.registryWrite.then(task, task); this.registryWrite = next.catch(() => {}); return next
  }
  attach(body: Record<string, unknown>): Promise<HostRecord> {
    return this.edit(async () => {
      const name = hostName(body.name); const hosts = await readHosts(this.dirs)
      if (hosts.some((host) => host.name === name)) throw new PaddockError("conflict", `${name} is already registered. Remove it explicitly before enrolling another machine.`)
      const endpoint = { ssh: sshDestination(body.ssh), binary: absolutePath(body.binary), stateDir: absolutePath(body.stateDir) }
      const hello = await this.peer(endpoint, async (_peer, hello) => hello)
      if (hello.machineId === this.hello.machineId || hosts.some((host) => host.machineId === hello.machineId)) throw new PaddockError("conflict", "This machine identity is already registered.")
      const host: HostRecord = { name, ...endpoint, machineId: hello.machineId, addedAt: new Date().toISOString(), diskPolicy: "watched", service: "prepared" }
      await writeHosts(this.dirs, [...hosts, host]); return host
    })
  }
  remove(body: Record<string, unknown>): Promise<{ removed: string; remoteRetained: true }> {
    return this.edit(async () => {
      const host = await this.resolve(body.name)
      if (body.confirm !== host.name) throw new PaddockError("usage", "Confirm removal with --confirm NAME. A prepared daemon and all remote data are retained.")
      for (const [id, forward] of this.forwards) if (forward.host === host.name) this.endForward(id, "The host was removed.")
      await writeHosts(this.dirs, (await readHosts(this.dirs)).filter((entry) => entry.name !== host.name))
      await updateRemoteAlias(this.dirs, host.name)
      this.cache.delete(host.name); return { removed: host.name, remoteRetained: true }
    })
  }

  private refresh(host: HostRecord): Promise<void> {
    const cache = this.cache.get(host.name) ?? { view: { host, state: "connecting" }, failures: 0, retryAt: 0 }
    this.cache.set(host.name, cache)
    if (cache.pending) return cache.pending
    cache.pending = this.peer(host, async (peer, hello) => {
      const summary = parseSummary(await peer.call("summary", {}, { timeoutMs: 10_000, machineId: host.machineId, version: this.hello.version }), hello)
      cache.summary = summary; cache.view = { host, state: "online", hello, receivedAt: new Date().toISOString() }; cache.failures = 0; cache.retryAt = Date.now() + 5000
    }).catch((error) => {
      cache.view = { ...cache.view, state: error instanceof PaddockError && (error.code === "incompatible" || error.code === "identity-changed") ? error.code : "offline", error: (error as Error).message }
      cache.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++cache.failures, 6))
    }).finally(() => { delete cache.pending })
    return cache.pending
  }

  async list(): Promise<HostView[]> {
    const hosts = await readHosts(this.dirs)
    await Promise.all(hosts.map((host) => this.refresh(host)))
    return hosts.map((host) => this.cache.get(host.name)!.view)
  }
  async fleet(refresh?: unknown): Promise<FleetView> {
    const hosts = await readHosts(this.dirs)
    if (refresh !== undefined && (typeof refresh !== "string" || !hosts.some((host) => host.name === refresh))) throw new PaddockError("not-found", "No such host to refresh.")
    for (const host of hosts) if (host.name === refresh || Date.now() >= (this.cache.get(host.name)?.retryAt ?? 0)) void this.refresh(host)
    return { machines: [{ machine: { host: { name: "local", machineId: this.hello.machineId }, state: "online" }, cached: await this.localSummary(), stale: false },
      ...hosts.map((host) => {
        const cache = this.cache.get(host.name)!; const stale = cache.view.state !== "online" || Date.now() - Date.parse(cache.view.receivedAt ?? "") > 15_000
        return { machine: cache.view, ...(cache.summary ? { cached: stale ? staleSummary(cache.summary) : cache.summary } : {}), stale }
      })] }
  }
}
