import { randomBytes } from "node:crypto"
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, statfs, utimes, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { blockers, complete, historical, WORKSPACE_CHECKLIST } from "./checks"
import { UNCHECKED_PASSES } from "./core"
import { claudeState, credentialFiles, profileName, readCredential, type Host } from "./credentials"
import { must, systemRunner } from "./run"
import { readConfig, validDiskGb, type Dirs } from "./state"
import { object } from "./transport"
import { AsideeError, type CheckResult, type DiskWarning, type RunResult, type Runner, type WorkspaceManifest, type WorkspaceSpec } from "./types"
import { belongs, controlledDecision, decision, profileEvidence, requireMac, stopWorkspaceProcesses, workspacePids } from "./workspace-processes"
import { within, WORKSPACE_DISCLOSURE, HOST_TEMP_DISCLOSURE, workspaceDisclosure, workspaceEnvironment, workspaceProfile } from "./workspace-profile"
import { WorkspaceSession } from "./workspace-session"
import controlProfile from "./workspace-control.sb" with { type: "text" }

export type WorkspaceView = {
  kind: "workspace"; name: string; folder: string; status: "idle" | "running" | "damaged" | "unknown"
  processes?: number; sizeBytes?: number; spec?: WorkspaceSpec; createdAt?: string; lastVerify?: WorkspaceManifest["lastVerify"]
  disclosure: string; problem?: string; stopReason?: string; enforcementProblem?: { at: string; message: string }
}
export type WorkspaceReport = { workspace: WorkspaceView; checks: CheckResult[]; ok: boolean; pathSuggestions?: string[] }
export type WorkspaceRemoval = { removed: string; kind: "workspace"; hardLinks: string[]; launchServices: string[]; launchd: string[]; notRemoved: string[]; disclosure: string }

// How often the daemon measures each workspace with running processes. /usr/bin/du took 0.06 to 0.12 s on 100,000
// small files on an Apple M5 with a warm cache, so a pass costs little; a cold cache was not measured.
export const WORKSPACE_WATCH_MS = 30_000
const GiB = 1024 ** 3
const gb = (bytes: number) => (bytes / GiB).toFixed(2)

export function workspaceName(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(value)) throw new AsideeError("usage", "A workspace name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return value
}
function strings(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64 || !value.every((path) => typeof path === "string" && path.length > 0 && path.length < 4096 && !/[\x00-\x1f]/.test(path))) throw new AsideeError("usage", `${label} must be at most 64 paths without control characters.`)
  return value
}
export function validWorkspaceSpec(input: Record<string, unknown>): WorkspaceSpec {
  if (input.loopback !== undefined && input.loopback !== "open") throw new AsideeError("usage", "Workspace loopback is open. Declared ports are not available in this version.")
  if (input.hostTemp !== undefined && typeof input.hostTemp !== "boolean") throw new AsideeError("usage", "hostTemp must be a boolean.")
  const copy = input.copy === undefined ? undefined : strings([input.copy], "copy")[0]
  const selected = input.logins ?? { kind: "profiles", claude: "default", codex: "default" }
  if (!object(selected) || (selected.kind !== "none" && selected.kind !== "profiles")) throw new AsideeError("usage", "logins must select named profiles or none.")
  const profile = (value: unknown) => { if (typeof value !== "string") throw new AsideeError("usage", "Choose a named login profile."); try { return profileName(value) } catch { throw new AsideeError("usage", "A login profile is 1 to 48 letters, digits, underscores or hyphens.") } }
  const logins: WorkspaceSpec["logins"] = selected.kind === "none" ? { kind: "none" } : { kind: "profiles", claude: profile(selected.claude), codex: profile(selected.codex) }
  return { name: workspaceName(input.name), hostTemp: input.hostTemp ?? false, diskGb: validDiskGb(input.diskGb, "Disk (GiB)"), reads: strings(input.reads, "reads"), path: strings(input.path, "path"), loopback: "open", ...(copy ? { copy } : {}), logins }
}
export const validArgv = (value: unknown): string[] => {
  if (!Array.isArray(value) || !value.length || !value.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new AsideeError("usage", "workspace exec needs a command after --.")
  return value
}

// Waits up to about a second for a starter to carry its profile. A rare refusal here has no known cause yet, so it says what was seen.
export async function acquire(session: WorkspaceSession, folder: string, what: string): Promise<void> {
  const started = Date.now(); let stderr = ""; let exit: { code?: number; error?: string } | undefined
  session.on("output", (which: "stdout" | "stderr", bytes: Uint8Array) => { if (which === "stderr" && stderr.length < 2000) stderr += Buffer.from(bytes).toString("utf8") })
  session.once("end", (ended: { code?: number; error?: string }) => { exit = ended })
  session.resume()
  for (let i = 0; i < 100 && !belongs(session.pid, folder); i++) { if (session.ended) break; await Bun.sleep(10) }
  if (belongs(session.pid, folder)) return
  const ended = !session.ended ? "it was still running" : exit?.error ? `it ended (${exit.error})` : `it ended (exit ${exit?.code ?? "unknown"})`
  const said = stderr.trim() ? `stderr ${JSON.stringify(stderr.trim().slice(0, 500))}` : "no stderr"
  throw new Error(`${what} did not acquire its expected profile after ${Date.now() - started} ms: ${ended}; ${said}; ${profileEvidence(session.pid, folder)}. The cause of this refusal is not known yet.`)
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
    throw new AsideeError("usage", "--read cannot expose the home folder, ~/.ssh, a workspace, the workspaces folder or Asidee state.")
  if (["/private/tmp", "/private/var/tmp", "/private/var/folders"].some((entry) => within(path, entry) || within(entry, path))) throw new AsideeError("usage", "--read cannot reopen shared temporary folders.")
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
  private readonly sessions = new Map<WorkspaceSession, string>()
  // One du per workspace at a time: a second caller shares the measurement in flight.
  private readonly measuring = new Map<string, Promise<{ bytes: number; complete: boolean } | undefined>>()
  private readonly unmeasured = new Map<string, number>()
  private readonly watchProblems = new Map<string, { at: string; message: string }>()
  constructor(readonly dirs: Dirs, private readonly env: NodeJS.ProcessEnv = process.env, private readonly loginHost?: Host, private readonly runHost: Runner = systemRunner) {}
  private exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(task, task)
    this.locks.set(name, next.catch(() => {})); return next
  }
  private async locations() {
    requireMac()
    const home = await realpath(userInfo().homedir)
    const root = await canonical(this.env.ASIDEE_WORKSPACES_ROOT ?? join(home, "Asidee"))
    const state = await canonical(this.dirs.state)
    if (root === home || !within(root, home) || within(root, state) || within(state, root) || within(root, await canonical(join(home, ".ssh"))))
      throw new AsideeError("usage", "The workspaces root must be strictly inside the real home, separate from ~/.ssh and Asidee state.")
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AsideeError("not-found", `There is no workspace named ${name}.`)
      throw new AsideeError("check-failed", `The workspace manifest for ${name} cannot be read.`)
    }
    if (!object(input) || input.version !== 1 || input.kind !== "workspace" || input.name !== name || typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id)
      || input.folder !== join(root, name) || input.home !== home || input.tag !== join(root, name, ".asidee-tag") || !object(input.spec)
      || typeof input.userVar !== "string" || !isAbsolute(input.userVar) || typeof input.profileHash !== "string" || !/^[a-f0-9]{64}$/.test(input.profileHash)
      || typeof input.macOS !== "string" || typeof input.createdAt !== "string" || !Array.isArray(input.reads) || !Array.isArray(input.logins) || typeof input.backup !== "string")
      throw new AsideeError("check-failed", `The workspace manifest for ${name} is invalid. Nothing was started or removed.`)
    const spec = validWorkspaceSpec(input.spec)
    if (spec.name !== name || !input.reads.every((read) => object(read) && typeof read.given === "string" && typeof read.canonical === "string" && isAbsolute(read.canonical) && typeof read.resolvedAt === "string")
      || !input.logins.every((login) => object(login) && (login.agent === "claude" || login.agent === "codex") && typeof login.copied === "boolean" && typeof login.detail === "string"))
      throw new AsideeError("check-failed", `The workspace manifest for ${name} is invalid.`)
    return { ...input, spec } as WorkspaceManifest
  }
  private async names() { return (await readdir(join(this.dirs.state, "workspaces")).catch(() => [])).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort() }
  private async restoreIdentity(manifest: WorkspaceManifest) {
    const { root } = await this.locations()
    if (await canonical(root) !== root) throw new AsideeError("check-failed", "A workspace parent was replaced by a symlink; nothing was signalled or removed.")
    const folder = await lstat(manifest.folder).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined })
    if (folder && !folder.isDirectory()) throw new AsideeError("check-failed", "The workspace folder was replaced by a symlink or another file; nothing was signalled or removed.")
    await mkdir(manifest.folder, { recursive: true, mode: 0o700 }); await chmod(manifest.folder, 0o700)
    if (await realpath(manifest.folder) !== manifest.folder) throw new AsideeError("check-failed", "The workspace folder is no longer canonical.")
    const tag = await lstat(manifest.tag).catch(() => undefined)
    if (tag && (!tag.isFile() || tag.nlink !== 1)) throw new AsideeError("check-failed", "The workspace tag is not a private regular file.")
    if (!tag) await writeFile(manifest.tag, manifest.id, { flag: "wx", mode: 0o444 })
    else if (await readFile(manifest.tag, "utf8") !== manifest.id) throw new AsideeError("check-failed", "The workspace tag identity changed.")
  }
  // The folder's size as du counts it, private tmp included. A du that fails part way still gives a lower bound.
  private measure(manifest: WorkspaceManifest): Promise<{ bytes: number; complete: boolean } | undefined> {
    const running = this.measuring.get(manifest.folder)
    if (running) return running
    const measured = this.runHost(["/usr/bin/du", "-sk", manifest.folder], { timeoutMs: 60_000 }).then((size) => {
      const kb = /^(\d+)\s/.exec(size.stdout)?.[1]
      return kb === undefined ? undefined : { bytes: Number(kb) * 1024, complete: size.exitCode === 0 }
    }).finally(() => this.measuring.delete(manifest.folder))
    this.measuring.set(manifest.folder, measured)
    return measured
  }
  // statfs "available" space on the volume that holds the folder; macOS purgeable space is not counted.
  protected async freeBytes(folder: string): Promise<number> { const volume = await statfs(folder); return volume.bavail * volume.bsize }
  private async freeSpace(folder: string): Promise<{ free: number; floorGb: number; low: boolean; sentence: string }> {
    const floorGb = (await readConfig(this.dirs)).workspaceFreeSpaceGb; const free = await this.freeBytes(folder)
    const low = free < floorGb * GiB
    return { free, floorGb, low, sentence: low
      ? `This Mac has ${gb(free)} GiB free where workspaces live, below the ${floorGb} GiB floor. Free space on this Mac, or change the floor: asd config set workspace-free-space GiB`
      : `${gb(free)} GiB free where workspaces live; the floor is ${floorGb} GiB. Purgeable space is not counted.` }
  }
  // Ends with the command, so nothing follows it on the line.
  private overLimit(manifest: WorkspaceManifest, usedBytes: number, then = ""): string {
    return `${manifest.name} uses ${gb(usedBytes)} GiB of its ${manifest.spec.diskGb} GiB disk limit${then}. Free space in ${manifest.folder}, or raise the limit: asd workspace set ${manifest.name} disk N`
  }
  private async view(manifest: WorkspaceManifest, withSize = false): Promise<WorkspaceView> {
    let processes: number | undefined; let problem: string | undefined
    try { processes = workspacePids(manifest.folder).length } catch (error) { problem = (error as Error).message }
    const size = withSize ? await this.measure(manifest) : undefined
    const watchProblem = this.watchProblems.get(manifest.name)
    return { kind: "workspace", name: manifest.name, folder: manifest.folder, status: processes === undefined ? "unknown" : processes ? "running" : "idle", processes,
      ...(size?.complete ? { sizeBytes: size.bytes } : {}), spec: manifest.spec, createdAt: manifest.createdAt, lastVerify: historical(manifest.lastVerify), disclosure: workspaceDisclosure(manifest.spec.hostTemp), problem,
      ...(manifest.stopReason ? { stopReason: manifest.stopReason } : {}), ...(watchProblem ? { enforcementProblem: watchProblem } : {}) }
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
      if (await lstat(this.file(spec.name)).catch(() => undefined) || await lstat(folder).catch(() => undefined)) throw new AsideeError("conflict", `Workspace ${spec.name} or its folder already exists.`)
      const existing = (await Promise.all((await this.names()).map((name) => this.manifest(name)))).map((entry) => entry.folder)
      const protectedPaths = { home, root, state, workspaces: existing, ssh: await canonical(join(home, ".ssh")) }
      // Still exit 1, as a raw ENOENT was; only the words change.
      const real = (given: string, flag: string) => realpath(expand(given, home)).catch((error: NodeJS.ErrnoException) => {
        throw error.code === "ENOENT" ? new AsideeError("runtime", `${flag} ${given} does not exist on this Mac; nothing was created.`) : error
      })
      const reads: WorkspaceManifest["reads"] = []
      for (const given of spec.reads) {
        const path = await real(given, "--read"); validateRead(path, protectedPaths)
        reads.push({ given, canonical: path, resolvedAt: new Date().toISOString() })
      }
      for (const path of spec.path) {
        const canonicalPath = await real(path, "--path")
        if (!(await lstat(canonicalPath)).isDirectory() || canonicalPath.includes(":")) throw new AsideeError("usage", "--path must be a directory without a colon.")
        if (within(canonicalPath, home) && !reads.some((read) => within(canonicalPath, read.canonical))) throw new AsideeError("usage", "A --path directory under home also needs an allowed --read.")
      }
      spec.path = await Promise.all(spec.path.map((path) => realpath(expand(path, home))))
      const source = spec.copy ? await real(spec.copy, "--copy") : undefined
      if (source && (!(await lstat(source)).isDirectory() || within(folder, source) || within(source, root) || within(source, state))) throw new AsideeError("usage", "--copy must be a project directory separate from workspace and state folders.")
      const temp = must(await this.runHost(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]), "Finding this user's temp folder").stdout.trim()
      if (spec.hostTemp && await realpath(temp) !== join(await realpath(dirname(temp)), "T")) throw new AsideeError("check-failed", "DARWIN_USER_TEMP_DIR is not the canonical per-user T folder.")
      const manifest: WorkspaceManifest = { version: 1, kind: "workspace", name: spec.name, id: randomBytes(16).toString("hex"), spec, folder, tag: join(folder, ".asidee-tag"), home,
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
    if (profile.hash !== manifest.profileHash || await readFile(this.profileFile(manifest.name), "utf8") !== profile.text) throw new AsideeError("check-failed", `The workspace profile changed; execution refused. To regenerate it from this workspace's saved settings (Asidee updates can change it), stop the workspace and run: asd workspace set ${manifest.name} host-temp ${manifest.spec.hostTemp ? "on" : "off"}`)
    for (const path of [manifest.home, manifest.userVar, ...manifest.reads.map((read) => read.canonical), ...manifest.spec.path])
      if (await realpath(path) !== path) throw new AsideeError("check-failed", "A canonical profile path changed; execution refused.")
    if (manifest.spec.hostTemp && await realpath(join(manifest.userVar, "T")) !== join(manifest.userVar, "T")) throw new AsideeError("check-failed", "The host temp folder is no longer canonical.")
    const session = new WorkspaceSession({ argv: ["/usr/bin/sandbox-exec", "-f", this.profileFile(manifest.name), ...profile.params.flatMap((value) => ["-D", value]), "--", ...argv],
      env: workspaceEnvironment(manifest, this.env), cwd: join(manifest.folder, "work"), folder: manifest.folder, tty, cols, rows })
    this.sessions.set(session, manifest.folder); session.on("end", () => this.sessions.delete(session))
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
    let tempFixture: string | undefined
    let socketFixture: string | undefined
    const servers: Array<ReturnType<typeof createServer>> = []
    try {
      await this.restoreIdentity(manifest)
      try { const space = await this.freeSpace(manifest.folder); add("free-space", space.low ? "fail" : "pass", "inspected", space.sentence) }
      catch (error) { add("free-space", "unknown", "none", `Free space where workspaces live could not be read: ${(error as Error).message}`) }
      const before = workspacePids(manifest.folder)
      probe = await this.launch(manifest, ["/bin/sleep", "30"])
      await acquire(probe, manifest.folder, "The live probe")
      add("seatbelt", "pass", "inspected", `Profile sha256 ${manifest.profileHash}; canonical -D parameters; macOS ${manifest.macOS} at creation.`)
      const pids = workspacePids(manifest.folder)
      add("processes", pids.includes(probe.pid) ? "pass" : "fail", "probed", `${before.length} processes before the known probe; finder ${pids.length} including its pid. Kernel tag criterion and uid checked. K15 supplies the independent empty-workspace control.`)
      fixture = join(dirname(manifest.folder), `.asidee-probe-${randomBytes(8).toString("hex")}`)
      await mkdir(fixture, { mode: 0o700 }); const target = join(fixture, "outside")
      const controlFile = join(fixture, "control.sb"); await writeFile(controlFile, controlProfile, { mode: 0o600 })
      control = new WorkspaceSession({ argv: ["/usr/bin/sandbox-exec", "-f", controlFile, "-D", `WS=${manifest.folder}`, "-D", `TAGFILE=${manifest.tag}`, "--", "/bin/sleep", "30"],
        env: workspaceEnvironment(manifest, this.env), cwd: join(manifest.folder, "work"), folder: manifest.folder, tty: false })
      await acquire(control, manifest.folder, "The confined decision control")
      await writeFile(target, "control")
      const write = await this.run(manifest, ["/bin/sh", "-c", 'printf changed > "$1"', "probe", target])
      const insideWrite = await this.run(manifest, ["/bin/sh", "-c", 'printf inside > "$TMPDIR/asidee-write-probe" && rm "$TMPDIR/asidee-write-probe"'])
      const writeRefused = write.exitCode !== 0 && await readFile(target, "utf8") === "control"
      add("writes", writeRefused && insideWrite.exitCode === 0 ? "pass" : "fail", "probed", `Sibling write ${writeRefused ? "refused" : "not refused"}; inside write ${insideWrite.exitCode === 0 ? "succeeded" : "failed"}. Home/shared-temp decisions use same-operation allowed controls in a confined profile.`)
      const read = await this.run(manifest, ["/bin/cat", target])
      const closed = [manifest.home, "/private/tmp", "/private/var/tmp", manifest.userVar, join(manifest.userVar, "C"), join(manifest.userVar, "0"), ...(!manifest.spec.hostTemp ? [join(manifest.userVar, "T")] : [])]
      const readControl = decision(probe.pid, "file-read-data", 1, manifest.folder) === 0 && closed.every((path) => controlledDecision(probe!.pid, control!.pid, "file-read-data", 1, path) !== "unknown")
      const denied = closed.every((path) => controlledDecision(probe!.pid, control!.pid, "file-read-data", 1, path) === "denied")
      add("home-closed", !readControl ? "unknown" : read.exitCode !== 0 && denied ? "pass" : "fail", "probed", `Sibling home read ${read.exitCode !== 0 ? "refused" : "allowed"}; allowed confined controls ${readControl ? "answered" : "unavailable"}; shared-temp decisions ${denied ? "denied" : "not established as denied"}. Read allowances: ${manifest.reads.map((read) => read.canonical).join(", ") || "none"}.`)
      const writeTargets = closed
      const writeAnswers = writeTargets.map((path) => decision(probe!.pid, "file-write-create", 1, path))
      if (decision(probe.pid, "file-write-create", 1, manifest.folder) !== 0 || writeAnswers.some((answer) => answer !== 0 && answer !== 1))
        results[results.findIndex((result) => result.id === "writes")] = { id: "writes", status: "unknown", evidence: "probed", detail: "A live write control or kernel decision for home/shared temp could not be established." }
      else if (writeAnswers.includes(0)) results[results.findIndex((result) => result.id === "writes")] = { id: "writes", status: "fail", evidence: "probed", detail: "An outside file-write-create decision was allowed beside the same-operation allowed control inside the workspace." }
      const tempChecks = results.filter((check) => check.id === "writes" || check.id === "home-closed").map((check) => ({ check, status: check.status, detail: check.detail }))
      for (const { check } of tempChecks) {
        check.status = "unknown"
        check.detail += ` Host temp probe required. ${manifest.spec.hostTemp ? HOST_TEMP_DISCLOSURE : "host-temp is off."}`
      }
      tempFixture = await mkdtemp(join(manifest.userVar, "T", "asidee-check-"))
      const tempSource = join(tempFixture, "source"); const tempTarget = join(tempFixture, "created")
      await writeFile(tempSource, "host-temp-control")
      const tempRead = await this.run(manifest, ["/bin/cat", tempSource])
      const tempWrite = await this.run(manifest, ["/bin/sh", "-c", 'printf host-temp-created > "$1" && cat "$1"', "probe", tempTarget])
      const tempOpen = tempRead.exitCode === 0 && tempRead.stdout === "host-temp-control" && tempWrite.exitCode === 0 && tempWrite.stdout === "host-temp-created"
      const tempClosed = tempRead.exitCode !== 0 && tempWrite.exitCode !== 0 && !await stat(tempTarget).catch(() => undefined)
      for (const { check: result, status, detail } of tempChecks) {
        result.status = status; result.detail = detail
        const expected = manifest.spec.hostTemp ? tempOpen : tempClosed
        if (!expected) result.status = "fail"
        else if (manifest.spec.hostTemp && result.status === "pass") result.status = "weak"
        result.detail += ` Host temp T read/create/read-back ${expected ? "matched" : "did not match"} host-temp ${manifest.spec.hostTemp ? "on" : "off"}; home, /private/tmp, /private/var/tmp, user-var parent, C and 0 decisions checked. ${manifest.spec.hostTemp ? HOST_TEMP_DISCLOSURE : "Shared host temp remains closed."}`
      }
      const controls = (checks: Array<[string, number, string]>) => checks.every(([op, type, arg]) => controlledDecision(probe!.pid, control!.pid, op, type, arg) !== "unknown"
        && (op !== "mach-lookup" || decision(probe!.pid, op, type, "com.apple.system.logger") === 0))
      const refuses = (checks: Array<[string, number, string]>) => checks.every(([op, type, arg]) => controlledDecision(probe!.pid, control!.pid, op, type, arg) === "denied")
      const launchChannels: Array<[string, number, string]> = [["lsopen", 0, ""], ["job-creation", 0, ""], ["mach-lookup", 2, "com.apple.lsd.modifydb"]]
      // A real listener, answered by an unconfined control, in a private fixture and in shared host temp T, which the
      // host-temp setting opens for files but not for connections.
      const marker = "asidee-socket-control\n"
      const listener = async (socket: string) => {
        const server = createServer((connection) => connection.end(marker)); servers.push(server)
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve) })
        const unconfined = await this.runHost(["/usr/bin/nc", "-w", "1", "-U", socket], { timeoutMs: 3000 })
        const attempt = await this.run(manifest, ["/usr/bin/nc", "-w", "1", "-U", socket])
        const answered = unconfined.exitCode === 0 && unconfined.stdout === marker; const denied = attempt.exitCode === 1 && attempt.stdout === ""
        return { known: answered && (attempt.exitCode === 0 || denied), denied, control: answered ? "answered" : `failed (exit ${unconfined.exitCode})` }
      }
      socketFixture = await mkdtemp("/private/tmp/asidee-check-")
      const outside = await listener(join(socketFixture, "control.sock"))
      const temp = await listener(join(tempFixture, "control.sock"))
      add("daemons", !controls(launchChannels) || !outside.known || !temp.known ? "unknown" : refuses(launchChannels) && outside.denied && temp.denied ? manifest.spec.hostTemp ? "weak" : "pass" : "fail", "probed", `A real Unix-socket listener control ${outside.control}; confined connect ${outside.denied ? "refused" : "not established as refused"}. In shared host temp T, with host-temp ${manifest.spec.hostTemp ? "on" : "off"}, a listener control ${temp.control}; confined connect ${temp.denied ? "refused" : "not established as refused"}. Allowed confined policy controls ${controls(launchChannels) ? "answered" : "unavailable"}; decisions ${launchChannels.map(([op, type, arg]) => op + "=" + controlledDecision(probe!.pid, control!.pid, op, type, arg)).join(", ")}. ${manifest.spec.hostTemp ? "Host-temp lets this workspace delete socket files in T and create listeners there. " : ""}Apple events are not covered.`)
      const data: Array<[string, number, string]> = [["user-preference-read", 6, "com.apple.finder"], ["user-preference-write", 6, "com.apple.finder"], ["mach-lookup", 2, "com.apple.pasteboard.1"], ["signal", 0, ""], ["process-info-pidinfo", 0, ""]]
      add("user-data", !controls(data) ? "unknown" : refuses(data) ? "pass" : "fail", "probed", `Preferences, pasteboard lookup, signals and process-info-pidinfo allowed confined controls ${controls(data) ? "answered" : "unavailable"}; denials ${refuses(data) ? "confirmed" : "not established"}. End-to-end coverage is K11/K12.`)
    } catch (error) {
      const failed: CheckResult = { id: "seatbelt", status: "fail", evidence: "none", detail: (error as Error).message }
      const index = results.findIndex((check) => check.id === "seatbelt")
      if (index < 0) results.push(failed)
      else results[index] = failed
    }
    finally {
      if (probe) { probe.close(); await probe.finished }
      if (control) { control.close(); await control.finished }
      for (const server of servers) if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      if (tempFixture) await rm(tempFixture, { recursive: true, force: true })
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
      const movie = join(manifest.folder, "tmp", `asidee-gpu-${randomBytes(8).toString("hex")}.mov`)
      try {
        const encoded = await this.run(manifest, ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=5:d=0.4", "-c:v", "hevc_videotoolbox", "-allow_sw", "0", "-y", movie])
        const written = (await stat(movie).catch(() => undefined))?.size ?? 0
        add("gpu", encoded.exitCode === 0 && written > 0 ? "pass" : "fail", "probed", `Hardware-only HEVC VideoToolbox encode ${encoded.exitCode === 0 && written > 0 ? "produced a nonempty movie" : "failed (exit " + encoded.exitCode + ")"}; software fallback disabled. Metal compute is not covered by this check.`)
      } catch { add("gpu", "unknown", "none", "The hardware encode probe could not run. Metal compute is not covered by this check.") }
      finally { await rm(movie, { force: true }) }
    }
    const watched = `Watched, not capped: while the daemon runs it measures this folder, private tmp included, every ${WORKSPACE_WATCH_MS / 1000} seconds and stops the workspace's processes once it passes ${manifest.spec.diskGb} GiB, so it can overshoot. Nothing watches it while no daemon runs.`
    const used = await this.measure(manifest)
    if (!used || (!used.complete && used.bytes <= manifest.spec.diskGb * GiB)) add("disk", "unknown", "none", `${watched} Its size could not be measured now.`)
    else add("disk", used.bytes > manifest.spec.diskGb * GiB ? "fail" : "weak", "inspected", `${watched} It uses ${gb(used.bytes)} GiB now.`)
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
    try { const links = await hardLinks(manifest.folder); add("hard-links", links.length ? "weak" : "info", "inspected", links.length ? `Multiple links, possibly shared outside: ${links.join(", ")}. Outside links cannot be located reliably.` : "No regular files with link count > 1 now. Asidee never copies with hard links.") }
    catch { add("hard-links", "unknown", "none", "Could not walk all workspace files.") }
    const backup = await this.runHost(["/usr/bin/tmutil", "isexcluded", manifest.folder], { timeoutMs: 5000 })
    manifest.backup = backup.exitCode === 0 && backup.stdout.includes("[Excluded]") ? "Time Machine reports this folder excluded now; existing backups are not removed." : "Time Machine exclusion could not be verified; backups may retain files."
    add("not-covered", "info", "none", `${workspaceDisclosure(manifest.spec.hostTemp)} ${manifest.backup}`)
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
      // The checks go in the message too: a stream session (shell, exec --stream) carries only the message.
      if (blocked.length) throw new AsideeError("check-failed", `Workspace execution refused by its checklist: ${blocked.map((check) => `${WORKSPACE_CHECKLIST.find((item) => item.id === check.id)?.title ?? check.id} (${check.status}): ${check.detail}`).join(" ")}`, blocked)
      // Over its limit, a launch still runs, so space can be freed from inside; the daemon stops it again if not.
      const used = await this.measure(manifest); const limitBytes = manifest.spec.diskGb * GiB
      const diskWarning: DiskWarning | undefined = used && used.bytes > limitBytes ? { usedBytes: used.bytes, limitBytes,
        message: this.overLimit(manifest, used.bytes, `, so the daemon stops its processes again within about ${WORKSPACE_WATCH_MS / 1000} seconds unless space is freed`) } : undefined
      if (manifest.stopReason) { delete manifest.stopReason; await this.save(manifest) }
      const session = await this.launch(manifest, command, options.tty, options.cols, options.rows)
      session.diskWarning = diskWarning
      return session
    })
  }
  async exec(name: string, argv: unknown, stdin?: string | Uint8Array, signal?: AbortSignal): Promise<RunResult & { diskWarning?: DiskWarning }> {
    const session = await this.open(name, argv, { tty: false })
    const result = session.collect(stdin, 0)
    const abort = () => session.close("The buffered exec client disconnected.")
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    try { const output = await result; return session.diskWarning ? { ...output, diskWarning: session.diskWarning } : output } finally { signal?.removeEventListener("abort", abort) }
  }
  async set(name: string, input: Record<string, unknown>): Promise<WorkspaceView> {
    if ((input.diskGb === undefined) === (input.hostTemp === undefined)) throw new AsideeError("usage", "Set hostTemp or diskGb, one at a time.")
    return input.diskGb !== undefined ? this.setDisk(name, input.diskGb) : this.setHostTemp(name, input.hostTemp)
  }
  // The limit is only watched, so it changes now, also while processes run.
  async setDisk(name: string, diskGb: unknown): Promise<WorkspaceView> {
    if (diskGb === null || diskGb === "") throw new AsideeError("usage", "Give the disk limit in GiB.")
    const limit = validDiskGb(diskGb, "Disk (GiB)")
    return this.exclusive(workspaceName(name), async () => {
      const manifest = await this.manifest(name)
      manifest.spec.diskGb = limit
      await this.save(manifest)
      return this.view(manifest)
    })
  }
  async setHostTemp(name: string, hostTemp: unknown): Promise<WorkspaceView> {
    if (typeof hostTemp !== "boolean") throw new AsideeError("usage", "hostTemp must be a boolean.")
    return this.exclusive(workspaceName(name), async () => {
      const manifest = await this.manifest(name)
      await this.restoreIdentity(manifest)
      if ([...this.sessions.values()].includes(manifest.folder) || workspacePids(manifest.folder).length) throw new AsideeError("conflict", "Stop the workspace before changing host-temp; running processes retain their launch policy.")
      if (hostTemp) {
        const temp = must(await this.runHost(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]), "Finding this user's temp folder").stdout.trim()
        if (await realpath(temp) !== join(manifest.userVar, "T")) throw new AsideeError("check-failed", "The host temp folder is no longer canonical or belongs to another user-var folder.")
      }
      manifest.spec.hostTemp = hostTemp
      const profile = workspaceProfile(manifest)
      await writeFile(this.profileFile(name), profile.text, { mode: 0o600 })
      manifest.profileHash = profile.hash
      delete manifest.lastVerify
      await this.save(manifest)
      return this.view(manifest)
    })
  }
  // The daemon's pass: each workspace with running processes is stopped, with the reason recorded, when free space
  // where workspaces live is below the floor or the workspace is over its disk limit. A workspace it cannot check
  // for UNCHECKED_PASSES passes in a row is stopped too, as a sandbox is.
  async watch(): Promise<void> {
    for (const name of await this.names()) {
      try {
        const manifest = await this.manifest(name)
        if (!workspacePids(manifest.folder).length) { this.unmeasured.delete(name); this.watchProblems.delete(name); continue }
        const at = new Date().toISOString()
        const space = await this.freeSpace(manifest.folder).catch(() => undefined)
        if (space?.low) { await this.stopBecause(manifest.name, `Stopped by the daemon at ${at}: ${space.sentence}`); continue }
        const used = await this.measure(manifest)
        if (used && used.bytes > manifest.spec.diskGb * GiB) { await this.stopBecause(manifest.name, `Stopped by the daemon at ${at}: ${this.overLimit(manifest, used.bytes)}`); continue }
        if (space && used?.complete) { this.unmeasured.delete(name); this.watchProblems.delete(name); continue }
        const count = (this.unmeasured.get(name) ?? 0) + 1; this.unmeasured.set(name, count)
        const message = space ? "Its size could not be measured." : "Free space where workspaces live could not be read."
        this.watchProblems.set(name, { at, message: `${message} After ${UNCHECKED_PASSES} such passes in a row its processes are stopped (this is ${count}).` })
        if (count >= UNCHECKED_PASSES) await this.stopBecause(manifest.name, `Stopped by the daemon at ${at}: for ${UNCHECKED_PASSES} passes in a row it could not check disk use. ${message}`)
      } catch (error) { this.watchProblems.set(name, { at: new Date().toISOString(), message: `The disk watch could not check it: ${(error as Error).message}` }) }
    }
  }
  private async stopProcesses(manifest: WorkspaceManifest, reason: string): Promise<void> {
    for (const [session, folder] of this.sessions) if (folder === manifest.folder) session.stopping(reason)
    await stopWorkspaceProcesses(manifest.folder)
  }
  private stopBecause(name: string, reason: string): Promise<void> {
    return this.exclusive(name, async () => {
      const manifest = await this.manifest(name)
      // Its processes may have ended while this pass measured; then there is nothing to stop or record.
      if (!workspacePids(manifest.folder).length) return
      await this.restoreIdentity(manifest); await this.stopProcesses(manifest, reason)
      manifest.stopReason = reason; await this.save(manifest)
      this.unmeasured.delete(name); this.watchProblems.delete(name)
    })
  }
  async stop(name: string): Promise<WorkspaceView> {
    return this.exclusive(workspaceName(name), async () => { const manifest = await this.manifest(name); await this.restoreIdentity(manifest); await this.stopProcesses(manifest, `Stopped by asd workspace stop ${name}.`); return this.view(manifest) })
  }
  async remove(name: string, confirm: unknown): Promise<WorkspaceRemoval> {
    if (confirm !== workspaceName(name)) throw new AsideeError("usage", `Removing a workspace deletes its files. Give --confirm ${name}.`)
    return this.exclusive(name, async () => {
      const manifest = await this.manifest(name); await this.restoreIdentity(manifest); await this.stopProcesses(manifest, `Stopped by asd workspace remove ${name}.`)
      const links = await hardLinks(manifest.folder, true)
      const bundles: string[] = []
      const walk = async (path: string) => { for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) { const full = join(path, entry.name); if (entry.name.endsWith(".app")) bundles.push(full); else await walk(full) } }
      await walk(manifest.folder)
      const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
      const issues: string[] = []
      for (const bundle of bundles) { const run = await this.runHost([lsregister, "-u", bundle], { timeoutMs: 10_000 }); if (run.exitCode !== 0) issues.push(`Unregistration failed for ${bundle}.`) }
      const jobs = await this.runHost(["/bin/launchctl", "print", `gui/${process.getuid?.()}`], { timeoutMs: 10_000 })
      const launchd = jobs.exitCode === 0 ? jobs.stdout.split("\n").filter((line) => line.includes(manifest.folder)) : ["launchd inspection failed; retained jobs unknown."]
      if (workspacePids(manifest.folder).length) throw new AsideeError("check-failed", "Processes appeared during removal; folder retained.")
      // Walk without following symlinks or chmodding hard-linked regular files outside this tree.
      await rm(manifest.folder, { recursive: true, force: true })
      // Filter before collecting: this Mac's full database exceeds the runner's 16 MiB output limit.
      const references = `"$1" -dump | /usr/bin/grep -F -- "$2"
status=("\${PIPESTATUS[@]}")
[ "\${status[0]}" -eq 0 ] || exit "\${status[0]}"
[ "\${status[1]}" -le 1 ] || exit "\${status[1]}"`
      for (const deadline = Date.now() + 5000;;) {
        const registered = await this.runHost(["/bin/bash", "-c", references, "asidee-lsregister", lsregister, manifest.folder], { timeoutMs: 20_000 })
        if (registered.exitCode !== 0) { issues.push(`LaunchServices inspection failed (exit ${registered.exitCode}; ${registered.stderr.slice(0, 200)}); retained registrations unknown.`); break }
        const remaining = registered.stdout.split("\n").filter(Boolean)
        if (!remaining.length) break
        if (Date.now() >= deadline) { issues.push(...remaining); break }
        for (const bundle of bundles) await this.runHost([lsregister, "-u", bundle], { timeoutMs: 10_000 })
        await Bun.sleep(100)
      }
      await rm(this.profileFile(name), { force: true }); await rm(this.file(name), { force: true })
      this.unmeasured.delete(name); this.watchProblems.delete(name)
      return { removed: name, kind: "workspace", hardLinks: links, launchServices: issues, launchd,
        notRemoved: ["Unified system logs", "Existing Time Machine or other backups", "Remote pushes, API calls, uploads and other network effects", "Changes through hard links supplied from outside", "Spotlight retention, Keychain additions and unnamed channels are not covered"], disclosure: workspaceDisclosure(manifest.spec.hostTemp) }
    })
  }
  closeSessions(): void { for (const session of this.sessions.keys()) session.close("The daemon stopped.") }
}
