import { expect, test } from "bun:test"
import { GvisorProvider, LABEL_ID, bridge } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Runner } from "../../core/types"

function fixture(docker = false) {
  const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo", docker }),
    engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }
  const state = { running: true, resolver: "nameserver 127.0.0.11\n", writable: true, readable: true, guard: "intact", network: true }
  const calls: string[][] = []
  const runner: Runner = async (argv, options) => {
    calls.push([...argv]); const args = argv.slice(3)
    let stdout = "", exitCode = 0
    if (args[0] === "inspect") stdout = JSON.stringify([{ State: { Running: state.running }, Config: { Labels: { [LABEL_ID]: manifest.id } }, HostConfig: { Runtime: "runsc" } }])
    else if (args[0] === "start") state.running = true
    else if (args[0] === "info") stdout = JSON.stringify({ runsc: { path: "/usr/bin/runsc", runtimeArgs: ["--net-raw", "--overlay2=none"] } })
    else if (args[0] === "network" && args[1] === "inspect") { stdout = bridge(manifest.name); exitCode = state.network ? 0 : 1 }
    else if (args[0] === "network" && args[1] === "create") state.network = true
    else if (args[0] === "run" && args.includes("nft")) state.guard = "intact"
    else if (args[0] === "run") stdout = state.guard
    else if (args[0] === "exec" && args.some((arg) => arg.includes("/etc/resolv.conf"))) {
      if (options?.stdin) { if (state.writable) state.resolver = String(options.stdin); else exitCode = 1 }
      if (args.some((arg) => arg.includes("cat /etc/resolv.conf"))) { stdout = state.resolver; if (!state.readable) exitCode = 1 }
    } else if (args.includes("docker")) stdout = "/var/lib/docker overlayfs"
    else if (args[0] === "exec") stdout = "gVisor"
    return { stdout, stderr: exitCode ? "fixture refused" : "", exitCode }
  }
  return { manifest, state, calls, provider: new GvisorProvider(runner) }
}

for (const docker of [false, true]) test(`start restores DNS on an already running sandbox, inner Docker ${docker}`, async () => {
  const { provider, manifest, state } = fixture(docker)
  await provider.start(manifest)
  expect(state.resolver).toBe("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
  state.running = false; state.resolver = "nameserver 172.20.0.1\n"
  await provider.start(manifest)
  expect(state.resolver).toContain("nameserver 1.1.1.1")
})

test("the enforcement runtime checks restore reset DNS and disclose an unreadable resolver", async () => {
  const { provider, manifest, state } = fixture()
  const checks = await provider.checks(manifest, "runtime")
  expect(state.resolver).toContain("nameserver 1.1.1.1")
  expect(checks.find((check) => check.id === "dns")).toMatchObject({ status: "pass", evidence: "inspected" })
  state.resolver = "nameserver 127.0.0.11\n"; state.writable = false
  expect((await provider.checks(manifest, "runtime")).find((check) => check.id === "dns")?.status).toBe("unknown")
  await expect(provider.start(manifest)).rejects.toThrow("DNS")
  state.writable = true; state.readable = false
  expect((await provider.checks(manifest, "runtime")).find((check) => check.id === "dns")?.status).toBe("unknown")
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
