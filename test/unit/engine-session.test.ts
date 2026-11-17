import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GvisorProvider, LABEL_ID } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Session } from "../../core/types"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo" }),
  engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }

// An engine whose every exec prints "hi" on stdout in the same write as the upgrade, ends at once and exits 0: a command
// that is over before its caller listens.
async function engine(): Promise<GvisorProvider> {
  const dir = await mkdtemp(join(tmpdir(), "asd-engine-"))
  const path = join(dir, "engine.sock")
  const server: Server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const line = chunk.toString("latin1").split("\r\n")[0]!
      const reply = (status: string, body: unknown) => { const text = JSON.stringify(body); socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${text.length}\r\nConnection: close\r\n\r\n${text}`) }
      if (/^POST \/containers\/c0ffee\/exec /.test(line)) return reply("201 Created", { Id: "e1" })
      if (/^GET \/exec\/e1\/json/.test(line)) return reply("200 OK", { Running: false, ExitCode: 0 })
      if (/^POST \/exec\/e1\/start /.test(line)) {
        const frame = Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("hi\n")])
        return socket.end(Buffer.concat([Buffer.from("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"), frame]))
      }
      reply("404 Not Found", { message: line })
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  cleanups.push(async () => { server.close(); await rm(dir, { recursive: true, force: true }) })
  return new GvisorProvider(async (argv) => {
    const args = argv.slice(3)
    if (args[0] === "context") return { exitCode: 0, stdout: `unix://${path}\n`, stderr: "" }
    if (args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: "c0ffee", State: { Running: true }, Config: { Labels: { [LABEL_ID]: manifest.id } }, HostConfig: { Runtime: "runsc" } }]), stderr: "" }
    return { exitCode: 1, stdout: "", stderr: "unexpected" }
  })
}

// What a session delivers once its caller listens, 300 ms after it opened.
async function late(session: Session): Promise<{ output: string; exit?: { code?: number; error?: string } }> {
  await Bun.sleep(300)
  let output = ""; let exit: { code?: number; error?: string } | undefined
  session.on("output", (_stream, bytes) => { output += Buffer.from(bytes).toString() })
  session.on("end", (ended) => { exit = ended })
  session.resume()
  await Bun.sleep(300)
  session.close()
  return { output, exit }
}

test("a held session keeps what it printed and its end for a caller that listens late; an unheld one does not", async () => {
  const provider = await engine()
  // The control: a session's output and end come before anyone listens, and are gone.
  expect(await late(await provider.openExec(manifest, ["cat"], { tty: false }))).toEqual({ output: "", exit: undefined })
  expect(await late(await provider.openExec(manifest, ["cat"], { tty: false, held: true }))).toEqual({ output: "hi\n", exit: { code: 0 } })
  expect(await late(await provider.dialLoopback(manifest, 5432, true))).toEqual({ output: "hi\n", exit: { code: 0 } })
})

test("link test replies travel on stdin and never in the sandbox command line", async () => {
  const { EventEmitter } = await import("node:events")
  let command: readonly string[] = []; let input = ""
  class Listener extends EventEmitter implements Session {
    readonly tty = false
    write(bytes: Uint8Array) { input += Buffer.from(bytes).toString(); return true }
    end() {} async resize() {} pause() {} resume() {} close() {}
  }
  const provider = new GvisorProvider(async () => { throw new Error("No engine command is needed.") })
  provider.openExec = async (_manifest, argv) => { command = argv; return new Listener() }
  const secret = "abcd1234ef567890"
  await provider.links.canary(manifest, 5432, secret, true)
  expect(command.join(" ")).not.toContain(secret)
  expect(input).toBe(`${secret}\n`)
})
