#!/usr/bin/env bun
import { spawn } from "node:child_process"
import { mkdirSync, openSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { CHECKLIST } from "../core/checks"
import type { SandboxView } from "../core/core"
import { readDaemonFile, runDaemon, VERSION } from "../core/daemon"
import type { Extension } from "../core/extensions"
import { defaultDirs, socketPath } from "../core/state"
import { PaddockError, type CheckResult, type Engine, type ErrorCode, type RunResult } from "../core/types"

// A thin client: every command is one call to the daemon, which is started on first use.

const HELP = `paddock ${VERSION}: sandboxes for coding agents that are checked, not assumed

  paddock doctor                         engines on this machine and what each one needs
  paddock create NAME [--image IMAGE] [--cpus N] [--memory GB] [--disk GB] [--pids N] [--engine ID]
  paddock list
  paddock start NAME | stop NAME
  paddock verify NAME                    run every check against the sandbox
  paddock exec NAME [--user USER] [--stdin] -- COMMAND…   --stdin sends this command's input (text)
  paddock shell NAME
  paddock remove NAME --confirm NAME
  paddock ext list
  paddock ext run EXTENSION ACTION [SANDBOX] [--set FIELD=VALUE]…
  paddock ui [--open]                    the dashboard's address
  paddock daemon status | stop | run

  --json   print {"ok":true,"data":…} or {"ok":false,"error":{code,message}}
Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed.`

const EXIT: Record<ErrorCode, number> = { runtime: 1, usage: 2, "not-found": 3, conflict: 4, dependency: 5, "check-failed": 6 }
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

async function call<T>(method: string, body: object = {}): Promise<T> {
  try { return await request<T>(method, body) } catch (error) {
    if (error instanceof PaddockError) throw error
  }
  mkdirSync(dirs.state, { recursive: true, mode: 0o700 })
  const log = openSync(join(dirs.state, "daemon.log"), "a", 0o600)
  spawn(self[0]!, [...self.slice(1), "daemon", "run"], { detached: true, stdio: ["ignore", log, log] }).unref()
  for (let attempt = 0; attempt < 50; attempt++) {
    await Bun.sleep(100)
    try { return await request<T>(method, body) } catch (error) { if (error instanceof PaddockError) throw error }
  }
  throw new PaddockError("runtime", `The daemon did not start. See ${join(dirs.state, "daemon.log")}.`)
}

const MARK: Record<CheckResult["status"], string> = { pass: "✓", weak: "~", fail: "✗", unsupported: "–", unknown: "?", info: "i" }
function printChecks(checks: CheckResult[]): void {
  for (const check of checks) {
    const item = CHECKLIST.find((entry) => entry.id === check.id)
    console.log(`  ${MARK[check.status]} ${item?.title ?? check.id}${check.status === "pass" || check.status === "info" ? "" : ` [${check.status}]`}\n      ${check.detail}${check.evidence === "none" ? "" : ` (${check.evidence})`}`)
  }
  console.log("\n  ✓ holds   ~ holds in a weaker form   ✗ does not hold   – not available on this engine   ? could not be checked   i for your information")
}

function printSandbox(view: SandboxView): void {
  console.log(`${view.name}: ${view.status} on ${view.engine}${view.stopReason ? `\n  ${view.stopReason}` : ""}`)
}

function printRun(output: RunResult): never {
  process.stdout.write(output.stdout); process.stderr.write(output.stderr)
  process.exit(output.exitCode)
}

async function main(argv: string[]): Promise<void> {
  const split = argv.indexOf("--")
  const head = split < 0 ? argv : argv.slice(0, split); const tail = split < 0 ? [] : argv.slice(split + 1)
  const asJson = head.includes("--json")
  const [command, ...rest] = head.filter((arg) => arg !== "--json")
  const out = (data: unknown, human: () => void) => { if (asJson) console.log(JSON.stringify({ ok: true, data })); else human() }
  const parse = (options: Record<string, { type: "string" | "boolean" }>, args = rest) => {
    try { return parseArgs({ args, options, allowPositionals: true }) as { values: Record<string, string | undefined>; positionals: string[] } }
    catch (error) { throw new PaddockError("usage", (error as Error).message) }
  }
  const need = (value: string | undefined, what: string) => { if (!value) throw new PaddockError("usage", `Missing ${what}. See \`paddock help\`.`); return value }

  try {
    switch (command) {
      case undefined: case "help": case "--help": case "-h": console.log(HELP); return
      case "version": case "--version": console.log(VERSION); return
      case "doctor": case "init": {
        const engines = await call<Engine[]>("engines")
        return out(engines, () => {
          if (!engines.length) console.log("No engine found. Paddock needs Docker (OrbStack, a Linux host, Colima, …) with a gVisor runtime.")
          for (const engine of engines) {
            console.log(`${engine.ready ? "✓" : "✗"} ${engine.label}  [${engine.id}]`)
            if (engine.capabilities) console.log(`    kernel isolation: ${engine.capabilities.kernelIsolation}; network guard: ${engine.capabilities.networkGuard ? "yes" : "no"}; disk limit: ${engine.capabilities.diskLimit}`)
            for (const problem of engine.problems) console.log(`    ${problem}`)
            if (engine.fix) console.log(`    Fix: ${engine.fix}`)
          }
        })
      }
      case "create": {
        const { values, positionals } = parse({ image: { type: "string" }, cpus: { type: "string" }, memory: { type: "string" }, disk: { type: "string" }, pids: { type: "string" }, engine: { type: "string" } })
        const made = await call<{ sandbox: SandboxView; checks: CheckResult[]; hooks: Array<{ extension: string; exitCode: number; output: string }> }>("create",
          { name: need(positionals[0], "a name"), image: values.image, cpus: values.cpus, memoryGb: values.memory, diskGb: values.disk, pids: values.pids, engine: values.engine })
        return out(made, () => {
          printSandbox(made.sandbox); printChecks(made.checks)
          for (const hook of made.hooks) console.log(`\n  ${hook.extension} (after create): ${hook.exitCode === 0 ? "done" : `failed with exit ${hook.exitCode}`}${hook.output ? `\n${hook.output}` : ""}`)
        })
      }
      case "list": case "ls": {
        const list = await call<SandboxView[]>("list")
        return out(list, () => {
          if (!list.length) console.log("No sandboxes. Create one with `paddock create NAME`.")
          for (const view of list) {
            const verified = view.lastVerify ? `verified ${view.lastVerify.at.slice(0, 16).replace("T", " ")} UTC, ${view.lastVerify.results.filter((check) => check.status === "fail").length} failed` : "never verified"
            console.log(`${view.name.padEnd(24)} ${view.status.padEnd(8)} ${view.spec.cpus} CPU  ${view.spec.memoryGb} GB  ${view.engine}  (${verified})${view.stopReason ? `\n    ${view.stopReason}` : ""}`)
          }
        })
      }
      case "start": case "stop": {
        const view = await call<SandboxView>(command, { name: need(rest[0], "a name") })
        return out(view, () => printSandbox(view))
      }
      case "verify": {
        const report = await call<{ sandbox: SandboxView; checks: CheckResult[]; ok: boolean }>("verify", { name: need(rest[0], "a name") })
        out(report, () => { printSandbox(report.sandbox); printChecks(report.checks) })
        if (!report.ok) process.exit(EXIT["check-failed"])
        return
      }
      case "remove": case "rm": {
        const { values, positionals } = parse({ confirm: { type: "string" } })
        const removed = await call<{ removed: string }>("remove", { name: need(positionals[0], "a name"), confirm: values.confirm })
        return out(removed, () => console.log(`Removed ${removed.removed}.`))
      }
      case "exec": {
        const { values, positionals } = parse({ user: { type: "string" }, stdin: { type: "boolean" } })
        if (!tail.length) throw new PaddockError("usage", "Give the command after --, as in `paddock exec NAME -- ls -la`.")
        const output = await call<RunResult>("exec", { name: need(positionals[0], "a name"), argv: tail, user: values.user, stdin: values.stdin ? await Bun.stdin.text() : undefined })
        if (asJson) { console.log(JSON.stringify({ ok: true, data: output })); process.exit(output.exitCode) }
        return printRun(output)
      }
      case "shell": {
        const { argv: attach } = await call<{ argv: string[] }>("attach", { name: need(rest[0], "a name"), argv: tail.length ? tail : undefined })
        process.exit(await Bun.spawn(attach, { stdio: ["inherit", "inherit", "inherit"] }).exited)
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
        const { values, positionals } = parseArgs({ args: rest.slice(1), options: { set: { type: "string", multiple: true } }, allowPositionals: true })
        const fields = Object.fromEntries((values.set ?? []).map((pair) => { const at = pair.indexOf("="); return at < 0 ? [pair, "true"] : [pair.slice(0, at), pair.slice(at + 1)] }))
        const output = await call<RunResult>("action", { extension: need(positionals[0], "an extension"), action: need(positionals[1], "an action"), sandbox: positionals[2], values: fields })
        if (asJson) { console.log(JSON.stringify({ ok: true, data: output })); process.exit(output.exitCode) }
        return printRun(output)
      }
      case "ui": {
        await call("version")
        const daemon = await readDaemonFile(dirs)
        if (!daemon) throw new PaddockError("runtime", "The daemon is not running.")
        const url = `http://127.0.0.1:${daemon.port}/#token=${daemon.token}`
        if (rest.includes("--open")) Bun.spawn([process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open", url])
        return out({ url }, () => console.log(url))
      }
      case "daemon": {
        if (rest[0] === "run") return await runDaemon(dirs, cliDir)
        if (rest[0] === "stop") {
          const stopped = await request("shutdown").then(() => true, () => false)
          return out({ stopped }, () => console.log(stopped ? "The daemon is stopping. Sandboxes keep running; their disk limits are not watched until it starts again." : "The daemon was not running."))
        }
        const version = await request<{ version: string }>("version").catch(() => undefined)
        const daemon = version ? await readDaemonFile(dirs) : undefined
        return out({ running: Boolean(version), ...daemon, token: undefined }, () => console.log(version ? `Running: version ${version.version}, pid ${daemon?.pid}, dashboard on port ${daemon?.port}.` : "Not running. It starts with the first command."))
      }
      default: throw new PaddockError("usage", `Unknown command ${command}. See \`paddock help\`.`)
    }
  } catch (error) {
    const code: ErrorCode = error instanceof PaddockError ? error.code : "runtime"
    const message = (error as Error).message
    if (asJson) console.log(JSON.stringify({ ok: false, error: { code, message, details: error instanceof PaddockError ? error.details : undefined } }))
    else console.error(`paddock: ${message}`)
    process.exit(EXIT[code])
  }
}

await main(process.argv.slice(2))
