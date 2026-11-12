import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import type { Server } from "node:net"
import { blockers, CHECKLIST, complete, failures, titleOf } from "./checks"
import { fieldValues, loadExtensions, runCommand } from "./extensions"
import { boundPort, LEASE_TTL_MS, listenLoopback, relay, validPort, type ForwardView } from "./forwards"
import { OUTPUT_LIMIT } from "./run"
import { addInclude, alias, editorKey, GUEST_SETUP, GUEST_SSH, includeLine, included, keyFingerprint, parseGuestSetup, userConfig, validPublicKey, writeClientFiles, type SshAccess } from "./ssh"
import { deleteManifest, listManifests, readConfig, readManifest, scanManifests, validName, validSizes, validSpec, validTemplateName, writeManifest, type Dirs } from "./state"
import type { OpenRequest } from "./stream"
import { PaddockError, type CheckResult, type Engine, type Limits, type Manifest, type Provider, type RunResult, type Runner, type Session, type Stage, type Template, type SshSetup } from "./types"

// A running sandbox is stopped when a blocking check could not be made this many timer passes in a row.
export const UNCHECKED_PASSES = 4
// Checks the core answers from what it holds itself; a provider's answer for them is ignored.
const CORE_CHECKS = new Set<CheckResult["id"]>(["forwards", "ssh"])
// A running sandbox's memory or task limit is not lowered to within this share of what it uses now: the engine kills a
// sandbox that passes either (measured: one using 351 MB was killed within seconds of a 256 MB limit).
export const SHRINK_HEADROOM = 0.9
// Said with every template, since a template is shared on purpose.
export const TEMPLATE_CONTENTS = "A template holds every file in the sandbox's own filesystem, home folders included, as it was at one moment: shell history, .env files, package-manager tokens and any login not in Paddock's list are inside. Removed before saving: the usual login files (Claude, Codex, GitHub, git, SSH keys, AWS, netrc) under /root and /home/*, and Paddock's own relay and SSH host key. Not in it: running processes and memory, /dev/shm and any other folder gVisor keeps in memory (it does so for /tmp when the image's /tmp is empty; /proc/mounts inside shows them as tmpfs), volumes (inner Docker's /var/lib/docker, so no inner images or containers, and any volume the image declares), and the engine's /etc/hosts, /etc/hostname and /etc/resolv.conf."

export type ResizeChange = { limit: "cpus" | "memoryGb" | "pids" | "diskGb"; from: number; to: number; applies: "now" | "next start" | "unchanged" | "not enforced"; note?: string }

export type SandboxView = {
  // damaged: its state file cannot be read; stopReason says what is wrong with it.
  name: string; status: "running" | "stopped" | "missing" | "damaged" | "unknown"; engine: string; spec: Manifest["spec"]; createdAt: string
  machineId?: string; sandboxId?: string
  capabilities?: Engine["capabilities"]; lastVerify?: Manifest["lastVerify"]; stopReason?: string
  enforcementProblem?: Manifest["enforcementProblem"]
  // What a long operation on it is doing right now.
  activity?: string
  template?: Manifest["template"]
}

// Every operation on a sandbox. The rule it keeps: a sandbox runs only while no blocking check fails. Checks that need
// only configuration run before a start, the rest right after it, and `enforce` repeats the cheap ones on a timer.
export class Core {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly activity = new Map<string, string>()
  // Passes in a row in which a blocking check of a running sandbox could not be made.
  private readonly unchecked = new Map<string, number>()
  private readonly enforcementProblems = new Map<string, NonNullable<Manifest["enforcementProblem"]>>()
  // Open sessions per sandbox name, closed when it stops or is removed.
  private readonly sessions = new Map<string, Set<Session>>()
  private readonly leases = new Map<string, { name: string; sandboxId: string; generation: string; port: number; session: Session; dials: Set<Session> }>()
  // Forwards by id. They live in this daemon only: a stop, restart or removal of their sandbox, or the daemon's exit,
  // ends them, and nothing brings one back.
  private readonly forwards = new Map<string, { view: Omit<ForwardView, "connections">; server: Server; connections: Set<Session>; watch: ReturnType<typeof setInterval> }>()
  // A hosted forward's lease ends after this long without a renewal from the primary (core/forwards.ts).
  leaseTtlMs = LEASE_TTL_MS
  constructor(private readonly providers: readonly Provider[], readonly dirs: Dirs, private readonly run: Runner, private readonly cliDir: string, readonly machineId = "") {}

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
    let status: SandboxView["status"] = "unknown"
    let stopReason = manifest.stopReason
    try {
      status = await this.provider(manifest).status(manifest)
      // Paddock did not stop it, so ask the engine why it is not running.
      if (status === "stopped" && !stopReason) stopReason = await this.provider(manifest).stoppedWhy(manifest)
    } catch (error) { if (error instanceof PaddockError && error.code === "conflict") stopReason = error.message }
    return { name: manifest.name, machineId: this.machineId, sandboxId: manifest.id, status, engine: manifest.engine.label, spec: manifest.spec, createdAt: manifest.createdAt, capabilities: manifest.engine.capabilities,
      lastVerify: manifest.lastVerify && { at: manifest.lastVerify.at, results: manifest.lastVerify.results.map((check) => ({ ...check, status: "unknown", evidence: "none",
        detail: `Historical only. Measured at ${manifest.lastVerify!.at}: ${check.status} (${check.evidence}). ${check.detail} Current property unknown; run paddock verify ${manifest.name} for a new measurement.` })) },
      enforcementProblem: this.enforcementProblems.get(manifest.name) ?? manifest.enforcementProblem,
      stopReason, activity: this.activity.get(manifest.name), template: manifest.template }
  }

  async list(): Promise<SandboxView[]> {
    const { manifests, damaged } = await scanManifests(this.dirs)
    return [...await Promise.all(manifests.map((manifest) => this.view(manifest))),
      ...damaged.map((entry): SandboxView => ({ name: entry.name, machineId: this.machineId, status: "damaged", engine: "", spec: { name: entry.name, image: "", cpus: 0, memoryGb: 0, pids: 0, diskGb: 0, docker: false }, createdAt: "",
        stopReason: `Its state file ${entry.file} cannot be read (${entry.problem}). Paddock does nothing with it; fix the file or delete it.` }))]
  }
  async get(name: string): Promise<SandboxView> { return this.view(await readManifest(this.dirs, name)) }

  private async stage(manifest: Manifest, stages: readonly Stage[], running: boolean): Promise<CheckResult[]> {
    const provider = this.provider(manifest); const results: CheckResult[] = []
    for (const stage of stages) {
      if (stage !== "config" && !running) continue
      results.push(...(await provider.checks(manifest, stage)).filter((result) => !CORE_CHECKS.has(result.id)))
    }
    if (stages.includes("config")) results.push(this.forwardCheck(manifest), this.sshCheck(manifest))
    return complete(results, stages, running ? undefined : "Not checked: the sandbox is not running.")
  }

  private refuse(name: string, failed: CheckResult[], consequence: string): never {
    throw new PaddockError("check-failed", `${name} ${consequence}: ${failed.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")}`, failed)
  }

  // Before the engine stops it, so each client is told why its session ended.
  private endSessions(name: string, reason: string): void {
    for (const session of this.sessions.get(name) ?? []) session.close(reason)
    this.sessions.delete(name)
    for (const forward of [...this.forwards.values()]) if (forward.view.name === name) this.endForward(forward.view.id, reason)
  }

  private async stopBecause(manifest: Manifest, reason: string): Promise<void> {
    this.endSessions(manifest.name, `The session ended: ${manifest.name} was stopped. ${reason}`)
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
    const { manifest, checks } = await this.exclusive(spec.name, async () => {
      if ((await listManifests(this.dirs)).some((entry) => entry.name === spec.name)) throw new PaddockError("conflict", `A sandbox named ${spec.name} already exists.`)
      const engines = await this.engines()
      const wanted = typeof input.engine === "string" && input.engine ? input.engine : config.engine
      const engine = wanted ? engines.find((entry) => entry.id === wanted) : engines.find((entry) => entry.ready)
      if (!engine) throw new PaddockError("dependency", wanted ? `There is no engine ${wanted}. Run \`paddock doctor\`.` : "No engine is ready for sandboxes. Run `paddock doctor` to see what each one needs.")
      if (!engine.ready) throw new PaddockError("dependency", `${engine.label} is not ready: ${engine.problems.join(" ")} ${engine.fix ?? ""}`.trim())
      if (spec.docker && !engine.capabilities?.docker) throw new PaddockError("dependency", `${engine.label} cannot run Docker inside a sandbox. Choose an engine with the docker capability (gVisor needs --net-raw and --overlay2=none).`)
      // Written before the engine is touched, so a half-made sandbox can always be removed.
      const manifest: Manifest = { version: 1, name: spec.name, id: randomBytes(16).toString("hex"), engine, spec, createdAt: new Date().toISOString() }
      const provider = this.provider(manifest)
      if (spec.template) {
        // Held until the container exists: from then on a removal of the template leaves its image to this sandbox.
        await this.exclusive(`template:${spec.template}`, async () => {
          const template = (await provider.templates(engine)).find((entry) => entry.name === spec.template)
          if (!template) throw new PaddockError("not-found", `There is no template named ${spec.template} on ${engine.label}. See \`paddock template list\`.`)
          spec.image = template.imageId
          manifest.template = { name: template.name, imageId: template.imageId, source: template.source, createdAt: template.createdAt }
          await writeManifest(this.dirs, manifest)
          this.activity.set(spec.name, `Creating from template ${template.name}`)
          await provider.create(manifest)
        })
      } else {
        await writeManifest(this.dirs, manifest)
        this.activity.set(spec.name, `Creating (downloading ${spec.image} if it is not here yet)`)
        await provider.create(manifest)
      }
      await this.startChecked(manifest)
      const { checks, failed } = await this.verifyNow(manifest)
      if (failed.length) this.refuse(spec.name, failed, "was created but stopped, and is kept for diagnosis")
      return { manifest, checks }
    })
    // Hooks run once the sandbox is free again, so a hook may use any command on it (verify, stop, start).
    const hooks = []
    for (const extension of (await loadExtensions(this.dirs)).extensions) {
      if (!extension.hooks.postCreate) continue
      this.activity.set(spec.name, `Running ${extension.name}'s setup`)
      const output = await runCommand(this.run, extension, extension.hooks.postCreate, { PADDOCK_SANDBOX: spec.name }, this.cliDir).finally(() => this.activity.delete(spec.name))
      hooks.push({ extension: extension.id, exitCode: output.exitCode, output: `${output.stdout}${output.stderr}`.trim() })
    }
    return { sandbox: await this.get(spec.name).catch(() => this.view(manifest)), checks, hooks }
  }

  start(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => { const manifest = await readManifest(this.dirs, name); await this.startChecked(manifest); return this.view(manifest) })
  }

  stop(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      this.activity.set(name, "Stopping")
      this.endSessions(name, `The session ended: ${name} was stopped.`)
      await this.provider(manifest).stop(manifest); return this.view(manifest)
    })
  }

  // The confirmation is checked here, not in a UI, so no client can remove a sandbox without naming it twice.
  remove(name: string, confirm: unknown): Promise<{ removed: string }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      if (confirm !== name) throw new PaddockError("usage", `Removing ${name} deletes everything in it. Confirm by repeating its name.`)
      this.activity.set(name, "Removing")
      this.endSessions(name, `The session ended: ${name} was removed.`)
      await this.provider(manifest).remove(manifest); await deleteManifest(this.dirs, name)
      this.enforcementProblems.delete(name); this.unchecked.delete(name)
      if (manifest.ssh) await writeClientFiles(this.dirs, await listManifests(this.dirs))
      return { removed: name }
    })
  }

  // CPUs, memory and the task limit are set in the engine, and the manifest follows once it accepted them. For a running
  // sandbox a limit counts as applied now only when the engine's host reports it back; the disk limit is the daemon's
  // own number, which its next watch pass (within 30 seconds) uses.
  resize(name: string, input: Record<string, unknown>): Promise<{ sandbox: SandboxView; changes: ResizeChange[]; checks: CheckResult[] }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest); const before = manifest.spec
      const keys = ["cpus", "memoryGb", "pids", "diskGb"] as const
      if (!keys.some((key) => input[key] !== undefined && input[key] !== null && input[key] !== "")) throw new PaddockError("usage", "Give at least one of --cpus, --memory, --pids and --disk.")
      const next = validSizes(input, before)
      if (manifest.engine.capabilities?.resize === "none") throw new PaddockError("dependency", `${manifest.engine.label} cannot change a sandbox's limits.`)
      const status = await provider.status(manifest)
      if (status === "missing") throw new PaddockError("not-found", `${name} has no container on ${manifest.engine.label}.`)
      this.activity.set(name, "Resizing")
      const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`
      if (status === "running" && (next.memoryGb < before.memoryGb || next.pids < before.pids)) {
        const use = await provider.usage(manifest).catch(() => undefined)
        if (!use) throw new PaddockError("conflict", `What ${name} uses now could not be read, so its limits were not lowered while it runs. Stop it and resize again; the new limits then apply at its next start.`)
        const memory = Math.round(next.memoryGb * 1024) * 1024 ** 2
        if (next.memoryGb < before.memoryGb && use.memoryBytes >= memory * SHRINK_HEADROOM)
          throw new PaddockError("conflict", `${name} uses ${gb(use.memoryBytes)} of memory now; a limit of ${next.memoryGb} GB would leave it under ${Math.round((1 - SHRINK_HEADROOM) * 100)}% headroom, and the engine kills a sandbox that passes its limit. Nothing was changed. Free memory inside it, or stop it first.`)
        if (next.pids < before.pids && use.tasks >= next.pids * SHRINK_HEADROOM)
          throw new PaddockError("conflict", `${name} runs ${use.tasks} tasks now (gVisor's own threads count); a limit of ${next.pids} would leave it under ${Math.round((1 - SHRINK_HEADROOM) * 100)}% headroom, and a gVisor sandbox that passes it ends. Nothing was changed.`)
      }
      if (next.diskGb < before.diskGb && manifest.engine.capabilities?.diskLimit !== "none") {
        const used = await provider.diskUsedBytes(manifest)
        if (used === undefined) throw new PaddockError("conflict", `${name}'s disk use could not be measured, so its disk limit was not lowered. Nothing was changed.`)
        if (used > next.diskGb * 1024 ** 3) throw new PaddockError("conflict", `${name} uses ${gb(used)} of disk, more than ${next.diskGb} GB; the watch would stop it at once. Nothing was changed.`)
      }
      const limitsChanged = (["cpus", "memoryGb", "pids"] as const).some((key) => next[key] !== before[key])
      const live = limitsChanged ? await provider.resize(manifest, next) : undefined
      manifest.spec = { ...before, ...next }
      await writeManifest(this.dirs, manifest)
      const same = (key: keyof Limits, a: number, b: number) => key === "memoryGb" ? Math.round(a * 1024) === Math.round(b * 1024) : key === "cpus" ? Math.round(a * 1e9) === Math.round(b * 1e9) : a === b
      const changes = keys.map((limit): ResizeChange => {
        const change = { limit, from: before[limit], to: next[limit] }
        if (next[limit] === before[limit]) return { ...change, applies: "unchanged" }
        if (limit === "diskGb") return manifest.engine.capabilities?.diskLimit === "none"
          ? { ...change, applies: "not enforced", note: "This engine has no disk limit; the number is recorded only." }
          : { ...change, applies: "now", note: "The daemon's disk watch uses it from its next pass, within 30 seconds." }
        if (status !== "running") return { ...change, applies: "next start" }
        if (live && same(limit, live[limit], next[limit])) return { ...change, applies: "now", note: "Read back from the engine's host. Inside, /proc/meminfo keeps the memory gVisor started with and nproc does not follow the CPU limit; the engine's host enforces the new one." }
        return { ...change, applies: "next start", note: `The engine accepted it, but the running sandbox could not be confirmed to have it${live ? ` (its host reports ${live[limit]})` : ""}. It applies at the next start.` }
      })
      const checks = (await this.stage(manifest, ["config"], status === "running")).filter((check) => CHECKLIST.find((item) => item.id === check.id)?.stage === "config")
      const failed = blockers(checks)
      if (failed.length && status === "running") await this.stopBecause(manifest, `Stopped after a resize: ${failed.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")}`)
      return { sandbox: await this.view(manifest), changes, checks }
    })
  }

  // The sandbox stays locked while its template is made, and a running one is paused for the moment its files are saved.
  async snapshot(name: string, as: unknown): Promise<{ template: Template; contents: string }> {
    const templateName = validTemplateName(as)
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.engine.capabilities?.snapshot === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot make templates: its gVisor runtime lacks --overlay2=none, so the engine does not see a sandbox's files.`)
      if ((await provider.status(manifest)) === "missing") throw new PaddockError("not-found", `${name} has no container on ${manifest.engine.label}.`)
      return this.exclusive(`template:${templateName}`, async () => {
        this.activity.set(name, `Saving template ${templateName}`)
        return { template: await provider.snapshot(manifest, templateName), contents: TEMPLATE_CONTENTS }
      })
    })
  }

  private async readyEngines(): Promise<Array<{ engine: Engine; provider: Provider }>> {
    return (await this.engines()).filter((engine) => engine.ready).flatMap((engine) => {
      const provider = this.providers.find((entry) => entry.id === engine.provider)
      return provider ? [{ engine, provider }] : []
    })
  }

  async templateList(): Promise<Template[]> {
    const templates: Template[] = []
    for (const { engine, provider } of await this.readyEngines()) templates.push(...await provider.templates(engine))
    return templates
  }

  // Sandboxes made from it keep running, and can be stopped and started; its image is deleted with the last of them.
  async templateRemove(name: unknown, engineId?: unknown): Promise<{ removed: string; imageId: string; dependants: string[]; note: string }> {
    const templateName = validTemplateName(name)
    return this.exclusive(`template:${templateName}`, async () => {
      const found: Array<{ engine: Engine; provider: Provider }> = []
      for (const entry of await this.readyEngines()) {
        if (typeof engineId === "string" && engineId && entry.engine.id !== engineId) continue
        if ((await entry.provider.templates(entry.engine)).some((template) => template.name === templateName)) found.push(entry)
      }
      if (!found.length) throw new PaddockError("not-found", `There is no template named ${templateName}. See \`paddock template list\`.`)
      if (found.length > 1) throw new PaddockError("usage", `Templates named ${templateName} are on ${found.map((entry) => entry.engine.id).join(" and ")}. Choose one with --engine.`)
      const removed = await found[0]!.provider.removeTemplate(found[0]!.engine, templateName)
      return { removed: templateName, ...removed, note: removed.dependants.length
        ? `Sandboxes made from it keep working (they run, stop and start as before): ${removed.dependants.join(", ")}. Its image is deleted when the last of them is removed.`
        : "Its image was deleted." }
    })
  }

  verify(name: string): Promise<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean; diskUsedBytes?: number }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const { checks, failed } = await this.verifyNow(manifest)
      return { sandbox: await this.view(manifest), checks, ok: failed.length === 0, diskUsedBytes: await this.provider(manifest).diskUsedBytes(manifest) }
    })
  }

  async exec(name: string, argv: unknown, options: { user?: string; stdin?: string } = {}): Promise<RunResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) throw new PaddockError("usage", "exec needs a command.")
    if (options.user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(options.user)) throw new PaddockError("usage", "The user must be a user name or id.")
    const manifest = await readManifest(this.dirs, name)
    const result = await this.provider(manifest).exec(manifest, argv as string[], options)
    if (result.overflow) throw new PaddockError("runtime", `The command printed more than ${OUTPUT_LIMIT / 1024 ** 2} MiB on ${result.overflow}, the most one exec may return, so Paddock stopped reading and discarded its output. ${result.stderr} Write large output to a file inside the sandbox and read it in parts.`.replace(/  +/g, " "))
    return result
  }

  // A session on the stream socket. It never starts a sandbox: a client that reconnects on its own (an editor) must not
  // undo a stop.
  async openSession(request: OpenRequest): Promise<Session> {
    if (request.kind === "workspace") throw new PaddockError("usage", "Use the workspace session handler.")
    const manifest = await readManifest(this.dirs, request.name); const provider = this.provider(manifest)
    if (request.machineId !== undefined && request.machineId !== this.machineId) throw new PaddockError("identity-changed", "The session names another machine.")
    if (request.sandboxId !== undefined && request.sandboxId !== manifest.id) throw new PaddockError("identity-changed", "The sandbox was recreated; open a new session or forward explicitly.")
    if (request.generation !== undefined && request.generation !== await provider.generation(manifest)) throw new PaddockError("conflict", "The sandbox's run changed; open a new forward explicitly.")
    if (manifest.engine.capabilities?.execStream === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot relay a session's bytes.`)
    if ((await provider.status(manifest)) !== "running") throw new PaddockError("conflict", `${request.name} is not running. Start it with \`paddock start ${request.name}\`.`)
    if (request.kind === "lease") {
      if (this.leases.has(request.leaseId)) throw new PaddockError("conflict", "This relay lease already exists.")
      if (manifest.engine.capabilities?.loopbackRelay === false) throw new PaddockError("dependency", "This engine cannot relay sandbox loopback.")
      await provider.prepareLoopback(manifest)
      const events = new EventEmitter(); let ended = false; let paused = false; let checking = false; let renewed = Date.now()
      const close = (reason = "The relay control stream ended.") => { if (ended) return; ended = true; clearInterval(watch); clearInterval(heartbeat); this.leases.delete(request.leaseId); for (const dial of lease.dials) dial.close(reason); events.emit("end", { error: reason }) }
      // Any byte from the primary renews the lease. Its silence ends it, however long SSH or TCP takes to notice a partition.
      const session: Session = Object.assign(events, { tty: false, write: () => { renewed = Date.now(); return true }, end: () => close(), resize: async () => {}, pause: () => { paused = true }, resume: () => { paused = false }, close })
      const lease = { name: manifest.name, sandboxId: manifest.id, generation: request.generation, port: request.port, session, dials: new Set<Session>() }
      this.leases.set(request.leaseId, lease)
      const watch = setInterval(async () => {
        if (checking || ended) return
        if (Date.now() - renewed >= this.leaseTtlMs) return close(`The primary did not renew this forward's lease for ${this.leaseTtlMs / 1000} seconds.`)
        checking = true
        try { if (await provider.generation(manifest).catch(() => undefined) !== request.generation) close("The forward's sandbox stopped or restarted.") } finally { checking = false }
      }, Math.min(2000, this.leaseTtlMs / 4))
      const heartbeat = setInterval(() => { if (!paused && !ended) events.emit("output", "stdout", Buffer.from([1])) }, 5000)
      watch.unref(); heartbeat.unref()
      this.trackSession(manifest.name, session)
      return session
    }
    if (request.kind === "dial") {
      const lease = this.leases.get(request.leaseId)
      if (!lease || lease.name !== manifest.name || lease.sandboxId !== manifest.id || lease.generation !== request.generation || lease.port !== request.port) throw new PaddockError("conflict", "The forward lease is no longer open for this run and port.")
      const session = await provider.dialLoopback(manifest, request.port)
      if (this.leases.get(request.leaseId) !== lease) { session.close(); throw new PaddockError("conflict", "The forward lease ended while connecting.") }
      lease.dials.add(session); session.on("end", () => lease.dials.delete(session)); this.trackSession(manifest.name, session)
      return session
    }
    // sshd in inetd mode serves this one connection; -e sends its complaints to the client's stderr.
    if (request.kind === "ssh" && !manifest.ssh) throw new PaddockError("conflict", `SSH is not set up for ${request.name}. Run \`paddock ssh setup ${request.name}\`.`)
    const session = request.kind === "ssh" ? await provider.openExec(manifest, [manifest.ssh!.sshd, "-i", "-e", "-f", `${GUEST_SSH}/sshd_config`], { user: "0", tty: false })
      : await provider.openExec(manifest, request.argv, request)
    this.trackSession(request.name, session)
    return session
  }

  private trackSession(name: string, session: Session): void {
    const open = this.sessions.get(name) ?? new Set<Session>()
    this.sessions.set(name, open.add(session))
    session.on("end", () => open.delete(session))
  }

  async sessionTarget(name: unknown): Promise<{ name: string; machineId: string; sandboxId: string; generation: string }> {
    const manifest = await readManifest(this.dirs, validName(name)); const generation = await this.provider(manifest).generation(manifest)
    if (!generation) throw new PaddockError("conflict", `${manifest.name} is not running.`)
    return { name: manifest.name, machineId: this.machineId, sandboxId: manifest.id, generation }
  }

  closeSessions(): void {
    for (const name of new Set([...this.sessions.keys(), ...[...this.forwards.values()].map((forward) => forward.view.name)])) this.endSessions(name, "The session ended: the Paddock daemon stopped.")
  }

  // A listener on 127.0.0.1 only, bound once, for this run of the sandbox. Each connection is relayed to the same port on
  // the sandbox's own loopback, after checking that the run it was made for is still the one running.
  async forwardAdd(name: string, port: unknown, localPort?: unknown): Promise<ForwardView> {
    const target = validPort(port, "The port"); const local = localPort === undefined || localPort === null || localPort === "" ? undefined : validPort(localPort, "The local port")
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.engine.capabilities?.loopbackRelay === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot relay a connection into a sandbox.`)
      const generation = await provider.generation(manifest)
      if (!generation) throw new PaddockError("conflict", `${name} is not running. Start it with \`paddock start ${name}\`, then add the forward.`)
      await provider.prepareLoopback(manifest)
      const server = await listenLoopback(local)
      const id = randomBytes(4).toString("hex")
      const forward = { view: { id, name, sandboxId: manifest.id, generation, localAddress: "127.0.0.1" as const, localPort: boundPort(server), port: target, createdAt: new Date().toISOString() },
        server, connections: new Set<Session>(), watch: setInterval(() => void this.forwardCurrent(id, manifest), 2000) }
      forward.watch.unref?.()
      this.forwards.set(id, forward)
      server.on("connection", async (socket) => {
        socket.on("error", () => {})
        if (!await this.forwardCurrent(id, manifest)) return socket.destroy()
        const session = await provider.dialLoopback(manifest, target).catch(() => undefined)
        if (!session || !this.forwards.has(id)) { session?.close(); return socket.destroy() }
        forward.connections.add(session); session.on("end", () => forward.connections.delete(session))
        relay(socket, session)
      })
      return { ...forward.view, connections: 0 }
    })
  }

  // Whether a forward's sandbox is still in the run the forward was made for. When it is not, the forward ends.
  private async forwardCurrent(id: string, manifest: Manifest): Promise<boolean> {
    const forward = this.forwards.get(id)
    if (!forward) return false
    const now = await this.provider(manifest).generation(manifest).catch(() => undefined)
    if (now === forward.view.generation) return true
    this.endForward(id, `The forward ended: ${manifest.name} ${now ? "was restarted" : "is no longer running"}.`)
    return false
  }

  private endForward(id: string, reason: string): void {
    const forward = this.forwards.get(id)
    if (!forward) return
    this.forwards.delete(id); clearInterval(forward.watch); forward.server.close()
    for (const session of forward.connections) session.close(reason)
  }

  forwardList(name?: unknown): ForwardView[] {
    const only = name === undefined || name === null || name === "" ? undefined : validName(name)
    return [...this.forwards.values()].filter((forward) => !only || forward.view.name === only).map((forward) => ({ ...forward.view, connections: forward.connections.size }))
  }

  forwardRemove(id: unknown): { closed: string } {
    if (typeof id !== "string" || !this.forwards.has(id)) throw new PaddockError("not-found", `There is no forward ${String(id)}. See \`paddock forward list\`.`)
    this.endForward(id, "The forward was removed.")
    return { closed: id }
  }

  // A disclosure, from the listeners themselves: any process on this machine can connect to a loopback port.
  private forwardCheck(manifest: Manifest): CheckResult {
    const mine = [...this.forwards.values()].filter((forward) => forward.view.sandboxId === manifest.id)
    const leases = [...this.leases.entries()].filter(([, lease]) => lease.sandboxId === manifest.id)
    if (leases.length) return { id: "forwards", status: "info", evidence: "inspected", detail: `${leases.map(([id, lease]) => `SSH lease ${id} to sandbox loopback port ${lease.port}`).join(", ")}. This daemon checked the sandbox run and port. The primary's loopback listener address and current reachability are unknown here; \`paddock --host HOST forward list\` on the primary shows its listener. The lease ends with its control stream or sandbox run, or ${this.leaseTtlMs / 1000} seconds after the primary last renewed it.` }
    if (!mine.length) return { id: "forwards", status: "info", evidence: "inspected", detail: "None. A forward added with `paddock forward add` listens on 127.0.0.1 only and ends when the sandbox stops." }
    const listed = mine.map((forward) => { const address = forward.server.address(); return `${typeof address === "object" && address ? `${address.address}:${address.port}` : "not listening"} to port ${forward.view.port} (${forward.view.id})` })
    return { id: "forwards", status: "info", evidence: "inspected", detail: `${listed.join(", ")}. Any process on this machine can connect to these, and so can whatever the engine relays to its loopback: on OrbStack, the engine's host and its other containers, through host.docker.internal.` }
  }

  // Prepares sshd inside, trusts only this machine's editor key there, and writes the alias and its host key here. Run
  // again, it makes a new host key; the old one stops being trusted.
  sshSetup(name: string, writeConfig = false, publicKey?: string): Promise<SshAccess & { config: string; include: string; included: boolean; editorKey: string; keyFile: string; sandboxId: string; setup: SshSetup }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.engine.capabilities?.execStream === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot relay a session's bytes, which SSH needs.`)
      if ((await provider.status(manifest)) !== "running") throw new PaddockError("conflict", `${name} is not running. Start it with \`paddock start ${name}\`, then set up SSH.`)
      if (publicKey !== undefined && !validPublicKey(publicKey)) throw new PaddockError("usage", "SSH preparation needs an Ed25519 public key.")
      const key = publicKey === undefined ? await editorKey(this.dirs) : { path: "", publicKey, fingerprint: keyFingerprint(publicKey) }
      this.activity.set(name, "Preparing SSH")
      try {
        const who = await provider.exec(manifest, ["id", "-un"])
        const user = who.stdout.trim()
        if (who.exitCode !== 0 || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new PaddockError("runtime", `Could not tell which user exec runs as in ${name}: ${who.stderr.trim() || user}`)
        const done = await provider.exec(manifest, ["sh", "-c", GUEST_SETUP, "sh", user, key.publicKey], { user: "0" })
        if (done.exitCode !== 0) throw new PaddockError(done.exitCode === 4 ? "dependency" : "runtime", `Could not prepare sshd in ${name}: ${done.stderr.trim().split("\n").slice(-3).join(" ")}`)
        // A second setup finds the password already unlocked; the first one's word for it is kept.
        const guest = parseGuestSetup(done.stdout)
        manifest.ssh = { user, ...guest, unlocked: guest.unlocked || Boolean(manifest.ssh?.unlocked), editorKey: key.fingerprint, at: new Date().toISOString(), ...(publicKey === undefined ? {} : { editorKeyOrigin: "client" as const }) }
        await writeManifest(this.dirs, manifest)
        if (publicKey === undefined) await writeClientFiles(this.dirs, await listManifests(this.dirs))
      } finally { this.activity.delete(name) }
      if (writeConfig && publicKey === undefined) await addInclude(this.dirs)
      return { ...await this.sshAccessOf(manifest), config: userConfig(), include: includeLine(this.dirs), included: publicKey === undefined && await included(this.dirs), editorKey: key.fingerprint, keyFile: key.path, sandboxId: manifest.id, setup: manifest.ssh! }
    })
  }

  async sshAccess(name: string): Promise<SshAccess> { return this.sshAccessOf(await readManifest(this.dirs, validName(name))) }

  // batchReady: `ssh ALIAS` would log in now without asking anything: set up for this sandbox, running, and included.
  private async sshAccessOf(manifest: Manifest): Promise<SshAccess> {
    const ready = Boolean(manifest.ssh) && (await this.provider(manifest).status(manifest)) === "running" && await included(this.dirs)
    return { alias: alias(manifest.name), user: manifest.ssh?.user ?? "", home: manifest.ssh?.home ?? "", batchReady: ready, loopbackForwarding: Boolean(manifest.ssh) }
  }

  private sshCheck(manifest: Manifest): CheckResult {
    if (!manifest.ssh) return { id: "ssh", status: "info", evidence: "inspected", detail: "Not set up. `paddock ssh setup` opens no port; it reaches sshd through the daemon." }
    return { id: "ssh", status: "info", evidence: "inspected", detail: `Set up ${manifest.ssh.at.slice(0, 10)} for ${manifest.ssh.user} (${manifest.ssh.home}) with ${manifest.ssh.editorKeyOrigin === "client" ? "the requesting client's editor public key" : "this machine's editor key"} ${manifest.ssh.editorKey}, ${manifest.ssh.editorKeyOrigin === "client" ? "whose private half is not installed by this daemon" : "kept in Paddock's state folder"}. Anything that can read that private key can log in as ${manifest.ssh.user} and forward to the sandbox's loopback; no agent forwarding, no other key.${manifest.ssh.unlocked ? ` Setup replaced ${manifest.ssh.user}'s locked password with * (still no password) because sshd refuses a locked account.` : ""}` }
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
    for (const listed of await listManifests(this.dirs)) {
      await this.exclusive(listed.name, async () => {
        const manifest = await readManifest(this.dirs, listed.name)
        let stoppingFor: string | undefined
        try {
          const provider = this.provider(manifest)
          if ((await provider.status(manifest)) !== "running") { this.unchecked.delete(manifest.name); return }
          const results = await this.stage(manifest, ["config", "runtime"], true)
          const describe = (entries: CheckResult[]) => entries.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")
          const failed = failures(results)
          if (failed.length) {
            stoppingFor = `Blocking checks did not hold: ${describe(failed)}`
            await this.recordEnforcement(manifest, stoppingFor)
            await this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString()}: ${describe(failed)}`)
            this.unchecked.delete(manifest.name); return
          }
          const blind = blockers(results); const problems = blind.length ? [`Could not check ${describe(blind)}`] : []
          if (manifest.engine.capabilities?.diskLimit === "watched") {
            const used = await provider.diskUsedBytes(manifest)
            if (used === undefined) problems.push("Disk use could not be measured; the watched disk limit is unknown.")
            else if (used > manifest.spec.diskGb * 1024 ** 3) {
              const reason = `Stopped by the disk watch: it used ${(used / 1024 ** 3).toFixed(1)} GB of its ${manifest.spec.diskGb} GB. Free space inside it after a start, or it is stopped again.`
              stoppingFor = reason
              await this.recordEnforcement(manifest, reason); await this.stopBecause(manifest, reason)
              this.unchecked.delete(manifest.name); return
            }
          }
          if (problems.length) return await this.enforcementUnknown(manifest, problems.join("; "))
          this.unchecked.delete(manifest.name)
          this.enforcementProblems.delete(manifest.name)
          if (manifest.enforcementProblem) { delete manifest.enforcementProblem; await writeManifest(this.dirs, manifest) }
        } catch (error) {
          await this.enforcementUnknown(manifest, `Enforcement could not be completed: ${(error as Error).message}${stoppingFor ? `; ${stoppingFor}` : ""}`)
        }
      }).catch((error) => { this.enforcementProblems.set(listed.name, { at: new Date().toISOString(), message: `Enforcement could not read its state: ${(error as Error).message}` }) })
    }
  }

  private async recordEnforcement(manifest: Manifest, message: string): Promise<void> {
    const problem = { at: new Date().toISOString(), message }
    manifest.enforcementProblem = problem; this.enforcementProblems.set(manifest.name, problem)
    try { await writeManifest(this.dirs, manifest) } catch (error) { problem.message += `; could not save this warning: ${(error as Error).message}` }
  }

  private async enforcementUnknown(manifest: Manifest, message: string): Promise<void> {
    const count = (this.unchecked.get(manifest.name) ?? 0) + 1
    this.unchecked.set(manifest.name, count)
    await this.recordEnforcement(manifest, message)
    if (count < UNCHECKED_PASSES) return
    try {
      await this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString()}: for ${UNCHECKED_PASSES} passes in a row it could not check enforcement. ${message}`)
      this.unchecked.delete(manifest.name)
    } catch (error) { await this.recordEnforcement(manifest, `${message}; the stop attempt also failed: ${(error as Error).message}`) }
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
