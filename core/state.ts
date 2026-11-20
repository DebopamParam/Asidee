import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { AsideeError, type Manifest, type SandboxSpec } from "./types"

export type Dirs = { state: string; config: string }
export function defaultDirs(env: Record<string, string | undefined> = process.env): Dirs {
  return {
    state: env.ASIDEE_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "asidee"),
    config: env.ASIDEE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "asidee"),
  }
}
export const socketPath = (dirs: Dirs) => join(dirs.state, "daemon.sock")
// Sessions (core/stream.ts). Its path is shorter than the API socket's, so the length check below covers it.
export const streamSocketPath = (dirs: Dirs) => join(dirs.state, "stream.sock")
// The operating system limits a socket's path (104 bytes on macOS, 108 on Linux). Past it the daemon cannot listen.
export function checkSocketPath(dirs: Dirs): void {
  if (Buffer.byteLength(socketPath(dirs)) > 100) throw new AsideeError("usage", `The state folder's path is too long for the daemon's socket (${socketPath(dirs)}). Set ASIDEE_STATE_DIR to a shorter path.`)
}
export const daemonFile = (dirs: Dirs) => join(dirs.state, "daemon.json")

export const DEFAULT_SPEC = { image: "docker/sandbox-templates:shell-docker", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, docker: false }

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
export function validName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new AsideeError("usage", "A sandbox name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return name
}
// A template's name is also its tag on the engine, so it follows the same rule.
export function validTemplateName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new AsideeError("usage", "A template name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return name
}

function number(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new AsideeError("usage", `${label} must be a number from ${min} to ${max}.`)
  return parsed
}

// The range of each size, the same for create and resize.
export type Sizes = Pick<SandboxSpec, "cpus" | "memoryGb" | "pids" | "diskGb">
const RANGES: Record<keyof Sizes, [string, number, number]> = { cpus: ["CPUs", 0.25, 64], memoryGb: ["Memory (GB)", 0.25, 256], pids: ["The process limit", 64, 65_536], diskGb: ["Disk (GB)", 1, 2000] }
// A workspace's watched disk limit has the same range and default as a sandbox's.
export const validDiskGb = (value: unknown, label = RANGES.diskGb[0]) => number(value, label, RANGES.diskGb[1], RANGES.diskGb[2], DEFAULT_SPEC.diskGb)
export function validSizes(input: Record<string, unknown>, base: Sizes): Sizes {
  const size = (key: keyof Sizes) => number(input[key], ...RANGES[key], base[key])
  return { cpus: size("cpus"), memoryGb: size("memoryGb"), pids: Math.round(size("pids")), diskGb: size("diskGb") }
}

// The only way a spec is made. Unknown fields are dropped, so a client cannot smuggle an engine option through.
// A default template applies only when the request names neither an image nor a template.
export type Defaults = Partial<typeof DEFAULT_SPEC> & { template?: string }
export const DEFAULT_KEYS_ALLOWED = [...Object.keys(DEFAULT_SPEC), "template"]
export function validSpec(input: Record<string, unknown>, defaults: Defaults = {}): SandboxSpec {
  const base = { ...DEFAULT_SPEC, ...defaults }
  const named = (value: unknown) => value !== undefined && value !== ""
  if (named(input.template) && named(input.image)) throw new AsideeError("usage", "Give an image or a template, not both.")
  const template = named(input.template) ? validTemplateName(input.template) : !named(input.image) && named(base.template) ? validTemplateName(base.template) : undefined
  const image = named(input.image) ? input.image : base.image
  if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(image)) throw new AsideeError("usage", "The image must be an image reference such as ubuntu:24.04.")
  // A template is used by its name, so the sandbox records it and its checklist says so.
  if (/^asidee-(template|snapshot)-/.test(image)) throw new AsideeError("usage", `${image} is one of Asidee's templates. Use --template with its name instead (see \`asd template list\`).`)
  // Only a request makes a GPU container, never a default: it is the weaker kind.
  const gpu = input.gpu === undefined ? false : input.gpu
  if (typeof gpu !== "boolean") throw new AsideeError("usage", "gpu must be a boolean (true or false).")
  if (gpu && input.docker === true) throw new AsideeError("usage", "A GPU container cannot run Docker inside: that has not been measured. Leave out --docker.")
  // Docker inside from the defaults does not apply to a GPU container.
  const docker = input.docker === undefined ? !gpu && base.docker : input.docker
  if (typeof docker !== "boolean") throw new AsideeError("usage", "docker must be a boolean (true or false).")
  return { name: validName(input.name), image, docker, ...validSizes(input, base), ...(template ? { template } : {}), ...(gpu ? { gpu } : {}) }
}

const manifestDir = (dirs: Dirs) => join(dirs.state, "sandboxes")
const manifestFile = (dirs: Dirs, name: string) => join(manifestDir(dirs), `${name}.json`)

export async function readManifest(dirs: Dirs, name: string): Promise<Manifest> {
  try { return JSON.parse(await readFile(manifestFile(dirs, validName(name)), "utf8")) as Manifest } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AsideeError("not-found", `There is no sandbox named ${name}.`)
    throw error
  }
}

// Only the daemon writes state, one operation per sandbox at a time; the rename keeps readers from seeing half a file.
export async function writeManifest(dirs: Dirs, manifest: Manifest): Promise<void> {
  await mkdir(manifestDir(dirs), { recursive: true, mode: 0o700 })
  const file = manifestFile(dirs, manifest.name); const temp = `${file}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); await rename(temp, file)
}

export const deleteManifest = (dirs: Dirs, name: string) => rm(manifestFile(dirs, name), { force: true })

// A state file that cannot be read (damaged, or not a sandbox's) is reported beside the sandboxes, never in their way.
export type Damaged = { name: string; file: string; problem: string }
export async function scanManifests(dirs: Dirs): Promise<{ manifests: Manifest[]; damaged: Damaged[] }> {
  const files = await readdir(manifestDir(dirs)).catch(() => [] as string[])
  const manifests: Manifest[] = []; const damaged: Damaged[] = []
  for (const name of files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort()) {
    try {
      const manifest = await readManifest(dirs, name)
      if (manifest?.name !== name || typeof manifest.id !== "string" || typeof manifest.engine?.provider !== "string" || typeof manifest.spec !== "object") throw new Error("it is not a sandbox's state")
      manifests.push(manifest)
    } catch (error) { damaged.push({ name, file: join(manifestDir(dirs), `${name}.json`), problem: (error as Error).message }) }
  }
  return { manifests, damaged }
}
export const listManifests = async (dirs: Dirs) => (await scanManifests(dirs)).manifests

// experimental: unproven features (today, other machines), off by default. workspaceFreeSpaceGb: below this much free
// space where workspaces live, workspace launches are refused and the daemon stops running workspaces. diskWatchSeconds:
// the pause between two measurements of a sandbox's watched disk limit. terminal: the app a dashboard button opens a
// shell in (core/terminal.ts); terminalCommand: the command used when it is "custom".
export type Config = { defaults: Defaults; engine?: string; requireProbes: boolean; experimental: boolean; workspaceFreeSpaceGb: number; diskWatchSeconds: number
  terminal: Terminal; terminalCommand?: string }
export const TERMINALS = ["default", "terminal", "ghostty", "iterm", "custom"] as const
export type Terminal = typeof TERMINALS[number]
// A custom terminal command runs on this Mac with the user's rights, so configSet never takes it: only
// terminalCommandSet does, which the dashboard reaches only after the person at the Mac allows it (core/approval.ts).
const TERMINAL_COMMAND = /^[^\x00-\x1f\x7f]{1,500}$/
const ENGINE_ID = /^[a-z0-9][a-z0-9:._-]{0,100}$/
export function validTerminalCommand(value: unknown): string {
  if (typeof value !== "string" || !TERMINAL_COMMAND.test(value) || !value.includes("{command}")) throw new AsideeError("usage", "The terminal command is one line that contains {command}, where the script to run goes.")
  return value
}

// What `configSet` may change. defaults, engine and terminal are checked on their own below; null removes defaults or
// engine.
const SETTINGS = { requireProbes: "boolean", experimental: "boolean", workspaceFreeSpaceGb: "number", diskWatchSeconds: "number" } as const
// Each number setting's unit, lowest and highest value. The enforcement pass measures disk use every 30 s whatever
// diskWatchSeconds says, so a longer pause than that would change nothing.
const NUMBER_SETTINGS: Record<string, [string, number, number]> = { workspaceFreeSpaceGb: ["GiB", 0, 100_000], diskWatchSeconds: ["seconds", 1, 30] }
export const DEFAULT_DISK_WATCH_SECONDS = 5
const settingProblem = (key: keyof typeof SETTINGS, value: unknown): string | undefined => SETTINGS[key] === "boolean"
  ? typeof value === "boolean" ? undefined : `${key} must be a boolean (true or false)`
  : ((unit: string, low: number, high: number) => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high ? undefined : `${key} must be a number of ${unit} from ${low} to ${high}`)(...NUMBER_SETTINGS[key]!)
// A config file with a mistake stops the request and says where, instead of being quietly ignored.
async function configFile(dirs: Dirs): Promise<Record<string, unknown>> {
  const file = join(dirs.config, "config.json")
  let text: string
  try { text = await readFile(file, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new AsideeError("usage", `${file} has a mistake: it is not valid JSON. Fix it or delete it.`) }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new AsideeError("usage", `${file} has a mistake: it must be a JSON object. Fix it or delete it.`)
  return data as Record<string, unknown>
}

function parseConfig(dirs: Dirs, data: Record<string, unknown>): Config {
  const file = join(dirs.config, "config.json")
  const wrong = (problem: string): never => { throw new AsideeError("usage", `${file} has a mistake: ${problem}. Fix it or delete it.`) }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  for (const key of Object.keys(SETTINGS) as Array<keyof typeof SETTINGS>) { const problem = data[key] === undefined ? undefined : settingProblem(key, data[key]); if (problem) wrong(problem) }
  if (data.defaults !== undefined && !isObject(data.defaults)) wrong("defaults must be an object")
  if (data.engine !== undefined && typeof data.engine !== "string") wrong("engine must be an engine id, as `asd doctor` prints it")
  if (data.terminal !== undefined && !TERMINALS.includes(data.terminal as Terminal)) wrong(`terminal must be one of ${TERMINALS.join(", ")}`)
  if (data.terminalCommand !== undefined && (typeof data.terminalCommand !== "string" || !TERMINAL_COMMAND.test(data.terminalCommand) || !data.terminalCommand.includes("{command}"))) wrong("terminalCommand must be one line that contains {command}")
  if (data.terminal === "custom" && data.terminalCommand === undefined) wrong("terminal is custom, but there is no terminalCommand")
  const defaults = (data.defaults ?? {}) as Record<string, unknown>
  // The defaults pass the same validation as a request, so config cannot set what a request cannot.
  try { validSpec({ ...defaults, name: "x" }) } catch (error) { wrong(`in defaults, ${(error as Error).message.replace(/^./, (first) => first.toLowerCase()).replace(/\.$/, "")}`) }
  const known = Object.fromEntries(Object.entries(defaults).filter(([key]) => DEFAULT_KEYS_ALLOWED.includes(key)))
  return { defaults: known as Defaults, engine: data.engine as string | undefined, requireProbes: data.requireProbes !== false, experimental: data.experimental === true,
    workspaceFreeSpaceGb: (data.workspaceFreeSpaceGb as number | undefined) ?? 5, diskWatchSeconds: (data.diskWatchSeconds as number | undefined) ?? DEFAULT_DISK_WATCH_SECONDS,
    terminal: (data.terminal as Terminal | undefined) ?? "default", ...(typeof data.terminalCommand === "string" ? { terminalCommand: data.terminalCommand } : {}) }
}

export async function readConfig(dirs: Dirs): Promise<Config> { return parseConfig(dirs, await configFile(dirs)) }

// The daemon serializes settings writes. Preserve fields owned by other config consumers. withCommand: the request is
// terminalCommandSet, the only way terminalCommand can be set.
export async function writeConfig(dirs: Dirs, input: Record<string, unknown>, withCommand = false): Promise<Config> {
  const keys = Object.keys(input)
  const allowed = [...Object.keys(SETTINGS), "defaults", "engine", "terminal", ...(withCommand ? ["terminalCommand"] : [])]
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw new AsideeError("usage", `Set ${allowed.join(", ")}.${withCommand || !keys.includes("terminalCommand") ? "" : " terminalCommand is set on its own: asd config set terminal-command '…', or the dashboard's Settings, which asks on this Mac first."}`)
  for (const key of keys.filter((key) => Object.hasOwn(SETTINGS, key)) as Array<keyof typeof SETTINGS>) { const problem = settingProblem(key, input[key]); if (problem) throw new AsideeError("usage", `${problem.replace(/^./, (first) => first.toUpperCase())}.`) }
  if (input.defaults !== undefined && input.defaults !== null) {
    if (typeof input.defaults !== "object" || Array.isArray(input.defaults)) throw new AsideeError("usage", "defaults must be an object.")
    const unknown = Object.keys(input.defaults).filter((key) => !DEFAULT_KEYS_ALLOWED.includes(key))
    if (unknown.length) throw new AsideeError("usage", `defaults may hold ${DEFAULT_KEYS_ALLOWED.join(", ")}; not ${unknown.join(", ")}.`)
    const given = input.defaults as Record<string, unknown>
    if (given.image !== undefined && given.template !== undefined) throw new AsideeError("usage", "A default image and a default template exclude each other. Set one of them.")
  }
  if (input.engine !== undefined && input.engine !== null && (typeof input.engine !== "string" || !ENGINE_ID.test(input.engine))) throw new AsideeError("usage", "engine must be an engine id, as `asd doctor` prints it, or null for the first ready engine.")
  if (input.terminal !== undefined && !TERMINALS.includes(input.terminal as Terminal)) throw new AsideeError("usage", `terminal must be one of ${TERMINALS.join(", ")}.`)
  if (input.terminalCommand !== undefined && input.terminalCommand !== null) validTerminalCommand(input.terminalCommand)
  const data: Record<string, unknown> = { ...await configFile(dirs), ...input }
  for (const key of ["defaults", "engine", "terminalCommand"]) if (data[key] === null) delete data[key]
  if (data.terminal === "custom" && typeof data.terminalCommand !== "string") throw new AsideeError("usage", "Set the custom command first: asd config set terminal-command '…' (it must contain {command}).")
  const config = parseConfig(dirs, data)
  await mkdir(dirs.config, { recursive: true, mode: 0o700 })
  const file = join(dirs.config, "config.json"); const temp = `${file}.tmp-${process.pid}`
  try { await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 }); await chmod(temp, 0o600); await rename(temp, file) }
  finally { await rm(temp, { force: true }) }
  return config
}
