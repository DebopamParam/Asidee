#!/usr/bin/env bun
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { agentName, run } from "./client"
import { discoverProfiles } from "./credentials"
import { importGithub, importLogin, listLogins, logout, type Login } from "./logins"

const HELP = `Asidee logins (requires Bun here and Node in the running sandbox)
  login.ts profiles claude|codex
  login.ts import NAME claude|codex [--profile default] [--target PROFILE] [--setup] [--replace]
  login.ts github NAME [--gh [--account ACCOUNT]] [--replace]
  login.ts list NAME
  login.ts logout NAME all|claude|codex|github [--profile PROFILE]
GitHub without --gh reads a token from stdin or a hidden terminal prompt. Never pass a token as an argument.
Imported profiles use ~/.claude-PROFILE or ~/.codex-PROFILE. Select them with CLAUDE_CONFIG_DIR or CODEX_HOME.
Logout uses profile ~ for a canonical ~/.claude or ~/.codex login. It leaves this machine logged in.`

type TokenInput = AsyncIterable<Uint8Array | string> & {
  isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown
  on: (event: "data" | "end" | "error", listener: (chunk: Buffer) => void) => unknown
  off: (event: "data" | "end" | "error", listener: (chunk: Buffer) => void) => unknown
  pause: () => unknown; resume: () => unknown
}

export async function readToken(input: TokenInput = process.stdin, output: { write: (text: string) => unknown } = process.stderr): Promise<string> {
  if (!input.isTTY) {
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of input) {
      const data = Buffer.from(chunk); size += data.length
      if (size > 1024) throw new Error("Token input is too long; contents withheld.")
      chunks.push(data)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  if (!input.setRawMode) throw new Error("A hidden prompt is unavailable. Pipe the token on stdin instead.")
  const rawMode = input.setRawMode.bind(input)
  return new Promise((resolve, reject) => {
    let value = ""
    const wasRaw = input.isRaw ?? false
    const finish = (error?: Error) => {
      input.off("data", onData); input.off("end", onEnd); input.off("error", onEnd); rawMode(wasRaw); input.pause()
      output.write("\n")
      if (error) reject(error); else resolve(value)
    }
    const onEnd = () => finish(new Error("Token input interrupted; contents withheld."))
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Token input cancelled."))
        if (char === "\r" || char === "\n") return finish()
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else if (char >= " ") value += char
        if (value.length > 1024) return finish(new Error("Token input is too long; contents withheld."))
      }
    }
    output.write("GitHub token (hidden): ")
    rawMode(true); input.on("data", onData); input.on("end", onEnd); input.on("error", onEnd); input.resume()
  })
}

const describe = (value: Login) => `${value.agent}/${value.profile}${value.account ? ` (${value.account})` : " (account unknown)"}`

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let parsed
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { profile: { type: "string" }, target: { type: "string" }, setup: { type: "boolean" }, replace: { type: "boolean" }, gh: { type: "boolean" }, account: { type: "string" }, help: { type: "boolean" } } }) }
  catch { throw new Error("Invalid login arguments. Run login.ts --help. Never pass tokens in arguments.") }
  const { values, positionals } = parsed
  const [action, directName, directAgent] = positionals
  if (values.help || !action) { console.log(HELP); return }
  const field = (key: string) => env[`ASIDEE_FIELD_${key.toUpperCase()}`]
  const name = directName ?? env.ASIDEE_SANDBOX ?? ""
  const profile = values.profile ?? field("profile") ?? "default"
  const replace = values.replace ?? field("replace") === "true"
  const host = { home: homedir(), platform: process.platform, runner: run }
  if (action === "profiles") {
    for (const agent of [agentName(directName ?? field("agent") ?? "")]) console.log(JSON.stringify({ agent, profiles: await discoverProfiles(agent, host) }))
  } else if (action === "import") {
    const agent = agentName(directAgent ?? field("agent") ?? "")
    const result = await importLogin(host, { name, agent, profile, target: values.target ?? field("target"), replace, setup: values.setup ?? field("setup") === "true" })
    console.log(`Imported ${agent}/${result.profile}. Select it inside the sandbox with ${agent === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"}="$HOME/.${agent}-${result.profile}" ${agent}.`)
    console.log(`Copied ${result.files} setup files.${result.missingCommands ? ` Missing hook/status-line commands or scripts: ${result.missingCommandNames.join(", ") || "names withheld"}${result.missingCommands > result.missingCommandNames.length ? ` (${result.missingCommands - result.missingCommandNames.length} names withheld)` : ""}.` : ""}`)
  } else if (action === "github" || action === "github-host") {
    const fromHost = action === "github-host" || values.gh
    const result = await importGithub(run, name, fromHost ? { kind: "host", account: values.account ?? field("account") } : { kind: "token", value: await readToken() }, replace)
    console.log(`Imported ${describe(result)}. The token lives inside the sandbox's gh hosts.yml (mode 0600, normally ~/.config/gh/hosts.yml). There is no secret proxy in a gVisor container; code inside can read and send it out.`)
  } else if (action === "list") {
    const found = await listLogins(run, name)
    console.log(found.length ? found.map(describe).join("\n") : "No agent or GitHub logins found.")
  } else if (action === "logout") {
    const selected = directAgent ?? field("agent") ?? "all"
    const agent = selected === "github" ? selected : selected === "all" ? selected : agentName(selected)
    const done = await logout(run, name, agent === "all" ? "all" : { agent, profile: agent === "github" ? "~" : profile })
    console.log(`Removed ${done.length} sandbox login(s); stopped ${done.reduce((sum, item) => sum + item.stopped, 0)} agent session(s). This machine stays logged in. Tokens were not revoked; other processes may retain copies.`)
  } else throw new Error("Unknown login action. Run login.ts --help.")
}

if (import.meta.main) main(process.argv.slice(2)).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Login operation failed; contents withheld."); process.exitCode = 1 })
