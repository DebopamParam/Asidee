import { createHash, randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { GVISOR, GVISOR_RELEASE, lineDiff, mergeRuntime, planHash, runtimeArgs } from "./hosts"
import { MANAGED_RUNTIME } from "./providers/gvisor"
import { object } from "./transport"
import { AsideeError, type Engine, type Runner } from "./types"

// `asd setup`: gives the engine on this Mac a gVisor runtime. It runs in the CLI, as the user, and never in the daemon,
// so no dashboard or extension can change the engine. Like host enrollment it shows one plan, applies only that plan,
// and calls the engine ready only after a test sandbox passes the checklist (the CLI does that through the daemon).

export const ORBSTACK_DOWNLOAD = "https://orbstack.dev/download"

export type SetupContext = {
  home: string
  run: Runner
  // Folders that hold applications; tests replace them.
  applications?: string[]
  download?: (url: string) => Promise<Uint8Array>
}

export type SetupPlan = {
  action: "setup" | "remove"
  engine: "orbstack"
  context: string
  arch: "aarch64" | "x86_64"
  docker: boolean
  runtime: { name: string; release: string; path: string; runtimeArgs: string[] }
  // Absent when the files are already in place, each with the expected checksum.
  download?: { url: string; sha512: string; folder: string; files: Record<string, string> }
  config?: { path: string; beforeSha256: string | null; sha256: string; after: string; diff: string }
  restart?: { argv: string[]; stops: string[] }
  removeFolder?: string
  // Setup only: the engine new sandboxes use. kept: a default was already set, and id is it; otherwise setup saves id
  // once the test sandbox passed.
  defaultEngine?: { id: string; kept: boolean }
  // Why the plan cannot be applied. Nothing is changed while there is one.
  blockers: string[]
  // A test sandbox is made, checked and removed after the changes.
  check: boolean
  hash: string
}

const ORBSTACK_CONTEXT = "orbstack"
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const exists = (path: string) => stat(path).then(() => true, () => false)
export const gvisorRoot = (home: string) => join(home, ".local", "share", "asidee", "gvisor")
const orbstackConfig = (home: string) => join(home, ".orbstack", "config", "docker.json")

export async function orbstackInstalled(context: SetupContext): Promise<boolean> {
  const folders = context.applications ?? ["/Applications", join(context.home, "Applications")]
  return (await Promise.all(folders.map((folder) => exists(join(folder, "OrbStack.app"))))).some(Boolean)
}

// The engine the daemon sees through OrbStack's context, which may be listed under another context naming the same engine.
export const orbstackEngine = (engines: readonly Engine[]) =>
  engines.find((engine) => engine.data.context === ORBSTACK_CONTEXT) ?? engines.find((engine) => engine.provider === "gvisor" && engine.label.startsWith("OrbStack "))

// The runtime entry without Asidee's, every other setting kept. An emptied runtimes object is dropped, as it was absent.
export function withoutRuntime(before: string): string {
  const config: unknown = JSON.parse(before)
  if (!object(config) || (config.runtimes !== undefined && !object(config.runtimes))) throw new AsideeError("usage", "The engine's configuration and its runtimes must be JSON objects.")
  const { [MANAGED_RUNTIME]: _, ...runtimes } = object(config.runtimes) ? config.runtimes : {}
  const { runtimes: __, ...rest } = config
  const indent = before.match(/^\s*\{\r?\n([ \t]+)"/)?.[1] ?? "  "
  return `${JSON.stringify(Object.keys(runtimes).length ? { ...rest, runtimes } : rest, null, indent)}\n`
}

// Asidee's entry in the engine's configuration, if it has one.
function managedEntry(text: string): unknown {
  const config: unknown = JSON.parse(text)
  if (!object(config) || (config.runtimes !== undefined && !object(config.runtimes))) throw new AsideeError("usage", "The engine's configuration and its runtimes must be JSON objects.")
  return object(config.runtimes) ? config.runtimes[MANAGED_RUNTIME] : undefined
}

async function intact(folder: string, files: Record<string, string>): Promise<boolean> {
  for (const [name, checksum] of Object.entries(files)) {
    const path = join(folder, name)
    const info = await lstat(path).catch(() => undefined)
    if (!info?.isFile() || (info.mode & 0o111) === 0 || sha256(await readFile(path)) !== checksum) return false
  }
  return true
}

async function dockerInfo(context: SetupContext): Promise<Record<string, unknown>> {
  const info = await context.run(["docker", "--context", ORBSTACK_CONTEXT, "info", "--format", "{{json .}}"], { timeoutMs: 15_000 })
  let parsed: unknown
  try { parsed = info.exitCode === 0 ? JSON.parse(info.stdout) : undefined } catch { parsed = undefined }
  if (!object(parsed) || Array.isArray(parsed.ServerErrors) && parsed.ServerErrors.length > 0)
    throw new AsideeError("dependency", "OrbStack's Docker engine does not answer. Open OrbStack and wait until it is running, then run asd setup again.")
  return parsed
}

const names = (output: string) => output.split("\n").map((line) => line.trim().replace(/^\//, "")).filter(Boolean)

// What setup (or, with remove, undoing it) would do on OrbStack now. Reads only: nothing is changed.
// defaultEngine: the engine Asidee's config names now, if any.
export async function planSetup(context: SetupContext, options: { docker: boolean; remove: boolean; engine?: Engine; defaultEngine?: string }): Promise<SetupPlan> {
  const info = await dockerInfo(context)
  const architecture = String(info.Architecture ?? "")
  const arch = /^(aarch64|arm64)$/.test(architecture) ? "aarch64" as const : /^(x86_64|amd64)$/.test(architecture) ? "x86_64" as const : undefined
  if (!arch) throw new AsideeError("dependency", `OrbStack reports an architecture gVisor has no release for: ${architecture || "none"}.`)
  const folder = join(gvisorRoot(context.home), GVISOR_RELEASE)
  const runtime = { name: MANAGED_RUNTIME, release: GVISOR_RELEASE, path: join(folder, "runsc"), runtimeArgs: runtimeArgs(options.docker) }
  const registered = object(info.Runtimes) && object(info.Runtimes[MANAGED_RUNTIME]) ? info.Runtimes[MANAGED_RUNTIME] : undefined
  const configPath = orbstackConfig(context.home)
  const before = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error })
  const change = (after: string) => {
    if (after === before) return undefined
    return { path: configPath, beforeSha256: before === null ? null : sha256(before), sha256: sha256(after), after, diff: lineDiff(configPath, before, after) }
  }
  const parse = <T>(make: () => T) => { try { return make() } catch (error) { throw new AsideeError("usage", `${configPath} is not a JSON object Asidee can edit (${(error as Error).message}). Nothing was changed.`) } }
  const running = async () => names((await context.run(["docker", "--context", ORBSTACK_CONTEXT, "ps", "--format", "{{.Names}}"], { timeoutMs: 15_000 })).stdout)
  const base = { engine: "orbstack" as const, context: ORBSTACK_CONTEXT, arch, docker: options.docker, runtime, blockers: [] as string[] }
  const finish = (plan: Omit<SetupPlan, "hash">): SetupPlan => ({ ...plan, hash: planHash(plan) })

  if (options.remove) {
    // Only a file that holds Asidee's runtime is rewritten: rewriting reformats it, which is not a change to make for nothing.
    const config = before !== null && parse(() => managedEntry(before)) !== undefined && parse(() => change(withoutRuntime(before)))
    const restart = Boolean(config || registered)
    const blockers: string[] = []
    if (restart) {
      // Containers made on the runtime would not start again without it.
      const ids = names((await context.run(["docker", "--context", ORBSTACK_CONTEXT, "ps", "-aq", "--no-trunc"], { timeoutMs: 15_000 })).stdout)
      const runtimes = ids.length ? (await context.run(["docker", "--context", ORBSTACK_CONTEXT, "inspect", "--format", "{{.Name}} {{.HostConfig.Runtime}}", ...ids], { timeoutMs: 30_000 })).stdout : ""
      const using = names(runtimes).filter((line) => line.endsWith(` ${MANAGED_RUNTIME}`)).map((line) => line.slice(0, -MANAGED_RUNTIME.length - 1))
      if (using.length) blockers.push(`These containers run on ${MANAGED_RUNTIME} and would not start again without it: ${using.join(", ")}. Remove them first (for a sandbox: asd remove NAME --confirm NAME).`)
    }
    const root = gvisorRoot(context.home)
    return finish({ action: "remove", ...base, blockers, check: false,
      ...(config ? { config } : {}),
      ...(restart ? { restart: { argv: ["orb", "restart", "docker"], stops: await running() } } : {}),
      ...(await exists(root) ? { removeFolder: root } : {}) })
  }

  const defaultEngine = options.defaultEngine ? { id: options.defaultEngine, kept: true } : { id: options.engine?.id ?? `gvisor:${ORBSTACK_CONTEXT}`, kept: false }
  if (options.engine?.ready && (!options.docker || options.engine.capabilities?.docker)) return finish({ action: "setup", ...base, defaultEngine, check: true })
  const files: Record<string, string> = { ...GVISOR[arch].files }
  const download = await intact(folder, files) ? undefined
    : { url: `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${arch}/gvisor.tar.bz2`, sha512: GVISOR[arch].archive, folder, files }
  const entry = before === null ? undefined : parse(() => managedEntry(before))
  const same = (value: unknown) => object(value) && value.path === runtime.path && JSON.stringify(value.runtimeArgs ?? []) === JSON.stringify(runtime.runtimeArgs)
  const config = same(entry) ? undefined : parse(() => change(mergeRuntime(before, runtime.path, options.docker)))
  const current = same(registered)
  return finish({ action: "setup", ...base, defaultEngine, check: true,
    ...(download ? { download } : {}),
    ...(config ? { config } : {}),
    ...(config || !current ? { restart: { argv: ["orb", "restart", "docker"], stops: await running() } } : {}) })
}

// Lines a person reads before saying yes. Paths under home are shown with ~.
export function setupPlanLines(plan: SetupPlan, home: string): string[] {
  const tilde = (path: string) => path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
  const lines = [plan.action === "remove" ? "Plan to undo asd setup on OrbStack" : "Setup plan for OrbStack"]
  if (plan.action === "setup") lines.push(
    `  Runtime: gVisor ${plan.runtime.release} for ${plan.arch}, registered as ${plan.runtime.name}: ${tilde(plan.runtime.path)} ${plan.runtime.runtimeArgs.join(" ")}`,
    `  Docker inside sandboxes: ${plan.docker ? "offered (--docker)" : "not offered (asd setup --docker offers it)"}`,
    ...(plan.defaultEngine?.kept ? [`  Default engine for new sandboxes: ${plan.defaultEngine.id}, as set already (kept)`] : []))
  lines.push("")
  let step = 0
  const add = (...text: string[]) => { lines.push(`  ${++step}. ${text[0]}`, ...text.slice(1).map((line) => `     ${line}`)) }
  if (plan.download) add(`Download ${plan.download.url}`, `check it against sha512 ${plan.download.sha512}, and keep these files in ${tilde(plan.download.folder)}, each checked against its sha256:`,
    ...Object.entries(plan.download.files).map(([name, checksum]) => `  ${name}: ${checksum}`))
  if (plan.config) add(`${plan.action === "remove" ? "Remove the runtime from" : "Add the runtime to"} ${tilde(plan.config.path)} (nothing else in it changes):`, ...plan.config.diff.split("\n").filter(Boolean).map((line) => `  ${line}`))
  if (plan.restart) add(`Restart OrbStack's Docker engine: ${plan.restart.argv.join(" ")}`,
    plan.restart.stops.length ? `These running containers stop: ${plan.restart.stops.join(", ")}. Asidee sandboxes among them are started again with asd start NAME.` : "No container is running, so none stops.")
  if (plan.removeFolder) add(`Delete ${tilde(plan.removeFolder)}`)
  if (plan.check) add("Create a test sandbox, run every check on it, and remove it. Setup is done only if every blocking check holds.")
  if (plan.defaultEngine && !plan.defaultEngine.kept) add(`Make OrbStack the default engine for new sandboxes: engine ${plan.defaultEngine.id} in Asidee's config.`)
  if (!step) lines.push("  Nothing to do: Asidee's runtime is not on this engine.")
  for (const blocker of plan.blockers) lines.push("", `Cannot apply: ${blocker}`)
  lines.push("", `Plan hash: ${plan.hash}`)
  return lines
}

// Whether the plan changes anything; one that only checks needs no consent.
export const setupChanges = (plan: SetupPlan) => Boolean(plan.download || plan.config || plan.restart || plan.removeFolder || plan.defaultEngine && !plan.defaultEngine.kept)

const fetchBytes = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new AsideeError("dependency", `Downloading ${url} failed: HTTP ${response.status}.`)
  return new Uint8Array(await response.arrayBuffer())
}

// Applies exactly the plan. Everything that can be checked first (the download and its files, the configuration file
// being as it was planned) is, before the engine changes; a step that fails stops the rest.
export async function applySetup(context: SetupContext, plan: SetupPlan, progress: (line: string) => void = () => {}): Promise<void> {
  if (plan.blockers.length) throw new AsideeError("conflict", `Nothing was changed: ${plan.blockers.join(" ")}`)
  if (plan.download) {
    const { url, sha512, folder, files } = plan.download
    progress(`Downloading gVisor ${plan.runtime.release}…`)
    const archive = await (context.download ?? fetchBytes)(url)
    if (createHash("sha512").update(archive).digest("hex") !== sha512) throw new AsideeError("runtime", `${url} does not match its pinned sha512. Nothing was changed.`)
    const staging = join(dirname(folder), `.staging-${randomUUID()}`)
    try {
      await mkdir(join(staging, "files"), { recursive: true, mode: 0o700 })
      await writeFile(join(staging, "gvisor.tar.bz2"), archive)
      // Exactly the planned files may be in the archive, so nothing else is unpacked.
      const listed = await context.run(["/usr/bin/tar", "-tjf", join(staging, "gvisor.tar.bz2")], { timeoutMs: 120_000 })
      if (listed.exitCode !== 0) throw new AsideeError("runtime", `The gVisor archive could not be read: ${listed.stderr.trim()}. Nothing was changed.`)
      const directories = new Set(Object.keys(files).map((name) => dirname(name)).filter((name) => name !== "."))
      const unexpected = names(listed.stdout).map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, "")).filter((entry) => !(entry in files) && !directories.has(entry))
      if (unexpected.length) throw new AsideeError("runtime", `The gVisor archive holds unexpected entries (${unexpected.slice(0, 5).join(", ")}). Nothing was changed.`)
      const unpacked = await context.run(["/usr/bin/tar", "-xjf", join(staging, "gvisor.tar.bz2"), "-C", join(staging, "files")], { timeoutMs: 120_000 })
      if (unpacked.exitCode !== 0) throw new AsideeError("runtime", `The gVisor archive could not be unpacked: ${unpacked.stderr.trim()}. Nothing was changed.`)
      for (const [name, checksum] of Object.entries(files)) {
        const path = join(staging, "files", name)
        const info = await lstat(path).catch(() => undefined)
        if (!info?.isFile() || sha256(await readFile(path)) !== checksum) throw new AsideeError("runtime", `${name} in the gVisor archive is missing or does not match its pinned sha256. Nothing was changed.`)
        await chmod(path, 0o755)
      }
      await rm(folder, { recursive: true, force: true })
      await rename(join(staging, "files"), folder)
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  if (plan.config) {
    const { path, beforeSha256, after } = plan.config
    const now = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error })
    if ((now === null ? null : sha256(now)) !== beforeSha256) throw new AsideeError("conflict", `${path} changed since the plan was made, so it was not written. Run asd setup again to see a new plan.`)
    const mode = (await stat(path).catch(() => undefined))?.mode ?? 0o600
    await mkdir(dirname(path), { recursive: true })
    const staged = `${path}.asidee-${randomUUID()}`
    await writeFile(staged, after, { mode: mode & 0o777 })
    await rename(staged, path)
  }
  if (plan.restart) {
    progress("Restarting OrbStack's Docker engine…")
    const restarted = await context.run(plan.restart.argv, { timeoutMs: 300_000 })
    if (restarted.exitCode !== 0) throw new AsideeError("runtime", `${plan.restart.argv.join(" ")} failed: ${restarted.stderr.trim() || `exit ${restarted.exitCode}`}.${plan.config ? ` ${plan.config.path} was already written.` : ""}`)
    const deadline = Date.now() + 120_000
    for (;;) {
      if ((await dockerInfo(context).catch(() => undefined))) break
      if (Date.now() > deadline) throw new AsideeError("runtime", "OrbStack's Docker engine did not answer within two minutes of the restart. Open OrbStack to see why, then run asd setup again.")
      await Bun.sleep(2_000)
    }
  }
  if (plan.removeFolder) await rm(plan.removeFolder, { recursive: true, force: true })
}
