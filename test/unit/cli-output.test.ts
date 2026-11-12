import { afterEach, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { VERSION } from "../../core/daemon"
import { enrollmentOptions, GVISOR, GVISOR_FILES, GVISOR_RELEASE, installationPlan, type HostProbe } from "../../core/hosts"
import { socketPath, streamSocketPath } from "../../core/state"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
const CLI = join(import.meta.dir, "../../cli/cli.ts")
const ESC = "\x1b[2J\x1b[H✓ forged\x9b31m‮"

// A daemon that answers as this build (so the CLI uses it) with text another machine chose. A reply that is a function
// is given the request's body.
async function daemon(replies: Record<string, unknown>, binary?: string) {
  const state = await mkdtemp(join(tmpdir(), "pdk-cli-"))
  const build = `${VERSION}+${Math.round(statSync(binary ?? CLI).mtimeMs)}`
  const server = Bun.serve({ unix: socketPath({ state, config: state }), fetch: async (request) => {
    const method = new URL(request.url).pathname.slice(5)
    if (method === "version") return Response.json({ ok: true, data: { version: VERSION, build } })
    const reply = replies[method]
    return method in replies ? Response.json(typeof reply === "function" ? reply(await request.json()) : reply) : Response.json({ ok: false, error: { code: "not-found", message: "No such method." } }, { status: 404 })
  } })
  cleanups.push(async () => { server.stop(true); await rm(state, { recursive: true, force: true }) })
  // Asynchronous, so this process keeps answering while the CLI runs.
  const env = { ...process.env, PADDOCK_STATE_DIR: state, PADDOCK_CONFIG_DIR: state }
  return Object.assign(async (...args: string[]) => {
    const run = Bun.spawn([...(binary ? [binary] : [process.execPath, CLI]), ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
    return { code, out, err }
  }, { env })
}

test("buffered exec and JSON preserve inherited file offsets on both output streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-output-")); cleanups.push(() => rm(root, { recursive: true, force: true }))
  const binary = join(root, "paddock")
  const build = Bun.spawn([process.execPath, "build", "--compile", "--minify", CLI, "--outfile", binary], { stdout: "pipe", stderr: "pipe" })
  expect(await build.exited).toBe(0)
  const result = { exitCode: 0, stdout: `Xé\u0000${"x".repeat(100_000)}\n`, stderr: "Eé\n" }
  for (const executable of [undefined, binary]) {
    const paddock = await daemon({ exec: { ok: true, data: result }, workspaceExec: { ok: true, data: result } }, executable)
    for (const workspace of [false, true]) for (const json of [false, true]) {
      const out = join(root, "out"); const err = join(root, "err")
      const script = 'task_out=$1; task_err=$2; shift 2; { printf b1; printf e1 >&2; "$@"; printf b2; printf e2 >&2; } > "$task_out" 2> "$task_err"'
      const args = [...(json ? ["--json"] : []), ...(workspace ? ["workspace"] : []), "exec", "demo", "--", "/bin/echo", "X"]
      const child = Bun.spawn(["/bin/sh", "-c", script, "sh", out, err, ...(executable ? [executable] : [process.execPath, CLI]), ...args], { env: paddock.env, stdout: "pipe", stderr: "pipe" })
      expect(await child.exited).toBe(0)
      expect(await readFile(out)).toEqual(Buffer.from(`b1${json ? `${JSON.stringify({ ok: true, data: result })}\n` : result.stdout}b2`))
      const disclosure = workspace && !json ? "Workspace, not a sandbox. Network and loopback open; no resource limits.\n" : ""
      expect(await readFile(err)).toEqual(Buffer.from(`e1${disclosure}${json ? "" : result.stderr}e2`))
    }
  }
}, 20_000)

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

test("list describes saved verification as dated history with current checks unknown", async () => {
  const paddock = await daemon({ list: { ok: true, data: [{ name: "demo", status: "running", engine: "fake", spec: { cpus: 1, memoryGb: 1 },
    lastVerify: { at: "2026-11-10T10:00:00Z", results: [{ id: "kernel", status: "pass" }] } }] } })
  const { out, code } = await paddock("list")
  expect(code).toBe(0)
  expect(out).toContain("last measured 2026-11-10T10:00:00Z; historical only, current checks unknown")
  expect(out).not.toContain("0 failed")
})

test("list shows the timestamp and reason of an enforcement failure", async () => {
  const row = { name: "demo", status: "running", engine: "fake", spec: { cpus: 1, memoryGb: 1 }, enforcementProblem: { at: "2026-11-12T00:00:00Z", message: "disk unreadable" } }
  const paddock = await daemon({ list: { ok: true, data: [row] } })
  const { out } = await paddock("list")
  expect(out).toContain("Enforcement unknown at 2026-11-12T00:00:00Z: disk unreadable")
})

test("an enrollment plan is shown as every command, file, download and restart, without the destination's control characters", async () => {
  // A destination that has Docker and two containers, one of them a sandbox of an earlier Paddock, and that answers
  // with text chosen to redraw a terminal.
  const probe: HostProbe = {
    system: "Linux", arch: "aarch64", libc: ["glibc", "2.39"], uid: 1000, gid: 1000, user: "alice", home: "/home/alice", machine: `m${ESC}`, boot: "b",
    hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8", systemd: true, os: { ID: "ubuntu", PRETTY_NAME: `Ubuntu${ESC}` },
    docker: { code: 0, out: "{}", err: "" }, containers: { code: 0, out: [{ Names: `owner-web${ESC}`, ID: "123" }, { Names: "sandbox-mine", ID: "456" }].map((row) => JSON.stringify(row)).join("\n"), err: "" },
    packages: { code: 0, out: "", err: "" }, downloads: [], apt: {}, repositories: {}, ancestors: {},
    files: Object.fromEntries([
      "/usr/local/bin/paddock", "/etc/systemd/system/paddock@1000.service", `/opt/paddock/releases/${"a".repeat(64)}/paddock`,
      ...GVISOR_FILES.map((name) => `/opt/paddock/gvisor/${GVISOR_RELEASE}/${name}`),
    ].map((path) => [path, { kind: "absent" }])),
    unit: { code: 0, out: "", err: "" }, dockerGroup: { code: 0, out: "docker:x:999:", err: "" }, lingering: { code: 0, out: "Linger=no", err: "" },
  }
  probe.files["/etc/docker/daemon.json"] = { kind: "file", sha256: "c".repeat(64), sha512: "d".repeat(128), uid: 0, mode: 0o644, text: `${JSON.stringify({ labels: [`keep${ESC}`] }, null, 2)}\n` }
  const asked: Array<Record<string, unknown>> = []
  const made = (body: Record<string, unknown>) => {
    asked.push(body)
    return { ok: true, data: installationPlan(enrollmentOptions({ ...body, host: undefined }), probe, { version: VERSION, sourceDigest: "b".repeat(64) }) }
  }
  const paddock = await daemon({ hostPlan: made, hostApply: { ok: false, error: { code: "conflict", message: "Consent is stale." } } })
  const args = ["host", "add", "build", "--ssh", "alice@build", "--artifact", "/tmp/paddock", "--sha256", "a".repeat(64)]
  const { code, out, err } = await paddock(...args, "--docker")
  // No terminal and no accepted hash: the plan is shown and nothing is applied.
  expect(code).toBe(2)
  expect(err).toContain("--accept-plan HASH")
  expect(asked[0]).toMatchObject({ name: "build", ssh: "alice@build", docker: true })
  const plan = installationPlan(enrollmentOptions({ name: "build", ssh: "alice@build", docker: true, artifact: { path: "/tmp/paddock", sha256: "a".repeat(64) } }), probe, { version: VERSION, sourceDigest: "b".repeat(64) })
  expect(plan.steps.length).toBeGreaterThan(10)
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
  for (const step of plan.steps) {
    expect(out).toContain(clean(step.label))
    expect(out).toContain(step.argv.join(" "))
    for (const left of step.leaves) expect(out).toContain(left)
  }
  for (const text of [
    `Plan hash: ${plan.hash}`, `sha256 ${"c".repeat(64)} becomes sha256 ${plan.changes[0]!.sha256}`, '    +    "paddock-runsc": {', '    +        "--net-raw"',
    `gvisor.tar.bz2: sha512 ${GVISOR.aarch64.archive}`, `takes gvisor-bin/gvisor_sentry: sha256 ${GVISOR.aarch64.files["gvisor-bin/gvisor_sentry"]}`,
    `paddock: sha256 ${"a".repeat(64)}, uploaded from /tmp/paddock`, "Docker restart: planned. It may interrupt every running container (2):", "sandbox-mine (456)",
    "Paddock service restart: none planned.", "Docker inside sandboxes: offered", `from ${plan.verification.image}`, "with Docker inside", "Disk limit: watched",
    `Helper image ${plan.verification.helperImage}, built on the destination from this Dockerfile:`, ...plan.verification.helperDockerfile.trim().split("\n").map((line) => `    ${line}`),
  ]) expect(out).toContain(text)
  expect(out).not.toContain("Blockers")
  expect(out).toContain("Interactive apply may ask for a password with `sudo -v`")
  expect(out).toContain("--accept-plan never prompts and requires noninteractive sudo")
  expect(out + err).not.toMatch(/[\x1b\x9b\u202e]/)
  // The line a forged check mark would have started is still one line of the diff.
  expect(out.split("\n").filter((line) => line.includes("forged")).every((line) => /^(    [ +-]|  Machine:|Docker restart:|  - )/.test(line))).toBe(true)

  // Without the option the plan says inner Docker is not offered, and a blocker is shown as one.
  const plain = await paddock(...args)
  expect(asked[1]!.docker).toBeUndefined()
  expect(plain.out).toContain("Docker inside sandboxes: not offered")
  expect(plain.out).not.toContain("--net-raw\"")
  probe.files["/usr/local/bin/paddock"] = { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/other" }
  const blocked = await paddock(...args, "--accept-plan", "0".repeat(64))
  expect(blocked.code).toBe(4)
  expect(blocked.out).not.toContain("asks for the password once")
  expect(blocked.out).toContain("Blockers (1); nothing is installed while one remains:\n  ✗ /usr/local/bin/paddock is unrelated")
  // --json is the whole plan and nothing else.
  const json = JSON.parse((await paddock("--json", ...args)).out)
  expect(json.data.hash).toMatch(/^[a-f0-9]{64}$/)
  expect(json.data.destination.machine).toBe(`m${ESC}`)
  const never = await paddock(...args, "--sudo", "never")
  expect(never.out).toContain("Privileged commands: none.")
  expect(never.out).not.toContain("asks for the password")
}, 30_000)

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
