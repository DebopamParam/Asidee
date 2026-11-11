import { randomBytes } from "node:crypto"
import type { Server } from "node:net"
import { blockers, complete, failures, titleOf } from "./checks"
import { fieldValues, loadExtensions, runCommand } from "./extensions"
import { boundPort, listenLoopback, relay, validPort, type ForwardView } from "./forwards"
import { OUTPUT_LIMIT } from "./run"
import { addInclude, alias, editorKey, GUEST_SETUP, GUEST_SSH, includeLine, included, parseGuestSetup, userConfig, writeClientFiles, type SshAccess } from "./ssh"
import { deleteManifest, listManifests, readConfig, readManifest, scanManifests, validName, validSpec, writeManifest, type Dirs } from "./state"
import type { OpenRequest } from "./stream"
import { PaddockError, type CheckResult, type Engine, type Manifest, type Provider, type RunResult, type Runner, type Session, type Stage } from "./types"

// A running sandbox is stopped when a blocking check could not be made this many timer passes in a row.
export const UNCHECKED_PASSES = 4
// Checks the core answers from what it holds itself; a provider's answer for them is ignored.
const CORE_CHECKS = new Set<CheckResult["id"]>(["forwards", "ssh"])

export type SandboxView = {
  // damaged: its state file cannot be read; stopReason says what is wrong with it.
  name: string; status: "running" | "stopped" | "missing" | "damaged"; engine: string; spec: Manifest["spec"]; createdAt: string
  capabilities?: Engine["capabilities"]; lastVerify?: Manifest["lastVerify"]; stopReason?: string
  // What a long operation on it is doing right now.
  activity?: string
}

// Every operation on a sandbox. The rule it keeps: a sandbox runs only while no blocking check fails. Checks that need
// only configuration run before a start, the rest right after it, and `enforce` repeats the cheap ones on a timer.
export class Core {
  private readonly locks = new Map<string, Promise<unknown>>()
  private readonly activity = new Map<string, string>()
  // Passes in a row in which a blocking check of a running sandbox could not be made.
  private readonly unchecked = new Map<string, number>()
  // Open sessions per sandbox name, closed when it stops or is removed.
  private readonly sessions = new Map<string, Set<Session>>()
  // Forwards by id. They live in this daemon only: a stop, restart or removal of their sandbox, or the daemon's exit,
  // ends them, and nothing brings one back.
  private readonly forwards = new Map<string, { view: Omit<ForwardView, "connections">; server: Server; connections: Set<Session>; watch: ReturnType<typeof setInterval> }>()
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
    let stopReason = manifest.stopReason
    try {
      status = await this.provider(manifest).status(manifest)
      // Paddock did not stop it, so ask the engine why it is not running.
      if (status === "stopped" && !stopReason) stopReason = await this.provider(manifest).stoppedWhy(manifest)
    } catch (error) { if (error instanceof PaddockError && error.code === "conflict") stopReason = error.message }
    return { name: manifest.name, status, engine: manifest.engine.label, spec: manifest.spec, createdAt: manifest.createdAt, capabilities: manifest.engine.capabilities,
      lastVerify: manifest.lastVerify, stopReason, activity: this.activity.get(manifest.name) }
  }

  async list(): Promise<SandboxView[]> {
    const { manifests, damaged } = await scanManifests(this.dirs)
    return [...await Promise.all(manifests.map((manifest) => this.view(manifest))),
      ...damaged.map((entry): SandboxView => ({ name: entry.name, status: "damaged", engine: "", spec: { name: entry.name, image: "", cpus: 0, memoryGb: 0, pids: 0, diskGb: 0, docker: false }, createdAt: "",
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
      await writeManifest(this.dirs, manifest)
      this.activity.set(spec.name, `Creating (downloading ${spec.image} if it is not here yet)`)
      await this.provider(manifest).create(manifest)
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
      if (manifest.ssh) await writeClientFiles(this.dirs, await listManifests(this.dirs))
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
    const result = await this.provider(manifest).exec(manifest, argv as string[], options)
    if (result.overflow) throw new PaddockError("runtime", `The command printed more than ${OUTPUT_LIMIT / 1024 ** 2} MiB on ${result.overflow}, the most one exec may return, so Paddock stopped reading and discarded its output. ${result.stderr} Write large output to a file inside the sandbox and read it in parts.`.replace(/  +/g, " "))
    return result
  }

  // A session on the stream socket. It never starts a sandbox: a client that reconnects on its own (an editor) must not
  // undo a stop.
  async openSession(request: OpenRequest): Promise<Session> {
    const manifest = await readManifest(this.dirs, request.name); const provider = this.provider(manifest)
    if (manifest.engine.capabilities?.execStream === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot relay a session's bytes.`)
    if ((await provider.status(manifest)) !== "running") throw new PaddockError("conflict", `${request.name} is not running. Start it with \`paddock start ${request.name}\`.`)
    // sshd in inetd mode serves this one connection; -e sends its complaints to the client's stderr.
    if (request.kind === "ssh" && !manifest.ssh) throw new PaddockError("conflict", `SSH is not set up for ${request.name}. Run \`paddock ssh setup ${request.name}\`.`)
    const session = request.kind === "ssh" ? await provider.openExec(manifest, [manifest.ssh!.sshd, "-i", "-e", "-f", `${GUEST_SSH}/sshd_config`], { user: "0", tty: false })
      : await provider.openExec(manifest, request.argv, request)
    const open = this.sessions.get(request.name) ?? new Set<Session>()
    this.sessions.set(request.name, open.add(session))
    session.on("end", () => open.delete(session))
    return session
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
    if (!mine.length) return { id: "forwards", status: "info", evidence: "inspected", detail: "None. A forward added with `paddock forward add` listens on 127.0.0.1 only and ends when the sandbox stops." }
    const listed = mine.map((forward) => { const address = forward.server.address(); return `${typeof address === "object" && address ? `${address.address}:${address.port}` : "not listening"} to port ${forward.view.port} (${forward.view.id})` })
    return { id: "forwards", status: "info", evidence: "inspected", detail: `${listed.join(", ")}. Any process on this machine can connect to these, and so can whatever the engine relays to its loopback: on OrbStack, the engine's host and its other containers, through host.docker.internal.` }
  }

  // Prepares sshd inside, trusts only this machine's editor key there, and writes the alias and its host key here. Run
  // again, it makes a new host key; the old one stops being trusted.
  sshSetup(name: string, writeConfig = false): Promise<SshAccess & { config: string; include: string; included: boolean; editorKey: string; keyFile: string }> {
    return this.exclusive(validName(name), async () => {
      const manifest = await readManifest(this.dirs, name); const provider = this.provider(manifest)
      if (manifest.engine.capabilities?.execStream === false) throw new PaddockError("dependency", `${manifest.engine.label} cannot relay a session's bytes, which SSH needs.`)
      if ((await provider.status(manifest)) !== "running") throw new PaddockError("conflict", `${name} is not running. Start it with \`paddock start ${name}\`, then set up SSH.`)
      const key = await editorKey(this.dirs)
      this.activity.set(name, "Preparing SSH")
      try {
        const who = await provider.exec(manifest, ["id", "-un"])
        const user = who.stdout.trim()
        if (who.exitCode !== 0 || !/^[a-z_][a-z0-9_.-]{0,31}$/i.test(user)) throw new PaddockError("runtime", `Could not tell which user exec runs as in ${name}: ${who.stderr.trim() || user}`)
        const done = await provider.exec(manifest, ["sh", "-c", GUEST_SETUP, "sh", user, key.publicKey], { user: "0" })
        if (done.exitCode !== 0) throw new PaddockError(done.exitCode === 4 ? "dependency" : "runtime", `Could not prepare sshd in ${name}: ${done.stderr.trim().split("\n").slice(-3).join(" ")}`)
        // A second setup finds the password already unlocked; the first one's word for it is kept.
        const guest = parseGuestSetup(done.stdout)
        manifest.ssh = { user, ...guest, unlocked: guest.unlocked || Boolean(manifest.ssh?.unlocked), editorKey: key.fingerprint, at: new Date().toISOString() }
        await writeManifest(this.dirs, manifest)
        await writeClientFiles(this.dirs, await listManifests(this.dirs))
      } finally { this.activity.delete(name) }
      if (writeConfig) await addInclude(this.dirs)
      return { ...await this.sshAccessOf(manifest), config: userConfig(), include: includeLine(this.dirs), included: await included(this.dirs), editorKey: key.fingerprint, keyFile: key.path }
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
    return { id: "ssh", status: "info", evidence: "inspected", detail: `Set up ${manifest.ssh.at.slice(0, 10)} for ${manifest.ssh.user} (${manifest.ssh.home}) with this machine's editor key ${manifest.ssh.editorKey}, kept in Paddock's state folder. Anything that can read that key can log in as ${manifest.ssh.user} and forward to the sandbox's loopback; no agent forwarding, no other key.${manifest.ssh.unlocked ? ` Setup replaced ${manifest.ssh.user}'s locked password with * (still no password) because sshd refuses a locked account.` : ""}` }
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
        if ((await provider.status(manifest)) !== "running") { this.unchecked.delete(manifest.name); return }
        const results = await this.stage(manifest, ["config", "runtime"], true)
        const failed = failures(results)
        // One pass that could not check is an engine hiccup. Several in a row is a sandbox nobody is checking.
        const blind = failed.length ? [] : blockers(results)
        this.unchecked.set(manifest.name, blind.length ? (this.unchecked.get(manifest.name) ?? 0) + 1 : 0)
        if (blind.length && this.unchecked.get(manifest.name)! >= UNCHECKED_PASSES) {
          this.unchecked.delete(manifest.name)
          return this.stopBecause(manifest, `Stopped by the daemon at ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC: for ${UNCHECKED_PASSES} passes in a row it could not check ${blind.map((entry) => `${titleOf(entry.id)} (${entry.detail})`).join("; ")}`)
        }
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
