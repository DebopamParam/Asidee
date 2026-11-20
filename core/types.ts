// The vocabulary of the core. Everything a client (CLI, UI, extension) can ask for is expressed in these types, and none
// of them can express a host mount, a privileged container, a runtime choice or a non-loopback port. The one exception
// is the boolean gpu, which makes a GPU container on the host's kernel: a weaker kind, never called a sandbox.

export type SandboxSpec = {
  name: string
  image: string
  cpus: number
  memoryGb: number
  pids: number
  // The sandbox may use this much disk. How strictly that holds depends on the engine: see Capabilities.diskLimit.
  diskGb: number
  docker: boolean
  // A GPU container: runc on the host's Linux kernel with the NVIDIA GPU, not gVisor. Absent means false.
  gpu?: boolean
  // The name of an Asidee template (an image made from a sandbox) to start from instead of an image; the core resolves it
  // to the template's image ID before anything is created.
  template?: string
}

export type Capabilities = {
  kernelIsolation: "gvisor" | "microvm"
  // hard: writes fail at the limit. watched: the daemon stops the sandbox after it passes the limit. none: no limit.
  diskLimit: "hard" | "watched" | "none"
  networkGuard: boolean
  docker: boolean
  // The daemon can relay a command's bytes as they come (shell, exec --stream).
  execStream: boolean
  // A connection can be relayed to a port on the sandbox's own loopback (forwards).
  loopbackRelay: boolean
  // Changing CPUs, memory and the process limit. live: a running sandbox gets the new limits at once. restart: at its next
  // start. none: they are fixed at creation.
  resize: "live" | "restart" | "none"
  // An image can be made from a sandbox's files (a template).
  snapshot: boolean
  // Docker can pass an NVIDIA GPU to a runc container (a GPU container). Absent means false.
  gpu?: boolean
}

export type Limits = { cpus: number; memoryGb: number; pids: number }

// An image the core made from a sandbox. Only the core makes one, under a name of its own on the engine.
export type Template = {
  name: string; engine: string; imageId: string
  // The sandbox it was saved from, and the image that sandbox was made from.
  source: string; sourceImage: string
  createdAt: string; sizeBytes: number
  // Login files (CREDENTIAL_FILES) that were in the sandbox and were left out of the template.
  loginsRemoved: string[]
  // Sandboxes on the engine whose container runs this image.
  dependants: string[]
}

// One place sandboxes can run: a provider plus the engine it found (a Docker context, for example).
export type Engine = {
  id: string
  provider: string
  label: string
  ready: boolean
  problems: string[]
  fix?: string
  capabilities?: Capabilities
  // Provider-private settings, recorded in each sandbox's manifest at creation.
  data: Record<string, string>
}

export type CheckId =
  | "kernel" | "hardening" | "mounts" | "network-guard" | "inbound" | "forwards" | "ssh" | "links" | "limits" | "disk" | "docker" | "dns"
  | "template" | "net-host" | "net-peers" | "link-scope" | "net-private" | "egress" | "credentials"
  | "confinement" | "host-driver"
  | "seatbelt" | "writes" | "home-closed" | "daemons" | "user-data" | "processes" | "gpu" | "network" | "loopback" | "not-covered" | "hard-links" | "free-space"

export type WorkspaceLogins = { kind: "none" } | { kind: "profiles"; claude: string; codex: string }
export type WorkspaceSpec = { name: string; hostTemp: boolean; diskGb: number; reads: string[]; loopback: "open"; path: string[]; copy?: string; logins: WorkspaceLogins }
export type WorkspaceManifest = {
  version: 1; kind: "workspace"; name: string; id: string; spec: WorkspaceSpec
  folder: string; tag: string; home: string; userVar: string
  reads: Array<{ given: string; canonical: string; resolvedAt: string }>
  profileHash: string; macOS: string; createdAt: string
  logins: Array<{ agent: "claude" | "codex"; copied: boolean; detail: string }>
  backup: string
  lastVerify?: { at: string; results: CheckResult[] }
  // Why the daemon last stopped its processes; a launch clears it.
  stopReason?: string
}

// pass: holds. weak: holds in a weaker form than the title says (the detail says how). fail: does not hold.
// unsupported: this engine cannot provide it. unknown: could not be checked. info: a disclosure, not a guarantee.
export type CheckStatus = "pass" | "weak" | "fail" | "unsupported" | "unknown" | "info"
// probed: tried against the live sandbox. inspected: read from the engine's configuration.
export type Evidence = "probed" | "inspected" | "none"
export type CheckResult = { id: CheckId; status: CheckStatus; evidence: Evidence; detail: string }

// config: readable before the sandbox starts. runtime: needs it running. probe: live attempts, measured at 15 to 40 seconds.
export type Stage = "config" | "runtime" | "probe"

export type Manifest = {
  version: 1
  name: string
  // Random; also a label on the engine's object, so the core never touches something it did not create.
  id: string
  engine: Engine
  spec: SandboxSpec
  createdAt: string
  lastVerify?: { at: string; results: CheckResult[] }
  // When a start began whose checks have not finished yet (for a create, its first verify). Written before the engine
  // starts the sandbox, so a daemon that ends in between leaves it for the next one, which stops the sandbox.
  checksPending?: string
  stopReason?: string
  enforcementProblem?: { at: string; message: string }
  // Set by `asd ssh setup` for this sandbox; a sandbox recreated under the name starts without it.
  ssh?: SshSetup
  // The template it was made from, as resolved at creation. spec.image is then imageId.
  template?: { name: string; imageId: string; source: string; createdAt: string }
}
// user and home: the login, the same as exec's. unlocked: its locked password was replaced by * (still no password),
// since sshd refuses a locked account even with a key. hostKey: the public half of the key made inside. editorKey: the
// fingerprint of the key this machine's editors log in with.
export type SshSetup = { user: string; home: string; unlocked: boolean; sshd: string; hostKey: string; editorKey: string; at: string; editorKeyOrigin?: "client" }

// overflow: the command printed more than its output limit on that stream, was killed, and its output was discarded.
// raw: stdout's bytes, when asked for with `binary`.
export type DiskWarning = { usedBytes: number; limitBytes: number; message: string }
export type RunResult = { exitCode: number; stdout: string; stderr: string; overflow?: "stdout" | "stderr"; raw?: Uint8Array }
export type RunOptions = { stdin?: string | Uint8Array; timeoutMs?: number; env?: Record<string, string>; cwd?: string; maxOutputBytes?: number; binary?: boolean; signal?: AbortSignal }
// Every external command goes through a Runner, so tests run without an engine.
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

// A command running in a sandbox whose bytes are passed on, never collected. While paused, the provider stops reading
// from the engine, so a slow reader slows the command down instead of filling the daemon's memory. `end` arrives once,
// after the last output: with the command's exit code, or with an error when it was cut off (the sandbox stopped).
export interface Session {
  readonly tty: boolean
  // A workspace launched over its disk limit says so; the stream passes it on with "ready".
  readonly diskWarning?: DiskWarning
  // false: wait for "drain" before writing more.
  write(bytes: Uint8Array): boolean
  // Closes the command's input; its output goes on. Ignored on a terminal, where input is keystrokes.
  end(): void
  resize(cols: number, rows: number): Promise<void>
  pause(): void
  resume(): void
  // Ends the session and, as far as the provider can, the command's processes.
  close(reason?: string): void
  on(event: "output", listener: (stream: "stdout" | "stderr", bytes: Uint8Array) => void): this
  on(event: "drain", listener: () => void): this
  on(event: "end", listener: (exit: { code?: number; error?: string }) => void): this
}

// What links (core/links.ts) need from a provider. Each call acts inside one sandbox, and every address, port and path
// in it comes from the daemon, never from inside a sandbox.
export interface LinkSupport {
  // Starts a link's listener inside the sandbox, as root, on its loopback address:port. It prints "r" once bound, or
  // "e REASON"; then "o PID" for each connection it accepts, which waits in dir until attached or ended. An input line
  // "x PID" ends that connection; it ends with its input, or after 15 seconds without a line.
  listen(manifest: Manifest, dir: string, address: string, port: number): Promise<Session>
  // One accepted connection's two halves: fromClient's output is what the client sends, toClient's input goes to it.
  // Both come back paused, so nothing they print is lost before the daemon listens.
  attach(manifest: Manifest, dir: string, pid: number): Promise<{ fromClient: Session; toClient: Session }>
  // Replaces Asidee's link lines in the sandbox's /etc/hosts with these, writing only when that changes it, and
  // returns the file as read back.
  hosts(manifest: Manifest, lines: readonly string[]): Promise<string>
  // A test listener that answers each connection with reply: on the sandbox's loopback only, or on every address.
  canary(manifest: Manifest, port: number, reply: string, everywhere: boolean): Promise<Session>
  // A connection from inside the sandbox to host:port, as any program there would make it, and what it received.
  dial(manifest: Manifest, host: string, port: number): Promise<{ connected: boolean; received: string }>
  // The sandbox's address on its engine network, and what a connection to ip:port from the engine's host receives.
  address(manifest: Manifest): Promise<string | undefined>
  hostDial(manifest: Manifest, ip: string, port: number): Promise<string>
}

export interface Provider {
  id: string
  detect(): Promise<Engine[]>
  create(manifest: Manifest): Promise<void>
  // Applies whatever must be in place before a start (network guard) without starting.
  prepare(manifest: Manifest): Promise<void>
  start(manifest: Manifest): Promise<void>
  stop(manifest: Manifest): Promise<void>
  remove(manifest: Manifest, createdOnly?: boolean): Promise<void>
  status(manifest: Manifest): Promise<"running" | "stopped" | "missing">
  exec(manifest: Manifest, argv: readonly string[], options?: { user?: string; stdin?: string | Uint8Array; signal?: AbortSignal }): Promise<RunResult>
  // A command whose bytes are relayed as they come, for shells, binary exec and anything long-lived. A held session
  // delivers nothing it printed, nor its end, before its first resume(), for a caller that waits on something else
  // before it listens.
  openExec(manifest: Manifest, argv: readonly string[], options: { user?: string; tty: boolean; cols?: number; rows?: number; held?: boolean }): Promise<Session>
  // Which run of the sandbox is running now, or undefined when it is not. A restart or a recreated container differs.
  generation(manifest: Manifest): Promise<string | undefined>
  // Puts the loopback relay in place in this run of the sandbox, then connects one session to 127.0.0.1:port inside it.
  prepareLoopback(manifest: Manifest): Promise<void>
  dialLoopback(manifest: Manifest, port: number, held?: boolean): Promise<Session>
  checks(manifest: Manifest, stage: Stage): Promise<CheckResult[]>
  diskUsedBytes(manifest: Manifest): Promise<number | undefined>
  // Why the engine stopped a sandbox that nobody asked to stop (it ran out of memory, for example), if it knows.
  stoppedWhy(manifest: Manifest): Promise<string | undefined>
  // Removes what an interrupted run of this provider may have left on an engine. Called when the daemon starts.
  sweep(engine: Engine): Promise<void>
  // Sets the sandbox's limits in the engine, running or not. For a running sandbox it returns the limits its running
  // instance has afterwards, read from the engine's host; undefined when it is stopped or they could not be read.
  resize(manifest: Manifest, limits: Limits): Promise<Limits | undefined>
  // What a running sandbox uses now; undefined when it is not running.
  usage(manifest: Manifest): Promise<{ memoryBytes: number; tasks: number; cpuNs?: number } | undefined>
  // Makes a template from the sandbox's files, minus the usual login files, and returns it as templates() lists it.
  snapshot(manifest: Manifest, name: string): Promise<Template>
  templates(engine: Engine): Promise<Template[]>
  // Removes the template's name. Sandboxes made from it keep their image; it goes with the last of them.
  removeTemplate(engine: Engine, name: string): Promise<{ imageId: string; dependants: string[] }>
  // Absent: this provider cannot link its sandboxes.
  links?: LinkSupport
}

export type ErrorCode = "usage" | "not-found" | "conflict" | "dependency" | "check-failed" | "probes-required" | "runtime" | "offline" | "incompatible" | "identity-changed" | "outcome-unknown"
export class AsideeError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message) }
}
