import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { CHECKLIST } from "./checks"
import { HOST_APPLY, HOST_PROBE, HOST_REQUEST } from "./host-scripts"
import { compatible, hostName, parseHello, readHosts, type Hello, type HostRecord, type Machines } from "./machines"
import { HELPER_IMAGE } from "./providers/gvisor"
import HELPER_DOCKERFILE from "./providers/helper.Dockerfile" with { type: "text" }
import { systemRunner, must } from "./run"
import { HttpPeer, object, sshArgv, sshDestination, type Endpoint } from "./transport"
import { PaddockError, type Session, type RunResult } from "./types"

export const GVISOR_RELEASE = "20251110.0"
export const GVISOR_SHA512 = {
  aarch64: "297d42a46463d5b68c4786bcd448fe0914d7af91cd62f3c51b494b94e1c91d7eda68c6f21cfb1a66ac4d45aadcf20f7410291c0f3f17b090799f9cfa676cb563",
  x86_64: "40d9ec839850cb1994321f0716026b6149adb712bab576b157be2c31b832e68e11475647b2776499fca4c52e96fc7489877fff2fb1985d5f1e128d14f776bd6b",
} as const
const RUNTIME_DIR = `/opt/paddock/gvisor/${GVISOR_RELEASE}`
const RUNTIME = `${RUNTIME_DIR}/runsc`
const IMAGE = "alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
export type EnrollmentOptions = { name: string; ssh: string; sudo: "ask" | "never"; diskPolicy: "watched"; artifact: { path: string; sha256: string } }
export function enrollmentOptions(body: Record<string, unknown>): EnrollmentOptions {
  if (body.sudo !== undefined && body.sudo !== "ask" && body.sudo !== "never") throw new PaddockError("usage", "--sudo must be ask or never.")
  if (body.diskPolicy !== undefined && body.diskPolicy !== "watched") throw new PaddockError("usage", "Enrollment supports --disk-policy watched only. Hard disks and disk tools are stage 1d and are not installed.")
  if (!object(body.artifact) || typeof body.artifact.path !== "string" || !digest(body.artifact.sha256)) throw new PaddockError("usage", "Give --artifact PATH and --sha256 HASH from an explicitly trusted local build. No release channel exists.")
  return { name: hostName(body.name), ssh: sshDestination(body.ssh), sudo: body.sudo ?? "ask", diskPolicy: "watched", artifact: { path: resolve(body.artifact.path), sha256: body.artifact.sha256 } }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
export const planHash = (value: unknown) => sha256(canonical(value))

export async function verifyArtifact(artifact: EnrollmentOptions["artifact"], arch: string): Promise<Uint8Array> {
  const data = new Uint8Array(await Bun.file(artifact.path).arrayBuffer())
  if (sha256(data) !== artifact.sha256) throw new PaddockError("usage", "The local Paddock artifact checksum does not match --sha256. Nothing was uploaded or installed.")
  const machine = data[18]! | data[19]! << 8
  if (data.length < 64 || Buffer.from(data.slice(0, 4)).toString("hex") !== "7f454c46" || data[4] !== 2 || data[5] !== 1 || machine !== (arch === "aarch64" ? 183 : 62))
    throw new PaddockError("usage", `The artifact must be a native Linux 64-bit ELF for ${arch}. Build it explicitly; host add never cross-compiles.`)
  return data
}

export function mergeRuntime(before: string | null, path: string): string {
  const config: unknown = before === null ? {} : JSON.parse(before)
  if (!object(config) || (config.runtimes !== undefined && !object(config.runtimes))) throw new PaddockError("usage", "Docker daemon.json and runtimes must be JSON objects.")
  return `${JSON.stringify({ ...config, runtimes: { ...(object(config.runtimes) ? config.runtimes : {}), "paddock-runsc": { path, runtimeArgs: ["--allow-suid", "--overlay2=none"] } } }, null, 2)}\n`
}

type Command = { code: number; out: string; err: string }
type FileState = { kind: "absent" } | { kind: "link"; target: string; uid: number; mode: number } | { kind: "file"; sha256: string; sha512: string; text: string | null; uid: number; mode: number } | { kind: "other"; uid: number; mode: number } | { kind: "unreadable"; error: string }
type Download = { url: string; file: string; bytes: string; sha256: string; package: string; version: string }
export type HostProbe = { system: string; arch: string; libc: string[]; uid: number; gid: number; user: string; home: string; machine: string; boot: string; systemd: boolean; os: Record<string, string>
  docker: Command; containers: Command; packages: Command; downloads: Download[]; apt: Record<string, string>; repositories: Record<string,string>; files: Record<string, FileState>; ancestors: Record<string, { uid: number; mode: number; link: boolean } | null>; unit: Command; dockerGroup: Command; lingering: Command; hostKey: string }
const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every((v) => typeof v === "string")
const command = (v: unknown): v is Command => object(v) && Number.isInteger(v.code) && typeof v.out === "string" && typeof v.err === "string"
const file = (v: unknown): v is FileState => object(v) && (v.kind === "absent" || v.kind === "unreadable" && typeof v.error === "string" || Number.isInteger(v.uid) && Number.isInteger(v.mode) && (v.kind === "other" || v.kind === "link" && typeof v.target === "string" || v.kind === "file" && digest(v.sha256) && typeof v.sha512 === "string" && (v.text === null || typeof v.text === "string")))
function isProbe(v: unknown): v is HostProbe {
  return object(v) && [v.system,v.arch,v.user,v.home,v.machine,v.boot,v.hostKey].every((v) => typeof v === "string") && Number.isSafeInteger(v.uid) && Number.isSafeInteger(v.gid)
    && typeof v.systemd === "boolean" && strings(v.os) && Array.isArray(v.libc) && v.libc.every((v) => typeof v === "string") && strings(v.apt) && strings(v.repositories)
    && [v.docker,v.containers,v.packages,v.unit,v.dockerGroup,v.lingering].every(command) && object(v.files) && Object.values(v.files).every(file)
    && object(v.ancestors) && Object.values(v.ancestors).every((v) => v === null || object(v) && Number.isInteger(v.uid) && Number.isInteger(v.mode) && typeof v.link === "boolean")
    && Array.isArray(v.downloads) && v.downloads.every((d) => object(d) && [d.url,d.file,d.bytes,d.package,d.version].every((v) => typeof v === "string") && digest(d.sha256))
}
async function probe(options: EnrollmentOptions): Promise<HostProbe> {
  const argv = sshArgv(options.ssh, ["python3", "-c", HOST_PROBE])
  const result = must(await systemRunner([argv[0]!, "-v", ...argv.slice(1)], { stdin: JSON.stringify({ sha256: options.artifact.sha256, runtime: RUNTIME }), timeoutMs: 90_000 }), "Read-only enrollment probe (requires Python 3, established SSH trust and readable Docker inventory)")
  const value: unknown = JSON.parse(result.stdout)
  const hostKey = result.stderr.match(/Server host key: \S+ (SHA256:[A-Za-z0-9+/]{43})/)?.[1]
  const bound = object(value) ? { ...value, hostKey } : undefined
  if (!isProbe(bound)) throw new PaddockError("dependency", "The read-only probe returned incomplete evidence. Nothing was installed.")
  return bound
}

type Step = { label: string; argv: string[] }
type Change = { path: string; before: string | null; beforeSha256: string | null; after: string | null; sha256: string | null; diff: string; staged: string }
type Upload = { kind: "artifact"; name: string; algorithm: "sha256"; checksum: string; source: string } | { kind: "download"; name: string; algorithm: "sha256" | "sha512"; checksum: string; url: string }
export type HostPlan = { hash: string; client: Pick<Hello, "version" | "sourceDigest">; options: EnrollmentOptions; destination: HostProbe; stageDir: string; requestPath: string; stateDir: string; binary: string; service: string; mode: "install" | "reuse"; changes: Change[]; uploads: Upload[]; steps: Step[]; authentication: string[]; restart: { required: boolean; containers: string[] }; packageRecipe: { repositories: Record<string,string>; repositoryHashes: Record<string,string>; downloads: Download[] }; verification: { name: string; image: string; helperImage: string; helperDockerfile: string; cpus: number; memoryGb: number; diskGb: number; pids: number; docker: false; duration: "unknown"; operations: string[] }; warnings: string[]; blockers: string[] }

export function installationPlan(options: EnrollmentOptions, destination: HostProbe, client: Pick<Hello, "version" | "sourceDigest">): HostPlan {
  const stateDir = `/var/lib/paddock/${destination.uid}`; const binary = `/opt/paddock/releases/${options.artifact.sha256}/paddock`; const service = `paddock@${destination.uid}.service`
  const stageDir = `/tmp/paddock-enroll-${sha256(`${destination.machine}:${destination.uid}:${options.artifact.sha256}`).slice(0, 24)}`
  const changes: Change[] = []; const steps: Step[] = []; const uploads: Upload[] = []; const blockers: string[] = []
  const add = (label: string, ...argv: string[]) => steps.push({ label, argv })
  const sudo = (label: string, ...argv: string[]) => add(label, "sudo", "-n", ...argv)
  const text = (path: string): string | null => { const f = destination.files[path]; if (f?.kind === "file") return f.text; if (f?.kind !== "absent") blockers.push(`Cannot safely read ${path} (${f?.kind ?? "missing evidence"}).`); return null }
  const change = (path: string, after: string) => {
    const before = text(path); const staged = `file-${changes.length}`; const old = destination.files[path]
    changes.push({ path, before, beforeSha256: old?.kind === "file" ? old.sha256 : null, after, sha256: sha256(after), diff: `--- ${path} (before)\n+++ ${path} (after)\n${(before ?? "").split("\n").map((line) => `-${line}`).join("\n")}\n${after.split("\n").map((line) => `+${line}`).join("\n")}\n`, staged })
    return `${stageDir}/${staged}`
  }
  if (destination.system !== "Linux" || !["aarch64", "x86_64"].includes(destination.arch) || !destination.systemd || destination.libc[0] !== "glibc") blockers.push("Requires native Linux x86_64/aarch64, glibc and systemd.")
  if (!["debian", "ubuntu"].includes(destination.os.ID ?? "") && !(destination.os.ID === "linuxmint" && destination.os.UBUNTU_CODENAME === "noble")) blockers.push("Only Debian/Ubuntu and Ubuntu-noble-based Linux Mint use this audited apt/systemd recipe.")
  if (destination.uid === 0 || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(destination.user)) blockers.push("The SSH account must be a non-root Linux user.")
  for (const [path, value] of Object.entries(destination.ancestors)) if (value && (value.link || (value.mode & 0o022) || value.uid !== (path === stateDir ? destination.uid : 0))) blockers.push(`Unsafe installation ancestor ${path}; requires owned directories without group/other write or symlinks.`)
  for (const [path, value] of Object.entries(destination.files)) {
    const expected = path.match(/\.paddock-([a-f0-9]{64})$/)?.[1]
    if (expected && value.kind !== "absent" && !(value.kind === "file" && value.uid === 0 && value.sha256 === expected)) blockers.push(`Backup ${path} already exists with unsafe ownership, type or other bytes.`)
  }
  const link = destination.files["/usr/local/bin/paddock"]
  if (link?.kind !== "absent" && !(link?.kind === "link" && /^\/opt\/paddock\/releases\/[a-f0-9]{64}\/paddock$/.test(link.target) && link.uid === 0)) blockers.push("/usr/local/bin/paddock is unrelated or not root-owned; it will not be replaced.")
  const unitPath = `/etc/systemd/system/${service}`; const previousUnit = text(unitPath)
  if (previousUnit !== null && !previousUnit.startsWith("# Paddock enrollment v1\n")) blockers.push(`${unitPath} is not a Paddock enrollment unit; refusing replacement.`)
  const existingBinary = destination.files[binary]
  if (existingBinary?.kind !== "absent" && !(existingBinary?.kind === "file" && existingBinary.uid === 0 && existingBinary.sha256 === options.artifact.sha256)) blockers.push("The immutable release path already contains other bytes or an unsafe file.")
  const existingRuntime = destination.files[RUNTIME]
  if (existingRuntime?.kind !== "absent" && !(existingRuntime?.kind === "file" && existingRuntime.uid === 0 && existingRuntime.sha512 === (destination.arch === "aarch64" ? GVISOR_SHA512.aarch64 : GVISOR_SHA512.x86_64))) blockers.push("The immutable gVisor path is occupied by other bytes or an unsafe file.")
  const oldConfig = text("/etc/docker/daemon.json")
  let config = ""
  try { config = mergeRuntime(oldConfig, RUNTIME) } catch (error) { blockers.push((error as Error).message) }
  let restart = true
  try { const old: unknown = JSON.parse(oldConfig ?? "{}"); restart = !(object(old) && object(old.runtimes) && canonical(old.runtimes["paddock-runsc"]) === canonical({ path: RUNTIME, runtimeArgs: ["--allow-suid", "--overlay2=none"] })) } catch {}
  const prepared = destination.unit.out.includes("ActiveState=active") && destination.unit.out.includes("UnitFileState=enabled") && destination.unit.out.includes(`User=${destination.user}\n`) && destination.unit.out.includes(binary) && existingBinary?.kind === "file" && existingBinary.sha256 === options.artifact.sha256 && link?.kind === "link" && link.target === binary
  const reuse = options.sudo === "never" || prepared
  const inventory: string[] = []
  if (destination.docker.code === 0) {
    if (destination.containers.code !== 0) blockers.push("Cannot read every running container; Docker restart impact is unknown.")
    else for (const line of destination.containers.out.split("\n").filter(Boolean)) { const v: unknown = JSON.parse(line); if (!object(v) || typeof v.Names !== "string" || typeof v.ID !== "string") throw new PaddockError("dependency", "Invalid Docker container inventory."); inventory.push(`${v.Names} (${v.ID})`) }
  } else if (!destination.downloads.length && !reuse) blockers.push("Docker is installed but its local socket is not readable, or the apt recipe is unavailable. Prepare Docker access first; the probe never uses sudo.")
  if (inventory.some((name) => name.startsWith("sandbox-"))) blockers.push("The engine has a running sandbox-* container; enrollment refuses to change this engine.")
  if (!reuse) {
    uploads.push({ kind: "artifact", name: "paddock", algorithm: "sha256", checksum: options.artifact.sha256, source: options.artifact.path }, { kind: "download", name: "runsc", algorithm: "sha512", checksum: destination.arch === "aarch64" ? GVISOR_SHA512.aarch64 : GVISOR_SHA512.x86_64, url: `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${destination.arch}/runsc` })
    for (const d of destination.downloads) {
      if (!/^[a-zA-Z0-9_.%+~:-]+\.deb$/.test(d.file) || !/^https?:\/\//.test(d.url)) throw new PaddockError("dependency", "Invalid apt download metadata.")
      uploads.push({ kind: "download", name: d.file, algorithm: "sha256", checksum: d.sha256, url: d.url })
    }
    sudo("Create boot-accessible state", "install", "-d", "-m", "0700", "-o", String(destination.uid), "-g", String(destination.gid), stateDir, `${stateDir}/config`)
    if (destination.downloads.length) sudo("Install the exact checksum-verified distro Docker transaction", "env", "DEBIAN_FRONTEND=noninteractive", "dpkg", "--install", ...destination.downloads.map((d) => `${stageDir}/${d.file}`))
    sudo("Create immutable release directory", "install", "-d", "-m", "0755", `/opt/paddock/releases/${options.artifact.sha256}`, RUNTIME_DIR)
    sudo("Install verified Paddock binary", "install", "-m", "0755", `${stageDir}/paddock`, binary)
    sudo("Install pinned verified gVisor", "install", "-m", "0755", `${stageDir}/runsc`, RUNTIME)
    sudo("Select Paddock release", "ln", "-sfn", binary, "/usr/local/bin/paddock")
    if (restart && config) {
      sudo("Create Docker config directory", "install", "-d", "-m", "0755", "/etc/docker")
      if (oldConfig !== null) sudo("Back up Docker configuration", "cp", "--no-clobber", "--preserve=all", "/etc/docker/daemon.json", `/etc/docker/daemon.json.paddock-${sha256(oldConfig)}`)
      const source = change("/etc/docker/daemon.json", config)
      sudo("Validate merged Docker configuration", "dockerd", "--validate", "--config-file", source)
      sudo("Install merged Docker configuration", "install", "-m", "0644", source, "/etc/docker/daemon.json")
      sudo("Restart Docker; all listed containers may be interrupted", "systemctl", "restart", "docker")
    }
    const unit = `# Paddock enrollment v1\n[Unit]\nDescription=Paddock checked sandboxes for ${destination.user}\nRequires=docker.service\nAfter=docker.service\n\n[Service]\nType=simple\nUser=${destination.user}\nGroup=${destination.gid}\nSupplementaryGroups=docker\nEnvironment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nEnvironment=PADDOCK_STATE_DIR=${stateDir}\nEnvironment=PADDOCK_CONFIG_DIR=${stateDir}/config\nEnvironment=PADDOCK_SOCKET_ONLY=1\nWorkingDirectory=${stateDir}\nExecStart=${binary} daemon run\nRestart=on-failure\nRestartSec=3\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`
    if (previousUnit !== null && previousUnit !== unit) sudo("Back up prior service unit", "cp", "--no-clobber", "--preserve=all", unitPath, `${unitPath}.paddock-${sha256(previousUnit)}`)
    sudo("Install system service as SSH user", "install", "-m", "0644", change(unitPath, unit), unitPath)
    sudo("Reload service definitions", "systemctl", "daemon-reload")
    sudo("Enable service at boot", "systemctl", "enable", service)
    sudo(destination.unit.out.includes("ActiveState=active") ? "Restart the Paddock service" : "Start service", "systemctl", destination.unit.out.includes("ActiveState=active") ? "restart" : "start", service)
  } else {
    if (!destination.unit.out.includes(binary) || !destination.unit.out.includes("ActiveState=active") || !destination.unit.out.includes("UnitFileState=enabled") || !destination.unit.out.includes(`User=${destination.user}\n`) || existingBinary?.kind !== "file" || existingBinary.sha256 !== options.artifact.sha256 || link?.kind !== "link" || link.target !== binary)
      blockers.push(`--sudo never requires an already enabled system service as ${destination.user}, this verified artifact, and working Docker access. Owner setup: install the reviewed system unit at ${unitPath}, state ${stateDir}, SupplementaryGroups=docker, then systemctl daemon-reload and systemctl enable --now ${service}. No user unit is installed; lingering boot behavior is not measured.`)
  }
  const verification = { name: `enroll-${sha256(`${options.name}:${options.artifact.sha256}:${destination.machine}`).slice(0, 16)}`, image: IMAGE, helperImage: HELPER_IMAGE, helperDockerfile: HELPER_DOCKERFILE, cpus: 0.5, memoryGb: 0.5, diskGb: 1, pids: 256, docker: false as const, duration: "unknown" as const,
    operations: ["Handshake: version, source, protocol, artifact digest and socket-only systemd service", "Inspect enabled/active boot unit, account and engine readiness", "Create sandbox on gvisor:default; require every blocking check to pass", "Write 1 MiB and read host-side disk measurement; disk limit remains watched", "Remove the verification sandbox even on failure; register only after successful cleanup"] }
  const plan = { client, options, destination, stageDir, requestPath: `${stageDir}.json`, stateDir, binary, service, mode: reuse ? "reuse" as const : "install" as const, changes, uploads, steps, authentication: reuse ? [] : ["sudo", "-v"], restart: { required: !reuse && restart, containers: inventory.sort() }, packageRecipe: { repositories: destination.downloads.length ? destination.repositories : {}, repositoryHashes: destination.downloads.length ? destination.apt : {}, downloads: destination.downloads }, verification,
    warnings: ["Disk limit: watched. No hard disk helper, disk tools or sudoers rule is planned or installed.", "Docker access (SupplementaryGroups=docker) is effectively host-root authority. No login group membership is edited.", "All running containers may be interrupted by the planned restart, even with live restore.", "Verification builds the digest-pinned core helper and may pull the pinned sandbox image; no credentials are copied. Duration unknown.", "No rollback is automatic. Completed/possibly interrupted steps and residual files are reported; shared packages and data are retained.", "Reboot persistence is not measured. The service does not recover stopped sandboxes automatically.", "U6: explicit local ELF/checksum only; no signed release channel, implicit build or provenance beyond the supplied digest.", "Pinned gVisor is release-20251110.0 (single-file distribution); inner Docker is unavailable with this runtime (no --net-raw)."], blockers }
  return { hash: planHash(plan), ...plan }
}

type Terminal = { closed: boolean; child?: ChildProcessWithoutNullStreams; output: (bytes: Buffer) => void; drain: () => void; paused: boolean }
export class Hosts {
  private readonly plans = new Map<string, HostPlan>()
  private applying = false
  private readonly terminals = new Set<Session>()
  constructor(private readonly machines: Machines) {}
  async plan(body: Record<string, unknown>): Promise<HostPlan> {
    const options = enrollmentOptions(body)
    // Hash-check before SSH, and architecture-check again using the actual probe.
    const bytes = new Uint8Array(await Bun.file(options.artifact.path).arrayBuffer())
    if (sha256(bytes) !== options.artifact.sha256) throw new PaddockError("usage", "The local artifact checksum does not match --sha256. Nothing was uploaded or installed.")
    const destination = await probe(options)
    await verifyArtifact(options.artifact, destination.arch)
    const plan = installationPlan(options, destination, { version: this.machines.hello.version, sourceDigest: this.machines.hello.sourceDigest })
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(plan.hash, plan)
    return plan
  }
  async apply(body: Record<string, unknown>, terminal?: Terminal): Promise<HostRecord> {
    if (body.accepted !== true || !digest(body.hash)) throw new PaddockError("usage", "Apply needs accepted:true and the exact reviewed plan hash.")
    const old = this.plans.get(body.hash)
    if (!old) throw new PaddockError("conflict", "Unknown or expired plan. Request and review a new host plan; nothing was changed.")
    if (this.applying) throw new PaddockError("conflict", "Another enrollment is applying. Retry after it completes.")
    this.applying = true
    let completed: unknown = []; let installed = false
    try {
      const current = await this.plan(old.options)
      if (current.hash !== old.hash) throw new PaddockError("conflict", "Enrollment inputs changed. Consent is stale; review the revised plan and accept its hash. Nothing was installed.", { plan: current })
      if (current.blockers.length) throw new PaddockError("dependency", `Enrollment refused before installation: ${current.blockers.join(" ")}`, { plan: current, completed: [] })
      // Check the alias before touching the remote. attach checks it again when committing the registration.
      const registry = await readHosts(this.machines.dirs)
      if ([...registry.hosts, ...registry.unknown].some((host) => host.name === current.options.name)) throw new PaddockError("conflict", "The host alias is already registered. Nothing was installed.")
      const identity = current.destination.files[`${current.stateDir}/machine-id`]
      if (identity?.kind === "file" && [this.machines.hello, ...registry.hosts].some((host) => sha256(`${host.machineId}\n`) === identity.sha256)) throw new PaddockError("conflict", "This daemon identity is already registered. Nothing was installed.")
      if (current.mode === "install") {
        const bytes = await verifyArtifact(current.options.artifact, current.destination.arch)
        const applied = await this.install(current, bytes, terminal)
        let report: unknown
        try { report = JSON.parse(applied.stdout) } catch { throw new PaddockError("outcome-unknown", "Installation SSH ended without a journal response. Some reviewed changes may have happened; inspect the destination enrollment.json and planned files before retrying.", { completed, journal: `${current.stateDir}/enrollment.json`, plan: current }) }
        if (!object(report)) throw new PaddockError("runtime", "Invalid installation report.")
        if (report.stale === true) { const revised = await this.plan(current.options); throw new PaddockError("conflict", "Inputs changed during artifact delivery. Nothing installed; review the revised plan.", { plan: revised }) }
        completed = report.completed; installed = true
        if (report.ok !== true) throw new PaddockError("runtime", `Installation failed: ${String(report.error)}. Host unregistered.`, report)
      }
      if (terminal?.closed) throw new PaddockError("outcome-unknown", "Enrollment terminal disconnected. Installation may be partial; nothing was registered. Inspect the journal before retrying.")
      const endpoint: Endpoint = { ssh: current.options.ssh, binary: current.binary, stateDir: current.stateDir }
      await this.verify(endpoint, current)
      if (terminal?.closed) throw new PaddockError("outcome-unknown", "Enrollment terminal disconnected during verification. Nothing was registered.")
      return await this.machines.attach({ name: current.options.name, ...endpoint, service: "systemd" }, () => { if (terminal?.closed) throw new PaddockError("outcome-unknown", "The terminal disconnected before registration. Nothing was registered.") })
    } catch (error) {
      if (installed) throw new PaddockError(error instanceof PaddockError ? error.code : "runtime", `${(error as Error).message} Host is unregistered. Completed steps: ${JSON.stringify(completed)}. Interrupted step: ${error instanceof PaddockError && object(error.details) ? String(error.details.started ?? "none; see verification error") : "unknown"}. Installed files retained at: ${[old.binary, RUNTIME, "/usr/local/bin/paddock", "/etc/docker/daemon.json", `/etc/systemd/system/${old.service}`, old.stateDir].join(", ")}. Journal: ${old.stateDir}/enrollment.json. Verification may retain shared helper ${HELPER_IMAGE}, paddock_guard tables or diagnostic sandbox ${old.verification.name}; inspect before removal. No automatic rollback.`, { completed, cause: error instanceof PaddockError ? error.details : undefined, journal: `${old.stateDir}/enrollment.json`, residualObjects: [HELPER_IMAGE, "inet/bridge paddock_guard", old.verification.name], residualPaths: [old.binary, RUNTIME, "/usr/local/bin/paddock", "/etc/docker/daemon.json", `/etc/systemd/system/${old.service}`, old.stateDir] })
      throw error
    } finally { this.applying = false }
  }
  async session(hash: string): Promise<Session> {
    if (!this.plans.has(hash)) throw new PaddockError("conflict", "Unknown or expired enrollment plan. Request and review a new one.")
    const events = new EventEmitter()
    const terminal: Terminal = { closed: false, paused: false, output: (bytes) => events.emit("output", "stdout", bytes), drain: () => events.emit("drain") }
    const close = () => {
      terminal.closed = true; this.terminals.delete(session)
      terminal.child?.kill()
      const timer = setTimeout(() => terminal.child?.kill("SIGKILL"), 1500); timer.unref()
    }
    const session: Session = Object.assign(events, { tty: true, write: (bytes: Uint8Array) => terminal.child?.stdin.write(bytes) ?? true,
      end: () => terminal.child?.stdin.end(), resize: async () => {}, pause: () => { terminal.paused = true; terminal.child?.stdout.pause(); terminal.child?.stderr.pause() },
      resume: () => { terminal.paused = false; terminal.child?.stdout.resume(); terminal.child?.stderr.resume() }, close })
    this.terminals.add(session)
    setTimeout(() => {
      void this.apply({ hash, accepted: true }, terminal).then((host) => {
        if (!terminal.closed) { terminal.output(Buffer.from(`\r\nEnrolled ${host.name}. Disk limit is watched. Verification passed; reboot persistence is not measured.\r\n`)); events.emit("end", { code: 0 }) }
      }, (error) => {
        if (!terminal.closed) {
          if (error instanceof PaddockError && error.details !== undefined) terminal.output(Buffer.from(`${JSON.stringify(error.details, null, 2)}\r\n`))
          events.emit("end", { error: (error as Error).message })
        }
      }).finally(() => this.terminals.delete(session))
    }, 0)
    return session
  }
  close(): void { for (const session of this.terminals) session.close(); this.terminals.clear() }
  private async install(plan: HostPlan, bytes: Uint8Array, terminal?: Terminal): Promise<RunResult> {
    const input = JSON.stringify({ ...plan, interactive: Boolean(terminal), probeScript: HOST_PROBE, runtime: RUNTIME, artifactBytes: Buffer.from(bytes).toString("base64") })
    if (!terminal) return systemRunner(sshArgv(plan.options.ssh, ["python3", "-c", HOST_APPLY]), { stdin: input, timeoutMs: 20 * 60_000 })
    if (terminal.closed) throw new PaddockError("conflict", "Enrollment terminal closed before installation.")
    must(await systemRunner(sshArgv(plan.options.ssh, ["python3", "-c", HOST_REQUEST, plan.requestPath]), { stdin: input, timeoutMs: 120_000 }), "Staging the private enrollment request")
    if (terminal.closed) throw new PaddockError("outcome-unknown", `Terminal closed after staging ${plan.requestPath}. No installation was started; remove that staging file before retrying.`)
    const argv = sshArgv(plan.options.ssh, ["python3", "-c", HOST_APPLY, plan.requestPath]); argv[1] = "-tt"
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] }); terminal.child = child
    child.stdin.on("error", () => {}); child.stdin.on("drain", terminal.drain)
    let output = ""; let size = 0
    const collect = (bytes: Buffer) => { size += bytes.length; if (size > 1024 ** 2) { child.kill(); return }; output += bytes.toString(); terminal.output(bytes) }
    child.stdout.on("data", collect); child.stderr.on("data", collect)
    if (terminal.paused) { child.stdout.pause(); child.stderr.pause() }
    const timeout = setTimeout(() => child.kill(), 20 * 60_000)
    let code: number | null
    try { code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) }) } finally { clearTimeout(timeout); terminal.child = undefined }
    const marker = output.lastIndexOf("PADDOCK-RESULT ")
    return { exitCode: code ?? 1, stdout: marker < 0 ? "" : output.slice(marker + 15).split(/\r?\n/)[0]!, stderr: "" }
  }
  private async verify(endpoint: Endpoint, plan: HostPlan): Promise<void> {
    const peer = new HttpPeer(endpoint)
    const spec = plan.verification; let created = false
    const call = (method: string, body: object = {}) => peer.call(method, body, { mutation: ["create", "remove", "exec", "verify"].includes(method), timeoutMs: 300_000 })
    try {
      // systemctl start can return before the service has opened its socket.
      let hello: Hello | undefined
      for (let at = 0; at < 30; at++) {
        const check = new HttpPeer(endpoint)
        try { hello = parseHello(await check.call("hello", {}, { timeoutMs: 5000 })); break } catch { await new Promise((resolve) => setTimeout(resolve, 500)) } finally { await check.close() }
      }
      if (!hello) throw new PaddockError("dependency", "The installed daemon did not answer within the startup budget.")
      compatible(hello, this.machines.hello)
      if (hello.buildDigest !== plan.options.artifact.sha256 || hello.service !== "systemd" || hello.listener !== "socket-only") throw new PaddockError("incompatible", "Service artifact digest, supervisor or socket-only listener does not match the approved installation.")
      const unit = must(await systemRunner(sshArgv(endpoint.ssh, ["systemctl", "show", plan.service, "--property=ActiveState,UnitFileState,User,SupplementaryGroups,ExecStart"])), "Inspecting the boot service")
      for (const expected of ["ActiveState=active", "UnitFileState=enabled", `User=${plan.destination.user}`, "SupplementaryGroups=docker", plan.binary]) if (!unit.stdout.includes(expected)) throw new PaddockError("dependency", `Boot-service inspection did not show ${expected}.`)
      const engines = await call("engines")
      if (!Array.isArray(engines) || !engines.some((e) => object(e) && e.id === "gvisor:default" && e.ready === true && object(e.capabilities) && e.capabilities.diskLimit === "watched")) throw new PaddockError("dependency", "The installed service has no ready local Docker/gVisor engine with watched disk measurement.")
      const existing = await call("list")
      if (!Array.isArray(existing) || existing.some((s) => object(s) && s.name === spec.name)) throw new PaddockError("conflict", "The smoke sandbox name already exists. It was not touched.")
      const { duration: _duration, operations: _operations, helperImage: _helper, helperDockerfile: _dockerfile, ...input } = spec
      const made = await call("create", { ...input, engine: "gvisor:default" })
      created = true
      if (!object(made) || !Array.isArray(made.checks)) throw new PaddockError("check-failed", "No smoke verification evidence.")
      for (const item of CHECKLIST.filter((item) => item.blocking)) if (!made.checks.some((c: unknown) => object(c) && c.id === item.id && (c.status === "pass" || item.id === "docker" && c.status === "info"))) throw new PaddockError("check-failed", `Enrollment smoke check ${item.id} did not pass.`)
      const write = await call("exec", { name: spec.name, argv: ["dd", "if=/dev/zero", "of=/paddock-disk-probe", "bs=1048576", "count=1"] })
      if (!object(write) || write.exitCode !== 0) throw new PaddockError("check-failed", "Smoke disk write failed.")
      const verified = await call("verify", { name: spec.name })
      if (!object(verified) || typeof verified.diskUsedBytes !== "number" || verified.diskUsedBytes < 1048576 || !Array.isArray(verified.checks) || !verified.checks.some((c: unknown) => object(c) && c.id === "disk" && c.status === "weak")) throw new PaddockError("check-failed", "Smoke disk use was not measured as watched.")
    } finally {
      try { if (created) await call("remove", { name: spec.name, confirm: spec.name }) } finally { await peer.close() }
    }
  }
}
