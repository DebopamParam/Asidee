import { spawn } from "node:child_process"
import { Agent, request } from "node:http"
import { connect } from "node:net"
import { Duplex } from "node:stream"
import { PaddockError, type ErrorCode } from "./types"

export const PROTOCOL = 1
export const MAX_REPLY = 8 * 1024 ** 2
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

export const sshArgv = (destination: string, command: readonly string[]) => ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
  "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none",
  "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3", sshDestination(destination), command.map(shellQuote).join(" ")]

export type Endpoint = { ssh: string; binary: string; stateDir: string }
export function transportCommand(host: Endpoint, stream = false): string[] {
  return ["/usr/bin/env", `PADDOCK_STATE_DIR=${absolutePath(host.stateDir)}`, absolutePath(host.binary), "transport", "stdio", "--protocol", String(PROTOCOL), ...(stream ? ["--stream"] : [])]
}

// One isolated SSH process per connection. stderr is diagnostic only and never mixed with protocol bytes.
export function sshConnection(host: Endpoint, stream = false) {
  const child = spawn("ssh", sshArgv(host.ssh, transportCommand(host, stream)).slice(1), { stdio: ["pipe", "pipe", "pipe"] })
  const wire = new Duplex({ read() { child.stdout.resume() }, write(chunk, _encoding, done) { child.stdin.write(chunk, done) }, final(done) { child.stdin.end(done) } })
  child.stdout.on("data", (chunk: Buffer) => { if (!wire.push(chunk)) child.stdout.pause() })
  child.stdout.on("end", () => wire.push(null))
  child.stdin.on("error", (error) => wire.destroy(error))
  let diagnostic = ""
  child.stderr.on("data", (bytes: Buffer) => { if (diagnostic.length < 4000) diagnostic += bytes.toString().slice(0, 4000 - diagnostic.length) })
  child.on("error", (error) => wire.destroy(error))
  const exited = new Promise<void>((resolve) => child.once("close", () => { wire.destroy(); resolve() }))
  wire.on("error", () => {})
  return { wire, diagnostic: () => diagnostic.trim(), async close() { wire.destroy(); child.kill(); await exited } }
}

export function parseReply(value: unknown): unknown {
  if (!object(value) || typeof value.ok !== "boolean") throw new PaddockError("incompatible", "The remote daemon returned a malformed reply.")
  if (value.ok) { if (!Object.hasOwn(value, "data")) throw new PaddockError("incompatible", "The remote daemon returned no data."); return value.data }
  const error = value.error
  if (!object(error) || typeof error.code !== "string" || !ERROR_CODES.some((code) => code === error.code) || typeof error.message !== "string") throw new PaddockError("incompatible", "The remote daemon returned a malformed error.")
  const code = ERROR_CODES.find((code) => code === error.code)!
  throw new PaddockError(code, error.message, error.details)
}

// hello and the operation use the same daemon connection. A reconnect never replays a mutation.
export class HttpPeer {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 1 })
  private readonly connection: ReturnType<typeof sshConnection>
  constructor(readonly endpoint: Endpoint) {
    this.connection = sshConnection(endpoint)
    this.agent.createConnection = () => this.connection.wire
    // SSH owns keepalives and connection lifetime; the HTTP agent must not apply TCP operations to its byte pipe.
    this.agent.keepSocketAlive = () => true
    this.agent.reuseSocket = () => {}
  }
  async call(method: string, body: object = {}, options: { timeoutMs?: number; mutation?: boolean; machineId?: string; version?: string } = {}): Promise<unknown> {
    let dispatched = false
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(body))
        const req = request({ host: "paddock", path: `/api/${method}`, method: "POST", agent: this.agent, headers: { "content-type": "application/json", "content-length": bytes.length,
          ...(options.machineId ? { "x-paddock-machine": options.machineId, "x-paddock-protocol": String(PROTOCOL), "x-paddock-version": options.version ?? "" } : {}) } }, (res) => {
          let size = 0; const chunks: Buffer[] = []
          res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_REPLY) { req.destroy(new PaddockError("incompatible", "The remote JSON reply exceeded 8 MiB; use a stream for large output.")); return }; chunks.push(chunk) })
          res.on("error", reject)
          res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())) } catch { reject(new PaddockError("incompatible", "The remote daemon returned invalid JSON.")) } })
        })
        req.on("error", reject)
        req.once("finish", () => { dispatched = true })
        const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => req.destroy(new Error("The remote request timed out.")), options.timeoutMs)
        req.once("close", () => clearTimeout(timer))
        req.end(bytes)
      })
      return parseReply(value)
    } catch (error) {
      if (error instanceof PaddockError) throw error
      throw new PaddockError(options.mutation && dispatched ? "outcome-unknown" : "offline", options.mutation && dispatched
        ? `The SSH link to ${this.endpoint.ssh} ended after sending ${method}; its outcome is unknown. It was not retried. Reconcile with get before acting again.`
        : `${this.endpoint.ssh} is unreachable: ${this.connection.diagnostic() || (error as Error).message}`)
    }
  }
  async close(): Promise<void> { this.agent.destroy(); await this.connection.close() }
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
