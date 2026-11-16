#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { connect } from "node:net"
import { resolve, dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { parseArgs } from "node:util"
import { CHECKLIST, WORKSPACE_CHECKLIST } from "../core/checks"
import type { WorkspaceReport, WorkspaceView, WorkspaceRemoval } from "../core/workspaces"
import { HOST_TEMP_DISCLOSURE, WORKSPACE_DISCLOSURE } from "../core/workspace-profile"
import type { ResizeChange, SandboxView } from "../core/core"
import { BUILD, readDaemonFile, runDaemon, VERSION } from "../core/daemon"
import type { Extension } from "../core/extensions"
import { FORWARD_REACH, type ForwardView } from "../core/forwards"
import { LINK_LIMITS, type LinkView } from "../core/links"
import type { HostPlan } from "../core/hosts"
import { hostOption, type FleetView, type HostView } from "../core/machines"
import { bounded, PROTOCOL, transportStdio } from "../core/transport"
import { included, userConfig, type SshAccess } from "../core/ssh"
import { checkSocketPath, defaultDirs, socketPath, streamSocketPath, type Config } from "../core/state"
import { dataFrames, frame, FrameReader, type OpenRequest, type EnrollmentRequest } from "../core/stream"
import { PaddockError, type CheckResult, type DiskWarning, type Engine, type ErrorCode, type RunResult, type Template } from "../core/types"

// A thin client: every command is one call to the daemon, which is started on first use.

// The help, grouped by task. `paddock COMMAND --help` prints the lines for that command.
const GROUPS: Array<[string, string[]]> = [
  ["Start here", [
    "paddock doctor                         engines on this machine and what each one needs",
    "paddock create NAME [--docker] [--image IMAGE | --template TEMPLATE] [--cpus N] [--memory GB] [--disk GB] [--pids N] [--engine ID]",
    "paddock shell NAME [-- COMMAND…]       a shell, or one command on a terminal, inside the sandbox",
    "paddock list                           your sandboxes",
    "paddock list --all                     machines, including unavailable ones and unknown cached sandboxes (experimental)",
  ]],
  ["Use a sandbox", [
    "paddock exec NAME [--user USER] [--stdin] -- COMMAND…   --stdin sends this command's input, bytes exact, up to 16 MiB;",
    "                                                        output comes back as text (invalid UTF-8 replaced). Piped input is sent only with --stdin or --stream.",
    "paddock exec NAME --stream [--user USER] -- COMMAND…    bytes in and out as they come, any size",
    "paddock verify NAME                    run every check against the sandbox and list each result",
    "paddock start NAME",
    "paddock stop NAME",
    "paddock remove NAME --confirm NAME     deletes the sandbox and everything in it",
  ]],
  ["Reach in", [
    "paddock forward add NAME --port PORT [--local-port PORT]   127.0.0.1 here to PORT on the sandbox's loopback",
    "paddock forward list [NAME] | forward remove ID            a forward ends when its sandbox stops",
    "paddock link add FROM TO --port PORT   programs in FROM connect to TO:PORT and reach PORT on TO's loopback, nothing else",
    "paddock link list [NAME] | link remove FROM TO --port PORT   on this machine only; a link comes back after restarts",
    "paddock ssh setup NAME [--write-config]   sshd inside, reached as NAME.paddock through the daemon, no port",
    "paddock ssh access NAME                   the alias, user and home an editor uses, and whether it is ready",
  ]],
  ["Change a sandbox", [
    "paddock resize NAME [--cpus N] [--memory GB] [--pids N] [--disk GB]   says which limits apply now and which at the next start",
    "paddock snapshot NAME --as TEMPLATE    save the sandbox's files, minus the usual logins, as a template",
    "paddock template list | template remove TEMPLATE [--engine ID]   sandboxes made from it keep working",
  ]],
  ["Settings", [
    "paddock config get                     settings on the selected machine",
    "paddock config set require-probes on|off   require blocking isolation probes at create (default on)",
    "paddock config set experimental on|off     features not yet proven on enough machines: other machines (default off)",
    "paddock config set workspace-free-space GB below this much free space, workspace launches are refused and running",
    "                                           workspaces are stopped (default 5; 0 turns it off; purgeable space not counted)",
  ]],
  ["Workspaces: on this Mac's own kernel, not a sandbox (macOS only)", [
    "paddock workspace create NAME [--host-temp] [--disk GB] [--copy PATH] [--read PATH]… [--path DIR]… [--no-logins | --claude-profile NAME --codex-profile NAME]",
    "                                       --host-temp opens shared per-user temp (default off); TMPDIR stays private",
    "                                       --disk is watched, not capped (default 20): past it the daemon stops its processes",
    "paddock workspace shell NAME [-- COMMAND…]",
    "paddock workspace exec NAME [--stdin | --stream] -- COMMAND…",
    "                                       Piped input is sent only with --stdin or --stream.",
    "paddock workspace list | get NAME | stop NAME | verify NAME",
    "paddock workspace set NAME host-temp on|off   stop first; applies to later processes; shared host temp weakens confinement",
    "paddock workspace set NAME disk GB            the watched disk limit; applies now, also while running",
    "paddock workspace remove NAME --confirm NAME",
  ]],
  ["Other machines (experimental, off unless turned on: paddock config set experimental on)", [
    "paddock host list                       registered SSH daemons and their connection state",
    "paddock host add NAME --ssh DEST --artifact PATH --sha256 HASH [--docker] [--sudo ask|never] [--disk-policy watched] [--accept-plan HASH]",
    "                                        installs or updates the same registered machine only after plan acceptance; --docker lets its sandboxes run Docker inside",
    "paddock host attach NAME --ssh DEST --binary PATH --state-dir PATH   attach an already prepared daemon",
    "paddock host remove NAME --confirm NAME  forget a prepared host; remote files and service stay",
  ]],
  ["Extensions, dashboard and daemon", [
    "paddock ext list",
    "paddock ext run EXTENSION ACTION [SANDBOX] [--set FIELD=VALUE]…",
    "paddock ui [--open]                    the dashboard's address",
    "paddock daemon status | stop | run",
    "paddock transport stdio --protocol 1 [--stream]   internal SSH socket relay; starts nothing",
  ]],
]
const OPTIONS = `  --host NAME   select a registered machine (experimental); unqualified names always mean local
  --json   print {"ok":true,"data":…} or {"ok":false,"error":{code,message}}
  --help   after any command, that command's usage`
const EXITS = "Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed or required probes could not run, 7 unreachable, 8 incompatible, 9 identity changed, 10 outcome unknown."
const HELP = `paddock ${VERSION}: sandboxes for coding agents that are checked, not assumed

${GROUPS.map(([group, lines]) => `${group}\n${lines.map((line) => `  ${line}`).join("\n")}`).join("\n")}

${OPTIONS}
${EXITS}`
// A command's lines, with the continuation lines under them. An action narrows workspace, host and the other nouns
// when it names one of their lines.
function commandHelp(words: string[]): string | undefined {
  const aliases: Record<string, string> = { ls: "list", rm: "remove", templates: "template", init: "doctor" }
  const command = aliases[words[0] ?? ""] ?? words[0]
  const action = words[1] && !words[1].startsWith("-") ? aliases[words[1]] ?? words[1] : undefined
  const pick = (match: (usage: string) => boolean) => {
    const picked: string[] = []; let taking = false
    for (const line of GROUPS.flatMap(([, lines]) => lines)) {
      if (line.startsWith("paddock ")) taking = match(`${line.slice(8).split("   ")[0]} `)
      if (taking) picked.push(line)
    }
    return picked
  }
  if (!command) return undefined
  const narrowed = action ? pick((usage) => usage.startsWith(`${command} `) && (usage.startsWith(`${command} ${action} `) || usage.includes(`| ${action} `) || usage.includes(`| ${command} ${action} `))) : []
  const lines = narrowed.length ? narrowed : pick((usage) => usage.startsWith(`${command} `))
  return lines.length ? `${lines.map((line) => `  ${line}`).join("\n")}\n\n${OPTIONS}` : undefined
}
// parseArgs explains its own syntax; a person needs the option it stopped at and where the usage is.
function argumentError(error: unknown, words: string): PaddockError {
  const message = (error as Error).message
  const option = /'(-[^' ]+)/.exec(message)?.[1]
  const code = (error as NodeJS.ErrnoException).code
  const see = `See \`paddock ${words} --help\`.`
  return new PaddockError("usage", !option ? `${message} ${see}` : code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? `paddock ${words} has no option ${option}. ${see}`
    : /does not take an argument/.test(message) ? `${option} takes no value. ${see}` : `${option} needs a value. ${see}`)
}
// Text from a daemon, which may be another machine's, on its way to a terminal: without control characters (an escape
// sequence can redraw the screen or forge a check mark) and line breaks (a forged line), and bounded. lines keeps breaks
// for output that is several lines by nature, such as an extension's.
const shown = (value: unknown, lines = false) => String(value ?? "").replace(lines ? /[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g : /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, lines ? 64_000 : 4000)

// An enrollment plan as a person reviews it: every privileged command with what it leaves, each file's diff, everything
// delivered with its checksum, and what a restart interrupts. Its text comes from the destination, so each piece goes
// through shown(). The probe evidence the hash also covers is left to --json.
function planLines(plan: HostPlan): string[] {
  const word = (text: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : JSON.stringify(text)
  const list = (items: string[]) => items.map((item) => shown(item)).join(", ")
  const { destination, runtime, restart, verification: smoke } = plan
  const lines = [
    `Enrollment plan for ${shown(plan.options.name)} (${shown(plan.options.ssh)})`,
    `  Machine: ${shown(destination.os.PRETTY_NAME ?? destination.os.ID)} on ${shown(destination.arch)}, account ${shown(destination.user)} (uid ${shown(destination.uid)}), machine id ${shown(destination.machine)}, host key ${shown(destination.hostKey)}`,
    `  Mode: ${plan.mode !== "reuse" ? plan.mode : "reuse. Nothing is installed; what is already there is verified and registered"}`,
    `  Paddock: ${shown(plan.options.artifact.path)} (sha256 ${shown(plan.options.artifact.sha256)}) as ${shown(plan.binary)}; service ${shown(plan.service)}; state in ${shown(plan.stateDir)}`,
    `  Runtime: gVisor ${shown(runtime.release)} registered with Docker as ${shown(runtime.name)}: ${shown([runtime.path, ...runtime.runtimeArgs].map(word).join(" "))}`,
    `  Docker inside sandboxes: ${runtime.innerDocker ? "offered (--docker)" : "not offered (enroll with --docker to offer it)"}`,
    `  Disk limit: ${shown(plan.options.diskPolicy)}`,
    "",
    plan.steps.length ? `Privileged commands (${plan.steps.length}), run in this order. ${plan.authentication.length ? `Interactive apply may ask for a password with \`${plan.authentication.join(" ")}\`; --accept-plan never prompts and requires noninteractive sudo.` : "No authentication prompt."}` : "Privileged commands: none.",
  ]
  plan.steps.forEach((step, index) => lines.push(
    `  ${index + 1}. ${shown(step.label)}`, `       ${shown(step.argv.map(word).join(" "))}`, `       leaves: ${list(step.leaves) || "nothing"}`))
  lines.push("", plan.changes.length ? `Files written (${plan.changes.length}):` : "Files written: none.")
  for (const change of plan.changes) {
    lines.push(`  ${shown(change.path)}: ${change.beforeSha256 ? `sha256 ${shown(change.beforeSha256)}` : "absent"} becomes sha256 ${shown(change.sha256)}`)
    for (const line of change.diff.split("\n").filter(Boolean)) lines.push(`    ${shown(line)}`)
  }
  lines.push("", plan.uploads.length ? `Delivered to the destination (${plan.uploads.length}), each checked there before any command runs:` : "Delivered to the destination: nothing.")
  for (const upload of plan.uploads) {
    lines.push(`  ${shown(upload.name)}: ${upload.algorithm} ${shown(upload.checksum)}, ${upload.kind === "artifact" ? `uploaded from ${shown(upload.source)}` : `downloaded by the destination from ${shown(upload.url)}`}`)
    if (upload.kind === "download" && upload.extract) for (const [name, checksum] of Object.entries(upload.extract.files)) lines.push(`    takes ${shown(name)}: sha256 ${shown(checksum)}`)
  }
  const recipe = plan.packageRecipe
  if (recipe.downloads.length) lines.push(
    "", `Packages installed (${recipe.downloads.length}): ${list(recipe.downloads.map((download) => `${download.package} ${download.version}`))}`,
    `  chosen by apt from ${list(Object.keys(recipe.repositories)) || "its sources"}; ${Object.keys(recipe.repositoryHashes).length} apt source, key and index files are hashed into this plan`)
  lines.push(
    "",
    restart.required ? `Docker restart: planned. It may interrupt every running container (${restart.containers.length}): ${list(restart.containers) || "none is running"}` : "Docker restart: none planned.",
    restart.service ? `Paddock service restart: planned. It stops these running sandboxes (${restart.sandboxes.length}): ${list(restart.sandboxes) || "none is running"}` : "Paddock service restart: none planned.",
    "",
    `Verification before the host is registered: sandbox ${shown(smoke.name)} from ${shown(smoke.image)} (${smoke.cpus} CPU, ${smoke.memoryGb} GB memory, ${smoke.diskGb} GB disk, ${smoke.pids} processes), ${smoke.docker ? "with Docker inside" : "without Docker inside"}`,
    ...smoke.operations.map((operation) => `  - ${shown(operation)}`),
    `  Helper image ${shown(smoke.helperImage)}, built on the destination from this Dockerfile:`,
    ...smoke.helperDockerfile.trimEnd().split("\n").map((line) => `    ${shown(line)}`),
    "", "Notes:", ...plan.warnings.map((warning) => `  - ${shown(warning)}`),
  )
  if (plan.blockers.length) lines.push("", `Blockers (${plan.blockers.length}); nothing is installed while one remains:`, ...plan.blockers.map((blocker) => `  ✗ ${shown(blocker)}`))
  lines.push("", `Plan hash: ${shown(plan.hash)}`)
  return lines
}
// What a refused enrollment carries: a revised plan as a plan, anything else as JSON.
function detailLines(details: unknown): string[] {
  const { plan, ...others } = details as { plan?: HostPlan }
  const lines = plan && Array.isArray(plan.steps) ? planLines(plan) : []
  const rest = plan && Array.isArray(plan.steps) ? others : details
  return Object.keys(rest as object).length ? [...lines, shown(JSON.stringify(rest, null, 2), true)] : lines
}

// A refused enrollment says what was changed and what was left, which is longer than other errors: all of it, on one line.
const refusal = (message: string) => shown(message.replace(/\s+/g, " "), true)

const EXIT: Record<ErrorCode, number> = { runtime: 1, usage: 2, "not-found": 3, conflict: 4, dependency: 5, "check-failed": 6, "probes-required": 6, offline: 7, incompatible: 8, "identity-changed": 9, "outcome-unknown": 10 }
let selectedHost: string | undefined
const dirs = defaultDirs()
const compiled = Bun.main.startsWith("/$bunfs/")
const self = compiled ? [process.execPath] : [process.execPath, Bun.main]
const cliDir = compiled ? dirname(process.execPath) : join(dirname(Bun.main), "..", "bin")

// Bun's fetch gives up after 360 seconds by default, and an exec runs as long as its command does: the daemon's own
// deadlines (none locally, 45 minutes for a remote mutation) are the ones that apply.
async function request<T>(method: string, body: object = {}): Promise<T> {
  const response = await fetch(`http://paddock/api/${method}`, { unix: socketPath(dirs), method: "POST", body: JSON.stringify(body), timeout: false } as RequestInit)
  const reply = await response.json() as { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } }
  if (!reply.ok) throw new PaddockError(reply.error.code, reply.error.message, reply.error.details)
  return reply.data
}

// Waits for a stopping daemon to finish: it may still be stopping sandboxes, and a second daemon must not start beside it.
async function daemonGone(): Promise<boolean> {
  const answers = () => request("version").then(() => true, () => false)
  for (let attempt = 0; attempt < 1200; attempt++) { if (!await answers()) return true; await Bun.sleep(100) }
  return false
}

// Starts the daemon when none runs, and replaces one left over from another version of Paddock (its sandboxes keep
// running through the switch).
let daemonReady = false
async function ensureDaemon(): Promise<void> {
  if (daemonReady) return
  checkSocketPath(dirs)
  const probe = () => request<{ version: string; build?: string; stopping?: boolean }>("version").catch(() => undefined)
  const build = () => probe().then((reply) => reply?.build)
  let running = await probe()
  if (running?.stopping) { await daemonGone(); running = undefined }
  if (running?.build !== BUILD) {
    if (running) {
      await request("shutdown", { keepSandboxes: true }).catch(() => {})
      await daemonGone()
    }
    mkdirSync(dirs.state, { recursive: true, mode: 0o700 })
    const log = openSync(join(dirs.state, "daemon.log"), "a", 0o600)
    spawn(self[0]!, [...self.slice(1), "daemon", "run"], { detached: true, stdio: ["ignore", log, log] }).unref()
    for (let attempt = 0; attempt < 100 && await build() !== BUILD; attempt++) await Bun.sleep(100)
    if (await build() !== BUILD) throw new PaddockError("runtime", `The daemon did not start. See ${join(dirs.state, "daemon.log")}.`)
  }
  daemonReady = true
}

// watch: a sandbox whose progress is printed (to stderr) while the call runs.
async function call<T>(method: string, body: object = {}, watch?: string): Promise<T> {
  await ensureDaemon()
  let last = ""
  const timer = watch === undefined ? undefined : setInterval(async () => {
    const view = await request<SandboxView>("get", { name: watch, host: selectedHost }).catch(() => undefined)
    if (view?.activity && view.activity !== last) { last = view.activity; console.error(`  … ${last}`) }
  }, 400)
  const interrupted = () => {
    const name = "name" in body ? shown(body.name) : "NAME"
    const workspace = method === "workspaceCreate" ? ["workspace"] : []
    console.error(`The daemon is still finishing ${name}; it will appear in \`${next(...workspace, "list")}\`. Remove it with \`${next(...workspace, "remove", name, "--confirm", name)}\`.`)
    process.exit(130)
  }
  const buffered = ["create", "workspaceCreate", "resize", "snapshot"].includes(method)
  if (buffered) process.once("SIGINT", interrupted)
  try { return await request<T>(method, { ...body, host: selectedHost }) } finally { clearInterval(timer); if (buffered) process.off("SIGINT", interrupted) }
}

// A session on the daemon's stream socket (core/stream.ts). This process only moves bytes between its own stdio and the
// socket, and waits whenever the other side has not taken what it was given. On a terminal the session gets one too:
// keystrokes, Ctrl-C included, go to the sandbox, and the terminal's settings are put back however the session ends.
async function session(request: OpenRequest | EnrollmentRequest): Promise<never> {
  request = { ...request, host: selectedHost }
  await ensureDaemon()
  const socket = connect(streamSocketPath(dirs))
  const raw = process.stdin.isTTY && (request.kind === "enroll" || (request.kind === "exec" || request.kind === "workspace") && request.tty)
  let restored = !raw
  const restore = () => { if (!restored) { restored = true; try { process.stdin.setRawMode(false) } catch {} } }
  process.on("exit", restore)
  let wrote: Promise<unknown> = Promise.resolve()
  const leave = async (code: number, message?: string): Promise<never> => {
    await wrote
    restore()
    if (message) process.stderr.write(`${raw ? "\r\n" : ""}paddock: ${message}\n`)
    process.exit(code)
  }
  // ssh ends its ProxyCommand with a hangup once it is done, which is not worth a word.
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => void leave(129, request.kind === "ssh" ? undefined : "the session was interrupted."))
  const out = (stream: NodeJS.WriteStream, bytes: Uint8Array) => {
    wrote = new Promise((resolve) => { if (!stream.write(bytes, resolve)) { socket.pause(); stream.once("drain", () => socket.resume()) } })
  }
  const reader = new FrameReader()
  let ready = false
  socket.on("connect", () => socket.write(frame("open", request)))
  socket.on("error", (error) => void leave(1, `could not reach the daemon's session socket: ${error.message}`))
  socket.on("close", () => void leave(1, ready ? "the session was lost before the command ended." : "the daemon closed the session."))
  socket.on("data", (chunk: Buffer) => {
    for (const { kind, payload } of reader.push(chunk)) {
      if (kind === "stdout") out(process.stdout, payload)
      else if (kind === "stderr") out(process.stderr, payload)
      else if (kind === "exit") { socket.removeAllListeners("close"); void leave(Number(JSON.parse(payload.toString()).code)) }
      else if (kind === "error") {
        socket.removeAllListeners("close")
        const error = JSON.parse(payload.toString()) as { code: ErrorCode; message: string }
        void leave(EXIT[error.code] ?? 1, request.kind === "enroll" ? refusal(error.message) : shown(error.message))
      } else if (kind === "ready" && !ready) {
        ready = true
        const warning = (JSON.parse(payload.toString()) as { diskWarning?: DiskWarning }).diskWarning
        if (warning) process.stderr.write(`${shown(warning.message)}\n`)
        if (raw) {
          process.stdin.setRawMode(true); restored = false
          // A terminal that reports no size (0 by 0) keeps the sandbox's default.
          const resize = () => { if (process.stdout.columns > 0 && process.stdout.rows > 0) socket.write(frame("resize", { cols: process.stdout.columns, rows: process.stdout.rows })) }
          process.on("SIGWINCH", resize); resize()
        }
        process.stdin.on("data", (bytes: Buffer) => { if (!dataFrames("stdin", bytes).map((piece) => socket.write(piece)).at(-1)) process.stdin.pause() })
        socket.on("drain", () => process.stdin.resume())
        process.stdin.on("end", () => socket.write(frame("eof")))
        process.stdin.resume()
      }
    }
  })
  return new Promise<never>(() => {})
}

const APPLIES: Record<ResizeChange["applies"], string> = { now: "now", "next start": "at the next start", unchanged: "unchanged", "not enforced": "recorded, not enforced" }
const LIMIT: Record<ResizeChange["limit"], string> = { cpus: "CPUs", memoryGb: "memory (GB)", pids: "task limit", diskGb: "disk (GB)" }
const MARK: Record<CheckResult["status"], string> = { pass: "✓", weak: "~", fail: "✗", unsupported: "–", unknown: "?", info: "i" }
const MEANING: Record<CheckResult["status"], string> = { pass: "holds", weak: "holds in a weaker form", fail: "does not hold", unsupported: "not available on this engine", unknown: "could not be checked", info: "for your information" }
// full lists every check; otherwise the passes are counted on one line, with the command that lists them, and every
// other result is printed in full. The legend names only the marks shown.
function printChecks(checks: CheckResult[], checklist = CHECKLIST, full: string | true = true): void {
  const passed = checks.filter((check) => check.status === "pass")
  if (full !== true && passed.length) console.log(`  ✓ ${passed.length} ${passed.length === 1 ? "check holds" : "checks hold"}. Each one is listed by \`${full}\`.`)
  for (const check of full === true ? checks : checks.filter((check) => check.status !== "pass")) {
    const item = checklist.find((entry) => entry.id === check.id)
    console.log(`  ${MARK[check.status] ?? "?"} ${item?.title ?? shown(check.id)}${check.status === "pass" || check.status === "info" ? "" : ` [${shown(check.status)}]`}\n      ${shown(check.detail)}${check.evidence === "none" ? "" : ` (${shown(check.evidence)})`}`)
  }
  const shownMarks = (Object.keys(MARK) as Array<CheckResult["status"]>).filter((status) => checks.some((check) => check.status === status))
  if (shownMarks.length) console.log(`\n  ${shownMarks.map((status) => `${MARK[status]} ${MEANING[status]}`).join("   ")}`)
}

function printSandbox(view: SandboxView): void {
  console.log(`${displayName(view.name)}: ${shown(view.status)} on ${shown(view.engine)}${view.stopReason ? `\n  ${shown(view.stopReason)}` : ""}`)
  if (view.diskWarning) console.log(`  ${shown(view.diskWarning.message)}`)
  if (view.enforcementProblem) console.log(`  Enforcement problem at ${shown(view.enforcementProblem.at)}: ${shown(view.enforcementProblem.message)}`)
}
const displayName = (name: string) => shown(selectedHost && selectedHost !== "local" ? `${selectedHost}/${name}` : name)
// A command to run next, on the machine this one addressed.
const next = (...words: string[]) => `paddock${selectedHost && selectedHost !== "local" ? ` --host ${selectedHost}` : ""} ${words.map((word) => shown(word)).join(" ")}`
// Engines report times with their own offset; shown in UTC, as labelled.
const utc = (at: string) => { const date = new Date(at); return Number.isNaN(date.getTime()) ? shown(at) : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC` }

// Buffered input travels as base64 so every byte arrives as it was; a string would lose bytes that are not UTF-8.
const stdinBytes = async () => ({ stdinBase64: Buffer.from(await Bun.stdin.arrayBuffer()).toString("base64") })
// Waits for the output to be written before exiting: into a pipe, an exit right after a write loses what did not fit.
async function printRun(output: RunResult & { diskWarning?: DiskWarning }, asJson = false): Promise<never> {
  const write = (stream: NodeJS.WriteStream, text: string) => new Promise<void>((resolve, reject) => stream.write(text, (error) => error ? reject(error) : resolve()))
  if (!asJson && output.diskWarning) await write(process.stderr, `${shown(output.diskWarning.message)}\n`)
  await write(process.stdout, asJson ? `${JSON.stringify({ ok: true, data: output })}\n` : output.stdout)
  if (!asJson) await write(process.stderr, output.stderr)
  process.exit(output.exitCode)
}

async function main(argv: string[]): Promise<void> {
  try { const parsed = hostOption(argv); selectedHost = parsed.host; argv = parsed.argv } catch (error) {
    const message = (error as Error).message
    if (argv.slice(0, argv.indexOf("--") < 0 ? undefined : argv.indexOf("--")).includes("--json")) console.log(JSON.stringify({ ok: false, error: { code: "usage", message } }))
    else console.error(`paddock: ${message}`)
    process.exit(2)
  }
  const split = argv.indexOf("--")
  const head = split < 0 ? argv : argv.slice(0, split); const tail = split < 0 ? [] : argv.slice(split + 1)
  const asJson = head.includes("--json")
  const [command, ...rest] = head.filter((arg) => arg !== "--json")
  const out = (data: unknown, human: () => void) => { if (asJson) console.log(JSON.stringify({ ok: true, data })); else human() }
  // Progress lines only for a person: --json output stays one line.
  const watching = (name: string) => asJson ? undefined : name
  const parse = (options: Record<string, { type: "string" | "boolean" }>, args = rest) => {
    try { return parseArgs({ args, options, allowPositionals: true }) }
    catch (error) { throw argumentError(error, args === rest ? command! : `${command} ${rest[0]}`) }
  }
  // The sandbox a create was making, for the next steps of a refusal.
  let creating: string | undefined
  const helpWords = [command, ...(["workspace", "host", "forward", "link", "template", "config", "ssh", "ext", "daemon"].includes(command ?? "") ? [rest[0]] : [])].filter(Boolean).join(" ")
  const need = (value: string | boolean | undefined, what: string) => { if (typeof value !== "string" || !value) throw new PaddockError("usage", `Missing ${what}. See \`paddock ${helpWords} --help\`.`); return value }

  try {
    const asked = command === "help" || command === "--help" || command === "-h" ? rest : rest.includes("--help") || rest.includes("-h") ? [command!, ...rest.filter((arg) => arg !== "--help" && arg !== "-h")] : []
    if (asked.length) {
      const text = commandHelp(asked)
      if (!text) throw new PaddockError("usage", `Unknown command ${asked[0]}. See \`paddock help\`.`)
      return out({ help: text }, () => console.log(text))
    }
    switch (command) {
      case "config": {
        const { positionals } = parse({})
        const [action, key, value] = positionals
        const settings: Record<string, keyof Config> = { "require-probes": "requireProbes", experimental: "experimental" }
        const gb = key === "workspace-free-space" && /^\d+(\.\d+)?$/.test(value ?? "")
        if (!((action === "get" && positionals.length === 1) || (action === "set" && positionals.length === 3 && (gb || (Object.hasOwn(settings, key!) && (value === "on" || value === "off"))))))
          throw new PaddockError("usage", "Use paddock config get, paddock config set require-probes|experimental on|off, or paddock config set workspace-free-space GB.")
        const config = await call<Config>(action === "get" ? "configGet" : "configSet", action === "get" ? {} : gb ? { workspaceFreeSpaceGb: Number(value) } : { [settings[key!]!]: value === "on" })
        const lines = { "require-probes": config.requireProbes ? "on" : "off", experimental: config.experimental ? "on" : "off", "workspace-free-space": `${config.workspaceFreeSpaceGb} GB` }
        return out(config, () => { for (const [name, text] of Object.entries(lines)) if (action === "get" || name === key) console.log(`${name} ${text}`) })
      }
      case "workspace": {
        if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "Workspaces run on this Mac; --host is not available.")
        if (process.platform !== "darwin") throw new PaddockError("dependency", "Workspaces are available only on macOS. A workspace is not a sandbox.")
        const action = rest[0]
        const { values, positionals } = (() => {
          try { return parseArgs({ args: rest.slice(1), allowPositionals: true, options: {
            read: { type: "string", multiple: true }, path: { type: "string", multiple: true }, copy: { type: "string" }, loopback: { type: "string" }, confirm: { type: "string" }, stdin: { type: "boolean" }, stream: { type: "boolean" },
            "host-temp": { type: "boolean" }, disk: { type: "string" }, "no-logins": { type: "boolean" }, "claude-profile": { type: "string" }, "codex-profile": { type: "string" },
          } }) } catch (error) { throw argumentError(error, `workspace ${action}`) }
        })()
        if (values["host-temp"] !== undefined && action !== "create") throw new PaddockError("usage", "--host-temp is a create option. Use workspace set NAME host-temp on|off to change it.")
        if (values.disk !== undefined && action !== "create") throw new PaddockError("usage", "--disk is a create option. Use workspace set NAME disk GB to change it.")
        const localPath = (path: string) => path === "~" || path.startsWith("~/") ? path : resolve(path)
        if (values["no-logins"] && (values["claude-profile"] !== undefined || values["codex-profile"] !== undefined)) throw new PaddockError("usage", "Choose --no-logins or named login profiles, not both.")
        // Only list and get measure size; elsewhere the field is left out rather than shown as unknown.
        const show = (view: WorkspaceView, measured = false) => console.log(`${shown(view.name)}: workspace, not a sandbox; ${shown(view.status)}, host-temp ${view.spec ? view.spec.hostTemp ? "on (shared, weaker)" : "off" : "unknown"}, ${view.processes ?? "unknown"} processes${view.sizeBytes !== undefined ? `, ${(view.sizeBytes / 1024 ** 2).toFixed(1)} MiB` : measured ? ", size unknown" : ""}${view.spec?.diskGb !== undefined ? `, disk limit ${view.spec.diskGb} GB (watched)` : ""}${view.folder ? `\n  ${shown(view.folder)}` : ""}${view.problem ? `\n  ${shown(view.problem)}` : ""}${view.stopReason ? `\n  ${shown(view.stopReason)}` : ""}${view.enforcementProblem ? `\n  Disk watch unknown at ${shown(view.enforcementProblem.at)}: ${shown(view.enforcementProblem.message)}` : ""}`)
        const disclose = (disclosure = WORKSPACE_DISCLOSURE) => console.log(`\n${shown(disclosure)}`)
        if (action === "list") {
          const workspaces = await call<WorkspaceView[]>("workspaceList")
          return out(workspaces, () => { for (const workspace of workspaces) { show(workspace, true); if (workspace.spec?.hostTemp) console.log(shown(workspace.disclosure)) } if (!workspaces.length) console.log("No workspaces."); disclose() })
        }
        const name = need(positionals[0], "a workspace name")
        if (action === "create" || action === "verify") {
          const report = await call<WorkspaceReport>(action === "create" ? "workspaceCreate" : "workspaceVerify", { name,
            ...(action === "create" ? { hostTemp: values["host-temp"] ?? false, ...(values.disk !== undefined ? { diskGb: values.disk } : {}), reads: values.read?.map(localPath), path: values.path?.map(localPath), copy: values.copy ? localPath(values.copy) : undefined, loopback: values.loopback,
              logins: values["no-logins"] ? { kind: "none" } : { kind: "profiles", claude: values["claude-profile"] ?? "default", codex: values["codex-profile"] ?? "default" } } : {}) })
          out(report, () => { show(report.workspace); printChecks(report.checks, WORKSPACE_CHECKLIST, action === "create" ? `paddock workspace verify ${shown(name)}` : true); for (const path of report.pathSuggestions ?? []) console.log(`Tool folder under home, closed unless declared with --read: ${shown(path)}`)
            // The not-covered check already carries the disclosure when verification reached it.
            if (!report.checks.some((check) => check.detail.includes(WORKSPACE_DISCLOSURE))) disclose(report.workspace.disclosure)
            if (report.ok && action === "create") console.log(`\nNext: paddock workspace shell ${shown(name)}`) })
          if (!report.ok) process.exit(EXIT["check-failed"])
          return
        }
        if (action === "set") {
          const [, key, value] = positionals
          const disk = key === "disk" && /^\d+(\.\d+)?$/.test(value ?? "")
          if (positionals.length !== 3 || !(disk || (key === "host-temp" && ["on", "off"].includes(value!)))) throw new PaddockError("usage", "Use paddock workspace set NAME host-temp on|off (stop the workspace first), or paddock workspace set NAME disk GB.")
          const view = await call<WorkspaceView>("workspaceSet", disk ? { name, diskGb: Number(value) } : { name, hostTemp: value === "on" })
          return out(view, () => { show(view); disclose(view.disclosure) })
        }
        if (action === "get" || action === "stop") { const view = await call<WorkspaceView>(action === "get" ? "workspaceGet" : "workspaceStop", { name }); return out(view, () => { show(view, action === "get"); disclose(view.disclosure) }) }
        if (action === "remove") {
          const removed = await call<WorkspaceRemoval>("workspaceRemove", { name, confirm: values.confirm })
          return out(removed, () => { console.log(`Removed workspace ${shown(removed.removed)}, not a sandbox.`); for (const path of removed.hardLinks) console.log(`Multiple hard links: ${shown(path)}`); for (const issue of [...removed.launchServices, ...removed.launchd]) console.log(shown(issue)); console.log(`Not removed or not covered: ${removed.notRemoved.map((item) => shown(item)).join("; ")}.`); disclose(removed.disclosure) })
        }
        if (action === "exec") {
          if (!tail.length) throw new PaddockError("usage", "Give the workspace command after --.")
          if (values.stream && (asJson || values.stdin)) throw new PaddockError("usage", "--stream takes neither --json nor --stdin.")
          if (!asJson) {
            const view = await call<WorkspaceView>("workspaceGet", { name, withSize: false })
            console.error(`Workspace, not a sandbox. Network and loopback open; disk watched, no other resource limits.${view.spec?.hostTemp ? ` ${HOST_TEMP_DISCLOSURE}` : ""}`)
          }
          if (values.stream) return await session({ kind: "workspace", name, argv: tail, tty: false })
          return printRun(await call<RunResult>("workspaceExec", { name, argv: tail, ...(values.stdin ? await stdinBytes() : {}) }), asJson)
        }
        if (action === "shell") {
          if (asJson) throw new PaddockError("usage", "An interactive workspace shell does not support --json.")
          const prepared = await call<{ argv: string[]; workspace: WorkspaceView }>("workspaceShell", { name })
          console.error(shown(prepared.workspace.disclosure))
          const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
          return await session({ kind: "workspace", name, argv: tail.length ? tail : prepared.argv, tty,
            ...(tty && process.stdout.columns > 0 && process.stdout.rows > 0 ? { cols: process.stdout.columns, rows: process.stdout.rows } : {}) })
        }
        throw new PaddockError("usage", "Use paddock workspace create|set|shell|exec|list|get|stop|remove|verify.")
      }
      case undefined: case "help": case "--help": case "-h": return out({ help: HELP }, () => console.log(HELP))
      case "version": case "--version": return out({ version: VERSION }, () => console.log(VERSION))
      case "doctor": case "init": {
        const engines = await call<Engine[]>("engines")
        out(engines, () => {
          if (!engines.length) console.log("No engine found. Paddock needs Docker (OrbStack, a Linux host, Colima, …) with a gVisor runtime.")
          for (const engine of engines) {
            console.log(`${engine.ready ? "✓" : "✗"} ${shown(engine.label)}  [${shown(engine.id)}]`)
            if (engine.capabilities) console.log(`    kernel isolation: ${shown(engine.capabilities.kernelIsolation)}; network guard: ${engine.capabilities.networkGuard ? "yes" : "no"}; disk limit: ${shown(engine.capabilities.diskLimit)}; inner Docker: ${engine.capabilities.docker ? "yes" : "no"}`)
            for (const problem of engine.problems) console.log(`    ${shown(problem)}`)
            if (engine.fix) console.log(`    Fix: ${shown(engine.fix)}`)
          }
          if (engines.some((engine) => engine.ready)) console.log(`Next: ${next("create", "NAME")}`)
        })
        if (!engines.some((engine) => engine.ready)) process.exit(EXIT.dependency)
        return
      }
      case "create": {
        const { values, positionals } = parse({ docker: { type: "boolean" }, image: { type: "string" }, template: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, pids: { type: "string" }, engine: { type: "string" } })
        const name = need(positionals[0], "a name"); creating = name
        const made = await call<{ sandbox: SandboxView; checks: CheckResult[]; hooks: Array<{ extension: string; exitCode: number; output: string }> }>("create",
          { name, docker: values.docker, image: values.image, template: values.template, cpus: values.cpus, memoryGb: values.memory, diskGb: values.disk, pids: values.pids, engine: values.engine }, watching(name))
        return out(made, () => {
          printSandbox(made.sandbox); printChecks(made.checks, CHECKLIST, next("verify", name))
          for (const hook of made.hooks) console.log(`\n  ${shown(hook.extension)} (after create): ${hook.exitCode === 0 ? "done" : `failed with exit ${hook.exitCode}`}${hook.output ? `\n${shown(hook.output, true)}` : ""}`)
          console.log(`\nNext: ${next("shell", name)}`)
        })
      }
      case "list": case "ls": {
        const { values } = parse({ all: { type: "boolean" } })
        if (values.all) {
          if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "Use --all or --host, not both.")
          const fleet = await call<FleetView>("fleet")
          return out(fleet, () => {
            for (const row of fleet.machines) {
              console.log(`${shown(row.machine.host.name)}: ${shown(row.machine.state)}${"error" in row.machine && row.machine.error ? ` (${shown(row.machine.error)})` : ""}${row.stale ? "; sandboxes unknown" : ""}`)
              for (const sandbox of row.cached?.sandboxes ?? []) console.log(`  ${shown(row.machine.host.name)}/${shown(sandbox.name)}: ${shown(sandbox.status)}${row.stale ? ` (last checked ${shown(row.cached?.checkedAt)})` : ""}${sandbox.status === "damaged" ? `\n    ${shown(sandbox.stopReason)}` : ""}${sandbox.enforcementProblem ? `\n    Enforcement unknown at ${shown(sandbox.enforcementProblem.at)}: ${shown(sandbox.enforcementProblem.message)}` : ""}`)
            }
          })
        }
        const list = await call<SandboxView[]>("list")
        return out(list, () => {
          if (!list.length) console.log("No sandboxes. Create one with `paddock create NAME`.")
          for (const view of list) {
            const verified = view.lastVerify ? `verified ${Math.max(0, Math.floor((Date.now() - Date.parse(view.lastVerify.at)) / 60000))} min ago` : "never verified"
            if (view.status === "damaged") { console.log(`${displayName(view.name).padEnd(24)} damaged\n    ${shown(view.stopReason)}`); continue }
            console.log(`${displayName(view.name).padEnd(24)} ${shown(view.status).padEnd(8)} ${view.spec.cpus} CPU  ${view.spec.memoryGb} GB  disk limit ${view.spec.diskGb} GB  ${shown(view.engine)}${view.template ? `  template ${shown(view.template.name)}` : ""}  (${verified})${view.stopReason ? `\n    ${shown(view.stopReason)}` : ""}`)
            if (view.enforcementProblem) console.log(`    Enforcement problem at ${shown(view.enforcementProblem.at)}: ${shown(view.enforcementProblem.message)}`)
          }
          if (list.some((view) => view.lastVerify)) console.log("Verification is historical only; current checks are unknown.")
        })
      }
      case "start": case "stop": {
        const view = await call<SandboxView>(command, { name: need(rest[0], "a name") }, watching(rest[0]!))
        return out(view, () => {
          printSandbox(view)
          if (command === "start") console.log(`  Its configuration was checked before it started and its runtime after; its network was not tested. To test it: ${next("verify", view.name)}`)
        })
      }
      case "verify": {
        const report = await call<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean }>("verify", { name: need(rest[0], "a name") }, watching(rest[0]!))
        out(report, () => { if (report.sandbox.status === "stopped") console.log(`${shown(report.sandbox.name)} is stopped; only its configuration was checked. Run \`${next("start", report.sandbox.name)}\`, then \`${next("verify", report.sandbox.name)}\` to check the rest.`); printSandbox(report.sandbox); printChecks(report.checks) })
        if (!report.ok) process.exit(EXIT["check-failed"])
        return
      }
      case "resize": {
        const { values, positionals } = parse({ cpus: { type: "string" }, memory: { type: "string" }, pids: { type: "string" }, disk: { type: "string" } })
        const name = need(positionals[0], "a name")
        const resized = await call<{ sandbox: SandboxView; changes: ResizeChange[]; checks: CheckResult[] }>("resize", { name, cpus: values.cpus, memoryGb: values.memory, pids: values.pids, diskGb: values.disk }, watching(name))
        return out(resized, () => {
          printSandbox(resized.sandbox)
          for (const change of resized.changes) console.log(`  ${LIMIT[change.limit]}: ${change.from === change.to ? change.to : `${change.from} -> ${change.to}`}, ${APPLIES[change.applies]}${change.note ? `\n      ${shown(change.note)}` : ""}`)
          console.log(""); printChecks(resized.checks, CHECKLIST, next("verify", name))
        })
      }
      case "snapshot": {
        const { values, positionals } = parse({ as: { type: "string" } })
        const name = need(positionals[0], "a name")
        const saved = await call<{ template: Template; contents: string }>("snapshot", { name, as: need(values.as, "--as TEMPLATE") }, watching(name))
        return out(saved, () => {
          console.log(`Saved ${name} as template ${shown(saved.template.name)} (${(saved.template.sizeBytes / 1024 ** 2).toFixed(0)} MB). Use it with \`paddock create NAME --template ${shown(saved.template.name)}\`.`)
          console.log(`  Login files left out: ${shown(saved.template.loginsRemoved.join(", ")) || "none were present"}.`)
          console.log(`  ${shown(saved.contents)}`)
        })
      }
      case "template": case "templates": {
        const { values, positionals } = parse({ engine: { type: "string" } }, rest.slice(1))
        if (rest[0] === "list" || rest[0] === undefined) {
          const list = await call<Template[]>("templateList")
          return out(list, () => {
            if (!list.length) console.log("No templates. Save one with `paddock snapshot NAME --as TEMPLATE`.")
            for (const template of list) console.log(`${shown(template.name).padEnd(24)} from ${shown(template.source)} (${shown(template.sourceImage)}), ${utc(template.createdAt)}, ${(template.sizeBytes / 1024 ** 2).toFixed(0)} MB, ${shown(template.engine)}${template.dependants.length ? `\n    used by ${shown(template.dependants.join(", "))}` : ""}`)
          })
        }
        if (rest[0] === "remove" || rest[0] === "rm") {
          const removed = await call<{ removed: string; note: string }>("templateRemove", { name: need(positionals[0], "a template name"), engine: values.engine })
          return out(removed, () => console.log(`Removed template ${shown(removed.removed)}. ${shown(removed.note)}`))
        }
        throw new PaddockError("usage", "Use `paddock template list` or `paddock template remove TEMPLATE`.")
      }
      case "remove": case "rm": {
        const { values, positionals } = parse({ confirm: { type: "string" } })
        const removed = await call<{ removed: string; warning?: string }>("remove", { name: need(positionals[0], "a name"), confirm: values.confirm })
        return out(removed, () => { console.log(`Removed ${shown(removed.removed)}.`); if (removed.warning) console.error(`paddock: ${shown(removed.warning)}`) })
      }
      case "exec": {
        const { values, positionals } = parse({ user: { type: "string" }, stdin: { type: "boolean" }, stream: { type: "boolean" } })
        if (!tail.length) throw new PaddockError("usage", "Give the command after --, as in `paddock exec NAME -- ls -la`.")
        if (values.stream && (asJson || values.stdin)) throw new PaddockError("usage", "--stream passes bytes through as they come, so it takes neither --json nor --stdin (its input is always this command's).")
        if (values.stream) return await session({ kind: "exec", name: need(positionals[0], "a name"), argv: tail, tty: false, ...(typeof values.user === "string" ? { user: values.user } : {}) })
        const output = await call<RunResult>("exec", { name: need(positionals[0], "a name"), argv: tail, user: values.user, ...(values.stdin ? await stdinBytes() : {}) })
        return printRun(output, asJson)
      }
      case "shell": {
        const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
        return await session({ kind: "exec", name: need(rest[0], "a name"), argv: tail.length ? tail : ["sh", "-c", "command -v bash >/dev/null && exec bash -l || exec sh -l"], tty,
          ...(tty && process.stdout.columns > 0 && process.stdout.rows > 0 ? { cols: process.stdout.columns, rows: process.stdout.rows } : {}) })
      }
      case "forward": {
        const { values, positionals } = parse({ port: { type: "string" }, "local-port": { type: "string" } }, rest.slice(1))
        if (rest[0] === "add") {
          const made = await call<ForwardView>("forwardAdd", { name: need(positionals[0], "a name"), port: need(values.port, "--port"), localPort: values["local-port"] })
          return out(made, () => {
            console.log(`Forwarding 127.0.0.1:${made.localPort} to port ${made.port} in ${displayName(made.name)} (forward ${shown(made.id)}). It ends when the sandbox stops or the daemon stops; for a sandbox on another machine, also when either daemon stops or its SSH link is silent for 15 seconds. Then add it again.`)
            console.log(`  ${FORWARD_REACH.replace("these", "it")}`)
            console.log(`Remove it: ${next("forward", "remove", made.id)}`)
          })
        }
        if (rest[0] === "list" || rest[0] === undefined) {
          const list = await call<ForwardView[]>("forwardList", { name: positionals[0] })
          return out(list, () => {
            if (!list.length) console.log("No forwards. Add one with `paddock forward add NAME --port PORT`.")
            for (const forward of list) console.log(`${shown(forward.id)}  127.0.0.1:${forward.localPort} -> ${shown(forward.name)}:${forward.port}  ${forward.connections} open, since ${utc(forward.createdAt)}`)
          })
        }
        if (rest[0] === "remove" || rest[0] === "rm") {
          const closed = await call<{ closed: string }>("forwardRemove", { id: need(positionals[0], "a forward id") })
          return out(closed, () => console.log(`Closed forward ${closed.closed}.`))
        }
        throw new PaddockError("usage", "Use `paddock forward add NAME --port PORT`, `paddock forward list [NAME]` or `paddock forward remove ID`.")
      }
      case "link": {
        const { values, positionals } = parse({ port: { type: "string" } }, rest.slice(1))
        const state = (link: LinkView) => link.state === "open" ? `open, ${link.connections} connection${link.connections === 1 ? "" : "s"}` : `${shown(link.state)}: ${shown(link.reason)}`
        if (rest[0] === "add") {
          const made = await call<LinkView>("linkAdd", { from: need(positionals[0], "FROM"), to: need(positionals[1], "TO"), port: need(values.port, "--port") })
          return out(made, () => {
            console.log(made.state === "open"
              ? `Linked: programs in ${shown(made.from)} connect to ${shown(made.to)}:${made.port} (${shown(made.address)}:${made.port}) and reach port ${made.port} on ${shown(made.to)}'s loopback, nothing else. Measured just now.`
              : `Linked ${shown(made.from)} to ${shown(made.to)}:${made.port}. It opens, and is measured, once both are running (${shown(made.reason)}).`)
            console.log(`  ${shown(made.trust)}`)
            console.log(`  ${LINK_LIMITS}`)
          })
        }
        if (rest[0] === "list" || rest[0] === undefined) {
          const list = await call<LinkView[]>("linkList", { name: positionals[0] })
          return out(list, () => {
            if (!list.length) console.log("No links. Add one with `paddock link add FROM TO --port PORT`.")
            for (const link of list) console.log(`${shown(link.from)} -> ${shown(link.to)}:${link.port}  ${state(link)}${link.measured ? `; measured ${utc(link.measured.at)}: ${shown(link.measured.status)}` : ""}`)
          })
        }
        if (rest[0] === "remove" || rest[0] === "rm") {
          const removed = await call<{ removed: { from: string; to: string; port: number }; measured: string }>("linkRemove", { from: need(positionals[0], "FROM"), to: need(positionals[1], "TO"), port: need(values.port, "--port") })
          return out(removed, () => console.log(`Removed the link from ${shown(removed.removed.from)} to ${shown(removed.removed.to)}:${removed.removed.port}. ${shown(removed.measured)}`))
        }
        throw new PaddockError("usage", "Use `paddock link add FROM TO --port PORT`, `paddock link list [NAME]` or `paddock link remove FROM TO --port PORT`.")
      }
      case "ssh": {
        const { values, positionals } = parse({ "write-config": { type: "boolean" }, "sandbox-id": { type: "string" } }, rest.slice(1))
        // The ProxyCommand an alias runs; ssh speaks through this process's stdin and stdout.
        if (rest[0] === "proxy") return await session({ kind: "ssh", name: need(positionals[0], "a name"), ...(typeof values["sandbox-id"] === "string" ? { sandboxId: values["sandbox-id"] } : {}) })
        if (rest[0] === "setup") {
          const done = await call<SshAccess & { config: string; include: string; included: boolean; editorKey: string; keyFile: string }>("sshSetup", { name: need(positionals[0], "a name"), writeConfig: values["write-config"] === true }, positionals[0])
          return out(done, () => console.log(done.included
            ? `\`ssh ${shown(done.alias)}\` logs in as ${shown(done.user)} with the key ${shown(done.editorKey)} (${done.keyFile}).`
            : `Set up. Add this line at the top of ${done.config}, or run again with --write-config:\n  ${done.include}\nThen \`ssh ${shown(done.alias)}\` logs in as ${shown(done.user)} with the key ${shown(done.editorKey)}.`))
        }
        if (rest[0] === "access") {
          const name = need(positionals[0], "a name")
          const access = await call<SshAccess>("sshAccess", { name })
          // Why not, in the order a person fixes it: set up, running, included.
          const why = async () => {
            if (!access.user) return `: run \`${next("ssh", "setup", name)}\``
            const view = await call<SandboxView>("get", { name }).catch(() => undefined)
            if (view && view.status !== "running") return `: ${shown(name)} is ${shown(view.status)}. Start it with \`${next("start", name)}\``
            if (!await included(dirs)) return `: ${userConfig()} does not include Paddock's file. Run \`${next("ssh", "setup", name, "--write-config")}\`, or add the line it prints`
            return ""
          }
          const reason = asJson || access.batchReady ? "" : await why()
          return out(access, () => console.log(`${shown(access.alias)}: ${access.user ? `${shown(access.user)}, home ${shown(access.home)}` : "not set up"}; ${access.batchReady ? "ready" : `not ready${reason}`}`))
        }
        throw new PaddockError("usage", "Use `paddock ssh setup NAME [--write-config]` or `paddock ssh access NAME`.")
      }
      case "ext": {
        if (rest[0] === "list" || rest[0] === undefined) {
          const loaded = await call<{ extensions: Extension[]; errors: string[] }>("extensions")
          return out(loaded, () => {
            if (!loaded.extensions.length) console.log(`No extensions. Put one in ${join(dirs.config, "extensions")}.`)
            for (const extension of loaded.extensions) {
              console.log(`${shown(extension.id)}: ${shown(extension.name)}${extension.description ? ` (${shown(extension.description)})` : ""}`)
              for (const action of extension.actions) console.log(`  ${shown(action.id)}: ${shown(action.label)}${action.fields.length ? `  [${shown(action.fields.map((field) => field.id).join(", "))}]` : ""}`)
            }
            for (const error of loaded.errors) console.log(`! ${shown(error)}`)
          })
        }
        if (rest[0] !== "run") throw new PaddockError("usage", "Use `paddock ext list` or `paddock ext run EXTENSION ACTION [SANDBOX]`.")
        let parsed
        try { parsed = parseArgs({ args: rest.slice(1), options: { set: { type: "string", multiple: true } }, allowPositionals: true }) } catch (error) { throw argumentError(error, "ext run") }
        const { values, positionals } = parsed
        const fields = Object.fromEntries((values.set ?? []).map((pair) => { const at = pair.indexOf("="); return at < 0 ? [pair, "true"] : [pair.slice(0, at), pair.slice(at + 1)] }))
        const output = await call<RunResult>("action", { extension: need(positionals[0], "an extension"), action: need(positionals[1], "an action"), sandbox: positionals[2], values: fields })
        return printRun(output, asJson)
      }
      case "ui": {
        if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "The dashboard is on the primary machine.")
        await ensureDaemon()
        const daemon = await readDaemonFile(dirs)
        if (!daemon) throw new PaddockError("runtime", "The daemon is not running.")
        const url = `http://127.0.0.1:${daemon.port}/#token=${daemon.token}`
        if (!daemon.port) return out({ url }, () => console.log("No dashboard: this daemon was started with PADDOCK_SOCKET_ONLY=1, so it answers on its socket only."))
        // On Windows `start` is part of cmd, not a program; its first quoted argument is a window title.
        if (rest.includes("--open")) Bun.spawn(process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url])
        return out({ url }, () => console.log(url))
      }
      case "daemon": {
        if (selectedHost && selectedHost !== "local") {
          if (rest[0] === "run") throw new PaddockError("usage", "Start a remote daemon through its service; routing never installs or starts one.")
          const result = await call(rest[0] === "stop" ? "shutdown" : "version")
          return out(result, () => console.log(JSON.stringify(result)))
        }
        if (rest[0] === "run") return await runDaemon(dirs, cliDir)
        if (rest[0] === "stop") {
          const asked = await request("shutdown").then(() => true, (error) => error instanceof PaddockError && error.code === "conflict")
          const stopped = asked && await daemonGone()
          return out({ stopped }, () => console.log(stopped ? "The daemon stopped, and with it every sandbox whose disk limit only the daemon enforces."
            : asked ? "The daemon is still stopping its sandboxes." : "The daemon was not running."))
        }
        const version = await request<{ version: string }>("version").catch(() => undefined)
        const daemon = version ? await readDaemonFile(dirs) : undefined
        return out({ running: Boolean(version), ...daemon, token: undefined }, () => console.log(version ? `Running: version ${version.version}, pid ${daemon?.pid}, ${daemon?.port ? `dashboard on port ${daemon.port}` : "no dashboard (socket only)"}.` : "Not running. It starts with the first command."))
      }
      case "host": {
        if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "The host registry belongs to the primary machine.")
        const { values, positionals } = parse({ ssh: { type: "string" }, binary: { type: "string" }, "state-dir": { type: "string" }, confirm: { type: "string" }, artifact: { type: "string" }, sha256: { type: "string" }, sudo: { type: "string" }, "disk-policy": { type: "string" }, "accept-plan": { type: "string" }, docker: { type: "boolean" } }, rest.slice(1))
        if (rest[0] === "add") {
          const plan = await call<HostPlan>("hostPlan", { name: need(positionals[0], "a host name"), ssh: need(values.ssh, "--ssh DEST"), artifact: { path: resolve(need(values.artifact, "--artifact PATH")), sha256: need(values.sha256, "--sha256 HASH") }, sudo: values.sudo, diskPolicy: values["disk-policy"], docker: values.docker })
          if (asJson) return out(plan, () => {})
          console.log(planLines(plan).join("\n"))
          if (values["accept-plan"] !== undefined) {
            if (values["accept-plan"] !== plan.hash) throw new PaddockError("conflict", "Consent is stale. Review the revised plan above and accept its hash. Nothing was installed.", { plan })
          }
          if (plan.blockers.length) throw new PaddockError("dependency", `Enrollment refused before installation: ${plan.blockers.join(" ")}`)
          if (values["accept-plan"] === undefined) {
            if (!process.stdin.isTTY) throw new PaddockError("usage", "Review --json and use --accept-plan HASH, or run from a terminal and enter yes. Nothing was installed.")
            const terminal = createInterface({ input: process.stdin, output: process.stdout })
            let answer: string
            try { answer = await terminal.question("Apply this exact plan? Enter yes: ") } finally { terminal.close() }
            if (answer !== "yes") throw new PaddockError("conflict", "Enrollment declined. Nothing was installed or registered.")
            return await session({ kind: "enroll", hash: plan.hash, accepted: true })
          }
          const host = await call("hostApply", { hash: plan.hash, accepted: true })
          return out(host, () => console.log(`Enrolled ${plan.options.name}. Disk limit is watched. Verification passed; reboot persistence is not measured.`))
        }
        if (rest[0] === "list" || rest[0] === undefined) {
          const hosts = await call<HostView[]>("hostList")
          return out(hosts, () => {
            if (!hosts.length) console.log("No registered hosts. Attach an already prepared daemon with `paddock host attach`.")
            for (const view of hosts) {
              if (view.state === "unknown-record") { console.log(`${shown(view.host.name)}: unknown record${view.host.ssh ? ` (${shown(view.host.ssh)})` : ""}\n  ${shown(view.error)}`); continue }
              const { host, state, receivedAt, hello, error } = view
              const runs = hello ? `${hello.listener === "socket-only" ? "socket-only" : hello.listener === "dashboard" ? "dashboard listener open on its loopback" : "listener unknown"}, ${hello.service === "systemd" ? "a systemd service" : hello.service === "none" ? "not a service" : "service unknown"}` : "listener and service unknown"
              console.log(`${shown(host.name)}: ${shown(state)} (${shown(host.ssh)} as ${shown(host.sshUser ?? "an unrecorded user")}, host key ${shown(host.hostKey ?? "not recorded")}), machine ${shown(host.machineId)}, ${shown(hello?.version ?? "version unknown")}, ${runs}, ${host.service}, disk ${shown(host.diskPolicy)}${receivedAt ? `, last contact ${shown(receivedAt)}` : ""}${error ? `\n  ${shown(error)}` : ""}`)
            }
          })
        }
        if (rest[0] === "attach") {
          const host = await call<{ sshUser: string; hostKey: string }>("hostAttach", { name: need(positionals[0], "a host name"), ssh: need(values.ssh, "--ssh DEST"), binary: need(values.binary, "--binary PATH"), stateDir: need(values["state-dir"], "--state-dir PATH") })
          return out(host, () => console.log(`Registered prepared daemon ${positionals[0]}, reached as ${shown(host.sshUser)} with host key ${shown(host.hostKey)}. No remote files or services were installed.`))
        }
        if (rest[0] === "remove") {
          const removed = await call<{ removed: string }>("hostRemove", { name: need(positionals[0], "a host name"), confirm: values.confirm })
          return out(removed, () => console.log(`Forgot ${removed.removed}. Its prepared remote daemon, service, sandboxes, images, runtime, packages and logs were retained.`))
        }
        throw new PaddockError("usage", "Use `paddock host add`, `paddock host list`, `paddock host attach` or `paddock host remove NAME --confirm NAME`.")
      }
      case "transport": {
        const { values } = parse({ protocol: { type: "string" }, stream: { type: "boolean" } }, rest.slice(1))
        if (selectedHost || asJson || rest[0] !== "stdio" || values.protocol !== String(PROTOCOL)) throw new PaddockError("incompatible", "Use `paddock transport stdio --protocol 1` on the target machine.")
        await transportStdio(values.stream ? streamSocketPath(dirs) : socketPath(dirs))
        // Exits as soon as the daemon's side is closed (a lease ended, say), rather than waiting for SSH to close stdin,
        // which a partitioned link may never do. Ending stdout first flushes Bun's own pipe buffer, which a pending write
        // callback does not wait for (the tail of an 8 MiB stream was lost); a reader that never reads gets five seconds.
        await bounded(new Promise<void>((resolve) => process.stdout.end(() => resolve())), 5000)
        process.exit(0)
      }
      default: throw new PaddockError("usage", `Unknown command ${command}. See \`paddock help\`.`)
    }
  } catch (error) {
    const code: ErrorCode = error instanceof PaddockError ? error.code : "runtime"
    const raw = (error as Error).message
    const message = code === "usage" && !raw.includes("See `paddock") ? `${raw} See \`paddock ${helpWords} --help\`.` : raw
    if (asJson) console.log(JSON.stringify({ ok: false, error: { code, message, details: error instanceof PaddockError ? error.details : undefined } }))
    else if (command === "host" && rest[0] === "add") {
      console.error(`paddock: ${refusal(message)}`)
      if (error instanceof PaddockError && error.details !== undefined) for (const line of detailLines(error.details)) console.error(line)
    }
    else if (code === "probes-required") {
      console.error(`paddock: ${refusal(message)}`)
      console.error(`To turn off the probe requirement on the selected machine: paddock${selectedHost && selectedHost !== "local" ? ` --host ${selectedHost}` : ""} config set require-probes off`)
    }
    else if (code === "check-failed" && error instanceof PaddockError && Array.isArray(error.details)) {
      // Workspaces have their own checklist; some ids (credentials) are in both with different titles.
      const checklist = command === "workspace" ? WORKSPACE_CHECKLIST : CHECKLIST
      console.error(`paddock: ${shown(message.split(": ")[0]!.replace(/\.$/, ""))}. These checks did not hold:`)
      for (const check of error.details as CheckResult[]) console.error(`  ${MARK[check.status] ?? "?"} ${checklist.find((entry) => entry.id === check.id)?.title ?? shown(check.id)}\n      ${shown(check.detail)}`)
      if (creating) console.error(`Remove it: ${next("remove", creating, "--confirm", creating)}`)
    } else console.error(`paddock: ${shown(message)}`)
    process.exit(EXIT[code])
  }
}

await main(process.argv.slice(2))
