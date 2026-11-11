import { afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VERSION } from "../../core/daemon"
import { socketPath, streamSocketPath } from "../../core/state"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const CLI = join(import.meta.dir, "../../cli/cli.ts")
const ESC = "\x1b[2J\x1b[H✓ forged\x9b31m‮"

// A daemon that answers as this build (so the CLI uses it) with text another machine chose.
async function daemon(replies: Record<string, unknown>) {
  const state = await mkdtemp(join(tmpdir(), "pdk-cli-"))
  const build = `${VERSION}+${Math.round(statSync(CLI).mtimeMs)}`
  const server = Bun.serve({ unix: socketPath({ state, config: state }), fetch: (request) => {
    const method = new URL(request.url).pathname.slice(5)
    if (method === "version") return Response.json({ ok: true, data: { version: VERSION, build } })
    return method in replies ? Response.json(replies[method]) : Response.json({ ok: false, error: { code: "not-found", message: "No such method." } }, { status: 404 })
  } })
  cleanups.push(async () => { server.stop(true); await rm(state, { recursive: true, force: true }) })
  // Asynchronous, so this process keeps answering while the CLI runs.
  return async (...args: string[]) => {
    const run = Bun.spawn([process.execPath, CLI, ...args], { env: { ...process.env, PADDOCK_STATE_DIR: state, PADDOCK_CONFIG_DIR: state }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    return { code, out, err }
  }
}

test("text from a daemon reaches the terminal without control characters", async () => {
  const machineId = "d".repeat(32)
  const row = { name: "demo", status: "damaged", machineId, engine: ESC, createdAt: "", spec: { name: "demo" }, stopReason: `bad${ESC}\nline` }
  const paddock = await daemon({
    fleet: { ok: true, data: { machines: [{ machine: { host: { name: "build", machineId }, state: "offline", error: `gone${ESC}` }, cached: { sandboxes: [row] }, stale: true }] } },
    list: { ok: true, data: [row] },
    stop: { ok: false, error: { code: "runtime", message: `failed${ESC}\nforged line` } },
  })
  for (const [args, seen] of [[["list", "--all"], "build/demo"], [["list"], "demo"], [["stop", "demo"], "failed"]] as const) {
    const { out, err } = await paddock(...args)
    expect(out + err).toContain(seen)
    expect(out + err).not.toMatch(/[\x1b\x9b‮]/)
  }
  const { code, err } = await paddock("stop", "demo")
  expect(code).toBe(1)
  expect(err.trim().split("\n")).toHaveLength(1)
}, 20_000)

test("transport stdio hands SSH every byte the daemon sent before it exits, even to a slow reader", async () => {
  const state = await mkdtemp(join(tmpdir(), "pdk-relay-")); const piece = Buffer.alloc(65536, 7); const pieces = 128
  // Ends its side as a stream does after the exit frame, while the reader is still behind.
  const server = createServer(async (socket) => {
    for (let at = 0; at < pieces; at++) if (!socket.write(piece)) await new Promise((resolve) => socket.once("drain", resolve))
    socket.end()
  })
  await new Promise<void>((resolve) => server.listen(streamSocketPath({ state, config: state }), resolve))
  cleanups.push(async () => { await new Promise((resolve) => server.close(resolve)); await rm(state, { recursive: true, force: true }) })
  // stdin stays open, as SSH keeps it, so only the daemon's side ending makes the relay exit.
  const run = Bun.spawn([process.execPath, CLI, "transport", "stdio", "--protocol", "1", "--stream"], { env: { ...process.env, PADDOCK_STATE_DIR: state, PADDOCK_CONFIG_DIR: state }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  let received = 0
  for await (const chunk of run.stdout) { received += chunk.length; await Bun.sleep(2) }
  expect(await run.exited).toBe(0)
  expect(received).toBe(piece.length * pieces)
  run.stdin.end()
}, 30_000)
