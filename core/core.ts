import { randomBytes } from "node:crypto"
import { blockers, complete, failures, titleOf } from "./checks"
import { fieldValues, loadExtensions, runCommand } from "./extensions"
import { deleteManifest, listManifests, readConfig, readManifest, validName, validSpec, writeManifest, type Dirs } from "./state"
import { PaddockError, type CheckResult, type Engine, type Manifest, type Provider, type RunResult, type Runner, type Stage } from "./types"

export type SandboxView = {
  name: string; status: "running" | "stopped" | "missing"; engine: string; spec: Manifest["spec"]; createdAt: string
  capabilities?: Engine["capabilities"]; lastVerify?: Manifest["lastVerify"]; stopReason?: string
  // What a long operation on it is doing right now.
  activity?: string
}

// Every operation on a sandbox. The rule it keeps: a sandbox runs only while no blocking check fails. Checks that need
// only configuration run before a start, the rest right after it, and `enforce` repeats the cheap ones on a timer.
export class Core {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly activity = new Map<string, string>()
  constructor(private readonly providers: readonly Provider[], readonly dirs: Dirs, private readonly run: Runner, private readonly cliDir: string) {}

  // One operation per sandbox at a time.
  private exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(task, task).finally(() => this.activity.delete(name))
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
    return { name: manifest.name, status, engine: manifest.engine.label, spec: manifest.spec, createdAt: manifest.createdAt, capabilities: manifest.engine.capabilities,
      lastVerify: manifest.lastVerify, stopReason: manifest.stopReason, activity: this.activity.get(manifest.name) }
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

  private async stopBecause(manifest: Manifest, reason: string): Promise<void> {
    await this.provider(manifest).stop(manifest)
    manifest.stopReason = reason; await writeManifest(this.dirs, manifest)
  }

  private async startChecked(manifest: Manifest): Promise<void> {
    const provider = this.provider(manifest); const name = manifest.name
    this.activity.set(name, "Loading the network guard")
    await provider.prepare(manifest)
    this.activity.set(name, "Checking the configuration")
    const before = blockers(await this.stage(manifest, ["config"], false))
    if (before.length) this.refuse(name, before, "was not started")
    this.activity.set(name, "Starting")
    // Whatever goes wrong from here, the sandbox is not left running unchecked.
    try {
      await provider.start(manifest)
      const after = blockers(await this.stage(manifest, ["runtime"], true))
      if (after.length) this.refuse(name, after, "was stopped again")
    } catch (error) {
      await provider.stop(manifest).catch(() => {})
      throw error
    }
    if (manifest.stopReason) { delete manifest.stopReason; await writeManifest(this.dirs, manifest) }
  }

  private async verifyNow(manifest: Manifest): Promise<{ checks: CheckResult[]; failed: CheckResult[] }> {
    const running = (await this.provider(manifest).status(manifest)) === "running"
    this.activity.set(manifest.name, running ? "Running the checks (live probes take a few seconds)" : "Checking the configuration")
    const checks = await this.stage(manifest, ["config", "runtime", "probe"], running)
    manifest.lastVerify = { at: new Date().toISOString(), results: checks }
    // A stopped sandbox is judged on its configuration alone: the rest was not checked, which is not a failure.
    const failed = running ? blockers(checks) : blockers(checks).filter((entry) => entry.status === "fail")
    if (failed.length && running) await this.stopBecause(manifest, `Stopped by verify: ${failed.map((entry) => titleOf(entry.id)).join("; ")}`)
    else await writeManifest(this.dirs, manifest)
    return { checks, failed }
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
      this.activity.set(spec.name, `Creating (downloading ${spec.image} if it is not here yet)`)
      await this.provider(manifest).create(manifest)
      await this.startChecked(manifest)
      const { checks, failed } = await this.verifyNow(manifest)
      if (failed.length) this.refuse(spec.name, failed, "was created but stopped, and is kept for diagnosis")
      const hooks = []
      for (const extension of (await loadExtensions(this.dirs)).extensions) {
        if (!extension.hooks.postCreate) continue
        this.activity.set(spec.name, `Running ${extension.name}'s setup`)
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
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      this.activity.set(name, "Stopping")
      await this.provider(manifest).stop(manifest); return this.view(manifest)
    })
  }

  // The confirmation is checked here, not in a UI, so no client can remove a sandbox without naming it twice.
  remove(name: string, confirm: unknown): Promise<{ removed: string }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      if (confirm !== name) throw new PaddockError("usage", `Removing ${name} deletes everything in it. Confirm by repeating its name.`)
      this.activity.set(name, "Removing")
      await this.provider(manifest).remove(manifest); await deleteManifest(this.dirs, name)
      return { removed: name }
    })
  }

  verify(name: string): Promise<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const { checks, failed } = await this.verifyNow(manifest)
      return { sandbox: await this.view(manifest), checks, ok: failed.length === 0 }
    })
  }

  async exec(name: string, argv: unknown, options: { user?: string; stdin?: string } = {}): Promise<RunResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) throw new PaddockError("usage", "exec needs a command.")
    if (options.user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(options.user)) throw new PaddockError("usage", "The user must be a user name or id.")
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

  // Called on a timer by the daemon, for every running sandbox: repeats the checks that are cheap (configuration, the
  // guard rules, the kernel) and measures disk use. A sandbox that fails one, or passed its watched disk limit, is
  // stopped. This is what catches a guard that was flushed, a container started behind Paddock's back, or an engine
  // whose runtime was reconfigured, without waiting for someone to run verify.
  async enforce(): Promise<void> {
    for (const listed of await listManifests(this.dirs).catch(() => [])) {
      await this.exclusive(listed.name, async () => {
        const manifest = await readManifest(this.dirs, listed.name); const provider = this.provider(manifest)
        if ((await provider.status(manifest)) !== "running") return
        const failed = failures(await this.stage(manifest, ["config", "runtime"], true))
        if (failed.length) return this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: ${failed.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")}`)
        if (manifest.engine.capabilities?.diskLimit !== "watched") return
        const used = await provider.diskUsedBytes(manifest)
        if (used !== undefined && used > manifest.spec.diskGb * 1024 ** 3)
          await this.stopBecause(manifest, `Stopped by the disk watch: it used ${(used / 1024 ** 3).toFixed(1)} GB of its ${manifest.spec.diskGb} GB. Free space inside it after a start, or it is stopped again.`)
      }).catch(() => {})
    }
  }

  // A watched disk limit holds only while something watches. When the daemon is stopped on purpose, the sandboxes that
  // depend on it stop with it.
  async stopWatched(): Promise<string[]> {
    const stopped: string[] = []
    for (const listed of await listManifests(this.dirs).catch(() => [])) {
      if (listed.engine.capabilities?.diskLimit !== "watched") continue
      await this.exclusive(listed.name, async () => {
        const manifest = await readManifest(this.dirs, listed.name)
        if ((await this.provider(manifest).status(manifest)) !== "running") return
        await this.stopBecause(manifest, "Stopped with the daemon: its disk limit is only enforced while the daemon runs.")
        stopped.push(manifest.name)
      }).catch(() => {})
    }
    return stopped
  }

  async sweep(): Promise<void> {
    for (const provider of this.providers) for (const engine of await provider.detect().catch(() => [])) if (engine.ready) await provider.sweep(engine).catch(() => {})
  }
}
