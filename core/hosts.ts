import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { CHECKLIST } from "./checks"
import { HOST_APPLY, HOST_PROBE, HOST_REQUEST, HOST_ROOT_STEP } from "./host-scripts"
import { compatible, hostName, parseHello, readHosts, type Hello, type HostRecord, type Machines } from "./machines"
import { HELPER_IMAGE, MANAGED_RUNTIME } from "./providers/gvisor"
import HELPER_DOCKERFILE from "./providers/helper.Dockerfile" with { type: "text" }
import { systemRunner, must } from "./run"
import { hostKeyCapture, HttpPeer, keyFingerprint, object, pinnedKnownHosts, shellQuote, sshArgv, sshDestination, type Endpoint } from "./transport"
import { PaddockError, type ErrorCode, type Session, type RunResult } from "./types"

// The one gVisor release enrollment installs. Its archive is checked against the SHA-512 the release publishes, and
// every file taken from it against the SHA-256 recorded here. It is the release the Mac scorecard measures. The last
// release published as a single file, 20251110.0, cannot run inner Docker: its overlay mount fails (measured on
// Ubuntu 24.04 arm64 with Docker 29).
export const GVISOR_RELEASE = "20261026.0"
export const GVISOR = {
  aarch64: {
    archive: "da177d9bcfd9ac23899ecfedc6fd47358e9684a1f7e3f5f8ffb8bf7c0ca65f4c08730c0c503b9231b522db28b04c132a06d04d6719e0d8c04c9f82edaf03d8ae",
    files: {
      "containerd-shim-runsc-v1": "a582d38e902ba3a1e7cd2ff94814481a89b0703a1ebfc7a34f4c4009d0f8c157",
      "runsc": "4f72639020312f6beeacc08f9421f2de75ec2c7992b19aedb2f2ffd1d489639c",
      "gvisor-bin/checkpointgofer": "9b134d6b420568d122ead8cf1485b64c5954edea656731050e23c8e3cda7c3b6",
      "gvisor-bin/gvisor-proc-umounter": "8ddecb8894b332be68e84faa073c073bbf1d6f046974d411fc02db03a73fde90",
      "gvisor-bin/gvisor-sentry-prewarmer": "3ac0099cc7492865a44a1c871fb3cf8b64e58aba773ece13fc9c0421d8375848",
      "gvisor-bin/gvisor_sentry": "7490b9cba6f00dd6622303e2ef014dae397f28184682a3551553a389d16d2ccc",
      "gvisor-bin/runsc-fd-parking": "e41db2da554154f282f2829a664a2c4234c163b9da74fc9b4388126223c7090c",
      "gvisor-bin/runsc-metric-server": "43fe2363548418564f349db14d02574faebe6c2a177cc1aee34c9d1f4e482918",
    },
  },
  x86_64: {
    archive: "26e4a327565f5da0f73261a6387e2c20f4695a232e330095a3111b70efd604fdf09d734e8cc8f714dbb5c5607ce8c87ea80b26df549d83a146f2efd5a1af448a",
    files: {
      "containerd-shim-runsc-v1": "b6885a92cd36ad7a1f8c603930c63164731240408ac9614517260ca542331074",
      "runsc": "7d658f2c3a5602d28c391285eb4ee0740e7dd21d40731324049a29620e51cf5e",
      "gvisor-bin/checkpointgofer": "a7e56d07b675aa0278d8dae690fcdaadf0b7b40dc14a0c014b93bb5c448e22fa",
      "gvisor-bin/gvisor-proc-umounter": "b3bbbaef5ddc62084e5febd19d3acca14f3d42b2a25d8552fb40def699467019",
      "gvisor-bin/gvisor-sentry-prewarmer": "46d5c028723ac5fbe40b863f95100f15a00d2aa0cd39c69d892500a988c930bd",
      "gvisor-bin/gvisor_sentry": "e7aba569a4b46b5382c5f0722e8555005f1f3aa1390c54403483d42379fae09b",
      "gvisor-bin/runsc-fd-parking": "03af90d07ea466c10ecc3e3ba839b2a59540959dd3286aea3886917cba850c11",
      "gvisor-bin/runsc-metric-server": "24b5762dc5a060657dd8581bd008fe3a338dbcb9a055ccfba0e0f9145337617b",
    },
  },
} as const
// Both architectures' archives hold the same file names, so the paths to read are known before the probe says which.
export const GVISOR_FILES = Object.keys(GVISOR.aarch64.files) as Array<keyof typeof GVISOR.aarch64.files>
const RUNTIME_DIR = `/opt/paddock/gvisor/${GVISOR_RELEASE}`
const RUNTIME = `${RUNTIME_DIR}/runsc`
// How Docker is told to start gVisor. --overlay2=none is what lets the disk watch see a sandbox's writes; --net-raw is
// added only for a host enrolled with inner Docker, whose NAT needs gVisor's raw sockets.
export const runtimeArgs = (docker: boolean) => ["--allow-suid", "--overlay2=none", ...(docker ? ["--net-raw"] : [])]
// The smoke sandbox's image. With inner Docker it is one that has dockerd, the docker client and iptables-legacy.
const IMAGE = "alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a"
const DOCKER_IMAGE = "docker:29.9.3-dind@sha256:08a98015fce594af7c382883bea080ea206de74402a95da9dc52b6428c8cd121"

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

export type EnrollmentOptions = {
  name: string
  ssh: string
  sudo: "ask" | "never"
  diskPolicy: "watched"
  // Register gVisor so that sandboxes on this host can run Docker inside.
  docker: boolean
  artifact: { path: string; sha256: string }
}

export function enrollmentOptions(body: Record<string, unknown>): EnrollmentOptions {
  if (body.sudo !== undefined && body.sudo !== "ask" && body.sudo !== "never") throw new PaddockError("usage", "--sudo must be ask or never.")
  if (body.diskPolicy !== undefined && body.diskPolicy !== "watched")
    throw new PaddockError("usage", "Enrollment supports --disk-policy watched only. Hard disks and disk tools are stage 1d and are not installed.")
  if (body.docker !== undefined && typeof body.docker !== "boolean") throw new PaddockError("usage", "docker must be true or false.")
  if (!object(body.artifact) || typeof body.artifact.path !== "string" || !digest(body.artifact.sha256))
    throw new PaddockError("usage", "Give --artifact PATH and --sha256 HASH from an explicitly trusted local build. No release channel exists.")
  return {
    name: hostName(body.name), ssh: sshDestination(body.ssh), sudo: body.sudo ?? "ask", diskPolicy: "watched", docker: body.docker ?? false,
    artifact: { path: resolve(body.artifact.path), sha256: body.artifact.sha256 },
  }
}

// One spelling for a value whatever order its keys were written in, so equal plans hash the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
// Ctrl-C cancels enrollment only while no remote terminal is attached; an attached one receives the byte itself.
export const enrollmentInterrupt = (bytes: Uint8Array, attached: boolean) => !attached && bytes.includes(3)
export const planHash = (value: unknown) => sha256(canonical(value))

export async function verifyArtifact(artifact: EnrollmentOptions["artifact"], arch: string): Promise<Uint8Array> {
  const data = new Uint8Array(await Bun.file(artifact.path).arrayBuffer())
  if (sha256(data) !== artifact.sha256) throw new PaddockError("usage", "The local Paddock artifact checksum does not match --sha256. Nothing was uploaded or installed.")
  // ELF header: magic, 64-bit, little-endian, and the machine field (183 is aarch64, 62 is x86_64).
  const machine = data[18]! | data[19]! << 8
  if (data.length < 64 || Buffer.from(data.slice(0, 4)).toString("hex") !== "7f454c46" || data[4] !== 2 || data[5] !== 1 || machine !== (arch === "aarch64" ? 183 : 62))
    throw new PaddockError("usage", `The artifact must be a native Linux 64-bit ELF for ${arch}. Build it explicitly; host add never cross-compiles.`)
  return data
}

// daemon.json with Paddock's runtime added. Every other setting, and every other runtime, is kept, and so is the file's
// own indentation, so that the diff shows the addition and not a reformatting.
export function mergeRuntime(before: string | null, path: string, docker = false): string {
  const config: unknown = before === null ? {} : JSON.parse(before)
  if (!object(config) || (config.runtimes !== undefined && !object(config.runtimes))) throw new PaddockError("usage", "Docker daemon.json and runtimes must be JSON objects.")
  const runtimes = { ...(object(config.runtimes) ? config.runtimes : {}), [MANAGED_RUNTIME]: { path, runtimeArgs: runtimeArgs(docker) } }
  const indent = before?.match(/^\s*\{\r?\n([ \t]+)"/)?.[1] ?? "  "
  return `${JSON.stringify({ ...config, runtimes }, null, indent)}\n`
}

// A line diff of a whole file: unchanged lines keep a leading space, removed lines begin "-" and added lines "+".
export function lineDiff(path: string, before: string | null, after: string): string {
  const header = `--- ${path} (${before === null ? "absent" : "before"})\n+++ ${path} (after)\n`
  const lines = (text: string) => text.replace(/\n$/, "").split("\n")
  const old = before === null ? [] : lines(before); const now = lines(after)
  if (old.length * now.length > 4_000_000)
    return `${header}(Too long for a line diff: ${old.length} lines before, ${now.length} after. The plan's before and after hold the full text.)\n`
  // The longest common subsequence, filled from the end so that the walk below reads forward.
  const common = Array.from({ length: old.length + 1 }, () => new Uint32Array(now.length + 1))
  for (let a = old.length - 1; a >= 0; a--)
    for (let b = now.length - 1; b >= 0; b--)
      common[a]![b] = old[a] === now[b] ? common[a + 1]![b + 1]! + 1 : Math.max(common[a + 1]![b]!, common[a]![b + 1]!)
  const out: string[] = []; let a = 0; let b = 0
  while (a < old.length || b < now.length) {
    if (a < old.length && b < now.length && old[a] === now[b]) { out.push(` ${old[a]}`); a++; b++ }
    else if (a < old.length && (b === now.length || common[a + 1]![b]! >= common[a]![b + 1]!)) out.push(`-${old[a++]}`)
    else out.push(`+${now[b++]}`)
  }
  return `${header}${out.join("\n")}\n`
}

// The system unit enrollment installs. It runs the daemon as the SSH account, with Docker's group and no dashboard.
export function serviceUnit(user: string, gid: number, stateDir: string, binary: string): string {
  return [
    "# Paddock enrollment v1",
    "[Unit]",
    `Description=Paddock checked sandboxes for ${user}`,
    "Requires=docker.service",
    "After=docker.service",
    "",
    "[Service]",
    "Type=simple",
    `User=${user}`,
    `Group=${gid}`,
    "SupplementaryGroups=docker",
    "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    `Environment=PADDOCK_STATE_DIR=${stateDir}`,
    `Environment=PADDOCK_CONFIG_DIR=${stateDir}/config`,
    "Environment=PADDOCK_SOCKET_ONLY=1",
    `WorkingDirectory=${stateDir}`,
    `ExecStart=${binary} daemon run`,
    "Restart=on-failure",
    "RestartSec=3",
    "UMask=0077",
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n")
}

// `systemctl show` prints one Property=value per line, and whole lines are compared: "enabled-runtime" (gone at the next
// boot) is not "enabled", and an account or executable that only begins with the expected text is another one.
export function serviceMatches(output: string, user: string, binary: string): boolean {
  return serviceRuns(output, user, binary) && output.split("\n").includes("UnitFileState=enabled")
}
// The running half of that: the service is up as this account with this executable, whatever happens at the next boot.
function serviceRuns(output: string, user: string, binary: string): boolean {
  const lines = output.split("\n")
  return ["ActiveState=active", `User=${user}`, "SupplementaryGroups=docker"].every((line) => lines.includes(line))
    && lines.some((line) => line.startsWith(`ExecStart={ path=${binary} ; argv[]=${binary} daemon run ;`))
}

// ---- what the read-only probe reports

type Command = { code: number; out: string; err: string }
type FileState = { kind: "absent" }
  | { kind: "link"; target: string; uid: number; mode: number }
  | { kind: "file"; sha256: string; sha512: string; text: string | null; uid: number; mode: number }
  | { kind: "other"; uid: number; mode: number }
  | { kind: "unreadable"; error: string }
type Download = { url: string; file: string; bytes: string; sha256: string; package: string; version: string }
export type HostProbe = {
  system: string; arch: string; libc: string[]; uid: number; gid: number; user: string; home: string
  machine: string; boot: string; systemd: boolean; os: Record<string, string>
  docker: Command; containers: Command
  packages: Command; downloads: Download[]; apt: Record<string, string>; repositories: Record<string,string>
  files: Record<string, FileState>; ancestors: Record<string, { uid: number; mode: number; link: boolean } | null>
  unit: Command; dockerGroup: Command; lingering: Command
  hostKey: string; hostPublicKey: string
}

const strings = (v: unknown): v is Record<string, string> => object(v) && Object.values(v).every((v) => typeof v === "string")
const command = (v: unknown): v is Command => object(v) && Number.isInteger(v.code) && typeof v.out === "string" && typeof v.err === "string"
const file = (v: unknown): v is FileState => object(v) && (
  v.kind === "absent"
  || v.kind === "unreadable" && typeof v.error === "string"
  || Number.isInteger(v.uid) && Number.isInteger(v.mode) && (
    v.kind === "other"
    || v.kind === "link" && typeof v.target === "string"
    || v.kind === "file" && digest(v.sha256) && typeof v.sha512 === "string" && (v.text === null || typeof v.text === "string")
  )
)
function isProbe(v: unknown): v is HostProbe {
  return object(v) && [v.system,v.arch,v.user,v.home,v.machine,v.boot,v.hostKey,v.hostPublicKey].every((v) => typeof v === "string")
    && Number.isSafeInteger(v.uid) && Number.isSafeInteger(v.gid) && typeof v.systemd === "boolean"
    && strings(v.os) && Array.isArray(v.libc) && v.libc.every((v) => typeof v === "string") && strings(v.apt) && strings(v.repositories)
    && [v.docker,v.containers,v.packages,v.unit,v.dockerGroup,v.lingering].every(command)
    && object(v.files) && Object.values(v.files).every(file)
    && object(v.ancestors) && Object.values(v.ancestors).every((v) => v === null || object(v) && Number.isInteger(v.uid) && Number.isInteger(v.mode) && typeof v.link === "boolean")
    && Array.isArray(v.downloads) && v.downloads.every((d) => object(d) && [d.url,d.file,d.bytes,d.package,d.version].every((v) => typeof v === "string") && digest(d.sha256))
}

// What the probe is asked to read: the release path of this artifact and every file of the pinned gVisor.
const probeRequest = (options: EnrollmentOptions) => ({ sha256: options.artifact.sha256, runtimeFiles: GVISOR_FILES.map((name) => `${RUNTIME_DIR}/${name}`) })

async function probe(options: EnrollmentOptions): Promise<HostProbe> {
  const capture = hostKeyCapture(options.ssh)
  try {
    const result = must(
      await systemRunner(sshArgv(options.ssh, ["python3", "-c", HOST_PROBE], capture.options), { stdin: JSON.stringify(probeRequest(options)), timeoutMs: 90_000 }),
      "Read-only enrollment probe (requires Python 3, established SSH trust and readable Docker inventory)",
    )
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch {
      throw new PaddockError("dependency", `The read-only probe did not print its evidence; it printed ${JSON.stringify(result.stdout.slice(0, 200))}. A login script on ${options.ssh} that prints to a non-interactive session causes this. Nothing was installed.`)
    }
    const hostPublicKey = capture.read(result.exitCode)
    const bound = object(value) ? { ...value, hostKey: keyFingerprint(hostPublicKey), hostPublicKey } : undefined
    if (!isProbe(bound)) throw new PaddockError("dependency", "The read-only probe returned incomplete evidence. Nothing was installed.")
    return bound
  } finally { capture.remove() }
}

// After consent, every command goes only to the host key the plan names.
async function pinned<T>(plan: HostPlan, run: (options: string[]) => Promise<T>): Promise<T> {
  const pin = pinnedKnownHosts(plan.destination.hostPublicKey)
  try { return await run(pin.options) } finally { pin.remove() }
}

// ---- the plan: everything an installation would do, decided from the probe alone

// One privileged command, and what it leaves on the host once it has run.
type Step = { label: string; argv: string[]; leaves: string[] }
type Change = { path: string; before: string | null; beforeSha256: string | null; after: string | null; sha256: string | null; diff: string; staged: string }
// extract: the download is an archive; exactly these files are taken from it, each checked against its SHA-256.
type Upload = { kind: "artifact"; name: string; algorithm: "sha256"; checksum: string; source: string }
  | { kind: "download"; name: string; algorithm: "sha256" | "sha512"; checksum: string; url: string; extract?: { directory: string; files: Record<string, string> } }
export type HostPlan = {
  hash: string
  client: Pick<Hello, "version" | "sourceDigest">
  options: EnrollmentOptions
  destination: HostProbe
  stageDir: string; requestPath: string; stateDir: string; binary: string; service: string
  mode: "install" | "update" | "reuse"
  previousHost: HostRecord | null
  runtime: { name: string; release: string; path: string; runtimeArgs: string[]; innerDocker: boolean }
  changes: Change[]; uploads: Upload[]; steps: Step[]
  authentication: string[]
  // required: Docker restarts, which may interrupt every container listed. service: the Paddock service restarts, which
  // stops the running sandboxes listed.
  restart: { required: boolean; containers: string[]; service: boolean; sandboxes: string[] }
  packageRecipe: { repositories: Record<string,string>; repositoryHashes: Record<string,string>; downloads: Download[] }
  verification: {
    name: string; image: string; helperImage: string; helperDockerfile: string
    cpus: number; memoryGb: number; diskGb: number; pids: number; docker: boolean
    duration: "unknown"; operations: string[]
  }
  warnings: string[]; blockers: string[]
}

export function installationPlan(options: EnrollmentOptions, destination: HostProbe, client: Pick<Hello, "version" | "sourceDigest">, previousHost: HostRecord | null = null): HostPlan {
  const stateDir = `/var/lib/paddock/${destination.uid}`
  if (previousHost && (previousHost.hostPublicKey !== destination.hostPublicKey
    || !previousHost.hostPublicKey || previousHost.stateDir !== stateDir
    || !identityRegistered(destination.files[`${stateDir}/machine-id`], [previousHost.machineId])))
    throw new PaddockError("identity-changed", `${options.name} is registered to another machine, SSH host key or state directory. Nothing was installed. Inspect the destination; remove and enroll explicitly only if you intend to replace it.`)
  const releaseDir = `/opt/paddock/releases/${options.artifact.sha256}`; const binary = `${releaseDir}/paddock`
  const service = `paddock@${destination.uid}.service`
  const stageDir = "@PADDOCK_STAGE@"
  const gvisor = GVISOR[destination.arch === "aarch64" ? "aarch64" : "x86_64"]
  const entry = { path: RUNTIME, runtimeArgs: runtimeArgs(options.docker) }
  const changes: Change[] = []; const steps: Step[] = []; const uploads: Upload[] = []
  // installing: what stops an installation, and does not stop the reuse of one that is already complete.
  const blockers: string[] = []; const installing: string[] = []
  const sudo = (label: string, leaves: string[], ...argv: string[]) => steps.push({ label, argv: ["sudo", "-n", ...argv], leaves })
  const text = (path: string): string | null => {
    const f = destination.files[path]
    if (f?.kind === "file") return f.text
    if (f?.kind !== "absent") blockers.push(`Cannot safely read ${path} (${f?.kind ?? "missing evidence"}).`)
    return null
  }
  // Records a file to write and returns the staged copy a step installs from.
  const change = (path: string, after: string) => {
    const before = text(path); const staged = `file-${changes.length}`; const old = destination.files[path]
    changes.push({ path, before, beforeSha256: old?.kind === "file" ? old.sha256 : null, after, sha256: sha256(after), diff: lineDiff(path, before, after), staged })
    return `${stageDir}/${staged}`
  }
  // A file an earlier installation put in place: root's, written by root alone, with exactly the expected bytes.
  const intact = (path: string, expected: string) => {
    const f = destination.files[path]
    return f?.kind === "file" && f.uid === 0 && (f.mode & 0o022) === 0 && f.sha256 === expected
  }

  // The machine, the account and the installation layout.
  if (destination.system !== "Linux" || !["aarch64", "x86_64"].includes(destination.arch) || !destination.systemd || destination.libc[0] !== "glibc")
    blockers.push("Requires native Linux x86_64/aarch64, glibc and systemd.")
  if (!["debian", "ubuntu"].includes(destination.os.ID ?? "") && !(destination.os.ID === "linuxmint" && destination.os.UBUNTU_CODENAME === "noble"))
    installing.push("Only Debian/Ubuntu and Ubuntu-noble-based Linux Mint use this audited apt/systemd recipe.")
  if (destination.uid === 0 || !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(destination.user)) blockers.push("The SSH account must be a non-root Linux user.")
  for (const [path, value] of Object.entries(destination.ancestors))
    if (value && (value.link || (value.mode & 0o022) || value.uid !== (path === stateDir ? destination.uid : 0)))
      blockers.push(`Unsafe installation ancestor ${path}; requires owned directories without group/other write or symlinks.`)
  for (const [path, value] of Object.entries(destination.files)) {
    const expected = path.match(/\.paddock-([a-f0-9]{64})$/)?.[1]
    if (expected && value.kind !== "absent" && !(value.kind === "file" && value.uid === 0 && value.sha256 === expected))
      installing.push(`Backup ${path} already exists with unsafe ownership, type or other bytes.`)
  }

  // What is already at each path an installation writes. Anything Paddock did not put there is refused, not replaced.
  const stateIdentity = destination.files[`${stateDir}/machine-id`]
  if (stateIdentity && stateIdentity.kind !== "absent" && !(stateIdentity.kind === "file" && /^[a-f0-9]{32}$/.test(stateIdentity.text?.trim() ?? "")))
    blockers.push("The existing Paddock machine identity is damaged or indirect. Restore it before enrollment.")
  const link = destination.files["/usr/local/bin/paddock"]
  if (link?.kind !== "absent" && !(link?.kind === "link" && /^\/opt\/paddock\/releases\/[a-f0-9]{64}\/paddock$/.test(link.target) && link.uid === 0))
    blockers.push("/usr/local/bin/paddock is unrelated or not root-owned; it will not be replaced.")
  const linked = link?.kind === "link" && link.target === binary
  const unitPath = `/etc/systemd/system/${service}`; const previousUnit = text(unitPath)
  if (previousUnit !== null && !previousUnit.startsWith("# Paddock enrollment v1\n")) blockers.push(`${unitPath} is not a Paddock enrollment unit; refusing replacement.`)
  const unit = serviceUnit(destination.user, destination.gid, stateDir, binary)
  const binaryInstalled = intact(binary, options.artifact.sha256)
  if (destination.files[binary]?.kind !== "absent" && !binaryInstalled) blockers.push("The immutable release path already contains other bytes or an unsafe file.")
  const runtimeMissing = GVISOR_FILES.filter((name) => !intact(`${RUNTIME_DIR}/${name}`, gvisor.files[name]))
  for (const name of runtimeMissing)
    if (destination.files[`${RUNTIME_DIR}/${name}`]?.kind !== "absent") blockers.push(`The immutable gVisor path ${RUNTIME_DIR}/${name} is occupied by other bytes or an unsafe file.`)

  // Docker's configuration is rewritten only when its file does not already hold this exact runtime entry, and Docker
  // restarts only when it has to read that file again: the entry is new, or Docker is running without it.
  const oldConfig = text("/etc/docker/daemon.json")
  let config = ""; let registered = false; let hadRawNetwork = false
  try {
    config = mergeRuntime(oldConfig, RUNTIME, options.docker)
    const old: unknown = JSON.parse(oldConfig ?? "{}")
    const previous: unknown = object(old) && object(old.runtimes) ? old.runtimes[MANAGED_RUNTIME] : undefined
    registered = canonical(previous) === canonical(entry)
    hadRawNetwork = object(previous) && Array.isArray(previous.runtimeArgs) && previous.runtimeArgs.includes("--net-raw")
  } catch (error) { installing.push(`/etc/docker/daemon.json cannot be merged: ${(error as Error).message}`) }
  let loaded = false
  try {
    const info: unknown = destination.docker.code === 0 ? JSON.parse(destination.docker.out) : undefined
    const running: unknown = object(info) && object(info.Runtimes) ? info.Runtimes[MANAGED_RUNTIME] : undefined
    loaded = object(running) && running.path === RUNTIME && canonical(running.runtimeArgs) === canonical(entry.runtimeArgs)
  } catch {}
  const restartDocker = !(registered && loaded)

  // An installation that is already complete is reused, and `--sudo never` accepts nothing else.
  const unitLines = destination.unit.out.split("\n")
  const serviceCurrent = serviceMatches(destination.unit.out, destination.user, binary) && previousUnit === unit
  const prepared = serviceCurrent && binaryInstalled && linked && runtimeMissing.length === 0 && registered && loaded
  const reuse = options.sudo === "never" || prepared

  // Every running container, because a Docker restart may interrupt each one. Ownership labels distinguish sandboxes
  // from unrelated containers and Paddock's probe helpers, regardless of their names.
  const inventory: string[] = []; const sandboxes: string[] = []
  if (destination.docker.code === 0) {
    if (destination.containers.code !== 0) installing.push("Cannot read every running container; Docker restart impact is unknown.")
    else for (const line of destination.containers.out.split("\n").filter(Boolean)) {
      let v: unknown
      try { v = JSON.parse(line) } catch { throw new PaddockError("dependency", "Invalid Docker container inventory. Nothing was installed; repeat the read-only plan probe.") }
      if (!object(v) || typeof v.Names !== "string" || typeof v.ID !== "string") throw new PaddockError("dependency", "Invalid Docker container inventory.")
      inventory.push(`${v.Names} (${v.ID})`)
      const labels = new Map(typeof v.Labels === "string" ? v.Labels.split(",").map((label) => [label.slice(0, label.indexOf("=")), label.slice(label.indexOf("=") + 1)]) : [])
      if (/^[a-f0-9]{32}$/.test(labels.get("dev.paddock.id") ?? "") && /^[a-z0-9][a-z0-9-]{0,30}$/.test(labels.get("dev.paddock.name") ?? "")) sandboxes.push(`${v.Names} (${v.ID})`)
    }
  } else if (!destination.downloads.length)
    installing.push("Docker is installed but its local socket is not readable, or the apt recipe is unavailable. Prepare Docker access first; the probe never uses sudo.")
  inventory.sort(); sandboxes.sort()

  let restartService = false
  if (!reuse) {
    blockers.push(...installing)
    sudo("Create boot-accessible state", [stateDir, `${stateDir}/config`], "install", "-d", "-m", "0700", "-o", String(destination.uid), "-g", String(destination.gid), stateDir, `${stateDir}/config`)
    if (destination.downloads.length) {
      for (const d of destination.downloads) {
        if (!/^[a-zA-Z0-9_.%+~:-]+\.deb$/.test(d.file) || !/^https?:\/\//.test(d.url)) throw new PaddockError("dependency", "Invalid apt download metadata.")
        uploads.push({ kind: "download", name: d.file, algorithm: "sha256", checksum: d.sha256, url: d.url })
      }
      sudo("Install the exact checksum-verified distro Docker transaction", destination.downloads.map((d) => `package ${d.package} ${d.version}`),
        "env", "DEBIAN_FRONTEND=noninteractive", "dpkg", "--install", ...destination.downloads.map((d) => `${stageDir}/${d.file}`))
    }
    if (!binaryInstalled) {
      uploads.push({ kind: "artifact", name: "paddock", algorithm: "sha256", checksum: options.artifact.sha256, source: options.artifact.path })
      sudo("Create immutable release directory", [releaseDir], "install", "-d", "-m", "0755", releaseDir)
      sudo("Install verified Paddock binary", [binary], "install", "-m", "0755", `${stageDir}/paddock`, binary)
    }
    if (runtimeMissing.length) {
      uploads.push({
        kind: "download", name: "gvisor.tar.bz2", algorithm: "sha512", checksum: gvisor.archive,
        url: `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/${destination.arch}/gvisor.tar.bz2`,
        extract: { directory: "gvisor", files: gvisor.files },
      })
      // One directory at a time: `install -t` puts the files it is given into one directory.
      const directories = [...new Set(GVISOR_FILES.map((name) => name.split("/").slice(0, -1).join("/")))]
      const target = (directory: string) => directory ? `${RUNTIME_DIR}/${directory}` : RUNTIME_DIR
      sudo("Create immutable gVisor directories", directories.map(target), "install", "-d", "-m", "0755", ...directories.map(target))
      for (const directory of directories) {
        const names = GVISOR_FILES.filter((name) => name.split("/").slice(0, -1).join("/") === directory)
        sudo(`Install pinned verified gVisor${directory ? ` (${directory})` : ""}`, names.map((name) => `${RUNTIME_DIR}/${name}`),
          "install", "-m", "0755", "-t", target(directory), ...names.map((name) => `${stageDir}/gvisor/${name}`))
      }
    }
    if (!linked) sudo("Select Paddock release", ["/usr/local/bin/paddock"], "ln", "-sfn", binary, "/usr/local/bin/paddock")
    if (!registered && config) {
      sudo("Create Docker config directory", ["/etc/docker"], "install", "-d", "-m", "0755", "/etc/docker")
      if (oldConfig !== null) {
        const backup = `/etc/docker/daemon.json.paddock-${sha256(oldConfig)}`
        sudo("Back up Docker configuration", [backup], "cp", "--no-clobber", "--preserve=all", "/etc/docker/daemon.json", backup)
      }
      const source = change("/etc/docker/daemon.json", config)
      sudo("Validate merged Docker configuration", [], "dockerd", "--validate", "--config-file", source)
      sudo("Install merged Docker configuration", ["/etc/docker/daemon.json"], "install", "-m", "0644", source, "/etc/docker/daemon.json")
    }
    if (restartDocker) sudo("Restart Docker; all listed containers may be interrupted", ["Docker restarted"], "systemctl", "restart", "docker")
    if (previousUnit !== unit) {
      if (previousUnit !== null) {
        const backup = `${unitPath}.paddock-${sha256(previousUnit)}`
        sudo("Back up prior service unit", [backup], "cp", "--no-clobber", "--preserve=all", unitPath, backup)
      }
      sudo("Install system service as SSH user", [unitPath], "install", "-m", "0644", change(unitPath, unit), unitPath)
      sudo("Reload service definitions", [], "systemctl", "daemon-reload")
    }
    if (!unitLines.includes("UnitFileState=enabled")) sudo("Enable service at boot", [`${service} enabled at boot`], "systemctl", "enable", service)
    // A service that is already running this binary from this unit, on a Docker that is not restarted, is left running.
    if (!unitLines.includes("ActiveState=active")) sudo("Start service", [`${service} running`], "systemctl", "start", service)
    else if (previousUnit !== unit || restartDocker || !serviceRuns(destination.unit.out, destination.user, binary)) {
      restartService = true
      sudo("Restart the Paddock service", [`${service} restarted`], "systemctl", "restart", service)
    }
  } else if (!prepared) {
    blockers.push(`--sudo never requires an installation that is already complete: ${service} active and enabled at boot as ${destination.user}, running this verified artifact from the reviewed unit, with the pinned gVisor registered as ${MANAGED_RUNTIME} (${entry.runtimeArgs.join(" ")}) and loaded by Docker. Owner setup: run \`paddock host add\` once without --sudo never and approve its plan, or install exactly what that plan lists: the unit at ${unitPath}, state ${stateDir}, SupplementaryGroups=docker, then systemctl daemon-reload and systemctl enable --now ${service}. No user unit is installed; lingering boot behavior is not measured.`)
  }

  const verification = {
    name: `enroll-${sha256(`${options.name}:${options.artifact.sha256}:${destination.machine}`).slice(0, 16)}`,
    image: options.docker ? DOCKER_IMAGE : IMAGE, helperImage: HELPER_IMAGE, helperDockerfile: HELPER_DOCKERFILE,
    ...(options.docker ? { cpus: 1, memoryGb: 1, diskGb: 2, pids: 4096 } : { cpus: 0.5, memoryGb: 0.5, diskGb: 1, pids: 256 }),
    docker: options.docker, duration: "unknown" as const,
    operations: [
      "Handshake: version, source, protocol, artifact digest and socket-only systemd service",
      `Inspect the boot unit (active, enabled, account, executable) and the engine: ready on ${MANAGED_RUNTIME}, watched disk, inner Docker ${options.docker ? "offered" : "not offered"}`,
      `Create sandbox on gvisor:default${options.docker ? " with inner Docker" : ""}; require every applicable blocking check to pass${options.docker ? ", the inner Docker check included" : ""}, except that net-private may be weak (a range not probed rests on the loaded rules alone)`,
      "No links are added to the smoke sandbox; link-scope must report info, without claiming a link measurement",
      "Write 1 MiB, verify again and require every applicable blocking check to pass again (net-private pass or weak) with the disk use measured; disk limit remains watched",
      "Remove a successfully created verification sandbox even if later checks fail; a failed/lost create reply retains the diagnostic name for inspection; register only after successful cleanup",
    ],
  }
  const checks = new Map<string, string>()
  for (const upload of uploads) {
    if (upload.kind === "download" && upload.extract) {
      for (const [name, hash] of Object.entries(upload.extract.files)) checks.set(`${stageDir}/${upload.extract.directory}/${name}`, hash)
    } else if (upload.algorithm === "sha256") checks.set(`${stageDir}/${upload.name}`, upload.checksum)
  }
  for (const change of changes) if (change.sha256) checks.set(`${stageDir}/${change.staged}`, change.sha256)
  for (const step of steps) {
    const inputs = Object.fromEntries(step.argv.filter((arg) => checks.has(arg)).map((arg) => [arg, checks.get(arg)!]))
    if (Object.keys(inputs).length) step.argv = ["sudo", "-n", "python3", "-c", HOST_ROOT_STEP, JSON.stringify(inputs), ...step.argv.slice(2)]
  }
  const plan = {
    client, options, destination, stageDir, requestPath: "@PADDOCK_REQUEST@", stateDir, binary, service,
    mode: previousHost ? "update" as const : reuse ? "reuse" as const : "install" as const, previousHost,
    runtime: { name: MANAGED_RUNTIME, release: GVISOR_RELEASE, ...entry, innerDocker: options.docker },
    changes, uploads, steps,
    authentication: reuse ? [] : ["sudo", "-v"],
    restart: { required: !reuse && restartDocker, containers: inventory, service: restartService, sandboxes: restartService ? sandboxes : [] },
    packageRecipe: {
      repositories: destination.downloads.length ? destination.repositories : {},
      repositoryHashes: destination.downloads.length ? destination.apt : {},
      downloads: destination.downloads,
    },
    verification,
    warnings: [
      "Staging uses destination mkdtemp and mkstemp paths reported by apply. Each root step copies its inputs into a root-owned private mkdtemp directory, checks SHA-256 immediately before use, and removes the copy afterwards. Interactive sudo is refreshed before each step.",
      "Disk limit: watched. No hard disk helper, disk tools or sudoers rule is planned or installed.",
      "Docker access (SupplementaryGroups=docker) is effectively host-root authority. No login group membership is edited.",
      reuse || !restartDocker ? "No Docker restart is planned, so Docker interrupts no running container."
        : inventory.length ? `The planned Docker restart may interrupt every running container, even with live restore: ${inventory.join(", ")}.`
        : "The planned Docker restart finds no running container to interrupt.",
      ...(restartService ? [sandboxes.length
        ? `Restarting the Paddock service stops the running sandboxes it watches and does not start them again: ${sandboxes.join(", ")}. Start each again with \`paddock start\`.`
        : "Restarting the Paddock service finds no running sandbox to stop."] : []),
      options.docker
        ? `gVisor ${GVISOR_RELEASE} is registered as ${MANAGED_RUNTIME} with --net-raw (gVisor's raw sockets, which inner Docker's NAT needs), so sandboxes on this host can be created with --docker. The smoke sandbox starts inner Docker and has to pass its check.`
        : `gVisor ${GVISOR_RELEASE} is registered as ${MANAGED_RUNTIME} without --net-raw, so this host does not offer inner Docker: \`paddock create --docker\` is refused there. Enroll with --docker to register it with --net-raw.`,
      ...(!reuse && !registered && hadRawNetwork && !options.docker
        ? [`This plan removes --net-raw from the registered ${MANAGED_RUNTIME} runtime. Sandboxes created with --docker on this host then fail their kernel check.`] : []),
      `Verification builds the helper image ${HELPER_IMAGE} from the Dockerfile shown (digest-pinned base), may pull the pinned sandbox image, and through that helper loads Paddock's firewall tables (inet and bridge paddock_guard) on the host, as every sandbox there does. The images and the tables stay afterwards. No credentials are copied. Duration unknown.`,
      "No rollback is automatic. Completed/possibly interrupted steps and what they left are reported; shared packages and data are retained.",
      "Reboot persistence is not measured. The service does not recover stopped sandboxes automatically.",
      "U6: explicit local ELF/checksum only; no signed release channel, implicit build or provenance beyond the supplied digest.",
    ],
    blockers: [...new Set(blockers)],
  }
  return { hash: planHash(plan), ...plan }
}

// ---- applying a plan

// What the installer said it did. Its last line is the report; without one nothing is known. A report of success from a
// session that did not exit 0 is not a finished installation: the script's own clean-up, or the connection, failed.
export type Progress = { completed: string[]; started: string | null }
export function installOutcome(result: RunResult): (Progress & { stale: boolean; failure?: { code: ErrorCode; message: string } }) | undefined {
  let report: unknown
  try { report = JSON.parse(result.stdout) } catch { return undefined }
  if (!object(report)) return undefined
  if (report.stale === true) return { stale: true, completed: [], started: null }
  const progress = {
    stale: false,
    completed: Array.isArray(report.completed) ? report.completed.filter((step): step is string => typeof step === "string") : [],
    started: typeof report.started === "string" ? report.started : null,
  }
  if (report.ok !== true) return { ...progress, failure: { code: "runtime", message: `Installation failed: ${String(report.error)}` } }
  if (result.exitCode !== 0)
    return { ...progress, failure: { code: "outcome-unknown", message: `The installer reported every step complete, but its SSH session ended with exit ${result.exitCode}, so the removal of its staging files is not confirmed.` } }
  return progress
}

// A refusal after the installer or verification began: what this run changed on the host, and what it may have left.
// progress is undefined when this run installed nothing (a reused service).
export function enrollmentFailure(plan: HostPlan, progress: Progress | undefined, verifying: boolean, error: unknown): PaddockError {
  const code = error instanceof PaddockError ? error.code : "runtime"; const journal = `${plan.stateDir}/enrollment.json`
  const registration = plan.previousHost
    ? `Existing registration retained. To review and retry the update: ${updateCommand(plan.options)}.`
    : "Host is unregistered."
  const left = verifying ? ` Verification may have left the shared helper image ${HELPER_IMAGE}, the paddock_guard firewall tables or the diagnostic sandbox ${plan.verification.name}; inspect before removal.` : ""
  const leaves = (labels: string[]) => plan.steps.filter((step) => labels.includes(step.label)).flatMap((step) => step.leaves)
  const details = {
    completed: progress?.completed ?? [], started: progress?.started ?? null, cause: error instanceof PaddockError ? error.details : undefined, journal,
    residualObjects: verifying ? [HELPER_IMAGE, "inet/bridge paddock_guard", plan.verification.name] : [],
    residualPaths: leaves([...progress?.completed ?? [], ...(progress?.started ? [progress.started] : [])]),
  }
  // The cause can carry a command's whole output; its start and end are kept, so that what follows is not pushed out.
  const cause = (error as Error).message; const message = cause.length > 1500 ? `${cause.slice(0, 400)} … ${cause.slice(-1000)}` : cause
  if (!progress) return new PaddockError(code, `${message} ${registration} This run installed nothing; the service it found was left as it is.${left}`, details)
  if (!progress.completed.length && !progress.started) return new PaddockError(code, `${message} No installation step ran. ${registration}`, details)
  const interrupted = progress.started ? `${progress.started}, which may also have left: ${leaves([progress.started]).join(", ") || "nothing"}` : "none"
  return new PaddockError(code, `${message} ${registration} Completed steps: ${JSON.stringify(progress.completed)}. They left, and it is retained: ${leaves(progress.completed).join(", ") || "nothing"}. Interrupted step: ${interrupted}. Journal: ${journal}.${left} No automatic rollback.`, details)
}

// A daemon whose identity this primary already knows is not enrolled a second time under another name. The identity
// file's text is compared, however it ends.
export function identityRegistered(identity: FileState | undefined, known: string[]): boolean {
  return identity?.kind === "file" && identity.text !== null && known.includes(identity.text.trim())
}

// The smoke sandbox is held to more than a sandbox's own start: every applicable blocking check has to pass, where a probe that
// could not run would only be shown as unknown. Inner Docker's check has to pass where the plan registers it, and
// reports "info" where it was not asked for. The smoke sandbox has no links, so link-scope must report "info" too.
// net-private may be weak: a stand-in range the engine's host already uses cannot be probed there, and rests on the
// loaded rules, which the check has read.
export function requireSmokeChecks(checks: unknown, docker: boolean): void {
  if (!Array.isArray(checks)) throw new PaddockError("check-failed", "No smoke verification evidence.")
  for (const item of CHECKLIST.filter((item) => item.blocking)) {
    const found: unknown = checks.find((check: unknown) => object(check) && check.id === item.id)
    const expected = item.id === "link-scope" || item.id === "docker" && !docker ? ["info"] : item.id === "net-private" ? ["pass", "weak"] : ["pass"]
    if (!object(found) || !expected.includes(found.status as string))
      throw new PaddockError("check-failed", `Enrollment smoke check ${item.id} ${object(found) ? `was ${String(found.status).slice(0, 20)}` : "is missing"}; expected ${expected.join(" or ")}.`)
  }
}

// The engine the installed daemon would use: the runtime this plan installed, not another one registered there, offering
// inner Docker exactly when the plan said it would.
export function requireSmokeEngine(engines: unknown, docker: boolean): void {
  const engine: unknown = Array.isArray(engines) ? engines.find((entry: unknown) => object(entry) && entry.id === "gvisor:default") : undefined
  if (!object(engine) || engine.ready !== true) throw new PaddockError("dependency", "The installed service has no ready local Docker/gVisor engine.")
  if (!object(engine.data) || engine.data.runtime !== MANAGED_RUNTIME)
    throw new PaddockError("dependency", `The installed service would run sandboxes on the runtime ${object(engine.data) ? String(engine.data.runtime).slice(0, 64) : "unknown"}, not the pinned ${MANAGED_RUNTIME}.`)
  if (!object(engine.capabilities) || engine.capabilities.diskLimit !== "watched")
    throw new PaddockError("dependency", "The installed service's engine cannot measure a sandbox's disk use, so the watched disk limit would not hold.")
  if (engine.capabilities.docker !== docker)
    throw new PaddockError("dependency", `The installed service's engine ${engine.capabilities.docker === true ? "offers" : "does not offer"} inner Docker, which is not what the plan registered.`)
}

// The verify after the disk write: creation having passed is not evidence about the sandbox now.
export function requireSmokeVerified(verified: unknown, docker: boolean): void {
  if (!object(verified) || verified.ok !== true) throw new PaddockError("check-failed", "The final smoke verification did not hold.")
  requireSmokeChecks(verified.checks, docker)
  if (typeof verified.diskUsedBytes !== "number" || verified.diskUsedBytes < 1048576
    || !(verified.checks as unknown[]).some((check) => object(check) && check.id === "disk" && check.status === "weak"))
    throw new PaddockError("check-failed", "Smoke disk use was not measured as watched.")
}

// Failure details for the enrollment terminal. A revised plan is named by its hash; running the command again shows it.
const terminalDetails = (details: unknown) => `${JSON.stringify(
  object(details) && object(details.plan) ? { ...details, plan: `revised plan ${String(details.plan.hash)}; run the command again to review it` } : details, null, 2)}\r\n`

type Terminal = { closed: boolean; child?: ChildProcessWithoutNullStreams; output: (bytes: Buffer) => void; drain: () => void; paused: boolean }

export class Hosts {
  private readonly plans = new Map<string, HostPlan>()
  private applying = false
  private readonly terminals = new Set<Session>()
  constructor(private readonly machines: Machines, private readonly io: Partial<EnrollmentIo> = {}) {}

  async plan(body: Record<string, unknown>): Promise<HostPlan> {
    await this.machines.experimental()
    const options = enrollmentOptions(body)
    // Hash-check before SSH, and architecture-check again using the actual probe.
    const bytes = new Uint8Array(await Bun.file(options.artifact.path).arrayBuffer())
    if (sha256(bytes) !== options.artifact.sha256) throw new PaddockError("usage", "The local artifact checksum does not match --sha256. Nothing was uploaded or installed.")
    const destination = await (this.io.probe ?? probe)(options)
    await (this.io.artifact ?? verifyArtifact)(options.artifact, destination.arch)
    const registry = await readHosts(this.machines.dirs)
    if (registry.unknown.some((host) => host.name === options.name))
      throw new PaddockError("conflict", `${options.name} has an unreadable registration. Restore it or remove it explicitly; nothing was installed.`)
    const previous = registry.hosts.find((host) => host.name === options.name) ?? null
    const plan = installationPlan(options, destination, { version: this.machines.hello.version, sourceDigest: this.machines.hello.sourceDigest }, previous)
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(plan.hash, plan)
    return plan
  }

  async apply(body: Record<string, unknown>, terminal?: Terminal): Promise<HostRecord> {
    await this.machines.experimental()
    if (body.accepted !== true || !digest(body.hash)) throw new PaddockError("usage", "Apply needs accepted:true and the exact reviewed plan hash.")
    const old = this.plans.get(body.hash)
    if (!old) throw new PaddockError("conflict", "Unknown or expired plan. Request and review a new host plan; nothing was changed.")
    if (this.applying) throw new PaddockError("conflict", "Another enrollment is applying. Retry after it completes.")
    this.applying = true
    // progress: what the installer reported, once it has. verifying: the service is being used, so it may hold a smoke
    // sandbox. A failure before either changed nothing on the host and is thrown as it is.
    let progress: Progress | undefined; let verifying = false
    try {
      // Consent covers the plan that was shown. Probe again, and go on only if this is still that plan.
      const current = await this.plan(old.options)
      if (current.hash !== old.hash)
        throw new PaddockError("conflict", "Enrollment inputs changed. Consent is stale; review the revised plan and accept its hash. Nothing was installed.", { plan: current })
      if (current.blockers.length) throw new PaddockError("dependency", `Enrollment refused before installation: ${current.blockers.join(" ")}`, { plan: current, completed: [] })
      // Check the alias before touching the remote. attach checks it again when committing the registration.
      const registry = await readHosts(this.machines.dirs)
      if (!current.previousHost && [...registry.hosts, ...registry.unknown].some((host) => host.name === current.options.name)) throw new PaddockError("conflict", "The host alias is already registered. Nothing was installed.")
      if (identityRegistered(current.destination.files[`${current.stateDir}/machine-id`], [this.machines.hello, ...registry.hosts.filter((host) => host.name !== current.previousHost?.name)].map((host) => host.machineId)))
        throw new PaddockError("conflict", "This daemon identity is already registered. Nothing was installed.")

      if (current.steps.length) {
        const bytes = await (this.io.artifact ?? verifyArtifact)(current.options.artifact, current.destination.arch)
        const outcome = installOutcome(await (this.io.install ?? this.install.bind(this))(current, bytes, terminal))
        if (!outcome)
          throw new PaddockError(
            "outcome-unknown",
            "Installation SSH ended without a journal response. Some reviewed changes may have happened; inspect the destination enrollment.json and planned files before retrying.",
            { journal: `${current.stateDir}/enrollment.json`, plan: current },
          )
        if (outcome.stale) {
          const revised = await this.plan(current.options)
          throw new PaddockError("conflict", "Inputs changed during artifact delivery. Nothing installed; review the revised plan.", { plan: revised })
        }
        progress = { completed: outcome.completed, started: outcome.started }
        if (outcome.failure) throw new PaddockError(outcome.failure.code, outcome.failure.message)
      }

      if (terminal?.closed) throw new PaddockError("outcome-unknown", "Enrollment terminal disconnected. Nothing was registered. Inspect the journal before retrying.")
      const endpoint: Endpoint = { ssh: current.options.ssh, binary: current.binary, stateDir: current.stateDir, hostKey: current.destination.hostKey, hostPublicKey: current.destination.hostPublicKey }
      terminal?.output(Buffer.from("\r\nVerifying the installed service and smoke sandbox.\r\n"))
      verifying = true
      await (this.io.verify ?? this.verify.bind(this))(endpoint, current, () => terminal?.closed ?? false)
      if (terminal?.closed) throw new PaddockError("outcome-unknown", "Enrollment terminal disconnected during verification. Nothing was registered.")
      try {
        return await this.machines.attach({ name: current.options.name, ...endpoint, service: "systemd" }, () => {
          if (terminal?.closed) throw new PaddockError("outcome-unknown", "The terminal disconnected before registration. Nothing was registered.")
        }, current.previousHost ?? undefined)
      } catch (error) {
        throw new PaddockError(error instanceof PaddockError ? error.code : "runtime", `Enrollment registration (SSH identity / hello / registry write) failed: ${(error as Error).message}`)
      }
    } catch (error) {
      if (progress || verifying) throw enrollmentFailure(old, progress, verifying, error)
      if (old.previousHost) throw new PaddockError(error instanceof PaddockError ? error.code : "runtime", `${(error as Error).message} Existing registration retained. To review and retry the update: ${updateCommand(old.options)}.`, error instanceof PaddockError ? error.details : undefined)
      throw error
    } finally { this.applying = false }
  }

  // The interactive path: one terminal carries sudo's prompt, the installation's output and the final result.
  async session(hash: string): Promise<Session> {
    if (!this.plans.has(hash)) throw new PaddockError("conflict", "Unknown or expired enrollment plan. Request and review a new one.")
    const events = new EventEmitter(); let cancelled = false
    const terminal: Terminal = { closed: false, paused: false, output: (bytes) => events.emit("output", "stdout", bytes), drain: () => events.emit("drain") }
    const close = () => {
      terminal.closed = true; this.terminals.delete(session)
      terminal.child?.kill()
      const timer = setTimeout(() => terminal.child?.kill("SIGKILL"), 1500); timer.unref()
    }
    const session: Session = Object.assign(events, {
      tty: true,
      write: (bytes: Uint8Array) => {
        if (enrollmentInterrupt(bytes, Boolean(terminal.child))) {
          if (!cancelled) {
            cancelled = true; close()
            terminal.output(Buffer.from("\r\nCancelling enrollment; waiting for verification cleanup.\r\n"))
          }
          return true
        }
        return terminal.child?.stdin.write(bytes) ?? true
      },
      end: () => terminal.child?.stdin.end(),
      resize: async () => {},
      pause: () => { terminal.paused = true; terminal.child?.stdout.pause(); terminal.child?.stderr.pause() },
      resume: () => { terminal.paused = false; terminal.child?.stdout.resume(); terminal.child?.stderr.resume() },
      close,
    })
    this.terminals.add(session)
    setTimeout(() => {
      void this.apply({ hash, accepted: true }, terminal).then((host) => {
        if (!terminal.closed || cancelled) {
          terminal.output(Buffer.from(`\r\nEnrolled ${host.name}. Disk limit is watched. Verification passed; reboot persistence is not measured.\r\n`))
          events.emit("end", { code: 0 })
        }
      }, (error) => {
        if (cancelled) {
          if (error instanceof PaddockError && error.details !== undefined) terminal.output(Buffer.from(terminalDetails(error.details)))
          terminal.output(Buffer.from(this.plans.get(hash)?.previousHost ? "Update cancelled; existing registration retained.\r\n" : "Enrollment cancelled; no host was registered.\r\n"))
          events.emit("end", { code: 130 })
        } else if (!terminal.closed) {
          if (error instanceof PaddockError && error.details !== undefined) terminal.output(Buffer.from(terminalDetails(error.details)))
          events.emit("end", { error: (error as Error).message })
        }
      }).finally(() => this.terminals.delete(session))
    }, 0)
    return session
  }

  close(): void {
    for (const session of this.terminals) session.close()
    this.terminals.clear()
  }

  // Sends the plan to the destination and runs it there. With a terminal, the plan goes into a private request file
  // first, so the terminal's input stays free for sudo.
  private install(plan: HostPlan, bytes: Uint8Array, terminal?: Terminal): Promise<RunResult> { return pinned(plan, (pin) => this.installPinned(plan, bytes, pin, terminal)) }
  private async installPinned(plan: HostPlan, bytes: Uint8Array, pin: string[], terminal?: Terminal): Promise<RunResult> {
    // The artifact's bytes travel only when this plan installs them.
    const artifact = plan.uploads.some((upload) => upload.kind === "artifact") ? { artifactBytes: Buffer.from(bytes).toString("base64") } : {}
    const input = JSON.stringify({ ...plan, interactive: Boolean(terminal), probeScript: HOST_PROBE, probeRequest: probeRequest(plan.options), ...artifact })
    if (!terminal) return systemRunner(sshArgv(plan.options.ssh, ["python3", "-c", HOST_APPLY], pin), { stdin: input, timeoutMs: 20 * 60_000 })
    if (terminal.closed) throw new PaddockError("conflict", "Enrollment terminal closed before installation.")
    const staged = await systemRunner(sshArgv(plan.options.ssh, ["python3", "-c", HOST_REQUEST], pin), { stdin: input, timeoutMs: 120_000 })
    must(staged, "Staging the private enrollment request")
    const requestPath = staged.stdout.trim()
    if (!/^\/tmp\/paddock-request-[a-zA-Z0-9_-]+$/.test(requestPath)) throw new PaddockError("runtime", "The host did not report a private request path.")
    if (terminal.closed) throw new PaddockError("outcome-unknown", `Terminal closed after staging ${requestPath}. No installation was started; remove that staging file before retrying.`)
    const argv = sshArgv(plan.options.ssh, ["python3", "-c", HOST_APPLY, requestPath, sha256(input)], pin); argv[1] = "-tt"
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] }); terminal.child = child
    child.stdin.on("error", () => {}); child.stdin.on("drain", terminal.drain)
    let output = ""; let size = 0
    const collect = (bytes: Buffer) => {
      size += bytes.length
      if (size > 1024 ** 2) { child.kill(); return }
      output += bytes.toString(); terminal.output(bytes)
    }
    child.stdout.on("data", collect); child.stderr.on("data", collect)
    if (terminal.paused) { child.stdout.pause(); child.stderr.pause() }
    const timeout = setTimeout(() => child.kill(), 20 * 60_000)
    let code: number | null
    try {
      code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve) })
    } finally { clearTimeout(timeout); terminal.child = undefined }
    // The report is the line after the last marker; everything before it is terminal output.
    const marker = output.lastIndexOf("PADDOCK-RESULT ")
    return { exitCode: code ?? 1, stdout: marker < 0 ? "" : output.slice(marker + 15).split(/\r?\n/)[0]!, stderr: "" }
  }

  // The installed service has to answer as the approved build and run a sandbox that passes, before anything is registered.
  private async verify(endpoint: Endpoint, plan: HostPlan, cancelled: () => boolean = () => false): Promise<void> {
    const { peer, hello } = await readyEnrollmentPeer(endpoint, cancelled, this.io.connect, this.io.pause)
    const spec = plan.verification; let created = false
    const call = async (method: string, body: object = {}) => {
      if (cancelled() && method !== "remove") throw new PaddockError("conflict", "Enrollment verification was cancelled.")
      return verificationCall(peer, method, body)
    }
    try {
      const identity = plan.destination.files[`${plan.stateDir}/machine-id`]
      compatible(hello, this.machines.hello, identity?.kind === "file" ? identity.text?.trim() : undefined)
      if (hello.buildDigest !== plan.options.artifact.sha256 || hello.service !== "systemd" || hello.listener !== "socket-only")
        throw new PaddockError("incompatible", "Service artifact digest, supervisor or socket-only listener does not match the approved installation.")

      const unit = this.io.inspectService ? await this.io.inspectService(plan) : must(await pinned(plan, (pin) => systemRunner(sshArgv(endpoint.ssh, ["systemctl", "show", plan.service, "--property=ActiveState,UnitFileState,User,SupplementaryGroups,ExecStart"], pin))), "Inspecting the boot service")
      if (!serviceMatches(unit.stdout, plan.destination.user, plan.binary))
        throw new PaddockError("dependency", `Boot-service inspection did not show ${plan.service} active, permanently enabled, and running ${plan.binary} daemon run as ${plan.destination.user} with SupplementaryGroups=docker.`)
      requireSmokeEngine(await call("engines"), spec.docker)

      // A sandbox of this name is the diagnostic an earlier attempt kept, or someone's own. Either way it is not removed here.
      const existing = await call("list")
      if (!Array.isArray(existing) || existing.some((s) => object(s) && s.name === spec.name))
        throw new PaddockError("conflict", `A sandbox named ${spec.name} already exists on the host: the diagnostic an earlier enrollment attempt kept, or the owner's. It was not touched. Inspect it there, then remove it and enroll again: \`ssh ${endpoint.ssh} env PADDOCK_STATE_DIR=${plan.stateDir} PADDOCK_CONFIG_DIR=${plan.stateDir}/config ${plan.binary} remove ${spec.name} --confirm ${spec.name}\``)
      const { duration: _duration, operations: _operations, helperImage: _helper, helperDockerfile: _dockerfile, ...input } = spec
      const made = await call("create", { ...input, engine: "gvisor:default" })
      created = true
      requireSmokeChecks(object(made) ? made.checks : undefined, spec.docker)
      const write = await call("exec", { name: spec.name, argv: ["dd", "if=/dev/zero", "of=/paddock-disk-probe", "bs=1048576", "count=1"] })
      if (!object(write) || write.exitCode !== 0) throw new PaddockError("check-failed", "Smoke disk write failed.")
      requireSmokeVerified(await call("verify", { name: spec.name }), spec.docker)
    } finally {
      try { if (created) await call("remove", { name: spec.name, confirm: spec.name }) } finally { await peer.close() }
    }
  }
}

export const updateCommand = (options: EnrollmentOptions) => `paddock host add ${options.name} --ssh ${options.ssh} --artifact ${shellQuote(options.artifact.path)} --sha256 ${options.artifact.sha256}${options.docker ? " --docker" : ""} --disk-policy watched${options.sudo === "never" ? " --sudo never" : ""}`

type EnrollmentPeer = Pick<HttpPeer, "call" | "close">
type EnrollmentIo = {
  connect: (endpoint: Endpoint) => EnrollmentPeer
  pause: () => Promise<void>
  inspectService: (plan: HostPlan) => Promise<RunResult>
  probe: typeof probe
  artifact: typeof verifyArtifact
  install: (plan: HostPlan, bytes: Uint8Array, terminal?: Terminal) => Promise<RunResult>
  verify: (endpoint: Endpoint, plan: HostPlan, cancelled: () => boolean) => Promise<void>
}

export async function verificationCall(peer: EnrollmentPeer, method: string, body: object = {}): Promise<unknown> {
  try { return await peer.call(method, body, { mutation: ["create", "remove", "exec", "verify"].includes(method), timeoutMs: 300_000 }) }
  catch (error) {
    throw new PaddockError(error instanceof PaddockError ? error.code : "runtime", `Enrollment verification call ${method} failed: ${(error as Error).message}`, { method, cause: error instanceof PaddockError ? error.details : undefined })
  }
}

export async function readyEnrollmentPeer(endpoint: Endpoint, cancelled: () => boolean = () => false,
  connect: (endpoint: Endpoint) => EnrollmentPeer = (endpoint) => new HttpPeer(endpoint),
  pause: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 500)),
): Promise<{ peer: EnrollmentPeer; hello: Hello }> {
  let last: unknown
  for (let at = 0; at < 30; at++) {
    if (cancelled()) throw new PaddockError("conflict", "Enrollment verification was cancelled before hello.")
    const peer = connect(endpoint)
    try { return { peer, hello: parseHello(await peer.call("hello", {}, { timeoutMs: 5000 })) } }
    catch (error) {
      last = error
      await peer.close()
      if (!(error instanceof PaddockError) || error.code !== "offline") break
      if (at < 29) await pause()
    }
  }
  throw new PaddockError(last instanceof PaddockError ? last.code : "runtime", `Enrollment verification startup call hello failed: ${(last as Error).message}`, { method: "hello" })
}
