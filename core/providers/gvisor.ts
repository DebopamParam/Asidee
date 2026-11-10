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
const GUARD_RANGES = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]
const SANDBOX_DNS = "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
const PROBE_REPLY = "paddock-probe"
const PROBE_PORT = "7777"
const CREDENTIAL_FILES = [".claude/.credentials.json", ".codex/auth.json", ".config/gh/hosts.yml", ".git-credentials", ".ssh/id_ed25519", ".ssh/id_rsa", ".aws/credentials", ".netrc"]

type Inspect = {
  State: { Running: boolean }
  Config: { Labels: Record<string, string> | null }
  HostConfig: {
    Runtime: string; Privileged: boolean; CapAdd: string[] | null; Devices: unknown[] | null; PidMode: string; IpcMode: string
    UTSMode: string; UsernsMode: string; SecurityOpt: string[] | null; NetworkMode: string; PublishAllPorts: boolean
    PortBindings: Record<string, unknown> | null; Memory: number; MemorySwap: number; PidsLimit: number | null; NanoCpus: number
  }
  Mounts: Array<{ Type: string; Source: string; Destination: string }> | null
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null }
}

const result = (id: CheckResult["id"], status: CheckResult["status"], evidence: CheckResult["evidence"], detail: string): CheckResult => ({ id, status, evidence, detail })
const isGvisor = (path: string | undefined) => (path ?? "").split("/").pop() === "runsc"

// The checks that only need `docker inspect`. Exported for tests.
export function configChecks(inspect: Inspect, manifest: Manifest, guardListing: string | undefined, networkBridge: string | undefined): CheckResult[] {
  const host = inspect.HostConfig; const name = manifest.name; const out: CheckResult[] = []

  const loose = [
    host.Privileged && "privileged mode",
    (host.CapAdd ?? []).length > 0 && `added capabilities (${(host.CapAdd ?? []).join(", ")})`,
    (host.Devices ?? []).length > 0 && "host devices",
    ...(["PidMode", "IpcMode", "UTSMode", "UsernsMode"] as const).map((key) => host[key] === "host" && `the host's ${key.replace("Mode", "").toLowerCase()} namespace`),
    (host.SecurityOpt ?? []).some((option) => option.includes("unconfined")) && "an unconfined security profile",
  ].filter(Boolean)
  out.push(loose.length ? result("hardening", "fail", "inspected", `The container has ${loose.join(", ")}.`) : result("hardening", "pass", "inspected", "None of them are set."))

  // Volumes the image declares live in the engine, not in a host folder.
  const binds = (inspect.Mounts ?? []).filter((mount) => mount.Type !== "volume" && mount.Type !== "tmpfs")
  out.push(binds.length ? result("mounts", "fail", "inspected", `Mounted from the host: ${binds.map((mount) => `${mount.Source} at ${mount.Destination}`).join(", ")}.`) : result("mounts", "pass", "inspected", "No host folders."))

  const networks = Object.keys(inspect.NetworkSettings.Networks ?? {})
  const own = network(name)
  const guardLoaded = guardListing !== undefined && guardListing.includes(`iifname != "${BRIDGE_PREFIX}*" accept`)
  const networkProblems = [
    !(networks.length === 1 && networks[0] === own) && `it is attached to ${networks.join(", ") || "no network"} instead of only ${own}`,
    host.NetworkMode !== own && `its network mode is ${host.NetworkMode}`,
    !(networkBridge ?? "").startsWith(BRIDGE_PREFIX) && "its network's bridge is not one the guard covers",
    !guardLoaded && "the guard rules are not loaded on the engine's host",
  ].filter(Boolean)
  out.push(networkProblems.length ? result("network-guard", "fail", "inspected", `Not guarded: ${networkProblems.join("; ")}.`) : result("network-guard", "pass", "inspected", `Only on ${own}; guard loaded.`))

  const published = Object.keys(host.PortBindings ?? {})
  out.push(published.length || host.PublishAllPorts ? result("inbound", "fail", "inspected", `Published ports: ${published.join(", ") || "all"}.`) : result("inbound", "pass", "inspected", "No published ports."))

  const unlimited = [
    !(host.Memory > 0) && "memory", host.Memory > 0 && host.MemorySwap !== host.Memory && "swap",
    !((host.PidsLimit ?? 0) > 0) && "processes", !(host.NanoCpus > 0) && "CPU",
  ].filter(Boolean)
  out.push(unlimited.length ? result("limits", "fail", "inspected", `No limit on ${unlimited.join(", ")}.`)
    : result("limits", "pass", "inspected", `${host.Memory / 1024 ** 3} GB memory, ${host.PidsLimit} processes, ${host.NanoCpus / 1e9} CPUs.`))

  const disk = manifest.engine.capabilities?.diskLimit
  out.push(disk === "hard" ? result("disk", "pass", "inspected", `${manifest.spec.diskGb} GB; writes fail at the limit.`)
    : disk === "watched" ? result("disk", "weak", "inspected", `Watched, not capped: the daemon stops the sandbox after it passes ${manifest.spec.diskGb} GB, so it can overshoot, and nothing watches while the daemon is not running.`)
    : result("disk", "unsupported", "none", "This engine cannot limit a sandbox's disk use."))
  return out
}

export class GvisorProvider implements Provider {
  readonly id = "gvisor"
  constructor(private readonly run: Runner) {}

  private docker(engine: Engine, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.run(["docker", "--context", engine.data.context!, ...args], options)
  }

  async detect(): Promise<Engine[]> {
    const listed = await this.run(["docker", "context", "ls", "--format", "{{json .}}"], { timeoutMs: 10_000 })
    if (listed.exitCode !== 0) return []
    const engines: Engine[] = []; const seen = new Set<string>()
    for (const line of listed.stdout.split("\n").filter(Boolean)) {
      const context = JSON.parse(line) as { Name: string; DockerEndpoint: string }
      const base = { id: `gvisor:${context.Name}`, provider: this.id, data: { context: context.Name } }
      // Remote engines (ssh://, tcp://) are not handled yet: the probes assume the engine's host is this machine or its VM.
      if (!/^(unix|npipe):\/\//.test(context.DockerEndpoint)) continue
      const info = await this.run(["docker", "--context", context.Name, "info", "--format", "{{json .}}"], { timeoutMs: 10_000 })
      let parsed: { ID?: string; OperatingSystem?: string; ServerVersion?: string; Runtimes?: Record<string, { path?: string }> } = {}
      try { parsed = JSON.parse(info.stdout) } catch {}
      if (info.exitCode !== 0 || !parsed.ServerVersion) {
        engines.push({ ...base, label: `Docker context ${context.Name}`, ready: false, problems: ["The Docker engine does not answer."], fix: "Start the engine (OrbStack, Docker Desktop, or `systemctl start docker`)." })
        continue
      }
      // Two contexts can name one engine (OrbStack also owns /var/run/docker.sock).
      if (parsed.ID && seen.has(parsed.ID)) continue
      if (parsed.ID) seen.add(parsed.ID)
      const label = `${parsed.OperatingSystem ?? "Docker"} ${parsed.ServerVersion} (context ${context.Name})`
      const runtime = Object.entries(parsed.Runtimes ?? {}).filter(([, entry]) => isGvisor(entry.path)).map(([name]) => name).sort()[0]
      if (!runtime) {
        engines.push({ ...base, label, ready: false, problems: ["The engine has no gVisor runtime, and Paddock does not run sandboxes on the host's kernel."],
          fix: 'Install gVisor (https://gvisor.dev/docs/user_guide/install/) and register it in the engine\'s daemon.json: "runtimes": { "runsc": { "path": "/usr/local/bin/runsc", "runtimeArgs": ["--allow-suid"] } }, then restart the engine.' })
        continue
      }
      engines.push({ ...base, label, ready: true, problems: [], data: { context: context.Name, runtime }, capabilities: { kernelIsolation: "gvisor", diskLimit: "watched", networkGuard: true } })
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

  // The guard does not survive a restart of the engine's host, so it is loaded before every start.
  async prepare(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    await this.ensureHelper(engine)
    must(await this.nft(engine, ["-f", "-"], GUARD_RULES), "Loading the network guard")
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
    const bytes = Number(output.stdout.trim())
    return output.exitCode === 0 && Number.isFinite(bytes) ? bytes : undefined
  }

  async checks(manifest: Manifest, stage: Stage): Promise<CheckResult[]> {
    const inspect = await this.inspect(manifest)
    if (!inspect) throw new PaddockError("not-found", `${manifest.name} has no container on ${manifest.engine.label}.`)
    if (stage === "config") {
      const { engine, name } = manifest
      const listing = await this.nft(engine, ["list", "table", "inet", "paddock_guard"])
      const bridgeName = await this.docker(engine, ["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}', network(name)])
      return configChecks(inspect, manifest, listing.exitCode === 0 ? listing.stdout : undefined, bridgeName.exitCode === 0 ? bridgeName.stdout.trim() : undefined)
    }
    if (stage === "runtime") return [await this.kernelCheck(manifest, inspect)]
    return this.probe(manifest, inspect)
  }

  // The runtime the engine reports, confirmed from inside: gVisor's kernel log and version string name it.
  private async kernelCheck(manifest: Manifest, inspect: Inspect): Promise<CheckResult> {
    const { engine, name } = manifest
    const runtimes = await this.docker(engine, ["info", "--format", "{{json .Runtimes}}"])
    let path: string | undefined
    try { path = (JSON.parse(runtimes.stdout) as Record<string, { path?: string }>)[inspect.HostConfig.Runtime]?.path } catch {}
    if (!isGvisor(path)) return result("kernel", "fail", "inspected", `The container's runtime is ${inspect.HostConfig.Runtime}, which is not gVisor.`)
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
      this.docker(engine, ["run", "-d", "--rm", "--name", cname, "--runtime", runtime, "--network", net, "--memory", "64m", "--pids-limit", "64", HELPER_IMAGE, ...command], { timeoutMs: 60_000 })
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
      must(await this.docker(engine, ["network", "create", "-o", `com.docker.network.bridge.name=${BRIDGE_PREFIX}x${tag}`, peerNet]), "Creating the probe network")
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

      const listing = await this.nft(engine, ["list", "table", "inet", "paddock_guard"])
      const missing = [...GUARD_RANGES.filter((range) => !listing.stdout.includes(range)), ...(listing.stdout.includes("meta nfproto ipv6 drop") ? [] : ["IPv6"])]
      const metadata = probeAlive && await connects(probeC, "169.254.169.254", "80")
      out.push(listing.exitCode !== 0 || missing.length ? result("net-private", "fail", "inspected", `The loaded guard does not drop ${missing.join(", ") || "anything: it is not loaded"}.`)
        : metadata ? result("net-private", "fail", "probed", "The cloud metadata address answered from the sandbox's network.")
        : result("net-private", "pass", "inspected", "The loaded guard drops private, tailnet, link-local and IPv6 destinations. Only the metadata address was tried live (no answer); the LAN has no listener to test against."))

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
