// The vocabulary of the core. Everything a client (CLI, UI, extension) can ask for is expressed in these types, and none
// of them can express a host mount, a privileged container, a runtime choice or a non-loopback port.

export type SandboxSpec = {
  name: string
  image: string
  cpus: number
  memoryGb: number
  pids: number
  // The sandbox may use this much disk. How strictly that holds depends on the engine: see Capabilities.diskLimit.
  diskGb: number
  docker: boolean
}

export type Capabilities = {
  kernelIsolation: "gvisor" | "microvm"
  // hard: writes fail at the limit. watched: the daemon stops the sandbox after it passes the limit. none: no limit.
  diskLimit: "hard" | "watched" | "none"
  networkGuard: boolean
  docker: boolean
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
  | "kernel" | "hardening" | "mounts" | "network-guard" | "inbound" | "limits" | "disk" | "docker"
  | "net-host" | "net-peers" | "net-private" | "egress" | "credentials"

// pass: holds. weak: holds in a weaker form than the title says (the detail says how). fail: does not hold.
// unsupported: this engine cannot provide it. unknown: could not be checked. info: a disclosure, not a guarantee.
export type CheckStatus = "pass" | "weak" | "fail" | "unsupported" | "unknown" | "info"
// probed: tried against the live sandbox. inspected: read from the engine's configuration.
export type Evidence = "probed" | "inspected" | "none"
export type CheckResult = { id: CheckId; status: CheckStatus; evidence: Evidence; detail: string }

// config: readable before the sandbox starts. runtime: needs it running. probe: live attempts, a few seconds.
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
  stopReason?: string
}

// overflow: the command printed more than its output limit on that stream, was killed, and its output was discarded.
// raw: stdout's bytes, when asked for with `binary`.
export type RunResult = { exitCode: number; stdout: string; stderr: string; overflow?: "stdout" | "stderr"; raw?: Uint8Array }
export type RunOptions = { stdin?: string | Uint8Array; timeoutMs?: number; env?: Record<string, string>; cwd?: string; maxOutputBytes?: number; binary?: boolean }
// Every external command goes through a Runner, so tests run without an engine.
export type Runner = (argv: readonly string[], options?: RunOptions) => Promise<RunResult>

export interface Provider {
  id: string
  detect(): Promise<Engine[]>
  create(manifest: Manifest): Promise<void>
  // Applies whatever must be in place before a start (network guard) without starting.
  prepare(manifest: Manifest): Promise<void>
  start(manifest: Manifest): Promise<void>
  stop(manifest: Manifest): Promise<void>
  remove(manifest: Manifest): Promise<void>
  status(manifest: Manifest): Promise<"running" | "stopped" | "missing">
  exec(manifest: Manifest, argv: readonly string[], options?: { user?: string; stdin?: string }): Promise<RunResult>
  // The command a terminal runs for an interactive session.
  attachArgv(manifest: Manifest, argv: readonly string[]): string[]
  checks(manifest: Manifest, stage: Stage): Promise<CheckResult[]>
  diskUsedBytes(manifest: Manifest): Promise<number | undefined>
  // Why the engine stopped a sandbox that nobody asked to stop (it ran out of memory, for example), if it knows.
  stoppedWhy(manifest: Manifest): Promise<string | undefined>
  // Removes what an interrupted run of this provider may have left on an engine. Called when the daemon starts.
  sweep(engine: Engine): Promise<void>
}

export type ErrorCode = "usage" | "not-found" | "conflict" | "dependency" | "check-failed" | "runtime"
export class PaddockError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) { super(message) }
}
