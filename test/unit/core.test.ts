import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blockers, CHECKLIST, complete } from "../../core/checks"
import { Core, UNCHECKED_PASSES } from "../../core/core"
import { fieldValues, loadExtensions, parseExtension } from "../../core/extensions"
import { configChecks, gvisorSetup, network, unsafeRuntimeArgs, type GuardState } from "../../core/providers/gvisor"
import { readConfig, validSpec } from "../../core/state"
import { PaddockError, type CheckResult, type Engine, type Manifest, type Provider, type Stage } from "../../core/types"

const engine: Engine = { id: "fake:1", provider: "fake", label: "Fake engine", ready: true, problems: [], data: { context: "fake", runtime: "runsc" }, capabilities: { kernelIsolation: "gvisor", diskLimit: "watched", networkGuard: true } }
const pass = (id: CheckResult["id"]): CheckResult => ({ id, status: "pass", evidence: "inspected", detail: "ok" })
const allPass = (stage: Stage) => CHECKLIST.filter((item) => item.stage === stage).map((item) => pass(item.id))

// A provider whose engine is a few fields, with check results a test can change.
function fakeProvider(overrides: Partial<Record<Stage, CheckResult[]>> = {}) {
  const state = { running: false, exists: false, starts: 0, stops: 0, overrides }
  const provider: Provider = {
    id: "fake",
    detect: async () => [engine],
    create: async () => { state.exists = true },
    prepare: async () => {},
    start: async () => { state.running = true; state.starts++ },
    stop: async () => { state.running = false; state.stops++ },
    remove: async () => { state.exists = false; state.running = false },
    status: async () => !state.exists ? "missing" : state.running ? "running" : "stopped",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    attachArgv: () => [],
    checks: async (_manifest, stage) => state.overrides[stage] ?? allPass(stage),
    diskUsedBytes: async () => 0,
    stoppedWhy: async () => undefined,
    sweep: async () => {},
  }
  return { provider, state }
}

async function core(provider: Provider) {
  const root = await mkdtemp(join(tmpdir(), "paddock-test-"))
  return new Core([provider], { state: join(root, "state"), config: join(root, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("a check the provider does not report is unknown, never a pass", () => {
  const results = complete([pass("hardening")], ["config"])
  expect(results.map((entry) => entry.id)).toEqual(["hardening", "mounts", "network-guard", "inbound", "limits", "disk"])
  expect(results.find((entry) => entry.id === "mounts")!.status).toBe("unknown")
  expect(blockers(results).map((entry) => entry.id)).toEqual(["mounts", "network-guard", "inbound", "limits"])
})

test("a failed blocking check blocks; an unknown probe and a weak disk limit do not", () => {
  const results: CheckResult[] = [
    { id: "net-host", status: "unknown", evidence: "none", detail: "" }, { id: "net-peers", status: "fail", evidence: "probed", detail: "" },
    { id: "disk", status: "weak", evidence: "inspected", detail: "" }, { id: "egress", status: "info", evidence: "probed", detail: "" },
  ]
  expect(blockers(results).map((entry) => entry.id)).toEqual(["net-peers"])
})

test("a spec keeps only known fields and refuses option-like images", () => {
  const spec = validSpec({ name: "demo", cpus: "3", privileged: true, mounts: ["/:/host"], runtime: "runc" })
  expect(spec).toEqual({ name: "demo", image: "docker/sandbox-templates:shell-docker", cpus: 3, memoryGb: 4, pids: 4096, diskGb: 20 })
  expect(() => validSpec({ name: "demo", image: "--privileged" })).toThrow(PaddockError)
  expect(() => validSpec({ name: "../x" })).toThrow(PaddockError)
  expect(() => validSpec({ name: "demo", memoryGb: 0 })).toThrow(PaddockError)
})

const manifest: Manifest = { version: 1, name: "demo", id: "abc", engine, spec: validSpec({ name: "demo" }), createdAt: "" }
function inspect(change: (value: any) => void = () => {}) {
  const value = {
    State: { Running: true }, Config: { Labels: {} }, Mounts: [],
    HostConfig: { Runtime: "runsc", Privileged: false, CapAdd: null, Devices: [], PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", SecurityOpt: null,
      NetworkMode: network("demo"), PublishAllPorts: false, PortBindings: {}, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3, PidsLimit: 4096, NanoCpus: 2e9 },
    NetworkSettings: { Networks: { [network("demo")]: { IPAddress: "10.0.0.2" } } },
  }
  change(value); return value
}
const failing = (value: ReturnType<typeof inspect>, guard: GuardState = "intact", bridge = "pdk123") =>
  configChecks(value, manifest, guard, bridge).filter((entry) => entry.status === "fail").map((entry) => entry.id)

test("a container made the way the provider makes it passes the configuration checks", () => {
  expect(failing(inspect())).toEqual([])
  expect(configChecks(inspect(), manifest, "intact", "pdk123").find((entry) => entry.id === "disk")!.status).toBe("weak")
  const unmeasured = { ...manifest, engine: { ...engine, capabilities: { ...engine.capabilities!, diskLimit: "none" as const } } }
  expect(configChecks(inspect(), unmeasured, "intact", "pdk123").find((entry) => entry.id === "disk")!.status).toBe("unsupported")
})

test("each way of loosening a container fails its check", () => {
  expect(failing(inspect((value) => { value.HostConfig.Privileged = true }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.HostConfig.CapAdd = ["SYS_ADMIN"] }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.HostConfig.PidMode = "host" }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.Mounts = [{ Type: "bind", Source: "/Users/me", Destination: "/host" }] }))).toEqual(["mounts"])
  expect(failing(inspect((value) => { value.Mounts = [{ Type: "volume", Source: "/var/lib/docker/volumes/x", Destination: "/data" }] }))).toEqual([])
  expect(failing(inspect((value) => { value.NetworkSettings.Networks.bridge = { IPAddress: "172.17.0.2" } }))).toEqual(["network-guard"])
  expect(failing(inspect((value) => { value.HostConfig.NetworkMode = "host" }))).toEqual(["network-guard"])
  expect(failing(inspect(), "missing")).toEqual(["network-guard"])
  expect(failing(inspect(), "changed")).toEqual(["network-guard"])
  expect(failing(inspect(), "intact", "br-abc")).toEqual(["network-guard"])
  expect(failing(inspect((value) => { value.HostConfig.Runtime = "runc" }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.HostConfig.Annotations = { "dev.gvisor.flag.network": "host" } }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.HostConfig.Binds = ["/var/run/docker.sock:/var/run/docker.sock"] }))).toEqual(["mounts"])
  expect(failing(inspect((value) => { value.HostConfig.DeviceRequests = [{}] }))).toEqual(["hardening"])
  expect(failing(inspect((value) => { value.HostConfig.PortBindings = { "22/tcp": [{}] } }))).toEqual(["inbound"])
  expect(failing(inspect((value) => { value.HostConfig.Memory = 0 }))).toEqual(["limits"])
  expect(failing(inspect((value) => { value.HostConfig.PidsLimit = null }))).toEqual(["limits"])
})

test("create starts a sandbox whose checks hold, and remove needs its name repeated", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  const made = await paddock.create({ name: "demo" })
  expect(made.sandbox.status).toBe("running")
  expect(made.checks.length).toBe(CHECKLIST.length)
  await expect(paddock.create({ name: "demo" })).rejects.toMatchObject({ code: "conflict" })
  await expect(paddock.remove("demo", undefined)).rejects.toMatchObject({ code: "usage" })
  expect(state.exists).toBe(true)
  await paddock.remove("demo", "demo")
  expect(await paddock.list()).toEqual([])
})

test("a sandbox whose configuration fails a check is never started", async () => {
  const { provider, state } = fakeProvider({ config: allPass("config").map((entry) => entry.id === "mounts" ? { ...entry, status: "fail" as const } : entry) })
  const paddock = await core(provider)
  await expect(paddock.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed" })
  expect(state.starts).toBe(0)
  expect((await paddock.get("demo")).status).toBe("stopped")
})

test("a sandbox that fails a check once running is stopped again", async () => {
  const { provider, state } = fakeProvider({ runtime: [{ id: "kernel", status: "fail", evidence: "probed", detail: "not gVisor" }] })
  const paddock = await core(provider)
  await expect(paddock.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed" })
  expect(state).toMatchObject({ starts: 1, stops: 1, running: false })
})

test("verify stops a running sandbox when a probe fails, and says why", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  state.overrides.probe = allPass("probe").map((entry) => entry.id === "net-host" ? { ...entry, status: "fail" as const } : entry)
  const report = await paddock.verify("demo")
  expect(report.ok).toBe(false)
  expect(report.sandbox.status).toBe("stopped")
  expect(report.sandbox.stopReason).toContain("Cannot reach the host")
})

test("guard rules that could not be read block a start but do not stop a running sandbox", async () => {
  const unreadable = configChecks(inspect(), manifest, "unknown", "pdk123")
  expect(blockers(unreadable).map((entry) => entry.id)).toEqual(["network-guard"])
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  state.overrides.config = unreadable
  await paddock.enforce()
  expect((await paddock.get("demo")).status).toBe("running")
})

test("gVisor flags that open the host are recognized in every spelling", () => {
  expect(unsafeRuntimeArgs(["--allow-suid", "--overlay2=none", "--net-raw", "--network=sandbox", "--host-uds=none", "--network-processors-per-channel=2", "--ignore-cgroups=false"])).toEqual([])
  for (const args of [["--network=host"], ["-network=host"], ["--network", "host"], ["--network=none"], ["--host-uds=all"], ["--host-fifo=open"], ["--fsgofer-host-uds"], ["--TESTONLY-unsafe-nonroot"], ["--ignore-cgroups"], ["--allow-flag-override=true"]])
    expect(unsafeRuntimeArgs(args).length).toBe(1)
  expect(gvisorSetup("OrbStack", "aarch64")).toContain("~/.orbstack/config/docker.json")
  expect(gvisorSetup("Ubuntu 24.04", "x86_64")).toContain("/etc/docker/daemon.json")
})

test("a start that fails halfway does not leave the sandbox running", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" }); await paddock.stop("demo")
  provider.start = async () => { state.running = true; throw new Error("DNS could not be set") }
  await expect(paddock.start("demo")).rejects.toThrow("DNS could not be set")
  expect(state.running).toBe(false)
})

test("verifying a stopped sandbox judges its configuration and does not call the rest a failure", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" }); await paddock.stop("demo")
  const report = await paddock.verify("demo")
  expect(report.ok).toBe(true)
  expect(report.checks.find((entry) => entry.id === "kernel")).toMatchObject({ status: "unknown", detail: "Not checked: the sandbox is not running." })
  state.overrides.config = allPass("config").map((entry) => entry.id === "inbound" ? { ...entry, status: "fail" as const } : entry)
  expect((await paddock.verify("demo")).ok).toBe(false)
})

test("the daemon's pass stops a running sandbox that fails a check or passed its disk limit", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo", diskGb: 1 }); await paddock.create({ name: "other", diskGb: 1 })
  await paddock.enforce()
  expect((await paddock.get("demo")).status).toBe("running")
  provider.diskUsedBytes = async () => 2 * 1024 ** 3
  await paddock.enforce()
  expect(await paddock.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("disk watch") })
  provider.diskUsedBytes = async () => 0
  await paddock.start("demo")
  state.overrides.config = allPass("config").map((entry) => entry.id === "network-guard" ? { ...entry, status: "fail" as const, detail: "guard missing" } : entry)
  await paddock.enforce()
  expect(await paddock.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("guard missing") })
})

test("stopping the daemon stops the sandboxes whose disk limit only it enforces", async () => {
  const { provider } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  expect(await paddock.stopWatched()).toEqual(["demo"])
  expect(await paddock.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("daemon") })
})

test("extensions are declarations: bad ones are reported, field values are checked", async () => {
  const extension = parseExtension("tools", "/x", { name: "Tools", actions: [{ id: "go", label: "Go", run: ["./go.sh"], fields: [
    { id: "version", label: "Version", type: "text", default: "latest" }, { id: "mode", label: "Mode", type: "select", options: ["a", "b"], required: true }] }] })
  const action = extension.actions[0]!
  expect(fieldValues(action, { mode: "a" })).toEqual({ PADDOCK_FIELD_VERSION: "latest", PADDOCK_FIELD_MODE: "a" })
  expect(() => fieldValues(action, { mode: "c" })).toThrow(PaddockError)
  expect(() => fieldValues(action, {})).toThrow(PaddockError)
  expect(() => parseExtension("tools", "/x", { name: "Tools", actions: [{ id: "go", label: "Go", run: "rm -rf /" }] })).toThrow(PaddockError)

  const root = await mkdtemp(join(tmpdir(), "paddock-ext-"))
  await mkdir(join(root, "extensions", "good"), { recursive: true }); await mkdir(join(root, "extensions", "bad"), { recursive: true })
  await writeFile(join(root, "extensions", "good", "extension.json"), JSON.stringify({ name: "Good", actions: [] }))
  await writeFile(join(root, "extensions", "bad", "extension.json"), "{")
  const loaded = await loadExtensions({ state: root, config: root })
  expect(loaded.extensions.map((entry) => entry.id)).toEqual(["good"])
  expect(loaded.errors.length).toBe(1)
})

test("a running sandbox that cannot be checked for several passes in a row is stopped; one clear pass resets the count", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  const blind = allPass("config").map((entry) => entry.id === "network-guard" ? { ...entry, status: "unknown" as const } : entry)
  state.overrides.config = blind
  for (let pass = 1; pass < UNCHECKED_PASSES; pass++) await paddock.enforce()
  expect(state.running).toBe(true)
  delete state.overrides.config; await paddock.enforce()
  state.overrides.config = blind
  for (let pass = 1; pass < UNCHECKED_PASSES; pass++) await paddock.enforce()
  expect(state.running).toBe(true)
  await paddock.enforce()
  expect(state.running).toBe(false)
  expect((await paddock.get("demo")).stopReason).toContain("could not check")
})

test("a config file with a mistake is refused by name, and its defaults obey the same limits as a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-config-")); const dirs = { state: join(root, "state"), config: root }
  expect(await readConfig(dirs)).toEqual({ defaults: {} })
  for (const bad of ["{ nope", "[]", "null", '{"defaults":"x"}', '{"engine":5}', '{"defaults":{"cpus":"lots"}}', '{"defaults":{"image":"--privileged"}}', '{"defaults":{"memoryGb":100000}}']) {
    await writeFile(join(root, "config.json"), bad)
    await expect(readConfig(dirs)).rejects.toThrow("config.json")
  }
  await writeFile(join(root, "config.json"), '{"defaults":{"image":"alpine:3","cpus":1,"privileged":true,"name":"x"},"engine":"gvisor:orbstack"}')
  expect(await readConfig(dirs)).toEqual({ defaults: { image: "alpine:3", cpus: 1 }, engine: "gvisor:orbstack" })
})

test("a damaged state file is listed as damaged and the other sandboxes still work", async () => {
  const { provider } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  await writeFile(join(paddock.dirs.state, "sandboxes", "broken.json"), "{ nope")
  await writeFile(join(paddock.dirs.state, "sandboxes", "other.json"), '{"name":"someone-else"}')
  const list = await paddock.list()
  expect(list.map((entry) => `${entry.name}:${entry.status}`)).toEqual(["demo:running", "broken:damaged", "other:damaged"])
  expect(list[1]!.stopReason).toContain("broken.json")
  await paddock.enforce()
  expect((await paddock.verify("demo")).ok).toBe(true)
})

test("a setup hook runs after the sandbox is free, so it can call back into it", async () => {
  const { provider } = fakeProvider()
  const root = await mkdtemp(join(tmpdir(), "paddock-hook-")); const dirs = { state: join(root, "state"), config: join(root, "config") }
  await mkdir(join(dirs.config, "extensions", "setup"), { recursive: true })
  await writeFile(join(dirs.config, "extensions", "setup", "extension.json"), JSON.stringify({ name: "Setup", hooks: { postCreate: ["./setup.sh"] } }))
  let paddock: Core
  // The hook's command stands in for a script that runs `paddock verify` on the new sandbox.
  paddock = new Core([provider], dirs, async (_argv, options) => ({ exitCode: 0, stdout: String((await paddock.verify(options!.env!.PADDOCK_SANDBOX!)).ok), stderr: "" }), "/nowhere")
  const made = await Promise.race([paddock.create({ name: "demo" }), Bun.sleep(2000).then(() => "stuck" as const)])
  expect(made).not.toBe("stuck")
  expect((made as Awaited<ReturnType<Core["create"]>>).hooks).toEqual([{ extension: "setup", exitCode: 0, output: "true" }])
})
