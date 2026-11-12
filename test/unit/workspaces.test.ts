import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import { blockers, complete, failures, WORKSPACE_CHECKLIST } from "../../core/checks"
import { belongs, decision, requireMac, signalWorkspacePid, workspacePids } from "../../core/workspace-processes"
import { WORKSPACE_DISCLOSURE, workspaceEnvironment, workspaceProfile } from "../../core/workspace-profile"
import { canonical, validateRead, validWorkspaceSpec, Workspaces } from "../../core/workspaces"

const mac = process.platform === "darwin" ? test : test.skip
const fixture = async () => {
  await mkdir(join(import.meta.dir, "../../dist"), { recursive: true })
  const root = await mkdtemp(join(import.meta.dir, "../../dist/workspace-test-"))
  const state = join(root, "state"); const config = join(root, "config")
  const env = { ...process.env, PADDOCK_WORKSPACES_ROOT: join(root, "workspaces"), CLAUDE_CONFIG_DIR: join(root, "no-claude"), CODEX_HOME: join(root, "no-codex") }
  return { root, env, workspaces: new Workspaces({ state, config }, env), clean: () => rm(root, { recursive: true, force: true }) }
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
  expect(validWorkspaceSpec({ name: "render", reads: ["/a"], privileged: true })).toEqual({ name: "render", reads: ["/a"], path: [], loopback: "open" })
  expect(() => validWorkspaceSpec({ name: "../outside" })).toThrow()
  expect(() => validWorkspaceSpec({ name: "render", loopback: [80] })).toThrow("Declared ports")
  expect(() => requireMac("linux")).toThrow("only on macOS")
})

test("workspace checks reuse blocker logic without weakening sandbox checks", () => {
  const missing = complete([], ["config", "runtime", "probe"], "missing", WORKSPACE_CHECKLIST)
  expect(missing.every((check) => check.status === "unknown")).toBe(true)
  expect(blockers(missing, WORKSPACE_CHECKLIST).map((check) => check.id)).toEqual(["seatbelt", "processes"])
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
    const made = await workspaces.create({ name: "render", copy: source })
    expect(made.ok).toBe(true)
    expect(made.workspace.disclosure).toContain("not a sandbox")
    expect(made.checks.find((check) => check.id === "gpu")?.status).toBe("unknown")
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
    for (const [source, file] of [[env.CLAUDE_CONFIG_DIR, ".credentials.json"], [env.CODEX_HOME, "auth.json"]] as const) {
      await mkdir(source); await writeFile(join(source, file), JSON.stringify({ invalidFixtureCredential: secret }))
    }
    const report = await workspaces.create({ name: "logins" }); const m = await workspaces.manifest("logins")
    expect(m.logins.every((login) => login.copied)).toBe(true)
    for (const [source, file, agent] of [[env.CLAUDE_CONFIG_DIR, ".credentials.json", "claude"], [env.CODEX_HOME, "auth.json", "codex"]] as const) {
      const original = await stat(join(source, file)); const copied = await stat(join(report.workspace.folder, "home", `.${agent}`, file))
      expect(copied.mode & 0o777).toBe(0o600); expect(copied.nlink).toBe(1); expect(copied.ino).not.toBe(original.ino)
    }
    expect(JSON.stringify(m)).not.toContain(secret)
    expect(report.checks.find((check) => check.id === "credentials")?.detail).toContain("not verified")
    await workspaces.remove("logins", "logins")
    expect((await stat(join(env.CODEX_HOME, "auth.json"))).isFile()).toBe(true)
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
