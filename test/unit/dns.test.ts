import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GvisorProvider, LABEL_ID, bridge } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Runner } from "../../core/types"

// The engine's archive API, where the relay is copied: each request is recorded in the calls of the fixture that made it.
const folder = await mkdtemp(join(tmpdir(), "asd-dns-"))
let archived: string[][] = []
const engine = Bun.serve({ unix: join(folder, "engine.sock"), fetch: (request) => { archived.push(["archive", request.method, new URL(request.url).pathname]); return new Response("") } })
afterAll(async () => { engine.stop(true); await rm(folder, { recursive: true, force: true }) })

function fixture(docker = false) {
  const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo", docker }),
    engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }
  const state = { running: true, resolver: "nameserver 127.0.0.11\n", writable: true, readable: true, guard: "intact", network: true, writes: 0 }
  const calls: string[][] = []; archived = calls
  const runner: Runner = async (argv, options) => {
    calls.push([...argv]); const args = argv.slice(3)
    let stdout = "", exitCode = 0
    if (args[0] === "inspect") stdout = JSON.stringify([{ Id: "c0ffee", State: { Running: state.running }, Config: { Labels: { [LABEL_ID]: manifest.id } }, HostConfig: { Runtime: "runsc" } }])
    else if (args[0] === "context") stdout = `unix://${join(folder, "engine.sock")}`
    else if (args.includes("/bin/busybox.static")) return { stdout: "", stderr: "", exitCode: 0, raw: new Uint8Array([0x7f, 0x45, 0x4c, 0x46]) }
    else if (args[0] === "start") state.running = true
    else if (args[0] === "info") stdout = JSON.stringify({ runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--net-raw", "--overlay2=none"] } })
    else if (args[0] === "network" && args[1] === "inspect") { stdout = bridge(manifest.name); exitCode = state.network ? 0 : 1 }
    else if (args[0] === "network" && args[1] === "create") state.network = true
    else if (args[0] === "run" && args.includes("nft")) state.guard = "intact"
    else if (args[0] === "run") stdout = state.guard
    else if (args[0] === "exec" && args.some((arg) => arg.includes("/etc/resolv.conf"))) {
      if (options?.stdin) { state.writes++; if (state.writable) state.resolver = String(options.stdin); else exitCode = 1 }
      if (exitCode === 0) { stdout = state.resolver; if (!state.readable) { stdout = ""; exitCode = 1 } }
    } else if (args.includes("docker")) stdout = "/var/lib/docker overlayfs"
    else if (args[0] === "exec") stdout = "gVisor"
    return { stdout, stderr: exitCode ? "fixture refused" : "", exitCode }
  }
  return { manifest, state, calls, provider: new GvisorProvider(runner) }
}

for (const docker of [false, true]) test(`start restores DNS on an already running sandbox, inner Docker ${docker}`, async () => {
  const { provider, manifest, state, calls } = fixture(docker)
  await provider.start(manifest)
  expect(state.resolver).toBe("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
  expect(calls.some((call) => call[0] === "archive")).toBe(false)
  state.running = false; state.resolver = "nameserver 172.20.0.1\n"
  await provider.start(manifest)
  expect(state.resolver).toContain("nameserver 1.1.1.1")
  // The relay goes in before the guest runs, so nothing inside can have looked for it first (W10).
  const copied = calls.findIndex((call) => call[0] === "archive"); const started = calls.findIndex((call) => call[3] === "start")
  expect(calls[copied]).toEqual(["archive", "PUT", "/containers/c0ffee/archive"])
  expect(copied).toBeGreaterThan(-1); expect(copied).toBeLessThan(started)
})

test("the enforcement runtime checks read DNS, restore it only when reset, and disclose an unreadable resolver", async () => {
  const { provider, manifest, state } = fixture()
  const dns = async () => (await provider.checks(manifest, "runtime")).find((check) => check.id === "dns")
  const repaired = await dns()
  expect(state.resolver).toContain("nameserver 1.1.1.1"); expect(state.writes).toBe(1)
  expect(repaired).toMatchObject({ status: "pass", evidence: "inspected" })
  expect(repaired?.detail).toContain("had been reset to other content; Asidee restored")
  // Already right: read, not rewritten, and the detail says nothing was written.
  for (let pass = 0; pass < 3; pass++) expect((await dns())?.detail).toContain("nothing was written")
  expect(state.writes).toBe(1)
  state.resolver = "nameserver 127.0.0.11\n"; state.writable = false
  expect((await dns())?.status).toBe("unknown")
  await expect(provider.start(manifest)).rejects.toThrow("DNS")
  state.writable = true; state.readable = false
  expect((await dns())?.status).toBe("unknown")
})

test("prepare restores a lost guard and network without trusting an old network resolver address", async () => {
  const { provider, manifest, state, calls } = fixture()
  state.guard = "missing"; state.network = false
  await provider.prepare(manifest)
  expect(state.guard).toBe("intact"); expect(state.network).toBe(true)
  expect(calls.some((argv) => argv.includes(`com.docker.network.bridge.name=${bridge(manifest.name)}`))).toBe(true)
})

test("an unavailable engine is an inspection error, never a missing sandbox that enforcement skips", async () => {
  const { manifest } = fixture()
  const provider = new GvisorProvider(async () => ({ exitCode: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }))
  await expect(provider.status(manifest)).rejects.toThrow("Cannot connect")
})
