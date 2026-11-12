import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, request } from "node:http"
import { connect } from "node:net"
import { Duplex } from "node:stream"
import { EventEmitter } from "node:events"
import { dataFrames, frame, FrameReader, MAX_MESSAGE, type Frame, type OpenRequest } from "./stream"
import { PaddockError, type ErrorCode, type Session } from "./types"

export const PROTOCOL = 1
export const MAX_REPLY = 8 * 1024 ** 2
// A mutation can download an image or install sshd, but never waits for ever: past this its outcome is unknown.
export const MUTATION_DEADLINE_MS = 45 * 60_000
// How long a closing SSH process gets after SIGTERM, and then after SIGKILL, before its close is given up on. A stopped
// or wedged ssh must not hold a daemon's shutdown, which stops the sandboxes only that daemon watches.
export const KILL_GRACE_MS = 1500
// A promise that settles by `ms` at the latest, whose timer is cleared once it settles, so it never keeps a stopping
// process alive (Bun.sleep cannot be cancelled).
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let clear = () => {}
  return Promise.race([promise, new Promise<undefined>((resolve) => { const timer = setTimeout(resolve, ms); clear = () => clearTimeout(timer) })]).finally(() => clear())
}
export const ERROR_CODES: readonly ErrorCode[] = ["usage", "not-found", "conflict", "dependency", "check-failed", "runtime", "offline", "incompatible", "identity-changed", "outcome-unknown"]
export const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
export const shellQuote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

export function sshDestination(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(value))
    throw new PaddockError("usage", "The SSH destination must be an alias or user@hostname, without options or configuration fragments.")
  return value
}

export function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) throw new PaddockError("usage", "An absolute path without control characters is required.")
  return value
}

export const sshArgv = (destination: string, command: readonly string[], options: readonly string[] = []) => ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
  "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", ...options, sshDestination(destination), command.map(shellQuote).join(" ")]

// hostKey: the SHA-256 fingerprint shown to people. hostPublicKey: the key itself ("TYPE BASE64"), which every connection
// is pinned to. A record from before the public key was kept has only the fingerprint and is refused.
export type Endpoint = { ssh: string; binary: string; stateDir: string; hostKey?: string; hostPublicKey?: string }
export function transportCommand(host: Endpoint, stream = false): string[] {
  return ["/usr/bin/env", `PADDOCK_STATE_DIR=${absolutePath(host.stateDir)}`, absolutePath(host.binary), "transport", "stdio", "--protocol", String(PROTOCOL), ...(stream ? ["--stream"] : [])]
}

export function hostPublicKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9@.-]{0,63} [A-Za-z0-9+/]{16,16384}={0,2}$/.test(value) || value.includes("-cert-")) throw new PaddockError("usage", "A host public key must be one known_hosts key: its type and base64, without a certificate.")
  return value
}
// As `ssh-keygen -l` prints it.
export const keyFingerprint = (publicKey: string) => `SHA256:${createHash("sha256").update(Buffer.from(publicKey.split(" ")[1]!, "base64")).digest("base64").replace(/=+$/, "")}`

// ssh splits option values at whitespace and expands % and ~ in file names, so a private file's path must have none.
function privateFolder(): string {
  const base = /^[A-Za-z0-9_./-]+$/.test(tmpdir()) ? tmpdir() : "/tmp"
  return mkdtempSync(join(base, "paddock-ssh-"))
}
const PIN_ALIAS = "paddock-enrolled-host"
// The destination is checked against this one key and nothing else: not the user's known_hosts or global file, DNS, or
// a KnownHostsCommand. OpenSSH does that check itself, before authentication, so nothing the server sends (a banner
// reaches the same stderr as -v's lines) can pass it, and no byte is sent or read before it. A ProxyJump hop runs its own
// ssh, which these options do not reach, so the user's own trust still checks the jump host.
export function pinnedKnownHosts(publicKey: string): { options: string[]; remove(): void } {
  const folder = privateFolder(); const file = join(folder, "known_hosts")
  writeFileSync(file, `${PIN_ALIAS} ${hostPublicKey(publicKey)}\n`, { mode: 0o600 })
  return { options: ["-o", `UserKnownHostsFile=${file}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", `HostKeyAlias=${PIN_ALIAS}`, "-o", "CheckHostIP=no", "-o", "VerifyHostKeyDNS=no", "-o", "KnownHostsCommand=none"],
    remove: () => rmSync(folder, { recursive: true, force: true }) }
}
// OpenSSH runs KnownHostsCommand with the key the server offered in key exchange (%I is HOSTNAME for the destination's
// lookup), then goes on only if the user's own known_hosts trusts that key. So the key captured on a connection that got
// past the check (ssh did not exit 255) is the one the user's trust accepted, written by ssh and not by the server. It
// replaces a KnownHostsCommand of the user's own for that connection.
export function hostKeyCapture(destination: string): { options: string[]; read(exitCode: number | null): string; remove(): void } {
  const folder = privateFolder(); const file = join(folder, "offered")
  return {
    options: ["-o", `KnownHostsCommand=/bin/sh -c 'printf "%%s %%s %%s\\n" "$1" "$2" "$3" >> "$0"' ${file} %I %t %K`],
    read(exitCode) {
      if (exitCode === 255 || exitCode === null) throw new PaddockError("dependency", `SSH could not connect to ${destination} with the user's own host trust, so no host key was recorded.`)
      let offered = ""; try { offered = readFileSync(file, "utf8") } catch {}
      const keys = new Set(offered.split("\n").filter((line) => line.startsWith("HOSTNAME ") && !line.includes("-cert-")).map((line) => line.slice("HOSTNAME ".length)))
      if (keys.size !== 1) throw new PaddockError("dependency", `SSH did not report exactly one host key it verified for ${destination}, so no host key was recorded. Paddock needs OpenSSH 8.5 or later (KnownHostsCommand) first on PATH, and a plain host key rather than only a certificate.`)
      return hostPublicKey([...keys][0])
    },
    remove: () => rmSync(folder, { recursive: true, force: true }),
  }
}
export const enrolledKeyHelp = "Check the destination, remove its host record with `paddock host remove NAME --confirm NAME`, then re-enroll deliberately with `paddock host add` or `paddock host attach`."
function pinRefusal(host: Endpoint): PaddockError | undefined {
  if (host.hostKey && !host.hostPublicKey) return new PaddockError("identity-changed", `${host.ssh} was enrolled with only its host-key fingerprint, read from ssh's verbose output, where text the server sends before authentication can imitate it. Paddock now pins the whole public key and does not use this record. Nothing was sent. ${enrolledKeyHelp}`)
}

// One isolated SSH process per connection. stderr is diagnostic only and never mixed with protocol bytes.
export function sshConnection(host: Endpoint, stream = false) {
  const old = pinRefusal(host)
  if (old) {
    const wire = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(old) } }); wire.on("error", () => {})
    const ready = Promise.reject(old); void ready.catch(() => {})
    return { wire, ready, pid: undefined as number | undefined, diagnostic: () => old.message, refusal: async () => old, async close() { wire.destroy() } }
  }
  const pin = host.hostPublicKey ? pinnedKnownHosts(host.hostPublicKey) : undefined
  const argv = sshArgv(host.ssh, transportCommand(host, stream), pin?.options)
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] })
  const wire = new Duplex({ read() { child.stdout.resume() }, write(chunk, _encoding, done) { child.stdin.write(chunk, done) }, final(done) { child.stdin.end(done) } })
  let outputEnded = false
  child.stdout.on("data", (chunk: Buffer) => { if (!wire.push(chunk)) child.stdout.pause() })
  child.stdout.on("end", () => { outputEnded = true; wire.push(null) })
  child.stdin.on("error", (error) => wire.destroy(error))
  let diagnostic = ""; let messages = ""
  child.stderr.on("data", (bytes: Buffer) => {
    if (diagnostic.length < 4000) diagnostic += bytes.toString().slice(0, 4000 - diagnostic.length)
    if (messages.length < 65536) messages += bytes.toString()
  })
  child.on("error", (error) => wire.destroy(error))
  let done = false; let refused: PaddockError | undefined
  // ssh can be gone while its last output still waits behind a slow reader: the wire closes once that is read.
  const exited = new Promise<void>((resolve) => child.once("close", (code) => {
    done = true; pin?.remove()
    // A ProxyJump hop's own refusal reaches the same stderr; only one that names the pin's alias is the destination's.
    if (pin && code === 255 && messages.includes("Host key verification failed.") && messages.includes(`for ${PIN_ALIAS} `)) {
      const offered = diagnostic.match(/key sent by the remote host is\s+(SHA256:[A-Za-z0-9+/]{43})/)?.[1]
      refused = new PaddockError("identity-changed", `The SSH host key for ${host.ssh} is not the one recorded at enrollment (${host.hostKey ?? keyFingerprint(host.hostPublicKey!)})${offered ? `; it offered ${offered}` : ""}. OpenSSH refused it before anything was sent. ${enrolledKeyHelp}`)
    }
    if (wire.readableEnded) wire.destroy(); else wire.once("end", () => wire.destroy()); resolve()
  }))
  wire.on("error", () => {})
  const settled = (ms: number) => bounded(exited, ms).then(() => done)
  return { wire, ready: Promise.resolve(), pid: child.pid, diagnostic: () => diagnostic.trim(),
    // Whether the link ended because the pinned key was refused. Asked only once output ended, when ssh exits at once.
    refusal: async () => { if (outputEnded) await settled(KILL_GRACE_MS); return refused },
    async close() {
      wire.destroy(); child.kill()
      if (!await settled(KILL_GRACE_MS)) { child.kill("SIGKILL"); await settled(KILL_GRACE_MS) }
    } }
}
export type Connection = Pick<ReturnType<typeof sshConnection>, "wire" | "diagnostic" | "close"> & { pid?: number; ready?: Promise<void>; refusal?: () => Promise<PaddockError | undefined> }

class RemoteFailure extends PaddockError {}
export function parseReply(value: unknown): unknown {
  if (!object(value) || typeof value.ok !== "boolean") throw new PaddockError("incompatible", "The remote daemon returned a malformed reply.")
  if (value.ok) { if (!Object.hasOwn(value, "data")) throw new PaddockError("incompatible", "The remote daemon returned no data."); return value.data }
  const error = value.error
  if (!object(error) || typeof error.code !== "string" || !ERROR_CODES.some((code) => code === error.code) || typeof error.message !== "string") throw new PaddockError("incompatible", "The remote daemon returned a malformed error.")
  const code = ERROR_CODES.find((code) => code === error.code)!
  throw new RemoteFailure(code, error.message.slice(0, MAX_MESSAGE), error.details)
}

// hello and the operation use the same daemon connection. A reconnect never replays a mutation.
export class HttpPeer {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 })
  private readonly connection: Connection
  // Why the connection was closed under a call in flight (its client went away, the host was removed).
  private ended?: string
  constructor(readonly endpoint: Endpoint, connection?: Connection) {
    this.connection = connection ?? sshConnection(endpoint)
    this.agent.createConnection = () => this.connection.wire
    // SSH owns keepalives and connection lifetime; the HTTP agent must not apply TCP operations to its byte pipe.
    this.agent.keepSocketAlive = () => true
    this.agent.reuseSocket = () => {}
  }
  async call(method: string, body: object = {}, options: { timeoutMs?: number; mutation?: boolean; machineId?: string; version?: string; build?: string } = {}): Promise<unknown> {
    let dispatched = false; let settle = () => {}
    try {
      await this.connection.ready
      const value = await new Promise<unknown>((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(body))
        const req = request({ host: "paddock", path: `/api/${method}`, method: "POST", agent: this.agent, headers: { "content-type": "application/json", "content-length": bytes.length,
          ...(options.machineId ? { "x-paddock-machine": options.machineId, "x-paddock-protocol": String(PROTOCOL), "x-paddock-version": options.version ?? "", "x-paddock-build": options.build ?? "" } : {}) } }, (res) => {
          let size = 0; const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_REPLY) { req.destroy(new PaddockError("incompatible", "The remote JSON reply exceeded 8 MiB; use a stream for large output.")); return }; chunks.push(chunk) })
          res.on("error", reject)
          res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(new PaddockError("incompatible", "The remote daemon returned invalid JSON.")) } })
        })
        req.on("error", reject)
        req.once("finish", () => { dispatched = true })
        const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { const late = new Error(`No reply came within ${Math.round(options.timeoutMs! / 1000)} seconds.`); req.destroy(late); reject(late) }, options.timeoutMs)
        // Bun's request on a connection that is gone emits nothing, even when destroyed, so the call settles by itself.
        const lost = () => reject(new Error("The connection closed before a reply arrived."))
        if (this.connection.wire.destroyed) lost(); else this.connection.wire.once("close", lost)
        settle = () => { clearTimeout(timer); this.connection.wire.off("close", lost) }
        req.end(bytes)
      }).finally(() => settle())
      return parseReply(value)
    } catch (error) {
      if (error instanceof RemoteFailure) throw error
      const refused = await this.connection.refusal?.()
      if (refused) throw refused
      // Said as it happened: a reply that was unusable is not a lost link, and a cancelled request is neither.
      const cause = this.ended ?? (error instanceof PaddockError ? error.message : `The SSH link to ${this.endpoint.ssh} ended: ${this.connection.diagnostic() || (error as Error).message}`)
      if (options.mutation && dispatched) throw new PaddockError("outcome-unknown", `${cause} ${method} had been sent to ${this.endpoint.ssh}, so its outcome is unknown. It was not retried. Reconcile with get before acting again.`)
      if (error instanceof PaddockError) throw error
      throw new PaddockError("offline", this.ended ?? `${this.endpoint.ssh} is unreachable: ${this.connection.diagnostic() || (error as Error).message}`)
    }
  }
  async close(reason?: string): Promise<void> { this.ended ??= reason; this.agent.destroy(); await this.connection.close() }
}

// The account and outer host key SSH really uses for a destination, from ssh itself: `ssh -G` resolves the user from the
// user's own configuration, and a capture (above) records the key the user's trust accepted. Recorded when attached.
export async function sshIdentity(endpoint: Endpoint): Promise<{ user: string; hostKey: string; hostPublicKey: string }> {
  // env: Bun otherwise resolves "ssh" with the PATH this process started with, unlike node:child_process for connections.
  const config = Bun.spawn(["ssh", "-G", sshDestination(endpoint.ssh)], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env })
  const [resolved, settings] = await Promise.all([config.exited, new Response(config.stdout).text()])
  const user = settings.match(/^user ([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/m)?.[1]
  if (resolved !== 0 || !user) throw new PaddockError("dependency", `SSH did not report the user it uses for ${endpoint.ssh}, so nothing was registered.`)
  // The fixed transport command again, with stdin closed: it reaches the daemon socket and ends at once.
  const capture = hostKeyCapture(endpoint.ssh)
  try {
    const argv = sshArgv(endpoint.ssh, transportCommand(endpoint), capture.options)
    const probe = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 20_000, env: process.env })
    const key = capture.read(await probe.exited)
    return { user, hostKey: keyFingerprint(key), hostPublicKey: key }
  } finally { capture.remove() }
}

// This mode relays only to an existing private socket. It never starts or replaces a daemon.
export async function transportStdio(path: string): Promise<void> {
  const socket = connect(path)
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
  await new Promise<void>((resolve, reject) => {
    socket.on("error", reject); socket.on("close", () => { process.stdin.unpipe(socket); process.stdin.pause(); resolve() })
    process.stdin.on("error", () => socket.destroy()); process.stdout.on("error", () => socket.destroy())
    process.stdin.pipe(socket); socket.pipe(process.stdout)
    process.stdin.on("end", () => socket.end())
  })
}

// Remote stdout is frames, never executable instructions. The one-frame/socket bound applies on both SSH pipes too.
export class RemoteSession extends EventEmitter implements Session {
  readonly tty: boolean
  linkLost = false
  private readonly connection: Connection
  private readonly reader = new FrameReader()
  private pending: Frame[] = []
  private paused = true
  private done = false
  private ready = false
  private wireClosed = false
  private opened: (error?: PaddockError) => void = () => {}
  readonly closed: Promise<void>
  private closedResolve: () => void = () => {}
  private readonly timer: ReturnType<typeof setTimeout>
  private constructor(host: Endpoint, request: OpenRequest, connection?: Connection) {
    super(); this.tty = request.kind === "exec" && request.tty
    this.connection = connection ?? sshConnection(host, true)
    this.closed = new Promise((resolve) => { this.closedResolve = resolve })
    const wire = this.connection.wire
    wire.on("drain", () => this.emit("drain"))
    wire.on("error", (error) => { if (!this.done) this.linkLost = true; this.finish({ error: `The SSH session was lost: ${error.message}` }) })
    // Frames already read, an exit among them, are still delivered after the wire closes (flush).
    wire.on("close", () => { this.wireClosed = true; this.flush() })
    wire.on("data", (chunk: Buffer) => {
      try {
        const frames = this.reader.push(chunk)
        if (!this.ready) {
          const first = frames.shift()
          if (!first) return
          if (first.kind === "error") { const error = this.error(first.payload); this.opened(error); return this.finish({ error: error.message }) }
          if (first.kind !== "ready") throw new PaddockError("incompatible", "The remote stream did not send ready.")
          this.ready = true; clearTimeout(this.timer); wire.pause(); this.pending.push(...frames); this.opened(); return
        }
        this.pending.push(...frames); this.flush()
      } catch (error) { const failure = error instanceof PaddockError ? error : new PaddockError("incompatible", "Malformed remote stream."); this.opened(failure); this.finish({ error: failure.message }) }
    })
    this.timer = setTimeout(() => { this.opened(new PaddockError("offline", "The remote stream did not become ready in 10 seconds.")); this.finish({ error: "The remote stream timed out." }) }, 10_000)
    void Promise.resolve(this.connection.ready).then(() => { if (!this.done) wire.write(frame("open", request)) }, (error) => {
      this.opened(error); this.finish({ error: error.message })
    })
  }
  static async open(host: Endpoint, request: OpenRequest, connection?: Connection): Promise<RemoteSession> {
    const session = new RemoteSession(host, request, connection)
    await new Promise<void>((resolve, reject) => { session.opened = (error) => error ? reject(error) : resolve() })
    return session
  }
  private error(payload: Buffer): PaddockError {
    const value: unknown = JSON.parse(payload.toString())
    if (!object(value) || typeof value.message !== "string" || !ERROR_CODES.some((code) => code === value.code)) return new PaddockError("incompatible", "Malformed remote stream error.")
    return new PaddockError(ERROR_CODES.find((code) => code === value.code)!, value.message.slice(0, MAX_MESSAGE))
  }
  private flush(): void {
    try {
    while (!this.paused && !this.done && this.pending.length) {
      const piece = this.pending.shift()!
      if (piece.kind === "stdout" || piece.kind === "stderr") this.emit("output", piece.kind, piece.payload)
      else if (piece.kind === "error") this.finish({ error: this.error(piece.payload).message })
      else if (piece.kind === "exit") {
        const value: unknown = JSON.parse(piece.payload.toString())
        if (!object(value) || !Number.isInteger(value.code) || Number(value.code) < -1 || Number(value.code) > 255) return this.finish({ error: "Malformed remote exit status." })
        this.finish({ code: Number(value.code) })
      } else this.finish({ error: `A remote daemon cannot send ${piece.kind}.` })
    }
    } catch { this.finish({ error: "Malformed remote stream control frame." }) }
    if (this.wireClosed && !this.done && !this.pending.length) { this.linkLost = true; this.finish({ error: `The SSH session was lost before an exit status arrived. ${this.connection.diagnostic()}`.trim() }) }
  }
  private finish(exit: { code?: number; error?: string }): void {
    if (this.done) return
    this.done = true; clearTimeout(this.timer)
    this.pending = []
    // The SSH process is closed whatever a listener does with the end, so `closed` always settles.
    try {
      if (!this.ready) {
        const offline = new PaddockError("offline", exit.error ?? "The remote stream ended before ready.")
        void (this.connection.refusal?.() ?? Promise.resolve(undefined)).then((refused) => this.opened(refused ?? offline), () => this.opened(offline))
      }
      this.emit("end", exit)
    } finally { void this.connection.close().finally(() => this.closedResolve()) }
  }
  write(bytes: Uint8Array): boolean { let writable = true; for (const piece of dataFrames("stdin", bytes)) if (!this.connection.wire.write(piece)) writable = false; return writable }
  end(): void { this.connection.wire.write(frame("eof")) }
  async resize(cols: number, rows: number): Promise<void> { this.connection.wire.write(frame("resize", { cols, rows })) }
  pause(): void { this.paused = true; this.connection.wire.pause() }
  resume(): void { this.paused = false; this.flush(); if (!this.paused && !this.done) this.connection.wire.resume() }
  close(reason = "The SSH session was closed."): void { this.finish({ error: reason }) }
}
