import { createHash, randomBytes } from "node:crypto"
import { must } from "../run"
import { PaddockError, type CheckResult, type Engine, type Manifest, type Provider, type RunOptions, type RunResult, type Runner, type Stage } from "../types"
import GUARD_RULES from "./guard.nft" with { type: "text" }
import HELPER_DOCKERFILE from "./helper.Dockerfile" with { type: "text" }

// Sandboxes as containers under gVisor, on any local Docker engine that has a gVisor runtime (OrbStack, a Linux host,
// Colima, …). The agent talks to gVisor's user-space kernel, never the host's. Each sandbox has a bridge network of its
// own, and an nftables table on the engine's host (guard.nft) drops its traffic to the host, to other sandboxes and
// containers, to private ranges (the LAN), the tailnet, link-local (cloud metadata) and all IPv6. The design and the
// measurements behind it come from sandbox-manager, where it was checked on OrbStack and on Linux Mint.

export const LABEL_NAME = "dev.paddock.name"
export const LABEL_ID = "dev.paddock.id"
export const container = (name: string) => `paddock-${name}`
export const network = (name: string) => `paddock-net-${name}`
// Linux limits interface names to 15 characters. The guard matches on this prefix.
export const BRIDGE_PREFIX = "pdk"
export const bridge = (name: string) => `${BRIDGE_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 10)}`
// The privileged steps (loading the guard) and the probes run from this image, never from a sandbox's image, which an
// agent or a tampered template could have changed. Its tag is a hash of its Dockerfile, so it is built once per engine.
export const HELPER_IMAGE = `paddock-helper:${createHash("sha256").update(HELPER_DOCKERFILE).digest("hex").slice(0, 12)}`
// Loads the guard into a scratch network namespace and compares how nft prints it there with how it prints the tables
// on the engine's host: any added, removed or reordered rule shows. Printing both with the same nft avoids depending on
// one version's wording. Prints intact, changed or missing.
const GUARD_COMPARE = `set -e
cat > /tmp/rules
show() { nft list table inet paddock_guard && nft list table bridge paddock_guard; }
ip netns add reference
ip netns exec reference nft -f /tmp/rules
ip netns exec reference sh -c 'nft list table inet paddock_guard && nft list table bridge paddock_guard' > /tmp/want
show > /tmp/have 2>/dev/null || { echo missing; exit 0; }
cmp -s /tmp/want /tmp/have && echo intact || echo changed`
// gVisor flags that open a path to the host or switch a limit off. A runtime registered with one is not used.
const UNSAFE_RUNTIME_ARGS = [/^--network(=|$)(?!sandbox$)/, /^--host-uds(=(?!none$)|$)/, /^--host-fifo(=(?!none$)|$)/, /^--fsgofer-host-uds(=(?!false$)|$)/, /^--TESTONLY/, /^--ignore-cgroups(=(?!false$)|$)/, /^--allow-flag-override(=(?!false$)|$)/]
type RuntimeEntry = { path?: string; runtimeArgs?: string[] }
export function unsafeRuntimeArgs(args: readonly string[] = []): string[] {
  // "--network host" (two words) is the same flag as "--network=host".
  // gVisor takes -flag and --flag alike.
  const flags = args.map((arg) => arg.replace(/^-+/, "--"))
  return args.filter((_, index) => UNSAFE_RUNTIME_ARGS.some((pattern) => pattern.test(flags[index]!)) && !(flags[index] === "--network" && args[index + 1] === "sandbox"))
}
// The disk watch reads the size of the container's writable layer. gVisor's default keeps written files in its own
// overlay, which Docker does not measure; only with --overlay2=none do they reach the layer (measured on OrbStack).
const seesWrites = (args: readonly string[] = []) => args.includes("--overlay2=none")
const SANDBOX_DNS = "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
const PROBE_REPLY = "paddock-probe"
const PROBE_PORT = "7777"
const CREDENTIAL_FILES = [".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml", ".git-credentials", ".ssh/id_ed25519", ".ssh/id_rsa", ".aws/credentials", ".netrc"]

type Inspect = {
  State: { Running: boolean }
  Config: { Labels: Record<string, string> | null }
  HostConfig: {
    Runtime: string; Privileged: boolean; CapAdd: string[] | null; Devices: unknown[] | null; PidMode: string; IpcMode: string
    Binds?: string[] | null; VolumesFrom?: string[] | null; DeviceRequests?: unknown[] | null; Annotations?: Record<string, string> | null
    UTSMode: string; UsernsMode: string; SecurityOpt: string[] | null; NetworkMode: string; PublishAllPorts: boolean
    PortBindings: Record<string, unknown> | null; Memory: number; MemorySwap: number; PidsLimit: number | null; NanoCpus: number
  }
  Mounts: Array<{ Type: string; Source: string; Destination: string }> | null
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null }
}

const result = (id: CheckResult["id"], status: CheckResult["status"], evidence: CheckResult["evidence"], detail: string): CheckResult => ({ id, status, evidence, detail })
const isGvisor = (path: string | undefined) => (path ?? "").split("/").pop() === "runsc"
export type GuardState = "intact" | "changed" | "missing" | "unknown"

// The checks that only need `docker inspect`. Exported for tests.
export function configChecks(inspect: Inspect, manifest: Manifest, guard: GuardState, networkBridge: string | undefined): CheckResult[] {
  const host = inspect.HostConfig; const name = manifest.name; const out: CheckResult[] = []

  const loose = [
    host.Privileged && "privileged mode",
    (host.CapAdd ?? []).length > 0 && `added capabilities (${(host.CapAdd ?? []).join(", ")})`,
    (host.Devices ?? []).length > 0 && "host devices",
    (host.DeviceRequests ?? []).length > 0 && "device requests (a GPU, for example)",
    (host.VolumesFrom ?? []).length > 0 && "another container's volumes",
    Object.keys(host.Annotations ?? {}).length > 0 && "runtime annotations",
    host.Runtime !== manifest.engine.data.runtime && `the runtime ${host.Runtime} instead of ${manifest.engine.data.runtime}`,
    ...(["PidMode", "IpcMode", "UTSMode", "UsernsMode"] as const).map((key) => host[key] === "host" && `the host's ${key.replace("Mode", "").toLowerCase()} namespace`),
    (host.SecurityOpt ?? []).some((option) => option.includes("unconfined")) && "an unconfined security profile",
  ].filter(Boolean)
  out.push(loose.length ? result("hardening", "fail", "inspected", `The container has ${loose.join(", ")}.`) : result("hardening", "pass", "inspected", "None of them are set."))

  // Volumes the image declares live in the engine, not in a host folder.
  const binds = [...(inspect.Mounts ?? []).filter((mount) => mount.Type !== "volume" && mount.Type !== "tmpfs"), ...(host.Binds ?? []).map((bind) => ({ Source: bind.split(":")[0]!, Destination: bind.split(":")[1] ?? "" }))]
  out.push(binds.length ? result("mounts", "fail", "inspected", `Mounted from the host: ${binds.map((mount) => `${mount.Source} at ${mount.Destination}`).join(", ")}.`) : result("mounts", "pass", "inspected", "No host folders."))

  const networks = Object.keys(inspect.NetworkSettings.Networks ?? {})
  const own = network(name)
  const networkProblems = [
    !(networks.length === 1 && networks[0] === own) && `it is attached to ${networks.join(", ") || "no network"} instead of only ${own}`,
    host.NetworkMode !== own && `its network mode is ${host.NetworkMode}`,
    !(networkBridge ?? "").startsWith(BRIDGE_PREFIX) && "its network's bridge is not one the guard covers",
    guard === "missing" && "the guard rules are not loaded on the engine's host",
    guard === "changed" && "the guard rules on the engine's host differ from the ones Paddock loads",
  ].filter(Boolean)
  out.push(networkProblems.length ? result("network-guard", "fail", "inspected", `Not guarded: ${networkProblems.join("; ")}.`)
    : guard === "unknown" ? result("network-guard", "unknown", "none", "The guard rules on the engine's host could not be read.")
    : result("network-guard", "pass", "inspected", `Only on ${own}; the loaded guard rules match Paddock's, rule for rule.`))

  const published = Object.keys(host.PortBindings ?? {})
  out.push(published.length || host.PublishAllPorts ? result("inbound", "fail", "inspected", `Published ports: ${published.join(", ") || "all"}.`) : result("inbound", "pass", "inspected", "No published ports."))

  const unlimited = [
    !(host.Memory > 0) && "memory", host.Memory > 0 && host.MemorySwap !== host.Memory && "swap",
    !((host.PidsLimit ?? 0) > 0) && "processes", !(host.NanoCpus > 0) && "CPU",
  ].filter(Boolean)
  out.push(unlimited.length ? result("limits", "fail", "inspected", `No limit on ${unlimited.join(", ")}.`)
    : result("limits", "pass", "inspected", `${host.Memory / 1024 ** 3} GB memory (past it, the sandbox is killed), ${host.PidsLimit} tasks (past it, new processes fail), ${host.NanoCpus / 1e9} CPUs.`))

  const disk = manifest.engine.capabilities?.diskLimit
  out.push(disk === "hard" ? result("disk", "pass", "inspected", `${manifest.spec.diskGb} GB; writes fail at the limit.`)
    : disk === "watched" ? result("disk", "weak", "inspected", `Watched, not capped: the daemon stops the sandbox within about 30 seconds of it passing ${manifest.spec.diskGb} GB, so it can overshoot. Stopping the daemon stops the sandbox; if the daemon crashes, nothing watches until it runs again.`)
    : result("disk", "unsupported", "none", "Nothing limits this sandbox's disk use: the engine has no cap, and its gVisor runtime lacks --overlay2=none, without which Paddock cannot measure what the sandbox writes."))
  return out
}

export class GvisorProvider implements Provider {
  readonly id = "gvisor"
  // Readings in flight, so checks of several sandboxes asked for at once share one. A finished reading is never reused:
  // a check must not be answered from before it was asked.
  private readonly guardReads = new Map<string, Promise<GuardState>>()
  constructor(private readonly run: Runner) {}

  private docker(engine: Engine, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.run(["docker", "--context", engine.data.context!, ...args], options)
  }

  async detect(): Promise<Engine[]> {
    const listed = await this.run(["docker", "context", "ls", "--format", "{{json .}}"], { timeoutMs: 10_000 })
    if (listed.exitCode !== 0) return []
    const engines: Engine[] = []; const seen = new Set<string>()
    // "default" is whatever owns /var/run/docker.sock today, so an engine also listed under its own name is recorded under that.
    const contexts = listed.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { Name: string; DockerEndpoint: string })
      .sort((a, b) => Number(a.Name === "default") - Number(b.Name === "default"))
    for (const context of contexts) {
      const base = { id: `gvisor:${context.Name}`, provider: this.id, data: { context: context.Name } }
      // Remote engines (ssh://, tcp://) are not handled yet: the probes assume the engine's host is this machine or its VM.
      if (!/^(unix|npipe):\/\//.test(context.DockerEndpoint)) continue
      const info = await this.run(["docker", "--context", context.Name, "info", "--format", "{{json .}}"], { timeoutMs: 10_000 })
      let parsed: { ID?: string; OperatingSystem?: string; ServerVersion?: string; Architecture?: string; Runtimes?: Record<string, RuntimeEntry> } = {}
      try { parsed = JSON.parse(info.stdout) } catch {}
      if (info.exitCode !== 0 || !parsed.ServerVersion) {
        engines.push({ ...base, label: `Docker context ${context.Name}`, ready: false, problems: ["The Docker engine does not answer."], fix: "Start the engine (OrbStack, Docker Desktop, or `systemctl start docker`)." })
        continue
      }
      // Two contexts can name one engine (OrbStack also owns /var/run/docker.sock).
      if (parsed.ID && seen.has(parsed.ID)) continue
      if (parsed.ID) seen.add(parsed.ID)
      const label = `${parsed.OperatingSystem ?? "Docker"} ${parsed.ServerVersion} (context ${context.Name})`
      const gvisor = Object.entries(parsed.Runtimes ?? {}).filter(([, entry]) => isGvisor(entry.path)).sort(([a], [b]) => a.localeCompare(b))
      const usable = gvisor.filter(([, entry]) => unsafeRuntimeArgs(entry.runtimeArgs).length === 0)
      // Prefer a runtime whose writes Paddock can measure.
      const chosen = usable.find(([, entry]) => seesWrites(entry.runtimeArgs)) ?? usable[0]
      if (!chosen) {
        const problems = gvisor.length
          ? gvisor.map(([name, entry]) => `The gVisor runtime ${name} is registered with ${unsafeRuntimeArgs(entry.runtimeArgs).join(", ")}, which opens a path to the host or switches a limit off.`)
          : ["The engine has no gVisor runtime, and Paddock does not run sandboxes on the host's kernel."]
        engines.push({ ...base, label, ready: false, problems, fix: gvisorSetup(parsed.OperatingSystem, parsed.Architecture) })
        continue
      }
      const measurable = seesWrites(chosen[1].runtimeArgs)
      engines.push({ ...base, label, ready: true, data: { context: context.Name, runtime: chosen[0] },
        problems: measurable ? [] : [`Sandboxes here have no disk limit: the runtime ${chosen[0]} lacks --overlay2=none, without which Paddock cannot measure what a sandbox writes.`],
        capabilities: { kernelIsolation: "gvisor", diskLimit: measurable ? "watched" : "none", networkGuard: true } })
    }
    return engines
  }

  private async ensureHelper(engine: Engine): Promise<void> {
    if ((await this.docker(engine, ["image", "inspect", HELPER_IMAGE])).exitCode === 0) return
    must(await this.docker(engine, ["build", "-q", "-t", HELPER_IMAGE, "-"], { stdin: HELPER_DOCKERFILE, timeoutMs: 300_000 }), "Building the helper image")
  }

  // Runs nft as root on the engine host's network, from the helper image.
  private nft(engine: Engine, args: readonly string[], stdin?: string): Promise<RunResult> {
    return this.docker(engine, ["run", "--rm", "-i", "--runtime", "runc", "--privileged", "--network", "host", "-u", "0", "--entrypoint", "nft", HELPER_IMAGE, ...args], { stdin, timeoutMs: 60_000 })
  }

  private guardState(engine: Engine): Promise<GuardState> {
    const reading = this.guardReads.get(engine.id)
    if (reading) return reading
    const read = (async (): Promise<GuardState> => {
      const output = await this.docker(engine, ["run", "--rm", "-i", "--runtime", "runc", "--privileged", "--network", "host", "-u", "0", "--entrypoint", "sh", HELPER_IMAGE, "-c", GUARD_COMPARE], { stdin: GUARD_RULES, timeoutMs: 60_000 })
      const word = output.stdout.trim()
      return output.exitCode === 0 && (word === "intact" || word === "changed" || word === "missing") ? word : "unknown"
    })().finally(() => this.guardReads.delete(engine.id))
    this.guardReads.set(engine.id, read)
    return read
  }

  // The guard does not survive a restart of the engine's host, so it is loaded before every start. Loading replaces the
  // tables in one transaction, which also undoes any change made to them.
  async prepare(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    await this.ensureHelper(engine)
    must(await this.nft(engine, ["-f", "-"], GUARD_RULES), "Loading the network guard")
    // A reading begun before the load may describe the tables it replaced; let it finish so the next one is new.
    await this.guardReads.get(engine.id)
    if ((await this.docker(engine, ["network", "inspect", network(name)])).exitCode !== 0)
      must(await this.docker(engine, ["network", "create", "-o", `com.docker.network.bridge.name=${bridge(name)}`, network(name)]), "Creating the sandbox's network")
  }

  async create(manifest: Manifest): Promise<void> {
    const { engine, spec, name } = manifest
    await this.prepare(manifest)
    const memory = `${Math.round(spec.memoryGb * 1024)}m`
    // sleep keeps the sandbox up; sessions come in through exec. No restart policy: a restart would skip the guard.
    must(await this.docker(engine, [
      "create", "--name", container(name), "--hostname", name, "--label", `${LABEL_NAME}=${name}`, "--label", `${LABEL_ID}=${manifest.id}`,
      "--runtime", engine.data.runtime!, "--network", network(name), "--restart", "no",
      "--cpus", String(spec.cpus), "--memory", memory, "--memory-swap", memory, "--pids-limit", String(spec.pids),
      "--entrypoint", "sleep", spec.image, "infinity",
    ], { timeoutMs: 1_800_000 }), `Creating ${name}`)
  }

  private async inspect(manifest: Manifest): Promise<Inspect | undefined> {
    const output = await this.docker(manifest.engine, ["inspect", container(manifest.name)])
    if (output.exitCode !== 0) return undefined
    const inspect = (JSON.parse(output.stdout) as Inspect[])[0]!
    // A container under this name that the core did not create (or a recreated one) is never operated on.
    if (inspect.Config.Labels?.[LABEL_ID] !== manifest.id)
      throw new PaddockError("conflict", `The container ${container(manifest.name)} was not created by this Paddock sandbox (its id label differs). Nothing was done to it.`)
    return inspect
  }

  async status(manifest: Manifest) {
    const inspect = await this.inspect(manifest)
    return inspect === undefined ? "missing" as const : inspect.State.Running ? "running" as const : "stopped" as const
  }

  async start(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    if ((await this.inspect(manifest))?.State.Running) return
    must(await this.docker(engine, ["start", container(name)]), `Starting ${name}`)
    // gVisor cannot use Docker's DNS server on a user-defined network (127.0.0.11 is refused), so public resolvers are written.
    const dns = await this.docker(engine, ["exec", "-i", "-u", "0", container(name), "sh", "-c", "cat > /etc/resolv.conf"], { stdin: SANDBOX_DNS })
    if (dns.exitCode !== 0) throw new PaddockError("runtime", `${name} started, but its DNS could not be set: ${dns.stderr.trim()}`)
  }

  async stop(manifest: Manifest): Promise<void> {
    if ((await this.inspect(manifest)) === undefined) return
    must(await this.docker(manifest.engine, ["stop", "-t", "5", container(manifest.name)], { timeoutMs: 60_000 }), `Stopping ${manifest.name}`)
  }

  async remove(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    if ((await this.inspect(manifest)) !== undefined) must(await this.docker(engine, ["rm", "-f", "-v", container(name)], { timeoutMs: 120_000 }), `Removing ${name}`)
    await this.docker(engine, ["network", "rm", network(name)])
  }

  async exec(manifest: Manifest, argv: readonly string[], options: { user?: string; stdin?: string } = {}): Promise<RunResult> {
    if ((await this.status(manifest)) !== "running") throw new PaddockError("conflict", `${manifest.name} is not running. Start it first.`)
    return this.docker(manifest.engine, ["exec", ...(options.stdin === undefined ? [] : ["-i"]), ...(options.user ? ["-u", options.user] : []), container(manifest.name), ...argv], { stdin: options.stdin })
  }

  attachArgv(manifest: Manifest, argv: readonly string[]): string[] {
    return ["docker", "--context", manifest.engine.data.context!, "exec", "-it", container(manifest.name), ...argv]
  }

  async diskUsedBytes(manifest: Manifest): Promise<number | undefined> {
    const output = await this.docker(manifest.engine, ["inspect", "--size", "--format", "{{.SizeRw}}", container(manifest.name)], { timeoutMs: 120_000 })
    const layer = Number(output.stdout.trim())
    if (output.exitCode !== 0 || !Number.isFinite(layer)) return undefined
    // Volumes an image declares are outside the writable layer. They are measured by the helper, not by the sandbox's
    // own du, which an agent could replace.
    const volumes = ((await this.inspect(manifest))?.Mounts ?? []).filter((mount) => mount.Type === "volume").map((mount) => mount.Destination)
    if (!volumes.length) return layer
    const du = await this.docker(manifest.engine, ["run", "--rm", "--runtime", "runc", "--network", "none", "--volumes-from", `${container(manifest.name)}:ro`, "--entrypoint", "du", HELPER_IMAGE, "-sk", ...volumes], { timeoutMs: 300_000 })
    if (du.exitCode !== 0) return undefined
    return layer + du.stdout.split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line.split("\t")[0]) * 1024, 0)
  }

  // Probe helpers left behind by a daemon that died mid-probe.
  async sweep(engine: Engine): Promise<void> {
    const stale = (await this.docker(engine, ["ps", "-aq", "--filter", "label=dev.paddock.probe"])).stdout.split("\n").filter(Boolean)
    if (stale.length) await this.docker(engine, ["rm", "-f", ...stale])
    const networks = (await this.docker(engine, ["network", "ls", "--format", "{{.Name}}", "--filter", "name=paddock-net-probe-"])).stdout.split("\n").filter(Boolean)
    if (networks.length) await this.docker(engine, ["network", "rm", ...networks])
  }

  async checks(manifest: Manifest, stage: Stage): Promise<CheckResult[]> {
    const inspect = await this.inspect(manifest)
    if (!inspect) throw new PaddockError("not-found", `${manifest.name} has no container on ${manifest.engine.label}.`)
    if (stage === "config") {
      const { engine, name } = manifest
      const bridgeName = await this.docker(engine, ["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}', network(name)])
      return configChecks(inspect, manifest, await this.guardState(engine), bridgeName.exitCode === 0 ? bridgeName.stdout.trim() : undefined)
    }
    if (stage === "runtime") return [await this.kernelCheck(manifest, inspect)]
    return this.probe(manifest, inspect)
  }

  // The runtime the engine reports, confirmed from inside: gVisor's kernel log and version string name it.
  private async kernelCheck(manifest: Manifest, inspect: Inspect): Promise<CheckResult> {
    const { engine, name } = manifest
    const runtimes = await this.docker(engine, ["info", "--format", "{{json .Runtimes}}"])
    let entry: RuntimeEntry | undefined
    try { entry = (JSON.parse(runtimes.stdout) as Record<string, RuntimeEntry>)[inspect.HostConfig.Runtime] } catch {}
    if (!isGvisor(entry?.path)) return result("kernel", "fail", "inspected", `The container's runtime is ${inspect.HostConfig.Runtime}, which is not gVisor.`)
    const unsafe = unsafeRuntimeArgs(entry?.runtimeArgs)
    if (unsafe.length) return result("kernel", "fail", "inspected", `The gVisor runtime ${inspect.HostConfig.Runtime} is registered with ${unsafe.join(", ")}, which opens a path to the host or switches a limit off.`)
    const inside = await this.docker(engine, ["exec", container(name), "sh", "-c", "dmesg 2>/dev/null | head -n 3; cat /proc/version"])
    if (inside.exitCode !== 0) return result("kernel", "unknown", "inspected", `The runtime is gVisor (${inspect.HostConfig.Runtime}), but that could not be confirmed from inside: ${inside.stderr.trim()}`)
    return /gvisor/i.test(inside.stdout) ? result("kernel", "pass", "probed", `gVisor (${inspect.HostConfig.Runtime}); its kernel answers inside the sandbox.`)
      : result("kernel", "fail", "probed", "The kernel inside the sandbox does not identify as gVisor.")
  }

  // Live attempts from where the sandbox sits on the network. A helper container joins the sandbox's own network, with
  // the sandbox's runtime, and tries to connect to: a listener on the engine's host, and a listener on another guarded
  // network (a stand-in for another sandbox). Each "blocked" result counts only if its controls answered: the host can
  // reach the helper (its network works) and the host can reach each listener (they are up).
  private async probe(manifest: Manifest, inspect: Inspect): Promise<CheckResult[]> {
    const { engine, name } = manifest
    if (!inspect.State.Running) return []
    const tag = randomBytes(4).toString("hex")
    const hostC = `paddock-probe-${tag}-host`; const peerC = `paddock-probe-${tag}-peer`; const probeC = `paddock-probe-${tag}-probe`
    const peerNet = `paddock-net-probe-${tag}`
    const listen = (port: string, address?: string) => ["nc", "-lk", "-p", port, ...(address ? ["-s", address] : []), "-e", "echo", PROBE_REPLY]
    const runHelper = (cname: string, runtime: string, net: string, command: string[]) =>
      this.docker(engine, ["run", "-d", "--rm", "--name", cname, "--label", "dev.paddock.probe=1", "--runtime", runtime, "--network", net, "--memory", "64m", "--pids-limit", "64", HELPER_IMAGE, ...command], { timeoutMs: 60_000 })
    const address = async (cname: string) => (await this.docker(engine, ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cname])).stdout.trim()
    // True when the listener's reply comes back.
    const reaches = async (from: string, ip: string, port: string) =>
      (await this.docker(engine, ["exec", from, "nc", "-w", "2", ip, port], { timeoutMs: 15_000 })).stdout.includes(PROBE_REPLY)
    // For targets without a listener of ours: true when the TCP connection opens.
    const connects = async (from: string, ip: string, port: string) =>
      (await this.docker(engine, ["exec", from, "sh", "-c", 'nc -w 3 "$1" "$2" </dev/null', "connect", ip, port], { timeoutMs: 15_000 })).exitCode === 0
    const retry = async (attempt: () => Promise<boolean>) => {
      for (let i = 0; i < 8; i++) { if (await attempt()) return true; await Bun.sleep(400) }
      return false
    }
    const out: CheckResult[] = []
    try {
      await this.ensureHelper(engine)
      const gateway = (await this.docker(engine, ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network(name)])).stdout.trim()
      const hostPort = String(20_000 + Math.floor(Math.random() * 40_000))
      must(await this.docker(engine, ["network", "create", "--label", "dev.paddock.probe=1", "-o", `com.docker.network.bridge.name=${BRIDGE_PREFIX}x${tag}`, peerNet]), "Creating the probe network")
      must(await runHelper(hostC, "runc", "host", listen(hostPort, gateway)), "Starting the host listener")
      must(await runHelper(peerC, "runc", peerNet, listen(PROBE_PORT)), "Starting the peer listener")
      must(await runHelper(probeC, engine.data.runtime!, network(name), listen(PROBE_PORT)), "Starting the probe")
      const [peerIp, probeIp] = [await address(peerC), await address(probeC)]

      const probeAlive = await retry(() => reaches(hostC, probeIp, PROBE_PORT))
      const hostListening = probeAlive && await retry(() => reaches(hostC, gateway, hostPort))
      const peerListening = probeAlive && await retry(() => reaches(hostC, peerIp, PROBE_PORT))
      const noControl = (what: string) => `Not checked: ${what} did not answer a control connection, so a blocked attempt would prove nothing.`

      out.push(!hostListening ? result("net-host", "unknown", "none", noControl(probeAlive ? "the listener on the host" : "the probe"))
        : await reaches(probeC, gateway, hostPort) ? result("net-host", "fail", "probed", `A connection from the sandbox's network reached a listener on the engine's host (${gateway}).`)
        : result("net-host", "pass", "probed", `A listener on the engine's host (${gateway}) answered the host and was unreachable from the sandbox's network.`))
      out.push(!peerListening ? result("net-peers", "unknown", "none", noControl(probeAlive ? "the stand-in sandbox" : "the probe"))
        : await reaches(probeC, peerIp, PROBE_PORT) ? result("net-peers", "fail", "probed", "A connection from the sandbox's network reached a container on another sandbox network.")
        : result("net-peers", "pass", "probed", "A container on another sandbox network answered the host and was unreachable from the sandbox's network."))

      const guard = await this.guardState(engine)
      const metadata = probeAlive && await connects(probeC, "169.254.169.254", "80")
      // The stand-in sandbox sits at a private address, so its probe also exercised the private-range rule.
      const viaPeer = peerListening && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(peerIp) ? ` The private-range rule was exercised live by the attempt on ${peerIp}.` : ""
      out.push(guard === "missing" || guard === "changed" ? result("net-private", "fail", "inspected", `The guard rules on the engine's host are ${guard}, so nothing is known to drop these destinations.`)
        : guard === "unknown" ? result("net-private", "unknown", "none", "The guard rules on the engine's host could not be read.")
        : metadata ? result("net-private", "fail", "probed", "The cloud metadata address answered from the sandbox's network.")
        : result("net-private", "pass", "inspected", `The loaded rules match Paddock's, which drop private, tailnet, link-local and IPv6 destinations.${viaPeer} The metadata address did not answer. Your LAN and tailnet have no listener to test against.`))

      out.push(!probeAlive ? result("egress", "unknown", "none", noControl("the probe"))
        : await connects(probeC, "1.1.1.1", "443") ? result("egress", "info", "probed", "Open: the sandbox can reach the internet, so anything inside it can be sent out.")
        : result("egress", "info", "probed", "The internet did not answer (this machine may be offline)."))
    } catch (error) {
      for (const id of ["net-host", "net-peers", "net-private", "egress"] as const)
        if (!out.some((entry) => entry.id === id)) out.push(result(id, "unknown", "none", `The probe could not run: ${(error as Error).message}`))
    } finally {
      await this.docker(engine, ["rm", "-f", hostC, peerC, probeC])
      await this.docker(engine, ["network", "rm", peerNet])
    }

    const script = `for home in /root /home/*; do for file in ${CREDENTIAL_FILES.join(" ")}; do [ -e "$home/$file" ] && echo "$home/$file"; done; done; true`
    const found = await this.docker(engine, ["exec", "-u", "0", container(name), "sh", "-c", script])
    const files = found.stdout.split("\n").filter(Boolean)
    out.push(found.exitCode !== 0 ? result("credentials", "unknown", "none", `Could not look: ${found.stderr.trim()}`)
      : files.length ? result("credentials", "info", "probed", `Found ${files.join(", ")}. An agent in the sandbox can read these and send them out.`)
      : result("credentials", "info", "probed", "None of the usual login files (Claude, Codex, GitHub, git, SSH keys, AWS, netrc) are present."))
    return out
  }
}

// What to do on an engine without a usable gVisor runtime. The OrbStack steps are the ones this was developed on.
export function gvisorSetup(os = "", architecture = ""): string {
  const arch = /arm64|aarch64/.test(architecture) ? "aarch64" : "x86_64"
  const runtime = (path: string) => `"runtimes": { "runsc": { "path": "${path}", "runtimeArgs": ["--allow-suid", "--overlay2=none"] } }`
  const download = `https://storage.googleapis.com/gvisor/releases/release/latest/${arch}/runsc (check it against runsc.sha512 beside it)`
  if (os === "OrbStack") return `1. Download ${download} into a folder under your home, such as ~/.local/share/paddock/gvisor, and make it executable. 2. Add to ~/.orbstack/config/docker.json: ${runtime("/Users/YOU/.local/share/paddock/gvisor/runsc")}. 3. Run \`orb restart docker\` (it stops running containers).`
  return `1. Install gVisor: download ${download} to /usr/local/bin/runsc and make it executable, or follow https://gvisor.dev/docs/user_guide/install/. 2. Add to /etc/docker/daemon.json: ${runtime("/usr/local/bin/runsc")}. 3. Restart the engine, for example \`sudo systemctl restart docker\` (it stops running containers).`
}
