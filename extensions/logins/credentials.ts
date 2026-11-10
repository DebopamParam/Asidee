import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir } from "node:fs/promises"
import { join } from "node:path"
import { object, profileName, type Agent, type Runner } from "./client"

export const credentialFiles = { claude: ".credentials.json", codex: "auth.json" }
export type Host = { home: string; platform: NodeJS.Platform; runner: Runner }
export const profileDirectory = (agent: Agent, profile: string, home: string) => join(home, profileName(profile) === "default" ? `.${agent}` : `.${agent}-${profile}`)

export function keychainServices(profile: string, home: string): string[] {
  const dir = profileDirectory("claude", profile, home)
  const hashed = (value: string) => `Claude Code-credentials-${createHash("sha256").update(value).digest("hex").slice(0, 8)}`
  return [...(profile === "default" ? ["Claude Code-credentials"] : []), hashed(dir), hashed(`${dir}/`)]
}

async function keychainService(profile: string, host: Host): Promise<string | undefined> {
  for (const service of keychainServices(profile, host.home)) {
    let result
    try { result = await host.runner(["security", "find-generic-password", "-s", service]) }
    catch { throw new Error("Could not query the macOS Keychain; contents withheld.") }
    if (result.exitCode === 0) return service
    if (result.exitCode !== 44) throw new Error("macOS Keychain lookup failed; contents withheld.")
  }
}

function validateCredential(text: string): string {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Credential exceeds 1 MiB; contents withheld.")
  try { if (!object(JSON.parse(text))) throw new Error() }
  catch { throw new Error("Credential is not a JSON object; contents withheld.") }
  return text
}

export async function readCredential(agent: Agent, profile: string, host: Host): Promise<string> {
  const dir = profileDirectory(agent, profile, host.home)
  if (agent === "claude" && host.platform === "darwin") {
    const service = await keychainService(profile, host)
    if (service) {
      let result
      try { result = await host.runner(["security", "find-generic-password", "-s", service, "-w"]) }
      catch { throw new Error("macOS Keychain access was denied or failed; contents withheld.") }
      if (result.exitCode !== 0) throw new Error("macOS Keychain access was denied or failed; contents withheld.")
      const value = result.stdout.trim()
      return validateCredential(/^(?:[0-9a-f]{2})+$/i.test(value) ? Buffer.from(value, "hex").toString("utf8") : value)
    }
  }
  try {
    if (!(await lstat(dir)).isDirectory()) throw new Error()
    const file = await open(join(dir, credentialFiles[agent]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error()
      return validateCredential(await file.readFile("utf8"))
    } finally { await file.close() }
  } catch { throw new Error("No readable regular credential file, or invalid credential JSON (maximum 1 MiB). Symlinked credential sources are refused; contents withheld.") }
}

export async function discoverProfiles(agent: Agent, host: Host): Promise<string[]> {
  const names = ["default", ...(await readdir(host.home).catch(() => [])).filter((name) => name.startsWith(`.${agent}-`)).map((name) => name.slice(agent.length + 2))]
  const found: string[] = []
  for (const profile of [...new Set(names)].sort()) {
    try { profileName(profile) } catch { continue }
    const dir = profileDirectory(agent, profile, host.home)
    const file = await lstat(join(dir, credentialFiles[agent])).catch(() => undefined)
    if ((await lstat(dir).catch(() => undefined))?.isDirectory() && file?.isFile()) found.push(profile)
    else if (agent === "claude" && host.platform === "darwin" && await keychainService(profile, host)) found.push(profile)
  }
  return found
}

export function githubToken(text: string): string {
  const token = text.trim()
  if (!/^[A-Za-z0-9_]{20,255}$/.test(token)) throw new Error("That does not look like a GitHub token; contents withheld.")
  return token
}

export async function hostGithubToken(runner: Runner, account?: string): Promise<string> {
  if (account && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(account)) throw new Error("Invalid GitHub account name.")
  let result
  try { result = await runner(["gh", "auth", "token", "--hostname", "github.com", ...(account ? ["--user", account] : [])]) }
  catch { throw new Error("Could not read this machine's gh login. Check that gh is installed and logged in.") }
  if (result.exitCode !== 0) throw new Error("No gh login for the selected account. Run gh auth login on this machine first.")
  return githubToken(result.stdout)
}
