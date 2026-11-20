import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blockers, CHECKLIST, GPU_CHECKLIST, GPU_KIND, GPU_WARNING } from "../../core/checks"
import { Core } from "../../core/core"
import { CATALOG, Machines, type Hello, type HostRecord } from "../../core/machines"
import { configChecks, confinement, GvisorProvider, gpuListing, gpuRequestProblem, hostDriver, hostKernel, insideSections, LABEL_ID, network } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import { AsideeError, type CheckResult, type Engine, type Manifest, type Provider, type RunResult, type Stage } from "../../core/types"

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
const temp = async () => { const root = await mkdtemp(join(tmpdir(), "asd-gpu-")); folders.push(root); return root }

const capabilities = { kernelIsolation: "gvisor" as const, diskLimit: "watched" as const, networkGuard: true, docker: true, execStream: true, loopbackRelay: true, resize: "live" as const, snapshot: true }
const engine: Engine = { id: "fake:1", provider: "fake", label: "Fake engine", ready: true, problems: [], data: { context: "fake", runtime: "runsc", apparmor: "docker-default" }, capabilities: { ...capabilities, gpu: true } }
const pass = (id: CheckResult["id"]): CheckResult => ({ id, status: "pass", evidence: "inspected", detail: "ok" })

// A provider that reports every item of the checklist the manifest's kind has as holding, with the kernel item a
// disclosure for a GPU container, as the real provider reports it.
function fakeProvider(detected: Engine = engine) {
  const state = { exists: false, running: false, execs: [] as Array<string | undefined>, sessions: [] as Array<string | undefined> }
  const provider: Provider = {
    id: "fake", detect: async () => [detected],
    create: async () => { state.exists = true }, prepare: async () => {}, start: async () => { state.running = true }, stop: async () => { state.running = false },
    remove: async () => { state.exists = false }, status: async () => !state.exists ? "missing" : state.running ? "running" : "stopped",
    exec: async (_manifest, _argv, options) => { state.execs.push(options?.user); return { exitCode: 0, stdout: "", stderr: "" } },
    openExec: async (_manifest, _argv, options) => { state.sessions.push(options.user); throw new AsideeError("dependency", "no sessions in the fake") },
    generation: async () => state.running ? "run-1" : undefined, prepareLoopback: async () => {}, dialLoopback: async () => { throw new Error("no") },
    checks: async (manifest, stage: Stage) => (manifest.spec.gpu ? GPU_CHECKLIST : CHECKLIST).filter((item) => item.stage === stage)
      .map((item) => manifest.spec.gpu && item.id === "kernel" ? { ...pass("kernel"), status: "info" as const } : pass(item.id)),
    diskUsedBytes: async () => 0, stoppedWhy: async () => undefined, sweep: async () => {}, resize: async () => undefined, usage: async () => undefined,
    snapshot: async () => { throw new Error("a template was made") }, templates: async () => [], removeTemplate: async () => { throw new Error("no") },
  }
  return { provider, state }
}
async function core(provider: Provider) {
  const root = await temp()
  return new Core([provider], { state: join(root, "state"), config: join(root, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("gpu is a strict boolean, false unless a request sets it, and excludes Docker inside", () => {
  expect(validSpec({ name: "demo" }).gpu).toBeUndefined()
  expect(validSpec({ name: "demo", gpu: false }).gpu).toBeUndefined()
  expect(validSpec({ name: "demo", gpu: true })).toMatchObject({ gpu: true, docker: false })
  for (const gpu of ["true", 1, null, {}]) expect(() => validSpec({ name: "demo", gpu })).toThrow("gpu must be a boolean")
  expect(() => validSpec({ name: "demo", gpu: true, docker: true })).toThrow("cannot run Docker inside")
  // Docker inside from the defaults does not apply to a GPU container; a default never makes one.
  expect(validSpec({ name: "demo", gpu: true }, { docker: true }).docker).toBe(false)
  expect(validSpec({ name: "demo" }, { gpu: true } as never).gpu).toBeUndefined()
})

test("the GPU checklist discloses the host kernel, never as isolated, and adds confinement and the GPU as blocking", () => {
  const item = (id: string) => GPU_CHECKLIST.find((entry) => entry.id === id)
  expect(item("kernel")!.title).not.toContain("isolated kernel")
  expect(item("kernel")!.title).toContain("host's Linux kernel")
  expect(item("confinement")).toMatchObject({ blocking: true, stage: "runtime" })
  expect(item("gpu")).toMatchObject({ blocking: true, stage: "runtime" })
  expect(item("host-driver")).toMatchObject({ blocking: false })
  expect(item("docker")).toBeUndefined()
  for (const id of ["network-guard", "net-host", "net-peers", "net-private", "limits", "disk", "mounts", "inbound"]) expect(item(id)).toEqual(CHECKLIST.find((entry) => entry.id === id)!)
  // The sandbox checklist is unchanged.
  expect(CHECKLIST.map((entry) => entry.id)).not.toContain("confinement")
  expect(CHECKLIST.find((entry) => entry.id === "kernel")!.title).toBe("Runs on an isolated kernel, not the host's")
  // A confinement or GPU result the provider did not report blocks, as any unreported item does.
  expect(blockers([{ id: "confinement", status: "unknown", evidence: "none", detail: "" }], GPU_CHECKLIST).map((entry) => entry.id)).toEqual(["confinement"])
})

test("a GPU container is refused on an engine without the gpu capability, and with --docker", async () => {
  const { provider, state } = fakeProvider({ ...engine, capabilities })
  const asidee = await core(provider)
  await expect(asidee.create({ name: "demo", gpu: true })).rejects.toMatchObject({ code: "dependency", message: expect.stringContaining("cannot make a GPU container") })
  await expect(asidee.create({ name: "demo", gpu: true, docker: true })).rejects.toMatchObject({ code: "usage" })
  expect(state.exists).toBe(false)
})

test("a GPU container is labelled, warned about, and refuses templates, links, SSH and other users", async () => {
  const { provider, state } = fakeProvider()
  const asidee = await core(provider)
  const made = await asidee.create({ name: "gpu", gpu: true })
  expect(made.warning).toBe(GPU_WARNING)
  expect(made.sandbox).toMatchObject({ kind: GPU_KIND, spec: { gpu: true } })
  expect(made.checks.map((check) => check.id)).toContain("confinement")
  expect(made.checks.find((check) => check.id === "kernel")!.status).toBe("info")
  expect((await asidee.get("gpu")).kind).toBe(GPU_KIND)
  expect((await asidee.list()).find((view) => view.name === "gpu")!.kind).toBe(GPU_KIND)
  const sandbox = await asidee.create({ name: "box" })
  expect(sandbox.warning).toBeUndefined(); expect(sandbox.sandbox.kind).toBeUndefined()

  await expect(asidee.snapshot("gpu", "base")).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("GPU container") })
  await expect(asidee.links.add("box", "gpu", 5432)).rejects.toThrow("links to or from one are refused")
  await expect(asidee.links.add("gpu", "box", 5432)).rejects.toThrow("links to or from one are refused")
  await expect(asidee.sshSetup("gpu")).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("sshd cannot switch") })
  for (const user of ["0", "root", "0:0", "agent", "1001"]) await expect(asidee.exec("gpu", ["id"], { user })).rejects.toMatchObject({ code: "usage" })
  await expect(asidee.openSession({ kind: "exec", name: "gpu", argv: ["sh"], tty: true, user: "root" })).rejects.toMatchObject({ code: "usage" })
  expect(state.execs).toEqual([]); expect(state.sessions).toEqual([])
  await asidee.exec("gpu", ["id"]); await asidee.exec("gpu", ["id"], { user: "1000" })
  // A sandbox's user is not limited.
  await asidee.exec("box", ["id"], { user: "0" })
  expect(state.execs).toEqual([undefined, "1000", "0"])
})

// docker create's arguments, from a runner that answers every other engine command with success.
async function createArgs(spec: Record<string, unknown>, data: Record<string, string> = { context: "fake", runtime: "runsc" }) {
  const calls: string[][] = []
  const provider = new GvisorProvider(async (argv) => { calls.push([...argv]); return { exitCode: 0, stdout: "", stderr: "" } })
  await provider.create({ version: 1, name: "demo", id: "abc", createdAt: "", spec: validSpec({ name: "demo", ...spec }), engine: { ...engine, provider: "gvisor", data } })
  return calls.find((call) => call[3] === "create")!.slice(4)
}

test("a GPU container is created on runc as uid 1000, with every capability dropped, no new privileges and the GPU request", async () => {
  const args = await createArgs({ gpu: true }, { context: "fake", runtime: "runsc", apparmor: "docker-default" })
  const after = (flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : [])
  expect(after("--runtime")).toEqual(["runc"])
  expect(after("--user")).toEqual(["1000:1000"])
  expect(after("--cap-drop")).toEqual(["ALL"])
  expect(after("--security-opt")).toEqual(["no-new-privileges", "apparmor=docker-default"])
  expect(after("--gpus")).toEqual(["all"])
  expect(after("--network")).toEqual([network("demo")])
  for (const flag of ["--privileged", "--cap-add", "--device", "-v", "--volume", "-p", "--publish", "--pid", "--ipc"]) expect(args).not.toContain(flag)
  expect(after("--security-opt")).not.toContain("seccomp=unconfined")
  expect(args.indexOf("--gpus")).toBeLessThan(args.indexOf("--entrypoint"))
  // Without AppArmor on the host, none is asked for.
  expect((await createArgs({ gpu: true })).filter((arg) => arg.startsWith("apparmor"))).toEqual([])
  // A sandbox is made as before.
  const sandbox = await createArgs({})
  expect(sandbox[sandbox.indexOf("--runtime") + 1]).toBe("runsc")
  for (const flag of ["--gpus", "--cap-drop", "--user", "--security-opt"]) expect(sandbox).not.toContain(flag)
})

test("an engine reports gpu only when Docker lists an NVIDIA CDI device or the nvidia runtime, and records AppArmor", async () => {
  const detect = async (info: Record<string, unknown>) => {
    const provider = new GvisorProvider(async (argv): Promise<RunResult> => argv[1] === "context"
      ? { exitCode: 0, stdout: `${JSON.stringify({ Name: "default", DockerEndpoint: "unix:///var/run/docker.sock" })}\n`, stderr: "" }
      : { exitCode: 0, stderr: "", stdout: JSON.stringify({ ID: "x", ServerVersion: "28.5.1", OperatingSystem: "Linux Mint 22.3", Runtimes: { "asidee-runsc": { path: "/opt/asidee/runsc", runtimeArgs: ["--overlay2=none", "--net-raw"] }, runc: { path: "runc" }, ...info.runtimes as object }, ...info }) })
    return (await provider.detect())[0]!
  }
  const cdi = await detect({ DiscoveredDevices: [{ Source: "cdi", ID: "nvidia.com/gpu=0" }, { Source: "cdi", ID: "nvidia.com/gpu=GPU-1234" }], SecurityOptions: ["name=apparmor", "name=seccomp,profile=builtin"] })
  expect(cdi.capabilities?.gpu).toBe(true); expect(cdi.data.apparmor).toBe("docker-default"); expect(cdi.data.runtime).toBe("asidee-runsc")
  const runtime = await detect({ runtimes: { nvidia: { path: "nvidia-container-runtime" } }, SecurityOptions: ["name=seccomp,profile=builtin"] })
  expect(runtime.capabilities?.gpu).toBe(true); expect(runtime.data.apparmor).toBeUndefined()
  const none = await detect({ DiscoveredDevices: [{ Source: "cdi", ID: "vendor.example/fpga=0" }], SecurityOptions: ["name=apparmor"] })
  expect(none.capabilities?.gpu).toBeUndefined(); expect(none.data.apparmor).toBeUndefined()
})

// docker inspect of a GPU container made as the provider makes it.
const gpuManifest: Manifest = { version: 1, name: "demo", id: "abc", engine, spec: validSpec({ name: "demo", gpu: true }), createdAt: "" }
const GPU_REQUEST = { Driver: "", Count: -1, DeviceIDs: null, Capabilities: [["gpu"]], Options: {} }
function inspect(change: (value: any) => void = () => {}) {
  const value = {
    State: { Running: true }, Config: { Labels: { [LABEL_ID]: "abc" }, User: "1000:1000" }, Mounts: [], AppArmorProfile: "docker-default",
    HostConfig: { Runtime: "runc", Privileged: false, CapAdd: null, CapDrop: ["ALL"], Devices: [], DeviceRequests: [GPU_REQUEST] as unknown[], PidMode: "", IpcMode: "private", UTSMode: "", UsernsMode: "",
      SecurityOpt: ["no-new-privileges", "apparmor=docker-default"], NetworkMode: network("demo"), PublishAllPorts: false, PortBindings: {}, Memory: 4 * 1024 ** 3, MemorySwap: 4 * 1024 ** 3,
      PidsLimit: 4096, NanoCpus: 2e9, LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } } },
    NetworkSettings: { Networks: { [network("demo")]: { IPAddress: "10.0.0.2" } } },
  }
  change(value); return value
}
const failing = (value: ReturnType<typeof inspect>, manifest = gpuManifest) => configChecks(value, manifest, "intact", "asd123").filter((entry) => entry.status === "fail").map((entry) => entry.id)

test("hardening allows exactly the one GPU request, and only for a GPU container", () => {
  expect(failing(inspect())).toEqual([])
  expect(configChecks(inspect(), gpuManifest, "intact", "asd123").find((entry) => entry.id === "mounts")!.detail).toContain("NVIDIA's hook")
  expect(failing(inspect((value) => { value.HostConfig.DeviceRequests = [{ ...GPU_REQUEST, Driver: "nvidia" }] }))).toEqual([])
  for (const requests of [[], [GPU_REQUEST, GPU_REQUEST], [{ ...GPU_REQUEST, Driver: "cdi" }], [{ ...GPU_REQUEST, Count: 1 }], [{ ...GPU_REQUEST, DeviceIDs: ["0"] }],
    [{ ...GPU_REQUEST, Capabilities: [["gpu", "compute"]] }], [{ ...GPU_REQUEST, Options: { x: "y" } }]])
    expect(failing(inspect((value) => { value.HostConfig.DeviceRequests = requests }))).toEqual(["hardening"])
  expect(gpuRequestProblem([GPU_REQUEST])).toBe(false)
  for (const change of [(value: any) => { value.HostConfig.Devices = [{ PathOnHost: "/dev/nvidia0" }] }, (value: any) => { value.HostConfig.Runtime = "runsc" },
    (value: any) => { value.HostConfig.Privileged = true }, (value: any) => { value.HostConfig.CapAdd = ["SYS_ADMIN"] }, (value: any) => { value.HostConfig.SecurityOpt = ["seccomp=unconfined"] },
    (value: any) => { value.HostConfig.SecurityOpt = ["no-new-privileges", "label=disable"] }, (value: any) => { value.HostConfig.PidMode = "host" }])
    expect(failing(inspect(change))).toEqual(["hardening"])
  // A sandbox with the same device request still fails.
  const sandbox: Manifest = { ...gpuManifest, spec: validSpec({ name: "demo" }) }
  const asSandbox = inspect((value) => { value.HostConfig.Runtime = "runsc"; value.HostConfig.CapDrop = null; value.HostConfig.SecurityOpt = null })
  expect(failing(asSandbox, sandbox)).toEqual(["hardening"])
  asSandbox.HostConfig.DeviceRequests = []
  expect(failing(asSandbox, sandbox)).toEqual([])
})

const STATUS = (change: Record<string, string> = {}) => Object.entries({ Uid: "1000\t1000\t1000\t1000", Gid: "1000\t1000\t1000\t1000", CapPrm: "0000000000000000", CapEff: "0000000000000000", CapBnd: "0000000000000000", NoNewPrivs: "1", Seccomp: "2", ...change })
  .map(([key, value]) => `${key}:\t${value}`).join("\n")
const inside = (self = STATUS(), main = STATUS(), apparmor = "docker-default (enforce)") => insideSections(`== status self\nName:\tcat\n${self}\n== apparmor self\n${apparmor}\n\n== status 1\n${main}\n== apparmor 1\n${apparmor}\n\n== version\nLinux version 6.8.0-51-generic (buildd@lcy02) #52-Ubuntu SMP\n== mounts\n1 0 0:1 / / rw - overlay overlay rw\n`)

test("the kernel item of a GPU container is a disclosure, and fails on any runtime but runc", () => {
  const kernel = hostKernel("runc", inside().version)
  expect(kernel.status).toBe("info"); expect(kernel.detail).toContain("Not isolated"); expect(kernel.detail).toContain("Linux version 6.8.0-51-generic")
  for (const runtime of ["runsc", "asidee-runsc", "nvidia", "kata"]) expect(hostKernel(runtime, inside().version).status).toBe("fail")
  expect(hostKernel("runc", "Linux version 4.4.0 #1 SMP Sun Jan 10 15:06:54 PST 2016 (gVisor)").status).toBe("fail")
  expect(hostKernel("runc", undefined).status).toBe("unknown")
  for (const value of [kernel, hostKernel("runsc", ""), hostKernel("runc", undefined)]) expect(value.status).not.toBe("pass")
})

test("confinement needs uid 1000, no capabilities, no new privileges, seccomp and AppArmor, from the engine and from inside", () => {
  const check = (value = inspect(), seen: Record<string, string> | undefined = inside(), manifest = gpuManifest) => confinement(value, manifest, seen)
  expect(check()).toMatchObject({ id: "confinement", status: "pass", evidence: "probed" })
  for (const [label, value, seen] of [
    ["user", inspect((value) => { value.Config.User = "" }), inside()],
    ["cap drop", inspect((value) => { value.HostConfig.CapDrop = [] }), inside()],
    ["cap add", inspect((value) => { value.HostConfig.CapAdd = ["NET_RAW"] }), inside()],
    ["no-new-privileges", inspect((value) => { value.HostConfig.SecurityOpt = ["apparmor=docker-default"] }), inside()],
    ["apparmor profile", inspect((value) => { value.AppArmorProfile = "unconfined" }), inside()],
    ["root inside", inspect(), inside(STATUS({ Uid: "0\t0\t0\t0" }))],
    ["main process root", inspect(), inside(STATUS(), STATUS({ Uid: "0\t0\t0\t0" }))],
    ["capabilities", inspect(), inside(STATUS({ CapEff: "00000000a80425fb" }))],
    ["bounding set", inspect(), inside(STATUS({ CapBnd: "00000000a80425fb" }))],
    ["new privileges", inspect(), inside(STATUS({ NoNewPrivs: "0" }))],
    ["seccomp", inspect(), inside(STATUS({ Seccomp: "0" }))],
    ["unconfined", inspect(), inside(STATUS(), STATUS(), "unconfined")],
  ] as const) expect([label, check(value as ReturnType<typeof inspect>, seen).status]).toEqual([label, "fail"])
  expect(confinement(inspect(), gpuManifest, undefined).status).toBe("unknown")
  // Where the host had no AppArmor when it was made, none is required.
  const plain: Manifest = { ...gpuManifest, engine: { ...engine, data: { context: "fake", runtime: "runsc" } } }
  const bare = inspect((value) => { value.AppArmorProfile = ""; value.HostConfig.SecurityOpt = ["no-new-privileges"] })
  expect(check(bare, inside(STATUS(), STATUS(), ""), plain).status).toBe("pass")
  expect(check(bare, inside(STATUS(), STATUS(), ""), plain).detail).toContain("no AppArmor")
})

test("the GPU check needs nvidia-smi to list a GPU, and the driver disclosure lists the hook's mounts", () => {
  expect(gpuListing({ exitCode: 0, stdout: "GPU 0: NVIDIA GeForce RTX 3050 (UUID: GPU-1234)\n", stderr: "" })).toMatchObject({ id: "gpu", status: "pass", detail: expect.stringContaining("GPU 0: NVIDIA GeForce RTX 3050") })
  expect(gpuListing({ exitCode: 0, stdout: "No devices found.\n", stderr: "" }).status).toBe("fail")
  expect(gpuListing({ exitCode: 127, stdout: "", stderr: "nvidia-smi: not found" }).status).toBe("fail")
  const mount = (path: string, options = "ro,nosuid,nodev,relatime") => `100 90 259:2 /usr/lib/x ${path} ${options} - ext4 /dev/nvme0n1p2 rw`
  const table = [mount("/usr/bin/nvidia-smi"), mount("/usr/lib/x86_64-linux-gnu/libcuda.so.550.120"), mount("/dev/nvidia0", "rw,nosuid,noexec"), "1 0 0:1 / / rw - overlay overlay rw"].join("\n")
  const listed = hostDriver(table)
  expect(listed).toMatchObject({ id: "host-driver", status: "info", evidence: "probed" })
  expect(listed.detail).toContain("2 of the host's driver files, all read-only"); expect(listed.detail).toContain("/dev/nvidia0"); expect(listed.detail).toContain("docker inspect does not show")
  expect(hostDriver(`${table}\n${mount("/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1", "rw,relatime")}`).status).toBe("weak")
  expect(hostDriver("1 0 0:1 / / rw - overlay overlay rw").status).toBe("unknown")
  expect(hostDriver(undefined).status).toBe("unknown")
})

test("a GPU container's runtime checks run inside as uid 1000", async () => {
  const calls: string[][] = []
  const provider = new GvisorProvider(async (argv) => {
    calls.push([...argv]); const args = argv.slice(3)
    if (args[0] === "inspect") return { exitCode: 0, stderr: "", stdout: JSON.stringify([inspect()]) }
    if (args[0] === "exec" && args.includes("nvidia-smi")) return { exitCode: 0, stderr: "", stdout: "GPU 0: NVIDIA GeForce RTX 3050 (UUID: GPU-1)\n" }
    if (args[0] === "exec" && args.some((arg) => arg.includes("== status"))) {
      const sections = inside(); return { exitCode: 0, stderr: "", stdout: Object.entries(sections).map(([key, value]) => `== ${key}\n${value}`).join("") }
    }
    if (args[0] === "exec" && args.some((arg) => arg.includes("resolv.conf"))) return { exitCode: 0, stderr: "", stdout: "nameserver 1.1.1.1\nnameserver 8.8.8.8\n" }
    return { exitCode: 0, stdout: "", stderr: "" }
  })
  const results = await provider.checks({ ...gpuManifest, engine: { ...engine, provider: "gvisor" } }, "runtime")
  expect(Object.fromEntries(results.map((check) => [check.id, check.status]))).toEqual({ kernel: "info", confinement: "pass", gpu: "pass", dns: "pass", "host-driver": "unknown" })
  const users = calls.filter((call) => call[3] === "exec").map((call) => call[call.indexOf("-u") + 1])
  expect(users.filter((user) => user === "1000:1000")).toHaveLength(2)
  expect(calls.find((call) => call.includes("nvidia-smi"))).toContain("1000:1000")
})

test("remote routing carries gpu to the other machine and labels what comes back", async () => {
  const root = await temp(); const dirs = { state: join(root, "s"), config: join(root, "c") }
  await mkdir(dirs.config); await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: true }))
  const LOCAL: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "9".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: ["machines", "remote-streams", "remote-forwards", "lease-renewal"] }
  const REMOTE: Hello = { ...LOCAL, machineId: "d".repeat(32), bootId: "e".repeat(32) }
  const HOST: HostRecord = { name: "home-linux", ssh: "home-linux", binary: "/opt/asidee/bin", stateDir: "/home/me/state", machineId: REMOTE.machineId, addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "prepared" }
  const row = { machineId: REMOTE.machineId, sandboxId: "f".repeat(32), name: "x", status: "running", engine: "remote-engine", createdAt: "2026-11-20", spec: validSpec({ name: "x", gpu: true }) }
  const calls: Array<{ method: string; body: object }> = []
  const machines = new Machines(dirs, LOCAL, async () => ({ hello: LOCAL, checkedAt: "2026-11-20T00:00:00Z", sandboxes: [] }), {
    sshIdentity: async () => ({ user: "me", hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8" }),
    connectPeer: () => ({ async close() {}, async call(method: string, body: object = {}) {
      calls.push({ method, body }); if (method === "hello") return REMOTE
      return method === "create" ? { sandbox: row, checks: [], hooks: [], warning: GPU_WARNING } : row
    } }) })
  await machines.attach(HOST)
  calls.length = 0
  const made = await machines.route("create", { host: "home-linux", name: "x", gpu: true }) as { sandbox: { kind?: string; spec: { gpu?: boolean } }; warning?: string }
  expect(calls.find((call) => call.method === "create")!.body).toEqual({ name: "x", gpu: true })
  expect(made.sandbox).toMatchObject({ kind: GPU_KIND, spec: { gpu: true } }); expect(made.warning).toBe(GPU_WARNING)
  expect(await machines.route("get", { host: "home-linux", name: "x" })).toMatchObject({ kind: GPU_KIND })
})
