import { expect, test } from "bun:test"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import { blockers, complete, failures, WORKSPACE_CHECKLIST } from "../../core/checks"
import { belongs, controlledDecision, decision, requireMac, signalWorkspacePid, workspacePids } from "../../core/workspace-processes"
import { systemRunner } from "../../core/run"
import type { Runner } from "../../core/types"
import controlProfile from "../../core/workspace-control.sb" with { type: "text" }
import { WORKSPACE_DISCLOSURE, HOST_TEMP_DISCLOSURE, workspaceDisclosure, workspaceEnvironment, workspaceProfile } from "../../core/workspace-profile"
import { canonical, validateRead, validWorkspaceSpec, Workspaces } from "../../core/workspaces"

const mac = process.platform === "darwin" ? test : test.skip
const fixture = async () => {
  await mkdir(join(import.meta.dir, "../../dist"), { recursive: true })
  const root = await mkdtemp(join(import.meta.dir, "../../dist/workspace-test-"))
  const state = join(root, "state"); const config = join(root, "config")
  const env = { ...process.env, PADDOCK_WORKSPACES_ROOT: join(root, "workspaces"), CLAUDE_CONFIG_DIR: join(root, "no-claude"), CODEX_HOME: join(root, "no-codex") }
  const commands: string[][] = []
  const runHost: Runner = (argv, options) => { commands.push([...argv]); return systemRunner(argv, options) }
  return { root, env, commands, workspaces: new Workspaces({ state, config }, env, { home: root, platform: "linux", runner: async () => { throw new Error("No host command is needed for file fixtures.") } }, runHost), clean: () => rm(root, { recursive: true, force: true }) }
}

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
  expect(validWorkspaceSpec({ name: "render", reads: ["/a"], privileged: true })).toEqual({ name: "render", hostTemp: false, reads: ["/a"], path: [], loopback: "open", logins: { kind: "profiles", claude: "default", codex: "default" } })
  expect(() => validWorkspaceSpec({ name: "../outside" })).toThrow()
  expect(() => validWorkspaceSpec({ name: "render", loopback: [80] })).toThrow("Declared ports")
  expect(() => requireMac("linux")).toThrow("only on macOS")
})

test("workspace checks reuse blocker logic without weakening sandbox checks", () => {
  const missing = complete([], ["config", "runtime", "probe"], "missing", WORKSPACE_CHECKLIST)
  expect(missing.every((check) => check.status === "unknown")).toBe(true)
  expect(blockers(missing, WORKSPACE_CHECKLIST, false).map((check) => check.id)).toEqual(["seatbelt", "processes"])
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
    expect(commands.map((argv) => argv[0])).toEqual(["/usr/bin/nc"])
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
  expect(open.text).toContain('(remote unix-socket (subpath (param "HOST_TEMP")))')
  expect(open.text).not.toContain(manifest.userVar)
  expect(workspaceDisclosure(false)).toBe(WORKSPACE_DISCLOSURE)
  expect(workspaceDisclosure(true)).toContain(HOST_TEMP_DISCLOSURE)
  expect(workspaceEnvironment({ folder: manifest.folder, name: "temp", spec: validWorkspaceSpec({ name: "temp", hostTemp: true }) }).TMPDIR).toBe(`${manifest.folder}/tmp/`)
})

mac("host temp opens only T, discloses weaker checks, refuses live changes and survives removal", async () => {
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
      expect(made.checks.find((check) => check.id === id)?.detail).toContain(id === "daemons" ? "Sockets in shared host temp are open" : HOST_TEMP_DISCLOSURE)
    }
    expect(made.checks.find((check) => check.id === "not-covered")?.detail).toContain(HOST_TEMP_DISCLOSURE)
    for (const view of [await workspaces.get("host-temp"), ...(await workspaces.list()), ...(await workspaces.summary())]) {
      expect(view.spec?.hostTemp).toBe(true); expect(view.disclosure).toContain(HOST_TEMP_DISCLOSURE)
    }
    const m = await workspaces.manifest("host-temp")
    const socket = join(outside, "listener.sock")
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve) })
    expect(await workspaces.exec("host-temp", ["/usr/bin/nc", "-w", "1", "-U", socket])).toMatchObject({ exitCode: 0, stdout: "shared-temp-socket" })
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
    expect((await workspaces.exec("host-temp", ["/usr/bin/nc", "-w", "1", "-U", socket])).exitCode).not.toBe(0)
    expect((await workspaces.exec("host-temp", ["/bin/cat", target])).exitCode).not.toBe(0)
    expect((await workspaces.exec("host-temp", write)).exitCode).not.toBe(0)
    const verified = await workspaces.verify("host-temp")
    for (const id of ["writes", "home-closed"]) expect(verified.checks.find((check) => check.id === id)?.status).toBe("pass")
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
