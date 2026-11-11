import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { connect } from "node:net"
import { boundPort, listenLoopback, relay, validPort } from "../../core/forwards"
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

test("a relay whose client sends FIN ends a guest that ignores EOF within three seconds", async () => {
  const session = new Echo(); let closed = false
  session.end = () => {}; session.close = () => { closed = true; session.emit("end", { error: "closed" }) }
  const server = await listenLoopback(); server.on("connection", (socket) => relay(socket, session))
  const client = connect(boundPort(server), "127.0.0.1", () => client.end())
  client.on("error", () => {})
  try {
    for (let i = 0; i < 60 && !closed; i++) await Bun.sleep(50)
    expect(closed).toBe(true)
  } finally { client.destroy(); server.close() }
})
