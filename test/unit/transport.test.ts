import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frame } from "../../core/stream"
import { HttpPeer, MAX_REPLY, RemoteSession } from "../../core/transport"

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
