import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dataFrames, frame, FrameReader, MAX_PAYLOAD, parseOpen, parseSize, serveStream, type Frame, type OpenRequest } from "../../core/stream"
import { PaddockError, type Session } from "../../core/types"

test("frames survive being split at every byte and keep binary payloads exact", () => {
  const payload = Uint8Array.from({ length: 300 }, (_, index) => index % 256)
  const bytes = Buffer.concat([frame("stdout", payload), frame("eof"), frame("exit", { code: 3 })])
  for (let cut = 0; cut <= bytes.length; cut++) {
    const reader = new FrameReader()
    const frames = [...reader.push(bytes.subarray(0, cut)), ...reader.push(bytes.subarray(cut))]
    expect(frames.map((piece) => piece.kind)).toEqual(["stdout", "eof", "exit"])
    expect(Buffer.from(frames[0]!.payload)).toEqual(Buffer.from(payload))
    expect(JSON.parse(frames[2]!.payload.toString())).toEqual({ code: 3 })
  }
})

test("data larger than a frame is split, and frames over 64 KiB or of unknown kinds are refused", () => {
  const data = new Uint8Array(MAX_PAYLOAD * 2 + 5).fill(7)
  const pieces = dataFrames("stdin", data)
  expect(pieces.map((piece) => piece.length - 5)).toEqual([MAX_PAYLOAD, MAX_PAYLOAD, 5])
  expect(new FrameReader().push(Buffer.concat(pieces)).reduce((size, piece) => size + piece.payload.length, 0)).toBe(data.length)
  expect(() => frame("stdout", new Uint8Array(MAX_PAYLOAD + 1))).toThrow(RangeError)
  // An oversized length is refused from its header, before its payload could be buffered.
  const header = Buffer.alloc(5); header[0] = 4; header.writeUInt32BE(MAX_PAYLOAD + 1, 1)
  expect(() => new FrameReader().push(header)).toThrow(PaddockError)
  for (const kind of [0, 10, 255]) expect(() => new FrameReader().push(Buffer.from([kind, 0, 0, 0, 0]))).toThrow("Not a paddock-stream/1 frame")
})

test("a session request keeps only known fields and refuses engine options, bad names and sizes", () => {
  expect(parseOpen({ kind: "exec", name: "demo", argv: ["id", "-u"], extra: "--privileged" })).toEqual({ kind: "exec", name: "demo", argv: ["id", "-u"], tty: false })
  expect(parseOpen({ kind: "exec", name: "demo", argv: ["sh"], user: "agent", tty: true, cols: 80, rows: 24 })).toEqual({ kind: "exec", name: "demo", argv: ["sh"], user: "agent", tty: true, cols: 80, rows: 24 })
  // A size means something only on a terminal.
  expect(parseOpen({ kind: "exec", name: "demo", argv: ["sh"], cols: 0 })).toEqual({ kind: "exec", name: "demo", argv: ["sh"], tty: false })
  expect(parseOpen({ kind: "ssh", name: "demo", argv: ["ignored"] })).toEqual({ kind: "ssh", name: "demo" })
  for (const bad of [null, [], "exec", { kind: "attach", name: "demo", argv: ["sh"] }, { kind: "exec", name: "../x", argv: ["sh"] }, { kind: "exec", name: "demo --privileged", argv: ["sh"] },
    { kind: "exec", name: "demo" }, { kind: "exec", name: "demo", argv: [] }, { kind: "exec", name: "demo", argv: "sh" }, { kind: "exec", name: "demo", argv: [1] },
    { kind: "exec", name: "demo", argv: ["a\0b"] }, { kind: "exec", name: "demo", argv: ["sh"], user: "0 --privileged" }, { kind: "exec", name: "demo", argv: ["sh"], user: "-u" },
    { kind: "exec", name: "demo", argv: ["sh"], user: 0 }, { kind: "exec", name: "demo", argv: ["sh"], tty: "yes" },
    { kind: "exec", name: "demo", argv: ["sh"], tty: true, cols: 0 }, { kind: "exec", name: "demo", argv: ["sh"], tty: true, rows: 10_001 }, { kind: "exec", name: "demo", argv: ["sh"], tty: true, cols: 1.5 }])
    expect(() => parseOpen(bad)).toThrow(PaddockError)
  expect(parseSize(Buffer.from('{"cols":120,"rows":40}'))).toEqual({ cols: 120, rows: 40 })
  for (const bad of ["", "{", "[]", '{"cols":120}', '{"cols":0,"rows":1}', '{"cols":"80","rows":24}']) expect(() => parseSize(Buffer.from(bad))).toThrow(PaddockError)
})

// A session that echoes its input and exits 3 at end of input.
class Echo extends EventEmitter implements Session {
  tty = false; closed?: string; ended = false; sizes: number[][] = []
  write(bytes: Uint8Array) { this.emit("output", "stdout", Buffer.from(bytes)); return true }
  end() { this.ended = true; this.emit("output", "stderr", Buffer.from("bye")); this.emit("end", { code: 3 }) }
  async resize(cols: number, rows: number) { this.sizes.push([cols, rows]) }
  pause() {} resume() {}
  close(reason?: string) { this.closed = reason ?? "closed" }
}
async function served(open: (request: OpenRequest) => Promise<Session>) {
  const path = join(await mkdtemp(join(tmpdir(), "pdk-stream-")), "s.sock")
  const server = createServer({ allowHalfOpen: true }, (socket) => serveStream(socket, open))
  await new Promise<void>((resolve) => server.listen(path, resolve))
  // Sends the first frame and, after ready, the rest; collects what comes back until the server closes the connection.
  const talk = ([first, ...rest]: Buffer[], hold = false) => new Promise<Frame[]>((resolve) => {
    const reader = new FrameReader(); const got: Frame[] = []
    const client = connect(path, () => { client.write(first!); if (hold) setTimeout(() => client.destroy(), 200) })
    client.on("data", (chunk: Buffer) => {
      const frames = reader.push(chunk); got.push(...frames)
      if (frames.some((piece) => piece.kind === "ready") && rest.length) client.write(Buffer.concat(rest))
    })
    client.on("error", () => {}); client.on("close", () => resolve(got))
  })
  return { talk, close: () => server.close() }
}

test("a session relays input, output, stderr, resize and end of input, then the exit code", async () => {
  const session = new Echo(); let asked: OpenRequest | undefined
  const { talk, close } = await served(async (request) => { asked = request; return session })
  const got = await talk([frame("open", { kind: "exec", name: "demo", argv: ["cat"] }), frame("resize", { cols: 90, rows: 30 }), ...dataFrames("stdin", Buffer.from([0, 255, 10])), frame("eof")])
  close()
  expect(asked).toEqual({ kind: "exec", name: "demo", argv: ["cat"], tty: false })
  expect(got.map((piece) => piece.kind)).toEqual(["ready", "stdout", "stderr", "exit"])
  expect([...got[1]!.payload]).toEqual([0, 255, 10])
  expect(got[2]!.payload.toString()).toBe("bye")
  expect(JSON.parse(got[3]!.payload.toString())).toEqual({ code: 3 })
  expect(session.sizes).toEqual([[90, 30]]); expect(session.ended).toBe(true)
})

test("a connection that does not open a session first, sends before ready, or asks for a bad one, gets an error frame", async () => {
  const { talk, close } = await served(async () => { throw new PaddockError("conflict", "demo is not running.") })
  const first = await talk([frame("stdin", "x")])
  const bad = await talk([frame("open", { kind: "exec", name: "../x", argv: ["sh"] })])
  const refused = await talk([frame("open", { kind: "exec", name: "demo", argv: ["sh"] })])
  const garbage = await talk([Buffer.from("GET / HTTP/1.1\r\n\r\n")])
  const early = await talk([Buffer.concat([frame("open", { kind: "exec", name: "demo", argv: ["sh"] }), frame("stdin", "too soon")])])
  close()
  for (const reply of [first, bad, refused, garbage, early]) expect(reply.map((piece) => piece.kind)).toEqual(["error"])
  expect(JSON.parse(refused[0]!.payload.toString())).toEqual({ code: "conflict", message: "demo is not running." })
  expect(JSON.parse(bad[0]!.payload.toString()).code).toBe("usage")
  expect(JSON.parse(early[0]!.payload.toString()).message).toBe("Wait for ready before sending.")
})

test("a client that goes away closes its session", async () => {
  const session = new Echo()
  const { talk, close } = await served(async () => session)
  await talk([frame("open", { kind: "exec", name: "demo", argv: ["sleep", "9"] })], true)
  await Bun.sleep(50); close()
  expect(session.closed).toBe("closed")
})
