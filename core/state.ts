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
export const daemonFile = (dirs: Dirs) => join(dirs.state, "daemon.json")

export const DEFAULT_SPEC = { image: "docker/sandbox-templates:shell-docker", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 }

const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/
export function validName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name)) throw new PaddockError("usage", "A sandbox name is 1 to 31 lowercase letters, digits or hyphens, and does not start with a hyphen.")
  return name
}

function number(value: unknown, label: string, min: number, max: number, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new PaddockError("usage", `${label} must be a number from ${min} to ${max}.`)
  return parsed
}

// The only way a spec is made. Unknown fields are dropped, so a client cannot smuggle an engine option through.
export function validSpec(input: Record<string, unknown>, defaults: Partial<typeof DEFAULT_SPEC> = {}): SandboxSpec {
  const base = { ...DEFAULT_SPEC, ...defaults }
  const image = input.image === undefined || input.image === "" ? base.image : input.image
  if (typeof image !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(image)) throw new PaddockError("usage", "The image must be an image reference such as ubuntu:24.04.")
  return {
    name: validName(input.name), image,
    cpus: number(input.cpus, "CPUs", 0.25, 64, base.cpus),
    memoryGb: number(input.memoryGb, "Memory (GB)", 0.25, 256, base.memoryGb),
    pids: Math.round(number(input.pids, "The process limit", 64, 65_536, base.pids)),
    diskGb: number(input.diskGb, "Disk (GB)", 1, 2000, base.diskGb),
  }
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

export async function listManifests(dirs: Dirs): Promise<Manifest[]> {
  const files = await readdir(manifestDir(dirs)).catch(() => [] as string[])
  const names = files.filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5)).sort()
  return Promise.all(names.map((name) => readManifest(dirs, name)))
}

export async function readConfig(dirs: Dirs): Promise<{ defaults?: Partial<typeof DEFAULT_SPEC>; engine?: string }> {
  try { return JSON.parse(await readFile(join(dirs.config, "config.json"), "utf8")) } catch { return {} }
}
