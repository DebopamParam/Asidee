import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { connect } from "node:net"
import { join } from "node:path"
import { blockers, CHECKLIST, complete } from "../../core/checks"
import { Core, UNCHECKED_PASSES } from "../../core/core"
import { DockerSandboxesProvider } from "../../core/providers/docker-sandboxes"
import { fieldValues, loadExtensions, parseExtension } from "../../core/extensions"
import { configChecks, DOCKER_CAPABILITIES, dockerVolume, gvisorSetup, network, unsafeRuntimeArgs, type GuardState } from "../../core/providers/gvisor"
import { OUTPUT_LIMIT, systemRunner } from "../../core/run"
import { readConfig, validSizes, validSpec, validTemplateName } from "../../core/state"
import { PaddockError, type CheckResult, type Engine, type Limits, type Manifest, type Provider, type Stage, type Template } from "../../core/types"

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
    openExec: async () => { throw new PaddockError("dependency", "no sessions in the fake") },
    generation: async () => state.running ? `run-${state.starts}` : undefined,
    prepareLoopback: async () => {},
    dialLoopback: async () => { throw new PaddockError("dependency", "no sessions in the fake") },
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
  const root = await mkdtemp(join(tmpdir(), "paddock-test-"))
  return new Core([provider], { state: join(root, "state"), config: join(root, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("a check the provider does not report is unknown, never a pass", () => {
  const results = complete([pass("hardening")], ["config"])
  expect(results.map((entry) => entry.id)).toEqual(["hardening", "mounts", "network-guard", "inbound", "forwards", "ssh", "limits", "disk", "template"])
  expect(results.find((entry) => entry.id === "mounts")!.status).toBe("unknown")
  expect(blockers(results).map((entry) => entry.id)).toEqual(["mounts", "network-guard", "inbound", "limits"])
})

test("remote relay leases require the current sandbox and run and are revoked on stop", async () => {
  const { provider, state } = fakeProvider(); const paddock = await core(provider)
  const made = await paddock.create({ name: "demo" }); const target = await paddock.sessionTarget("demo")
  expect(made.sandbox.sandboxId).toBe(target.sandboxId)
  const lease = { kind: "lease" as const, ...target, port: 3000, leaseId: "a".repeat(32) }
  await expect(paddock.openSession({ ...lease, sandboxId: "b".repeat(32) })).rejects.toThrow("recreated")
  await expect(paddock.openSession({ ...lease, generation: "old" })).rejects.toThrow("run changed")
  const control = await paddock.openSession(lease); let ended = ""
  control.on("end", (exit) => { ended = exit.error ?? "" })
  const checks = (await paddock.verify("demo")).checks
  expect(checks.find((check) => check.id === "forwards")?.detail).toContain("SSH lease")
  await expect(paddock.openSession({ ...lease, kind: "dial", port: 3001 })).rejects.toThrow("no longer open")
  await expect(paddock.openSession({ ...lease, kind: "dial", leaseId: "b".repeat(32) })).rejects.toThrow("no longer open")
  await paddock.stop("demo")
  expect(ended).toContain("stopped")
  expect(state.running).toBe(false)
  await paddock.start("demo")
  await expect(paddock.openSession({ ...lease, kind: "dial" })).rejects.toThrow("run changed")
})

test("a remote lease ends on its own when the primary stops renewing it, and lasts while it renews", async () => {
  const { provider } = fakeProvider(); const paddock = await core(provider); paddock.leaseTtlMs = 200
  await paddock.create({ name: "demo" }); const target = await paddock.sessionTarget("demo")
  const lease = { kind: "lease" as const, ...target, port: 3000, leaseId: "a".repeat(32) }
  const renewed = await paddock.openSession(lease); let renewedEnd = ""
  renewed.on("end", (exit) => { renewedEnd = exit.error ?? "ended" })
  const timer = setInterval(() => renewed.write(new Uint8Array([1])), 50)
  const silent = await paddock.openSession({ ...lease, leaseId: "b".repeat(32) }); let silentEnd = ""
  silent.on("end", (exit) => { silentEnd = exit.error ?? "ended" })
  await Bun.sleep(600); clearInterval(timer)
  expect(silentEnd).toContain("did not renew")
  expect(renewedEnd).toBe("")
  await Bun.sleep(400)
  expect(renewedEnd).toContain("did not renew")
})

test("a failed blocking check blocks; an unknown probe and a weak disk limit do not", () => {
  const results: CheckResult[] = [
    { id: "net-host", status: "unknown", evidence: "none", detail: "" }, { id: "net-peers", status: "fail", evidence: "probed", detail: "" },
    { id: "disk", status: "weak", evidence: "inspected", detail: "" }, { id: "egress", status: "info", evidence: "probed", detail: "" },
  ]
  expect(blockers(results).map((entry) => entry.id)).toEqual(["net-peers"])
})

test("unsupported blocking properties refuse creation and name the missing promise", async () => {
  for (const id of ["network-guard", "kernel", "net-host"] as const) {
    const stage = CHECKLIST.find((item) => item.id === id)!.stage
    const results = allPass(stage).map((entry): CheckResult => entry.id === id ? { ...entry, status: "unsupported", detail: "Engine cannot provide this." } : entry)
    expect(blockers(results).map((entry) => entry.id)).toEqual([id])
    const { provider, state } = fakeProvider({ [stage]: results }); const paddock = await core(provider)
    await expect(paddock.create({ name: "demo" })).rejects.toThrow(CHECKLIST.find((item) => item.id === id)!.title)
    expect(state.running).toBe(false)
  }
  expect(blockers([{ id: "disk", status: "unsupported", evidence: "none", detail: "No disk cap." }])).toEqual([])
})

test("Docker Sandboxes is detection-only and refuses create without touching an engine", async () => {
  const calls: string[][] = []
  const provider = new DockerSandboxesProvider(async (argv) => { calls.push([...argv]); return { exitCode: 0, stdout: "1.0", stderr: "" } })
  const paddock = await core(provider)
  expect((await provider.detect())[0]?.ready).toBe(false)
  await expect(paddock.create({ name: "demo", engine: "docker-sandboxes" })).rejects.toThrow("does not support Docker Sandboxes yet")
  expect(calls.every((argv) => argv.join(" ") === "sbx version")).toBe(true)
  expect(await paddock.list()).toEqual([])
})

test("a spec keeps only known fields and refuses option-like images", () => {
  const spec = validSpec({ name: "demo", cpus: "3", privileged: true, mounts: ["/:/host"], runtime: "runc" })
  expect(spec).toEqual({ name: "demo", image: "docker/sandbox-templates:shell-docker", cpus: 3, memoryGb: 4, pids: 4096, diskGb: 20, docker: false })
  expect(() => validSpec({ name: "demo", image: "--privileged" })).toThrow(PaddockError)
  expect(() => validSpec({ name: "../x" })).toThrow(PaddockError)
  expect(() => validSpec({ name: "demo", memoryGb: 0 })).toThrow(PaddockError)
})

test("create and resize share one range for each size, and resize keeps what is not given", () => {
  const base = { cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 }
  expect(validSizes({}, base)).toEqual(base)
  expect(validSizes({ memoryGb: "8", pids: "100.4" }, base)).toEqual({ ...base, memoryGb: 8, pids: 100 })
  for (const input of [{ cpus: 0.2 }, { memoryGb: 0.2 }, { pids: 63 }, { diskGb: 0.5 }, { cpus: 65 }, { memoryGb: "lots" }, { pids: "-1" }])
    expect(() => validSizes(input, base)).toThrow(PaddockError)
})

test("a template is named like a sandbox, and its images are reached only by that name", () => {
  expect(validTemplateName("base-1")).toBe("base-1")
  for (const name of ["", "-x", "Base", "a/b", "a:b", "x".repeat(32), 3]) expect(() => validTemplateName(name)).toThrow("template name")
  expect(validSpec({ name: "demo", template: "base" })).toMatchObject({ template: "base" })
  expect(() => validSpec({ name: "demo", template: "base", image: "ubuntu:24.04" })).toThrow("not both")
  expect(() => validSpec({ name: "demo", template: "../x" })).toThrow(PaddockError)
  for (const image of ["paddock-template-abc:base", "paddock-snapshot-abc:1"]) expect(() => validSpec({ name: "demo", image })).toThrow("--template")
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
  const paddock = await core(provider)
  await expect(paddock.create({ name: "demo", docker: true })).rejects.toMatchObject({ code: "dependency" })
  expect(state.exists).toBe(false)
  expect(await paddock.list()).toEqual([])
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
  // Set, but not to what the spec says: changed behind Paddock's back, or a resize the manifest does not know of.
  expect(failing(inspect((value) => { value.HostConfig.Memory = value.HostConfig.MemorySwap = 8 * 1024 ** 3 }))).toEqual(["limits"])
  expect(failing(inspect((value) => { value.HostConfig.PidsLimit = 8192 }))).toEqual(["limits"])
  expect(failing(inspect((value) => { value.HostConfig.NanoCpus = 3e9 }))).toEqual(["limits"])
})

test("the template check says what a sandbox was made from, and fails when the engine runs something else", () => {
  const image = (labels: Record<string, string> = {}, tags = ["paddock-template-own:base"]) => ({ Id: "sha256:t", RepoTags: tags, Config: { Labels: labels } })
  const templated: Manifest = { ...manifest, template: { name: "base", imageId: "sha256:t", source: "src", createdAt: "2026-11-11T00:00:00Z" } }
  const check = (value: ReturnType<typeof inspect>, sandbox: Manifest, described?: ReturnType<typeof image>) => configChecks(value, sandbox, "intact", "pdk123", undefined, described, "own").find((entry) => entry.id === "template")!
  const running = (id: string) => inspect((value) => { (value as any).Image = id })
  expect(check(running("sha256:t"), templated, image())).toMatchObject({ status: "info" })
  expect(check(running("sha256:t"), templated, image()).detail).toContain("Template base, saved from the sandbox src")
  expect(check(running("sha256:t"), templated, image({}, [])).detail).toContain("has been removed since")
  expect(check(running("sha256:other"), templated, image()).status).toBe("fail")
  expect(check(running("sha256:t"), templated).status).toBe("unknown")
  expect(check(running("sha256:i"), manifest, image()).detail).toBe(`None: made from the image ${manifest.spec.image}.`)
  expect(check(running("sha256:t"), manifest, image({ "dev.paddock.template": "base", "dev.paddock.template.owner": "own" })).detail).toContain("is Paddock template base's")
})

test("Docker hardening accepts exactly its declared additions inside gVisor", () => {
  const enabled = { ...manifest, spec: { ...manifest.spec, docker: true } }
  const checked = (caps: string[], change: (value: any) => void = () => {}) => configChecks(inspect((value) => {
    value.HostConfig.CapAdd = caps
    value.Mounts = [{ Type: "volume", Name: dockerVolume(enabled), Source: "/engine/volume", Destination: "/var/lib/docker", RW: true }]
    change(value)
  }), enabled, "intact", "pdk123", [{ Name: dockerVolume(enabled), Driver: "local", Options: null, Labels: { "dev.paddock.id": enabled.id, "dev.paddock.name": enabled.name } }])
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
    }), sandbox, "intact", "pdk123").find((entry) => entry.id === "limits")!
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
  const volume = { Name: dockerVolume(enabled), Driver: "local", Options: null, Labels: { "dev.paddock.id": enabled.id, "dev.paddock.name": enabled.name } }
  const mounts = (volumes?: Parameters<typeof configChecks>[4]) => configChecks(value, enabled, "intact", "pdk123", volumes).find((entry) => entry.id === "mounts")!
  expect(mounts([volume]).status).toBe("pass")
  expect(mounts().status).toBe("unknown")
  expect(mounts([]).status).toBe("unknown")
  expect(mounts([{ ...volume, Options: { type: "none", device: "/tmp", o: "bind" } }]).status).toBe("fail")
  expect(mounts([{ ...volume, Driver: "nfs" }]).status).toBe("fail")
  expect(mounts([{ ...volume, Labels: {} }]).status).toBe("fail")
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

test("a command that prints more than the output limit is killed, and nothing it printed is returned", async () => {
  const whole = await systemRunner(["sh", "-c", `head -c ${OUTPUT_LIMIT} /dev/zero; exit 3`])
  expect(whole.exitCode).toBe(3); expect(whole.stdout.length).toBe(OUTPUT_LIMIT); expect(whole.overflow).toBeUndefined()
  const started = Date.now()
  const over = await systemRunner(["sh", "-c", "yes paddock; echo finished > /dev/null"])
  expect(over).toMatchObject({ exitCode: 124, stdout: "", overflow: "stdout" })
  expect(over.stderr).toContain("16 MiB on stdout")
  expect(Date.now() - started).toBeLessThan(20_000)
  expect(await systemRunner(["sh", "-c", "yes paddock >&2"], { maxOutputBytes: 1024 ** 2 })).toMatchObject({ exitCode: 124, stdout: "", overflow: "stderr" })
  const bytes = new Uint8Array([0, 255, 128, 10, 0xc3])
  expect([...(await systemRunner(["cat"], { stdin: bytes, binary: true })).raw!]).toEqual([...bytes])
})

test("exec refuses output past the limit with an error that names it, never a cut-off result", async () => {
  const { provider } = fakeProvider(); const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  provider.exec = async () => ({ exitCode: 124, stdout: "", stderr: "", overflow: "stdout" })
  await expect(paddock.exec("demo", ["yes"])).rejects.toMatchObject({ code: "runtime", message: expect.stringContaining("16 MiB on stdout") })
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

test("a session is refused on a stopped sandbox without starting it, and ends when its sandbox stops or goes", async () => {
  const { provider, state } = fakeProvider(); const closed: string[] = []
  provider.openExec = async () => ({ tty: false, write: () => true, end: () => {}, resize: async () => {}, pause: () => {}, resume: () => {}, close: (reason?: string) => { closed.push(reason ?? "") }, on: () => {} }) as never
  const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  await paddock.stop("demo")
  const starts = state.starts
  await expect(paddock.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })).rejects.toMatchObject({ code: "conflict" })
  expect(state.starts).toBe(starts); expect(state.running).toBe(false)
  await paddock.start("demo")
  await paddock.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })
  await paddock.stop("demo")
  expect(closed).toEqual(["The session ended: demo was stopped."])
  await paddock.start("demo"); await paddock.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false })
  await paddock.remove("demo", "demo")
  expect(closed[1]).toBe("The session ended: demo was removed.")
})

test("a forward listens on loopback for one run of its sandbox and ends with it", async () => {
  const { provider, state } = fakeProvider()
  const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  const reachable = (port: number) => new Promise<boolean>((resolve) => { const socket = connect(port, "127.0.0.1", () => { socket.destroy(); resolve(true) }); socket.on("error", () => resolve(false)) })
  const made = await paddock.forwardAdd("demo", "8080")
  expect(made).toMatchObject({ name: "demo", port: 8080, localAddress: "127.0.0.1", generation: "run-1" })
  expect(await reachable(made.localPort)).toBe(true)
  const disclosed = (await paddock.verify("demo")).checks.find((check) => check.id === "forwards")!
  expect(disclosed.status).toBe("info"); expect(disclosed.detail).toContain(`127.0.0.1:${made.localPort} to port 8080 (${made.id})`)
  await expect(paddock.forwardAdd("demo", 8080, made.localPort)).rejects.toMatchObject({ code: "conflict" })
  await paddock.stop("demo")
  expect(paddock.forwardList()).toEqual([]); expect(await reachable(made.localPort)).toBe(false)
  await expect(paddock.forwardAdd("demo", 8080)).rejects.toMatchObject({ code: "conflict" })
  // A run the forward was not made for (the engine restarted it) ends the forward at the next connection.
  await paddock.start("demo")
  const again = await paddock.forwardAdd("demo", 8080)
  state.starts++
  await reachable(again.localPort); await Bun.sleep(50)
  expect(paddock.forwardList("demo")).toEqual([])
  const removed = await paddock.forwardAdd("demo", 9000)
  expect(paddock.forwardRemove(removed.id)).toEqual({ closed: removed.id })
  expect(() => paddock.forwardRemove(removed.id)).toThrow(PaddockError)
  const last = await paddock.forwardAdd("demo", 9000)
  await paddock.remove("demo", "demo")
  expect(await reachable(last.localPort)).toBe(false)
  for (const bad of [0, 70_000, "x"]) await expect(paddock.forwardAdd("demo", bad)).rejects.toMatchObject({ code: "usage" })
})

test("resize refuses what it cannot do safely, and says when each limit applies", async () => {
  const { provider, state } = fakeProvider()
  const paddock = await core(provider)
  await paddock.create({ name: "demo" })
  await expect(paddock.resize("ghost", { memoryGb: 8 })).rejects.toMatchObject({ code: "not-found" })
  await expect(paddock.resize("demo", {})).rejects.toMatchObject({ code: "usage" })
  await expect(paddock.resize("demo", { memoryGb: 0.1 })).rejects.toMatchObject({ code: "usage" })
  await expect(paddock.resize("demo", { pids: 10 })).rejects.toMatchObject({ code: "usage" })
  // Running, using 3 GiB: lowering memory to 3 GB leaves no headroom; nothing changes.
  state.use = { memoryBytes: 3 * 1024 ** 3, tasks: 100 }
  await expect(paddock.resize("demo", { memoryGb: 3 })).rejects.toMatchObject({ code: "conflict" })
  expect(state.resized).toBeUndefined()
  expect((await paddock.get("demo")).spec.memoryGb).toBe(4)
  state.use = { memoryBytes: 3 * 1024 ** 3, tasks: 3000 }
  await expect(paddock.resize("demo", { pids: 3000 })).rejects.toMatchObject({ code: "conflict" })
  state.use = undefined
  await expect(paddock.resize("demo", { memoryGb: 2 })).rejects.toMatchObject({ code: "conflict" })
  // Raising needs no reading. The engine's host confirms memory, not CPUs.
  state.live = { cpus: 2, memoryGb: 8, pids: 4096 }
  const raised = await paddock.resize("demo", { memoryGb: 8, cpus: 3 })
  expect(raised.changes.map((change) => [change.limit, change.applies])).toEqual([["cpus", "next start"], ["memoryGb", "now"], ["pids", "unchanged"], ["diskGb", "unchanged"]])
  expect(state.resized).toEqual({ cpus: 3, memoryGb: 8, pids: 4096, diskGb: 20 } as Limits)
  expect((await paddock.get("demo")).spec).toMatchObject({ cpus: 3, memoryGb: 8 })
  expect(raised.checks.map((check) => check.id)).toContain("limits")
  // Stopped: everything waits for the next start, and lowering needs no reading.
  await paddock.stop("demo")
  const lowered = await paddock.resize("demo", { memoryGb: 1, diskGb: 10 })
  expect(lowered.changes.find((change) => change.limit === "memoryGb")!.applies).toBe("next start")
  expect(lowered.changes.find((change) => change.limit === "diskGb")!.applies).toBe("now")
})

test("a sandbox made from a template records it and runs its image; removing the template says who still uses it", async () => {
  const { provider, state } = fakeProvider()
  const paddock = await core(provider)
  await expect(paddock.create({ name: "copy", template: "base" })).rejects.toMatchObject({ code: "not-found" })
  expect(await paddock.list()).toEqual([])
  await paddock.create({ name: "src" })
  await expect(paddock.snapshot("src", "Bad Name")).rejects.toMatchObject({ code: "usage" })
  await expect(paddock.snapshot("ghost", "base")).rejects.toMatchObject({ code: "not-found" })
  const saved = await paddock.snapshot("src", "base")
  expect(saved.contents).toContain("home folders included")
  const made = await paddock.create({ name: "copy", template: "base" })
  expect(made.sandbox.template).toMatchObject({ name: "base", imageId: "sha256:base", source: "src" })
  expect(state.created.at(-1)!.spec.image).toBe("sha256:base")
  expect(await paddock.templateList()).toHaveLength(1)
  state.templates[0]!.dependants = ["copy"]
  const removed = await paddock.templateRemove("base")
  expect(removed).toMatchObject({ removed: "base", dependants: ["copy"] })
  expect(removed.note).toContain("keep working")
  await expect(paddock.templateRemove("base")).rejects.toMatchObject({ code: "not-found" })
})
