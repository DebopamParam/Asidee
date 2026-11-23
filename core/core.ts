import { randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import type { Server } from "node:net"
import { blockers, checklistFor, complete, failures, GPU_KIND, GPU_USER, GPU_WARNING, historical, titleOf } from "./checks"
import { availableExtensions, fieldValues, installExtension, loadExtensions, removeExtension, runCommand } from "./extensions"
import { copyFlag, remainingSteps, validSetup } from "./create-setup"
import { homeFolder } from "./folders"
import { boundPort, FORWARD_REACH, LEASE_TTL_MS, listenLoopback, relay, validPort, type ForwardView } from "./forwards"
import { Links } from "./links"
import { OUTPUT_LIMIT } from "./run"
import { addInclude, alias, editorKey, GUEST_SETUP, GUEST_SSH, includeLine, included, keyFingerprint, parseGuestSetup, userConfig, validPublicKey, writeClientFiles, type SshAccess } from "./ssh"
import { deleteManifest, listManifests, readConfig, readManifest, scanManifests, validName, validSizes, validSpec, validTemplateName, writeManifest, writeConfig, type Dirs } from "./state"
import type { OpenRequest } from "./stream"
import { AsideeError, type CheckResult, type CreateSetup, type DiskWarning, type Engine, type Limits, type Manifest, type Provider, type RunResult, type Runner, type Session, type Stage, type Template, type SshSetup, type Visibility, privateThere } from "./types"

// Private: only this machine's own Asidee sees it. Public: other machines see and use it too, through routing.
export const visibilityOf = (manifest: Pick<Manifest, "visibility">): Visibility => manifest.visibility ?? "public"
export { privateThere } from "./types"

// A running sandbox is stopped when a blocking check could not be made this many timer passes in a row.
export const UNCHECKED_PASSES = 4
// Checks the core answers from what it holds itself; a provider's answer for them is ignored.
const CORE_CHECKS = new Set<CheckResult["id"]>(["forwards", "ssh", "links", "link-scope"])
// A running sandbox's memory or task limit is not lowered to within this share of what it uses now: the engine kills a
// sandbox that passes either (measured: one using 351 MB was killed within seconds of a 256 MB limit).
export const SHRINK_HEADROOM = 0.9
// How long a create that did not finish is kept after its last progress, for a retry: long enough to fix a login or a
// repository name and run `asd create --retry`, short enough that a forgotten one does not hold its disk for long.
export const UNFINISHED_KEEP_MS = 30 * 60_000
// Said with every template, since a template is shared on purpose.
export const TEMPLATE_CONTENTS = "A template holds every file in the sandbox's own filesystem, home folders included, as it was at one moment: shell history, .env files, package-manager tokens and any login not in Asidee's list are inside. Removed before saving: the usual login files (Claude, Codex, GitHub, git, SSH keys, AWS, netrc) under /root and /home/*, and Asidee's own relay and SSH host key. Not in it: running processes and memory, /dev/shm and any other folder gVisor keeps in memory (it does so for /tmp when the image's /tmp is empty; /proc/mounts inside shows them as tmpfs), volumes (inner Docker's /var/lib/docker, so no inner images or containers, and any volume the image declares), and the engine's /etc/hosts, /etc/hostname and /etc/resolv.conf."

export type ResizeChange = { limit: "cpus" | "memoryGb" | "pids" | "diskGb"; from: number; to: number; applies: "now" | "next start" | "unchanged" | "not enforced"; note?: string }

export type SandboxView = {
  // damaged: its state file cannot be read; stopReason says what is wrong with it.
  name: string; status: "running" | "stopped" | "missing" | "damaged" | "unknown"; engine: string; spec: Manifest["spec"]; createdAt: string
  machineId?: string; sandboxId?: string
  capabilities?: Engine["capabilities"]; lastVerify?: Manifest["lastVerify"]; stopReason?: string
  enforcementProblem?: Manifest["enforcementProblem"]
  diskWarning?: DiskWarning
  // What a long operation on it is doing right now.
  activity?: string
  template?: Manifest["template"]
  unfinished?: Manifest["unfinished"]
  visibility?: Visibility
  // Set only for the weaker kind, a GPU container (GPU_KIND); a sandbox has none.
  kind?: string
}

export type SandboxUsage = { name: string; running: boolean; cpus: number; memoryLimitBytes: number; pidsLimit: number; diskLimitBytes: number; cpuPercent?: number; memoryBytes?: number
  tasks?: number; diskBytes?: number; diskMeasuredAt?: string; problem?: string }

// In a GPU container, commands run as uid 1000; a request for any other user, root included, is refused. Asidee's own
// steps inside it (the DNS fallback, the relay) do not come through here.
function gpuUser(manifest: Manifest, user: string | undefined): void {
  if (manifest.spec.gpu && user !== undefined && user !== "1000" && user !== GPU_USER)
    throw new AsideeError("usage", `${manifest.name} is a GPU container, where commands run as uid 1000 only; --user ${user} is refused. Root is not offered there, since the container runs on its machine's own kernel.`)
}

const overDisk = (manifest: Manifest, used: number) => `Stopped by the disk watch: it used ${(used / 1024 ** 3).toFixed(1)} GB of its ${manifest.spec.diskGb} GB. Free space inside it after a start, or it is stopped again.`

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
  // When a start found a sandbox over its watched disk limit, by name. For diskRecoveryMs after it the sandbox is not
  // stopped for its disk use, so there is time to free space; the disk watch ends that early once it measures under.
  private readonly startedOver = new Map<string, number>()
  diskRecoveryMs = 30_000
  unfinishedKeepMs = UNFINISHED_KEEP_MS
  private recovering(name: string): boolean { return Date.now() - (this.startedOver.get(name) ?? -Infinity) < this.diskRecoveryMs }
  // The last disk measurement of each sandbox and when it was made, for the dashboard's usage view; and the CPU time
  // each had used at the previous usage call, to give the share of a CPU between two calls.
  private readonly diskSeen = new Map<string, { bytes: number; at: string }>()
  private readonly cpuSeen = new Map<string, { ns: number; at: number }>()
  // A hosted forward's lease ends after this long without a renewal from the primary (core/forwards.ts).
  leaseTtlMs = LEASE_TTL_MS
  // Links between sandboxes (core/links.ts). Unlike forwards they are recorded, and come back after a restart.
  readonly links: Links
  constructor(private readonly providers: readonly Provider[], readonly dirs: Dirs, private readonly run: Runner, readonly cliDir: string, readonly machineId = "") {
    this.links = new Links(dirs, (manifest) => this.provider(manifest))
  }

  // One operation per sandbox at a time.
  private exclusive<T>(name: string, task: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(name) ?? Promise.resolve()).then(task, task).finally(() => this.activity.delete(name))
    this.locks.set(name, next.catch(() => {}))
    return next
  }

  private provider(manifest: Manifest): Provider {
    const provider = this.providers.find((entry) => entry.id === manifest.engine.provider)
    if (!provider) throw new AsideeError("dependency", `${manifest.name} was made with the ${manifest.engine.provider} provider, which this build does not have.`)
    return provider
  }

  configGet() { return readConfig(this.dirs) }
  // withCommand: the request came over the CLI's socket, so it may set the custom terminal command.
  configSet(input: Record<string, unknown>, withCommand = false) { return this.exclusive(":config", () => writeConfig(this.dirs, input, withCommand)) }

  private async measureDisk(manifest: Manifest): Promise<number | undefined> {
    const used = await this.provider(manifest).diskUsedBytes(manifest)
    if (used !== undefined) this.diskSeen.set(manifest.name, { bytes: used, at: new Date().toISOString() })
    return used
  }

  // What each sandbox uses now, against its limits. cpuPercent is the share of one CPU since the previous call, as
  // docker stats counts it (200 is two CPUs busy), so the first call has none; disk is the last measurement the disk
  // watch, a start or a verify made, with its time. Nothing here is measured for a stopped sandbox.
  async usage(): Promise<SandboxUsage[]> {
    return Promise.all((await listManifests(this.dirs)).map(async (manifest): Promise<SandboxUsage> => {
      const limits = { cpus: manifest.spec.cpus, memoryLimitBytes: manifest.spec.memoryGb * 1024 ** 3, pidsLimit: manifest.spec.pids, diskLimitBytes: manifest.spec.diskGb * 1024 ** 3 }
      const disk = this.diskSeen.get(manifest.name)
      const seen = disk ? { diskBytes: disk.bytes, diskMeasuredAt: disk.at } : {}
      let use: Awaited<ReturnType<Provider["usage"]>>
      try { use = await this.provider(manifest).usage(manifest) } catch (error) { return { name: manifest.name, running: false, ...limits, ...seen, problem: (error as Error).message } }
      if (!use) { this.cpuSeen.delete(manifest.name); return { name: manifest.name, running: false, ...limits, ...seen } }
      const now = Date.now(); const before = this.cpuSeen.get(manifest.name)
      if (use.cpuNs !== undefined) this.cpuSeen.set(manifest.name, { ns: use.cpuNs, at: now })
      const cpuPercent = before && use.cpuNs !== undefined && use.cpuNs >= before.ns && now > before.at ? (use.cpuNs - before.ns) / ((now - before.at) * 1e6) * 100 : undefined
      return { name: manifest.name, running: true, ...limits, ...seen, memoryBytes: use.memoryBytes, tasks: use.tasks, ...(cpuPercent !== undefined ? { cpuPercent: Math.round(cpuPercent * 10) / 10 } : {}) }
    }))
  }

  async engines(): Promise<Engine[]> { return (await Promise.all(this.providers.map((provider) => provider.detect()))).flat() }

  private async view(manifest: Manifest): Promise<SandboxView> {
    let status: SandboxView["status"] = "unknown"
    let stopReason = manifest.stopReason
    try {
      status = await this.provider(manifest).status(manifest)
      // Asidee did not stop it, so ask the engine why it is not running.
      if (status === "stopped" && !stopReason) stopReason = await this.provider(manifest).stoppedWhy(manifest)
    } catch (error) { if (error instanceof AsideeError && error.code === "conflict") stopReason = error.message }
    return { name: manifest.name, machineId: this.machineId, sandboxId: manifest.id, status, engine: manifest.engine.label, spec: manifest.spec, createdAt: manifest.createdAt, capabilities: manifest.engine.capabilities,
      lastVerify: historical(manifest.lastVerify),
      enforcementProblem: this.enforcementProblems.get(manifest.name) ?? manifest.enforcementProblem,
      stopReason, activity: this.activity.get(manifest.name), template: manifest.template, ...(manifest.unfinished ? { unfinished: manifest.unfinished } : {}), ...(manifest.spec.gpu ? { kind: GPU_KIND } : {}),
      visibility: visibilityOf(manifest) }
  }

  async list(): Promise<SandboxView[]> {
    const { manifests, damaged } = await scanManifests(this.dirs)
    return [...await Promise.all(manifests.map((manifest) => this.view(manifest))),
      ...damaged.map((entry): SandboxView => ({ name: entry.name, machineId: this.machineId, status: "damaged", engine: "", spec: { name: entry.name, image: "", cpus: 0, memoryGb: 0, pids: 0, diskGb: 0, docker: false }, createdAt: "",
        stopReason: `Its state file ${entry.file} cannot be read (${entry.problem}). Asidee does nothing with it; fix the file or delete it.` }))]
  }
  async get(name: string): Promise<SandboxView> { return this.view(await readManifest(this.dirs, name)) }

  // For a request from another machine: refuses a private sandbox, and leaves one that does not exist to the method,
  // which says so.
  async visible(name: unknown): Promise<void> {
    const manifest = await readManifest(this.dirs, validName(name)).catch((error) => { if (error instanceof AsideeError && error.code === "not-found") return undefined; throw error })
    if (manifest && visibilityOf(manifest) === "private") throw new AsideeError("not-found", privateThere(manifest.name))
  }
  // routed: asked by another machine, which may make a sandbox private but never public.
  setVisibility(name: string, visibility: unknown, routed = false): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => {
      if (visibility !== "private" && visibility !== "public") throw new AsideeError("usage", "visibility is private or public.")
      if (routed && visibility === "public") throw new AsideeError("usage", `Only ${name}'s own machine can make it public: run \`asd share ${name}\` there.`)
      const manifest = await readManifest(this.dirs, name)
      if (routed && visibilityOf(manifest) === "private") throw new AsideeError("not-found", privateThere(name))
      manifest.visibility = visibility
      await writeManifest(this.dirs, manifest)
      return this.view(manifest)
    })
  }

  private async stage(manifest: Manifest, stages: readonly Stage[], running: boolean): Promise<CheckResult[]> {
    const provider = this.provider(manifest); const results: CheckResult[] = []
    for (const stage of stages) {
      if (stage !== "config" && !running) continue
      results.push(...(await provider.checks(manifest, stage)).filter((result) => !CORE_CHECKS.has(result.id)))
      if (stage === "probe") {
        const peers = results.find((result) => result.id === "net-peers")
        if (peers) peers.detail += await this.links.peers(manifest)
        results.push(await this.links.scope(manifest))
      }
    }
    if (stages.includes("config")) results.push(this.forwardCheck(manifest), this.sshCheck(manifest), await this.links.check(manifest))
    return complete(results, stages, running ? undefined : `Not checked: the ${manifest.spec.gpu ? "GPU container" : "sandbox"} is not running.`, checklistFor(manifest.spec))
  }

  private refuse(manifest: Manifest, failed: CheckResult[], consequence: string): never {
    throw new AsideeError("check-failed", `${manifest.name} ${consequence}: ${failed.map((entry) => `${titleOf(entry.id, checklistFor(manifest.spec))} (${entry.detail})`).join("; ")}`, failed)
  }

  // Before the engine stops it, so each client is told why its session ended.
  private endSessions(name: string, reason: string): void {
    for (const session of this.sessions.get(name) ?? []) session.close(reason)
    this.sessions.delete(name)
    for (const forward of [...this.forwards.values()]) if (forward.view.name === name) this.endForward(forward.view.id, reason)
    this.links.end(name, reason)
  }

  private async stopBecause(manifest: Manifest, reason: string): Promise<void> {
    this.endSessions(manifest.name, `The session ended: ${manifest.name} was stopped. ${reason}`)
    await this.provider(manifest).stop(manifest)
    // A stop resolves what enforcement found; stopReason now carries it, so it is not left as a standing problem.
    manifest.stopReason = reason; delete manifest.enforcementProblem; delete manifest.checksPending; this.enforcementProblems.delete(manifest.name)
    await writeManifest(this.dirs, manifest)
  }

  // verifyFollows: the caller verifies next (create), and the start's checks are finished only once that verify is.
  private async startChecked(manifest: Manifest, verifyFollows = false): Promise<void> {
    const provider = this.provider(manifest); const name = manifest.name
    this.activity.set(name, "Loading the network guard")
    await provider.prepare(manifest)
    this.activity.set(name, "Checking the configuration")
    const checklist = checklistFor(manifest.spec)
    const before = blockers(await this.stage(manifest, ["config"], false), checklist)
    if (before.length) this.refuse(manifest, before, "was not started")
    this.activity.set(name, "Starting")
    manifest.checksPending = new Date().toISOString(); await writeManifest(this.dirs, manifest)
    // Whatever goes wrong from here, the sandbox is not left running unchecked.
    try {
      await provider.start(manifest)
      const after = blockers(await this.stage(manifest, ["runtime"], true), checklist)
      if (after.length) this.refuse(manifest, after, "was stopped again")
    } catch (error) {
      await provider.stop(manifest).catch(() => {})
      throw error
    }
    delete manifest.stopReason
    if (!verifyFollows) delete manifest.checksPending
    await this.clearEnforcement(manifest, true)
  }

  private async verifyNow(manifest: Manifest, requireProbes = false): Promise<{ checks: CheckResult[]; failed: CheckResult[]; configurationOnly: boolean }> {
    const running = (await this.provider(manifest).status(manifest)) === "running"
    this.activity.set(manifest.name, running ? "Running the checks (the live network tests take about 15 to 40 seconds)" : "Checking the configuration")
    const checks = await this.stage(manifest, ["config", "runtime", "probe"], running)
    manifest.lastVerify = { at: new Date().toISOString(), results: checks }; delete manifest.checksPending
    // A stopped sandbox is judged on its configuration alone: the rest was not checked, which is not a failure.
    const checklist = checklistFor(manifest.spec)
    const failed = running ? blockers(checks, checklist, requireProbes) : blockers(checks, checklist).filter((entry) => entry.status === "fail")
    if (failed.length && running) await this.stopBecause(manifest, `Stopped by verify: ${failed.map((entry) => titleOf(entry.id, checklist)).join("; ")}`)
    else await writeManifest(this.dirs, manifest)
    return { checks, failed, configurationOnly: !running }
  }

  private removeAt(): string { return new Date(Date.now() + this.unfinishedKeepMs).toISOString() }

  // A create's start and first verify, which a retry repeats. Whatever fails, the sandbox is left stopped, and its
  // unfinished record says why and when it goes.
  private async firstChecks(manifest: Manifest, requireProbes: boolean): Promise<CheckResult[]> {
    const name = manifest.name
    try {
      if ((await this.provider(manifest).status(manifest)) !== "running") await this.startChecked(manifest, true)
      let verified: Awaited<ReturnType<Core["verifyNow"]>>
      try { verified = await this.verifyNow(manifest, requireProbes) }
      catch (error) {
        // Whatever require-probes says: turning it off accepts an unknown probe, not a run with no verification at all.
        const reason = error instanceof Error ? error.message : String(error)
        try { await this.stopBecause(manifest, `Stopped after creation: its first checks could not finish. ${reason}`) }
        catch (stop) { throw new AsideeError("runtime", `${name} was created, but its first checks could not finish (${reason}), and stopping it failed too (${stop instanceof Error ? stop.message : String(stop)}). The daemon stops it on its next pass, within 30 seconds.`) }
        throw new AsideeError("runtime", `${name} was created but stopped: its first checks could not finish. ${reason}`)
      }
      const { checks, failed } = verified
      if (failed.length) {
        // Only when turning the requirement off would let this create through: a failure beside an unknown probe is a failed check.
        const checklist = checklistFor(manifest.spec)
        const unknown = failed.every((check) => check.status === "unknown" && checklist.find((item) => item.id === check.id)?.stage === "probe")
        if (unknown) throw new AsideeError("probes-required", `${name} was created but stopped: ${failed.map((check) => `${titleOf(check.id, checklist)} (${check.detail})`).join("; ")}. Required isolation probes could not run. Only to allow creation without them: run \`asd config set require-probes off\` on this machine, or turn off Require isolation probes in Settings.`, failed)
        this.refuse(manifest, failed, "was created but stopped")
      }
      return checks
    } catch (error) {
      const unfinished = manifest.unfinished ?? { stage: "checks" as const, reason: "", removeAt: "", done: [] }
      Object.assign(unfinished, { stage: "checks", reason: error instanceof Error ? error.message : String(error), removeAt: this.removeAt() })
      manifest.unfinished = unfinished
      await writeManifest(this.dirs, manifest).catch(() => {})
      const at = `${unfinished.removeAt.slice(0, 16).replace("T", " ")} UTC`
      throw new AsideeError(error instanceof AsideeError ? error.code : "runtime", `${unfinished.reason.replace(/\.?$/, ".")} It is kept for diagnosis until ${at}, then removed. To try again: \`asd create --retry ${name}\`. To remove it now: \`asd remove ${name} --confirm ${name}\`.`,
        error instanceof AsideeError ? error.details : undefined)
    }
  }

  // The rest of a create that did not finish: its start and first checks again if they did not pass, then the setup
  // steps not yet done, which the client runs (core/create-setup.ts) and reports one by one with createStep.
  createRetry(name: string): Promise<{ sandbox: SandboxView; checks?: CheckResult[]; setup?: CreateSetup; remaining: string[] }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      const unfinished = manifest.unfinished
      if (!unfinished) throw new AsideeError("conflict", `${name}'s create finished; there is nothing to retry.`)
      let checks: CheckResult[] | undefined
      if (unfinished.stage === "checks") checks = await this.firstChecks(manifest, (await readConfig(this.dirs)).requireProbes)
      else if ((await this.provider(manifest).status(manifest)) !== "running") await this.startChecked(manifest)
      const remaining = remainingSteps(name, unfinished.setup, unfinished.done).map((step) => step.label)
      if (remaining.length) Object.assign(unfinished, { stage: "setup", reason: "Its setup has not finished.", removeAt: this.removeAt() })
      manifest.unfinished = remaining.length ? unfinished : undefined
      await writeManifest(this.dirs, manifest)
      return { sandbox: await this.view(manifest), ...(checks ? { checks } : {}), ...(unfinished.setup ? { setup: unfinished.setup } : {}), remaining }
    })
  }

  // A client's report of one setup step. Each moves the removal on, and the last one done ends the record.
  createStep(name: string, step: unknown, ok: unknown): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      const unfinished = manifest.unfinished
      if (unfinished?.stage !== "setup") throw new AsideeError("conflict", `${name} has no setup waiting for its steps.`)
      const remaining = remainingSteps(name, unfinished.setup, unfinished.done).map((entry) => entry.label)
      if (typeof step !== "string" || !remaining.includes(step)) throw new AsideeError("usage", `${name}'s setup has no step ${JSON.stringify(step)} left; its steps left are ${remaining.join(", ")}.`)
      if (typeof ok !== "boolean") throw new AsideeError("usage", "ok must be true or false.")
      if (ok) { unfinished.done.push(step); if (unfinished.failed === step) delete unfinished.failed } else unfinished.failed = step
      unfinished.reason = ok ? "Its setup has not finished." : `Its setup step ${step} failed.`
      unfinished.removeAt = this.removeAt()
      if (remaining.length === 1 && ok) delete manifest.unfinished
      await writeManifest(this.dirs, manifest)
      return this.view(manifest)
    })
  }

  // Keeps a sandbox whose create did not finish as it is: it is no longer removed, and its remaining steps are dropped.
  createKeep(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      if (!manifest.unfinished) throw new AsideeError("conflict", `${name}'s create finished; it is kept already.`)
      delete manifest.unfinished
      await writeManifest(this.dirs, manifest)
      return this.view(manifest)
    })
  }

  // warning: said with every GPU container made (GPU_WARNING). visibility: public when another machine asked for it.
  async create(input: Record<string, unknown>, visibility: Visibility = "private"): Promise<{ sandbox: SandboxView; checks: CheckResult[]; hooks: Array<{ extension: string; exitCode: number; output: string }>; warning?: string }> {
    const config = await readConfig(this.dirs)
    const spec = validSpec(input, config.defaults)
    const setup = validSetup(spec.name, input.setup)
    // A folder to copy in that cannot be copied is refused now, not after the sandbox is made: the same checks as the copy.
    for (const value of setup?.copy ?? []) {
      const { source } = copyFlag(value)
      await homeFolder(source).catch((error: Error) => { throw new AsideeError(error instanceof AsideeError ? error.code : "usage", `Cannot copy ${source} in: ${error.message} Nothing was created.`) })
    }
    const { manifest, checks } = await this.exclusive(spec.name, async () => {
      if ((await listManifests(this.dirs)).some((entry) => entry.name === spec.name)) throw new AsideeError("conflict", `A sandbox named ${spec.name} already exists.`)
      const engines = await this.engines()
      const wanted = typeof input.engine === "string" && input.engine ? input.engine : config.engine
      const engine = wanted ? engines.find((entry) => entry.id === wanted) : engines.find((entry) => entry.ready && (!spec.gpu || entry.capabilities?.gpu)) ?? engines.find((entry) => entry.ready)
      if (!engine) throw new AsideeError("dependency", wanted ? `There is no engine ${wanted}. Run \`asd doctor\`.` : "No engine is ready for sandboxes. Run `asd doctor` to see what each one needs.")
      if (!engine.ready) throw new AsideeError("dependency", `${engine.label} is not ready: ${engine.problems.join(" ")} ${engine.fix ?? ""}`.trim())
      if (spec.docker && !engine.capabilities?.docker) throw new AsideeError("dependency", `${engine.label} cannot run Docker inside a sandbox. Choose an engine with the docker capability (gVisor needs --net-raw and --overlay2=none).`)
      if (spec.gpu && !engine.capabilities?.gpu) throw new AsideeError("dependency", `${engine.label} cannot make a GPU container: Docker there lists no NVIDIA GPU (no nvidia.com/gpu CDI device and no nvidia runtime). It needs Linux with an NVIDIA GPU and the NVIDIA Container Toolkit.`)
      // Written before the engine is touched, so a half-made sandbox can always be removed, and is unfinished until its
      // checks pass: one left by a daemon that ended mid-create goes too.
      const manifest: Manifest = { version: 1, name: spec.name, id: randomBytes(16).toString("hex"), engine, spec, createdAt: new Date().toISOString(), visibility,
        unfinished: { stage: "checks", reason: "It was being created.", removeAt: this.removeAt(), ...(setup ? { setup } : {}), done: [] } }
      const provider = this.provider(manifest)
      const createContainer = async () => {
        try { await provider.create(manifest) }
        catch (error) {
          const reason = (error instanceof Error ? error.message : String(error)).replace(/[.\s]+$/, "")
          try {
            if (await provider.status(manifest) !== "missing") throw new Error("the container exists and is kept for inspection")
            await provider.remove(manifest, true)
            if (await provider.status(manifest) !== "missing") throw new Error("the container remains after cleanup")
            await deleteManifest(this.dirs, spec.name)
          } catch (cleanup) {
            throw new AsideeError("runtime", `${reason}. Cleanup incomplete: the record for ${spec.name} is kept; ${cleanup instanceof Error ? cleanup.message : String(cleanup)}. Run \`asd remove ${spec.name} --confirm ${spec.name}\` to remove what remains.`)
          }
          throw new AsideeError(error instanceof AsideeError ? error.code : "runtime", `${reason}. Nothing was kept for ${spec.name}.`)
        }
      }
      if (spec.template) {
        // Held until the container exists: from then on a removal of the template leaves its image to this sandbox.
        await this.exclusive(`template:${spec.template}`, async () => {
          const template = (await provider.templates(engine)).find((entry) => entry.name === spec.template)
          const fromDefault = input.template === undefined || input.template === ""
          if (!template) throw new AsideeError("not-found", `There is no template named ${spec.template} on ${engine.label}. ${fromDefault ? `It is the default template for new sandboxes: make it with \`asd template prepare ${spec.template}\`, give --image, or clear the default with \`asd config set default-template auto\`.` : "See `asd template list`."}`)
          spec.image = template.imageId
          manifest.template = { name: template.name, imageId: template.imageId, source: template.source, createdAt: template.createdAt }
          await writeManifest(this.dirs, manifest)
          this.activity.set(spec.name, `Creating from template ${template.name}`)
          await createContainer()
        })
      } else {
        await writeManifest(this.dirs, manifest)
        this.activity.set(spec.name, `Creating (downloading ${spec.image} if it is not here yet)`)
        await createContainer()
      }
      const checks = await this.firstChecks(manifest, config.requireProbes)
      if (setup) manifest.unfinished = { stage: "setup", reason: "Its setup has not finished.", removeAt: this.removeAt(), setup, done: [] }
      else delete manifest.unfinished
      await writeManifest(this.dirs, manifest)
      return { manifest, checks }
    })
    // Hooks run once the sandbox is free again, so a hook may use any command on it (verify, stop, start).
    const hooks = []
    for (const extension of (await loadExtensions(this.dirs)).extensions) {
      if (!extension.hooks.postCreate) continue
      this.activity.set(spec.name, `Running ${extension.name}'s setup`)
      const output = await runCommand(this.run, extension, extension.hooks.postCreate, { ASIDEE_SANDBOX: spec.name }, this.cliDir).finally(() => this.activity.delete(spec.name))
      hooks.push({ extension: extension.id, exitCode: output.exitCode, output: `${output.stdout}${output.stderr}`.trim() })
    }
    return { sandbox: await this.get(spec.name).catch(() => this.view(manifest)), checks, hooks, ...(spec.gpu ? { warning: GPU_WARNING } : {}) }
  }

  // Its links open once it runs, outside its lock: opening one touches the sandbox at its other end too. Then each
  // extension's postStart hook runs, as postCreate's do after a create; a hook that fails does not fail the start.
  async start(name: string): Promise<SandboxView> {
    const sandbox = await this.startOnly(name)
    await this.links.sync(name).catch(() => {})
    for (const extension of (await loadExtensions(this.dirs).catch(() => ({ extensions: [] }))).extensions) {
      if (!extension.hooks.postStart) continue
      this.activity.set(name, `Running ${extension.name}'s start step`)
      await runCommand(this.run, extension, extension.hooks.postStart, { ASIDEE_SANDBOX: name }, this.cliDir).catch(() => {}).finally(() => this.activity.delete(name))
    }
    return sandbox
  }

  private startOnly(name: string): Promise<SandboxView> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name)
      await this.startChecked(manifest)
      const sandbox = await this.view(manifest)
      this.startedOver.delete(name)
      if (manifest.engine.capabilities?.diskLimit === "watched") {
        const usedBytes = await this.measureDisk(manifest)
        const limitBytes = manifest.spec.diskGb * 1024 ** 3
        if (usedBytes !== undefined && usedBytes > limitBytes) {
          this.startedOver.set(name, Date.now())
          sandbox.diskWarning = { usedBytes, limitBytes,
            message: `${name} uses ${(usedBytes / 1024 ** 3).toFixed(2)} GB of its ${manifest.spec.diskGb} GB disk limit. It will be stopped again within about 30 seconds unless space is freed or the disk is resized. Run \`asd exec ${name} -- …\` to free space, or \`asd resize ${name} --disk N\` to raise the limit.` }
        }
      }
      return sandbox
    })
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
      if (confirm !== name) throw new AsideeError("usage", `Removing ${name} deletes everything in it.${typeof confirm === "string" && confirm ? ` --confirm ${confirm} does not match ${name}; nothing was removed.` : ""} To confirm: \`asd remove ${name} --confirm ${name}\`.`)
      await this.removeNow(manifest)
      return { removed: name }
    })
  }

  private async removeNow(manifest: Manifest): Promise<void> {
    const name = manifest.name
    this.activity.set(name, "Removing")
    this.endSessions(name, `The session ended: ${name} was removed.`)
    await this.provider(manifest).remove(manifest); await deleteManifest(this.dirs, name)
    this.diskSeen.delete(name); this.cpuSeen.delete(name)
    await this.links.forget(manifest).catch(() => {})
    this.enforcementProblems.delete(name); this.unchecked.delete(name)
    if (manifest.ssh) await writeClientFiles(this.dirs, await listManifests(this.dirs))
  }

  // CPUs, memory and the task limit are set in the engine, and the manifest follows once it accepted them. For a running
  // sandbox a limit counts as applied now only when the engine's host reports it back; the disk limit is the daemon's
  // own number, which its next watch pass (within 30 seconds) uses.
  resize(name: string, input: Record<string, unknown>): Promise<{ sandbox: SandboxView; changes: ResizeChange[]; checks: CheckResult[] }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest); const before = manifest.spec
      const keys = ["cpus", "memoryGb", "pids", "diskGb"] as const
      if (!keys.some((key) => input[key] !== undefined && input[key] !== null && input[key] !== "")) throw new AsideeError("usage", "Give at least one of --cpus, --memory, --pids and --disk.")
      const next = validSizes(input, before)
      if (manifest.engine.capabilities?.resize === "none") throw new AsideeError("dependency", `${manifest.engine.label} cannot change a sandbox's limits.`)
      const status = await provider.status(manifest)
      if (status === "missing") throw new AsideeError("not-found", `${name} has no container on ${manifest.engine.label}.`)
      this.activity.set(name, "Resizing")
      const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`
      if (status === "running" && (next.memoryGb < before.memoryGb || next.pids < before.pids)) {
        const use = await provider.usage(manifest).catch(() => undefined)
        if (!use) throw new AsideeError("conflict", `What ${name} uses now could not be read, so its limits were not lowered while it runs. Stop it and resize again; the new limits then apply at its next start.`)
        const memory = Math.round(next.memoryGb * 1024) * 1024 ** 2
        if (next.memoryGb < before.memoryGb && use.memoryBytes >= memory * SHRINK_HEADROOM)
          throw new AsideeError("conflict", `${name} uses ${gb(use.memoryBytes)} of memory now; a limit of ${next.memoryGb} GB would leave it under ${Math.round((1 - SHRINK_HEADROOM) * 100)}% headroom, and the engine kills a sandbox that passes its limit. Nothing was changed. Free memory inside it, or stop it first.`)
        if (next.pids < before.pids && use.tasks >= next.pids * SHRINK_HEADROOM)
          throw new AsideeError("conflict", `${name} runs ${use.tasks} tasks now (gVisor's own threads count); a limit of ${next.pids} would leave it under ${Math.round((1 - SHRINK_HEADROOM) * 100)}% headroom, and a gVisor sandbox that passes it ends. Nothing was changed.`)
      }
      if (next.diskGb < before.diskGb && manifest.engine.capabilities?.diskLimit !== "none") {
        const used = await this.measureDisk(manifest)
        if (used === undefined) throw new AsideeError("conflict", `${name}'s disk use could not be measured, so its disk limit was not lowered. Nothing was changed.`)
        if (used > next.diskGb * 1024 ** 3) throw new AsideeError("conflict", `${name} uses ${gb(used)} of disk, more than ${next.diskGb} GB; the watch would stop it at once. Nothing was changed.`)
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
      const checklist = checklistFor(manifest.spec)
      const checks = (await this.stage(manifest, ["config"], status === "running")).filter((check) => checklist.find((item) => item.id === check.id)?.stage === "config")
      const failed = blockers(checks, checklist)
      if (failed.length && status === "running") await this.stopBecause(manifest, `Stopped after a resize: ${failed.map((entry) => `${titleOf(entry.id, checklist)} (${entry.detail})`).join("; ")}`)
      return { sandbox: await this.view(manifest), changes, checks }
    })
  }

  // The sandbox stays locked while its template is made, and a running one is paused for the moment its files are saved.
  async snapshot(name: string, as: unknown): Promise<{ template: Template; contents: string }> {
    const templateName = validTemplateName(as)
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.spec.gpu) throw new AsideeError("usage", `${name} is a GPU container, and templates are made from sandboxes only for now: a template from a GPU container's files has not been measured.`)
      if (manifest.engine.capabilities?.snapshot === false) throw new AsideeError("dependency", `${manifest.engine.label} cannot make templates: its gVisor runtime lacks --overlay2=none, so the engine does not see a sandbox's files.`)
      if ((await provider.status(manifest)) === "missing") throw new AsideeError("not-found", `${name} has no container on ${manifest.engine.label}.`)
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
      if (!found.length) throw new AsideeError("not-found", `There is no template named ${templateName}. See \`asd template list\`.`)
      if (found.length > 1) throw new AsideeError("usage", `Templates named ${templateName} are on ${found.map((entry) => entry.engine.id).join(" and ")}. Choose one with --engine.`)
      const removed = await found[0]!.provider.removeTemplate(found[0]!.engine, templateName)
      return { removed: templateName, ...removed, note: removed.dependants.length
        ? `Sandboxes made from it keep working (they run, stop and start as before): ${removed.dependants.join(", ")}. Its image is deleted when the last of them is removed.`
        : "Its image was deleted." }
    })
  }

  verify(name: string): Promise<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean; configurationOnly: boolean; diskUsedBytes?: number }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const { checks, failed, configurationOnly } = await this.verifyNow(manifest)
      return { sandbox: await this.view(manifest), checks, ok: failed.length === 0, configurationOnly, diskUsedBytes: await this.measureDisk(manifest) }
    })
  }

  async exec(name: string, argv: unknown, options: { user?: string; stdin?: string | Uint8Array; signal?: AbortSignal } = {}): Promise<RunResult> {
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) throw new AsideeError("usage", "exec needs a command.")
    if (options.user !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/.test(options.user)) throw new AsideeError("usage", "The user must be a user name or id.")
    const manifest = await readManifest(this.dirs, name)
    gpuUser(manifest, options.user)
    const result = await this.provider(manifest).exec(manifest, argv as string[], options)
    if (result.overflow) throw new AsideeError("runtime", `The command printed more than ${OUTPUT_LIMIT / 1024 ** 2} MiB on ${result.overflow}, the most one exec may return, so Asidee stopped reading and discarded its output. ${result.stderr} Write large output to a file inside the sandbox and read it in parts.`.replace(/  +/g, " "))
    return result
  }

  // A session on the stream socket. It never starts a sandbox: a client that reconnects on its own (an editor) must not
  // undo a stop.
  async openSession(request: OpenRequest): Promise<Session> {
    if (request.kind === "workspace") throw new AsideeError("usage", "Use the workspace session handler.")
    const manifest = await readManifest(this.dirs, request.name); const provider = this.provider(manifest)
    if (request.machineId !== undefined && request.machineId !== this.machineId) throw new AsideeError("identity-changed", "The session names another machine.")
    // A session that names this machine's identity came through machine routing: another machine asked for it.
    if (request.machineId !== undefined && visibilityOf(manifest) === "private") throw new AsideeError("not-found", privateThere(manifest.name))
    if (request.sandboxId !== undefined && request.sandboxId !== manifest.id) throw new AsideeError("identity-changed", "The sandbox was recreated; open a new session or forward explicitly.")
    if (request.generation !== undefined && request.generation !== await provider.generation(manifest)) throw new AsideeError("conflict", "The sandbox's run changed; open a new forward explicitly.")
    if (manifest.engine.capabilities?.execStream === false) throw new AsideeError("dependency", `${manifest.engine.label} cannot relay a session's bytes.`)
    if ((await provider.status(manifest)) !== "running") throw new AsideeError("conflict", `${request.name} is not running. Start it with \`asd start ${request.name}\`.`)
    if (request.kind === "lease") {
      if (this.leases.has(request.leaseId)) throw new AsideeError("conflict", "This relay lease already exists.")
      if (manifest.engine.capabilities?.loopbackRelay === false) throw new AsideeError("dependency", "This engine cannot relay sandbox loopback.")
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
      if (!lease || lease.name !== manifest.name || lease.sandboxId !== manifest.id || lease.generation !== request.generation || lease.port !== request.port) throw new AsideeError("conflict", "The forward lease is no longer open for this run and port.")
      const session = await provider.dialLoopback(manifest, request.port)
      if (this.leases.get(request.leaseId) !== lease) { session.close(); throw new AsideeError("conflict", "The forward lease ended while connecting.") }
      lease.dials.add(session); session.on("end", () => lease.dials.delete(session)); this.trackSession(manifest.name, session)
      return session
    }
    // sshd in inetd mode serves this one connection; -e sends its complaints to the client's stderr.
    if (request.kind === "ssh" && !manifest.ssh) throw new AsideeError("conflict", `SSH is not set up for ${request.name}. Run \`asd ssh setup ${request.name}\`.`)
    if (request.kind === "exec") gpuUser(manifest, request.user)
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
    if (!generation) throw new AsideeError("conflict", `${manifest.name} is not running. Start it with \`asd start ${manifest.name}\`.`)
    return { name: manifest.name, machineId: this.machineId, sandboxId: manifest.id, generation }
  }

  closeSessions(): void {
    for (const name of new Set([...this.sessions.keys(), ...[...this.forwards.values()].map((forward) => forward.view.name)])) this.endSessions(name, "The session ended: the Asidee daemon stopped.")
    this.links.close()
  }

  // A listener on 127.0.0.1 only, bound once, for this run of the sandbox. Each connection is relayed to the same port on
  // the sandbox's own loopback, after checking that the run it was made for is still the one running.
  async forwardAdd(name: string, port: unknown, localPort?: unknown): Promise<ForwardView> {
    const target = validPort(port, "The port"); const local = localPort === undefined || localPort === null || localPort === "" ? undefined : validPort(localPort, "The local port")
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.engine.capabilities?.loopbackRelay === false) throw new AsideeError("dependency", `${manifest.engine.label} cannot relay a connection into a sandbox.`)
      const generation = await provider.generation(manifest)
      if (!generation) throw new AsideeError("conflict", `${name} is not running. Start it with \`asd start ${name}\`, then add the forward.`)
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
    if (typeof id !== "string" || !this.forwards.has(id)) throw new AsideeError("not-found", `There is no forward ${String(id)}. See \`asd forward list\`.`)
    this.endForward(id, "The forward was removed.")
    return { closed: id }
  }

  // A disclosure, from the listeners themselves: any process on this machine can connect to a loopback port.
  private forwardCheck(manifest: Manifest): CheckResult {
    const mine = [...this.forwards.values()].filter((forward) => forward.view.sandboxId === manifest.id)
    const leases = [...this.leases.entries()].filter(([, lease]) => lease.sandboxId === manifest.id)
    if (leases.length) return { id: "forwards", status: "info", evidence: "inspected", detail: `${leases.map(([id, lease]) => `SSH lease ${id} to sandbox loopback port ${lease.port}`).join(", ")}. This daemon checked the sandbox run and port. The primary's loopback listener address and current reachability are unknown here; \`asd --host HOST forward list\` on the primary shows its listener. The lease ends with its control stream or sandbox run, or ${this.leaseTtlMs / 1000} seconds after the primary last renewed it.` }
    if (!mine.length) return { id: "forwards", status: "info", evidence: "inspected", detail: "None. A forward added with `asd forward add` listens on 127.0.0.1 only and ends when the sandbox stops." }
    const listed = mine.map((forward) => { const address = forward.server.address(); return `${typeof address === "object" && address ? `${address.address}:${address.port}` : "not listening"} to port ${forward.view.port} (${forward.view.id})` })
    return { id: "forwards", status: "info", evidence: "inspected", detail: `${listed.join(", ")}. ${FORWARD_REACH}` }
  }

  // Prepares sshd inside, trusts only this machine's editor key there, and writes the alias and its host key here. Run
  // again, it makes a new host key; the old one stops being trusted.
  sshSetup(name: string, writeConfig = false, publicKey?: string): Promise<SshAccess & { config: string; include: string; included: boolean; editorKey: string; keyFile: string; sandboxId: string; setup: SshSetup }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.spec.gpu) throw new AsideeError("usage", `${name} is a GPU container, where sshd cannot switch to its user: no process there has the capabilities to. Use \`asd shell ${name}\`.`)
      if (manifest.engine.capabilities?.execStream === false) throw new AsideeError("dependency", `${manifest.engine.label} cannot relay a session's bytes, which SSH needs.`)
      if ((await provider.status(manifest)) !== "running") throw new AsideeError("conflict", `${name} is not running. Start it with \`asd start ${name}\`, then set up SSH.`)
      if (publicKey !== undefined && !validPublicKey(publicKey)) throw new AsideeError("usage", "SSH preparation needs an Ed25519 public key.")
      const key = publicKey === undefined ? await editorKey(this.dirs) : { path: "", publicKey, fingerprint: keyFingerprint(publicKey) }
      this.activity.set(name, "Preparing SSH")
      try {
        const who = await provider.exec(manifest, ["id", "-un"])
        const user = who.stdout.trim()
        if (who.exitCode !== 0 || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new AsideeError("runtime", `Could not tell which user exec runs as in ${name}: ${who.stderr.trim() || user}`)
        const done = await provider.exec(manifest, ["sh", "-c", GUEST_SETUP, "sh", user, key.publicKey], { user: "0" })
        if (done.exitCode !== 0) throw new AsideeError(done.exitCode === 4 ? "dependency" : "runtime", `Could not prepare sshd in ${name}: ${done.stderr.trim().split("\n").slice(-3).join(" ")}`)
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
    if (!manifest.ssh) return { id: "ssh", status: "info", evidence: "inspected", detail: "Not set up. `asd ssh setup` opens no port; it reaches sshd through the daemon." }
    return { id: "ssh", status: "info", evidence: "inspected", detail: `Set up ${manifest.ssh.at.slice(0, 10)} for ${manifest.ssh.user} (${manifest.ssh.home}) with ${manifest.ssh.editorKeyOrigin === "client" ? "the requesting client's editor public key" : "this machine's editor key"} ${manifest.ssh.editorKey}, ${manifest.ssh.editorKeyOrigin === "client" ? "whose private half is not installed by this daemon" : "kept in Asidee's state folder"}. Anything that can read that private key can log in as ${manifest.ssh.user} and forward to the sandbox's loopback; no agent forwarding, no other key.${manifest.ssh.unlocked ? ` Setup replaced ${manifest.ssh.user}'s locked password with * (still no password) because sshd refuses a locked account.` : ""}` }
  }

  async extensions() {
    const loaded = await loadExtensions(this.dirs)
    return { ...loaded, available: availableExtensions(loaded.extensions) }
  }
  installExtension(id: unknown) { return installExtension(this.dirs, id) }
  removeExtension(id: unknown) { return removeExtension(this.dirs, id) }

  // An installed extension's action. host: a registered machine whose sandbox it is for; this machine's extension runs
  // here with ASIDEE_HOST set, so the asd commands it runs act on that machine (the daemon checked the sandbox there).
  async actionFor(extensionId: unknown, actionId: unknown, host?: string) {
    const extension = (await loadExtensions(this.dirs)).extensions.find((entry) => entry.id === extensionId)
    const action = extension?.actions.find((entry) => entry.id === actionId)
    if (!extension || !action) throw new AsideeError("not-found", `There is no action ${String(actionId)} in an extension ${String(extensionId)}.`)
    if (host === undefined) return { extension, action }
    if (action.scope !== "sandbox") throw new AsideeError("usage", `${extension.name}'s ${action.label} acts on this machine, not on a sandbox, so it takes no other machine.`)
    return { extension, action }
  }
  async runAction(extensionId: unknown, actionId: unknown, sandbox: unknown, values: unknown, host?: string): Promise<RunResult> {
    const { extension, action } = await this.actionFor(extensionId, actionId, host)
    const env = fieldValues(action, (values ?? {}) as Record<string, unknown>)
    if (host !== undefined) Object.assign(env, { ASIDEE_SANDBOX: validName(sandbox), ASIDEE_HOST: host })
    else if (action.scope === "sandbox") env.ASIDEE_SANDBOX = (await readManifest(this.dirs, validName(sandbox))).name
    return runCommand(this.run, extension, action.run, env, this.cliDir)
  }

  // Called on a timer by the daemon, for every running sandbox: repeats the checks that are cheap (configuration, the
  // guard rules, the kernel) and measures disk use. A sandbox that fails one, or passed its watched disk limit, is
  // stopped. This is what catches a guard that was flushed, a container started behind Asidee's back, or an engine
  // whose runtime was reconfigured, without waiting for someone to run verify.
  async enforce(): Promise<void> {
    for (const listed of await listManifests(this.dirs)) {
      await this.exclusive(listed.name, async () => {
        const manifest = await readManifest(this.dirs, listed.name)
        let stoppingFor: string | undefined
        try {
          const provider = this.provider(manifest)
          // A create that did not finish goes once its time is up, but not from under an open shell or forward.
          const unfinished = manifest.unfinished
          if (unfinished && Date.parse(unfinished.removeAt) <= Date.now() && !this.sessions.get(manifest.name)?.size && ![...this.forwards.values()].some((forward) => forward.view.name === manifest.name)) {
            try { return await this.removeNow(manifest) } catch (error) { throw new Error(`Removing it, since its create did not finish by ${unfinished.removeAt}, failed: ${(error as Error).message}`) }
          }
          if ((await provider.status(manifest)) !== "running") {
            this.unchecked.delete(manifest.name)
            const pending = manifest.checksPending !== undefined; delete manifest.checksPending
            return await this.clearEnforcement(manifest, pending)
          }
          // Started by a daemon that ended before its checks finished (this daemon's own starts hold the sandbox's lock
          // until theirs do). It is stopped rather than checked now: a check can fail to finish too.
          if (manifest.checksPending) {
            stoppingFor = `it was started at ${manifest.checksPending}, but its checks never finished: the daemon that started it ended first.`
            await this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString()}: ${stoppingFor} It is kept for diagnosis. Start it and run \`asd verify ${manifest.name}\`, or remove it and create it again.`)
            this.unchecked.delete(manifest.name); return
          }
          const results = await this.stage(manifest, ["config", "runtime"], true)
          const checklist = checklistFor(manifest.spec)
          const describe = (entries: CheckResult[]) => entries.map((entry) => `${titleOf(entry.id, checklist)} (${entry.detail})`).join("; ")
          const failed = failures(results, checklist)
          if (failed.length) {
            stoppingFor = `Blocking checks did not hold: ${describe(failed)}`
            await this.recordEnforcement(manifest, stoppingFor)
            await this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString()}: ${describe(failed)}`)
            this.unchecked.delete(manifest.name); return
          }
          const blind = blockers(results, checklist); const problems = blind.length ? [`Could not check ${describe(blind)}`] : []
          if (manifest.engine.capabilities?.diskLimit === "watched") {
            const used = await this.measureDisk(manifest)
            if (used === undefined) problems.push("Disk use could not be measured; the watched disk limit is unknown.")
            else if (used > manifest.spec.diskGb * 1024 ** 3 && !this.recovering(manifest.name)) {
              const reason = overDisk(manifest, used)
              stoppingFor = reason
              await this.recordEnforcement(manifest, reason); await this.stopBecause(manifest, reason)
              this.unchecked.delete(manifest.name); return
            }
          }
          if (problems.length) return await this.enforcementUnknown(manifest, problems.join("; "))
          this.unchecked.delete(manifest.name)
          await this.clearEnforcement(manifest)
        } catch (error) {
          await this.enforcementUnknown(manifest, `Enforcement could not be completed: ${(error as Error).message}${stoppingFor ? `; ${stoppingFor}` : ""}`)
        }
      }).catch((error) => { this.enforcementProblems.set(listed.name, { at: new Date().toISOString(), message: `Enforcement could not read its state: ${(error as Error).message}` }) })
    }
    // Then links: a sandbox that started behind Asidee's back, or a daemon that just started, opens them again here.
    await this.links.sync().catch(() => {})
  }

  // Called by the daemon between enforcement passes, so a sandbox past its watched disk limit is stopped sooner than
  // the next pass. It only ever stops one that measured over: a measurement that fails is left to `enforce`, which
  // counts it. Measured without the sandbox's lock, so a long operation on one sandbox does not hold up the others;
  // one found over is measured again under the lock before it is stopped.
  async watchDisk(): Promise<void> {
    for (const listed of await listManifests(this.dirs)) {
      if (listed.engine.capabilities?.diskLimit !== "watched") continue
      try {
        const over = async (manifest: Manifest) => {
          if ((await this.provider(manifest).status(manifest)) !== "running") return undefined
          const used = await this.measureDisk(manifest)
          if (used === undefined) return undefined
          const isOver = used > manifest.spec.diskGb * 1024 ** 3
          // Asked again under the lock: a start that was running during the first measurement may have set it since.
          // The window ends early once the sandbox measures under its limit.
          if (isOver && this.recovering(manifest.name)) return undefined
          this.startedOver.delete(manifest.name)
          return isOver ? used : undefined
        }
        if (await over(listed) === undefined) continue
        await this.exclusive(listed.name, async () => {
          const manifest = await readManifest(this.dirs, listed.name)
          const used = manifest.id === listed.id ? await over(manifest) : undefined
          if (used === undefined) return
          const reason = overDisk(manifest, used)
          await this.recordEnforcement(manifest, reason); await this.stopBecause(manifest, reason)
        })
      } catch { /* `enforce` reports what cannot be read or measured. */ }
    }
  }

  private async recordEnforcement(manifest: Manifest, message: string): Promise<void> {
    const problem = { at: new Date().toISOString(), message }
    manifest.enforcementProblem = problem; this.enforcementProblems.set(manifest.name, problem)
    try { await writeManifest(this.dirs, manifest) } catch (error) { problem.message += `; could not save this warning: ${(error as Error).message}` }
  }

  // changed: the caller altered the manifest too, so it is written even without a problem to clear.
  private async clearEnforcement(manifest: Manifest, changed = false): Promise<void> {
    this.enforcementProblems.delete(manifest.name)
    if (manifest.enforcementProblem) { delete manifest.enforcementProblem; changed = true }
    if (changed) await writeManifest(this.dirs, manifest)
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
