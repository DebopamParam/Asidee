import { isDeepStrictEqual } from "node:util"
import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Server } from "node:net"
import type { SandboxView } from "./core"
import { GPU_KIND } from "./checks"
import { boundPort, LEASE_RENEW_MS, LEASE_TTL_MS, listenLoopback, relay, validPort, type ForwardView } from "./forwards"
import { readConfig, validName, validSpec, type Dirs } from "./state"
import type { OpenRequest } from "./stream"
import { addInclude, alias, editorKey, included, includeLine, parseSshSetup, remoteAliases, updateRemoteAlias, userConfig } from "./ssh"
import { absolutePath, bounded, enrolledKeyHelp, hostPublicKey, HttpPeer, keyFingerprint, KILL_GRACE_MS, MUTATION_DEADLINE_MS, object, PROTOCOL, RemoteSession, sshDestination, sshIdentity, type Endpoint } from "./transport"
import { AsideeError } from "./types"

// Each method's access on the dashboard's port (open, asked first on this Mac, or never) and its routing.
export const CATALOG = {
  version: ["dashboard", "read"], hello: ["socket", "read"], checklist: ["dashboard", "read"], summary: ["dashboard", "read"],
  configGet: ["dashboard", "read"], configSet: ["dashboard", "write"],
  engines: ["dashboard", "read"], list: ["dashboard", "read"], get: ["dashboard", "read"], create: ["dashboard", "write"],
  createRetry: ["dashboard", "write"], createStep: ["dashboard", "write"], createKeep: ["dashboard", "write"],
  start: ["dashboard", "write"], stop: ["dashboard", "write"], remove: ["dashboard", "write"], verify: ["dashboard", "write"], visibilitySet: ["dashboard", "write"],
  resize: ["dashboard", "write"], snapshot: ["dashboard", "write"], templateList: ["dashboard", "read"], templateRemove: ["dashboard", "write"],
  templatePrepare: ["dashboard", "write"], templatePreparing: ["dashboard", "read"], templatePrepareInfo: ["dashboard", "primary"],
  exec: ["dashboard", "write"], extensions: ["dashboard", "read"], action: ["dashboard", "write"], extensionInstall: ["dashboard", "write"], extensionRemove: ["dashboard", "write"],
  forwardAdd: ["dashboard", "primary"], forwardList: ["dashboard", "primary"], forwardRemove: ["dashboard", "primary"],
  linkAdd: ["dashboard", "primary"], linkList: ["dashboard", "primary"], linkRemove: ["dashboard", "primary"],
  sshAccess: ["dashboard", "primary"], sshSetup: ["approve", "primary"], shutdown: ["approve", "write"],
  hostList: ["dashboard", "primary"], fleet: ["dashboard", "primary"], hostAttach: ["approve", "primary"], hostPlan: ["socket", "primary"], hostApply: ["socket", "primary"], hostRemove: ["approve", "primary"],
  sessionTarget: ["socket", "read"],
  sshPrepare: ["socket", "write"],
  folderBrowse: ["dashboard", "primary"], folderPreview: ["dashboard", "primary"], folderChoose: ["dashboard", "primary"],
  terminalCommandSet: ["approve", "primary"], about: ["dashboard", "primary"], usage: ["dashboard", "read"], openTerminal: ["dashboard", "primary"],
} as const
export type MethodName = keyof typeof CATALOG
export const EXPERIMENTAL_OFF = "Other machines are experimental and off on this machine: they are not yet proven on enough machines. To turn them on: asd config set experimental on"
export const LINKS_LOCAL = "Links join two sandboxes on this machine only, so they cannot be used with --host."
export const FOLDERS_LOCAL = "Folders are browsed and previewed on this Mac, where they are copied from, so this takes no --host."
export const isMethod = (method: string): method is MethodName => Object.hasOwn(CATALOG, method)
export const mutates = (method: MethodName) => CATALOG[method][1] === "write"

// sourceDigest names the source a build was made from, the same for every platform's binary; buildDigest is this
// artifact's own SHA-256. listener and service say how the daemon runs, for `host list`.
export type Hello = { machineId: string; bootId: string; version: string; buildDigest: string; sourceDigest: string; protocols: number[]; methods: string[]; features: string[]
  listener?: "socket-only" | "dashboard"; service?: "systemd" | "none" }
// sshUser, hostKey and hostPublicKey: the account, outer host-key fingerprint and public key SSH used when attached.
export type HostRecord = Endpoint & { name: string; machineId: string; addedAt: string; diskPolicy: "watched"; service: "prepared" | "systemd"; sshUser?: string; hostKey?: string; hostPublicKey?: string }
// A record this Asidee cannot use: written by a newer one, or damaged. It is shown, and only it is refused.
export type UnknownHost = { name: string; error: string; ssh?: string; machineId?: string }
export type HostView = { host: HostRecord; state: "connecting" | "online" | "offline" | "incompatible" | "identity-changed"; receivedAt?: string; hello?: Hello; error?: string }
  | { host: UnknownHost; state: "unknown-record"; error: string }
export type MachineSummary = { hello: Hello; sandboxes: SandboxView[]; checkedAt: string }
export type FleetView = { machines: Array<{ machine: HostView | { host: { name: "local"; machineId: string }; state: "online" }; cached?: MachineSummary; stale: boolean }> }

export function hostName(value: unknown): string {
  const name = validName(value)
  if (name === "local") throw new AsideeError("usage", "local is reserved for this daemon's machine.")
  return name
}

export function hostOption(argv: string[]): { host?: string; argv: string[] } {
  const args: string[] = []; let host: string | undefined; let command = false
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at]!
    if (arg === "--") command = true
    if (!command && (arg === "--host" || arg.startsWith("--host="))) {
      if (host !== undefined) throw new AsideeError("usage", "Give --host only once.")
      const value = arg === "--host" ? argv[++at] : arg.slice(7)
      host = value === "local" ? value : hostName(value)
    } else args.push(arg)
  }
  return { host, argv: args }
}

const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value)
export const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export async function machineIdentity(dirs: Dirs): Promise<string> {
  const path = join(dirs.state, "machine-id")
  await mkdir(dirs.state, { recursive: true, mode: 0o700 })
  const candidate = randomBytes(16).toString("hex")
  try { await writeFile(path, `${candidate}\n`, { flag: "wx", mode: 0o600 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
  const value = (await readFile(path, "utf8")).trim()
  if (!id(value)) throw new AsideeError("conflict", `${path} is damaged. Restore its machine identity; Asidee will not silently replace it.`)
  return value
}

export function parseHello(value: unknown): Hello {
  if (!object(value) || !id(value.machineId) || !id(value.bootId) || typeof value.version !== "string" || value.version.length > 64 || !digest(value.buildDigest) || !digest(value.sourceDigest)
    || !Array.isArray(value.protocols) || !value.protocols.every(Number.isSafeInteger) || !Array.isArray(value.methods) || !value.methods.every((entry) => typeof entry === "string")
    || !Array.isArray(value.features) || !value.features.every((entry) => typeof entry === "string")
    || (value.listener !== undefined && value.listener !== "socket-only" && value.listener !== "dashboard") || (value.service !== undefined && value.service !== "systemd" && value.service !== "none"))
    throw new AsideeError("incompatible", "The remote daemon has no valid Machines handshake.")
  return { machineId: value.machineId, bootId: value.bootId, version: value.version, buildDigest: value.buildDigest, sourceDigest: value.sourceDigest, protocols: value.protocols, methods: value.methods, features: value.features,
    ...(value.listener ? { listener: value.listener } : {}), ...(value.service ? { service: value.service } : {}) }
}

// Exactly one build talks to another: the same version, protocol and source. There is no negotiation down to an older
// protocol and no upgrade; a mismatch is refused before anything is sent.
export function compatible(hello: Hello, local: Pick<Hello, "version" | "sourceDigest">, expected?: string, binary?: string, enrollment?: { name: string; ssh: string }): void {
  const update = enrollment ? `Build the Linux artifact from this source, then review and accept an update with \`asd host add ${enrollment.name} --ssh ${enrollment.ssh} --artifact PATH --sha256 HASH\`. Include --docker if the host offers inner Docker. Nothing was sent or replaced.` : `Build Asidee for that machine from this machine's source (bun build --compile --target=bun-linux-x64 or bun-linux-arm64 --outfile asidee cli/cli.ts), put it in place of ${binary ?? "the binary its host record names"}, and restart its daemon. Nothing was sent; nothing was replaced.`
  if (hello.version !== local.version || !hello.protocols.includes(PROTOCOL)) throw new AsideeError("incompatible", `Remote Asidee ${hello.version} (protocols ${hello.protocols.join(", ")}) is incompatible with ${local.version}, protocol ${PROTOCOL}. ${update}`)
  if (hello.sourceDigest !== local.sourceDigest) throw new AsideeError("incompatible", `Remote Asidee ${hello.version} was built from other source (${hello.sourceDigest.slice(0, 12)}) than this one (${local.sourceDigest.slice(0, 12)}); two builds of one version are not mixed. ${update}`)
  if (expected && expected !== hello.machineId) throw new AsideeError("identity-changed", `The machine identity changed from ${expected} to ${hello.machineId}. Nothing was sent to its sandboxes. Remove and enroll it explicitly.`)
}

// Each record is read on its own: one this Asidee does not know (a later `host add` kind) or a damaged one is shown and
// refused, and every other host keeps working. Unknown records are written back as they were.
export type Registry = { hosts: HostRecord[]; unknown: UnknownHost[]; entries: unknown[] }
export function parseHosts(value: unknown): Registry {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.hosts)) throw new AsideeError("usage", "hosts.json must contain {version:1, hosts:[…]}.")
  const registry: Registry = { hosts: [], unknown: [], entries: value.hosts }; const names = new Set<string>(); const identities = new Set<string>()
  value.hosts.forEach((entry: unknown, index) => {
    const name = recordName(entry, index)
    try {
      if (!object(entry)) throw new AsideeError("usage", "it is not an object")
      if (names.has(hostName(entry.name)) || identities.has(String(entry.machineId))) throw new AsideeError("usage", "it repeats another record's alias or machine identity")
      if (entry.diskPolicy !== "watched" || (entry.service !== "prepared" && entry.service !== "systemd")) throw new AsideeError("incompatible", `it is a host with service ${JSON.stringify(entry.service)} and disk policy ${JSON.stringify(entry.diskPolicy)}, which this Asidee does not know; use the Asidee that wrote it`)
      if (!id(entry.machineId) || typeof entry.addedAt !== "string" || !Number.isFinite(Date.parse(entry.addedAt))) throw new AsideeError("usage", "its machine identity or date is invalid")
      if (entry.sshUser !== undefined && (typeof entry.sshUser !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(entry.sshUser))) throw new AsideeError("usage", "its SSH user is invalid")
      if (entry.hostKey !== undefined && (typeof entry.hostKey !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(entry.hostKey))) throw new AsideeError("usage", "its host-key fingerprint is invalid")
      if (entry.hostPublicKey !== undefined && (keyFingerprint(hostPublicKey(entry.hostPublicKey)) !== entry.hostKey)) throw new AsideeError("usage", "its host public key does not match its fingerprint")
      registry.hosts.push({ name: hostName(entry.name), ssh: sshDestination(entry.ssh), binary: absolutePath(entry.binary), stateDir: absolutePath(entry.stateDir), machineId: entry.machineId, addedAt: entry.addedAt, diskPolicy: "watched", service: entry.service,
        ...(entry.sshUser ? { sshUser: entry.sshUser as string } : {}), ...(entry.hostKey ? { hostKey: entry.hostKey as string } : {}), ...(entry.hostPublicKey ? { hostPublicKey: entry.hostPublicKey as string } : {}) })
    } catch (error) {
      registry.unknown.push({ name, error: `hosts.json record ${index + 1} cannot be used: ${(error as Error).message.replace(/\.$/, "")}. Other hosts are unaffected; \`asd host remove ${name} --confirm ${name}\` forgets it.`,
        ...(object(entry) && typeof entry.ssh === "string" ? { ssh: entry.ssh.slice(0, 256) } : {}), ...(object(entry) && id(entry.machineId) ? { machineId: entry.machineId } : {}) })
    }
    names.add(name); if (object(entry) && id(entry.machineId)) identities.add(entry.machineId)
  })
  return registry
}

const recordName = (entry: unknown, index: number) => object(entry) && typeof entry.name === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test(entry.name) ? entry.name : `record-${index + 1}`

export async function readHosts(dirs: Dirs): Promise<Registry> {
  const path = join(dirs.config, "hosts.json")
  try { return parseHosts(JSON.parse(await readFile(path, "utf8"))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hosts: [], unknown: [], entries: [] }
    throw new AsideeError("usage", `${path} could not be read: ${(error as Error).message}`)
  }
}
async function writeHosts(dirs: Dirs, entries: unknown[]): Promise<void> {
  await mkdir(dirs.config, { recursive: true, mode: 0o700 })
  const file = join(dirs.config, "hosts.json"); const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify({ version: 1, hosts: entries }, null, 2)}\n`, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, file)
}

// ---- replies from another machine, validated before the primary or a client relies on them

type Shape = "string" | "number" | "boolean" | "object" | ((value: unknown) => boolean) | readonly [Shape] | { readonly [key: string]: Shape }
const oneOf = (...values: readonly unknown[]) => (value: unknown) => values.includes(value)
export function fits(value: unknown, shape: Shape): boolean {
  if (shape === "object") return object(value)
  if (typeof shape === "string") return typeof value === shape && (shape !== "number" || Number.isFinite(value))
  if (typeof shape === "function") return shape(value)
  if (Array.isArray(shape)) return Array.isArray(value) && value.every((item) => fits(item, shape[0]))
  return object(value) && Object.entries(shape as Record<string, Shape>).every(([key, inner]) => key.endsWith("?") ? value[key.slice(0, -1)] === undefined || fits(value[key.slice(0, -1)], inner) : fits(value[key], inner))
}
const CHECK = { id: "string", status: oneOf("pass", "weak", "fail", "unsupported", "unknown", "info"), evidence: oneOf("probed", "inspected", "none"), detail: "string" } as const
const TEMPLATE = { name: "string", engine: "string", imageId: "string", source: "string", sourceImage: "string", createdAt: "string", sizeBytes: "number", loginsRemoved: ["string"], dependants: ["string"] } as const
const RUN = { exitCode: "number", stdout: "string", stderr: "string" } as const
const ENGINE = { id: "string", provider: "string", label: "string", ready: "boolean", problems: ["string"], "fix?": "string", "capabilities?": { kernelIsolation: "string", networkGuard: "boolean", diskLimit: "string", docker: "boolean" } } as const
const CHANGE = { limit: oneOf("cpus", "memoryGb", "pids", "diskGb"), from: "number", to: "number", applies: oneOf("now", "next start", "unchanged", "not enforced"), "note?": "string" } as const
const shaped = (shape: Shape) => (value: unknown) => { if (!fits(value, shape)) throw new Error("its shape"); return value }

// One sandbox row. Only an identity that is not this machine's rejects the whole reply; any other problem turns the row
// into a damaged one that says so, so one odd sandbox cannot hide a machine's inventory or mark it offline.
export function parseRow(entry: unknown, hello: Hello, index = 0): SandboxView {
  if (!object(entry) || entry.machineId !== hello.machineId) throw new AsideeError("incompatible", "The remote daemon reported a sandbox of another machine.")
  const name = typeof entry.name === "string" && /^[a-z0-9][a-z0-9-]{0,30}$/.test(entry.name) ? entry.name : `unreadable-${index + 1}`
  try {
    if (!["running", "stopped", "missing", "damaged", "unknown"].includes(String(entry.status)) || typeof entry.engine !== "string" || typeof entry.createdAt !== "string"
      || (entry.status !== "damaged" && !id(entry.sandboxId)) || !object(entry.spec)) throw new Error("its status, engine, identity or spec")
    if (validName(entry.name) && entry.spec.name !== name) throw new Error("its spec names another sandbox")
    let lastVerify: SandboxView["lastVerify"]
    if (entry.lastVerify !== undefined) {
      // The checklist catalog can grow independently. Unknown check IDs stay visible with their evidence.
      if (!fits(entry.lastVerify, { at: "string", results: [CHECK] })) throw new Error("its last checks")
      lastVerify = entry.lastVerify as SandboxView["lastVerify"]
    }
    for (const key of ["stopReason", "activity"]) if (entry[key] !== undefined && typeof entry[key] !== "string") throw new Error(`its ${key}`)
    let enforcementProblem: SandboxView["enforcementProblem"]
    if (entry.enforcementProblem !== undefined) {
      if (!object(entry.enforcementProblem) || typeof entry.enforcementProblem.at !== "string" || typeof entry.enforcementProblem.message !== "string") throw new Error("its enforcement warning")
      enforcementProblem = { at: entry.enforcementProblem.at, message: entry.enforcementProblem.message }
    }
    let diskWarning: SandboxView["diskWarning"]
    if (entry.diskWarning !== undefined) {
      const warning = entry.diskWarning
      if (!object(warning) || typeof warning.usedBytes !== "number" || !Number.isFinite(warning.usedBytes) || typeof warning.limitBytes !== "number" || !Number.isFinite(warning.limitBytes) || typeof warning.message !== "string") throw new Error("its disk warning")
      diskWarning = { usedBytes: warning.usedBytes, limitBytes: warning.limitBytes, message: warning.message }
    }
    const spec = entry.status === "damaged" ? damagedSpec(name) : validSpec(entry.spec.template ? { ...entry.spec, image: undefined } : entry.spec)
    if (entry.status !== "damaged" && entry.spec.template && typeof entry.spec.image === "string") spec.image = entry.spec.image
    return { name, status: entry.status as SandboxView["status"], machineId: hello.machineId, ...(id(entry.sandboxId) ? { sandboxId: entry.sandboxId } : {}), engine: entry.engine, createdAt: entry.createdAt, spec, ...(spec.gpu ? { kind: GPU_KIND } : {}),
      lastVerify, enforcementProblem, ...(diskWarning ? { diskWarning } : {}), ...(entry.visibility === "private" || entry.visibility === "public" ? { visibility: entry.visibility } : {}), ...(typeof entry.stopReason === "string" ? { stopReason: entry.stopReason } : {}), ...(typeof entry.activity === "string" ? { activity: entry.activity } : {}) }
  } catch (error) {
    return { name, status: "damaged", machineId: hello.machineId, ...(id(entry.sandboxId) ? { sandboxId: entry.sandboxId } : {}), engine: typeof entry.engine === "string" ? entry.engine : "", createdAt: "", spec: damagedSpec(name),
      stopReason: `The remote daemon reported this sandbox in a form this Asidee cannot read (${(error as Error).message}). See it with that machine's own Asidee.` }
  }
}
const damagedSpec = (name: string): SandboxView["spec"] => ({ name, image: "", cpus: 0, memoryGb: 0, pids: 0, diskGb: 0, docker: false })

// Validate the summary at the remote boundary before it can replace any cached evidence.
export function parseSummary(value: unknown, hello: Hello): MachineSummary {
  const invalid = (): never => { throw new AsideeError("incompatible", "The remote daemon returned a malformed machine summary.") }
  try {
    if (!object(value) || !Array.isArray(value.sandboxes) || typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return invalid()
    const reported = parseHello(value.hello)
    if (reported.machineId !== hello.machineId || reported.bootId !== hello.bootId || reported.buildDigest !== hello.buildDigest) return invalid()
    return { hello: reported, sandboxes: value.sandboxes.map((entry, index) => parseRow(entry, hello, index)), checkedAt: value.checkedAt }
  } catch (error) { throw error instanceof AsideeError && error.code === "incompatible" ? error : new AsideeError("incompatible", `The remote daemon returned a malformed machine summary: ${(error as Error).message}`) }
}

// Every method a remote daemon may answer, with what its answer must look like. A method without one is not routed.
const withRow = (shape: Shape) => (value: unknown, hello: Hello) => { shaped(shape)(value); return { ...(value as object), sandbox: parseRow((value as { sandbox: unknown }).sandbox, hello) } }
const REPLIES: Partial<Record<MethodName, (value: unknown, hello: Hello) => unknown>> = {
  version: shaped({ version: "string" }), hello: (value) => parseHello(value), checklist: shaped([{ id: "string", title: "string" }]), summary: (value, hello) => parseSummary(value, hello),
  configGet: shaped({ defaults: "object", requireProbes: "boolean", "experimental?": "boolean", "remoteCreate?": "boolean" }), configSet: shaped({ defaults: "object", requireProbes: "boolean", "experimental?": "boolean", "remoteCreate?": "boolean" }),
  engines: shaped([ENGINE]), list: (value, hello) => { if (!Array.isArray(value)) throw new Error("its shape"); return value.map((entry, index) => parseRow(entry, hello, index)) },
  get: (value, hello) => parseRow(value, hello), start: (value, hello) => parseRow(value, hello), stop: (value, hello) => parseRow(value, hello), visibilitySet: (value, hello) => parseRow(value, hello),
  create: withRow({ sandbox: "object", checks: [CHECK], hooks: [{ extension: "string", exitCode: "number", output: "string" }] }), remove: shaped({ removed: "string" }),
  verify: withRow({ sandbox: "object", checks: [CHECK], ok: "boolean" }), resize: withRow({ sandbox: "object", changes: [CHANGE], checks: [CHECK] }),
  snapshot: shaped({ template: TEMPLATE, contents: "string" }), templateList: shaped([TEMPLATE]), templateRemove: shaped({ removed: "string", imageId: "string", dependants: ["string"], note: "string" }),
  templatePrepare: shaped({ template: TEMPLATE, versions: { claude: "string", codex: "string" }, tools: ["string"], default: "boolean" }), templatePreparing: shaped([{ name: "string", startedAt: "string", lines: ["string"] }]),
  exec: shaped(RUN), action: shaped(RUN), extensions: shaped({ extensions: [{ id: "string", name: "string", "description?": "string", actions: [{ id: "string", label: "string", fields: [{ id: "string" }] }] }], errors: ["string"], "available?": [{ id: "string", name: "string", installed: "boolean" }] }),
  extensionInstall: shaped({ id: "string", name: "string", actions: [{ id: "string", label: "string" }] }), extensionRemove: shaped({ removed: "string" }),
  usage: shaped([{ name: "string", running: "boolean", cpus: "number", memoryLimitBytes: "number", pidsLimit: "number", diskLimitBytes: "number" }]),
  shutdown: shaped({ stopping: "boolean" }), sessionTarget: shaped({ name: "string", machineId: id, sandboxId: id, generation: "string" }),
  sshPrepare: (value) => { shaped({ sandboxId: id, setup: "object" })(value); parseSshSetup((value as { setup: unknown }).setup); return value },
}
export function parseRouted(method: MethodName, value: unknown, hello: Hello): unknown {
  const parse = REPLIES[method]
  try {
    if (!parse) throw new Error("no reply schema")
    return parse(value, hello)
  } catch (error) {
    if (error instanceof AsideeError && error.code !== "usage") throw mutates(method) ? new AsideeError("outcome-unknown", `${error.message} ${method} had been sent, so its outcome is unknown. It was not retried. Reconcile with get before acting again.`) : error
    const message = `The remote daemon's reply to ${method} is malformed (${(error as Error).message}).`
    throw mutates(method) ? new AsideeError("outcome-unknown", `${message} ${method} had been sent, so its outcome is unknown. It was not retried. Reconcile with get before acting again.`) : new AsideeError("incompatible", message)
  }
}

export const staleSummary = (summary: MachineSummary): MachineSummary => ({ ...summary, sandboxes: summary.sandboxes.map((sandbox) => ({ ...sandbox, status: "unknown",
  lastVerify: sandbox.lastVerify && { ...sandbox.lastVerify, results: sandbox.lastVerify.results.map((check) => ({ ...check, status: "unknown", evidence: "none", detail: `Last contact lost. ${check.detail}` })) } })) })

type Peer = Pick<HttpPeer, "call" | "close">
// How the primary reaches another machine: a buffered call, a stream, and SSH's own word for the account and host key.
export type MachineIo = {
  connectPeer: (endpoint: Endpoint) => Peer
  openStream: (endpoint: Endpoint, request: OpenRequest) => Promise<RemoteSession>
  sshIdentity: (endpoint: Endpoint) => Promise<{ user: string; hostKey: string; hostPublicKey: string }>
}
type Cached = { view: HostView & { host: HostRecord }; summary?: MachineSummary; pending?: Promise<void>; failures: number; retryAt: number }
type Forward = { host: string; view: ForwardView & { host: string; machineId: string }; server: Server; lease: RemoteSession; connections: Set<RemoteSession>; timers: Array<ReturnType<typeof setInterval>> }
export class Machines {
  private readonly cache = new Map<string, Cached>()
  private registryWrite: Promise<unknown> = Promise.resolve()
  private readonly forwards = new Map<string, Forward>()
  // Open streams and calls in flight, by host alias, so removing a host or stopping the daemon ends them.
  private readonly sessions = new Map<RemoteSession, string>()
  private readonly peers = new Set<Peer>()
  // Bumped when a host is removed: a stream or forward that was opening for it is ended instead of kept.
  private readonly epochs = new Map<string, number>()
  private closing = false
  private readonly io: MachineIo
  renewMs = LEASE_RENEW_MS
  constructor(readonly dirs: Dirs, readonly hello: Hello, private readonly localSummary: () => Promise<MachineSummary>, io: Partial<MachineIo> = {}) {
    this.io = { connectPeer: (endpoint) => new HttpPeer(endpoint), openStream: (endpoint, request) => RemoteSession.open(endpoint, request), sshIdentity, ...io }
  }

  // Other machines are experimental: with the setting off, this daemon refuses to act as a primary and contacts no host.
  // Answering another machine's primary (a request without a host) is not gated.
  async experimental(): Promise<void> {
    if (!(await readConfig(this.dirs)).experimental) throw new AsideeError("dependency", EXPERIMENTAL_OFF)
  }
  // Turning the setting off ends what still talks to other machines.
  suspend(): void { for (const name of new Set([...this.forwards.values()].map((forward) => forward.host).concat([...this.sessions.values()]))) this.endHost(name, "Other machines were turned off on this machine.") }

  async resolve(host: unknown): Promise<HostRecord> {
    const name = hostName(host)
    const registry = await readHosts(this.dirs)
    const found = registry.hosts.find((entry) => entry.name === name)
    if (found) return found
    const unknown = registry.unknown.find((entry) => entry.name === name)
    if (unknown) throw new AsideeError("incompatible", unknown.error)
    throw new AsideeError("not-found", `There is no host ${name}. See \`asd host list\`. No local fallback was attempted.`)
  }

  private epoch(name: string): number { return this.epochs.get(name) ?? 0 }

  // signal: the client's request. When it goes away, the SSH connection is closed and a sent mutation is outcome-unknown.
  private async peer<T>(host: Endpoint & { machineId?: string }, run: (peer: Peer, hello: Hello) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) throw new AsideeError("conflict", "The daemon is stopping.")
    const peer = this.io.connectPeer(host); this.peers.add(peer)
    const cancel = () => void peer.close("The request was cancelled by its client, and its SSH connection closed.")
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      const hello = parseHello(await peer.call("hello", {}, { timeoutMs: 10_000 }))
      compatible(hello, this.hello, host.machineId, host.binary, "name" in host && typeof host.name === "string" ? { name: host.name, ssh: host.ssh } : undefined)
      return await run(peer, hello)
    } finally { signal?.removeEventListener("abort", cancel); this.peers.delete(peer); await peer.close() }
  }
  private options(host: HostRecord, method: MethodName) {
    return { mutation: mutates(method), machineId: host.machineId, version: this.hello.version, build: this.hello.sourceDigest, timeoutMs: mutates(method) ? MUTATION_DEADLINE_MS : 10_000 }
  }

  async route(method: MethodName, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { host: selected, ...payload } = body
    if (selected === undefined || selected === "local") return undefined
    if (method === "linkAdd" || method === "linkList" || method === "linkRemove") throw new AsideeError("usage", LINKS_LOCAL)
    if (method === "folderBrowse" || method === "folderPreview" || method === "folderChoose") throw new AsideeError("usage", FOLDERS_LOCAL)
    await this.experimental()
    const host = await this.resolve(selected)
    if (body.machineId !== undefined && body.machineId !== host.machineId) throw new AsideeError("identity-changed", `${host.name} is machine ${host.machineId}, not the ${String(body.machineId)} the request names. Nothing was sent.`)
    if (method === "forwardAdd") return this.forwardAdd(host, body, signal)
    if (method === "forwardList") return this.forwardList(host.name, body.name)
    if (method === "forwardRemove") return this.forwardRemove(body.id, host.name)
    if (method === "sshSetup") return this.sshSetup(host, body, signal)
    if (method === "sshAccess") return this.sshAccess(host, body.name, signal)
    if (CATALOG[method][1] === "primary") throw new AsideeError("dependency", `${method} has no remote implementation yet.`)
    return this.peer(host, async (peer, hello) => {
      if (!hello.methods.includes(method)) throw new AsideeError("incompatible", `The daemon on ${host.name} does not offer ${method}.`)
      const result = parseRouted(method, await peer.call(method, payload, this.options(host, method)), hello)
      if (method !== "remove") return result
      // The removal happened there; a failure to tidy this machine's alias is reported beside it, not instead of it.
      try { await updateRemoteAlias(this.dirs, host.name, validName(body.name)) } catch (error) {
        return { ...(result as object), warning: `Removed on ${host.name}, but this machine's SSH alias for it could not be updated: ${(error as Error).message}` }
      }
      return result
    }, signal)
  }

  private async sshSetup(host: HostRecord, body: Record<string, unknown>, signal?: AbortSignal) {
    const name = validName(body.name); const key = await editorKey(this.dirs)
    const result = await this.peer(host, async (peer, hello) => parseRouted("sshPrepare", await peer.call("sshPrepare", { name, publicKey: key.publicKey }, this.options(host, "sshPrepare")), hello), signal) as { sandboxId: string; setup: unknown }
    const setup = parseSshSetup(result.setup)
    if (setup.editorKey !== key.fingerprint) throw new AsideeError("incompatible", "The remote daemon prepared another editor key.")
    await updateRemoteAlias(this.dirs, host.name, name, { host: host.name, name, machineId: host.machineId, sandboxId: result.sandboxId, setup })
    if (body.writeConfig === true) await addInclude(this.dirs)
    return { ...await this.sshAccess(host, name, signal), config: userConfig(), include: includeLine(this.dirs), included: await included(this.dirs), editorKey: key.fingerprint, keyFile: key.path }
  }
  private async sshAccess(host: HostRecord, input: unknown, signal?: AbortSignal) {
    const name = validName(input); const setup = (await remoteAliases(this.dirs)).find((entry) => entry.host === host.name && entry.machineId === host.machineId && entry.name === name)
    const current = await this.peer(host, async (peer, hello) => parseRow(await peer.call("get", { name }, this.options(host, "get")), hello), signal)
    const same = current.sandboxId === setup?.sandboxId
    return { alias: alias(name, host.name), user: same ? setup?.setup.user ?? "" : "", home: same ? setup?.setup.home ?? "" : "", loopbackForwarding: Boolean(same && setup),
      batchReady: Boolean(same && setup && current.status === "running" && await included(this.dirs)) }
  }

  private async target(peer: Peer, host: HostRecord, name: unknown) {
    const value = await peer.call("sessionTarget", { name: validName(name) }, this.options(host, "sessionTarget"))
    if (!object(value) || value.name !== name || value.machineId !== host.machineId || !id(value.sandboxId) || typeof value.generation !== "string" || value.generation.length > 128 || /[\x00-\x1f\x7f]/.test(value.generation)) throw new AsideeError("incompatible", "Invalid remote sandbox identity.")
    return { name: validName(name), machineId: host.machineId, sandboxId: value.sandboxId, generation: value.generation }
  }

  private async remoteSession(host: HostRecord, hello: Hello, request: OpenRequest, epoch: number): Promise<RemoteSession> {
    const session = await this.io.openStream(host, { ...request, host: undefined, machineId: host.machineId, bootId: hello.bootId, protocol: PROTOCOL, version: this.hello.version, build: this.hello.sourceDigest })
    if (this.closing || this.epoch(host.name) !== epoch) {
      session.close("The host was removed, or the daemon is stopping."); await session.closed
      throw new AsideeError("conflict", `${host.name} was removed, or this daemon began stopping, while the session opened. It was closed.`)
    }
    this.sessions.set(session, host.name); void session.closed.finally(() => this.sessions.delete(session))
    return session
  }

  async openSession(request: OpenRequest, local: (request: OpenRequest) => Promise<import("./types").Session>): Promise<import("./types").Session> {
    if (request.host === undefined || request.host === "local") {
      if (request.bootId !== undefined && request.bootId !== this.hello.bootId) throw new AsideeError("identity-changed", "The daemon restarted before this session opened.")
      if (request.protocol !== undefined && (request.protocol !== PROTOCOL || request.version !== this.hello.version || request.build !== this.hello.sourceDigest)) throw new AsideeError("incompatible", "The stream protocol, daemon version or build differs.")
      return local(request)
    }
    await this.experimental()
    const host = await this.resolve(request.host); const epoch = this.epoch(host.name)
    if (request.machineId !== undefined && request.machineId !== host.machineId) throw new AsideeError("identity-changed", `${host.name} is machine ${host.machineId}, not the ${request.machineId} the session names. Nothing was opened.`)
    return this.peer(host, async (peer, hello) => {
      if (!hello.features.includes("remote-streams")) throw new AsideeError("dependency", "The remote daemon does not offer hosted streams.")
      const target = await this.target(peer, host, request.name)
      if (request.sandboxId && request.sandboxId !== target.sandboxId) throw new AsideeError("identity-changed", "The sandbox was recreated; set up its alias again.")
      return this.remoteSession(host, hello, { ...request, ...target }, epoch)
    })
  }

  private async forwardAdd(host: HostRecord, body: Record<string, unknown>, signal?: AbortSignal): Promise<ForwardView> {
    const port = validPort(body.port, "The port"); const local = body.localPort === undefined ? undefined : validPort(body.localPort, "The local port"); const epoch = this.epoch(host.name)
    return this.peer(host, async (peer, hello) => {
      if (!hello.features.includes("remote-forwards")) throw new AsideeError("dependency", "The remote daemon does not offer hosted forwards.")
      const target = await this.target(peer, host, body.name); const leaseId = randomBytes(16).toString("hex")
      const lease = await this.remoteSession(host, hello, { kind: "lease", ...target, port, leaseId }, epoch)
      let server: Server
      try { server = await listenLoopback(local) } catch (error) { lease.close(); await lease.closed; throw error }
      // The registry may have changed while this waited; nothing is registered for a host that was removed meanwhile.
      if (this.closing || this.epoch(host.name) !== epoch) { server.close(); lease.close("The host was removed."); throw new AsideeError("conflict", `${host.name} was removed while the forward was being added. Nothing is listening.`) }
      const forwardId = randomBytes(4).toString("hex"); let heard = Date.now()
      const forward: Forward = { host: host.name, view: { id: forwardId, ...target, host: host.name, localAddress: "127.0.0.1" as const, localPort: boundPort(server), port, createdAt: new Date().toISOString(), connections: 0 }, server, lease, connections: new Set<RemoteSession>(),
        timers: [setInterval(() => { if (Date.now() - heard >= LEASE_TTL_MS) this.endForward(forwardId, `The SSH control stream was silent for ${LEASE_TTL_MS / 1000} seconds; add a new forward explicitly.`) }, 1000),
          // The renewal the remote daemon waits for: without it the remote lease ends on its own.
          setInterval(() => { lease.write(Buffer.from([1])) }, this.renewMs)] }
      for (const timer of forward.timers) timer.unref()
      this.forwards.set(forwardId, forward)
      lease.on("output", () => { heard = Date.now() }); lease.on("end", () => this.endForward(forwardId, "The remote daemon, sandbox run or SSH control link ended.")); lease.resume()
      server.on("connection", async (socket) => {
        socket.on("error", () => {})
        if (!this.forwards.has(forwardId) || Date.now() - heard >= LEASE_TTL_MS) { this.endForward(forwardId, "The SSH control stream expired."); return socket.destroy() }
        let session: RemoteSession
        try { session = await this.remoteSession(host, hello, { kind: "dial", ...target, port, leaseId }, epoch) } catch { return socket.destroy() }
        if (!this.forwards.has(forwardId) || socket.destroyed) { session.close(); socket.destroy(); return }
        forward.connections.add(session)
        // A service closing normally ends only that connection. Transport failure ends the listener as well.
        session.on("end", (exit) => { forward.connections.delete(session); if (session.linkLost) this.endForward(forwardId, exit.error ?? "The SSH relay was lost.") })
        relay(socket, session); session.resume()
      })
      return forward.view
    }, signal)
  }

  private endForward(id: string, reason: string): void {
    const forward = this.forwards.get(id)
    if (!forward) return
    this.forwards.delete(id); for (const timer of forward.timers) clearInterval(timer); forward.server.close(); forward.lease.close(reason)
    for (const session of forward.connections) session.close(reason)
  }
  forwardList(host: string, name?: unknown): ForwardView[] {
    const only = name === undefined ? undefined : validName(name)
    return [...this.forwards.values()].filter((forward) => forward.host === host && (!only || forward.view.name === only)).map((forward) => ({ ...forward.view, connections: forward.connections.size }))
  }
  forwardRemove(id: unknown, host?: string): { closed: string } | undefined {
    if (typeof id !== "string" || !this.forwards.has(id) || (host && this.forwards.get(id)!.host !== host)) {
      if (host) throw new AsideeError("not-found", "No such primary forward for this host.")
      return undefined
    }
    this.endForward(id, "The forward was removed."); return { closed: id }
  }
  private endHost(name: string, reason: string): void {
    this.epochs.set(name, this.epoch(name) + 1)
    for (const [id, forward] of this.forwards) if (forward.host === name) this.endForward(id, reason)
    for (const [session, host] of this.sessions) if (host === name) session.close(reason)
  }
  // Bounded: each SSH process gets SIGTERM, then SIGKILL, and nothing here waits longer than that. The daemon stops the
  // sandboxes only it watches right after, so a stopped or wedged ssh cannot leave them running unwatched.
  async close(): Promise<void> {
    this.closing = true
    for (const id of [...this.forwards.keys()]) this.endForward(id, "The primary daemon stopped.")
    const sessions = [...this.sessions.keys()]; for (const session of sessions) session.close("The primary daemon stopped.")
    const peers = [...this.peers].map((peer) => peer.close("The primary daemon stopped.").catch(() => {}))
    await bounded(Promise.all([...sessions.map((session) => session.closed), ...peers]), 3 * KILL_GRACE_MS)
  }

  // Serializes only registry writes; a slow or unreachable machine never holds another machine's refresh.
  private edit<T>(task: () => Promise<T>): Promise<T> {
    const next = this.registryWrite.then(task, task); this.registryWrite = next.catch(() => {}); return next
  }
  attach(body: Record<string, unknown>, beforeWrite?: () => void, previous?: HostRecord): Promise<HostRecord> {
    return this.edit(async () => {
      await this.experimental()
      const name = hostName(body.name); const registry = await readHosts(this.dirs)
      const existing = registry.hosts.find((host) => host.name === name)
      if (previous && !isDeepStrictEqual(existing, previous)) throw new AsideeError("conflict", `${name}'s registration changed during the update. Existing registration retained; request a new plan.`)
      if (!previous && [...registry.hosts, ...registry.unknown].some((host) => host.name === name)) throw new AsideeError("conflict", `${name} is already registered. Remove it explicitly before enrolling another machine.`)
      const endpoint = { ssh: sshDestination(body.ssh), binary: absolutePath(body.binary), stateDir: absolutePath(body.stateDir) }
      const ssh = await this.io.sshIdentity(endpoint)
      // Enrollment passes the key its plan named: the machine attached must still be that one.
      if (body.hostPublicKey !== undefined && body.hostPublicKey !== ssh.hostPublicKey) throw new AsideeError("identity-changed", `The SSH host key for ${endpoint.ssh} changed from ${typeof body.hostKey === "string" ? body.hostKey : "the planned one"} to ${ssh.hostKey} during enrollment. Nothing was registered. ${enrolledKeyHelp}`)
      if (previous && (previous.hostPublicKey !== ssh.hostPublicKey || !previous.hostPublicKey))
        throw new AsideeError("identity-changed", "The registered SSH host key changed. Existing registration retained.")
      const pinned = { ...endpoint, ...(previous ? { machineId: previous.machineId } : {}), hostKey: ssh.hostKey, hostPublicKey: ssh.hostPublicKey }
      const hello = await this.peer(pinned, async (_peer, hello) => hello)
      if (hello.machineId === this.hello.machineId || [...registry.hosts, ...registry.unknown].some((host) => host.name !== previous?.name && host.machineId === hello.machineId)) throw new AsideeError("conflict", "This machine identity is already registered.")
      const host: HostRecord = { name, ...endpoint, machineId: hello.machineId, addedAt: previous?.addedAt ?? new Date().toISOString(), diskPolicy: "watched", service: body.service === "systemd" ? "systemd" : "prepared", sshUser: ssh.user, hostKey: ssh.hostKey, hostPublicKey: ssh.hostPublicKey }
      beforeWrite?.()
      await writeHosts(this.dirs, previous ? registry.entries.map((entry, index) => recordName(entry, index) === name ? host : entry) : [...registry.entries, host])
      if (previous) { this.endHost(name, "The host was updated."); this.cache.delete(name) }
      return host
    })
  }
  remove(body: Record<string, unknown>): Promise<{ removed: string; remoteRetained: true }> {
    return this.edit(async () => {
      await this.experimental()
      const name = hostName(body.name); const registry = await readHosts(this.dirs)
      if (![...registry.hosts, ...registry.unknown].some((host) => host.name === name)) throw new AsideeError("not-found", `There is no host ${name}. See \`asd host list\`.`)
      if (body.confirm !== name) throw new AsideeError("usage", "Confirm removal with --confirm NAME. A prepared daemon and all remote data are retained.")
      this.endHost(name, "The host was removed.")
      await writeHosts(this.dirs, registry.entries.filter((entry, index) => recordName(entry, index) !== name))
      await updateRemoteAlias(this.dirs, name)
      this.cache.delete(name); return { removed: name, remoteRetained: true }
    })
  }

  private refresh(host: HostRecord): Promise<void> {
    const cache = this.cache.get(host.name) ?? { view: { host, state: "connecting" }, failures: 0, retryAt: 0 }
    this.cache.set(host.name, cache)
    if (cache.pending) return cache.pending
    cache.pending = this.peer(host, async (peer, hello) => {
      const summary = parseSummary(await peer.call("summary", {}, this.options(host, "summary")), hello)
      cache.summary = summary; cache.view = { host, state: "online", hello, receivedAt: new Date().toISOString() }; cache.failures = 0; cache.retryAt = Date.now() + 5000
    }).catch((error) => {
      cache.view = { ...cache.view, state: error instanceof AsideeError && (error.code === "incompatible" || error.code === "identity-changed") ? error.code : "offline", error: (error as Error).message }
      cache.retryAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(++cache.failures, 6))
    }).finally(() => { delete cache.pending })
    return cache.pending
  }

  // A host removed while these wait is left out, not reported as a failure of the whole call.
  async list(): Promise<HostView[]> {
    await this.experimental()
    const registry = await readHosts(this.dirs)
    await Promise.all(registry.hosts.map((host) => this.refresh(host)))
    return [...registry.hosts.flatMap((host) => { const view = this.cache.get(host.name)?.view; return view ? [view] : [] }),
      ...registry.unknown.map((host): HostView => ({ host, state: "unknown-record", error: host.error }))]
  }
  async fleet(refresh?: unknown): Promise<FleetView> {
    await this.experimental()
    const registry = await readHosts(this.dirs); const hosts = registry.hosts
    if (refresh !== undefined && (typeof refresh !== "string" || !hosts.some((host) => host.name === refresh))) throw new AsideeError("not-found", "No such host to refresh.")
    for (const host of hosts) if (host.name === refresh || Date.now() >= (this.cache.get(host.name)?.retryAt ?? 0)) void this.refresh(host)
    const local = await this.localSummary()
    return { machines: [{ machine: { host: { name: "local", machineId: this.hello.machineId }, state: "online" }, cached: local, stale: false },
      ...hosts.flatMap((host) => {
        const cache = this.cache.get(host.name)
        if (!cache) return []
        const stale = cache.view.state !== "online" || Date.now() - Date.parse(cache.view.receivedAt ?? "") > 15_000
        return [{ machine: cache.view, ...(cache.summary ? { cached: stale ? staleSummary(cache.summary) : cache.summary } : {}), stale }]
      }),
      ...registry.unknown.map((host) => ({ machine: { host, state: "unknown-record" as const, error: host.error }, stale: true }))] }
  }
}
