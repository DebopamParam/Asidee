import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dataFrames, frame, FrameReader, serveStream, type Frame } from "../../core/stream"
import { HttpPeer, MAX_REPLY, RemoteSession, sshConnection } from "../../core/transport"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const host = { ssh: "unused", binary: "/unused", stateDir: "/unused" }
async function peer(answer: (socket: Socket) => void) {
  const root = await mkdtemp(join(tmpdir(), "pdk-wire-")); const path = join(root, "peer.sock")
  const sockets = new Set<Socket>()
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.once("data", () => answer(socket)) })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const wire = connect(path)
  wire.on("error", () => {})
  const closed = new Promise<void>((resolve) => wire.once("close", resolve))
  const connection = { wire, diagnostic: () => "fixture", close: async () => { wire.destroy(); await closed } }
  cleanups.push(async () => { await connection.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  return connection
}

test("malformed exit/error controls buffered behind ready end a hosted stream instead of escaping resume", async () => {
  for (const last of [frame("exit", "{"), frame("error", "{"), frame("exit", { code: 1e20 }), frame("exit", { code: "0" })]) {
    const connection = await peer((socket) => socket.write(Buffer.concat([frame("ready", { tty: false }), last])))
    const session = await RemoteSession.open(host, { kind: "exec", name: "demo", argv: ["true"], tty: false }, connection)
    let message = ""
    session.on("end", (exit) => { message = exit.error ?? "" })
    expect(() => session.resume()).not.toThrow()
    await session.closed
    expect(message).toContain("Malformed remote")
  }
})

test("transport loss before an exit status reports a lost session", async () => {
  const connection = await peer((socket) => { socket.write(frame("ready", { tty: false })); setTimeout(() => socket.destroy(), 10) })
  const session = await RemoteSession.open(host, { kind: "exec", name: "demo", argv: ["true"], tty: false }, connection)
  let message = ""
  session.on("end", (exit) => { message = exit.error ?? "" }); session.resume(); await session.closed
  expect(message).toContain("lost before an exit status")
  expect(session.linkLost).toBe(true)
})

test("lost, malformed and oversized mutation replies have unknown outcomes and are never replayed", async () => {
  for (const kind of ["lost", "json", "schema", "oversized"] as const) {
    let requests = 0
    const connection = await peer((socket) => {
      requests++
      if (kind === "lost") { socket.destroy(); return }
      const body = kind === "json" ? "{" : kind === "schema" ? "{}" : "x".repeat(MAX_REPLY + 1)
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
    const client = new HttpPeer(host, connection)
    await expect(client.call("stop", { name: "demo" }, { mutation: true, timeoutMs: 2000 })).rejects.toMatchObject({ code: "outcome-unknown" })
    await client.close()
    expect(requests).toBe(1)
  }
})

test("a valid remote refusal remains a known refusal, while malformed read replies are incompatible", async () => {
  for (const [body, code] of [[JSON.stringify({ ok: false, error: { code: "check-failed", message: "refused before start" } }), "check-failed"], ["{}", "incompatible"]]) {
    const connection = await peer((socket) => socket.end(`HTTP/1.1 409 Conflict\r\nContent-Length: ${Buffer.byteLength(body!)}\r\n\r\n${body}`))
    const client = new HttpPeer(host, connection)
    await expect(client.call("get", {}, { timeoutMs: 2000 })).rejects.toMatchObject({ code })
    await client.close()
  }
})

// Fails rather than hangs when a promise never settles.
const within = <T>(promise: Promise<T>, ms: number, what: string) => Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error(`${what} did not settle within ${ms} ms`) })])

test("a remote error message that fills a whole frame reaches the client cut short, and the SSH connection still closes", async () => {
  const message = "A".repeat(65_536 - JSON.stringify({ code: "usage", message: "" }).length)
  const connection = await peer((socket) => socket.write(Buffer.concat([frame("ready", { tty: false }), frame("error", { code: "usage", message })])))
  let closed = false; const close = connection.close; connection.close = async () => { closed = true; await close() }
  let session: RemoteSession | undefined
  const root = await mkdtemp(join(tmpdir(), "pdk-relay-")); const path = join(root, "stream.sock")
  const server = createServer((socket) => serveStream(socket, async (request) => (session = await RemoteSession.open(host, request, connection))))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const client = connect(path); const reader = new FrameReader(); const frames: Frame[] = []
  const last = new Promise<Frame>((resolve) => client.on("data", (chunk) => { for (const got of reader.push(chunk as Buffer)) { frames.push(got); if (got.kind === "error" || got.kind === "exit") resolve(got) } }))
  client.write(frame("open", { kind: "exec", name: "demo", argv: ["true"] }))
  const error = JSON.parse((await within(last, 3000, "the client's last frame")).payload.toString())
  client.destroy()
  expect(error.message.length).toBeLessThanOrEqual(4000)
  expect(error.message.startsWith("AAAA")).toBe(true)
  await within(session!.closed, 3000, "the remote session's close")
  expect(closed).toBe(true)
})

test("a session's SSH connection closes even when a listener of its end throws", async () => {
  const connection = await peer((socket) => socket.write(Buffer.concat([frame("ready", { tty: false }), frame("exit", { code: 0 })])))
  const session = await RemoteSession.open(host, { kind: "exec", name: "demo", argv: ["true"], tty: false }, connection)
  session.on("end", () => { throw new Error("a listener failed") })
  expect(() => session.resume()).not.toThrow()
  await within(session.closed, 3000, "the session's close")
})

test("closing an SSH process that was stopped (SIGSTOP) finishes within its kill bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-ssh-")); const path = process.env.PATH
  // Real ssh handles SIGTERM, and a stopped process runs no handler, so SIGTERM alone never ends it.
  await writeFile(join(root, "ssh"), "#!/bin/sh\ntrap '' TERM\nexec sleep 600\n"); await chmod(join(root, "ssh"), 0o755)
  process.env.PATH = `${root}:${path}`
  cleanups.push(async () => { process.env.PATH = path; await rm(root, { recursive: true, force: true }) })
  const connection = sshConnection(host)
  // Stopped only once the trap is set and sleep runs, as a real ssh is stopped mid-session.
  for (let at = 0; at < 50 && Bun.spawnSync(["ps", "-o", "comm=", "-p", String(connection.pid)]).stdout.toString().trim() !== "sleep"; at++) await Bun.sleep(50)
  process.kill(connection.pid!, "SIGSTOP")
  const started = Date.now()
  await within(connection.close(), 6000, "closing a stopped ssh")
  expect(Date.now() - started).toBeLessThan(4000)
  expect(() => process.kill(connection.pid!, 0)).toThrow()
}, 10_000)

// A stand-in ssh on PATH that prints `output` and exits without reading its stdin.
async function exitingSsh(output: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "pdk-ssh-")); const path = process.env.PATH
  await writeFile(join(root, "output"), output)
  await writeFile(join(root, "ssh"), `#!/bin/sh\nexec cat '${join(root, "output")}'\n`); await chmod(join(root, "ssh"), 0o755)
  process.env.PATH = `${root}:${path}`
  cleanups.push(async () => { process.env.PATH = path; await rm(root, { recursive: true, force: true }) })
}

test("a hosted stream whose ssh exits while its reader is slow still delivers every byte and the exit status", async () => {
  const bytes = new Uint8Array(4 * 1048576); for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536))
  await exitingSsh(Buffer.concat([frame("ready", { tty: false }), ...dataFrames("stdout", bytes), frame("exit", { code: 5 })]))
  const session = await RemoteSession.open(host, { kind: "exec", name: "demo", argv: ["true"], tty: false })
  const ended = new Promise<{ code?: number; error?: string }>((resolve) => session.on("end", resolve))
  let received = 0
  session.on("output", (_kind, chunk: Buffer) => { received += chunk.length; session.pause(); setTimeout(() => session.resume(), 1) })
  session.resume()
  expect(await within(ended, 20_000, "the slow stream's end")).toEqual({ code: 5 })
  expect(received).toBe(bytes.length)
  expect(session.linkLost).toBe(false)
}, 30_000)

test("a call over an SSH link that has already ended fails at once as offline instead of waiting", async () => {
  const body = JSON.stringify({ ok: true, data: "hello" })
  await exitingSsh(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`))
  const connection = sshConnection(host); const client = new HttpPeer(host, connection)
  cleanups.push(() => client.close())
  expect(await client.call("hello", {}, { timeoutMs: 5000 })).toBe("hello")
  for (let at = 0; at < 100 && !connection.wire.destroyed; at++) await Bun.sleep(20)
  expect(connection.wire.destroyed).toBe(true)
  const started = Date.now()
  await expect(within(client.call("hello", {}, { timeoutMs: 5000 }), 3000, "the call on an ended link")).rejects.toMatchObject({ code: "offline" })
  expect(Date.now() - started).toBeLessThan(1000)
})

test("a mutation's unusable reply and a cancelled call say so, and both have unknown outcomes", async () => {
  const oversized = await peer((socket) => { const body = "x".repeat(MAX_REPLY + 1); socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`) })
  const client = new HttpPeer(host, oversized)
  await expect(client.call("stop", { name: "demo" }, { mutation: true, timeoutMs: 2000 })).rejects.toMatchObject({ code: "outcome-unknown", message: expect.stringContaining("exceeded 8 MiB") })
  await client.close()
  const silent = await peer(() => {})
  const waiting = new HttpPeer(host, silent)
  const sent = waiting.call("stop", { name: "demo" }, { mutation: true, timeoutMs: 5000 }).catch((error) => error)
  await Bun.sleep(100); await waiting.close("The request was cancelled by its client.")
  expect(await sent).toMatchObject({ code: "outcome-unknown", message: expect.stringContaining("cancelled by its client") })
})
