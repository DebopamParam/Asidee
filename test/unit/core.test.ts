import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { connect } from "node:net"
import { join } from "node:path"
import { blockers, CHECKLIST, complete } from "../../core/checks"
import { createHandler, methods } from "../../core/daemon"
import { Core, UNCHECKED_PASSES } from "../../core/core"
import { CATALOG, Machines, type Hello } from "../../core/machines"
import { object, parseReply } from "../../core/transport"
import { DockerSandboxesProvider } from "../../core/providers/docker-sandboxes"
import { fieldValues, loadExtensions, parseExtension } from "../../core/extensions"
import { configChecks, DOCKER_CAPABILITIES, dockerVolume, GvisorProvider, gvisorSetup, network, unsafeRuntimeArgs, type GuardState } from "../../core/providers/gvisor"
import { OUTPUT_LIMIT, systemRunner } from "../../core/run"
import { readConfig, readManifest, validSizes, validSpec, validTemplateName } from "../../core/state"
import { AsideeError, type CheckResult, type Engine, type Limits, type Manifest, type Provider, type Stage, type Template } from "../../core/types"

const engine: Engine = { id: "fake:1", provider: "fake", label: "Fake engine", ready: true, problems: [], data: { context: "fake", runtime: "runsc" }, capabilities: { kernelIsolation: "gvisor", diskLimit: "watched", networkGuard: true, docker: true, execStream: true, loopbackRelay: true, resize: "live", snapshot: true } }
const pass = (id: CheckResult["id"]): CheckResult => ({ id, status: "pass", evidence: "inspected", detail: "ok" })
const allPass = (stage: Stage) => CHECKLIST.filter((item) => item.stage === stage).map((item) => pass(item.id))

// A provider whose engine is a few fields, with check results a test can change.
function fakeProvider(overrides: Partial<Record<Stage, CheckResult[]>> = {}) {
  const state = { running: false, exists: false, starts: 0, stops: 0, overrides, use: { memoryBytes: 0, tasks: 0 } as { memoryBytes: number; tasks: number } | undefined,
    live: undefined as Limits | undefined, resized: undefined as Limits | undefined, templates: [] as Template[], created: [] as Manifest[] }
  const provider: Provider = {
    id: "fake",
    detect: async () => [engine],
    create: async (manifest) => { state.exists = true; state.created.push(structuredClone(manifest)) },
    prepare: async () => {},
    start: async () => { state.running = true; state.starts++ },
    stop: async () => { state.running = false; state.stops++ },
    remove: async () => { state.exists = false; state.running = false },
    status: async () => !state.exists ? "missing" : state.running ? "running" : "stopped",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    openExec: async () => { throw new AsideeError("dependency", "no sessions in the fake") },
    generation: async () => state.running ? `run-${state.starts}` : undefined,
    prepareLoopback: async () => {},
    dialLoopback: async () => { throw new AsideeError("dependency", "no sessions in the fake") },
    checks: async (_manifest, stage) => state.overrides[stage] ?? allPass(stage),
    diskUsedBytes: async () => 0,
    stoppedWhy: async () => undefined,
    sweep: async () => {},
    resize: async (_manifest, limits) => { state.resized = limits; return state.running ? state.live ?? limits : undefined },
    usage: async () => state.running ? state.use : undefined,
    snapshot: async (manifest, name) => {
      const made: Template = { name, engine: engine.id, imageId: `sha256:${name}`, source: manifest.name, sourceImage: manifest.spec.image, createdAt: "2026-11-11T00:00:00Z", sizeBytes: 1, loginsRemoved: [], dependants: [] }
      state.templates.push(made); return made
    },
    templates: async () => state.templates,
    removeTemplate: async (_engine, name) => {
      const found = state.templates.find((entry) => entry.name === name)!
      state.templates = state.templates.filter((entry) => entry !== found)
      return { imageId: found.imageId, dependants: found.dependants }
    },
  }
  return { provider, state }
}

async function core(provider: Provider) {
  const root = await mkdtemp(join(tmpdir(), "asidee-test-"))
  return new Core([provider], { state: join(root, "state"), config: join(root, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("stored verification is dated history with current properties unknown across every lifecycle change", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  const made = await asidee.create({ name: "demo" })
  expect(made.checks.find((check) => check.id === "kernel")?.status).toBe("pass")
  const measured = made.sandbox.lastVerify!.at
  const historical = async (instance = asidee) => {
    const saved = (await instance.get("demo")).lastVerify!
    expect(saved.at).toBe(measured)
    expect(saved.results.every((check) => check.status === "unknown" && check.evidence === "none")).toBe(true)
    expect(saved.results[0]!.detail).toStartWith(`Measured ${measured}: pass (`)
  }
  await historical()
  state.starts++; await historical()
  await asidee.stop("demo"); await historical()
  await asidee.start("demo"); await historical()
  await historical(new Core([provider], asidee.dirs, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere"))
  provider.checks = async () => { throw new Error("engine restarted or changed") }
  await historical()
  expect((await asidee.list())[0]!.lastVerify?.results[0]?.status).toBe("unknown")
})

test("a check the provider does not report is unknown, never a pass", () => {
  const results = complete([pass("hardening")], ["config"])
  expect(results.map((entry) => entry.id)).toEqual(["hardening", "mounts", "network-guard", "inbound", "forwards", "ssh", "links", "limits", "disk", "template"])
  expect(results.find((entry) => entry.id === "mounts")!.status).toBe("unknown")
  expect(blockers(results).map((entry) => entry.id)).toEqual(["mounts", "network-guard", "inbound", "limits"])
})

test("remote relay leases require the current sandbox and run and are revoked on stop", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  const made = await asidee.create({ name: "demo" }); const target = await asidee.sessionTarget("demo")
  expect(made.sandbox.sandboxId).toBe(target.sandboxId)
  const lease = { kind: "lease" as const, ...target, port: 3000, leaseId: "a".repeat(32) }
  await expect(asidee.openSession({ ...lease, sandboxId: "b".repeat(32) })).rejects.toThrow("recreated")
  await expect(asidee.openSession({ ...lease, generation: "old" })).rejects.toThrow("run changed")
  const control = await asidee.openSession(lease); let ended = ""
  control.on("end", (exit) => { ended = exit.error ?? "" })
  const checks = (await asidee.verify("demo")).checks
  expect(checks.find((check) => check.id === "forwards")?.detail).toContain("SSH lease")
  await expect(asidee.openSession({ ...lease, kind: "dial", port: 3001 })).rejects.toThrow("no longer open")
  await expect(asidee.openSession({ ...lease, kind: "dial", leaseId: "b".repeat(32) })).rejects.toThrow("no longer open")
  await asidee.stop("demo")
  expect(ended).toContain("stopped")
  expect(state.running).toBe(false)
  await asidee.start("demo")
  await expect(asidee.openSession({ ...lease, kind: "dial" })).rejects.toThrow("run changed")
})

test("a remote lease ends on its own when the primary stops renewing it, and lasts while it renews", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider); asidee.leaseTtlMs = 200
  await asidee.create({ name: "demo" }); const target = await asidee.sessionTarget("demo")
  const lease = { kind: "lease" as const, ...target, port: 3000, leaseId: "a".repeat(32) }
  const renewed = await asidee.openSession(lease); let renewedEnd = ""
  renewed.on("end", (exit) => { renewedEnd = exit.error ?? "ended" })
  const timer = setInterval(() => renewed.write(new Uint8Array([1])), 50)
  const silent = await asidee.openSession({ ...lease, leaseId: "b".repeat(32) }); let silentEnd = ""
  silent.on("end", (exit) => { silentEnd = exit.error ?? "ended" })
  await Bun.sleep(600); clearInterval(timer)
  expect(silentEnd).toContain("did not renew")
  expect(renewedEnd).toBe("")
  await Bun.sleep(400)
  expect(renewedEnd).toContain("did not renew")
})

test("a failed blocking check blocks; an unknown probe blocks by default and a weak disk limit does not", () => {
  const results: CheckResult[] = [
    { id: "net-host", status: "unknown", evidence: "none", detail: "" }, { id: "net-peers", status: "fail", evidence: "probed", detail: "" },
    { id: "disk", status: "weak", evidence: "inspected", detail: "" }, { id: "egress", status: "info", evidence: "probed", detail: "" },
  ]
  expect(blockers(results).map((entry) => entry.id)).toEqual(["net-host", "net-peers"])
  expect(blockers(results, CHECKLIST, false).map((entry) => entry.id)).toEqual(["net-peers"])
})

test("unsupported blocking properties refuse creation and name the missing promise", async () => {
  for (const id of ["network-guard", "kernel", "net-host"] as const) {
    const stage = CHECKLIST.find((item) => item.id === id)!.stage
    const results = allPass(stage).map((entry): CheckResult => entry.id === id ? { ...entry, status: "unsupported", detail: "Engine cannot provide this." } : entry)
    expect(blockers(results).map((entry) => entry.id)).toEqual([id])
    const { provider, state } = fakeProvider({ [stage]: results }); const asidee = await core(provider)
    await expect(asidee.create({ name: "demo" })).rejects.toThrow(CHECKLIST.find((item) => item.id === id)!.title)
    expect(state.running).toBe(false)
  }
  expect(blockers([{ id: "disk", status: "unsupported", evidence: "none", detail: "No disk cap." }])).toEqual([])
})

test("Docker Sandboxes is detection-only and refuses create without touching an engine", async () => {
  const calls: string[][] = []
  const provider = new DockerSandboxesProvider(async (argv) => { calls.push([...argv]); return { exitCode: 0, stdout: "1.0", stderr: "" } })
  const asidee = await core(provider)
  expect((await provider.detect())[0]?.ready).toBe(false)
  await expect(asidee.create({ name: "demo", engine: "docker-sandboxes" })).rejects.toThrow("does not support Docker Sandboxes yet")
  expect(calls.every((argv) => argv.join(" ") === "sbx version")).toBe(true)
  expect(await asidee.list()).toEqual([])
})

test("a spec keeps only known fields and refuses option-like images", () => {
  const spec = validSpec({ name: "demo", cpus: "3", privileged: true, mounts: ["/:/host"], runtime: "runc" })
  expect(spec).toEqual({ name: "demo", image: "docker/sandbox-templates:shell-docker", cpus: 3, memoryGb: 4, pids: 4096, diskGb: 20, docker: false })
  expect(() => validSpec({ name: "demo", image: "--privileged" })).toThrow(AsideeError)
  expect(() => validSpec({ name: "../x" })).toThrow(AsideeError)
  expect(() => validSpec({ name: "demo", memoryGb: 0 })).toThrow(AsideeError)
})

test("create and resize share one range for each size, and resize keeps what is not given", () => {
  const base = { cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 }
  expect(validSizes({}, base)).toEqual(base)
  expect(validSizes({ memoryGb: "8", pids: "100.4" }, base)).toEqual({ ...base, memoryGb: 8, pids: 100 })
  for (const input of [{ cpus: 0.2 }, { memoryGb: 0.2 }, { pids: 63 }, { diskGb: 0.5 }, { cpus: 65 }, { memoryGb: "lots" }, { pids: "-1" }])
    expect(() => validSizes(input, base)).toThrow(AsideeError)
})

test("a template is named like a sandbox, and its images are reached only by that name", () => {
  expect(validTemplateName("base-1")).toBe("base-1")
  for (const name of ["", "-x", "Base", "a/b", "a:b", "x".repeat(32), 3]) expect(() => validTemplateName(name)).toThrow("template name")
  expect(validSpec({ name: "demo", template: "base" })).toMatchObject({ template: "base" })
  expect(() => validSpec({ name: "demo", template: "base", image: "ubuntu:24.04" })).toThrow("not both")
  expect(() => validSpec({ name: "demo", template: "../x" })).toThrow(AsideeError)
  for (const image of ["asidee-template-abc:base", "asidee-snapshot-abc:1"]) expect(() => validSpec({ name: "demo", image })).toThrow("--template")
})

test("docker is a strict boolean, defaults off, and can be set or overridden in defaults", () => {
  expect(validSpec({ name: "demo" }).docker).toBe(false)
  expect(validSpec({ name: "demo", docker: true }).docker).toBe(true)
  expect(validSpec({ name: "demo" }, { docker: true }).docker).toBe(true)
  expect(validSpec({ name: "demo", docker: false }, { docker: true }).docker).toBe(false)
  for (const docker of ["true", "false", 0, 1, null, [], {}]) expect(() => validSpec({ name: "demo", docker })).toThrow("docker must be a boolean")
})

test("an engine without inner Docker refuses the option before making a sandbox", async () => {
  const { provider, state } = fakeProvider()
  provider.detect = async () => [{ ...engine, capabilities: { ...engine.capabilities!, docker: false } }]
  const asidee = await core(provider)
  await expect(asidee.create({ name: "demo", docker: true })).rejects.toMatchObject({ code: "dependency" })
  expect(state.exists).toBe(false)
  expect(await asidee.list()).toEqual([])
})

const manifest: Manifest = { version: 1, name: "demo", id: "abc", engine, spec: validSpec({ name: "demo" }), createdAt: "" }
function inspect(change: (value: any) => void = () => {}) {
  const value = {
    State: { Running: true }, Config: { Labels: {} }, Mounts: [],
    HostConfig: { Runtime: "runsc", Privileged: false, CapAdd: null, Devices: [], PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "", SecurityOpt: null,
      NetworkMode: network("demo"), PublishAllPorts: false, PortBindings: {}, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3, PidsLimit: 4096, NanoCpus: 2e9,
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } } as { Type: string; Config: Record<string, string> | null } | undefined },
    NetworkSettings: { Networks: { [network("demo")]: { IPAddress: "10.0.0.2" } } },
  }
  change(value); return value
}
const failing = (value: ReturnType<typeof inspect>, guard: GuardState = "intact", bridge = "asd123") =>
  configChecks(value, manifest, guard, bridge).filter((entry) => entry.status === "fail").map((entry) => entry.id)

test("a container made the way the provider makes it passes the configuration checks", () => {
  expect(failing(inspect())).toEqual([])
  expect(configChecks(inspect(), manifest, "intact", "asd123").find((entry) => entry.id === "disk")!.status).toBe("weak")
  const unmeasured = { ...manifest, engine: { ...engine, capabilities: { ...engine.capabilities!, diskLimit: "none" as const } } }
  expect(configChecks(inspect(), unmeasured, "intact", "asd123").find((entry) => entry.id === "disk")!.status).toBe("unsupported")
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
  // Set, but not to what the spec says: changed behind Asidee's back, or a resize the manifest does not know of.
  expect(failing(inspect((value) => { value.HostConfig.Memory = value.HostConfig.MemorySwap = 8 * 1024 ** 3 }))).toEqual(["limits"])
  expect(failing(inspect((value) => { value.HostConfig.PidsLimit = 8192 }))).toEqual(["limits"])
  expect(failing(inspect((value) => { value.HostConfig.NanoCpus = 3e9 }))).toEqual(["limits"])
})

test("the template check says what a sandbox was made from, and fails when the engine runs something else", () => {
  const image = (labels: Record<string, string> = {}, tags = ["asidee-template-own:base"]) => ({ Id: "sha256:t", RepoTags: tags, Config: { Labels: labels } })
  const templated: Manifest = { ...manifest, template: { name: "base", imageId: "sha256:t", source: "src", createdAt: "2026-11-11T00:00:00Z" } }
  const check = (value: ReturnType<typeof inspect>, sandbox: Manifest, described?: ReturnType<typeof image>) => configChecks(value, sandbox, "intact", "asd123", undefined, described, "own").find((entry) => entry.id === "template")!
  const running = (id: string) => inspect((value) => { (value as any).Image = id })
  expect(check(running("sha256:t"), templated, image())).toMatchObject({ status: "info" })
  expect(check(running("sha256:t"), templated, image()).detail).toContain("Template base, saved from the sandbox src")
  expect(check(running("sha256:t"), templated, image({}, [])).detail).toContain("has been removed since")
  expect(check(running("sha256:other"), templated, image()).status).toBe("fail")
  expect(check(running("sha256:t"), templated).status).toBe("unknown")
  expect(check(running("sha256:i"), manifest, image()).detail).toBe(`None: made from the image ${manifest.spec.image}.`)
  expect(check(running("sha256:t"), manifest, image({ "com.asidee.template": "base", "com.asidee.template.owner": "own" })).detail).toContain("is Asidee template base's")
})

test("Docker hardening accepts exactly its declared additions inside gVisor", () => {
  const enabled = { ...manifest, spec: { ...manifest.spec, docker: true } }
  const checked = (caps: string[], change: (value: any) => void = () => {}) => configChecks(inspect((value) => {
    value.HostConfig.CapAdd = caps
    value.Mounts = [{ Type: "volume", Name: dockerVolume(enabled), Source: "/engine/volume", Destination: "/var/lib/docker", RW: true }]
    change(value)
  }), enabled, "intact", "asd123", [{ Name: dockerVolume(enabled), Driver: "local", Options: null, Labels: { "com.asidee.id": enabled.id, "com.asidee.name": enabled.name } }])
  const hardening = (caps: string[], change?: (value: any) => void) => checked(caps, change).find((entry) => entry.id === "hardening")!
  expect(hardening([...DOCKER_CAPABILITIES])).toMatchObject({ status: "pass", evidence: "inspected" })
  expect(DOCKER_CAPABILITIES).toEqual(["NET_ADMIN", "SYS_ADMIN"])
  expect(hardening(["CAP_SYS_ADMIN", "cap_net_admin"]).status).toBe("pass")
  for (const word of [...DOCKER_CAPABILITIES, "inside gVisor"]) expect(hardening([...DOCKER_CAPABILITIES]).detail).toContain(word)
  for (const caps of [[], ["NET_ADMIN"], ["SYS_ADMIN"], ["ALL"], [...DOCKER_CAPABILITIES, "SYS_PTRACE"]]) expect(hardening(caps).status).toBe("fail")
  for (const change of [
    (value: any) => { value.HostConfig.Privileged = true },
    (value: any) => { value.HostConfig.PidMode = "host" },
    (value: any) => { value.HostConfig.Devices = [{}] },
    (value: any) => { value.HostConfig.CapDrop = ["ALL"] },
    (value: any) => { value.HostConfig.Runtime = "runc" },
  ]) expect(hardening([...DOCKER_CAPABILITIES], change).status).toBe("fail")
  expect(checked([...DOCKER_CAPABILITIES], (value) => { value.Mounts[0].Name = "someone-elses-volume" }).find((entry) => entry.id === "mounts")!.status).toBe("fail")
})

test("every sandbox's main-process output must have bounded host logging, with or without Docker", () => {
  for (const docker of [false, true]) {
    const sandbox = { ...manifest, spec: { ...manifest.spec, docker } }
    const limits = (LogConfig?: { Type: string; Config: Record<string, string> | null }) => configChecks(inspect((value) => {
      value.HostConfig.LogConfig = LogConfig
    }), sandbox, "intact", "asd123").find((entry) => entry.id === "limits")!
    expect(limits({ Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } }).status).toBe("pass")
    const invalid: Parameters<typeof limits>[0][] = [undefined, { Type: "json-file", Config: {} }, { Type: "json-file", Config: { "max-size": "10m" } },
      { Type: "json-file", Config: { "max-size": "10m", "max-file": "200" } }, { Type: "local", Config: { "max-size": "10m", "max-file": "2" } }]
    for (const config of invalid) {
      expect(limits(config)).toMatchObject({ status: "fail" })
      expect(limits(config).detail).toContain("host logs (json-file with max-size=10m")
    }
  }
})

test("Docker volumes cannot disguise host folders or another sandbox's data", () => {
  const enabled = { ...manifest, spec: { ...manifest.spec, docker: true } }
  const value = inspect((value) => { value.Mounts = [{ Type: "volume", Name: dockerVolume(enabled), Destination: "/var/lib/docker", Source: "/engine/volume", RW: true }] })
  const volume = { Name: dockerVolume(enabled), Driver: "local", Options: null, Labels: { "com.asidee.id": enabled.id, "com.asidee.name": enabled.name } }
  const mounts = (volumes?: Parameters<typeof configChecks>[4]) => configChecks(value, enabled, "intact", "asd123", volumes).find((entry) => entry.id === "mounts")!
  expect(mounts([volume]).status).toBe("pass")
  expect(mounts().status).toBe("unknown")
  expect(mounts([]).status).toBe("unknown")
  expect(mounts([{ ...volume, Options: { type: "none", device: "/tmp", o: "bind" } }]).status).toBe("fail")
  expect(mounts([{ ...volume, Driver: "nfs" }]).status).toBe("fail")
  expect(mounts([{ ...volume, Labels: {} }]).status).toBe("fail")
})

test("create starts a sandbox whose checks hold, and remove needs its name repeated", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  const made = await asidee.create({ name: "demo" })
  expect(made.sandbox.status).toBe("running")
  expect(made.checks.length).toBe(CHECKLIST.length)
  await expect(asidee.create({ name: "demo" })).rejects.toMatchObject({ code: "conflict" })
  await expect(asidee.remove("demo", undefined)).rejects.toMatchObject({ code: "usage" })
  expect(state.exists).toBe(true)
  await asidee.remove("demo", "demo")
  expect(await asidee.list()).toEqual([])
})

test("a command that prints more than the output limit is killed, and nothing it printed is returned", async () => {
  const whole = await systemRunner(["sh", "-c", `head -c ${OUTPUT_LIMIT} /dev/zero; exit 3`])
  expect(whole.exitCode).toBe(3); expect(whole.stdout.length).toBe(OUTPUT_LIMIT); expect(whole.overflow).toBeUndefined()
  const started = Date.now()
  const over = await systemRunner(["sh", "-c", "yes asidee; echo finished > /dev/null"])
  expect(over).toMatchObject({ exitCode: 124, stdout: "", overflow: "stdout" })
  expect(over.stderr).toContain("16 MiB on stdout")
  expect(Date.now() - started).toBeLessThan(20_000)
  expect(await systemRunner(["sh", "-c", "yes asidee >&2"], { maxOutputBytes: 1024 ** 2 })).toMatchObject({ exitCode: 124, stdout: "", overflow: "stderr" })
  const bytes = new Uint8Array([0, 255, 128, 10, 0xc3])
  expect([...(await systemRunner(["cat"], { stdin: bytes, binary: true })).raw!]).toEqual([...bytes])
})

test("exec refuses output past the limit with an error that names it, never a cut-off result", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  provider.exec = async () => ({ exitCode: 124, stdout: "", stderr: "", overflow: "stdout" })
  await expect(asidee.exec("demo", ["yes"])).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("16 MiB on stdout") })
})

test("a sandbox whose configuration fails a check is never started", async () => {
  const { provider, state } = fakeProvider({ config: allPass("config").map((entry) => entry.id === "mounts" ? { ...entry, status: "fail" as const } : entry) })
  const asidee = await core(provider)
  await expect(asidee.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed" })
  expect(state.starts).toBe(0)
  expect((await asidee.get("demo")).status).toBe("stopped")
})

test("a sandbox that fails a check once running is stopped again", async () => {
  const { provider, state } = fakeProvider({ runtime: [{ id: "kernel", status: "fail", evidence: "probed", detail: "not gVisor" }] })
  const asidee = await core(provider)
  await expect(asidee.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed" })
  expect(state).toMatchObject({ starts: 1, stops: 1, running: false })
})

test("verify stops a running sandbox when a probe fails, and says why", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  state.overrides.probe = allPass("probe").map((entry) => entry.id === "net-host" ? { ...entry, status: "fail" as const } : entry)
  const report = await asidee.verify("demo")
  expect(report.ok).toBe(false)
  expect(report.sandbox.status).toBe("stopped")
  expect(report.sandbox.stopReason).toContain("Cannot reach the host")
  expect(report.configurationOnly).toBe(false)
})

test("guard rules that could not be read block a start but do not stop a running sandbox", async () => {
  const unreadable = configChecks(inspect(), manifest, "unknown", "asd123")
  expect(blockers(unreadable).map((entry) => entry.id)).toEqual(["network-guard"])
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  state.overrides.config = unreadable
  await asidee.enforce()
  expect((await asidee.get("demo")).status).toBe("running")
})

test("gVisor flags that open the host are recognized in every spelling", () => {
  expect(unsafeRuntimeArgs(["--allow-suid", "--overlay2=none", "--net-raw", "--network=sandbox", "--host-uds=none", "--network-processors-per-channel=2", "--ignore-cgroups=false", "--nvproxy=false", "-tpuproxy=false"])).toEqual([])
  for (const args of [["--network=host"], ["-network=host"], ["--network", "host"], ["--network=none"], ["--host-uds=all"], ["--host-fifo=open"], ["--fsgofer-host-uds"], ["--TESTONLY-unsafe-nonroot"], ["--ignore-cgroups"], ["--allow-flag-override=true"],
    ["--nvproxy"], ["-nvproxy"], ["--nvproxy=true"], ["--nvproxy-docker"], ["--nvproxy-docker=true"], ["--tpuproxy"], ["-tpuproxy=true"]])
    expect(unsafeRuntimeArgs(args).length).toBe(1)
  expect(gvisorSetup("OrbStack", "aarch64")).toContain("~/.orbstack/config/docker.json")
  expect(gvisorSetup("OrbStack", "aarch64")).toContain("--net-raw")
  expect(gvisorSetup("Ubuntu 24.04", "x86_64")).toContain("/etc/docker/daemon.json")
})

test("a start that fails halfway does not leave the sandbox running", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" }); await asidee.stop("demo")
  provider.start = async () => { state.running = true; throw new Error("DNS could not be set") }
  await expect(asidee.start("demo")).rejects.toThrow("DNS could not be set")
  expect(state.running).toBe(false)
})

for (const requireProbes of [true, false]) test(`a create whose first verify throws stops the sandbox and says so, require-probes ${requireProbes ? "on" : "off"}`, async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.configSet({ requireProbes })
  provider.checks = async (_manifest, stage) => { if (stage === "probe") throw new AsideeError("runtime", "A previous Asidee probe has not finished tearing down its routes."); return allPass(stage) }
  await expect(asidee.create({ name: "demo" })).rejects.toThrow("demo was created but stopped, and is kept for diagnosis: its first checks could not finish. A previous Asidee probe")
  expect(state.running).toBe(false)
  const saved = await readManifest(asidee.dirs, "demo")
  expect(saved.stopReason).toContain("its first checks could not finish")
  expect(saved.checksPending).toBeUndefined()
})

test("a sandbox a crashed daemon started but never finished checking is stopped by the next daemon", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  // The first daemon dies inside the probe: the sandbox runs, and only the mark written before its start says so.
  let reached: () => void = () => {}
  const inProbe = new Promise<void>((resolve) => { reached = resolve })
  provider.checks = async (_manifest, stage) => { if (stage === "probe") { reached(); return new Promise<never>(() => {}) } return allPass(stage) }
  void asidee.create({ name: "demo" })
  await inProbe
  expect(state.running).toBe(true)
  expect((await readManifest(asidee.dirs, "demo")).checksPending).toBeString()
  provider.checks = async (_manifest, stage) => state.overrides[stage] ?? allPass(stage)
  const next = new Core([provider], asidee.dirs, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
  await next.enforce()
  expect(state.running).toBe(false)
  const saved = await readManifest(asidee.dirs, "demo")
  expect(saved.stopReason).toContain("its checks never finished: the daemon that started it ended first")
  expect(saved.checksPending).toBeUndefined()
  // Control: a start whose checks finished leaves no mark, and enforcement keeps it running.
  await next.start("demo")
  expect((await readManifest(asidee.dirs, "demo")).checksPending).toBeUndefined()
  await next.enforce()
  expect(state.running).toBe(true)
})

test("verifying a stopped sandbox judges its configuration and does not call the rest a failure", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" }); await asidee.stop("demo")
  const report = await asidee.verify("demo")
  expect(report.ok).toBe(true)
  expect(report.checks.find((entry) => entry.id === "kernel")).toMatchObject({ status: "unknown", detail: "Not checked: the sandbox is not running." })
  state.overrides.config = allPass("config").map((entry) => entry.id === "inbound" ? { ...entry, status: "fail" as const } : entry)
  expect((await asidee.verify("demo")).ok).toBe(false)
})

test("the daemon's pass stops a running sandbox that fails a check or passed its disk limit", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo", diskGb: 1 }); await asidee.create({ name: "other", diskGb: 1 })
  await asidee.enforce()
  expect((await asidee.get("demo")).status).toBe("running")
  provider.diskUsedBytes = async () => 2 * 1024 ** 3
  await asidee.enforce()
  expect(await asidee.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("disk watch") })
  provider.diskUsedBytes = async () => 0
  await asidee.start("demo")
  state.overrides.config = allPass("config").map((entry) => entry.id === "network-guard" ? { ...entry, status: "fail" as const, detail: "guard missing" } : entry)
  await asidee.enforce()
  expect(await asidee.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("guard missing") })
})

test("the disk watch stops a sandbox measured over its limit twice, and leaves a failed measurement to the daemon's pass", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo", diskGb: 1 })
  await asidee.watchDisk()
  expect((await asidee.get("demo")).status).toBe("running")
  // Not measurable: never a stop here, however often, and nothing is recorded.
  provider.diskUsedBytes = async () => undefined
  for (let pass = 0; pass < UNCHECKED_PASSES + 2; pass++) await asidee.watchDisk()
  provider.diskUsedBytes = async () => { throw new Error("disk unreadable") }
  await asidee.watchDisk()
  provider.diskUsedBytes = async () => 0
  expect(await asidee.get("demo")).toMatchObject({ status: "running", enforcementProblem: undefined })
  // Over on the first measurement only: the second, made under the sandbox's lock, decides.
  let measured = 0
  provider.diskUsedBytes = async () => measured++ === 0 ? 2 * 1024 ** 3 : 0
  await asidee.watchDisk()
  expect(measured).toBe(2)
  expect((await asidee.get("demo")).status).toBe("running")
  measured = 0
  provider.diskUsedBytes = async () => { measured++; return 2 * 1024 ** 3 }
  await asidee.watchDisk()
  expect(measured).toBe(2)
  // A stopped sandbox is not measured.
  await asidee.watchDisk()
  expect(measured).toBe(2)
  expect(await asidee.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("disk watch") })
  // Started over its limit: the watch leaves it alone for the recovery window, so space can be freed.
  expect((await asidee.start("demo")).diskWarning?.message).toContain("within about 30 seconds")
  await asidee.watchDisk(); await asidee.enforce()
  expect(await asidee.get("demo")).toMatchObject({ status: "running", enforcementProblem: undefined })
  // The window ends once it measures under its limit; over again, it is stopped at the next measurement.
  provider.diskUsedBytes = async () => 0
  await asidee.watchDisk()
  provider.diskUsedBytes = async () => 2 * 1024 ** 3
  await asidee.watchDisk()
  expect((await asidee.get("demo")).status).toBe("stopped")
  // Still over when the window has passed: stopped.
  await asidee.start("demo")
  asidee.diskRecoveryMs = 0
  await asidee.watchDisk()
  expect((await asidee.get("demo")).status).toBe("stopped")
})

test("enforcement exceptions are recorded per sandbox, survive a daemon restart and do not skip other sandboxes", async () => {
  for (const operation of ["status", "checks", "diskUsedBytes"] as const) {
    const { provider } = fakeProvider(); const asidee = await core(provider)
    await asidee.create({ name: "demo" }); await asidee.create({ name: "other" })
    const original = provider[operation]; let otherChecked = false
    const checks = provider.checks
    provider.checks = async (manifest, stage) => { if (manifest.name === "other") otherChecked = true; return checks(manifest, stage) }
    if (operation === "status") provider.status = async (manifest) => { if (manifest.name === "demo") throw new Error("engine offline"); return "running" }
    if (operation === "checks") provider.checks = async (manifest, stage) => { if (manifest.name === "demo") throw new Error("guard unreadable"); otherChecked = true; return checks(manifest, stage) }
    if (operation === "diskUsedBytes") provider.diskUsedBytes = async (manifest) => { if (manifest.name === "demo") throw new Error("disk unreadable"); return 0 }
    await asidee.enforce()
    expect(otherChecked).toBe(true)
    const saved = await readManifest(asidee.dirs, "demo")
    expect(saved.enforcementProblem?.message).toContain("Enforcement could not be completed")
    expect(saved.enforcementProblem?.at).toMatch(/^\d{4}-/)
    const restarted = new Core([provider], asidee.dirs, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
    expect((await restarted.get("demo")).enforcementProblem).toEqual(saved.enforcementProblem)
    expect((await asidee.get("other")).enforcementProblem).toBeUndefined()
    Object.assign(provider, { [operation]: original })
    await asidee.enforce()
    expect((await asidee.get("demo")).enforcementProblem).toBeUndefined()
  }
})

test("a failure enforcement acted on is cleared once the stop succeeds, and stays only while the stop failed", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo", diskGb: 1 })
  state.overrides.config = allPass("config").map((entry) => entry.id === "network-guard" ? { ...entry, status: "fail" as const, detail: "guard missing" } : entry)
  await asidee.enforce()
  const stopped = await asidee.get("demo")
  expect(stopped).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("guard missing") })
  expect(stopped.enforcementProblem).toBeUndefined()
  expect((await readManifest(asidee.dirs, "demo")).enforcementProblem).toBeUndefined()
  delete state.overrides.config; await asidee.start("demo")
  provider.diskUsedBytes = async () => 2 * 1024 ** 3
  await asidee.enforce()
  expect(await asidee.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("disk watch"), enforcementProblem: undefined })
  // The stop failed: the sandbox still runs past its limit, and that is what stays shown.
  provider.diskUsedBytes = async () => 0; await asidee.start("demo")
  provider.diskUsedBytes = async () => 2 * 1024 ** 3; const stop = provider.stop
  provider.stop = async () => { throw new Error("stop refused") }
  await asidee.enforce()
  expect(state.running).toBe(true)
  expect((await asidee.get("demo")).enforcementProblem?.message).toMatch(/stop refused.*disk watch/)
  provider.stop = stop; provider.diskUsedBytes = async () => 0
})

test("a stale enforcement problem is cleared when the sandbox is found stopped and on an explicit start", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  provider.diskUsedBytes = async () => undefined
  await asidee.enforce()
  expect((await asidee.get("demo")).enforcementProblem?.message).toContain("Disk use could not be measured")
  // Stopped behind the daemon's back: nothing is left to enforce, so the warning goes.
  state.running = false
  await asidee.enforce()
  expect((await asidee.get("demo")).enforcementProblem).toBeUndefined()
  expect((await readManifest(asidee.dirs, "demo")).enforcementProblem).toBeUndefined()
  await asidee.start("demo"); await asidee.enforce()
  expect((await asidee.get("demo")).enforcementProblem).toBeDefined()
  // An explicit start passes its own blocking checks, so it begins without the old warning.
  await asidee.stop("demo")
  expect((await asidee.get("demo")).enforcementProblem).toBeDefined()
  await asidee.start("demo")
  expect((await asidee.get("demo")).enforcementProblem).toBeUndefined()
  const saved = await readManifest(asidee.dirs, "demo")
  expect(saved.enforcementProblem).toBeUndefined(); expect(saved.stopReason).toBeUndefined()
})

test("unmeasured disk use and exceptions consume the unknown budget, and failed stops stay visible", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  provider.diskUsedBytes = async () => undefined
  await asidee.enforce()
  expect((await asidee.get("demo")).enforcementProblem?.message).toContain("Disk use could not be measured")
  provider.checks = async () => { throw new Error("guard unreadable") }
  provider.stop = async () => { throw new Error("stop refused") }
  for (let at = 1; at < UNCHECKED_PASSES; at++) await asidee.enforce()
  expect(state.running).toBe(true)
  const view = await asidee.get("demo")
  expect(view.enforcementProblem?.message).toContain("stop refused")
  expect(view.enforcementProblem?.message).toContain("guard unreadable")
  provider.stop = async () => { state.running = false }
  await asidee.enforce()
  expect(state.running).toBe(false)
  expect((await asidee.get("demo")).stopReason).toContain("4 passes")
})

test("stopping the daemon stops the sandboxes whose disk limit only it enforces", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  expect(await asidee.stopWatched()).toEqual(["demo"])
  expect(await asidee.get("demo")).toMatchObject({ status: "stopped", stopReason: expect.stringContaining("daemon") })
})

test("extensions are declarations: bad ones are reported, field values are checked", async () => {
  const extension = parseExtension("tools", "/x", { name: "Tools", actions: [{ id: "go", label: "Go", run: ["./go.sh"], fields: [
    { id: "version", label: "Version", type: "text", default: "latest" }, { id: "mode", label: "Mode", type: "select", options: ["a", "b"], required: true }] }] })
  const action = extension.actions[0]!
  expect(fieldValues(action, { mode: "a" })).toEqual({ ASIDEE_FIELD_VERSION: "latest", ASIDEE_FIELD_MODE: "a" })
  expect(() => fieldValues(action, { mode: "c" })).toThrow(AsideeError)
  expect(() => fieldValues(action, {})).toThrow(AsideeError)
  expect(() => parseExtension("tools", "/x", { name: "Tools", actions: [{ id: "go", label: "Go", run: "rm -rf /" }] })).toThrow(AsideeError)

  const root = await mkdtemp(join(tmpdir(), "asidee-ext-"))
  await mkdir(join(root, "extensions", "good"), { recursive: true }); await mkdir(join(root, "extensions", "bad"), { recursive: true })
  await writeFile(join(root, "extensions", "good", "extension.json"), JSON.stringify({ name: "Good", actions: [] }))
  await writeFile(join(root, "extensions", "bad", "extension.json"), "{")
  const loaded = await loadExtensions({ state: root, config: root })
  expect(loaded.extensions.map((entry) => entry.id)).toEqual(["good"])
  expect(loaded.errors.length).toBe(1)
})

test("a running sandbox that cannot be checked for several passes in a row is stopped; one clear pass resets the count", async () => {
  const { provider, state } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  const blind = allPass("config").map((entry) => entry.id === "network-guard" ? { ...entry, status: "unknown" as const } : entry)
  state.overrides.config = blind
  for (let pass = 1; pass < UNCHECKED_PASSES; pass++) await asidee.enforce()
  expect(state.running).toBe(true)
  delete state.overrides.config; await asidee.enforce()
  state.overrides.config = blind
  for (let pass = 1; pass < UNCHECKED_PASSES; pass++) await asidee.enforce()
  expect(state.running).toBe(true)
  await asidee.enforce()
  expect(state.running).toBe(false)
  expect((await asidee.get("demo")).stopReason).toContain("could not check")
})

test("a config file with a mistake is refused by name, and its defaults obey the same limits as a request", async () => {
  const root = await mkdtemp(join(tmpdir(), "asidee-config-")); const dirs = { state: join(root, "state"), config: root }
  expect(await readConfig(dirs)).toEqual({ defaults: {}, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" })
  for (const bad of ['{"workspaceFreeSpaceGb":-1}', '{"diskWatchSeconds":0}', '{"diskWatchSeconds":31}', '{"diskWatchSeconds":"1"}', '{"workspaceFreeSpaceGb":"5"}', '{"workspaceFreeSpaceGb":100001}', '{"experimental":"on"}', '{"experimental":1}', "{ nope", "[]", "null", '{"defaults":"x"}', '{"engine":5}', '{"requireProbes":"off"}', '{"requireProbes":null}', '{"requireProbes":0}', '{"defaults":{"cpus":"lots"}}', '{"defaults":{"image":"--privileged"}}', '{"defaults":{"memoryGb":100000}}']) {
    await writeFile(join(root, "config.json"), bad)
    await expect(readConfig(dirs)).rejects.toThrow("config.json")
  }
  await writeFile(join(root, "config.json"), '{"defaults":{"image":"alpine:3","cpus":1,"privileged":true,"name":"x"},"engine":"gvisor:orbstack"}')
  expect(await readConfig(dirs)).toEqual({ defaults: { image: "alpine:3", cpus: 1 }, engine: "gvisor:orbstack", requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" })
})

test("a damaged state file is listed as damaged and the other sandboxes still work", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  await writeFile(join(asidee.dirs.state, "sandboxes", "broken.json"), "{ nope")
  await writeFile(join(asidee.dirs.state, "sandboxes", "other.json"), '{"name":"someone-else"}')
  const list = await asidee.list()
  expect(list.map((entry) => `${entry.name}:${entry.status}`)).toEqual(["demo:running", "broken:damaged", "other:damaged"])
  expect(list[1]!.stopReason).toContain("broken.json")
  await asidee.enforce()
  expect((await asidee.verify("demo")).ok).toBe(true)
})

test("a setup hook runs after the sandbox is free, so it can call back into it", async () => {
  const { provider } = fakeProvider()
  const root = await mkdtemp(join(tmpdir(), "asidee-hook-")); const dirs = { state: join(root, "state"), config: join(root, "config") }
  await mkdir(join(dirs.config, "extensions", "setup"), { recursive: true })
  await writeFile(join(dirs.config, "extensions", "setup", "extension.json"), JSON.stringify({ name: "Setup", hooks: { postCreate: ["./setup.sh"] } }))
  let asidee: Core
  // The hook's command stands in for a script that runs `asd verify` on the new sandbox.
  asidee = new Core([provider], dirs, async (_argv, options) => ({ exitCode: 0, stdout: String((await asidee.verify(options!.env!.ASIDEE_SANDBOX!)).ok), stderr: "" }), "/nowhere")
  const made = await Promise.race([asidee.create({ name: "demo" }), Bun.sleep(2000).then(() => "stuck" as const)])
  expect(made).not.toBe("stuck")
  expect((made as Awaited<ReturnType<Core["create"]>>).hooks).toEqual([{ extension: "setup", exitCode: 0, output: "true" }])
})

test("a session is refused on a stopped sandbox without starting it, and ends when its sandbox stops or goes", async () => {
  const { provider, state } = fakeProvider(); const closed: string[] = []
  provider.openExec = async () => ({ tty: false, write: () => true, end: () => {}, resize: async () => {}, pause: () => {}, resume: () => {}, close: (reason?: string) => { closed.push(reason ?? "") }, on: () => {} }) as never
  const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  await asidee.stop("demo")
  const starts = state.starts
  await expect(asidee.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })).rejects.toMatchObject({ code: "conflict" })
  expect(state.starts).toBe(starts); expect(state.running).toBe(false)
  await asidee.start("demo")
  await asidee.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })
  await asidee.stop("demo")
  expect(closed).toEqual(["The session ended: demo was stopped."])
  await asidee.start("demo"); await asidee.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })
  await asidee.remove("demo", "demo")
  expect(closed[1]).toBe("The session ended: demo was removed.")
})

test("a forward listens on loopback for one run of its sandbox and ends with it", async () => {
  const { provider, state } = fakeProvider()
  const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  const reachable = (port: number) => new Promise<boolean>((resolve) => { const socket = connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true) }); socket.on("error", () => resolve(false)) })
  const made = await asidee.forwardAdd("demo", "8080")
  expect(made).toMatchObject({ name: "demo", port: 8080, localAddress: "127.0.0.1", generation: "run-1" })
  expect(await reachable(made.localPort)).toBe(true)
  const disclosed = (await asidee.verify("demo")).checks.find((check) => check.id === "forwards")!
  expect(disclosed.status).toBe("info"); expect(disclosed.detail).toContain(`127.0.0.1:${made.localPort} to port 8080 (${made.id})`)
  await expect(asidee.forwardAdd("demo", 8080, made.localPort)).rejects.toMatchObject({ code: "conflict" })
  await asidee.stop("demo")
  expect(asidee.forwardList()).toEqual([]); expect(await reachable(made.localPort)).toBe(false)
  await expect(asidee.forwardAdd("demo", 8080)).rejects.toMatchObject({ code: "conflict" })
  // A run the forward was not made for (the engine restarted it) ends the forward at the next connection.
  await asidee.start("demo")
  const again = await asidee.forwardAdd("demo", 8080)
  state.starts++
  await reachable(again.localPort); await Bun.sleep(50)
  expect(asidee.forwardList("demo")).toEqual([])
  const removed = await asidee.forwardAdd("demo", 9000)
  expect(asidee.forwardRemove(removed.id)).toEqual({ closed: removed.id })
  expect(() => asidee.forwardRemove(removed.id)).toThrow(AsideeError)
  const last = await asidee.forwardAdd("demo", 9000)
  await asidee.remove("demo", "demo")
  expect(await reachable(last.localPort)).toBe(false)
  for (const bad of [0, 70_000, "x"]) await expect(asidee.forwardAdd("demo", bad)).rejects.toMatchObject({ code: "usage" })
})

test("resize refuses what it cannot do safely, and says when each limit applies", async () => {
  const { provider, state } = fakeProvider()
  const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  await expect(asidee.resize("ghost", { memoryGb: 8 })).rejects.toMatchObject({ code: "not-found" })
  await expect(asidee.resize("demo", {})).rejects.toMatchObject({ code: "usage" })
  await expect(asidee.resize("demo", { memoryGb: 0.1 })).rejects.toMatchObject({ code: "usage" })
  await expect(asidee.resize("demo", { pids: 10 })).rejects.toMatchObject({ code: "usage" })
  // Running, using 3 GiB: lowering memory to 3 GB leaves no headroom; nothing changes.
  state.use = { memoryBytes: 3 * 1024 ** 3, tasks: 100 }
  await expect(asidee.resize("demo", { memoryGb: 3 })).rejects.toMatchObject({ code: "conflict" })
  expect(state.resized).toBeUndefined()
  expect((await asidee.get("demo")).spec.memoryGb).toBe(4)
  state.use = { memoryBytes: 3 * 1024 ** 3, tasks: 3000 }
  await expect(asidee.resize("demo", { pids: 3000 })).rejects.toMatchObject({ code: "conflict" })
  state.use = undefined
  await expect(asidee.resize("demo", { memoryGb: 2 })).rejects.toMatchObject({ code: "conflict" })
  // Raising needs no reading. The engine's host confirms memory, not CPUs.
  state.live = { cpus: 2, memoryGb: 8, pids: 4096 }
  const raised = await asidee.resize("demo", { memoryGb: 8, cpus: 3 })
  expect(raised.changes.map((change) => [change.limit, change.applies])).toEqual([["cpus", "next start"], ["memoryGb", "now"], ["pids", "unchanged"], ["diskGb", "unchanged"]])
  expect(state.resized).toEqual({ cpus: 3, memoryGb: 8, pids: 4096, diskGb: 20 } as Limits)
  expect((await asidee.get("demo")).spec).toMatchObject({ cpus: 3, memoryGb: 8 })
  expect(raised.checks.map((check) => check.id)).toContain("limits")
  // Stopped: everything waits for the next start, and lowering needs no reading.
  await asidee.stop("demo")
  const lowered = await asidee.resize("demo", { memoryGb: 1, diskGb: 10 })
  expect(lowered.changes.find((change) => change.limit === "memoryGb")!.applies).toBe("next start")
  expect(lowered.changes.find((change) => change.limit === "diskGb")!.applies).toBe("now")
})

test("a sandbox made from a template records it and runs its image; removing the template says who still uses it", async () => {
  const { provider, state } = fakeProvider()
  const asidee = await core(provider)
  await expect(asidee.create({ name: "copy", template: "base" })).rejects.toMatchObject({ code: "not-found" })
  expect(await asidee.list()).toEqual([])
  await asidee.create({ name: "src" })
  await expect(asidee.snapshot("src", "Bad Name")).rejects.toMatchObject({ code: "usage" })
  await expect(asidee.snapshot("ghost", "base")).rejects.toMatchObject({ code: "not-found" })
  const saved = await asidee.snapshot("src", "base")
  expect(saved.contents).toContain("home folders included")
  const made = await asidee.create({ name: "copy", template: "base" })
  expect(made.sandbox.template).toMatchObject({ name: "base", imageId: "sha256:base", source: "src" })
  expect(state.created.at(-1)!.spec.image).toBe("sha256:base")
  expect(await asidee.templateList()).toHaveLength(1)
  state.templates[0]!.dependants = ["copy"]
  const removed = await asidee.templateRemove("base")
  expect(removed).toMatchObject({ removed: "base", dependants: ["copy"] })
  expect(removed.note).toContain("keep working")
  await expect(asidee.templateRemove("base")).rejects.toMatchObject({ code: "not-found" })
})

test("create requires unknown blocking probes by default and keeps only a stopped sandbox for diagnosis", async () => {
  const probes = allPass("probe").map((check): CheckResult => check.id === "net-host" || check.id === "net-peers"
    ? { ...check, status: "unknown", evidence: "none", detail: `${check.id}: the helper control did not answer.` } : check)
  const { provider, state } = fakeProvider({ probe: probes }); const asidee = await core(provider)
  expect((await asidee.configGet()).requireProbes).toBe(true)
  await expect(asidee.create({ name: "demo", requireProbes: false })).rejects.toMatchObject({ code: "probes-required", details: probes.filter((check) => check.status === "unknown"),
    message: expect.stringContaining("asd config set require-probes off") })
  expect(state).toMatchObject({ starts: 1, stops: 1, running: false, exists: true })
  const saved = await readManifest(asidee.dirs, "demo")
  expect(saved.lastVerify?.results.filter((check) => check.status === "unknown")).toEqual(probes.filter((check) => check.status === "unknown"))
  expect(saved.stopReason).toContain("Cannot reach the host; Cannot reach other sandboxes")
  expect((await asidee.list())[0]?.status).toBe("stopped")
})

test("turning the requirement off permits unknown probes without inventing a pass; verify and start keep running", async () => {
  const { provider, state } = fakeProvider({ probe: [] }); const asidee = await core(provider)
  await asidee.configSet({ requireProbes: false })
  const made = await asidee.create({ name: "demo" })
  expect(state.running).toBe(true)
  const unknown = made.checks.filter((check) => check.status === "unknown")
  // The core answers link-scope itself: with no links it is a disclosure, not an unknown.
  expect(unknown.map((check) => check.id)).toEqual(CHECKLIST.filter((item) => item.stage === "probe" && item.id !== "link-scope").map((item) => item.id))
  expect(made.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "info", evidence: "none" })
  expect(unknown.every((check) => check.evidence === "none")).toBe(true)
  expect((await asidee.list())[0]?.lastVerify?.results.find((check) => check.id === "net-host")?.detail).toContain("unknown (none)")
  await asidee.configSet({ requireProbes: true })
  const verified = await asidee.verify("demo")
  expect(verified.ok).toBe(true); expect(verified.sandbox.status).toBe("running")
  expect(verified.checks.filter((check) => check.status === "unknown")).toEqual(unknown)
  await asidee.stop("demo")
  const checks = provider.checks
  provider.checks = async (manifest, stage) => { if (stage === "probe") throw new Error("start must not probe"); return checks(manifest, stage) }
  expect((await asidee.start("demo")).status).toBe("running")
  await asidee.enforce()
  expect(state.running).toBe(true)
})

test("failed and unsupported blocking probes stop creation in both modes; nonblocking unknown probes never block", async () => {
  for (const requireProbes of [true, false]) {
    for (const status of ["fail", "unsupported"] as const) {
      const probes = allPass("probe").map((check): CheckResult => check.id === "net-host" ? { ...check, status, detail: "Isolation was not provided." } : check)
      const { provider, state } = fakeProvider({ probe: probes }); const asidee = await core(provider)
      await asidee.configSet({ requireProbes })
      await expect(asidee.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed", message: expect.stringContaining("Cannot reach the host (Isolation was not provided.)") })
      expect(state).toMatchObject({ starts: 1, stops: 1, running: false, exists: true })
      // A failure beside an unknown probe is a failed check: turning the requirement off would not let it through.
      const mixed = probes.map((check): CheckResult => check.id === "net-peers" ? { ...check, status: "unknown", evidence: "none", detail: "The control did not answer." } : check)
      const other = await core(fakeProvider({ probe: mixed }).provider); await other.configSet({ requireProbes })
      await expect(other.create({ name: "demo" })).rejects.toMatchObject({ code: "check-failed" })
    }
    const { provider } = fakeProvider({ probe: allPass("probe").filter((check) => check.id !== "egress" && check.id !== "credentials") })
    const asidee = await core(provider); await asidee.configSet({ requireProbes })
    const made = await asidee.create({ name: "demo" })
    expect(made.sandbox.status).toBe("running")
    expect(made.checks.find((check) => check.id === "egress")?.status).toBe("unknown")
  }
})

test("settings persist across core and daemon instances, preserve other config and take effect without restart", async () => {
  const { provider, state } = fakeProvider({ probe: [] }); const asidee = await core(provider)
  await mkdir(asidee.dirs.config, { recursive: true })
  const file = join(asidee.dirs.config, "config.json")
  const existing = { defaults: { cpus: 1, image: "alpine" }, engine: "fake:1", future: { keep: true } }
  await writeFile(file, JSON.stringify(existing))
  const table = methods(asidee, () => {})
  expect(await table.configSet!.run({ requireProbes: false })).toMatchObject({ requireProbes: false, defaults: existing.defaults, engine: "fake:1" })
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...existing, requireProbes: false })
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  const restarted = new Core([provider], asidee.dirs, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
  expect(await methods(restarted, () => {}).configGet!.run({})).toMatchObject({ requireProbes: false })
  expect((await restarted.create({ name: "demo" })).sandbox.status).toBe("running")
  await table.configSet!.run({ requireProbes: true })
  await expect(restarted.create({ name: "other" })).rejects.toMatchObject({ code: "probes-required" })
  expect(await table.configSet!.run({ experimental: true })).toMatchObject({ requireProbes: true, experimental: true })
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ...existing, requireProbes: true, experimental: true })
  expect(await table.configSet!.run({ workspaceFreeSpaceGb: 12.5 })).toMatchObject({ workspaceFreeSpaceGb: 12.5 })
  expect(await table.configSet!.run({ diskWatchSeconds: 1 })).toMatchObject({ diskWatchSeconds: 1, workspaceFreeSpaceGb: 12.5 })
  expect(await methods(restarted, () => {}).configGet!.run({})).toMatchObject({ workspaceFreeSpaceGb: 12.5 })
  expect(state.running).toBe(false)
})

test("settings require a boolean and loopback writes require both token and trusted Host", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  const asked: string[] = []
  const answer = createHandler(methods(asidee, () => {}), "secret", asidee.dirs.config, undefined, async (approval) => { asked.push(approval.cli); return "deny" })
  const post = (body: object, headers: Record<string, string> = {}) => new Request("http://127.0.0.1:7717/api/configSet", { method: "POST", headers: { host: "127.0.0.1:7717", authorization: "Bearer secret", ...headers }, body: JSON.stringify(body) })
  for (const value of ["off", 0, null, [], {}, undefined]) {
    expect((await answer(post({ requireProbes: value }), false, 7717)).status).toBe(400)
  }
  // A custom terminal command runs on the Mac, so a page with the token cannot set it beside another setting, and alone
  // only when the person at the Mac allows it.
  for (const body of [{ requireProbes: false, terminalCommand: "sh -c {command}" }, { terminalCommand: "sh -c {command}" }, { terminal: "custom" }, { terminal: "xterm" }, { engine: "Bad Engine" }, { engine: 5 },
    { defaults: { privileged: true } }, { defaults: { cpus: "lots" } }, { defaults: { image: "--privileged" } }, { defaults: [] }]) expect((await answer(post(body), false, 7717)).status).toBe(400)
  const viaPage = await answer(new Request("http://127.0.0.1:7717/api/terminalCommandSet", { method: "POST", headers: { host: "127.0.0.1:7717", authorization: "Bearer secret" }, body: JSON.stringify({ terminalCommand: "sh -c {command}" }) }), false, 7717)
  expect([viaPage.status, (await viaPage.json() as any).error.details]).toEqual([403, { approval: "denied", command: "asd config set terminal-command 'sh -c {command}'" }])
  expect(asked).toEqual(["asd config set terminal-command 'sh -c {command}'"])
  expect((await asidee.configGet()).terminalCommand).toBeUndefined()
  for (const value of ["on", 1, null]) expect((await answer(post({ experimental: value }), false, 7717)).status).toBe(400)
  for (const value of ["5", -1, 100_001, null, true]) expect((await answer(post({ workspaceFreeSpaceGb: value }), false, 7717)).status).toBe(400)
  for (const value of ["1", 0, 0.5, 31, null, true]) expect((await answer(post({ diskWatchSeconds: value }), false, 7717)).status).toBe(400)
  expect((await answer(post({}), false, 7717)).status).toBe(400)
  expect((await answer(post({ requireProbes: false }, { authorization: "" }), false, 7717)).status).toBe(401)
  expect((await answer(post({ requireProbes: false }, { authorization: "Bearer wrong" }), false, 7717)).status).toBe(401)
  expect((await answer(post({ requireProbes: false }, { host: "evil.example:7717" }), false, 7717)).status).toBe(403)
  expect((await asidee.configGet()).requireProbes).toBe(true)
  const response = await answer(post({ requireProbes: false }), false, 7717)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, data: { requireProbes: false } })
  expect((await asidee.configGet()).requireProbes).toBe(false)
  expect(await (await answer(post({ defaults: { cpus: 1, docker: true }, engine: "fake:1", terminal: "ghostty" }), false, 7717)).json()).toMatchObject({ ok: true, data: { defaults: { cpus: 1, docker: true }, engine: "fake:1", terminal: "ghostty" } })
  expect(await (await answer(post({ defaults: null, engine: null }), false, 7717)).json()).toMatchObject({ ok: true, data: { defaults: {}, terminal: "ghostty" } })
  expect((await asidee.configGet()).engine).toBeUndefined()
  // Over the socket the CLI can set it; setting it chooses it, and clearing it goes back to the default terminal.
  const viaSocket = (body: object) => answer(new Request("http://asidee/api/terminalCommandSet", { method: "POST", body: JSON.stringify(body) }), true, 0).then((response) => response.json())
  expect(await viaSocket({ terminalCommand: "two\nlines {command}" })).toMatchObject({ ok: false })
  expect(await viaSocket({ terminalCommand: "no placeholder" })).toMatchObject({ ok: false })
  expect(await viaSocket({ terminalCommand: "kitty sh -c {command}" })).toMatchObject({ ok: true, data: { terminal: "custom", terminalCommand: "kitty sh -c {command}" } })
  expect(await viaSocket({ terminalCommand: null })).toMatchObject({ ok: true, data: { terminal: "default" } })
  expect((await asidee.configGet()).terminalCommand).toBeUndefined()
})

test("routed create preserves the remote refusal text and code and uses only the remote probe setting", async () => {
  const fake = fakeProvider({ probe: [] }); const target = await core(fake.provider)
  const remote = new Core([fake.provider], target.dirs, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere", "d".repeat(32))
  const local = await core(fakeProvider().provider)
  await local.configSet({ requireProbes: false, experimental: true })
  const hello: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "e".repeat(64), version: "0.4.0", protocols: [1], features: [], methods: Object.keys(CATALOG) }
  const remoteHello = { ...hello, machineId: remote.machineId }
  const remoteHandle = createHandler({ ...methods(remote, () => {}), hello: { run: async () => remoteHello } }, "remote-token", remote.dirs.config)
  const machines = new Machines(local.dirs, hello, async () => ({ hello, sandboxes: [], checkedAt: new Date().toISOString() }), { connectPeer: () => ({ close: async () => {}, call: async (method, body = {}) =>
    parseReply(await (await remoteHandle(new Request(`http://asidee/api/${method}`, { method: "POST", body: JSON.stringify(body) }), true, 0)).json()) }) })
  await writeFile(join(local.dirs.config, "hosts.json"), JSON.stringify({ version: 1, hosts: [{ name: "build", ssh: "fixture", binary: "/fixture/asd", stateDir: "/fixture/state", machineId: remote.machineId, addedAt: "2026-11-15", diskPolicy: "watched", service: "prepared" }] }))
  const localHandle = createHandler(methods(local, () => {}, () => false, machines), "local-token", local.dirs.config, machines)
  const request = (host?: string) => new Request("http://asidee/api/create", { method: "POST", body: JSON.stringify({ name: "demo", host }) })
  const direct = await (await remoteHandle(request(), true, 0)).json()
  expect(direct).toMatchObject({ ok: false, error: { code: "probes-required" } })
  if (!object(direct) || !object(direct.error) || typeof direct.error.message !== "string") throw new Error("The refusal has no message.")
  expect(direct.error.message).toContain("Cannot reach the host (The provider did not report this check.)")
  expect(direct.error.message).toContain("Cannot reach other sandboxes (The provider did not report this check.)")
  await remote.remove("demo", "demo")
  const routed = await localHandle(request("build"), true, 0)
  expect(routed.status).toBe(422)
  expect(await routed.json()).toEqual(direct)
  expect(fake.state.running).toBe(false)
  expect((await local.list()).length).toBe(0)
  expect(await machines.route("configGet", { host: "build" })).toMatchObject({ requireProbes: true })
  await machines.route("configSet", { host: "build", requireProbes: false })
  await local.configSet({ requireProbes: true })
  await remote.remove("demo", "demo")
  expect(await (await localHandle(request("build"), true, 0)).json()).toMatchObject({ ok: true, data: { sandbox: { status: "running" } } })
  expect((await local.configGet()).requireProbes).toBe(true)
  expect((await remote.configGet()).requireProbes).toBe(false)
  await machines.close()
})

test("a create that fails before a container exists removes its record and permits retry", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  const create = provider.create
  provider.create = async () => { throw new Error("pull access denied") }
  await expect(asidee.create({ name: "demo" })).rejects.toThrow("Nothing was kept")
  expect(await asidee.list()).toEqual([])
  provider.create = create
  expect((await asidee.create({ name: "demo" })).sandbox.status).toBe("running")
})

test("a failed create whose cleanup fails keeps its record and names the removal command", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  provider.create = async () => { throw new Error("pull access denied") }
  provider.remove = async () => { throw new Error("network asidee-net-demo remains; engine unavailable") }
  await expect(asidee.create({ name: "demo" })).rejects.toThrow("asd remove demo --confirm demo")
  expect((await asidee.list())[0]?.status).toBe("missing")
})

test("starting above a watched disk limit reports current use without retaining a stale stop reason", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo", diskGb: 1 })
  await asidee.stop("demo")
  expect(await asidee.start("demo")).not.toHaveProperty("diskWarning")
  provider.diskUsedBytes = async () => 1.3 * 1024 ** 3
  await asidee.enforce()
  expect((await asidee.get("demo")).stopReason).toContain("disk watch")
  expect(await asidee.start("demo")).toMatchObject({ status: "running", stopReason: undefined,
    diskWarning: { usedBytes: 1.3 * 1024 ** 3, limitBytes: 1024 ** 3, message: expect.stringContaining("asd resize demo --disk N") } })
  // It is given the 30 seconds the warning names, whenever the next pass falls.
  await asidee.enforce()
  expect(await asidee.get("demo")).toMatchObject({ status: "running", enforcementProblem: undefined })
  asidee.diskRecoveryMs = 0
  await asidee.enforce()
  expect((await asidee.get("demo")).status).toBe("stopped")
})

test("the limits check counts one CPU in the singular, and the template check does not claim the credentials check sees every secret", () => {
  const limits = (cpus: number) => configChecks(inspect((value) => { value.HostConfig.NanoCpus = cpus * 1e9 }), { ...manifest, spec: { ...manifest.spec, cpus } }, "intact", "asd123").find((entry) => entry.id === "limits")!.detail
  expect(limits(1)).toContain(" 1 CPU. ")
  expect(limits(2)).toContain(" 2 CPUs. ")
  const templated: Manifest = { ...manifest, template: { name: "base", imageId: "sha256:t", source: "src", createdAt: "2026-11-11T00:00:00Z" } }
  const detail = configChecks(inspect((value) => { (value as any).Image = "sha256:t" }), templated, "intact", "asd123", undefined, { Id: "sha256:t", RepoTags: ["asidee-template-own:base"], Config: { Labels: {} } }, "own").find((entry) => entry.id === "template")!.detail
  expect(detail).not.toContain("the credentials check says what is inside")
  expect(detail).toContain("other secrets saved in it (.env files, shell history, tokens) are not looked for")
})

test("a refused removal and a command on a stopped sandbox name the command to run", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" })
  await expect(asidee.remove("demo", undefined)).rejects.toThrow("Removing demo deletes everything in it. To confirm: `asd remove demo --confirm demo`.")
  await expect(asidee.remove("demo", "other")).rejects.toThrow("--confirm other does not match demo; nothing was removed.")
  await asidee.remove("demo", "demo")
  const stopped = new GvisorProvider(async () => ({ exitCode: 1, stdout: "", stderr: "Error: No such object: asidee-demo" }))
  for (const attempt of [() => stopped.exec(manifest, ["true"]), () => stopped.openExec(manifest, ["true"], { tty: false }), () => stopped.prepareLoopback(manifest)])
    await expect(attempt()).rejects.toThrow("demo is not running. Start it with `asd start demo`.")
})


test("stopped verification reports configuration scope and succeeds if that configuration holds", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo" }); await asidee.stop("demo")
  expect(await asidee.verify("demo")).toMatchObject({ ok: true, configurationOnly: true })
})

test("B13: failed-create cleanup preserves the image dependency code without doubled punctuation", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  provider.create = async () => { throw new AsideeError("dependency", "Cannot download image bad/image:0: pull access denied.") }
  await expect(asidee.create({ name: "demo" })).rejects.toMatchObject({ code: "dependency", message: "Cannot download image bad/image:0: pull access denied. Nothing was kept for demo." })
})

test("usage gives each sandbox's CPU share between two calls, memory and tasks against its limits, and its last disk measurement", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  await asidee.create({ name: "demo", cpus: 2, memoryGb: 1, diskGb: 10 })
  let cpuNs = 5e9
  provider.usage = async () => ({ memoryBytes: 300 * 1024 ** 2, tasks: 12, cpuNs })
  provider.diskUsedBytes = async () => 3 * 1024 ** 3
  const [first] = await asidee.usage()
  expect(first).toMatchObject({ name: "demo", running: true, cpus: 2, memoryBytes: 300 * 1024 ** 2, memoryLimitBytes: 1024 ** 3, tasks: 12, diskLimitBytes: 10 * 1024 ** 3 })
  expect(first!.cpuPercent).toBeUndefined()
  await asidee.verify("demo")
  await Bun.sleep(100); cpuNs += 1e8
  const [second] = await asidee.usage()
  // 0.1 s of CPU in about 0.1 s: about one CPU busy.
  expect(second!.cpuPercent).toBeGreaterThan(50); expect(second!.cpuPercent).toBeLessThanOrEqual(101)
  expect(second).toMatchObject({ diskBytes: 3 * 1024 ** 3 })
  expect(Date.parse(second!.diskMeasuredAt!)).toBeGreaterThan(Date.now() - 10_000)
  provider.usage = async () => undefined
  const [stopped] = await asidee.usage()
  expect(stopped).toMatchObject({ running: false, diskBytes: 3 * 1024 ** 3 }); expect(stopped!.memoryBytes).toBeUndefined()
  provider.usage = async () => { throw new Error("engine away") }
  expect((await asidee.usage())[0]).toMatchObject({ running: false, problem: "engine away" })
  await asidee.stop("demo"); await asidee.remove("demo", "demo")
  expect(await asidee.usage()).toEqual([])
})

test("exactly the listed methods ask on the Mac; the rest stay socket-only and are refused without asking", async () => {
  const { provider } = fakeProvider(); const asidee = await core(provider)
  const table = methods(asidee, () => {})
  const approvable = Object.keys(table).filter((name) => table[name]!.approve).sort()
  expect(approvable).toEqual(["hostAttach", "hostRemove", "shutdown", "sshSetup", "terminalCommandSet", "workspaceCreate", "workspaceExec", "workspaceRemove", "workspaceSet", "workspaceStop"])
  for (const [name, [access]] of Object.entries(CATALOG)) expect([name, access === "approve"]).toEqual([name, Boolean(table[name]?.approve)])
  const asked: string[] = []
  const answer = createHandler(table, "secret", asidee.dirs.config, undefined, async (approval) => { asked.push(approval.cli); return "allow" })
  const viaPage = (method: string, body: object = {}) => answer(new Request(`http://127.0.0.1:7717/api/${method}`, { method: "POST", headers: { host: "127.0.0.1:7717", authorization: "Bearer secret" }, body: JSON.stringify(body) }), false, 7717)
  for (const method of ["hello", "sessionTarget", "sshPrepare", "hostPlan", "hostApply", "workspaceShell"]) {
    expect([method, table[method]!.approve, (await viaPage(method, { name: "demo" })).status]).toEqual([method, undefined, 403])
  }
  // Clearing the terminal command and setting up SSH without touching ~/.ssh/config need no dialog.
  expect((await viaPage("terminalCommandSet", { terminalCommand: null })).status).toBe(200)
  expect(await table.sshSetup!.approve!({ name: "demo" })).toBeUndefined()
  // Approval cannot widen a request: the dashboard's shutdown takes no options, and extra keys are refused before asking.
  expect((await viaPage("shutdown", { keepSandboxes: true })).status).toBe(400)
  expect((await viaPage("workspaceStop", { name: "demo", force: true })).status).toBe(400)
  expect(asked).toEqual([])
  // A run's input is shown in full, since to an interpreter it is the program; input that is not text is not asked.
  const run = await table.workspaceExec!.approve!({ name: "demo", argv: ["bash"], stdinBase64: Buffer.from("rm -rf ~\n").toString("base64") })
  expect(run).toMatchObject({ details: ['"bash"', "With this input:", '"rm -rf ~\\n"'], cli: "asd workspace exec demo --stdin -- bash" })
  expect(() => table.workspaceExec!.approve!({ name: "demo", argv: ["bash"], stdinBase64: Buffer.from([0xff, 0xfe]).toString("base64") })).toThrow("text input only")
})
