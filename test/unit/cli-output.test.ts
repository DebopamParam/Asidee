import { afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKLIST, GPU_KIND, GPU_WARNING, WORKSPACE_CHECKLIST } from "../../core/checks"
import { VERSION } from "../../core/daemon"
import { enrollmentOptions, GVISOR, GVISOR_FILES, GVISOR_RELEASE, installationPlan, type HostProbe } from "../../core/hosts"
import { socketPath, streamSocketPath } from "../../core/state"
import { frame } from "../../core/stream"
import { WORKSPACE_DISCLOSURE, workspaceDisclosure, HOST_TEMP_DISCLOSURE } from "../../core/workspace-profile"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const CLI = join(import.meta.dir, "../../cli/cli.ts")
const ESC = "\x1b[2J\x1b[H✓ forged\x9b31m‮"

// A daemon that answers as this build (so the CLI uses it) with text another machine chose. A reply that is a function
// is given the request's body.
async function daemon(replies: Record<string, unknown>, binary?: string) {
  const state = await mkdtemp(join(tmpdir(), "asd-cli-"))
  const build = `${VERSION}+${Math.round(statSync(binary ?? CLI).mtimeMs)}`
  const server = Bun.serve({ unix: socketPath({ state, config: state }), fetch: async (request) => {
    const method = new URL(request.url).pathname.slice(5)
    if (method === "version") return Response.json({ ok: true, data: { version: VERSION, build } })
    const reply = replies[method]
    return method in replies ? Response.json(typeof reply === "function" ? await reply(await request.json()) : reply) : Response.json({ ok: false, error: { code: "not-found", message: "No such method." } }, { status: 404 })
  } })
  cleanups.push(async () => { server.stop(true); await rm(state, { recursive: true, force: true }) })
  // Asynchronous, so this process keeps answering while the CLI runs.
  const env = { ...process.env, ASIDEE_STATE_DIR: state, ASIDEE_CONFIG_DIR: state }
  return Object.assign(async (...args: string[]) => {
    const run = Bun.spawn([...(binary ? [binary] : [process.execPath, CLI]), ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    return { code, out, err }
  }, { env })
}

test("buffered exec and JSON preserve inherited file offsets on both output streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "asd-output-")); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, "asd")
  const build = Bun.spawn([process.execPath, "build", "--compile", "--minify", CLI, "--outfile", binary], { stdout: "pipe", stderr: "pipe" })
  expect(await build.exited).toBe(0)
  const result = { exitCode: 0, stdout: `Xé\u0000${"x".repeat(100_000)}\n`, stderr: "Eé\n" }
  for (const executable of [undefined, binary]) {
    const asidee = await daemon({ exec: { ok: true, data: result }, workspaceExec: { ok: true, data: result }, workspaceGet: { ok: true, data: { spec: { hostTemp: false } } } }, executable)
    for (const workspace of [false, true]) for (const json of [false, true]) {
      const out = join(root, "out"); const err = join(root, "err")
      const script = 'task_out=$1; task_err=$2; shift 2; { printf b1; printf e1 >&2; "$@"; printf b2; printf e2 >&2; } > "$task_out" 2> "$task_err"'
      const args = [...(json ? ["--json"] : []), ...(workspace ? ["workspace"] : []), "exec", "demo", "--", "/bin/echo", "X"]
      const child = Bun.spawn(["/bin/sh", "-c", script, "sh", out, err, ...(executable ? [executable] : [process.execPath, CLI]), ...args], { env: asidee.env, stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(0)
      expect(await readFile(out)).toEqual(Buffer.from(`b1${json ? `${JSON.stringify({ ok: true, data: result })}\n` : result.stdout}b2`))
      const disclosure = workspace && !json ? "Workspace, not a sandbox. Network and loopback open; disk watched, no other resource limits.\n" : ""
      expect(await readFile(err)).toEqual(Buffer.from(`e1${disclosure}${json ? "" : result.stderr}e2`))
    }
  }
}, 20_000)

test("text from a daemon reaches the terminal without control characters", async () => {
  const machineId = "d".repeat(32)
  const row = { name: "demo", status: "damaged", machineId, engine: ESC, createdAt: "", spec: { name: "demo" }, stopReason: `bad${ESC}\nline` }
  const asidee = await daemon({
    fleet: { ok: true, data: { machines: [{ machine: { host: { name: "build", machineId }, state: "offline", error: `gone${ESC}` }, cached: { sandboxes: [row] }, stale: true }] } },
    list: { ok: true, data: [row] },
    stop: { ok: false, error: { code: "runtime", message: `failed${ESC}\nforged line` } },
  })
  for (const [args, seen] of [[["list", "--all"], "build/demo"], [["list"], "demo"], [["stop", "demo"], "failed"]] as const) {
    const { out, err } = await asidee(...args)
    expect(out + err).toContain(seen)
    expect(out + err).not.toMatch(/[\x1b\x9b‮]/)
  }
  const { code, err } = await asidee("stop", "demo")
  expect(code).toBe(1)
  expect(err.trim().split("\n")).toHaveLength(1)
}, 20_000)

test("list describes saved verification as dated history with current checks unknown", async () => {
  const asidee = await daemon({ list: { ok: true, data: [{ name: "demo", status: "running", engine: "fake", spec: { cpus: 1, memoryGb: 1, diskGb: 20 },
    lastVerify: { at: "2026-11-10T10:00:00Z", results: [{ id: "kernel", status: "pass" }] } }] } })
  const { out, code } = await asidee("list")
  expect(code).toBe(0)
  expect(out).toMatch(/verified \d+ d ago/)
  expect(out.split("historical only")).toHaveLength(2)
  expect(out).toContain("disk limit 20 GB")
  expect(out).not.toContain("0 failed")
})

test("a GPU container is labelled as one in create, list, get and verify, and never as a sandbox's isolated kernel", async () => {
  const gpu = { name: "gpu", status: "running", engine: "Fake", kind: GPU_KIND, spec: { cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, image: "ubuntu:24.04", gpu: true } }
  const box = { name: "box", status: "running", engine: "Fake", spec: { cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, image: "ubuntu:24.04" } }
  const checks = [{ id: "kernel", status: "info", evidence: "probed", detail: "Not isolated: runc runs it on the host's own Linux kernel." }]
  const bodies: unknown[] = []
  const asidee = await daemon({ create: (body: unknown) => { bodies.push(body); return { ok: true, data: { sandbox: gpu, checks, hooks: [], warning: GPU_WARNING } } },
    list: { ok: true, data: [gpu, box] }, get: { ok: true, data: gpu }, verify: { ok: true, data: { sandbox: gpu, checks, ok: true } } })
  const made = await asidee("create", "gpu", "--gpu")
  expect(made.code).toBe(0); expect(bodies).toEqual([expect.objectContaining({ name: "gpu", gpu: true })])
  expect(made.err).toContain(GPU_WARNING); expect(made.out).toContain(GPU_KIND)
  expect(made.out).toContain("Runs on the host's Linux kernel (runc)")
  const listed = (await asidee("list")).out.split("\n")
  expect(listed.find((line) => line.includes("gpu"))).toContain(GPU_KIND)
  expect(listed.find((line) => line.includes("box"))).not.toContain(GPU_KIND)
  const got = await asidee("get", "gpu")
  expect(got.out).toContain(GPU_KIND); expect(got.out).toContain("is not a sandbox")
  const verified = (await asidee("verify", "gpu")).out
  expect(verified).toContain(GPU_KIND); expect(verified).not.toContain("isolated kernel")
  expect((await asidee("--json", "get", "gpu")).out).toContain(`"kind":"${GPU_KIND}"`)
  // The daemon refuses --gpu with --docker; the CLI passes both on.
  await asidee("create", "x", "--gpu", "--docker")
  expect(bodies[1]).toMatchObject({ gpu: true, docker: true })
})

test("workspace create and verify print the disclosure once, also when no check carried it", async () => {
  const workspace = { kind: "workspace", name: "render", folder: "/w/render", status: "stopped", processes: 0, disclosure: WORKSPACE_DISCLOSURE }
  const reached = { workspace, ok: true, checks: [{ id: "not-covered", status: "info", evidence: "none", detail: `${WORKSPACE_DISCLOSURE} Time Machine exclusion could not be verified.` }] }
  const cut = { workspace, ok: true, checks: [{ id: "not-covered", status: "unknown", evidence: "none", detail: "This workspace check could not be made." }] }
  const asidee = await daemon({ workspaceCreate: { ok: true, data: reached }, workspaceVerify: { ok: true, data: cut } })
  for (const action of ["create", "verify"]) {
    const result = await asidee("workspace", action, "render")
    expect(result.code).toBe(0)
    expect(result.out.split(WORKSPACE_DISCLOSURE).length - 1).toBe(1)
  }
})

test("list shows the timestamp and reason of an enforcement failure", async () => {
  const row = { name: "demo", status: "running", engine: "fake", spec: { cpus: 1, memoryGb: 1 }, enforcementProblem: { at: "2026-11-12T00:00:00Z", message: "disk unreadable" } }
  const asidee = await daemon({ list: { ok: true, data: [row] } })
  const { out } = await asidee("list")
  expect(out).toContain("Enforcement problem at 2026-11-12T00:00:00Z: disk unreadable")
})

test("an enrollment plan is shown as every command, file, download and restart, without the destination's control characters", async () => {
  // A destination that has Docker and two containers, one of them a sandbox of an earlier Asidee, and that answers
  // with text chosen to redraw a terminal.
  const probe: HostProbe = {
    system: "Linux", arch: "aarch64", libc: ["glibc", "2.39"], uid: 1000, gid: 1000, user: "alice", home: "/home/alice", machine: `m${ESC}`, boot: "b",
    hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8", systemd: true, os: { ID: "ubuntu", PRETTY_NAME: `Ubuntu${ESC}` },
    docker: { code: 0, out: "{}", err: "" }, containers: { code: 0, out: [{ Names: `owner-web${ESC}`, ID: "123" }, { Names: "sandbox-mine", ID: "456" }].map((row) => JSON.stringify(row)).join("\n"), err: "" },
    packages: { code: 0, out: "", err: "" }, downloads: [], apt: {}, repositories: {}, ancestors: {},
    files: Object.fromEntries([
      "/usr/local/bin/asd", "/etc/systemd/system/asidee@1000.service", `/opt/asidee/releases/${"a".repeat(64)}/asd`,
      ...GVISOR_FILES.map((name) => `/opt/asidee/gvisor/${GVISOR_RELEASE}/${name}`),
    ].map((path) => [path, { kind: "absent" }])),
    unit: { code: 0, out: "", err: "" }, dockerGroup: { code: 0, out: "docker:x:999:", err: "" }, lingering: { code: 0, out: "Linger=no", err: "" },
  }
  probe.files["/etc/docker/daemon.json"] = { kind: "file", sha256: "c".repeat(64), sha512: "d".repeat(128), uid: 0, mode: 0o644, text: `${JSON.stringify({ labels: [`keep${ESC}`] }, null, 2)}\n` }
  const asked: Array<Record<string, unknown>> = []
  const made = (body: Record<string, unknown>) => {
    asked.push(body)
    return { ok: true, data: installationPlan(enrollmentOptions({ ...body, host: undefined }), probe, { version: VERSION, sourceDigest: "b".repeat(64) }) }
  }
  const asidee = await daemon({ hostPlan: made, hostApply: { ok: false, error: { code: "conflict", message: "Consent is stale." } } })
  const args = ["host", "add", "build", "--ssh", "alice@build", "--artifact", "/tmp/asd", "--sha256", "a".repeat(64)]
  const { code, out, err } = await asidee(...args, "--docker")
  // No terminal and no accepted hash: the plan is shown and nothing is applied.
  expect(code).toBe(2)
  expect(err).toContain("--accept-plan HASH")
  expect(asked[0]).toMatchObject({ name: "build", ssh: "alice@build", docker: true })
  const plan = installationPlan(enrollmentOptions({ name: "build", ssh: "alice@build", docker: true, artifact: { path: "/tmp/asd", sha256: "a".repeat(64) } }), probe, { version: VERSION, sourceDigest: "b".repeat(64) })
  expect(plan.steps.length).toBeGreaterThan(10)
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
  for (const step of plan.steps) {
    expect(out).toContain(clean(step.label))
    expect(out).toContain(clean(step.argv.map((arg) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ")))
    for (const left of step.leaves) expect(out).toContain(left)
  }
  for (const text of [
    `Plan hash: ${plan.hash}`, `sha256 ${"c".repeat(64)} becomes sha256 ${plan.changes[0]!.sha256}`, '    +    "asidee-runsc": {', '    +        "--net-raw"',
    `gvisor.tar.bz2: sha512 ${GVISOR.aarch64.archive}`, `takes gvisor-bin/gvisor_sentry: sha256 ${GVISOR.aarch64.files["gvisor-bin/gvisor_sentry"]}`,
    `asd: sha256 ${"a".repeat(64)}, uploaded from /tmp/asd`, "Docker restart: planned. It may interrupt every running container (2):", "sandbox-mine (456)",
    "Asidee service restart: none planned.", "Docker inside sandboxes: offered", `from ${plan.verification.image}`, "with Docker inside", "Disk limit: watched",
    `Helper image ${plan.verification.helperImage}, built on the destination from this Dockerfile:`, ...plan.verification.helperDockerfile.trim().split("\n").map((line) => `    ${line}`),
  ]) expect(out).toContain(text)
  expect(out).not.toContain("Blockers")
  expect(out).toContain("Interactive apply may ask for a password with `sudo -v`")
  expect(out).toContain("--accept-plan never prompts and requires noninteractive sudo")
  expect(out + err).not.toMatch(/[\x1b\x9b\u202e]/)
  // The line a forged check mark would have started is still one line of the diff.
  expect(out.split("\n").filter((line) => line.includes("forged")).every((line) => /^(    [ +-]|  Machine:|Docker restart:|  - )/.test(line))).toBe(true)

  // Without the option the plan says inner Docker is not offered, and a blocker is shown as one.
  const plain = await asidee(...args)
  expect(asked[1]!.docker).toBeUndefined()
  expect(plain.out).toContain("Docker inside sandboxes: not offered")
  expect(plain.out).not.toContain("--net-raw\"")
  probe.files["/usr/local/bin/asd"] = { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/other" }
  const blocked = await asidee(...args, "--accept-plan", "0".repeat(64))
  expect(blocked.code).toBe(4)
  expect(blocked.out).not.toContain("asks for the password once")
  expect(blocked.out).toContain("Blockers (1); nothing is installed while one remains:\n  ✗ /usr/local/bin/asd is unrelated")
  // --json is the whole plan and nothing else.
  const json = JSON.parse((await asidee("--json", ...args)).out)
  expect(json.data.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(json.data.destination.machine).toBe(`m${ESC}`)
  const never = await asidee(...args, "--sudo", "never")
  expect(never.out).toContain("Privileged commands: none.")
  expect(never.out).not.toContain("asks for the password")
}, 30_000)

test("transport stdio hands SSH every byte the daemon sent before it exits, even to a slow reader", async () => {
  const state = await mkdtemp(join(tmpdir(), "asd-relay-")); const piece = Buffer.alloc(65536, 7); const pieces = 128
  // Ends its side as a stream does after the exit frame, while the reader is still behind.
  const server = createServer(async (socket) => {
    for (let at = 0; at < pieces; at++) if (!socket.write(piece)) await new Promise((resolve) => socket.once("drain", resolve))
    socket.end()
  })
  await new Promise<void>((resolve) => server.listen(streamSocketPath({ state, config: state }), resolve))
  cleanups.push(async () => { await new Promise((resolve) => server.close(resolve)); await rm(state, { recursive: true, force: true }) })
  // stdin stays open, as SSH keeps it, so only the daemon's side ending makes the relay exit.
  const run = Bun.spawn([process.execPath, CLI, "transport", "stdio", "--protocol", "1", "--stream"], { env: { ...process.env, ASIDEE_STATE_DIR: state, ASIDEE_CONFIG_DIR: state }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  let received = 0
  for await (const chunk of run.stdout) { received += chunk.length; await Bun.sleep(2) }
  expect(await run.exited).toBe(0)
  expect(received).toBe(piece.length * pieces)
  run.stdin.end()
}, 30_000)

test("config get/set route settings and support JSON; invalid commands are refused", async () => {
  const calls: unknown[] = []
  const asidee = await daemon({ configGet: (body: unknown) => { calls.push(body); return { ok: true, data: { defaults: {}, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" } } },
    configSet: (body: { requireProbes?: boolean; experimental?: boolean; workspaceFreeSpaceGb?: number; diskWatchSeconds?: number }) => { calls.push(body); return { ok: true, data: { defaults: {}, requireProbes: body.requireProbes ?? true, experimental: body.experimental ?? false, workspaceFreeSpaceGb: body.workspaceFreeSpaceGb ?? 5, diskWatchSeconds: body.diskWatchSeconds ?? 5, terminal: "default" } } } })
  expect(await asidee("config", "get")).toMatchObject({ code: 0, out: "require-probes on\nexperimental off\nremote-create off\nworkspace-free-space 5 GiB\ndisk-watch 5 s\nengine auto\ndefault-image auto (docker/sandbox-templates:shell-docker)\ndefault-cpus auto (2)\ndefault-memory auto (4 GiB)\ndefault-pids auto (4096)\ndefault-disk auto (20 GiB)\ndefault-docker auto (off)\ndefault-template auto (none)\nterminal default\nterminal-command none\n" })
  expect(await asidee("config", "set", "disk-watch", "1")).toMatchObject({ code: 0, out: "disk-watch 1 s\n" })
  expect(await asidee("config", "set", "workspace-free-space", "12.5")).toMatchObject({ code: 0, out: "workspace-free-space 12.5 GiB\n" })
  expect(await asidee("config", "set", "require-probes", "off")).toMatchObject({ code: 0, out: "require-probes off\n" })
  expect(await asidee("config", "set", "experimental", "on")).toMatchObject({ code: 0, out: "experimental on\n" })
  const json = await asidee("--host", "build", "config", "set", "require-probes", "on", "--json")
  expect(JSON.parse(json.out)).toEqual({ ok: true, data: { defaults: {}, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" } })
  expect(calls).toEqual([{}, { diskWatchSeconds: 1 }, { workspaceFreeSpaceGb: 12.5 }, { requireProbes: false }, { experimental: true }, { host: "build", requireProbes: true }])
  expect(JSON.parse((await asidee("config", "get", "--json")).out).data.requireProbes).toBe(true)
  for (const args of [["get", "extra"], ["set", "require-probes", "false"], ["set", "require-probes"], ["set", "bogus", "on"], ["set", "experimental", "yes"], ["set", "workspace-free-space", "lots"], ["set", "workspace-free-space", "on"], ["set", "disk-watch", "fast"], ["set", "disk-watch"], ["set", "require-probes", "5"]]) {
    expect((await asidee("config", ...args)).code).toBe(2)
  }
})

test("config sets the engine, what a new sandbox gets and the terminal; the custom command goes through its own method", async () => {
  const calls: Array<[string, unknown]> = []
  let config: Record<string, unknown> = { defaults: { cpus: 1 }, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" }
  const set = (method: string) => (body: Record<string, unknown>) => { calls.push([method, body]); config = { ...config, ...body }; for (const key of Object.keys(body)) if (body[key] === null) delete config[key]; return { ok: true, data: config } }
  const asidee = await daemon({ configGet: () => ({ ok: true, data: config }), configSet: set("configSet"), terminalCommandSet: (body: Record<string, unknown>) => set("terminalCommandSet")({ ...body, terminal: body.terminalCommand === null ? "default" : "custom" }) })
  expect(await asidee("config", "set", "engine", "gvisor:orbstack")).toMatchObject({ code: 0, out: "engine gvisor:orbstack\n" })
  expect(await asidee("config", "set", "engine", "auto")).toMatchObject({ code: 0, out: "engine auto\n" })
  expect(await asidee("config", "set", "default-memory", "8")).toMatchObject({ code: 0, out: "default-memory 8 GiB\n" })
  expect(await asidee("config", "set", "default-docker", "on")).toMatchObject({ code: 0, out: "default-docker on\n" })
  expect(await asidee("config", "set", "default-cpus", "auto")).toMatchObject({ code: 0, out: "default-cpus auto (2)\n" })
  expect(await asidee("config", "set", "terminal", "ghostty")).toMatchObject({ code: 0, out: "terminal ghostty\n" })
  expect(await asidee("config", "set", "terminal-command", "kitty sh -c {command}")).toMatchObject({ code: 0, out: "terminal-command kitty sh -c {command} (terminal custom)\n" })
  expect(await asidee("config", "set", "terminal-command", "none")).toMatchObject({ code: 0, out: "terminal-command none (terminal default)\n" })
  expect(calls).toEqual([["configSet", { engine: "gvisor:orbstack" }], ["configSet", { engine: null }], ["configSet", { defaults: { cpus: 1, memoryGb: 8 } }], ["configSet", { defaults: { cpus: 1, memoryGb: 8, docker: true } }],
    ["configSet", { defaults: { memoryGb: 8, docker: true } }], ["configSet", { terminal: "ghostty" }], ["terminalCommandSet", { terminalCommand: "kitty sh -c {command}", terminal: "custom" }], ["terminalCommandSet", { terminalCommand: null, terminal: "default" }]])
})

test("a required-probe refusal prints the reason and exact local or hosted command with exit 6", async () => {
  const error = { code: "probes-required", message: "demo was created but stopped: Cannot reach the host (helper image unavailable). Required isolation probes could not run.", details: [{ id: "net-host", status: "unknown", evidence: "none", detail: "helper image unavailable" }] }
  const asidee = await daemon({ create: { ok: false, error } })
  for (const host of [[], ["--host", "build"]]) {
    const refused = await asidee(...host, "create", "demo")
    expect(refused.code).toBe(6)
    expect(refused.err).toContain("Cannot reach the host (helper image unavailable)")
    expect(refused.err).toContain(`asd${host.length ? " --host build" : ""} config set require-probes off`)
    const json = await asidee(...host, "create", "demo", "--json")
    expect(json.code).toBe(6)
    expect(JSON.parse(json.out)).toEqual({ ok: false, error })
    expect(json.err).toBe("")
  }
})


test("workspace host-temp parses create/set, reports state and disclosure in text and JSON", async () => {
  const calls: unknown[] = []
  const view = (hostTemp: boolean) => ({ kind: "workspace", name: "render", status: "idle", spec: { hostTemp }, disclosure: workspaceDisclosure(hostTemp) })
  const asidee = await daemon({
    workspaceCreate: (body: { hostTemp: boolean }) => { calls.push(body); return { ok: true, data: { workspace: view(body.hostTemp), checks: [], ok: true } } },
    workspaceSet: (body: { hostTemp: boolean }) => { calls.push(body); return { ok: true, data: view(body.hostTemp) } },
    workspaceExec: { ok: true, data: { exitCode: 0, stdout: "", stderr: "" } },
    workspaceGet: { ok: true, data: view(true) }, workspaceList: { ok: true, data: [view(true), { ...view(false), name: "closed" }] },
  })
  expect((await asidee("workspace", "create", "render", "--host-temp")).out).toContain(HOST_TEMP_DISCLOSURE)
  expect(calls[0]).toMatchObject({ name: "render", hostTemp: true })
  await asidee("workspace", "create", "render")
  expect(calls[1]).toMatchObject({ name: "render", hostTemp: false })
  expect((await asidee("workspace", "set", "render", "host-temp", "on")).out).toContain("host-temp on (shared, weaker)")
  const json = await asidee("workspace", "set", "render", "host-temp", "off", "--json")
  expect(JSON.parse(json.out).data.spec.hostTemp).toBe(false)
  expect(calls[3]).toEqual({ name: "render", hostTemp: false })
  for (const args of [["render", "bogus", "on"], ["render", "host-temp", "yes"], ["render", "host-temp"], ["render", "host-temp", "off", "extra"]]) expect((await asidee("workspace", "set", ...args)).code).toBe(2)
  for (const action of ["list", "get"]) {
    const text = await asidee("workspace", action, ...(action === "get" ? ["render"] : []))
    expect(text.out).toContain("host-temp on (shared, weaker)")
    expect(text.out).toContain(HOST_TEMP_DISCLOSURE)
    const result = JSON.parse((await asidee("workspace", action, ...(action === "get" ? ["render"] : []), "--json")).out).data
    expect((action === "list" ? result[0] : result).spec.hostTemp).toBe(true)
  }
  expect((await asidee("workspace", "verify", "render", "--host-temp")).code).toBe(2)
  expect((await asidee("workspace", "exec", "render", "--", "true")).err).toContain(HOST_TEMP_DISCLOSURE)
  expect((await asidee("help")).out).toContain("workspace set NAME host-temp on|off")
})

test("a refused workspace launch ends its sentence once and names workspace checks by their titles", async () => {
  const details = [
    { id: "seatbelt", status: "fail", evidence: "none", detail: "The workspace profile changed; execution refused. Run: asd workspace set render host-temp on" },
    { id: "processes", status: "unknown", evidence: "none", detail: "This workspace check could not be made." },
    // In both checklists, with different titles.
    { id: "credentials", status: "unknown", evidence: "none", detail: "Not measured." },
  ]
  const error = { code: "check-failed", message: "Workspace execution refused by its checklist: Runs under its workspace profile (fail): The workspace profile changed.", details }
  const asidee = await daemon({ workspaceExec: { ok: false, error }, workspaceGet: { ok: true, data: { kind: "workspace", name: "render", status: "idle", spec: { hostTemp: false }, disclosure: WORKSPACE_DISCLOSURE } } })
  const refused = await asidee("workspace", "exec", "render", "--", "true")
  expect(refused.code).toBe(6)
  expect(refused.err).toContain("asd: Workspace execution refused by its checklist. These checks did not hold:\n")
  expect(refused.err).not.toContain("..")
  for (const id of ["seatbelt", "processes", "credentials"]) expect(refused.err).toContain(WORKSPACE_CHECKLIST.find((item) => item.id === id)!.title)
  expect(refused.err).not.toContain(CHECKLIST.find((item) => item.id === "credentials")!.title)
  expect(refused.err).toContain("asd workspace set render host-temp on")
  expect(refused.err).not.toMatch(/^\s+\S+ (seatbelt|processes|credentials)$/m)
})

test("workspace status lines leave size out where it was not measured and say unknown only where it was tried", async () => {
  const view = (sizeBytes?: number) => ({ kind: "workspace", name: "render", folder: "/w/render", status: "idle", processes: 0, spec: { hostTemp: false }, disclosure: WORKSPACE_DISCLOSURE, ...(sizeBytes === undefined ? {} : { sizeBytes }) })
  const report = { workspace: view(), ok: true, checks: [] }
  const asidee = await daemon({ workspaceCreate: { ok: true, data: report }, workspaceVerify: { ok: true, data: report }, workspaceSet: { ok: true, data: view() },
    workspaceStop: { ok: true, data: view() }, workspaceGet: { ok: true, data: view() }, workspaceList: { ok: true, data: [view(3 * 1024 ** 2)] } })
  for (const args of [["create", "render"], ["verify", "render"], ["set", "render", "host-temp", "off"], ["stop", "render"]]) {
    const { out, code } = await asidee("workspace", ...args)
    expect(code).toBe(0)
    expect(out).toContain("render: workspace, not a sandbox; idle, host-temp off, 0 processes\n")
    expect(out).not.toContain("size")
  }
  expect((await asidee("workspace", "get", "render")).out).toContain("0 processes, size unknown")
  expect((await asidee("workspace", "list")).out).toContain("0 processes, 0.00 GiB")
})

test("workspace disk: create and set send the limit, status shows it and a stop reason, and a launch over it warns in text and JSON", async () => {
  const calls: unknown[] = []
  const warning = { usedBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, message: "render uses 2.00 GB of its 1 GB disk limit, so the daemon stops its processes again within about 30 seconds unless space is freed. Free space in /w/render, or raise the limit: asd workspace set render disk N" }
  const view = { kind: "workspace", name: "render", folder: "/w/render", status: "idle", processes: 0, spec: { hostTemp: false, diskGb: 1 }, disclosure: WORKSPACE_DISCLOSURE,
    stopReason: "Stopped by the daemon at 2026-11-16T10:00:00Z: render uses 2.00 GB of its 1 GB disk limit. Free space in /w/render, or raise the limit: asd workspace set render disk N",
    enforcementProblem: { at: "2026-11-16T10:00:30Z", message: "Its size could not be measured." } }
  const result = { exitCode: 0, stdout: "out\n", stderr: "", diskWarning: warning }
  const asidee = await daemon({
    workspaceCreate: (body: unknown) => { calls.push(body); return { ok: true, data: { workspace: view, checks: [], ok: true } } },
    workspaceSet: (body: unknown) => { calls.push(body); return { ok: true, data: view } },
    workspaceGet: { ok: true, data: view }, workspaceExec: { ok: true, data: result },
  })
  await asidee("workspace", "create", "render", "--disk", "7", "--no-logins")
  expect(calls[0]).toMatchObject({ name: "render", diskGb: "7" })
  await asidee("workspace", "create", "other", "--no-logins")
  expect(calls[1]).not.toHaveProperty("diskGb")
  const set = await asidee("workspace", "set", "render", "disk", "2.5")
  expect(set.code).toBe(0); expect(calls[2]).toEqual({ name: "render", diskGb: 2.5 })
  for (const args of [["set", "render", "disk"], ["set", "render", "disk", "lots"], ["set", "render", "disk", "on"], ["get", "render", "--disk", "3"]]) expect((await asidee("workspace", ...args)).code).toBe(2)
  const shown = (await asidee("workspace", "get", "render")).out
  expect(shown).toContain("0 processes, size unknown, disk limit 1 GiB (watched)\n")
  expect(shown).toContain(`\n  ${view.stopReason}\n`)
  expect(shown).toContain("\n  Disk watch unknown at 2026-11-16T10:00:30Z: Its size could not be measured.")
  const text = await asidee("workspace", "exec", "render", "--", "true")
  expect(text.code).toBe(0); expect(text.out).toBe("out\n"); expect(text.err).toContain(`${warning.message}\n`)
  const json = await asidee("--json", "workspace", "exec", "render", "--", "true")
  expect(JSON.parse(json.out).data.diskWarning).toEqual(warning); expect(json.err).toBe("")
  expect((await asidee("help")).out).toContain("asd workspace set NAME disk GiB")
})

test("a workspace stream session prints the disk warning that comes with ready", async () => {
  const asidee = await daemon({ workspaceGet: { ok: true, data: { kind: "workspace", name: "render", status: "idle", spec: { hostTemp: false, diskGb: 1 }, disclosure: WORKSPACE_DISCLOSURE } } })
  const state = asidee.env.ASIDEE_STATE_DIR!
  const message = "render uses 2.00 GB of its 1 GB disk limit. Free space in /w/render, or raise the limit: asd workspace set render disk N"
  const server = createServer((socket) => socket.once("data", () => socket.end(Buffer.concat([frame("ready", { tty: false, diskWarning: { usedBytes: 2, limitBytes: 1, message } }), frame("exit", { code: 0 })]))))
  await new Promise<void>((resolve) => server.listen(streamSocketPath({ state, config: state }), resolve))
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  const run = await asidee("workspace", "exec", "render", "--stream", "--", "true")
  expect(run.code).toBe(0); expect(run.err).toContain(`${message}\n`)
})

test("help is grouped by task, and each command answers --help with its own usage", async () => {
  const asidee = await daemon({})
  const top = await asidee("help")
  for (const group of ["Start here", "Use a sandbox", "Reach in", "Change a sandbox", "Settings", "Other machines"]) expect(top.out).toContain(`\n${group}`)
  // Help may run without a daemon, so it says what is true either way: experimental, off unless turned on.
  expect(top.out).toContain("\nOther machines (experimental, off unless turned on: asd config set experimental on)\n")
  expect(top.out).toContain("asd config set experimental on|off")
  expect(top.out).toContain("--host NAME   select a registered machine (experimental)")
  const usage = async (...args: string[]) => { const result = await asidee(...args); expect(result.code).toBe(0); return result.out }
  for (const [args, has, lacks] of [
    [["create", "--help"], "asd create NAME", "asd remove"],
    [["create", "demo", "-h"], "asd create NAME", "asd remove"],
    [["help", "stop"], "asd stop NAME", "workspace"],
    [["forward", "remove", "--help"], "forward remove ID", "forward add"],
    [["workspace", "set", "--help"], "workspace set NAME host-temp on|off", "workspace create"],
    [["workspace", "--help"], "workspace create NAME", "asd create NAME"],
    [["rm", "--help"], "asd remove NAME --confirm NAME", "workspace"],
  ] as const) {
    const text = await usage(...args)
    expect(text).toContain(has); expect(text).not.toContain(lacks); expect(text).toContain("--help   after any command")
  }
  const unknown = await asidee("bogus", "--help")
  expect(unknown.code).toBe(2); expect(unknown.err).toContain("Unknown command bogus")
})

test("argument errors name the option and point to the command's help", async () => {
  const asidee = await daemon({})
  for (const [args, message] of [
    [["create", "demo", "--bogus"], "asd: asd create has no option --bogus. See `asd create --help`."],
    [["forward", "add", "demo", "--port"], "asd: --port needs a value. See `asd forward add --help`."],
    [["create", "demo", "--docker=yes"], "asd: --docker takes no value. See `asd create --help`."],
    [["workspace", "create", "w", "--copy"], "asd: --copy needs a value. See `asd workspace create --help`."],
    [["ext", "run", "--bogus"], "asd: asd ext run has no option --bogus. See `asd ext run --help`."],
  ] as const) {
    const result = await asidee(...args)
    expect(result.code).toBe(2)
    expect(result.err.trim()).toBe(message)
  }
})

test("create counts the checks that held, prints every other result in full, a legend of the marks shown and the next step", async () => {
  const check = (id: string, status: string, detail: string) => ({ id, status, evidence: "inspected", detail })
  const checks = [check("kernel", "pass", "gVisor answered."), check("mounts", "pass", "No mounts."), check("limits", "pass", "4 GB."),
    check("disk", "weak", "Watched, not capped."), check("egress", "info", "Open: anything inside can be sent out.")]
  const sandbox = { name: "demo", status: "running", engine: "Fake", spec: { cpus: 1, memoryGb: 1 } }
  const asidee = await daemon({ create: { ok: true, data: { sandbox, checks, hooks: [] } }, verify: { ok: true, data: { sandbox, checks, ok: true } },
    resize: { ok: true, data: { sandbox, changes: [], checks } } })
  const made = await asidee("create", "demo")
  expect(made.code).toBe(0)
  expect(made.out).toContain("  ✓ 3 checks hold. Each one is listed by `asd verify demo`.\n")
  for (const title of ["Runs on an isolated kernel", "No host folders are mounted"]) expect(made.out).not.toContain(title)
  expect(made.out).toContain("~ Disk use is limited [weak]\n      Watched, not capped. (inspected)")
  expect(made.out).toContain("i Internet access\n      Open: anything inside can be sent out. (inspected)")
  expect(made.out).toContain("  ✓ holds   ~ holds in a weaker form   i for your information\n")
  expect(made.out).not.toContain("not available on this engine")
  expect(made.out.trimEnd().endsWith("Next: asd shell demo")).toBe(true)
  expect((await asidee("resize", "demo", "--memory", "2")).out).toContain("  ✓ 3 checks hold. Each one is listed by `asd verify demo`.")
  const verified = await asidee("verify", "demo")
  for (const title of ["Runs on an isolated kernel", "No host folders are mounted", "Memory, process and CPU limits are set"]) expect(verified.out).toContain(title)
  expect(verified.out).not.toContain("checks hold")
})

test("a refused create names the command that removes what it kept", async () => {
  const failed = [{ id: "net-host", status: "fail", evidence: "probed", detail: "A connection reached the host." }]
  const asidee = await daemon({ create: { ok: false, error: { code: "check-failed", message: "demo was created but stopped, and is kept for diagnosis: Cannot reach the host (A connection reached the host.)", details: failed } } })
  const refused = await asidee("create", "demo")
  expect(refused.code).toBe(6)
  expect(refused.err.trimEnd().endsWith("Remove it: asd remove demo --confirm demo")).toBe(true)
})

test("a create that did not finish says when it is removed and how to retry, keep or remove it", async () => {
  const unfinished = { stage: "setup", reason: "Its setup step Clone o/r failed.", removeAt: "2026-11-21T10:00:00.000Z", setup: { repo: "o/r" }, done: [], failed: "Clone o/r" }
  const view = { name: "demo", status: "running", engine: "Fake", spec: { cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, image: "ubuntu:24.04" }, unfinished }
  const calls: unknown[] = []
  const asidee = await daemon({ get: { ok: true, data: view }, list: { ok: true, data: [view] },
    createKeep: (body: unknown) => { calls.push(["createKeep", body]); return { ok: true, data: { ...view, unfinished: undefined } } },
    createRetry: (body: unknown) => { calls.push(["createRetry", body]); return { ok: true, data: { sandbox: { ...view, unfinished: undefined }, checks: [], remaining: [] } } } })
  const got = await asidee("get", "demo")
  expect(got.out).toContain("Its setup did not finish: Its setup step Clone o/r failed. It is removed at 2026-11-21 10:00 UTC unless that is done: asd create --retry demo")
  expect(got.out).toContain("To keep it as it is: asd create --keep demo. To remove it now: asd remove demo --confirm demo")
  expect((await asidee("list")).out).toContain("Unfinished create, removed at 2026-11-21 10:00 UTC: Its setup step Clone o/r failed. To finish it: asd create --retry demo")
  const kept = await asidee("create", "--keep", "demo")
  expect([kept.code, kept.out.trim()]).toEqual([0, "demo is kept as it is. The setup steps that did not run will not run; it is not removed."])
  const retried = await asidee("create", "--retry", "demo")
  expect(retried.code).toBe(0)
  expect(retried.out).toContain("Next: asd shell demo")
  for (const args of [["--retry", "--keep"], ["--retry", "--docker"], ["--keep", "--repo", "o/r"]]) expect((await asidee("create", "demo", ...args)).code).toBe(2)
  expect(calls).toEqual([["createKeep", { name: "demo" }], ["createRetry", { name: "demo" }]])
})

test("a relative --copy folder is sent from the folder the command runs in; ~ and absolute ones as given", async () => {
  const bodies: unknown[] = []
  const asidee = await daemon({ create: (body: unknown) => { bodies.push(body); return { ok: false, error: { code: "usage", message: "Refused here." } } } })
  expect((await asidee("create", "demo", "--copy", "scratch/copytest:/root/copytest", "--copy", "~/.agents", "--copy", "/abs/kit:~/kit")).code).toBe(2)
  expect(bodies).toMatchObject([{ name: "demo", setup: { copy: [`${process.cwd()}/scratch/copytest:/root/copytest`, "~/.agents", "/abs/kit:~/kit"] } }])
})

test("a create refused by its checks prints how long it is kept and how to retry", async () => {
  const failed = [{ id: "net-host", status: "fail", evidence: "probed", detail: "A connection reached the host." }]
  const note = "It is kept for diagnosis until 2026-11-21 10:00 UTC, then removed. To try again: `asd create --retry demo`. To remove it now: `asd remove demo --confirm demo`."
  const asidee = await daemon({ create: { ok: false, error: { code: "check-failed", message: `demo was created but stopped: Cannot reach the host (A connection reached the host.). ${note}`, details: failed } } })
  const refused = await asidee("create", "demo")
  expect(refused.code).toBe(6)
  expect(refused.err.trimEnd().endsWith(note)).toBe(true)
})

test("template and forward times are shown in UTC whatever offset the engine reported", async () => {
  const template = { name: "tpl", engine: "Fake", imageId: "sha256:t", source: "a", sourceImage: "img", createdAt: "2026-11-16T01:46:52+05:30", sizeBytes: 0, loginsRemoved: [], dependants: [] }
  const forward = { id: "f1", name: "demo", sandboxId: "s", generation: "g", localAddress: "127.0.0.1", localPort: 5000, port: 3000, connections: 0, createdAt: "2026-11-15T20:16:00.000Z" }
  const asidee = await daemon({ templateList: { ok: true, data: [template] }, forwardList: { ok: true, data: [forward] } })
  expect((await asidee("template", "list")).out).toContain("2026-11-15 20:16 UTC")
  expect((await asidee("forward", "list")).out).toContain("since 2026-11-15 20:16 UTC")
})

test("forward add says who can connect and how to remove it", async () => {
  const forward = { id: "f1", name: "demo", sandboxId: "s", generation: "g", localAddress: "127.0.0.1", localPort: 5000, port: 3000, connections: 0, createdAt: "2026-11-15T20:16:00.000Z" }
  const asidee = await daemon({ forwardAdd: { ok: true, data: forward } })
  const { out } = await asidee("forward", "add", "demo", "--port", "3000")
  expect(out).toContain("Any process on this machine can connect to it, and so can whatever the engine relays to its loopback")
  expect(out).toContain("Remove it: asd forward remove f1")
  expect(out).not.toContain("the sandbox run,")
})

test("link add says what it reaches and what the other side trusts; list and remove say their state", async () => {
  const link = { from: "web", to: "db", port: 5432, address: "127.77.0.2", createdAt: "2026-11-15T20:16:00.000Z", state: "open", connections: 1,
    measured: { at: "2026-11-15T20:16:00.000Z", status: "pass", detail: "ok" }, trust: "db sees these connections as local (from 127.0.0.1 inside db), so a service in db that trusts local connections trusts web." }
  const asidee = await daemon({ linkAdd: { ok: true, data: link }, linkList: { ok: true, data: [link] },
    linkRemove: { ok: true, data: { removed: { from: "web", to: "db", port: 5432 }, measured: "Measured: 127.77.0.2:5432 now refuses connections inside web." } } })
  const added = (await asidee("link", "add", "web", "db", "--port", "5432")).out
  expect(added).toContain("Linked: programs in web connect to db:5432 (127.77.0.2:5432) and reach port 5432 on db's loopback, nothing else.")
  expect(added).toContain("a service in db that trusts local connections trusts web.")
  expect(added).toContain("up to 64 connections at once, and is down while the daemon is not running.")
  expect((await asidee("link", "list")).out.trim()).toBe("web -> db:5432  open, 1 connection; measured 2026-11-15 20:16 UTC: pass")
  expect((await asidee("link", "remove", "web", "db", "--port", "5432")).out.trim()).toBe("Removed the link from web to db:5432. Measured: 127.77.0.2:5432 now refuses connections inside web.")
  const help = await asidee("link", "add", "--help")
  expect(help.out).toContain("asd link add FROM TO --port PORT"); expect(help.out).not.toContain("forward add")
  expect((await asidee("link", "add", "web", "db")).err).toContain("Missing --port")
})

test("a link to an address says where the daemon relays it and what that address trusts", async () => {
  const link = { from: "agent", to: "vm", toAddress: "192.168.64.5", port: 22, address: "127.77.0.2", createdAt: "2026-11-15T20:16:00.000Z", state: "open", connections: 0,
    measured: { at: "2026-11-15T20:16:00.000Z", status: "pass", detail: "ok" }, trust: "agent can open connections to 192.168.64.5:22 as this machine, so whatever there trusts this machine trusts agent; and what that address can reach (the internet, the local network) is outside Asidee's checks." }
  const asidee = await daemon({ linkAdd: { ok: true, data: link }, linkList: { ok: true, data: [link] } })
  const added = (await asidee("link", "add", "agent", "vm", "--address", "192.168.64.5", "--port", "22")).out
  expect(added).toContain("Linked: programs in agent connect to vm:22 (127.77.0.2:22), and the daemon relays each connection to 192.168.64.5:22 from this machine. Measured just now.")
  expect(added).toContain("what that address can reach (the internet, the local network) is outside Asidee's checks.")
  expect((await asidee("link", "list")).out.trim()).toBe("agent -> vm:22 (192.168.64.5:22)  open, 0 connections; measured 2026-11-15 20:16 UTC: pass")
  expect((await asidee("link", "add", "--help")).out).toContain("asd link add FROM NAME --address IP --port PORT")
})

test("ssh access says why it is not ready and what to run", async () => {
  const access = (user: string) => ({ alias: "demo.asidee", user, home: user ? "/home/agent" : "", batchReady: false, loopbackForwarding: Boolean(user) })
  const unset = await (await daemon({ sshAccess: { ok: true, data: access("") } }))("ssh", "access", "demo")
  expect(unset.out.trim()).toBe("demo.asidee: not set up; not ready: run `asd ssh setup demo`")
  const stopped = await (await daemon({ sshAccess: { ok: true, data: access("agent") }, get: { ok: true, data: { name: "demo", status: "stopped" } } }))("ssh", "access", "demo")
  expect(stopped.out.trim()).toBe("demo.asidee: agent, home /home/agent; not ready: demo is stopped. Start it with `asd start demo`")
})

test("ui and daemon status say there is no dashboard instead of printing port 0", async () => {
  const asidee = await daemon({})
  await writeFile(join(asidee.env.ASIDEE_STATE_DIR, "daemon.json"), JSON.stringify({ pid: 1, port: 0, token: "t", version: VERSION }))
  const ui = await asidee("ui")
  expect(ui.code).toBe(0)
  expect(ui.out.trim()).toBe("No dashboard: this daemon was started with ASIDEE_SOCKET_ONLY=1, so it answers on its socket only.")
  expect((await asidee("daemon", "status")).out).toContain("no dashboard (socket only)")
})

test("start says what it checked and did not, and doctor and workspace create end with the next command", async () => {
  const sandbox = { name: "demo", status: "running", engine: "Fake", spec: { cpus: 1, memoryGb: 1 } }
  const workspace = { kind: "workspace", name: "render", folder: "/w/render", status: "idle", processes: 0, spec: { hostTemp: false }, disclosure: WORKSPACE_DISCLOSURE }
  const engine = (ready: boolean) => ({ id: "fake:1", provider: "fake", label: "Fake", ready, problems: [], data: {} })
  const asidee = await daemon({ start: { ok: true, data: sandbox }, engines: { ok: true, data: [engine(true)] },
    workspaceCreate: { ok: true, data: { workspace, ok: true, checks: [{ id: "seatbelt", status: "pass", evidence: "inspected", detail: "ok" }] } } })
  expect((await asidee("start", "demo")).out).toContain("Its configuration was checked before it started and its runtime after; its network was not tested. To test it: asd verify demo")
  expect((await asidee("doctor")).out.trimEnd().endsWith("Next: asd create NAME")).toBe(true)
  const created = await asidee("workspace", "create", "render", "--no-logins")
  expect(created.out).toContain("✓ 1 check holds. Each one is listed by `asd workspace verify render`.")
  expect(created.out.trimEnd().endsWith("Next: asd workspace shell render")).toBe(true)
  const none = await (await daemon({ engines: { ok: true, data: [engine(false)] } }))("doctor")
  expect(none.out).not.toContain("Next:")
})

test("B11: doctor exits 5 with no engines or with unavailable engines", async () => {
  const asidee = await daemon({ engines: { ok: true, data: [] }, verify: { ok: true, data: { sandbox: { name: "demo", status: "stopped", engine: "fake" }, configurationOnly: true, checks: [], ok: true } } })
  expect((await asidee("doctor")).code).toBe(5)
  const unavailable = await daemon({ engines: { ok: true, data: [{ id: "fake", label: "Fake engine", ready: false, problems: ["Engine unavailable."] }] } })
  expect((await unavailable("doctor")).code).toBe(5)
})

test("audit B12: stopped verify explains its scope", async () => {
  const asidee = await daemon({ verify: { ok: true, data: { sandbox: { name: "demo", status: "stopped", engine: "fake" }, configurationOnly: true, checks: [], ok: true } } })
  const verified = await asidee("verify", "demo")
  expect(verified.code).toBe(0)
  expect(verified.out.split("\n")[0]).toContain("stopped; only its configuration was checked")
  expect(verified.out).toContain("asd start demo")
})

test("B16: usage errors point to the command help", async () => {
  const asidee = await daemon({})
  for (const args of [["create"], ["snapshot", "demo"], ["workspace", "get"]]) {
    const result = await asidee(...args)
    expect(result.code).toBe(2)
    expect(result.err).toContain(`See \`asd ${args[0] === "workspace" ? "workspace get" : args[0]} --help\``)
  }
})

test("audit B4: stdin help names the opt-in", async () => {
  const asidee = await daemon({})
  for (const args of [["exec"], ["workspace", "exec"]]) expect((await asidee(...args, "--help")).out).toContain("Piped input is sent only with --stdin or --stream")
})

test("audit B2: workspace get and list include the saved stop reason", async () => {
  const view = { name: "demo", status: "idle", spec: { diskGb: 1 }, stopReason: "Stopped by the daemon: disk limit exceeded. Free space or raise the limit." }
  const asidee = await daemon({ workspaceGet: { ok: true, data: view }, workspaceList: { ok: true, data: [view] } })
  for (const args of [["workspace", "get", "demo"], ["workspace", "list"]]) expect((await asidee(...args)).out).toContain(view.stopReason)
})


test("audit B1: interrupted buffered mutations explain continued daemon work", async () => {
  for (const [method, args, workspace] of [
    ["create", ["create", "demo"], false], ["workspaceCreate", ["workspace", "create", "demo", "--no-logins"], true],
    ["resize", ["resize", "demo", "--memory", "2"], false], ["snapshot", ["snapshot", "demo", "--as", "saved"], false],
  ] as const) {
    let received!: () => void
    const ready = new Promise<void>((resolve) => { received = resolve })
    const asidee = await daemon({ [method]: async () => { received(); await Bun.sleep(1000); return { ok: true, data: {} } } })
    const child = Bun.spawn([process.execPath, CLI, ...args], { env: asidee.env, stdout: "pipe", stderr: "pipe" })
    await ready; child.kill("SIGINT")
    expect(await child.exited).toBe(130)
    const err = await new Response(child.stderr).text()
    expect(err.trim().split("\n")).toHaveLength(1)
    if (method === "resize") { expect(err).toContain("The daemon is still resizing demo"); expect(err).not.toContain("remove") }
    else if (method === "snapshot") { expect(err).toContain("still saving demo as template saved"); expect(err).toContain("asd template remove saved"); expect(err).not.toContain("--confirm") }
    else {
      expect(err).toContain("The daemon is still finishing demo")
      expect(err).toContain(`asd ${workspace ? "workspace " : ""}list`)
      expect(err).toContain(`asd ${workspace ? "workspace " : ""}remove demo --confirm demo`)
    }
  }
}, 10_000)

test("B14/B19: workspace text summarizes listeners and uses GiB; JSON keeps listener detail", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `process${i} ${700 + i} owner 10u IPv4 0x1234 0t0 TCP *:${8000 + i} (LISTEN)`)
  const detail = `Open. Current listeners, including wildcard binds reachable on loopback: ${[...lines, lines[0]].join("; ")}. Services started later are also reachable.`
  const workspace = { name: "demo", status: "idle", processes: 0, sizeBytes: 1024 ** 3, spec: { diskGb: 2 } }
  const report = { workspace, checks: [{ id: "loopback", status: "weak", evidence: "inspected", detail }], ok: true }
  const asidee = await daemon({ workspaceVerify: { ok: true, data: report }, workspaceGet: { ok: true, data: workspace } })
  const out = (await asidee("workspace", "verify", "demo")).out
  expect(out).toContain("8000 (process0)")
  expect(out).not.toContain("0x1234")
  expect(out).not.toContain("8008 (process8)")
  expect(out.split("8000 (process0)")).toHaveLength(2)
  expect(JSON.parse((await asidee("workspace", "verify", "demo", "--json")).out).data.checks[0].detail).toBe(detail)
  const got = (await asidee("workspace", "get", "demo")).out
  expect(got).toContain("1.00 GiB")
  expect(got).toContain("disk limit 2 GiB")
})

test("B22: an empty port still gets a forward, and remote lifetime text is only for a host", async () => {
  const asked: string[][] = []
  const asidee = await daemon({ forwardAdd: { ok: true, data: { id: "abcd", name: "demo", port: 9999, localPort: 4567 } }, exec: (body: { argv: string[] }) => { asked.push(body.argv.slice(1)); return { ok: true, data: { exitCode: 0, stdout: "Proto Recv-Q Send-Q Local Address Foreign Address State\ntcp        0      0 127.0.0.1:19999         0.0.0.0:*               LISTEN\ntcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN\n", stderr: "" } } } })
  const local = await asidee("forward", "add", "demo", "--port", "9999")
  expect(local.code).toBe(0)
  expect(local.out).toContain("nothing listens on 9999 inside yet")
  expect(local.out).not.toContain("SSH")
  const remote = await asidee("--host", "build", "forward", "add", "demo", "--port", "9999")
  expect(remote.out).toContain("SSH")
  expect(remote.out).toContain("nothing listens on 9999 inside yet")
  // The check reads the listeners; it never connects to the port, which would use up a one-connection server.
  for (const argv of asked) expect(argv).toEqual(["netstat", "-ltn"])
  const open = await daemon({ forwardAdd: { ok: true, data: { id: "abcd", name: "demo", port: 8080, localPort: 4567 } }, exec: { ok: true, data: { exitCode: 0, stdout: "tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN\n", stderr: "" } } })
  expect((await open("forward", "add", "demo", "--port", "8080")).out).not.toMatch(/nothing listens|Could not check/)
  const blind = await daemon({ forwardAdd: { ok: true, data: { id: "abcd", name: "demo", port: 8080, localPort: 4567 } }, exec: { ok: true, data: { exitCode: 127, stdout: "", stderr: "" } } })
  expect((await blind("forward", "add", "demo", "--port", "8080")).out).toContain("Could not check whether port 8080 listens inside")
})

test("B12: a verify that stops a running sandbox does not claim only configuration was checked", async () => {
  const asidee = await daemon({ verify: { ok: true, data: { sandbox: { name: "demo", status: "stopped", engine: "fake" }, configurationOnly: false, checks: [{ id: "net-host", status: "fail", evidence: "probed", detail: "Reached the host." }], ok: false } } })
  const result = await asidee("verify", "demo")
  expect(result.code).toBe(6)
  expect(result.out).not.toContain("only its configuration was checked")
  expect(result.out).toContain("Reached the host.")
})

test("share and unshare set a sandbox's visibility, ASIDEE_HOST selects a machine, and ext run aimed at one runs this machine's extension", async () => {
  const bodies: Record<string, Array<Record<string, unknown>>> = {}
  const spec = { name: "demo", image: "ubuntu:24.04", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, docker: false }
  const answer = (method: string, data: (body: Record<string, unknown>) => unknown) => (body: Record<string, unknown>) => { (bodies[method] ??= []).push(body); return { ok: true, data: data(body) } }
  const view = (visibility: unknown) => ({ name: "demo", status: "running", engine: "Fake engine", spec, createdAt: "2026-11-21T00:00:00Z", visibility })
  const asidee = await daemon({ visibilitySet: answer("visibilitySet", (body) => view(body.visibility)), get: answer("get", () => view("public")), action: answer("action", () => ({ exitCode: 0, stdout: "done\n", stderr: "" })) })
  const withHost = async (host: string, ...args: string[]) => {
    const run = Bun.spawn([process.execPath, CLI, ...args], { env: { ...asidee.env, ASIDEE_HOST: host }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    return { code, out, err }
  }
  expect(await asidee("share", "demo")).toMatchObject({ code: 0, out: "demo is public: other machines that route here see and use it. To make it private: asd unshare demo\n" })
  expect(await asidee("--host", "build", "unshare", "demo")).toMatchObject({ code: 0, out: "build/demo is private: only its own machine's Asidee sees it. This machine no longer sees it; only that machine can share it again. Anyone signed in to that machine's account can still see it.\n" })
  expect(bodies.visibilitySet).toEqual([{ name: "demo", visibility: "public" }, { name: "demo", visibility: "private", host: "build" }])
  expect(await asidee("get", "demo")).toMatchObject({ code: 0, out: expect.stringContaining("demo: running on Fake engine, public\n") })
  expect(await withHost("build", "get", "demo")).toMatchObject({ code: 0, out: expect.stringContaining("build/demo: running") })
  expect(bodies.get!.at(-1)).toEqual({ name: "demo", host: "build" })
  // The extension is this machine's: the action goes to this daemon, naming the machine its sandbox is on.
  expect(await asidee("--host", "build", "ext", "run", "folders", "copy", "demo", "--set", "source=~/.agents")).toMatchObject({ code: 0, out: "done\n" })
  expect(await withHost("build", "ext", "run", "t3", "setup", "demo")).toMatchObject({ code: 0 })
  expect(await asidee("ext", "run", "t3", "setup", "demo")).toMatchObject({ code: 0 })
  expect(bodies.action).toEqual([{ extension: "folders", action: "copy", sandbox: "demo", values: { source: "~/.agents" }, machine: "build" },
    { extension: "t3", action: "setup", sandbox: "demo", values: {}, machine: "build" }, { extension: "t3", action: "setup", sandbox: "demo", values: {} }])
  expect(await withHost("Not a name", "list")).toMatchObject({ code: 2, err: expect.stringContaining("asd: ") })
})
