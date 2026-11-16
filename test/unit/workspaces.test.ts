import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import { blockers, complete, failures, WORKSPACE_CHECKLIST } from "../../core/checks"
import { belongs, controlledDecision, decision, requireMac, signalWorkspacePid, workspacePids } from "../../core/workspace-processes"
import { systemRunner } from "../../core/run"
import { writeConfig } from "../../core/state"
import { PaddockError, type RunResult, type Runner } from "../../core/types"
import controlProfile from "../../core/workspace-control.sb" with { type: "text" }
import { WORKSPACE_DISCLOSURE, HOST_TEMP_DISCLOSURE, workspaceDisclosure, workspaceEnvironment, workspaceProfile } from "../../core/workspace-profile"
import { acquire, canonical, validateRead, validWorkspaceSpec, Workspaces } from "../../core/workspaces"
import { WorkspaceSession } from "../../core/workspace-session"
import { ExplainedWorkspaces } from "./workspace-evidence"

const mac = process.platform === "darwin" ? test : test.skip
const fixture = async () => {
  await mkdir(join(import.meta.dir, "../../dist"), { recursive: true })
  const root = await mkdtemp(join(import.meta.dir, "../../dist/workspace-test-"))
  const state = join(root, "state"); const config = join(root, "config")
  const env = { ...process.env, PADDOCK_WORKSPACES_ROOT: join(root, "workspaces"), CLAUDE_CONFIG_DIR: join(root, "no-claude"), CODEX_HOME: join(root, "no-codex") }
  const commands: string[][] = []
  // du and free space as a test sets them; left unset, the real ones.
  const fake: { du?: () => Promise<RunResult>; free?: number } = {}
  const runHost: Runner = (argv, options) => { commands.push([...argv]); return argv[0] === "/usr/bin/du" && fake.du ? fake.du() : systemRunner(argv, options) }
  class Faked extends ExplainedWorkspaces { protected override async freeBytes(folder: string) { return fake.free ?? super.freeBytes(folder) } }
  const dirs = { state, config }
  return { root, env, dirs, commands, fake, workspaces: new Faked(dirs, env, { home: root, platform: "linux", runner: async () => { throw new Error("No host command is needed for file fixtures.") } }, runHost), clean: () => rm(root, { recursive: true, force: true }) }
}
const du = (gb: number, exitCode = 0) => async (): Promise<RunResult> => ({ exitCode, stdout: `${Math.round(gb * 1024 ** 2)}\t/folder\n`, stderr: "" })

mac("K15 finder control: empty workspace matches zero, known processes match exactly, and decoys do not match", async () => {
  const { root, clean } = await fixture(); const children: Bun.Subprocess[] = []
  try {
    const home = await realpath(userInfo().homedir)
    const userVar = await realpath(dirname(Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim()))
    const make = async (name: string) => {
      const folder = join(root, name); const tag = join(folder, ".paddock-tag")
      await mkdir(folder); await writeFile(tag, "control")
      const profile = workspaceProfile({ folder, home, userVar, tag, reads: [] }); const file = join(root, `${name}.sb`)
      await writeFile(file, profile.text)
      return { folder, argv: ["/usr/bin/sandbox-exec", "-f", file, ...profile.params.flatMap((value) => ["-D", value]), "/bin/sleep", "60"] }
    }
    const a = await make("a"); const b = await make("b")
    expect(workspacePids(a.folder)).toEqual([]); expect(workspacePids(b.folder)).toEqual([])
    children.push(Bun.spawn(a.argv, { stdout: "pipe", stderr: "pipe" }), Bun.spawn(a.argv, { stdout: "pipe", stderr: "pipe" }),
      Bun.spawn(b.argv, { stdout: "pipe", stderr: "pipe" }), Bun.spawn(["/bin/sleep", "60"], { env: { ...process.env, PADDOCK_WORKSPACE: "a" }, stdout: "pipe", stderr: "pipe" }))
    await Bun.sleep(150)
    expect(workspacePids(a.folder).sort()).toEqual(children.slice(0, 2).map((child) => child.pid).sort())
    expect(workspacePids(b.folder)).toEqual([children[2]!.pid])
    expect(belongs(children[3]!.pid, a.folder)).toBe(false)
    expect(signalWorkspacePid(children[3]!.pid, a.folder, "SIGKILL")).toBe(false)
    expect(decision(process.pid, "file-read-data", 1, a.folder)).toBe(0)
  } finally {
    // Each handle here was started by this test, even when the list-only control fails.
    for (const child of children) { child.kill("SIGKILL"); await child.exited }
    await clean()
  }
})

test("workspace spec drops unknown fields, permits only open loopback, and refuses unsupported platforms", () => {
  expect(validWorkspaceSpec({ name: "render", reads: ["/a"], privileged: true })).toEqual({ name: "render", hostTemp: false, diskGb: 20, reads: ["/a"], path: [], loopback: "open", logins: { kind: "profiles", claude: "default", codex: "default" } })
  expect(validWorkspaceSpec({ name: "render", diskGb: "3" }).diskGb).toBe(3)
  for (const diskGb of [0, 2001, "lots", -1]) expect(() => validWorkspaceSpec({ name: "render", diskGb })).toThrow("Disk (GiB) must be a number from 1 to 2000.")
  expect(() => validWorkspaceSpec({ name: "../outside" })).toThrow()
  expect(() => validWorkspaceSpec({ name: "render", loopback: [80] })).toThrow("Declared ports")
  expect(() => requireMac("linux")).toThrow("only on macOS")
})

test("workspace checks reuse blocker logic without weakening sandbox checks", () => {
  const missing = complete([], ["config", "runtime", "probe"], "missing", WORKSPACE_CHECKLIST)
  expect(missing.every((check) => check.status === "unknown")).toBe(true)
  expect(blockers(missing, WORKSPACE_CHECKLIST, false).map((check) => check.id)).toEqual(["seatbelt", "processes", "free-space"])
  // The size limit is watched, never a reason to refuse a launch.
  expect(blockers([{ id: "disk", status: "fail", evidence: "inspected", detail: "over" }], WORKSPACE_CHECKLIST, false)).toEqual([])
  expect(failures([{ id: "writes", status: "fail", evidence: "probed", detail: "outside write" }], WORKSPACE_CHECKLIST)).toHaveLength(1)
  expect(blockers([{ id: "kernel", status: "fail", evidence: "probed", detail: "host" }])).toHaveLength(1)
})

test("profile parameters contain paths and tag denies follow every read allowance", () => {
  const folder = '/home/me/Paddock/a'; const attack = '/home/me/x") (allow file-write*)'
  const profile = workspaceProfile({ folder, home: "/home/me", userVar: "/var/folders/user", tag: `${folder}/.paddock-tag`, reads: [{ given: attack, canonical: attack, resolvedAt: "now" }] })
  expect(profile.text).not.toContain(attack); expect(profile.params).toContain(`READ_0=${attack}`)
  expect(profile.text.indexOf('(param "READ_0")')).toBeLessThan(profile.text.lastIndexOf('(deny file-read-data (literal (param "TAGFILE")))'))
  expect(profile.text.trim().endsWith('(deny file-write* (literal (param "TAGFILE")))')).toBe(true)
  const manifest = { folder, name: "a", spec: validWorkspaceSpec({ name: "a" }) }
  const env = workspaceEnvironment(manifest, { USER: "me", TERM: "xterm", TOKEN: "secret", SSH_AUTH_SOCK: "/outside", DYLD_INSERT_LIBRARIES: "/evil" })
  expect(env.HOME).toBe(`${folder}/home`); expect(env.TMPDIR).toBe(`${folder}/tmp/`)
  expect(env.TOKEN).toBeUndefined(); expect(env.SSH_AUTH_SOCK).toBeUndefined(); expect(env.DYLD_INSERT_LIBRARIES).toBeUndefined()
  expect(WORKSPACE_DISCLOSURE).toContain("not a sandbox")
})

test("read allowances cannot expose SSH, home, workspace ancestors or state", () => {
  const protectedPaths = { home: "/Users/me", root: "/Users/me/Paddock", state: "/Users/me/.local/state/paddock", workspaces: ["/Users/me/elsewhere/a"], ssh: "/private/keys" }
  for (const path of ["/", "/Users", "/Users/me", "/Users/me/Paddock", "/Users/me/elsewhere", "/Users/me/.local", "/Users/me/.local/state/paddock/ssh", "/Users/me/.ssh", "/Users/me/.ssh/id_ed25519", "/private/keys", "/private/tmp/sessions"])
    expect(() => validateRead(path, protectedPaths)).toThrow()
  expect(() => validateRead("/Users/me/project", protectedPaths)).not.toThrow()
})

mac("workspace copy, verify, pipes, stop and confirmed remove preserve the original", async () => {
  const { root, workspaces, clean } = await fixture()
  try {
    const source = join(root, "project"); await mkdir(source); await writeFile(join(source, "file"), "original")
    // Modes the umask would clear, old times on a file and a read-only folder, a link that is not followed, and
    // extended attributes and an ACL that are not carried.
    const old = new Date("2001-02-03T04:05:06Z"); const older = new Date("1999-01-01T00:00:00Z")
    await mkdir(join(source, "bin")); await writeFile(join(source, "bin/tool"), "#!/bin/sh\n"); await chmod(join(source, "bin/tool"), 0o755); await utimes(join(source, "bin/tool"), old, old)
    await writeFile(join(source, "shared"), "group"); await chmod(join(source, "shared"), 0o664)
    await writeFile(join(source, "outside"), "outside"); await symlink(join(source, "outside"), join(source, "link"))
    await writeFile(join(source, "quarantined"), "q")
    for (const [name, value] of [["com.apple.quarantine", "0081;00000000;Test;"], ["org.paddock.test", "carried"]] as const)
      expect(Bun.spawnSync(["/usr/bin/xattr", "-w", name, value, join(source, "quarantined")]).exitCode).toBe(0)
    expect(Bun.spawnSync(["/bin/chmod", "+a", "everyone deny delete", join(source, "quarantined")]).exitCode).toBe(0)
    await chmod(join(source, "bin"), 0o555); await utimes(join(source, "bin"), older, older)
    const made = await workspaces.create({ name: "render", copy: source })
    await chmod(join(source, "bin"), 0o755)
    expect(made.ok).toBe(true)
    // The checks just measured are current; the stored copy in the view is history.
    expect(made.checks.some((check) => check.status === "pass")).toBe(true)
    expect(made.workspace.lastVerify!.results.every((check) => check.status === "unknown" && check.evidence === "none" && check.detail.startsWith(`Measured ${made.workspace.lastVerify!.at}: `))).toBe(true)
    const work = join(made.workspace.folder, "work")
    const tool = await stat(join(work, "bin/tool")); expect(tool.mode & 0o7777).toBe(0o755); expect(tool.mtime.getTime()).toBe(old.getTime())
    const bin = await stat(join(work, "bin")); expect(bin.mode & 0o7777).toBe(0o555); expect(bin.mtime.getTime()).toBe(older.getTime())
    expect((await stat(join(work, "shared"))).mode & 0o7777).toBe(0o664)
    expect((await lstat(join(work, "link"))).isSymbolicLink()).toBe(true); expect(await readlink(join(work, "link"))).toBe(join(source, "outside"))
    // macOS marks the copy itself: provenance on every file this process writes, and a fresh quarantine on a copy of a
    // quarantined file. The source's own values are what must not arrive.
    const attributes = Bun.spawnSync(["/usr/bin/xattr", "-l", join(work, "quarantined")]).stdout.toString()
    expect(attributes).not.toContain("org.paddock.test"); expect(attributes).not.toContain("0081;00000000;Test;")
    expect(Bun.spawnSync(["/bin/ls", "-le", join(work, "quarantined")]).stdout.toString()).not.toContain("deny delete")
    expect(Bun.spawnSync(["/bin/ls", "-le", join(source, "quarantined")]).stdout.toString()).toContain("deny delete")
    expect(made.workspace.disclosure).toContain("not a sandbox")
    expect(made.checks.find((check) => check.id === "gpu")?.detail).toContain("Metal compute")
    const command = await workspaces.exec("render", ["/bin/sh", "-c", 'printf changed > file; printf "$HOME"; printf error >&2; exit 7'])
    expect(command.exitCode).toBe(7); expect(command.stderr).toBe("error")
    expect(command.stdout).toBe(join(made.workspace.folder, "home"))
    expect(await readFile(join(source, "file"), "utf8")).toBe("original")
    await expect(workspaces.remove("render", undefined)).rejects.toThrow("--confirm render")
    await workspaces.stop("render")
    await workspaces.remove("render", "render")
    expect(await Bun.file(join(source, "file")).text()).toBe("original")
    expect(await workspaces.list()).toEqual([])
  } finally {
    for (const workspace of await workspaces.list()) await workspaces.remove(workspace.name, workspace.name)
    Bun.spawnSync(["/bin/chmod", "-R", "-N", root])
    await clean()
  }
}, 30_000)

mac("workspace PTY receives input and a resize, and returns the command's output", async () => {
  const { workspaces, clean } = await fixture()
  try {
    await workspaces.create({ name: "terminal" })
    const session = await workspaces.open("terminal", ["/bin/sh", "-c", 'read line; stty size; printf "reply:%s\\n" "$line"'], { tty: true, cols: 80, rows: 24 })
    let output = ""; session.on("output", (_stream: string, bytes: Uint8Array) => { output += Buffer.from(bytes).toString() })
    await session.resize(101, 37); session.resume(); session.write(Buffer.from("hello\n"))
    await Promise.race([session.finished, Bun.sleep(5000).then(() => { session.close(); throw new Error("PTY did not complete") })])
    expect(output).toContain("37 101"); expect(output).toContain("reply:hello")
  } finally { for (const ws of await workspaces.list()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 15_000)

mac("workspace file login copies are private, not hard links, and credential bytes never enter manifests", async () => {
  const { root, env, workspaces, clean } = await fixture()
  try {
    const secret = "workspace-test-credential-never-in-manifest"
    for (const [source, file] of [[join(root, ".claude"), ".credentials.json"], [join(root, ".codex"), "auth.json"]] as const) {
      await mkdir(source); await writeFile(join(source, file), JSON.stringify({ invalidFixtureCredential: secret }))
    }
    const report = await workspaces.create({ name: "logins" }); const m = await workspaces.manifest("logins")
    expect(m.logins.every((login) => login.copied)).toBe(true)
    for (const [source, file, agent] of [[join(root, ".claude"), ".credentials.json", "claude"], [join(root, ".codex"), "auth.json", "codex"]] as const) {
      const original = await stat(join(source, file)); const copied = await stat(join(report.workspace.folder, "home", `.${agent}`, file))
      expect(copied.mode & 0o777).toBe(0o600); expect(copied.nlink).toBe(1); expect(copied.ino).not.toBe(original.ino)
    }
    expect(JSON.stringify(m)).not.toContain(secret)
    expect(report.checks.find((check) => check.id === "credentials")?.detail).toContain("did not report logged in")
    await workspaces.remove("logins", "logins")
    expect((await stat(join(root, ".codex/auth.json"))).isFile()).toBe(true)
  } finally { for (const ws of await workspaces.list()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("stop recovers an unreadable or missing folder before identifying its own live process", async () => {
  const { workspaces, clean } = await fixture()
  try {
    for (const mode of ["unreadable", "missing"]) {
      const made = await workspaces.create({ name: mode })
      const session = await workspaces.open(mode, ["/bin/sleep", "60"], { tty: false }); session.resume()
      for (let i = 0; i < 100 && !belongs(session.pid, made.workspace.folder); i++) await Bun.sleep(10)
      expect(belongs(session.pid, made.workspace.folder)).toBe(true)
      if (mode === "unreadable") await chmod(made.workspace.folder, 0)
      else await rm(made.workspace.folder, { recursive: true, force: true })
      const stopped = await workspaces.stop(mode); expect(stopped.processes).toBe(0)
      await session.finished; await workspaces.remove(mode, mode)
    }
  } finally { for (const ws of await workspaces.list()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("summary and get never repair identity or permissions; only an explicit size request runs du", async () => {
  const { root, commands, workspaces, clean } = await fixture()
  try {
    const made = await workspaces.create({ name: "inventory", logins: { kind: "none" } })
    await rm(join(made.workspace.folder, ".paddock-tag"))
    await chmod(made.workspace.folder, 0o555)
    const before = await stat(made.workspace.folder); commands.length = 0
    const rows = await workspaces.summary()
    expect(rows[0]?.status).toBe("unknown"); expect(rows[0]?.sizeBytes).toBeUndefined()
    expect(commands).toEqual([])
    await workspaces.get("inventory", false)
    expect(commands).toEqual([])
    expect((await stat(made.workspace.folder)).mode & 0o777).toBe(0o555)
    expect((await stat(made.workspace.folder)).ctimeMs).toBe(before.ctimeMs)
    expect(await Bun.file(join(made.workspace.folder, ".paddock-tag")).exists()).toBe(false)
    await workspaces.get("inventory")
    expect(commands.map((argv) => argv[0])).toEqual(["/usr/bin/du"])
    expect((await stat(made.workspace.folder)).mode & 0o777).toBe(0o555)
    expect(await Bun.file(join(made.workspace.folder, ".paddock-tag")).exists()).toBe(false)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 15_000)

mac("launch runs blocking checks only and verify reads hard-link directories without chmod", async () => {
  const { root, commands, workspaces, clean } = await fixture()
  try {
    for (const [agent, filename] of [["claude", ".credentials.json"], ["codex", "auth.json"]]) {
      await mkdir(join(root, `.${agent}`)); await writeFile(join(root, `.${agent}`, filename!), '{"fixture":true}')
    }
    const made = await workspaces.create({ name: "launch" }); const m = await workspaces.manifest("launch")
    const home = join(m.folder, "home"); const bin = join(home, ".local/bin"); await mkdir(bin, { recursive: true })
    for (const name of ["claude", "codex", "ffmpeg"]) { const file = join(bin, name); await writeFile(file, `#!/bin/sh\nprintf '${name}\\n' >> "$HOME/information-called"\nexit 1\n`); await chmod(file, 0o700) }
    const closed = join(m.folder, "work/closed"); await mkdir(closed); await chmod(closed, 0)
    commands.length = 0
    expect((await workspaces.exec("launch", ["/usr/bin/true"])).exitCode).toBe(0)
    expect(await Bun.file(join(home, "information-called")).exists()).toBe(false)
    // Only the two unconfined listener controls (the private fixture and shared host temp T), and du for the disk warning.
    expect(commands.map((argv) => argv[0])).toEqual(["/usr/bin/nc", "/usr/bin/nc", "/usr/bin/du"])
    expect((await stat(closed)).mode & 0o777).toBe(0)
    expect((await workspaces.manifest("launch")).lastVerify?.at).toBe(m.lastVerify?.at)
    const verified = await workspaces.verify("launch")
    expect((await readFile(join(home, "information-called"), "utf8")).trim().split("\n").sort()).toEqual(["claude", "codex", "ffmpeg"])
    expect(verified.checks.find((check) => check.id === "gpu")?.status).toBe("fail")
    expect(verified.checks.find((check) => check.id === "hard-links")?.status).toBe("unknown")
    expect((await stat(closed)).mode & 0o777).toBe(0)
    expect(made.workspace.sizeBytes).toBeUndefined()
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 20_000)

mac("named login profiles ignore daemon environment and no-logins imports nothing", async () => {
  const { root, workspaces, clean } = await fixture()
  try {
    for (const agent of ["claude", "codex"]) for (const profile of ["default", "work"]) {
      const source = join(root, profile === "default" ? `.${agent}` : `.${agent}-${profile}`)
      await mkdir(source); await writeFile(join(source, agent === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify({ profile }))
    }
    await writeFile(join(root, ".claude-work/.claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "fixture@example.com" }, unselectedSetting: true }))
    const selected = await workspaces.create({ name: "profiles", logins: { kind: "profiles", claude: "work", codex: "work" } })
    expect(JSON.parse(await readFile(join(selected.workspace.folder, "home/.claude/.credentials.json"), "utf8"))).toEqual({ profile: "work" })
    const state = JSON.parse(await readFile(join(selected.workspace.folder, "home/.claude/.claude.json"), "utf8"))
    expect(state).toMatchObject({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: "fixture@example.com" } })
    expect(state.unselectedSetting).toBeUndefined()
    expect((await stat(join(selected.workspace.folder, "home/.claude/.claude.json"))).mode & 0o777).toBe(0o600)
    const empty = await workspaces.create({ name: "empty-logins", logins: { kind: "none" } })
    expect((await workspaces.manifest("empty-logins")).logins).toEqual([])
    expect(await Bun.file(join(empty.workspace.folder, "home/.claude/.credentials.json")).exists()).toBe(false)
    expect(empty.checks.find((check) => check.id === "credentials")?.detail).toBe("No logins requested.")
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 20_000)

mac("option-shaped commands cannot override workspace parameters", async () => {
  const { root, workspaces, clean } = await fixture()
  try {
    const ws = await workspaces.create({ name: "arguments", logins: { kind: "none" } })
    const target = join(root, "escaped")
    const argv = ["-D", "WS=/", "/bin/sh", "-c", 'printf escaped > "$1"', "control", target]
    const safe = await workspaces.exec("arguments", argv)
    expect(safe.exitCode).toBe(71); expect(safe.stderr).toContain("execvp() of '-D'")
    expect(await Bun.file(target).exists()).toBe(false)
    const m = await workspaces.manifest("arguments"); const profile = workspaceProfile(m)
    const control = await systemRunner(["/usr/bin/sandbox-exec", "-f", join(root, "state/workspaces/arguments.sb"), ...profile.params.flatMap((value) => ["-D", value]), ...argv])
    expect(control.exitCode).toBe(0); expect(await readFile(target, "utf8")).toBe("escaped")
    expect((await workspaces.exec("arguments", ["-p", "(version 1)(allow default)", "/usr/bin/true"])).exitCode).toBe(71)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 20_000)

mac("a missing or misspelled decision control cannot establish denial", async () => {
  const { root, workspaces, clean } = await fixture(); let child: Bun.Subprocess | undefined
  try {
    const ws = await workspaces.create({ name: "controls", logins: { kind: "none" } }); const m = await workspaces.manifest("controls")
    const file = join(root, "control.sb"); await writeFile(file, controlProfile)
    child = Bun.spawn(["/usr/bin/sandbox-exec", "-f", file, "-D", `WS=${m.folder}`, "-D", `TAGFILE=${m.tag}`, "--", "/bin/sleep", "30"], { stdout: "pipe", stderr: "pipe" })
    await Bun.sleep(100)
    expect(controlledDecision(child.pid, child.pid, "file-read-data", 1, m.folder)).toBe("allowed")
    expect(controlledDecision(child.pid, child.pid, "paddock-misspelled-operation")).toBe("unknown")
    expect(controlledDecision(child.pid, process.pid, "file-read-data", 1, m.folder)).toBe("unknown")
    expect(ws.checks.find((check) => check.id === "daemons")?.detail).toContain("real Unix-socket listener")
    expect(ws.checks.find((check) => check.id === "daemons")?.status).toBe("pass")
  } finally { if (child) { child.kill("SIGKILL"); await child.exited }; for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 15_000)


test("host temp defaults closed, validates booleans and leaves the original profile bytes intact", () => {
  expect(validWorkspaceSpec({ name: "temp" }).hostTemp).toBe(false)
  expect(validWorkspaceSpec({ name: "temp", hostTemp: true }).hostTemp).toBe(true)
  for (const hostTemp of ["on", 1, null, []]) expect(() => validWorkspaceSpec({ name: "temp", hostTemp })).toThrow("boolean")
  const manifest = { folder: "/Users/me/Paddock/temp", home: "/Users/me", userVar: "/private/var/folders/xx/user", tag: "/Users/me/Paddock/temp/.paddock-tag", reads: [] }
  const original = workspaceProfile(manifest)
  // Captured from the original generator, before host-temp support.
  expect(original.hash).toBe("92f58a5a5c52b7a7a1b258243b4ce2aa602a4cccddc531c10f1f2c34a2a2d29c")
  const closed = workspaceProfile({ ...manifest, spec: { hostTemp: false } })
  expect(closed).toEqual(original)
  const open = workspaceProfile({ ...manifest, spec: { hostTemp: true } })
  expect(open.params).toContain(`HOST_TEMP=${manifest.userVar}/T`)
  expect(open.text).toContain('(allow file-read* file-write* (subpath (param "HOST_TEMP")))')
  // Host temp opens files only, and the user-var folder's own metadata for tools that walk T's ancestors; Unix socket
  // connections there stay under the base profile's denial.
  expect(open.text.split("\n").filter((line) => !closed.text.split("\n").includes(line))).toEqual(['(allow file-read* file-write* (subpath (param "HOST_TEMP")))', '(allow file-read-metadata (literal (param "USER_VAR")))'])
  expect(open.text).not.toContain(manifest.userVar)
  expect(workspaceDisclosure(false)).toBe(WORKSPACE_DISCLOSURE)
  expect(workspaceDisclosure(true)).toContain(HOST_TEMP_DISCLOSURE)
  expect(workspaceEnvironment({ folder: manifest.folder, name: "temp", spec: validWorkspaceSpec({ name: "temp", hostTemp: true }) }).TMPDIR).toBe(`${manifest.folder}/tmp/`)
})

mac("host temp opens only T to files, refuses socket connections there, discloses weaker checks, refuses live changes and survives removal", async () => {
  const { root, workspaces, clean } = await fixture()
  const temp = await realpath(Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]).stdout.toString().trim())
  const outside = await mkdtemp(join(temp, "paddock-host-temp-test-"))
  let session: Awaited<ReturnType<Workspaces["open"]>> | undefined
  const server = createServer((socket) => socket.end("shared-temp-socket"))
  try {
    await expect(workspaces.setHostTemp("host-temp", "on")).rejects.toThrow("boolean")
    const made = await workspaces.create({ name: "host-temp", hostTemp: true, logins: { kind: "none" } })
    expect(made.ok).toBe(true)
    for (const id of ["writes", "home-closed", "daemons"]) {
      expect(made.checks.find((check) => check.id === id)).toMatchObject({ status: "weak" })
      expect(made.checks.find((check) => check.id === id)?.detail).toContain(id === "daemons" ? "In shared host temp T, with host-temp on, a listener control answered; confined connect refused." : HOST_TEMP_DISCLOSURE)
    }
    expect(made.checks.find((check) => check.id === "not-covered")?.detail).toContain(HOST_TEMP_DISCLOSURE)
    for (const view of [await workspaces.get("host-temp"), ...(await workspaces.list()), ...(await workspaces.summary())]) {
      expect(view.spec?.hostTemp).toBe(true); expect(view.disclosure).toContain(HOST_TEMP_DISCLOSURE)
    }
    const m = await workspaces.manifest("host-temp")
    const socket = join(outside, "listener.sock")
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve) })
    // The unconfined control connects; the workspace is refused, though it can delete the socket file and listen there.
    expect(await systemRunner(["/usr/bin/nc", "-w", "1", "-U", socket])).toMatchObject({ exitCode: 0, stdout: "shared-temp-socket" })
    expect(await workspaces.exec("host-temp", ["/usr/bin/nc", "-w", "1", "-U", socket])).toMatchObject({ exitCode: 1, stdout: "" })
    const left = join(outside, "left.sock"); const leftServer = createServer()
    await new Promise<void>((resolve, reject) => { leftServer.once("error", reject); leftServer.listen(left, resolve) })
    try { expect((await workspaces.exec("host-temp", ["/bin/rm", left])).exitCode).toBe(0) } finally { await new Promise<void>((resolve) => leftServer.close(() => resolve())) }
    expect(await Bun.file(left).exists()).toBe(false)
    const own = join(outside, "own.sock")
    const listening = workspaces.exec("host-temp", ["/usr/bin/nc", "-lU", own])
    for (let i = 0; i < 100 && !await lstat(own).catch(() => undefined); i++) await Bun.sleep(20)
    expect((await systemRunner(["/usr/bin/nc", "-w", "1", "-U", own], { stdin: "from-outside" })).exitCode).toBe(0)
    expect(await listening).toMatchObject({ exitCode: 0, stdout: "from-outside" })
    const target = join(outside, "file")
    const write = ["/bin/sh", "-c", 'printf live-temp > "$1" && cat "$1"', "probe", target]
    expect(await workspaces.exec("host-temp", write)).toMatchObject({ exitCode: 0, stdout: "live-temp" })
    for (const location of ["/private/tmp", "/private/var/tmp", join(m.userVar, "C"), join(m.userVar, "0"), m.home]) {
      const denied = join(location, `paddock-denied-${m.id}`)
      try {
        expect((await workspaces.exec("host-temp", ["/bin/sh", "-c", 'printf escaped > "$1"', "probe", denied])).exitCode).not.toBe(0)
        expect(await Bun.file(denied).exists()).toBe(false)
      } finally { await rm(denied, { force: true }) }
    }
    session = await workspaces.open("host-temp", ["/bin/sleep", "60"], { tty: false }); session.resume()
    await expect(workspaces.setHostTemp("host-temp", false)).rejects.toThrow("Stop the workspace")
    expect((await workspaces.manifest("host-temp")).spec.hostTemp).toBe(true)
    for (let i = 0; i < 100 && !belongs(session.pid, m.folder); i++) await Bun.sleep(10)
    expect(belongs(session.pid, m.folder)).toBe(true)
    await workspaces.stop("host-temp"); await session.finished; session = undefined
    const closed = await workspaces.setHostTemp("host-temp", false)
    expect(closed.spec?.hostTemp).toBe(false); expect(closed.lastVerify).toBeUndefined()
    expect(await workspaces.exec("host-temp", ["/usr/bin/nc", "-w", "1", "-U", socket])).toMatchObject({ exitCode: 1, stdout: "" })
    expect((await workspaces.exec("host-temp", ["/bin/cat", target])).exitCode).not.toBe(0)
    expect((await workspaces.exec("host-temp", write)).exitCode).not.toBe(0)
    expect((await workspaces.exec("host-temp", ["/usr/bin/nc", "-lU", join(outside, "closed.sock")])).exitCode).not.toBe(0)
    expect(await Bun.file(join(outside, "closed.sock")).exists()).toBe(false)
    expect((await workspaces.exec("host-temp", ["/bin/rm", socket])).exitCode).not.toBe(0)
    expect(await lstat(socket).catch(() => undefined)).toBeDefined()
    const verified = await workspaces.verify("host-temp")
    for (const id of ["writes", "home-closed", "daemons"]) expect(verified.checks.find((check) => check.id === id)?.status).toBe("pass")
    expect(verified.checks.find((check) => check.id === "daemons")?.detail).toContain("In shared host temp T, with host-temp off, a listener control answered; confined connect refused.")
    expect(verified.workspace.disclosure).not.toContain(HOST_TEMP_DISCLOSURE)
    // Old manifests acquire the default without rewriting their profile.
    const file = join(root, "state/workspaces/host-temp.json")
    const legacy = JSON.parse(await readFile(file, "utf8")); delete legacy.spec.hostTemp
    await writeFile(file, JSON.stringify(legacy))
    expect((await workspaces.manifest("host-temp")).spec.hostTemp).toBe(false)
    expect((await workspaces.exec("host-temp", ["/usr/bin/true"])).exitCode).toBe(0)
    legacy.spec.hostTemp = "on"; await writeFile(file, JSON.stringify(legacy))
    await expect(workspaces.manifest("host-temp")).rejects.toThrow("boolean")
    delete legacy.spec.hostTemp; await writeFile(file, JSON.stringify(legacy))
    await workspaces.setHostTemp("host-temp", true)
    const removed = await workspaces.remove("host-temp", "host-temp")
    expect(removed.disclosure).toContain(HOST_TEMP_DISCLOSURE)
    expect(await readFile(target, "utf8")).toBe("live-temp")
  } finally {
    if (session) { session.close(); await session.finished }
    for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name)
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(outside, { recursive: true, force: true }); await clean()
  }
}, 60_000)


mac("host temp opens the user-var folder's metadata only, and a stale saved profile names the command that rewrites it", async () => {
  const { root, workspaces, clean } = await fixture()
  try {
    await workspaces.create({ name: "user-var", hostTemp: true, logins: { kind: "none" } })
    const m = await workspaces.manifest("user-var")
    const stat = (path: string) => workspaces.exec("user-var", ["/usr/bin/stat", "-f", "%p", path])
    // A stat of the user-var folder is what tools creating folders under T need; listing it, and its C and 0, stay refused.
    expect(await stat(m.userVar)).toMatchObject({ exitCode: 0 })
    expect(await stat(join(m.userVar, "T"))).toMatchObject({ exitCode: 0 })
    expect((await workspaces.exec("user-var", ["/bin/ls", m.userVar])).stderr).toContain("Operation not permitted")
    for (const child of ["C", "0"]) {
      const refused = await stat(join(m.userVar, child))
      expect(refused.exitCode).not.toBe(0); expect(refused.stderr).toContain("Operation not permitted")
    }
    // A workspace saved by a generator without the rule: launch refuses and says how to rewrite it.
    const file = join(root, "state/workspaces/user-var.sb"); const manifestFile = join(root, "state/workspaces/user-var.json")
    const old = (await readFile(file, "utf8")).replace('(allow file-read-metadata (literal (param "USER_VAR")))\n', "")
    const saved = JSON.parse(await readFile(manifestFile, "utf8"))
    saved.profileHash = new Bun.CryptoHasher("sha256").update(old).digest("hex")
    await writeFile(file, old); await writeFile(manifestFile, JSON.stringify(saved))
    const refused = await workspaces.exec("user-var", ["/usr/bin/true"]).then(() => undefined, (error) => error)
    // The message carries the command too, for stream sessions, which show only the message.
    expect(refused?.message).toStartWith("Workspace execution refused by its checklist: ")
    expect(refused?.message).toContain("paddock workspace set user-var host-temp on")
    expect(refused?.details.find((check: { id: string }) => check.id === "seatbelt")?.detail).toContain("paddock workspace set user-var host-temp on")
    // Setting the same value again rewrites the profile from the saved settings.
    await workspaces.setHostTemp("user-var", true)
    expect(await stat(m.userVar)).toMatchObject({ exitCode: 0 })
    await workspaces.setHostTemp("user-var", false)
    const closed = await stat(m.userVar)
    expect(closed.exitCode).not.toBe(0); expect(closed.stderr).toContain("Operation not permitted")
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("confstr temp file creation fails closed and succeeds with host-temp without changing TMPDIR", async () => {
  const { workspaces, clean } = await fixture()
  try {
    const made = await workspaces.create({ name: "confstr", logins: { kind: "none" } })
    const source = join(made.workspace.folder, "work/temp.c"); const binary = join(made.workspace.folder, "work/temp")
    await writeFile(source, `#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(void) {
  char path[4096];
  if (!confstr(_CS_DARWIN_USER_TEMP_DIR, path, sizeof(path))) return 2;
  printf("host=%s\\nTMPDIR=%s\\n", path, getenv("TMPDIR"));
  strncat(path, "paddock-confstr-XXXXXX", sizeof(path) - strlen(path) - 1);
  int fd = mkstemp(path);
  if (fd < 0) { perror("mkstemp"); return 3; }
  char bytes[5] = {0};
  int ok = write(fd, "temp", 4) == 4 && lseek(fd, 0, SEEK_SET) == 0 && read(fd, bytes, 4) == 4 && strcmp(bytes, "temp") == 0;
  close(fd); unlink(path);
  return ok ? 0 : 4;
}
`)
    const compile = await systemRunner(["/usr/bin/env", "-u", "DEVELOPER_DIR", "-u", "SDKROOT", "/usr/bin/xcrun", "clang", source, "-o", binary], { timeoutMs: 10_000 })
    expect(compile.exitCode).toBe(0)
    const closed = await workspaces.exec("confstr", [binary])
    expect(closed.exitCode).toBe(3); expect(closed.stderr).toContain("Operation not permitted")
    await workspaces.setHostTemp("confstr", true)
    const open = await workspaces.exec("confstr", [binary])
    expect(open.exitCode).toBe(0)
    expect(open.stdout).toContain("/T/"); expect(open.stdout).toContain(`TMPDIR=${made.workspace.folder}/tmp/`)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 20_000)

mac("a starter that never carries its profile is refused with what was seen", async () => {
  const folder = await mkdtemp(join(import.meta.dir, "../../dist/workspace-acquire-"))
  try {
    const ended = new WorkspaceSession({ argv: ["/bin/sh", "-c", "echo boom >&2; exit 3"], cwd: folder, env: { PATH: "/usr/bin:/bin" }, folder, tty: false })
    const failed = await acquire(ended, folder, "The live probe").then(() => "", (error: Error) => error.message)
    expect(failed).toMatch(/^The live probe did not acquire its expected profile after \d+ ms: it ended \(exit 3\); stderr "boom"; pid \d+ not found\. The cause of this refusal is not known yet\.$/)
    const running = new WorkspaceSession({ argv: ["/bin/sleep", "30"], cwd: folder, env: { PATH: "/usr/bin:/bin" }, folder, tty: false })
    try {
      const refused = await acquire(running, folder, "The confined decision control").then(() => "", (error: Error) => error.message)
      expect(refused).toContain("it was still running; no stderr;")
      expect(refused).toContain(`uid ${process.getuid!()} (Paddock's ${process.getuid!()}); sandboxed no;`)
      expect(Number(/after (\d+) ms/.exec(refused)?.[1])).toBeGreaterThanOrEqual(1000)
    } finally { process.kill(running.pid, "SIGKILL"); await running.finished }
  } finally { await rm(folder, { recursive: true, force: true }) }
})

mac("a --copy, --read or --path that does not exist is refused in plain words, with nothing created", async () => {
  const { root, workspaces, clean } = await fixture()
  try {
    const missing = join(root, "nowhere")
    for (const [input, flag] of [[{ copy: missing }, "--copy"], [{ reads: [missing] }, "--read"], [{ path: [missing] }, "--path"]] as const) {
      const refused = await workspaces.create({ name: "absent", ...input }).then(() => undefined, (error: PaddockError) => error)
      expect(refused).toBeInstanceOf(PaddockError)
      expect([refused!.code, refused!.message]).toEqual(["runtime", `${flag} ${missing} does not exist on this Mac; nothing was created.`])
    }
    expect(await lstat(join(root, "workspaces", "absent")).catch(() => undefined)).toBeUndefined()
  } finally { await clean() }
})

// Waits for a launched command's processes to be found, so a watch pass sees the workspace running.
const running = async (workspaces: Workspaces, name: string) => { for (let i = 0; i < 100 && (await workspaces.get(name, false)).status !== "running"; i++) await Bun.sleep(20) }

mac("over its disk limit a workspace is stopped by the watch with a reason, warned at launch, and clear again once under", async () => {
  const { workspaces, fake, clean } = await fixture()
  try {
    const made = await workspaces.create({ name: "disk", diskGb: 1, logins: { kind: "none" } })
    expect(made.workspace.spec?.diskGb).toBe(1)
    const watched = made.checks.find((check) => check.id === "disk")!
    expect(watched.status).toBe("weak"); expect(watched.detail).toContain("every 30 seconds"); expect(watched.detail).toContain("Watched, not capped")
    fake.du = du(2)
    // A launch over the limit runs, and says so.
    const warned = await workspaces.exec("disk", ["/bin/echo", "ran"])
    expect(warned.stdout).toBe("ran\n")
    expect(warned.diskWarning).toEqual({ usedBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, message: `disk uses 2.00 GiB of its 1 GiB disk limit, so the daemon stops its processes again within about 30 seconds unless space is freed. Free space in ${made.workspace.folder}, or raise the limit: paddock workspace set disk disk N` })
    const session = await workspaces.open("disk", ["/bin/sleep", "60"], { tty: false }); session.resume()
    expect(session.diskWarning?.usedBytes).toBe(2 * 1024 ** 3)
    await running(workspaces, "disk")
    await workspaces.watch()
    await session.finished
    const stopped = await workspaces.get("disk", false)
    expect(stopped.status).toBe("idle")
    expect(stopped.stopReason).toMatch(new RegExp(`^Stopped by the daemon at \\S+: disk uses 2\\.00 GiB of its 1 GiB disk limit\\. Free space in ${made.workspace.folder}, or raise the limit: paddock workspace set disk disk N$`))
    expect((await workspaces.list())[0]!.stopReason).toBe(stopped.stopReason)
    expect((await workspaces.verify("disk")).checks.find((check) => check.id === "disk")).toMatchObject({ status: "fail", detail: expect.stringContaining("It uses 2.00 GiB now.") })
    // Under the limit again: no warning, and a launch clears the old reason.
    fake.du = du(0.5)
    const clear = await workspaces.exec("disk", ["/usr/bin/true"])
    expect(clear.diskWarning).toBeUndefined()
    expect((await workspaces.get("disk", false)).stopReason).toBeUndefined()
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("a workspace whose processes are idle is not measured by the watch, and the limit can change while it runs", async () => {
  const { workspaces, fake, commands, clean } = await fixture()
  try {
    await workspaces.create({ name: "idle", logins: { kind: "none" } })
    fake.du = du(30); commands.length = 0
    await workspaces.watch()
    expect(commands).toEqual([])
    expect((await workspaces.get("idle", false)).stopReason).toBeUndefined()
    fake.du = du(0.1)
    const session = await workspaces.open("idle", ["/bin/sleep", "60"], { tty: false }); session.resume()
    await running(workspaces, "idle")
    const changed = await workspaces.set("idle", { diskGb: 3 })
    expect(changed.spec?.diskGb).toBe(3); expect(changed.status).toBe("running")
    expect((await workspaces.manifest("idle")).spec.diskGb).toBe(3)
    await expect(workspaces.set("idle", { diskGb: 0 })).rejects.toThrow("from 1 to 2000")
    await expect(workspaces.set("idle", { diskGb: 3, hostTemp: true })).rejects.toThrow("one at a time")
    await expect(workspaces.set("idle", { diskGb: null })).rejects.toThrow("in GiB")
    // Host temp still refuses a live change.
    await expect(workspaces.set("idle", { hostTemp: true })).rejects.toThrow("Stop the workspace")
    session.close(); await session.finished
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("a manifest written before disk limits reads with the 20 GiB default", async () => {
  const { workspaces, dirs, clean } = await fixture()
  try {
    await workspaces.create({ name: "legacy", logins: { kind: "none" } })
    const file = join(dirs.state, "workspaces", "legacy.json")
    const saved = JSON.parse(await readFile(file, "utf8")); delete saved.spec.diskGb; await writeFile(file, JSON.stringify(saved))
    expect((await workspaces.manifest("legacy")).spec.diskGb).toBe(20)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 15_000)

mac("a measurement that fails is unknown, warns in the view, and stops the workspace after four passes in a row", async () => {
  const { workspaces, fake, clean } = await fixture()
  try {
    await workspaces.create({ name: "blind", diskGb: 1, logins: { kind: "none" } })
    const session = await workspaces.open("blind", ["/bin/sleep", "60"], { tty: false }); session.resume()
    await running(workspaces, "blind")
    // A partial total under the limit proves nothing; one over it would.
    fake.du = du(0.5, 1)
    for (let pass = 1; pass <= 3; pass++) {
      await workspaces.watch()
      const view = await workspaces.get("blind", false)
      expect(view.status).toBe("running")
      expect(view.enforcementProblem?.message).toBe(`Its size could not be measured. After 4 such passes in a row its processes are stopped (this is ${pass}).`)
    }
    expect((await workspaces.verify("blind")).checks.find((check) => check.id === "disk")?.status).toBe("unknown")
    await workspaces.watch(); await session.finished
    const view = await workspaces.get("blind", false)
    expect(view.status).toBe("idle"); expect(view.enforcementProblem).toBeUndefined()
    expect(view.stopReason).toMatch(/^Stopped by the daemon at \S+: for 4 passes in a row it could not check disk use\. Its size could not be measured\.$/)
    // A partial total already over the limit is enough to stop.
    const again = await workspaces.open("blind", ["/bin/sleep", "60"], { tty: false }); again.resume()
    await running(workspaces, "blind")
    fake.du = du(2, 1)
    await workspaces.watch(); await again.finished
    expect((await workspaces.get("blind", false)).stopReason).toContain("uses 2.00 GiB of its 1 GiB disk limit")
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("below the free-space floor launches are refused with the setting's command and running workspaces are stopped", async () => {
  const { workspaces, fake, dirs, clean } = await fixture()
  try {
    await workspaces.create({ name: "floor", logins: { kind: "none" } })
    const session = await workspaces.open("floor", ["/bin/sleep", "60"], { tty: false }); session.resume()
    await running(workspaces, "floor")
    fake.free = 3 * 1024 ** 3
    const sentence = "This Mac has 3.00 GiB free where workspaces live, below the 5 GiB floor. Free space on this Mac, or change the floor: paddock config set workspace-free-space GiB"
    const refused = await workspaces.exec("floor", ["/usr/bin/true"]).then(() => undefined, (error: PaddockError) => error)
    expect(refused?.code).toBe("check-failed"); expect(refused?.message).toContain(`(fail): ${sentence}`)
    await workspaces.watch(); await session.finished
    const view = await workspaces.get("floor", false)
    expect(view.status).toBe("idle"); expect(view.stopReason).toMatch(new RegExp(`^Stopped by the daemon at \\S+: ${sentence.replace(/\./g, "\\.")}$`))
    // The floor is the machine-wide setting; at 2 GiB the same free space is enough.
    await writeConfig(dirs, { workspaceFreeSpaceGb: 2 })
    expect((await workspaces.exec("floor", ["/usr/bin/true"])).exitCode).toBe(0)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)

mac("two measurements of one workspace never run at once", async () => {
  const { workspaces, fake, commands, clean } = await fixture()
  try {
    await workspaces.create({ name: "once", logins: { kind: "none" } })
    let active = 0; let most = 0
    fake.du = async () => { active++; most = Math.max(most, active); await Bun.sleep(100); active--; return du(0.1)() }
    commands.length = 0
    const views = await Promise.all([workspaces.get("once"), workspaces.get("once"), workspaces.list()])
    expect(most).toBe(1); expect(commands.filter((argv) => argv[0] === "/usr/bin/du")).toHaveLength(1)
    expect(views[0].sizeBytes).toBe(Math.round(0.1 * 1024 ** 2) * 1024)
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 15_000)

mac("workspace stop, remove and disk watch deliver a reason before the command ends", async () => {
  const { workspaces, fake, clean } = await fixture()
  try {
    for (const action of ["stop", "remove", "watch"] as const) {
      fake.du = du(0)
      await workspaces.create({ name: action, diskGb: 1, logins: { kind: "none" } })
      const session = await workspaces.open(action, ["/bin/sleep", "60"], { tty: false })
      const result = session.collect()
      await running(workspaces, action)
      if (action === "watch") { fake.du = du(2); await workspaces.watch() }
      else if (action === "stop") await workspaces.stop(action)
      else await workspaces.remove(action, action)
      const ended = await result
      expect(ended.exitCode).toBe(137)
      expect(ended.stderr).toContain(action === "watch" ? "Stopped by the daemon" : `Stopped by paddock workspace ${action}`)
    }
  } finally { for (const ws of await workspaces.summary()) await workspaces.remove(ws.name, ws.name); await clean() }
}, 30_000)
