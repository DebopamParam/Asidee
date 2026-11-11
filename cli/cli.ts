#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { connect } from "node:net"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { CHECKLIST } from "../core/checks"
import type { ResizeChange, SandboxView } from "../core/core"
import { BUILD, readDaemonFile, runDaemon, VERSION } from "../core/daemon"
import type { Extension } from "../core/extensions"
import type { ForwardView } from "../core/forwards"
import { hostOption, type FleetView, type HostView } from "../core/machines"
import { PROTOCOL, transportStdio } from "../core/transport"
import type { SshAccess } from "../core/ssh"
import { checkSocketPath, defaultDirs, socketPath, streamSocketPath } from "../core/state"
import { dataFrames, frame, FrameReader, type OpenRequest } from "../core/stream"
import { PaddockError, type CheckResult, type Engine, type ErrorCode, type RunResult, type Template } from "../core/types"

// A thin client: every command is one call to the daemon, which is started on first use.

const HELP = `paddock ${VERSION}: sandboxes for coding agents that are checked, not assumed

  paddock doctor                         engines on this machine and what each one needs
  paddock create NAME [--docker] [--image IMAGE | --template TEMPLATE] [--cpus N] [--memory GB] [--disk GB] [--pids N] [--engine ID]
  paddock list
  paddock list --all                      machines, including unavailable ones and unknown cached sandboxes
  paddock host list                       registered SSH daemons and their connection state
  paddock host attach NAME --ssh DEST --binary PATH --state-dir PATH   attach an already prepared daemon
  paddock host remove NAME --confirm NAME  forget a prepared host; remote files and service stay
  paddock resize NAME [--cpus N] [--memory GB] [--pids N] [--disk GB]   says which limits apply now and which at the next start
  paddock start NAME | stop NAME
  paddock verify NAME                    run every check against the sandbox
  paddock exec NAME [--user USER] [--stdin] -- COMMAND…   --stdin sends this command's input (text)
  paddock exec NAME --stream [--user USER] -- COMMAND…    bytes in and out as they come, any size
  paddock shell NAME [-- COMMAND…]
  paddock forward add NAME --port PORT [--local-port PORT]   127.0.0.1 here to PORT on the sandbox's loopback
  paddock forward list [NAME] | forward remove ID            a forward ends when its sandbox stops
  paddock ssh setup NAME [--write-config]   sshd inside, reached as NAME.paddock through the daemon, no port
  paddock ssh access NAME                   the alias, user and home an editor uses, and whether it is ready
  paddock remove NAME --confirm NAME
  paddock snapshot NAME --as TEMPLATE    save the sandbox's files, minus the usual logins, as a template
  paddock template list | template remove TEMPLATE [--engine ID]   sandboxes made from it keep working
  paddock ext list
  paddock ext run EXTENSION ACTION [SANDBOX] [--set FIELD=VALUE]…
  paddock ui [--open]                    the dashboard's address
  paddock daemon status | stop | run
  paddock transport stdio --protocol 1 [--stream]   internal SSH socket relay; starts nothing

  --host NAME   select a registered machine (unqualified names always mean local)
  --json   print {"ok":true,"data":…} or {"ok":false,"error":{code,message}}
Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed, 7 unreachable, 8 incompatible, 9 identity changed, 10 outcome unknown.`

const EXIT: Record<ErrorCode, number> = { runtime: 1, usage: 2, "not-found": 3, conflict: 4, dependency: 5, "check-failed": 6, offline: 7, incompatible: 8, "identity-changed": 9, "outcome-unknown": 10 }
let selectedHost: string | undefined
const dirs = defaultDirs()
const compiled = Bun.main.startsWith("/$bunfs/")
const self = compiled ? [process.execPath] : [process.execPath, Bun.main]
const cliDir = compiled ? dirname(process.execPath) : join(dirname(Bun.main), "..", "bin")

async function request<T>(method: string, body: object = {}): Promise<T> {
  const response = await fetch(`http://paddock/api/${method}`, { unix: socketPath(dirs), method: "POST", body: JSON.stringify(body) } as RequestInit)
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
  try { return await request<T>(method, { ...body, host: selectedHost }) } finally { clearInterval(timer) }
}

// A session on the daemon's stream socket (core/stream.ts). This process only moves bytes between its own stdio and the
// socket, and waits whenever the other side has not taken what it was given. On a terminal the session gets one too:
// keystrokes, Ctrl-C included, go to the sandbox, and the terminal's settings are put back however the session ends.
async function session(request: OpenRequest): Promise<never> {
  request = { ...request, host: selectedHost }
  await ensureDaemon()
  const socket = connect(streamSocketPath(dirs))
  const raw = request.kind === "exec" && request.tty && process.stdin.isTTY
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
        void leave(EXIT[error.code] ?? 1, error.message)
      } else if (kind === "ready" && !ready) {
        ready = true
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
function printChecks(checks: CheckResult[]): void {
  for (const check of checks) {
    const item = CHECKLIST.find((entry) => entry.id === check.id)
    console.log(`  ${MARK[check.status]} ${item?.title ?? check.id}${check.status === "pass" || check.status === "info" ? "" : ` [${check.status}]`}\n      ${check.detail}${check.evidence === "none" ? "" : ` (${check.evidence})`}`)
  }
  console.log("\n  ✓ holds   ~ holds in a weaker form   ✗ does not hold   – not available on this engine   ? could not be checked   i for your information")
}

function printSandbox(view: SandboxView): void {
  console.log(`${displayName(view.name)}: ${view.status} on ${view.engine}${view.stopReason ? `\n  ${view.stopReason}` : ""}`)
}
const displayName = (name: string) => selectedHost && selectedHost !== "local" ? `${selectedHost}/${name}` : name

// Waits for the output to be written before exiting: into a pipe, an exit right after a write loses what did not fit.
async function printRun(output: RunResult, asJson = false): Promise<never> {
  if (asJson) await Bun.write(Bun.stdout, `${JSON.stringify({ ok: true, data: output })}\n`)
  else { await Bun.write(Bun.stdout, output.stdout); await Bun.write(Bun.stderr, output.stderr) }
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
    catch (error) { throw new PaddockError("usage", (error as Error).message) }
  }
  const need = (value: string | boolean | undefined, what: string) => { if (typeof value !== "string" || !value) throw new PaddockError("usage", `Missing ${what}. See \`paddock help\`.`); return value }

  try {
    switch (command) {
      case undefined: case "help": case "--help": case "-h": return out({ help: HELP }, () => console.log(HELP))
      case "version": case "--version": return out({ version: VERSION }, () => console.log(VERSION))
      case "doctor": case "init": {
        const engines = await call<Engine[]>("engines")
        return out(engines, () => {
          if (!engines.length) console.log("No engine found. Paddock needs Docker (OrbStack, a Linux host, Colima, …) with a gVisor runtime.")
          for (const engine of engines) {
            console.log(`${engine.ready ? "✓" : "✗"} ${engine.label}  [${engine.id}]`)
            if (engine.capabilities) console.log(`    kernel isolation: ${engine.capabilities.kernelIsolation}; network guard: ${engine.capabilities.networkGuard ? "yes" : "no"}; disk limit: ${engine.capabilities.diskLimit}; inner Docker: ${engine.capabilities.docker ? "yes" : "no"}`)
            for (const problem of engine.problems) console.log(`    ${problem}`)
            if (engine.fix) console.log(`    Fix: ${engine.fix}`)
          }
        })
      }
      case "create": {
        const { values, positionals } = parse({ docker: { type: "boolean" }, image: { type: "string" }, template: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, pids: { type: "string" }, engine: { type: "string" } })
        const name = need(positionals[0], "a name")
        const made = await call<{ sandbox: SandboxView; checks: CheckResult[]; hooks: Array<{ extension: string; exitCode: number; output: string }> }>("create",
          { name, docker: values.docker, image: values.image, template: values.template, cpus: values.cpus, memoryGb: values.memory, diskGb: values.disk, pids: values.pids, engine: values.engine }, watching(name))
        return out(made, () => {
          printSandbox(made.sandbox); printChecks(made.checks)
          for (const hook of made.hooks) console.log(`\n  ${hook.extension} (after create): ${hook.exitCode === 0 ? "done" : `failed with exit ${hook.exitCode}`}${hook.output ? `\n${hook.output}` : ""}`)
        })
      }
      case "list": case "ls": {
        const { values } = parse({ all: { type: "boolean" } })
        if (values.all) {
          if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "Use --all or --host, not both.")
          const fleet = await call<FleetView>("fleet")
          return out(fleet, () => {
            for (const row of fleet.machines) {
              console.log(`${row.machine.host.name}: ${row.machine.state}${"error" in row.machine && row.machine.error ? ` (${row.machine.error})` : ""}${row.stale ? "; sandboxes unknown" : ""}`)
              for (const sandbox of row.cached?.sandboxes ?? []) console.log(`  ${row.machine.host.name}/${sandbox.name}: ${sandbox.status}${row.stale ? ` (last checked ${row.cached?.checkedAt})` : ""}`)
            }
          })
        }
        const list = await call<SandboxView[]>("list")
        return out(list, () => {
          if (!list.length) console.log("No sandboxes. Create one with `paddock create NAME`.")
          for (const view of list) {
            const verified = view.lastVerify ? `verified ${view.lastVerify.at.slice(0, 16).replace("T", " ")} UTC, ${view.lastVerify.results.filter((check) => check.status === "fail").length} failed` : "never verified"
            if (view.status === "damaged") { console.log(`${displayName(view.name).padEnd(24)} damaged\n    ${view.stopReason}`); continue }
            console.log(`${displayName(view.name).padEnd(24)} ${view.status.padEnd(8)} ${view.spec.cpus} CPU  ${view.spec.memoryGb} GB  ${view.engine}${view.template ? `  template ${view.template.name}` : ""}  (${verified})${view.stopReason ? `\n    ${view.stopReason}` : ""}`)
          }
        })
      }
      case "start": case "stop": {
        const view = await call<SandboxView>(command, { name: need(rest[0], "a name") }, watching(rest[0]!))
        return out(view, () => printSandbox(view))
      }
      case "verify": {
        const report = await call<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean }>("verify", { name: need(rest[0], "a name") }, watching(rest[0]!))
        out(report, () => { printSandbox(report.sandbox); printChecks(report.checks) })
        if (!report.ok) process.exit(EXIT["check-failed"])
        return
      }
      case "resize": {
        const { values, positionals } = parse({ cpus: { type: "string" }, memory: { type: "string" }, pids: { type: "string" }, disk: { type: "string" } })
        const name = need(positionals[0], "a name")
        const resized = await call<{ sandbox: SandboxView; changes: ResizeChange[]; checks: CheckResult[] }>("resize", { name, cpus: values.cpus, memoryGb: values.memory, pids: values.pids, diskGb: values.disk }, watching(name))
        return out(resized, () => {
          printSandbox(resized.sandbox)
          for (const change of resized.changes) console.log(`  ${LIMIT[change.limit]}: ${change.from === change.to ? change.to : `${change.from} -> ${change.to}`}, ${APPLIES[change.applies]}${change.note ? `\n      ${change.note}` : ""}`)
          console.log(""); printChecks(resized.checks)
        })
      }
      case "snapshot": {
        const { values, positionals } = parse({ as: { type: "string" } })
        const name = need(positionals[0], "a name")
        const saved = await call<{ template: Template; contents: string }>("snapshot", { name, as: need(values.as, "--as TEMPLATE") }, watching(name))
        return out(saved, () => {
          console.log(`Saved ${name} as template ${saved.template.name} (${(saved.template.sizeBytes / 1024 ** 2).toFixed(0)} MB). Use it with \`paddock create NAME --template ${saved.template.name}\`.`)
          console.log(`  Login files left out: ${saved.template.loginsRemoved.join(", ") || "none were present"}.`)
          console.log(`  ${saved.contents}`)
        })
      }
      case "template": case "templates": {
        const { values, positionals } = parse({ engine: { type: "string" } }, rest.slice(1))
        if (rest[0] === "list" || rest[0] === undefined) {
          const list = await call<Template[]>("templateList")
          return out(list, () => {
            if (!list.length) console.log("No templates. Save one with `paddock snapshot NAME --as TEMPLATE`.")
            for (const template of list) console.log(`${template.name.padEnd(24)} from ${template.source} (${template.sourceImage}), ${template.createdAt.slice(0, 16).replace("T", " ")} UTC, ${(template.sizeBytes / 1024 ** 2).toFixed(0)} MB, ${template.engine}${template.dependants.length ? `\n    used by ${template.dependants.join(", ")}` : ""}`)
          })
        }
        if (rest[0] === "remove" || rest[0] === "rm") {
          const removed = await call<{ removed: string; note: string }>("templateRemove", { name: need(positionals[0], "a template name"), engine: values.engine })
          return out(removed, () => console.log(`Removed template ${removed.removed}. ${removed.note}`))
        }
        throw new PaddockError("usage", "Use `paddock template list` or `paddock template remove TEMPLATE`.")
      }
      case "remove": case "rm": {
        const { values, positionals } = parse({ confirm: { type: "string" } })
        const removed = await call<{ removed: string }>("remove", { name: need(positionals[0], "a name"), confirm: values.confirm })
        return out(removed, () => console.log(`Removed ${removed.removed}.`))
      }
      case "exec": {
        const { values, positionals } = parse({ user: { type: "string" }, stdin: { type: "boolean" }, stream: { type: "boolean" } })
        if (!tail.length) throw new PaddockError("usage", "Give the command after --, as in `paddock exec NAME -- ls -la`.")
        if (values.stream && (asJson || values.stdin)) throw new PaddockError("usage", "--stream passes bytes through as they come, so it takes neither --json nor --stdin (its input is always this command's).")
        if (values.stream) return await session({ kind: "exec", name: need(positionals[0], "a name"), argv: tail, tty: false, ...(typeof values.user === "string" ? { user: values.user } : {}) })
        const output = await call<RunResult>("exec", { name: need(positionals[0], "a name"), argv: tail, user: values.user, stdin: values.stdin ? await Bun.stdin.text() : undefined })
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
          return out(made, () => console.log(`Forwarding 127.0.0.1:${made.localPort} to port ${made.port} in ${selectedHost && selectedHost !== "local" ? `${selectedHost}/` : ""}${made.name} (forward ${made.id}). It ends when the sandbox run, either daemon or the SSH link ends; a silent control link closes it after 15 seconds without a heartbeat. Then add it again.`))
        }
        if (rest[0] === "list" || rest[0] === undefined) {
          const list = await call<ForwardView[]>("forwardList", { name: positionals[0] })
          return out(list, () => {
            if (!list.length) console.log("No forwards. Add one with `paddock forward add NAME --port PORT`.")
            for (const forward of list) console.log(`${forward.id}  127.0.0.1:${forward.localPort} -> ${forward.name}:${forward.port}  ${forward.connections} open, since ${forward.createdAt.slice(0, 16).replace("T", " ")} UTC`)
          })
        }
        if (rest[0] === "remove" || rest[0] === "rm") {
          const closed = await call<{ closed: string }>("forwardRemove", { id: need(positionals[0], "a forward id") })
          return out(closed, () => console.log(`Closed forward ${closed.closed}.`))
        }
        throw new PaddockError("usage", "Use `paddock forward add NAME --port PORT`, `paddock forward list [NAME]` or `paddock forward remove ID`.")
      }
      case "ssh": {
        const { values, positionals } = parse({ "write-config": { type: "boolean" }, "sandbox-id": { type: "string" } }, rest.slice(1))
        // The ProxyCommand an alias runs; ssh speaks through this process's stdin and stdout.
        if (rest[0] === "proxy") return await session({ kind: "ssh", name: need(positionals[0], "a name"), ...(typeof values["sandbox-id"] === "string" ? { sandboxId: values["sandbox-id"] } : {}) })
        if (rest[0] === "setup") {
          const done = await call<SshAccess & { config: string; include: string; included: boolean; editorKey: string; keyFile: string }>("sshSetup", { name: need(positionals[0], "a name"), writeConfig: values["write-config"] === true }, positionals[0])
          return out(done, () => console.log(done.included
            ? `\`ssh ${done.alias}\` logs in as ${done.user} with the key ${done.editorKey} (${done.keyFile}).`
            : `Set up. Add this line at the top of ${done.config}, or run again with --write-config:\n  ${done.include}\nThen \`ssh ${done.alias}\` logs in as ${done.user} with the key ${done.editorKey}.`))
        }
        if (rest[0] === "access") {
          const access = await call<SshAccess>("sshAccess", { name: need(positionals[0], "a name") })
          return out(access, () => console.log(`${access.alias}: ${access.user ? `${access.user}, home ${access.home}` : "not set up"}; ${access.batchReady ? "ready" : "not ready"}`))
        }
        throw new PaddockError("usage", "Use `paddock ssh setup NAME [--write-config]` or `paddock ssh access NAME`.")
      }
      case "ext": {
        if (rest[0] === "list" || rest[0] === undefined) {
          const loaded = await call<{ extensions: Extension[]; errors: string[] }>("extensions")
          return out(loaded, () => {
            if (!loaded.extensions.length) console.log(`No extensions. Put one in ${join(dirs.config, "extensions")}.`)
            for (const extension of loaded.extensions) {
              console.log(`${extension.id}: ${extension.name}${extension.description ? ` (${extension.description})` : ""}`)
              for (const action of extension.actions) console.log(`  ${action.id}: ${action.label}${action.fields.length ? `  [${action.fields.map((field) => field.id).join(", ")}]` : ""}`)
            }
            for (const error of loaded.errors) console.log(`! ${error}`)
          })
        }
        if (rest[0] !== "run") throw new PaddockError("usage", "Use `paddock ext list` or `paddock ext run EXTENSION ACTION [SANDBOX]`.")
        let parsed
        try { parsed = parseArgs({ args: rest.slice(1), options: { set: { type: "string", multiple: true } }, allowPositionals: true }) } catch (error) { throw new PaddockError("usage", (error as Error).message) }
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
        return out({ running: Boolean(version), ...daemon, token: undefined }, () => console.log(version ? `Running: version ${version.version}, pid ${daemon?.pid}, dashboard on port ${daemon?.port}.` : "Not running. It starts with the first command."))
      }
      case "host": {
        if (selectedHost && selectedHost !== "local") throw new PaddockError("usage", "The host registry belongs to the primary machine.")
        const { values, positionals } = parse({ ssh: { type: "string" }, binary: { type: "string" }, "state-dir": { type: "string" }, confirm: { type: "string" } }, rest.slice(1))
        if (rest[0] === "list" || rest[0] === undefined) {
          const hosts = await call<HostView[]>("hostList")
          return out(hosts, () => {
            if (!hosts.length) console.log("No registered hosts. Attach an already prepared daemon with `paddock host attach`.")
            for (const { host, state, receivedAt, hello, error } of hosts) console.log(`${host.name}: ${state} (${host.ssh}), machine ${host.machineId}, ${hello?.version ?? "version unknown"}, ${host.service}, disk ${host.diskPolicy}${receivedAt ? `, last contact ${receivedAt}` : ""}${error ? `\n  ${error}` : ""}`)
          })
        }
        if (rest[0] === "attach") {
          const host = await call("hostAttach", { name: need(positionals[0], "a host name"), ssh: need(values.ssh, "--ssh DEST"), binary: need(values.binary, "--binary PATH"), stateDir: need(values["state-dir"], "--state-dir PATH") })
          return out(host, () => console.log(`Registered prepared daemon ${positionals[0]}. No remote files or services were installed.`))
        }
        if (rest[0] === "remove") {
          const removed = await call<{ removed: string }>("hostRemove", { name: need(positionals[0], "a host name"), confirm: values.confirm })
          return out(removed, () => console.log(`Forgot ${removed.removed}. Its prepared remote daemon, service, sandboxes, images, runtime, packages and logs were retained.`))
        }
        throw new PaddockError("usage", "Use `paddock host list`, `paddock host attach` or `paddock host remove NAME --confirm NAME`.")
      }
      case "transport": {
        const { values } = parse({ protocol: { type: "string" }, stream: { type: "boolean" } }, rest.slice(1))
        if (selectedHost || asJson || rest[0] !== "stdio" || values.protocol !== String(PROTOCOL)) throw new PaddockError("incompatible", "Use `paddock transport stdio --protocol 1` on the target machine.")
        return await transportStdio(values.stream ? streamSocketPath(dirs) : socketPath(dirs))
      }
      default: throw new PaddockError("usage", `Unknown command ${command}. See \`paddock help\`.`)
    }
  } catch (error) {
    const code: ErrorCode = error instanceof PaddockError ? error.code : "runtime"
    const message = (error as Error).message
    if (asJson) console.log(JSON.stringify({ ok: false, error: { code, message, details: error instanceof PaddockError ? error.details : undefined } }))
    else if (code === "check-failed" && error instanceof PaddockError && Array.isArray(error.details)) {
      console.error(`paddock: ${message.split(": ")[0]}. These checks did not hold:`)
      for (const check of error.details as CheckResult[]) console.error(`  ${MARK[check.status]} ${CHECKLIST.find((entry) => entry.id === check.id)?.title ?? check.id}\n      ${check.detail}`)
    } else console.error(`paddock: ${message}`)
    process.exit(EXIT[code])
  }
}

await main(process.argv.slice(2))
