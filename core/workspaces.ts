import { randomBytes } from "node:crypto"
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { blockers, complete, historical, WORKSPACE_CHECKLIST } from "./checks"
import { claudeState, credentialFiles, profileName, readCredential, type Host } from "./credentials"
import { must, systemRunner } from "./run"
import type { Dirs } from "./state"
import { object } from "./transport"
import { PaddockError, type CheckResult, type RunResult, type Session, type Runner, type WorkspaceManifest, type WorkspaceSpec } from "./types"
import { belongs, controlledDecision, decision, requireMac, stopWorkspaceProcesses, workspacePids } from "./workspace-processes"
import { within, WORKSPACE_DISCLOSURE, workspaceEnvironment, workspaceProfile } from "./workspace-profile"
import { WorkspaceSession } from "./workspace-session"
import controlProfile from "./workspace-control.sb" with { type: "text" }

export type WorkspaceView = {
  kind: "workspace"; name: string; folder: string; status: "idle" | "running" | "damaged" | "unknown"
  processes?: number; sizeBytes?: number; spec?: WorkspaceSpec; createdAt?: string; lastVerify?: WorkspaceManifest["lastVerify"]
  disclosure: string; problem?: string
}
export type WorkspaceReport = { workspace: WorkspaceView; checks: CheckResult[]; ok: boolean; pathSuggestions?: string[] }
export type WorkspaceRemoval = { removed: string; kind: "workspace"; hardLinks: string[]; launchServices: string[]; launchd: string[]; notRemoved: string[]; disclosure: string }

export function workspaceName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(value)) throw new PaddockError("usage", "A workspace name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return value
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64 || !value.every((path) => typeof path === "string" && path.length > 0 && path.length < 4096 && !/[\x00-\x1f]/.test(path))) throw new PaddockError("usage", `${label} must be at most 64 paths without control characters.`)
  return value
}
export function validWorkspaceSpec(input: Record<string, unknown>): WorkspaceSpec {
  if (input.loopback !== undefined && input.loopback !== "open") throw new PaddockError("usage", "Workspace loopback is open. Declared ports are not available in this version.")
  const copy = input.copy === undefined ? undefined : strings([input.copy], "copy")[0]
  const selected = input.logins ?? { kind: "profiles", claude: "default", codex: "default" }
  if (!object(selected) || (selected.kind !== "none" && selected.kind !== "profiles")) throw new PaddockError("usage", "logins must select named profiles or none.")
  const profile = (value: unknown) => { if (typeof value !== "string") throw new PaddockError("usage", "Choose a named login profile."); try { return profileName(value) } catch { throw new PaddockError("usage", "A login profile is 1 to 48 letters, digits, underscores or hyphens.") } }
  const logins: WorkspaceSpec["logins"] = selected.kind === "none" ? { kind: "none" } : { kind: "profiles", claude: profile(selected.claude), codex: profile(selected.codex) }
  return { name: workspaceName(input.name), reads: strings(input.reads, "reads"), path: strings(input.path, "path"), loopback: "open", ...(copy ? { copy } : {}), logins }
}
export const validArgv = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.length || !value.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new PaddockError("usage", "workspace exec needs a command after --.")
  return value
}

// Resolve even a not-yet-created path through its nearest existing ancestor.
export async function canonical(path: string): Promise<string> {
  const absolute = resolve(path)
  try { return await realpath(absolute) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(await canonical(parent), absolute.slice(parent.length))
  }
}
const expand = (path: string, home: string) => path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : resolve(path)

export function validateRead(path: string, protectedPaths: { home: string; root: string; state: string; workspaces: string[]; ssh: string }): void {
  const { home, root, state, workspaces, ssh } = protectedPaths
  if ([home, root, state, ...workspaces].some((entry) => within(entry, path)) || [root, state, ...workspaces, ssh, join(home, ".ssh")].some((entry) => within(path, entry)))
    throw new PaddockError("usage", "--read cannot expose the home folder, ~/.ssh, a workspace, the workspaces folder or Paddock state.")
  if (["/private/tmp", "/private/var/tmp", "/private/var/folders"].some((entry) => within(path, entry) || within(entry, path))) throw new PaddockError("usage", "--read cannot reopen shared temporary folders.")
}

export async function hardLinks(folder: string, repair = false): Promise<string[]> {
  const found: string[] = []
  const walk = async (path: string) => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return
    if (info.isFile() && info.nlink > 1) found.push(path)
    if (info.isDirectory()) { if (repair) await chmod(path, info.mode | 0o700); for (const entry of await readdir(path)) await walk(join(path, entry)) }
  }
  await walk(folder)
  return found.sort()
}

// A plain cp keeps neither times nor modes the umask clears, and cp -p would also carry the group, ACLs and file flags.
// So the copy is plain and the times and permission bits (not setuid, setgid or sticky) are set here from the source,
// children before their folder, without following a symlink on either side.
export async function copyTimesAndModes(source: string, target: string): Promise<void> {
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const from = join(source, entry.name); const to = join(target, entry.name)
    const info = await lstat(from).catch(() => undefined)
    if (!info || info.isSymbolicLink() !== entry.isSymbolicLink() || info.isDirectory() !== entry.isDirectory() || info.isFile() !== entry.isFile()) continue
    if (entry.isSymbolicLink()) { await lutimes(to, info.atime, info.mtime); continue }
    if (entry.isDirectory()) await copyTimesAndModes(from, to)
    await chmod(to, info.mode & 0o777); await utimes(to, info.atime, info.mtime)
  }
}

export class Workspaces {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly sessions = new Set<Session>()
  constructor(readonly dirs: Dirs, private readonly env: NodeJS.ProcessEnv = process.env, private readonly loginHost?: Host, private readonly runHost: Runner = systemRunner) {}
  private exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(task, task)
    this.locks.set(name, next.catch(() => {})); return next
  }
  private async locations() {
    requireMac()
    const home = await realpath(userInfo().homedir)
    const root = await canonical(this.env.PADDOCK_WORKSPACES_ROOT ?? join(home, "Paddock"))
    const state = await canonical(this.dirs.state)
    if (root === home || !within(root, home) || within(root, state) || within(state, root) || within(root, await canonical(join(home, ".ssh"))))
      throw new PaddockError("usage", "The workspaces root must be strictly inside the real home, separate from ~/.ssh and Paddock state.")
    return { home, root, state }
  }
  private file(name: string) { return join(this.dirs.state, "workspaces", `${workspaceName(name)}.json`) }
  private profileFile(name: string) { return join(this.dirs.state, "workspaces", `${workspaceName(name)}.sb`) }
  private async save(manifest: WorkspaceManifest) {
    const file = this.file(manifest.name); const tmp = `${file}.tmp`
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); await rename(tmp, file)
  }
  async manifest(name: string): Promise<WorkspaceManifest> {
    const { root, home } = await this.locations()
    let input: unknown
    try { input = JSON.parse(await readFile(this.file(name), "utf8")) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PaddockError("not-found", `There is no workspace named ${name}.`)
      throw new PaddockError("check-failed", `The workspace manifest for ${name} cannot be read.`)
    }
    if (!object(input) || input.version !== 1 || input.kind !== "workspace" || input.name !== name || typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id)
      || input.folder !== join(root, name) || input.home !== home || input.tag !== join(root, name, ".paddock-tag") || !object(input.spec)
      || typeof input.userVar !== "string" || !isAbsolute(input.userVar) || typeof input.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(input.profileHash)
      || typeof input.macOS !== "string" || typeof input.createdAt !== "string" || !Array.isArray(input.reads) || !Array.isArray(input.logins) || typeof input.backup !== "string")
      throw new PaddockError("check-failed", `The workspace manifest for ${name} is invalid. Nothing was started or removed.`)
    const spec = validWorkspaceSpec(input.spec)
    if (spec.name !== name || !input.reads.every((read) => object(read) && typeof read.given === "string" && typeof read.canonical === "string" && isAbsolute(read.canonical) && typeof read.resolvedAt === "string")
      || !input.logins.every((login) => object(login) && (login.agent === "claude" || login.agent === "codex") && typeof login.copied === "boolean" && typeof login.detail === "string"))
      throw new PaddockError("check-failed", `The workspace manifest for ${name} is invalid.`)
    return { ...input, spec } as WorkspaceManifest
  }
  private async names() { return (await readdir(join(this.dirs.state, "workspaces")).catch(() => [])).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort() }
  private async restoreIdentity(manifest: WorkspaceManifest) {
    const { root } = await this.locations()
    if (await canonical(root) !== root) throw new PaddockError("check-failed", "A workspace parent was replaced by a symlink; nothing was signalled or removed.")
    const folder = await lstat(manifest.folder).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined })
    if (folder && !folder.isDirectory()) throw new PaddockError("check-failed", "The workspace folder was replaced by a symlink or another file; nothing was signalled or removed.")
    await mkdir(manifest.folder, { recursive: true, mode: 0o700 }); await chmod(manifest.folder, 0o700)
    if (await realpath(manifest.folder) !== manifest.folder) throw new PaddockError("check-failed", "The workspace folder is no longer canonical.")
    const tag = await lstat(manifest.tag).catch(() => undefined)
    if (tag && (!tag.isFile() || tag.nlink !== 1)) throw new PaddockError("check-failed", "The workspace tag is not a private regular file.")
    if (!tag) await writeFile(manifest.tag, manifest.id, { flag: "wx", mode: 0o444 })
    else if (await readFile(manifest.tag, "utf8") !== manifest.id) throw new PaddockError("check-failed", "The workspace tag identity changed.")
  }
  private async view(manifest: WorkspaceManifest, withSize = false): Promise<WorkspaceView> {
    let processes: number | undefined; let problem: string | undefined
    try { processes = workspacePids(manifest.folder).length } catch (error) { problem = (error as Error).message }
    const size = withSize ? await this.runHost(["/usr/bin/du", "-sk", manifest.folder], { timeoutMs: 10_000 }) : undefined
    const kb = size?.exitCode === 0 ? Number(size.stdout.trim().split(/\s/)[0]) : NaN
    return { kind: "workspace", name: manifest.name, folder: manifest.folder, status: processes === undefined ? "unknown" : processes ? "running" : "idle", processes,
      ...(Number.isFinite(kb) ? { sizeBytes: kb * 1024 } : {}), spec: manifest.spec, createdAt: manifest.createdAt, lastVerify: historical(manifest.lastVerify), disclosure: WORKSPACE_DISCLOSURE, problem }
  }
  private async inventory(withSize: boolean): Promise<WorkspaceView[]> {
    await this.locations()
    const views: WorkspaceView[] = []
    for (const name of await this.names()) {
      try { views.push(await this.view(await this.manifest(name), withSize)) } catch (error) { views.push({ kind: "workspace", name, folder: "", status: "damaged", problem: (error as Error).message, disclosure: WORKSPACE_DISCLOSURE }) }
    }
    return views
  }
  async summary(): Promise<WorkspaceView[]> { return this.inventory(false) }
  async list(): Promise<WorkspaceView[]> { return this.inventory(true) }
  async get(name: string, withSize = true): Promise<WorkspaceView> { return this.view(await this.manifest(name), withSize) }

  private async copyLogins(manifest: WorkspaceManifest): Promise<void> {
    const selected = manifest.spec.logins
    if (selected.kind === "none") return
    for (const agent of ["claude", "codex"] as const) {
      let failure = "Not imported: the credential or Claude account state could not be read; contents withheld."
      const sourceHost: Host = this.loginHost ?? { home: manifest.home, platform: process.platform, runner: (argv) => this.runHost(argv, { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 + 1024 }) }
      const host: Host = { ...sourceHost, runner: async (argv) => {
        const result = await sourceHost.runner(argv)
        if (argv.includes("-w") && result.exitCode !== 0) failure = result.overflow ? "Not imported: credential output exceeded its limit; contents withheld."
          : result.exitCode === 124 ? "Not imported: Keychain password read timed out or was interrupted; the timeout is 15 seconds and a pending access prompt is possible."
          : "Not imported: Keychain password access was denied or failed (exit " + result.exitCode + "); contents withheld."
        return result
      } }
      const dest = join(manifest.folder, "home", "." + agent)
      let copied = false
      try {
        const credential = await readCredential(agent, selected[agent], host)
        const state = agent === "claude" ? await claudeState(selected.claude, host.home) : undefined
        await mkdir(dest, { recursive: true, mode: 0o700 })
        if (state) {
          await writeFile(join(dest, ".claude.json"), JSON.stringify(state), { mode: 0o600, flag: "wx" })
          await writeFile(join(dest, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "" } }), { mode: 0o600, flag: "wx" })
        }
        await writeFile(join(dest, credentialFiles[agent]), credential, { mode: 0o600, flag: "wx" })
        copied = true
      } catch {
        for (const file of [credentialFiles[agent], ...(agent === "claude" ? [".claude.json", "settings.json"] : [])]) await rm(join(dest, file), { force: true })
      }
      manifest.logins.push({ agent, copied, detail: copied ? "Selected profile " + selected[agent] + " copied privately; CLI recognition has not been checked." : failure })
    }
  }

  async create(input: Record<string, unknown>): Promise<WorkspaceReport> {
    const spec = validWorkspaceSpec(input); const { root, home, state } = await this.locations()
    return this.exclusive(spec.name, async () => {
      const folder = join(root, spec.name)
      if (await lstat(this.file(spec.name)).catch(() => undefined) || await lstat(folder).catch(() => undefined)) throw new PaddockError("conflict", `Workspace ${spec.name} or its folder already exists.`)
      const existing = (await Promise.all((await this.names()).map((name) => this.manifest(name)))).map((entry) => entry.folder)
      const protectedPaths = { home, root, state, workspaces: existing, ssh: await canonical(join(home, ".ssh")) }
      const reads: WorkspaceManifest["reads"] = []
      for (const given of spec.reads) {
        const path = await realpath(expand(given, home)); validateRead(path, protectedPaths)
        reads.push({ given, canonical: path, resolvedAt: new Date().toISOString() })
      }
      for (const path of spec.path) {
        const canonicalPath = await realpath(expand(path, home))
        if (!(await lstat(canonicalPath)).isDirectory() || canonicalPath.includes(":")) throw new PaddockError("usage", "--path must be a directory without a colon.")
        if (within(canonicalPath, home) && !reads.some((read) => within(canonicalPath, read.canonical))) throw new PaddockError("usage", "A --path directory under home also needs an allowed --read.")
      }
      spec.path = await Promise.all(spec.path.map((path) => realpath(expand(path, home))))
      const source = spec.copy ? await realpath(expand(spec.copy, home)) : undefined
      if (source && (!(await lstat(source)).isDirectory() || within(folder, source) || within(source, root) || within(source, state))) throw new PaddockError("usage", "--copy must be a project directory separate from workspace and state folders.")
      const temp = must(await this.runHost(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]), "Finding this user's temp folder").stdout.trim()
      const manifest: WorkspaceManifest = { version: 1, kind: "workspace", name: spec.name, id: randomBytes(16).toString("hex"), spec, folder, tag: join(folder, ".paddock-tag"), home,
        userVar: await realpath(dirname(temp)), reads, profileHash: "", macOS: must(await this.runHost(["/usr/bin/sw_vers", "-productVersion"]), "Reading macOS version").stdout.trim(), createdAt: new Date().toISOString(), logins: [], backup: "Time Machine exclusion not measured." }
      await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(folder, { mode: 0o700 })
      try {
        for (const name of ["home", "tmp", "work", "home/.claude", "home/.codex"]) await mkdir(join(folder, name), { mode: 0o700 })
        await writeFile(manifest.tag, manifest.id, { flag: "wx", mode: 0o444 })
        if (source) {
          must(await this.runHost(["/bin/cp", "-R", "-P", "-X", `${source}/.`, join(folder, "work")], { timeoutMs: 600_000 }), "Copying the project")
          await copyTimesAndModes(source, join(folder, "work"))
        }
        await this.copyLogins(manifest)
        const backup = await this.runHost(["/usr/bin/tmutil", "addexclusion", folder])
        const excluded = backup.exitCode === 0 ? await this.runHost(["/usr/bin/tmutil", "isexcluded", folder]) : undefined
        manifest.backup = excluded?.exitCode === 0 && excluded.stdout.includes("[Excluded]") ? "Time Machine reports this folder excluded now; existing backups are not removed." : "Time Machine exclusion could not be verified; backups may retain files."
        const profile = workspaceProfile(manifest); manifest.profileHash = profile.hash
        await mkdir(dirname(this.file(spec.name)), { recursive: true, mode: 0o700 })
        await writeFile(this.profileFile(spec.name), profile.text, { flag: "wx", mode: 0o600 })
        await this.save(manifest)
      } catch (error) {
        await rm(folder, { recursive: true, force: true }); await rm(this.profileFile(spec.name), { force: true }); throw error
      }
      // Retain a failed workspace and its evidence, so the user can inspect and remove it explicitly.
      const report = await this.verifyNow(manifest)
      const suggestions: string[] = []
      for (const path of (this.env.PATH ?? "").split(":")) {
        const resolved = await realpath(path).catch(() => undefined)
        if (resolved && within(resolved, home)) { try { validateRead(resolved, protectedPaths); suggestions.push(resolved) } catch {} }
      }
      return { ...report, pathSuggestions: [...new Set(suggestions)] }
    })
  }

  private async launch(manifest: WorkspaceManifest, argv: string[], tty = false, cols?: number, rows?: number): Promise<WorkspaceSession> {
    await this.restoreIdentity(manifest)
    const profile = workspaceProfile(manifest)
    if (profile.hash !== manifest.profileHash || await readFile(this.profileFile(manifest.name), "utf8") !== profile.text) throw new PaddockError("check-failed", "The workspace profile changed; execution refused.")
    for (const path of [manifest.home, manifest.userVar, ...manifest.reads.map((read) => read.canonical), ...manifest.spec.path])
      if (await realpath(path) !== path) throw new PaddockError("check-failed", "A canonical profile path changed; execution refused.")
    const session = new WorkspaceSession({ argv: ["/usr/bin/sandbox-exec", "-f", this.profileFile(manifest.name), ...profile.params.flatMap((value) => ["-D", value]), "--", ...argv],
      env: workspaceEnvironment(manifest, this.env), cwd: join(manifest.folder, "work"), folder: manifest.folder, tty, cols, rows })
    this.sessions.add(session); session.on("end", () => this.sessions.delete(session))
    return session
  }
  private async run(manifest: WorkspaceManifest, argv: string[], stdin?: string | Uint8Array, timeoutMs = 20_000): Promise<RunResult> {
    const session = await this.launch(manifest, argv)
    return session.collect(stdin, timeoutMs)
  }
  private async blockingChecks(manifest: WorkspaceManifest): Promise<CheckResult[]> {
    const results: CheckResult[] = []
    const add = (id: CheckResult["id"], status: CheckResult["status"], evidence: CheckResult["evidence"], detail: string) => results.push({ id, status, evidence, detail })
    let probe: WorkspaceSession | undefined
    let control: WorkspaceSession | undefined
    let fixture: string | undefined
    let socketFixture: string | undefined
    let server: ReturnType<typeof createServer> | undefined
    try {
      await this.restoreIdentity(manifest)
      const before = workspacePids(manifest.folder)
      probe = await this.launch(manifest, ["/bin/sleep", "30"])
      for (let i = 0; i < 100 && !belongs(probe.pid, manifest.folder); i++) { if (probe.ended) break; await Bun.sleep(10) }
      if (!belongs(probe.pid, manifest.folder)) throw new Error("The live probe did not acquire the expected workspace profile.")
      add("seatbelt", "pass", "inspected", `Profile sha256 ${manifest.profileHash}; canonical -D parameters; macOS ${manifest.macOS} at creation.`)
      const pids = workspacePids(manifest.folder)
      add("processes", pids.includes(probe.pid) ? "pass" : "fail", "probed", `${before.length} processes before the known probe; finder ${pids.length} including its pid. Kernel tag criterion and uid checked. K15 supplies the independent empty-workspace control.`)
      fixture = join(dirname(manifest.folder), `.paddock-probe-${randomBytes(8).toString("hex")}`)
      await mkdir(fixture, { mode: 0o700 }); const target = join(fixture, "outside")
      const controlFile = join(fixture, "control.sb"); await writeFile(controlFile, controlProfile, { mode: 0o600 })
      control = new WorkspaceSession({ argv: ["/usr/bin/sandbox-exec", "-f", controlFile, "-D", `WS=${manifest.folder}`, "-D", `TAGFILE=${manifest.tag}`, "--", "/bin/sleep", "30"],
        env: workspaceEnvironment(manifest, this.env), cwd: join(manifest.folder, "work"), folder: manifest.folder, tty: false })
      for (let i = 0; i < 100 && !belongs(control.pid, manifest.folder); i++) { if (control.ended) break; await Bun.sleep(10) }
      if (!belongs(control.pid, manifest.folder)) throw new Error("The confined decision control did not acquire its expected profile.")
      await writeFile(target, "control")
      const write = await this.run(manifest, ["/bin/sh", "-c", 'printf changed > "$1"', "probe", target])
      const insideWrite = await this.run(manifest, ["/bin/sh", "-c", 'printf inside > "$TMPDIR/paddock-write-probe" && rm "$TMPDIR/paddock-write-probe"'])
      const writeRefused = write.exitCode !== 0 && await readFile(target, "utf8") === "control"
      add("writes", writeRefused && insideWrite.exitCode === 0 ? "pass" : "fail", "probed", `Sibling write ${writeRefused ? "refused" : "not refused"}; inside write ${insideWrite.exitCode === 0 ? "succeeded" : "failed"}. Home/shared-temp decisions use same-operation allowed controls in a confined profile.`)
      const read = await this.run(manifest, ["/bin/cat", target])
      const closed = [manifest.home, "/private/tmp", "/private/var/tmp", manifest.userVar]
      const readControl = decision(probe.pid, "file-read-data", 1, manifest.folder) === 0 && closed.every((path) => controlledDecision(probe!.pid, control!.pid, "file-read-data", 1, path) !== "unknown")
      const denied = closed.every((path) => controlledDecision(probe!.pid, control!.pid, "file-read-data", 1, path) === "denied")
      add("home-closed", !readControl ? "unknown" : read.exitCode !== 0 && denied ? "pass" : "fail", "probed", `Sibling home read ${read.exitCode !== 0 ? "refused" : "allowed"}; allowed confined controls ${readControl ? "answered" : "unavailable"}; shared-temp decisions ${denied ? "denied" : "not established as denied"}. Read allowances: ${manifest.reads.map((read) => read.canonical).join(", ") || "none"}.`)
      const writeTargets = [manifest.home, "/private/tmp", manifest.userVar]
      const writeAnswers = writeTargets.map((path) => decision(probe!.pid, "file-write-create", 1, path))
      if (decision(probe.pid, "file-write-create", 1, manifest.folder) !== 0 || writeAnswers.some((answer) => answer !== 0 && answer !== 1))
        results[results.findIndex((result) => result.id === "writes")] = { id: "writes", status: "unknown", evidence: "probed", detail: "A live write control or kernel decision for home/shared temp could not be established." }
      else if (writeAnswers.includes(0)) results[results.findIndex((result) => result.id === "writes")] = { id: "writes", status: "fail", evidence: "probed", detail: "An outside file-write-create decision was allowed beside the same-operation allowed control inside the workspace." }
      const controls = (checks: Array<[string, number, string]>) => checks.every(([op, type, arg]) => controlledDecision(probe!.pid, control!.pid, op, type, arg) !== "unknown"
        && (op !== "mach-lookup" || decision(probe!.pid, op, type, "com.apple.system.logger") === 0))
      const refuses = (checks: Array<[string, number, string]>) => checks.every(([op, type, arg]) => controlledDecision(probe!.pid, control!.pid, op, type, arg) === "denied")
      const launchChannels: Array<[string, number, string]> = [["lsopen", 0, ""], ["job-creation", 0, ""], ["mach-lookup", 2, "com.apple.lsd.modifydb"]]
      socketFixture = await mkdtemp("/private/tmp/paddock-check-")
      const socket = join(socketFixture, "control.sock"); const marker = "paddock-socket-control\n"
      server = createServer((connection) => connection.end(marker))
      await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(socket, resolve) })
      const socketControl = await this.runHost(["/usr/bin/nc", "-w", "1", "-U", socket], { timeoutMs: 3000 })
      const socketAttempt = await this.run(manifest, ["/usr/bin/nc", "-w", "1", "-U", socket])
      const socketDenied = socketAttempt.exitCode === 1 && socketAttempt.stdout === ""
      const socketsKnown = socketControl.exitCode === 0 && socketControl.stdout === marker && (socketAttempt.exitCode === 0 || socketDenied)
      add("daemons", !controls(launchChannels) || !socketsKnown ? "unknown" : refuses(launchChannels) && socketDenied ? "pass" : "fail", "probed", `A real Unix-socket listener control ${socketControl.exitCode === 0 && socketControl.stdout === marker ? "answered" : "failed (exit " + socketControl.exitCode + ")"}; confined connect ${socketDenied ? "refused" : "not established as refused"}. Allowed confined policy controls ${controls(launchChannels) ? "answered" : "unavailable"}; decisions ${launchChannels.map(([op, type, arg]) => op + "=" + controlledDecision(probe!.pid, control!.pid, op, type, arg)).join(", ")}. Apple events are not covered.`)
      const data: Array<[string, number, string]> = [["user-preference-read", 6, "com.apple.finder"], ["user-preference-write", 6, "com.apple.finder"], ["mach-lookup", 2, "com.apple.pasteboard.1"], ["signal", 0, ""], ["process-info-pidinfo", 0, ""]]
      add("user-data", !controls(data) ? "unknown" : refuses(data) ? "pass" : "fail", "probed", `Preferences, pasteboard lookup, signals and process-info-pidinfo allowed confined controls ${controls(data) ? "answered" : "unavailable"}; denials ${refuses(data) ? "confirmed" : "not established"}. End-to-end coverage is K11/K12.`)
    } catch (error) { add("seatbelt", "fail", "none", (error as Error).message) }
    finally {
      if (probe) { probe.close(); await probe.finished }
      if (control) { control.close(); await control.finished }
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
      if (socketFixture) await rm(socketFixture, { recursive: true, force: true })
      if (fixture) await rm(fixture, { recursive: true, force: true })
    }
    return complete(results, ["config", "runtime", "probe"], "This workspace check could not be made.", WORKSPACE_CHECKLIST.filter((item) => item.blocking))
  }
  private async verifyNow(manifest: WorkspaceManifest): Promise<WorkspaceReport> {
    const results = await this.blockingChecks(manifest)
    const add = (id: CheckResult["id"], status: CheckResult["status"], evidence: CheckResult["evidence"], detail: string) => results.push({ id, status, evidence, detail })
    const available = await this.run(manifest, ["/bin/sh", "-c", "command -v ffmpeg"]).catch(() => undefined)
    if (!available) add("gpu", "unknown", "none", "The ffmpeg availability probe could not run; hardware encode was not measured. Metal compute is not covered by this check.")
    else if (available.exitCode !== 0) add("gpu", "unknown", "none", "No ffmpeg executable is available on the workspace PATH; hardware encode was not measured. Metal compute is not covered by this check.")
    else {
      const movie = join(manifest.folder, "tmp", `paddock-gpu-${randomBytes(8).toString("hex")}.mov`)
      try {
        const encoded = await this.run(manifest, ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=5:d=0.4", "-c:v", "hevc_videotoolbox", "-allow_sw", "0", "-y", movie])
        const written = (await stat(movie).catch(() => undefined))?.size ?? 0
        add("gpu", encoded.exitCode === 0 && written > 0 ? "pass" : "fail", "probed", `Hardware-only HEVC VideoToolbox encode ${encoded.exitCode === 0 && written > 0 ? "produced a nonempty movie" : "failed (exit " + encoded.exitCode + ")"}; software fallback disabled. Metal compute is not covered by this check.`)
      } catch { add("gpu", "unknown", "none", "The hardware encode probe could not run. Metal compute is not covered by this check.") }
      finally { await rm(movie, { force: true }) }
    }
    add("network", "info", "inspected", "No IP network restrictions. Internet, LAN, tailnet and remote effects are open; HTTPS is measured by K18.")
    const listeners = await this.runHost(["/usr/sbin/lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 5000, maxOutputBytes: 256 * 1024 })
    add("loopback", listeners.exitCode === 0 ? "weak" : "unknown", listeners.exitCode === 0 ? "inspected" : "none", listeners.exitCode === 0
      ? `Open. Current listeners, including wildcard binds reachable on loopback: ${listeners.stdout.trim().split("\n").slice(1).join("; ")}. Services started later are also reachable.` : "Open. Current listeners could not be enumerated.")
    const loginDetails: string[] = []
    for (const login of manifest.logins) {
      if (!login.copied) { loginDetails.push(`${login.agent}: ${login.detail}`); continue }
      const status = await this.run(manifest, login.agent === "claude" ? ["claude", "auth", "status"] : ["codex", "login", "status"]).catch(() => undefined)
      let recognized = false
      if (status?.exitCode === 0) {
        if (login.agent === "codex") recognized = /logged in/i.test(`${status.stdout}\n${status.stderr}`)
        else { try { const parsed: unknown = JSON.parse(status.stdout); recognized = object(parsed) && parsed.loggedIn === true } catch {} }
      }
      loginDetails.push(`${login.agent}: copied; ${recognized ? "CLI reports logged in; authenticated API calls and refresh not measured" : status ? "CLI did not report logged in (exit " + status.exitCode + "); output withheld" : "CLI status could not run; output withheld"}.`)
    }
    add("credentials", "info", manifest.logins.some((login) => login.copied) ? "probed" : "inspected", loginDetails.join(" ") || "No logins requested.")
    try { const links = await hardLinks(manifest.folder); add("hard-links", links.length ? "weak" : "info", "inspected", links.length ? `Multiple links, possibly shared outside: ${links.join(", ")}. Outside links cannot be located reliably.` : "No regular files with link count > 1 now. Paddock never copies with hard links.") }
    catch { add("hard-links", "unknown", "none", "Could not walk all workspace files.") }
    const backup = await this.runHost(["/usr/bin/tmutil", "isexcluded", manifest.folder], { timeoutMs: 5000 })
    manifest.backup = backup.exitCode === 0 && backup.stdout.includes("[Excluded]") ? "Time Machine reports this folder excluded now; existing backups are not removed." : "Time Machine exclusion could not be verified; backups may retain files."
    add("not-covered", "info", "none", `${WORKSPACE_DISCLOSURE} ${manifest.backup}`)
    const checks = complete(results, ["config", "runtime", "probe"], "This workspace check could not be made.", WORKSPACE_CHECKLIST)
    manifest.lastVerify = { at: new Date().toISOString(), results: checks }; await this.save(manifest)
    return { workspace: await this.view(manifest), checks, ok: blockers(checks, WORKSPACE_CHECKLIST, false).length === 0 }
  }
  async verify(name: string): Promise<WorkspaceReport> { return this.exclusive(workspaceName(name), async () => this.verifyNow(await this.manifest(name))) }
  async open(name: string, argv: unknown, options: { tty: boolean; cols?: number; rows?: number }): Promise<WorkspaceSession> {
    const command = validArgv(argv)
    return this.exclusive(workspaceName(name), async () => {
      const manifest = await this.manifest(name)
      const blocked = blockers(await this.blockingChecks(manifest), WORKSPACE_CHECKLIST, false)
      if (blocked.length) throw new PaddockError("check-failed", "Workspace execution refused by its checklist.", blocked)
      return this.launch(manifest, command, options.tty, options.cols, options.rows)
    })
  }
  async exec(name: string, argv: unknown, stdin?: string | Uint8Array): Promise<RunResult> { return (await this.open(name, argv, { tty: false })).collect(stdin, 0) }
  async stop(name: string): Promise<WorkspaceView> {
    return this.exclusive(workspaceName(name), async () => { const manifest = await this.manifest(name); await this.restoreIdentity(manifest); await stopWorkspaceProcesses(manifest.folder); return this.view(manifest) })
  }
  async remove(name: string, confirm: unknown): Promise<WorkspaceRemoval> {
    if (confirm !== workspaceName(name)) throw new PaddockError("usage", `Removing a workspace deletes its files. Give --confirm ${name}.`)
    return this.exclusive(name, async () => {
      const manifest = await this.manifest(name); await this.restoreIdentity(manifest); await stopWorkspaceProcesses(manifest.folder)
      const links = await hardLinks(manifest.folder, true)
      const bundles: string[] = []
      const walk = async (path: string) => { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) { const full = join(path, entry.name); if (entry.name.endsWith(".app")) bundles.push(full); else await walk(full) } }
      await walk(manifest.folder)
      const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
      const issues: string[] = []
      for (const bundle of bundles) { const run = await this.runHost([lsregister, "-u", bundle], { timeoutMs: 10_000 }); if (run.exitCode !== 0) issues.push(`Unregistration failed for ${bundle}.`) }
      const jobs = await this.runHost(["/bin/launchctl", "print", `gui/${process.getuid?.()}`], { timeoutMs: 10_000 })
      const launchd = jobs.exitCode === 0 ? jobs.stdout.split("\n").filter((line) => line.includes(manifest.folder)) : ["launchd inspection failed; retained jobs unknown."]
      if (workspacePids(manifest.folder).length) throw new PaddockError("check-failed", "Processes appeared during removal; folder retained.")
      // Walk without following symlinks or chmodding hard-linked regular files outside this tree.
      await rm(manifest.folder, { recursive: true, force: true })
      // Filter before collecting: this Mac's full database exceeds the runner's 16 MiB output limit.
      const references = `"$1" -dump | /usr/bin/grep -F -- "$2"
status=("\${PIPESTATUS[@]}")
[ "\${status[0]}" -eq 0 ] || exit "\${status[0]}"
[ "\${status[1]}" -le 1 ] || exit "\${status[1]}"`
      for (const deadline = Date.now() + 5000;;) {
        const registered = await this.runHost(["/bin/bash", "-c", references, "paddock-lsregister", lsregister, manifest.folder], { timeoutMs: 20_000 })
        if (registered.exitCode !== 0) { issues.push(`LaunchServices inspection failed (exit ${registered.exitCode}; ${registered.stderr.slice(0, 200)}); retained registrations unknown.`); break }
        const remaining = registered.stdout.split("\n").filter(Boolean)
        if (!remaining.length) break
        if (Date.now() >= deadline) { issues.push(...remaining); break }
        for (const bundle of bundles) await this.runHost([lsregister, "-u", bundle], { timeoutMs: 10_000 })
        await Bun.sleep(100)
      }
      await rm(this.profileFile(name), { force: true }); await rm(this.file(name), { force: true })
      return { removed: name, kind: "workspace", hardLinks: links, launchServices: issues, launchd,
        notRemoved: ["Unified system logs", "Existing Time Machine or other backups", "Remote pushes, API calls, uploads and other network effects", "Changes through hard links supplied from outside", "Spotlight retention, Keychain additions and unnamed channels are not covered"], disclosure: WORKSPACE_DISCLOSURE }
    })
  }
  closeSessions(): void { for (const session of this.sessions) session.close("The daemon stopped.") }
}
