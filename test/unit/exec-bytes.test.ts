import { afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import { Core } from "../../core/core"
import { execStdin, methods, VERSION } from "../../core/daemon"
import { CATALOG, Machines, type Hello, type HostRecord } from "../../core/machines"
import { GvisorProvider, LABEL_ID } from "../../core/providers/gvisor"
import { systemRunner } from "../../core/run"
import { socketPath, streamSocketPath, validSpec, writeManifest } from "../../core/state"
import { serveStream, type OpenRequest } from "../../core/stream"
import type { Manifest, Runner, Session } from "../../core/types"
import { ExplainedWorkspaces } from "./workspace-evidence"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const CLI = join(import.meta.dir, "../../cli/cli.ts")
// Every byte value, then sequences that are not UTF-8: a lone continuation byte, an overlong encoding, a surrogate, a
// truncated sequence, and bytes past U+10FFFF.
const BYTES = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, value) => value)), Buffer.from([0x80, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xe2, 0x82, 0xf4, 0x90, 0x80, 0x80, 0xff, 0xfe])])
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
const hasher = process.platform === "darwin" ? ["/usr/bin/shasum", "-a", "256"] : ["sha256sum"]

test("BYTES is not UTF-8, so a text path would change it", () => {
  expect(Buffer.from(BYTES.toString("utf8"), "utf8").equals(BYTES)).toBe(false)
})

test("the daemon takes buffered stdin as exact base64 bytes within the limit, and a string as before", () => {
  expect(Buffer.from(execStdin({ stdinBase64: BYTES.toString("base64") }) as Uint8Array).equals(BYTES)).toBe(true)
  expect(execStdin({ stdin: "text é" })).toBe("text é")
  expect(execStdin({})).toBeUndefined()
  expect((execStdin({ stdinBase64: "" }) as Uint8Array).length).toBe(0)
  for (const body of [{ stdinBase64: "abc" }, { stdinBase64: "ab=c" }, { stdinBase64: "a b=" }, { stdinBase64: "YQ==\n" }, { stdinBase64: "-_8=" }, { stdinBase64: 5 }, { stdin: 5 },
    { stdin: "a", stdinBase64: "YQ==" }, { stdinBase64: Buffer.alloc(16 * 1024 ** 2 + 1).toString("base64") }, { stdin: "x".repeat(16 * 1024 ** 2 + 1) }])
    expect(() => execStdin(body)).toThrow()
  expect((execStdin({ stdinBase64: Buffer.alloc(16 * 1024 ** 2).toString("base64") }) as Uint8Array).length).toBe(16 * 1024 ** 2)
})

// A daemon that answers as this build, records buffered bodies, and echoes a stream's input back as its stdout.
async function daemon() {
  const state = await mkdtemp(join(tmpdir(), "pdk-bytes-")); const bodies: Record<string, Record<string, unknown>> = {}
  const build = `${VERSION}+${Math.round(statSync(CLI).mtimeMs)}`
  const server = Bun.serve({ unix: socketPath({ state, config: state }), fetch: async (request) => {
    const method = new URL(request.url).pathname.slice(5)
    if (method === "version") return Response.json({ ok: true, data: { version: VERSION, build } })
    bodies[method] = await request.json() as Record<string, unknown>
    return Response.json({ ok: true, data: { exitCode: 0, stdout: "", stderr: "" } })
  } })
  const opened: OpenRequest[] = []
  const stream = createServer({ allowHalfOpen: true }, (socket) => serveStream(socket, async (request) => { opened.push(request); return new Echo() }))
  await new Promise<void>((resolve) => stream.listen(streamSocketPath({ state, config: state }), resolve))
  cleanups.push(async () => { server.stop(true); stream.close(); await rm(state, { recursive: true, force: true }) })
  const run = async (args: string[], input: Uint8Array) => {
    const child = Bun.spawn([process.execPath, CLI, ...args], { env: { ...process.env, PADDOCK_STATE_DIR: state, PADDOCK_CONFIG_DIR: state }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).bytes(), child.exited])
    return { out: Buffer.from(out), err: Buffer.from(err), code }
  }
  return { bodies, opened, run }
}
// stdin comes back on stdout as it came; at its end, BYTES on stderr and exit 0.
class Echo extends EventEmitter implements Session {
  readonly tty = false
  write(bytes: Uint8Array) { this.emit("output", "stdout", Buffer.from(bytes)); return true }
  end() { this.emit("output", "stderr", BYTES); this.emit("end", { code: 0 }) }
  async resize() {}
  pause() {} resume() {}
  close() {}
}

test("the CLI sends --stdin bytes exactly for sandbox and workspace exec", async () => {
  const { bodies, run } = await daemon()
  for (const [method, args] of [["exec", ["exec", "demo", "--stdin", "--", "cat"]], ["workspaceExec", ["workspace", "exec", "demo", "--stdin", "--", "cat"]]] as const) {
    expect((await run([...args], BYTES)).code).toBe(0)
    expect(bodies[method]!.stdin).toBeUndefined()
    expect(Buffer.from(String(bodies[method]!.stdinBase64), "base64").equals(BYTES)).toBe(true)
  }
}, 20_000)

test("--stream is byte-exact in both directions for sandbox and workspace exec", async () => {
  const { opened, run } = await daemon()
  const large = new Uint8Array(3 * 1048576 + 17); for (let at = 0; at < large.length; at += 65536) crypto.getRandomValues(large.subarray(at, at + 65536))
  const input = Buffer.concat([BYTES, large, BYTES])
  for (const args of [["exec", "demo", "--stream", "--", "cat"], ["workspace", "exec", "demo", "--stream", "--", "cat"]]) {
    const result = await run(args, input)
    expect(result.code).toBe(0)
    expect(sha256(result.out)).toBe(sha256(input))
    expect(result.err.subarray(result.err.length - BYTES.length).equals(BYTES)).toBe(true)
  }
  expect(opened.map((request) => request.kind)).toEqual(["exec", "workspace"])
}, 30_000)

test("buffered sandbox exec delivers stdinBase64 to the engine's exec byte for byte, hashed by the command it runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-exec-")); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dirs = { state: join(root, "state"), config: join(root, "config") }; await mkdir(dirs.state, { recursive: true })
  const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo" }),
    engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }
  await writeManifest(dirs, manifest)
  // The engine's exec of `docker exec … demo HASHER` runs the hasher here on the bytes the provider handed the client.
  const runner: Runner = async (argv, options) => {
    const args = argv.slice(3)
    if (args[0] === "inspect") return { exitCode: 0, stderr: "", stdout: JSON.stringify([{ State: { Running: true }, Config: { Labels: { [LABEL_ID]: manifest.id } }, HostConfig: { Runtime: "runsc" } }]) }
    if (args[0] === "exec" && args.includes("-i")) return systemRunner(args.slice(args.indexOf("paddock-demo") + 1), { stdin: options?.stdin })
    return { exitCode: 1, stdout: "", stderr: "unexpected" }
  }
  const table = methods(new Core([new GvisorProvider(runner)], dirs, runner, "/nowhere"), () => {})
  const result = await table.exec!.run({ name: "demo", argv: hasher, stdinBase64: BYTES.toString("base64") }) as { exitCode: number; stdout: string }
  expect(result.exitCode).toBe(0)
  expect(result.stdout.split(" ")[0]).toBe(sha256(BYTES))
})

;(process.platform === "darwin" ? test : test.skip)("buffered workspace exec delivers stdinBase64 to the command byte for byte, hashed inside the workspace", async () => {
  await mkdir(join(import.meta.dir, "../../dist"), { recursive: true })
  const root = await mkdtemp(join(import.meta.dir, "../../dist/workspace-bytes-"))
  const dirs = { state: join(root, "state"), config: join(root, "config") }
  const env = { ...process.env, PADDOCK_WORKSPACES_ROOT: join(root, "workspaces"), CLAUDE_CONFIG_DIR: join(root, "no-claude"), CODEX_HOME: join(root, "no-codex") }
  const workspaces = new ExplainedWorkspaces(dirs, env, { home: root, platform: "linux", runner: async () => { throw new Error("No host command is needed.") } }, systemRunner)
  cleanups.push(async () => { for (const workspace of await workspaces.list()) await workspaces.remove(workspace.name, workspace.name); await rm(root, { recursive: true, force: true }) })
  expect((await workspaces.create({ name: "bytes" })).ok).toBe(true)
  const table = methods(new Core([], dirs, systemRunner, "/nowhere"), () => {}, undefined, undefined, undefined, workspaces)
  const result = await table.workspaceExec!.run({ name: "bytes", argv: ["/usr/bin/shasum", "-a", "256"], stdinBase64: BYTES.toString("base64") }) as { exitCode: number; stdout: string }
  expect(result.exitCode).toBe(0)
  expect(result.stdout.split(" ")[0]).toBe(sha256(BYTES))
}, 30_000)

test("a routed exec carries stdinBase64 to the remote daemon unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-route-")); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const dirs = { state: join(root, "s"), config: join(root, "c") }; await mkdir(dirs.config)
  await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: true }))
  const local: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "9".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: ["machines", "remote-streams", "remote-forwards", "lease-renewal"] }
  const remote: Hello = { ...local, machineId: "d".repeat(32), bootId: "e".repeat(32) }
  const host: HostRecord = { name: "build", ssh: "home-linux", binary: "/opt/paddock/bin", stateDir: "/home/me/state", machineId: remote.machineId, addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "prepared" }
  const sent: Array<Record<string, unknown>> = []
  const machines = new Machines(dirs, local, async () => ({ hello: local, sandboxes: [], checkedAt: "" }), {
    sshIdentity: async () => ({ user: "builder", hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8" }),
    connectPeer: () => ({ async close() {}, async call(method: string, body: Record<string, unknown> = {}) { if (method === "hello") return remote; sent.push(body); return { exitCode: 0, stdout: "", stderr: "" } } }) })
  await machines.attach(host)
  await machines.route("exec", { host: "build", name: "demo", argv: ["cat"], stdinBase64: BYTES.toString("base64") })
  expect(Buffer.from(String(sent[0]!.stdinBase64), "base64").equals(BYTES)).toBe(true)
})
