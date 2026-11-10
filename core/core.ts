import { randomBytes } from "node:crypto"
import { blockers, complete, titleOf } from "./checks"
import { fieldValues, loadExtensions, runCommand } from "./extensions"
import { deleteManifest, listManifests, readConfig, readManifest, validName, validSpec, writeManifest, type Dirs } from "./state"
import { PaddockError, type CheckResult, type Engine, type Manifest, type Provider, type RunResult, type Runner, type Stage } from "./types"

export type SandboxView = {
  name: string; status: "running" | "stopped" | "missing"; engine: string; spec: Manifest["spec"]; createdAt: string
  capabilities?: Engine["capabilities"]; lastVerify?: Manifest["lastVerify"]; stopReason?: string
}

// Every operation on a sandbox. The rule it keeps: a sandbox runs only if no blocking check failed. Checks that need
// only configuration run before a start, the rest right after it, and a failure stops the sandbox again.
export class Core {
  private readonly locks = new Map<string, Promise<unknown>>()
  constructor(private readonly providers: readonly Provider[], readonly dirs: Dirs, private readonly run: Runner, private readonly cliDir: string) {}

  // One operation per sandbox at a time.
  private exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(task, task)
    this.locks.set(name, next.catch(() => {}))
    return next
  }

  private provider(manifest: Manifest): Provider {
    const provider = this.providers.find((entry) => entry.id === manifest.engine.provider)
    if (!provider) throw new PaddockError("dependency", `${manifest.name} was made with the ${manifest.engine.provider} provider, which this build does not have.`)
    return provider
  }

  async engines(): Promise<Engine[]> { return (await Promise.all(this.providers.map((provider) => provider.detect()))).flat() }

  private async view(manifest: Manifest): Promise<SandboxView> {
    let status: SandboxView["status"] = "missing"
    try { status = await this.provider(manifest).status(manifest) } catch {}
    return { name: manifest.name, status, engine: manifest.engine.label, spec: manifest.spec, createdAt: manifest.createdAt, capabilities: manifest.engine.capabilities, lastVerify: manifest.lastVerify, stopReason: manifest.stopReason }
  }

  async list(): Promise<SandboxView[]> { return Promise.all((await listManifests(this.dirs)).map((manifest) => this.view(manifest))) }
  async get(name: string): Promise<SandboxView> { return this.view(await readManifest(this.dirs, name)) }

  private async stage(manifest: Manifest, stages: readonly Stage[], running: boolean): Promise<CheckResult[]> {
    const provider = this.provider(manifest); const results: CheckResult[] = []
    for (const stage of stages) {
      if (stage !== "config" && !running) continue
      results.push(...await provider.checks(manifest, stage))
    }
    return complete(results, stages, running ? undefined : "Not checked: the sandbox is not running.")
  }

  private refuse(name: string, failed: CheckResult[], consequence: string): never {
    throw new PaddockError("check-failed", `${name} ${consequence}: ${failed.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")}`, failed)
  }

  private async startChecked(manifest: Manifest): Promise<void> {
    const provider = this.provider(manifest)
    await provider.prepare(manifest)
    const before = blockers(await this.stage(manifest, ["config"], false))
    if (before.length) this.refuse(manifest.name, before, "was not started")
    await provider.start(manifest)
    const after = blockers(await this.stage(manifest, ["runtime"], true))
    if (after.length) { await provider.stop(manifest); this.refuse(manifest.name, after, "was stopped again") }
    if (manifest.stopReason) { delete manifest.stopReason; await writeManifest(this.dirs, manifest) }
  }

  private async verifyNow(manifest: Manifest): Promise<CheckResult[]> {
    const running = (await this.provider(manifest).status(manifest)) === "running"
    const results = await this.stage(manifest, ["config", "runtime", "probe"], running)
    manifest.lastVerify = { at: new Date().toISOString(), results }
    const failed = blockers(results)
    // A sandbox that fails a blocking check does not keep running.
    if (failed.length && running) { await this.provider(manifest).stop(manifest); manifest.stopReason = `Stopped by verify: ${failed.map((entry) => titleOf(entry.id)).join("; ")}` }
    await writeManifest(this.dirs, manifest)
    return results
  }

  async create(input: Record<string, unknown>): Promise<{ sandbox: SandboxView; checks: CheckResult[]; hooks: Array<{ extension: string; exitCode: number; output: string }> }> {
    const config = await readConfig(this.dirs)
    const spec = validSpec(input, config.defaults)
    return this.exclusive(spec.name, async () => {
      if ((await listManifests(this.dirs)).some((entry) => entry.name === spec.name)) throw new PaddockError("conflict", `A sandbox named ${spec.name} already exists.`)
      const engines = await this.engines()
      const wanted = typeof input.engine === "string" && input.engine ? input.engine : config.engine
      const engine = wanted ? engines.find((entry) => entry.id === wanted) : engines.find((entry) => entry.ready)
      if (!engine) throw new PaddockError("dependency", wanted ? `There is no engine ${wanted}. Run \`paddock doctor\`.` : "No engine is ready for sandboxes. Run `paddock doctor` to see what each one needs.")
      if (!engine.ready) throw new PaddockError("dependency", `${engine.label} is not ready: ${engine.problems.join(" ")} ${engine.fix ?? ""}`.trim())
      // Written before the engine is touched, so a half-made sandbox can always be removed.
      const manifest: Manifest = { version: 1, name: spec.name, id: randomBytes(16).toString("hex"), engine, spec, createdAt: new Date().toISOString() }
      await writeManifest(this.dirs, manifest)
      await this.provider(manifest).create(manifest)
      await this.startChecked(manifest)
      const checks = await this.verifyNow(manifest)
      const failed = blockers(checks)
      if (failed.length) this.refuse(spec.name, failed, "was created but stopped, and is kept for diagnosis")
      const hooks = []
      for (const extension of (await loadExtensions(this.dirs)).extensions) {
        if (!extension.hooks.postCreate) continue
        const output = await runCommand(this.run, extension, extension.hooks.postCreate, { PADDOCK_SANDBOX: spec.name }, this.cliDir)
        hooks.push({ extension: extension.id, exitCode: output.exitCode, output: `${output.stdout}${output.stderr}`.trim() })
      }
      return { sandbox: await this.view(manifest), checks, hooks }
    })
  }

  start(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => { const manifest = await readManifest(this.dirs, name); await this.startChecked(manifest); return this.view(manifest) })
  }

  stop(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => { const manifest = await readManifest(this.dirs, name); await this.provider(manifest).stop(manifest); return this.view(manifest) })
  }

  // The confirmation is checked here, not in a UI, so no client can remove a sandbox without naming it twice.
  remove(name: string, confirm: unknown): Promise<{ removed: string }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      if (confirm !== name) throw new PaddockError("usage", `Removing ${name} deletes everything in it. Confirm by repeating its name.`)
      await this.provider(manifest).remove(manifest); await deleteManifest(this.dirs, name)
      return { removed: name }
    })
  }

  verify(name: string): Promise<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const checks = await this.verifyNow(manifest)
      return { sandbox: await this.view(manifest), checks, ok: blockers(checks).length === 0 }
    })
  }

  async exec(name: string, argv: unknown, options: { user?: string; stdin?: string } = {}): Promise<RunResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) throw new PaddockError("usage", "exec needs a command.")
    const manifest = await readManifest(this.dirs, name)
    return this.provider(manifest).exec(manifest, argv as string[], options)
  }

  async attach(name: string, argv: unknown): Promise<{ argv: string[] }> {
    const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
    if ((await provider.status(manifest)) !== "running") throw new PaddockError("conflict", `${name} is not running. Start it first.`)
    const command = Array.isArray(argv) && argv.length && argv.every((part) => typeof part === "string") ? argv as string[] : ["sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"]
    return { argv: provider.attachArgv(manifest, command) }
  }

  extensions() { return loadExtensions(this.dirs) }

  async runAction(extensionId: unknown, actionId: unknown, sandbox: unknown, values: unknown): Promise<RunResult> {
    const extension = (await loadExtensions(this.dirs)).extensions.find((entry) => entry.id === extensionId)
    const action = extension?.actions.find((entry) => entry.id === actionId)
    if (!extension || !action) throw new PaddockError("not-found", `There is no action ${String(actionId)} in an extension ${String(extensionId)}.`)
    const env = fieldValues(action, (values ?? {}) as Record<string, unknown>)
    if (action.scope === "sandbox") env.PADDOCK_SANDBOX = (await readManifest(this.dirs, validName(sandbox))).name
    return runCommand(this.run, extension, action.run, env, this.cliDir)
  }

  // The "watched" disk limit: stops running sandboxes that have passed theirs. Called on a timer by the daemon.
  async watchDisks(): Promise<void> {
    for (const manifest of await listManifests(this.dirs)) {
      if (manifest.engine.capabilities?.diskLimit !== "watched") continue
      await this.exclusive(manifest.name, async () => {
        const provider = this.provider(manifest)
        if ((await provider.status(manifest)) !== "running") return
        const used = await provider.diskUsedBytes(manifest)
        if (used === undefined || used <= manifest.spec.diskGb * 1024 ** 3) return
        await provider.stop(manifest)
        const current = await readManifest(this.dirs, manifest.name)
        current.stopReason = `Stopped by the disk watch: it used ${(used / 1024 ** 3).toFixed(1)} GB of its ${manifest.spec.diskGb} GB.`
        await writeManifest(this.dirs, current)
      }).catch(() => {})
    }
  }
}
