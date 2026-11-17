import type { Socket } from "node:net"
import { validPort } from "./forwards"
import { validName } from "./state"
import { AsideeError, type ErrorCode, type Session } from "./types"

// asidee-stream/1, spoken only on the daemon's second Unix socket (stream.sock). Each frame is one kind byte, a
// four-byte big-endian length and at most 64 KiB of payload, so stdout and stderr stay apart and nothing is decoded.
// The client sends `open` and waits for `ready` (or `error`); then stdin, eof and resize go one way, and stdout, stderr
// and a last exit or error the other.
export const KINDS = ["open", "ready", "stdin", "stdout", "stderr", "eof", "resize", "exit", "error"] as const
export type Kind = typeof KINDS[number]
export type Frame = { kind: Kind; payload: Buffer }
export const MAX_PAYLOAD = 64 * 1024
// Error messages in a frame are cut to this many characters (at most six bytes each in JSON), well under a payload.
export const MAX_MESSAGE = 4000
const HEADER = 5

export function frame(kind: Kind, payload: Uint8Array | string | object = new Uint8Array()): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload instanceof Uint8Array ? payload : Buffer.from(JSON.stringify(payload))
  if (body.byteLength > MAX_PAYLOAD) throw new RangeError(`A frame carries at most ${MAX_PAYLOAD} bytes.`)
  const out = Buffer.allocUnsafe(HEADER + body.byteLength)
  out[0] = KINDS.indexOf(kind) + 1; out.writeUInt32BE(body.byteLength, 1); out.set(body, HEADER)
  return out
}

// Data of any size, as frames of at most 64 KiB.
export function dataFrames(kind: "stdin" | "stdout" | "stderr", bytes: Uint8Array): Buffer[] {
  const out: Buffer[] = []
  for (let at = 0; at < bytes.byteLength; at += MAX_PAYLOAD) out.push(frame(kind, bytes.subarray(at, at + MAX_PAYLOAD)))
  return out
}

// Splits bytes into frames. It holds at most one unfinished frame, so a peer cannot make it buffer more than 64 KiB.
export class FrameReader {
  private pending = Buffer.alloc(0)
  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk)
    const frames: Frame[] = []
    while (this.pending.length >= HEADER) {
      const kind = KINDS[this.pending[0]! - 1]
      if (!kind) throw new AsideeError("usage", "Not a asidee-stream/1 frame.")
      const size = this.pending.readUInt32BE(1)
      if (size > MAX_PAYLOAD) throw new AsideeError("usage", `A frame carries at most ${MAX_PAYLOAD} bytes.`)
      if (this.pending.length < HEADER + size) break
      frames.push({ kind, payload: this.pending.subarray(HEADER, HEADER + size) })
      this.pending = this.pending.subarray(HEADER + size)
    }
    return frames
  }
}

type RelayRequest = { name: string; sandboxId: string; generation: string; port: number; leaseId: string }
type SessionRequest =
  | { kind: "exec"; name: string; argv: string[]; user?: string; tty: boolean; cols?: number; rows?: number }
  | { kind: "workspace"; name: string; argv: string[]; tty: boolean; cols?: number; rows?: number }
  | { kind: "ssh"; name: string }
  | ({ kind: "lease" } & RelayRequest)
  | ({ kind: "dial" } & RelayRequest)
export type OpenRequest = SessionRequest & { host?: string; machineId?: string; bootId?: string; protocol?: number; version?: string; build?: string; sandboxId?: string; generation?: string }
export type EnrollmentRequest = { kind: "enroll"; hash: string; accepted: true; host?: string }

export function enrollmentHash(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value) || value.kind !== "enroll") return undefined
  if (!("hash" in value) || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !("accepted" in value) || value.accepted !== true || "host" in value && value.host !== undefined && value.host !== "local")
    throw new AsideeError("usage", "Enrollment needs accepted:true and a reviewed plan hash on the primary socket.")
  return value.hash
}

const USER = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/
const size = (value: unknown, what: string) => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000) throw new AsideeError("usage", `${what} must be a whole number from 1 to 10000.`)
  return value as number
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AsideeError("usage", "A session request is a JSON object.")
  return value as Record<string, unknown>
}

// The only way a session request is read. Unknown fields are dropped, as in a spec.
export function parseOpen(value: unknown): OpenRequest {
  const body = record(value)
  const name = validName(body.name)
  const route: Pick<OpenRequest, "host" | "machineId" | "bootId" | "protocol" | "version" | "build" | "sandboxId" | "generation"> = {}
  if (body.host !== undefined) route.host = validName(body.host)
  for (const key of ["machineId", "bootId", "sandboxId"] as const) if (body[key] !== undefined) {
    if (typeof body[key] !== "string" || !/^[a-f0-9]{32}$/.test(body[key])) throw new AsideeError("usage", `${key} must be an identity.`)
    route[key] = body[key]
  }
  if (body.protocol !== undefined) { if (!Number.isSafeInteger(body.protocol)) throw new AsideeError("usage", "protocol must be an integer."); route.protocol = body.protocol as number }
  for (const key of ["version", "build", "generation"] as const) if (body[key] !== undefined) {
    if (typeof body[key] !== "string" || body[key].length > 128 || /[\x00-\x1f]/.test(body[key])) throw new AsideeError("usage", `${key} must be bounded text.`)
    route[key] = body[key]
  }
  if (body.kind === "ssh") return { ...route, kind: "ssh", name }
  if (body.kind === "lease" || body.kind === "dial") {
    if (!route.sandboxId || !route.generation || typeof body.leaseId !== "string" || !/^[a-f0-9]{32}$/.test(body.leaseId)) throw new AsideeError("usage", "A relay needs sandbox identity, run generation and lease identity.")
    return { ...route, kind: body.kind, name, sandboxId: route.sandboxId, generation: route.generation, port: validPort(body.port, "The relay port"), leaseId: body.leaseId }
  }
  if (body.kind !== "exec" && body.kind !== "workspace") throw new AsideeError("usage", "A session is an exec, workspace or ssh session.")
  const argv = body.argv
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && !part.includes("\0"))) throw new AsideeError("usage", "exec needs a command.")
  if (body.user !== undefined && (typeof body.user !== "string" || !USER.test(body.user))) throw new AsideeError("usage", "The user must be a user name or id.")
  if (body.tty !== undefined && typeof body.tty !== "boolean") throw new AsideeError("usage", "tty must be true or false.")
  const tty = body.tty === true
  if (body.kind === "workspace") {
    if (route.host && route.host !== "local" || body.user !== undefined) throw new AsideeError("usage", "Workspace sessions run locally as this user.")
    return { ...route, kind: "workspace", name, argv: argv as string[], tty,
      ...(tty && body.cols !== undefined ? { cols: size(body.cols, "cols") } : {}), ...(tty && body.rows !== undefined ? { rows: size(body.rows, "rows") } : {}) }
  }
  return { ...route, kind: "exec", name, argv: argv as string[], tty, ...(body.user === undefined ? {} : { user: body.user as string }),
    ...(tty && body.cols !== undefined ? { cols: size(body.cols, "cols") } : {}), ...(tty && body.rows !== undefined ? { rows: size(body.rows, "rows") } : {}) }
}

export function parseSize(payload: Uint8Array): { cols: number; rows: number } {
  let body: Record<string, unknown>
  try { body = record(JSON.parse(Buffer.from(payload).toString("utf8"))) } catch { throw new AsideeError("usage", "A resize is {cols, rows}.") }
  return { cols: size(body.cols, "cols"), rows: size(body.rows, "rows") }
}

// Relays one client connection to the session it asks for. Each direction waits for the other side to take what it
// was given (pause, then resume on drain), so the daemon holds at most a socket buffer and one frame per direction.
export function serveStream(socket: Socket, open: (request: OpenRequest) => Promise<Session>, enroll?: (hash: string) => Promise<Session>): void {
  const reader = new FrameReader()
  let session: Session | undefined; let opening = false; let done = false
  let inputWaits = false; let outputWaits = false
  const finish = (last: Buffer) => { if (done) return; done = true; clearTimeout(timer); socket.end(last) }
  // Bounded, so a long message (a remote daemon's, relayed) still fits one frame.
  const failure = (message: string, code: ErrorCode) => frame("error", { code, message: message.slice(0, MAX_MESSAGE) })
  const fail = (message: string, code: ErrorCode = "runtime") => { finish(failure(message, code)); session?.close() }
  const timer = setTimeout(() => fail("No session was asked for.", "usage"), 10_000)
  socket.on("error", () => {})
  socket.on("end", () => socket.destroy())
  socket.on("close", () => { clearTimeout(timer); if (!done) { done = true; session?.close() } })
  socket.on("drain", () => { if (outputWaits) { outputWaits = false; session?.resume() } })
  socket.on("data", (chunk: Buffer) => {
    let frames: Frame[]
    try { frames = reader.push(chunk) } catch (error) { return fail((error as Error).message, "usage") }
    for (const { kind, payload } of frames) {
      if (done) return
      if (!session) {
        if (opening || kind !== "open") return fail(opening ? "Wait for ready before sending." : "The first frame must open a session.", "usage")
        opening = true; clearTimeout(timer); socket.pause()
        let requested: Promise<Session>
        try {
          const input: unknown = JSON.parse(payload.toString("utf8")); const hash = enrollmentHash(input)
          if (hash && !enroll) throw new AsideeError("usage", "Enrollment is unavailable on this stream endpoint.")
          requested = hash ? enroll!(hash) : open(parseOpen(input))
        } catch (error) { return fail(error instanceof SyntaxError ? "The session request is not JSON." : (error as Error).message, "usage") }
        requested.then((opened) => {
          if (done) return opened.close()
          session = opened
          opened.on("output", (stream, bytes) => {
            for (const piece of dataFrames(stream, bytes)) if (!socket.write(piece)) outputWaits = true
            if (outputWaits) opened.pause()
          })
          opened.on("drain", () => { if (inputWaits) { inputWaits = false; socket.resume() } })
          opened.on("end", (exit) => finish(exit.error === undefined ? frame("exit", { code: exit.code ?? -1 }) : failure(exit.error, "runtime")))
          socket.write(frame("ready", { tty: opened.tty, ...(opened.diskWarning ? { diskWarning: opened.diskWarning } : {}) }))
          opened.resume()
          socket.resume()
        }, (error) => fail((error as Error).message, error instanceof AsideeError ? error.code : "runtime"))
        continue
      }
      try {
        if (kind === "stdin") { if (!session.write(payload) && !inputWaits) { inputWaits = true; socket.pause() } }
        else if (kind === "eof") session.end()
        else if (kind === "resize") { const { cols, rows } = parseSize(payload); void session.resize(cols, rows).catch(() => {}) }
        else return fail(`A client does not send ${kind} frames.`, "usage")
      } catch (error) { return fail((error as Error).message, "usage") }
    }
  })
}
