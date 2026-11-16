import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { connect } from "node:net"
import { boundPort, FORWARD_CONNECTIONS, listenLoopback, relay, validPort } from "../../core/forwards"
import { PaddockError, type Session } from "../../core/types"

test("ports are whole numbers from 1 to 65535, as numbers or digits", () => {
  expect(validPort(3000, "port")).toBe(3000); expect(validPort("65535", "port")).toBe(65_535)
  for (const bad of [0, 65_536, -1, 1.5, "80x", " 80", "", null, undefined, "0x50", [80]]) expect(() => validPort(bad, "port")).toThrow(PaddockError)
})

test("a listener binds 127.0.0.1 once, picks a free port when none is given, and refuses an occupied one", async () => {
  const first = await listenLoopback()
  const address = first.address() as { address: string; port: number }
  expect(address.address).toBe("127.0.0.1"); expect(boundPort(first)).toBeGreaterThan(0)
  await expect(listenLoopback(boundPort(first))).rejects.toMatchObject({ code: "conflict" })
  first.close()
})

// A sandbox port that echoes.
class Echo extends EventEmitter implements Session {
  tty = false
  write(bytes: Uint8Array) { this.emit("output", "stdout", Buffer.from(bytes)); this.emit("output", "stderr", Buffer.from("noise")); return true }
  end() { this.emit("end", { code: 0 }) }
  async resize() {}
  pause() {} resume() {}
  close() { this.emit("end", { error: "closed" }) }
}
const through = async (session: Session, send: (client: ReturnType<typeof connect>) => void) => {
  const server = await listenLoopback()
  server.on("connection", (socket) => relay(socket, session))
  const got = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []; const client = connect(boundPort(server), "127.0.0.1", () => send(client))
    client.on("data", (chunk: Buffer) => chunks.push(chunk)); client.on("error", () => {}); client.on("close", () => resolve(Buffer.concat(chunks)))
  })
  server.close()
  return got
}

test(`a forward's listener holds ${FORWARD_CONNECTIONS} connections at once, counting ones not relayed yet, and closes the rest`, async () => {
  const server = await listenLoopback()
  // Nothing is relayed: each connection waits, as one does while its session is being dialled.
  const accepted: Array<{ destroy(): void }> = []; server.on("connection", (socket) => { accepted.push(socket) })
  const closed: number[] = []
  const clients = Array.from({ length: FORWARD_CONNECTIONS + 3 }, (_, at) => {
    const client = connect(boundPort(server), "127.0.0.1"); client.on("error", () => {}); client.on("close", () => closed.push(at)); return client
  })
  await Bun.sleep(300)
  expect(accepted.length).toBe(FORWARD_CONNECTIONS); expect(closed.length).toBe(3)
  // One that ends frees its place.
  accepted[0]!.destroy(); await Bun.sleep(100)
  const late = connect(boundPort(server), "127.0.0.1"); late.on("error", () => {})
  await Bun.sleep(200)
  expect(accepted.length).toBe(FORWARD_CONNECTIONS + 1)
  for (const client of [...clients, late]) client.destroy()
  server.close()
})

test("a relayed connection carries bytes both ways, drops the sandbox's stderr, and passes on end of input", async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index)
  const got = await through(new Echo(), (client) => client.end(bytes))
  expect([...got]).toEqual([...bytes])
})

test("a relay that is closed, or whose command failed, resets the connection", async () => {
  const failing = new Echo(); failing.end = () => failing.emit("end", { code: 1 })
  expect((await through(failing, (client) => client.end("x"))).toString()).toBe("x")
  const closing = new Echo()
  const got = await through(closing, (client) => { client.write("y"); setTimeout(() => closing.close(), 50) })
  expect(got.toString()).toBe("y")
})

test("after a client's FIN the relay stays while the port answers, and goes once it has been silent for the allowed time", async () => {
  const session = new Echo(); let ended = false; let closed = false
  session.end = () => { ended = true }; session.close = () => { closed = true; session.emit("end", { error: "closed" }) }
  const server = await listenLoopback(); server.on("connection", (socket) => relay(socket, session, 600))
  const got: Buffer[] = []
  const client = connect({ port: boundPort(server), host: "127.0.0.1", allowHalfOpen: true }, () => client.end())
  client.on("error", () => {}); client.on("data", (chunk: Buffer) => got.push(chunk))
  try {
    for (let i = 0; i < 60 && !ended; i++) await Bun.sleep(50)
    expect(ended).toBe(true)
    // An answer every 300 ms for 1.5 s: longer than the allowed silence, and never silent that long.
    for (let i = 0; i < 5; i++) { await Bun.sleep(300); expect(closed).toBe(false); session.emit("output", "stdout", Buffer.from("late")) }
    for (let i = 0; i < 60 && !closed; i++) await Bun.sleep(50)
    expect(closed).toBe(true); expect(Buffer.concat(got).toString()).toBe("late".repeat(5))
  } finally { client.destroy(); server.close() }
})
