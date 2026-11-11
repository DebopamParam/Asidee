import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { PaddockError, type Manifest, type SandboxSpec } from "./types"

export type Dirs = { state: string; config: string }
export function defaultDirs(env: Record<string, string | undefined> = process.env): Dirs {
  return {
    state: env.PADDOCK_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "paddock"),
    config: env.PADDOCK_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "paddock"),
  }
}
export const socketPath = (dirs: Dirs) => join(dirs.state, "daemon.sock")
// Sessions (core/stream.ts). Its path is shorter than the API socket's, so the length check below covers it.
export const streamSocketPath = (dirs: Dirs) => join(dirs.state, "stream.sock")
// The operating system limits a socket's path (104 bytes on macOS, 108 on Linux). Past it the daemon cannot listen.
export function checkSocketPath(dirs: Dirs): void {
  if (Buffer.byteLength(socketPath(dirs)) > 100) throw new PaddockError("usage", `The state folder's path is too long for the daemon's socket (${socketPath(dirs)}). Set PADDOCK_STATE_DIR to a shorter path.`)
}
export const daemonFile = (dirs: Dirs) => join(dirs.state, "daemon.json")

export const DEFAULT_SPEC = { image: "docker/sandbox-templates:shell-docker", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, docker: false }

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
export function validName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new PaddockError("usage", "A sandbox name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return name
}
// A template's name is also its tag on the engine, so it follows the same rule.
export function validTemplateName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new PaddockError("usage", "A template name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return name
}

function number(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new PaddockError("usage", `${label} must be a number from ${min} to ${max}.`)
  return parsed
}

// The range of each size, the same for create and resize.
export type Sizes = Pick<SandboxSpec, "cpus" | "memoryGb" | "pids" | "diskGb">
const RANGES: Record<keyof Sizes, [string, number, number]> = { cpus: ["CPUs", 0.25, 64], memoryGb: ["Memory (GB)", 0.25, 256], pids: ["The process limit", 64, 65_536], diskGb: ["Disk (GB)", 1, 2000] }
export function validSizes(input: Record<string, unknown>, base: Sizes): Sizes {
  const size = (key: keyof Sizes) => number(input[key], ...RANGES[key], base[key])
  return { cpus: size("cpus"), memoryGb: size("memoryGb"), pids: Math.round(size("pids")), diskGb: size("diskGb") }
}

// The only way a spec is made. Unknown fields are dropped, so a client cannot smuggle an engine option through.
export function validSpec(input: Record<string, unknown>, defaults: Partial<typeof DEFAULT_SPEC> = {}): SandboxSpec {
  const base = { ...DEFAULT_SPEC, ...defaults }
  const template = input.template === undefined || input.template === "" ? undefined : validTemplateName(input.template)
  if (template && input.image !== undefined && input.image !== "") throw new PaddockError("usage", "Give an image or a template, not both.")
  const image = input.image === undefined || input.image === "" ? base.image : input.image
  if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(image)) throw new PaddockError("usage", "The image must be an image reference such as ubuntu:24.04.")
  // A template is used by its name, so the sandbox records it and its checklist says so.
  if (/^paddock-(template|snapshot)-/.test(image)) throw new PaddockError("usage", `${image} is one of Paddock's templates. Use --template with its name instead (see \`paddock template list\`).`)
  const docker = input.docker === undefined ? base.docker : input.docker
  if (typeof docker !== "boolean") throw new PaddockError("usage", "docker must be a boolean (true or false).")
  return { name: validName(input.name), image, docker, ...validSizes(input, base), ...(template ? { template } : {}) }
}

const manifestDir = (dirs: Dirs) => join(dirs.state, "sandboxes")
const manifestFile = (dirs: Dirs, name: string) => join(manifestDir(dirs), `${name}.json`)

export async function readManifest(dirs: Dirs, name: string): Promise<Manifest> {
  try { return JSON.parse(await readFile(manifestFile(dirs, validName(name)), "utf8")) as Manifest } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PaddockError("not-found", `There is no sandbox named ${name}.`)
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

export type Config = { defaults: Partial<typeof DEFAULT_SPEC>; engine?: string }
// A config file with a mistake stops the request and says where, instead of being quietly ignored.
export async function readConfig(dirs: Dirs): Promise<Config> {
  const file = join(dirs.config, "config.json")
  const wrong = (problem: string): never => { throw new PaddockError("usage", `${file} has a mistake: ${problem}. Fix it or delete it.`) }
  let text: string
  try { text = await readFile(file, "utf8") } catch { return { defaults: {} } }
  let data: unknown
  try { data = JSON.parse(text) } catch (error) { wrong(`it is not valid JSON (${(error as Error).message})`) }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  if (!isObject(data)) return wrong("it must be a JSON object")
  if (data.defaults !== undefined && !isObject(data.defaults)) wrong("defaults must be an object")
  if (data.engine !== undefined && typeof data.engine !== "string") wrong("engine must be an engine id, as `paddock doctor` prints it")
  const defaults = (data.defaults ?? {}) as Record<string, unknown>
  // The defaults pass the same validation as a request, so config cannot set what a request cannot.
  try { validSpec({ ...defaults, name: "x" }) } catch (error) { wrong(`in defaults, ${(error as Error).message.replace(/^./, (first) => first.toLowerCase()).replace(/\.$/, "")}`) }
  const known = Object.fromEntries(Object.entries(defaults).filter(([key]) => key in DEFAULT_SPEC))
  return { defaults: known as Partial<typeof DEFAULT_SPEC>, engine: data.engine as string | undefined }
}
