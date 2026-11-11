import { readFile, readdir, stat } from "node:fs/promises"
import { join, relative } from "node:path"
import { object, type Agent } from "./client"
import { profileDirectory } from "./credentials"

const ALLOW = {
  claude: { files: ["settings.json", "keybindings.json"], directories: ["agents", "commands", "skills", "output-styles", "hooks"] },
  codex: { files: ["config.toml"], directories: ["prompts", "skills"] },
}
const OMIT = new Set([".DS_Store", "node_modules", ".git", "__pycache__", "plugins", "history", "transcripts", "cache", "caches", "auth.json", ".credentials.json", ".mcp.json", ".ssh", ".aws", ".gnupg", ".env", "hosts.yml"])
const STATE = ["hasCompletedOnboarding", "lastOnboardingVersion", "oauthAccount", "theme", "editorMode"]
export type SetupFile = { path: string; data: string; mode: number }
export type Setup = { hostHome: string; files: SetupFile[]; homeFiles: SetupFile[]; state: Record<string, unknown> }

export async function claudeState(profile: string, home: string): Promise<Record<string, unknown>> {
  const paths = [join(profileDirectory("claude", profile, home), ".claude.json"), ...(profile === "default" ? [join(home, ".claude.json")] : [])]
  for (const path of paths) {
    if (!(await stat(path).catch(() => undefined))?.isFile()) continue
    try {
      if ((await stat(path)).size > 1024 * 1024) throw new Error()
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
      if (!object(parsed)) throw new Error()
      return Object.fromEntries(STATE.filter((key) => Object.hasOwn(parsed, key)).map((key) => [key, parsed[key]]))
    } catch { throw new Error("Claude account/setup state is invalid; contents withheld.") }
  }
  return {}
}

export function settingsCommands(value: unknown): string[] {
  if (!object(value)) return []
  const commands: string[] = []
  if (object(value.hooks)) for (const groups of Object.values(value.hooks)) if (Array.isArray(groups)) {
    for (const group of groups) if (object(group) && Array.isArray(group.hooks)) {
      for (const hook of group.hooks) if (object(hook) && typeof hook.command === "string") commands.push(hook.command)
    }
  }
  if (object(value.statusLine) && typeof value.statusLine.command === "string") commands.push(value.statusLine.command)
  return commands
}

export function referencedHomePaths(commands: string[], home: string): string[] {
  const found = new Set<string>()
  for (const command of commands) for (const token of command.split(/[\s;|&()'"]+/)) {
    const rel = /^(?:~|\$HOME|\$\{HOME\})\/(.+)$/.exec(token)?.[1] ?? (token.startsWith(`${home}/`) ? token.slice(home.length + 1) : undefined)
    if (rel && !rel.split("/").includes("..") && !rel.split("/").some((part) => OMIT.has(part))) found.add(rel)
  }
  return [...found]
}

// Re-serialize parsed TOML instead of deleting lines: MCP tables can use dotted, quoted or inline keys.
// Settings `env` blocks and provider tables often hold API keys; only the selected login is meant to reach the guest.
const INTEGRATION = /^(mcp_?servers|mcp|plugins|enabledPlugins|extraKnownMarketplaces|marketplaces)$/i
const SECRET = /api_?key$|access_?key|private_?key|token$|secret|passw|credential|bearer|cookie|^authorization$|headers$/i
function withoutIntegrations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIntegrations)
  if (!object(value) || value instanceof Date) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !INTEGRATION.test(key) && !SECRET.test(key)).map(([key, child]) => [key, withoutIntegrations(child)]))
}

function tomlValue(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf"
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (typeof value === "bigint") return String(value)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`
  if (object(value)) return `{ ${Object.entries(value).map(([key, child]) => `${JSON.stringify(key)} = ${tomlValue(child)}`).join(", ")} }`
  throw new Error("Unsupported TOML value; contents withheld.")
}

export function cleanConfig(agent: Agent, text: string): string {
  try {
    const parsed: unknown = agent === "codex" ? Bun.TOML.parse(text) : JSON.parse(text)
    if (!object(parsed)) throw new Error()
    const clean = withoutIntegrations(parsed)
    if (!object(clean)) throw new Error()
    return agent === "codex" ? `${Object.entries(clean).map(([key, value]) => `${JSON.stringify(key)} = ${tomlValue(value)}`).join("\n")}\n` : `${JSON.stringify(clean, null, 2)}\n`
  } catch { throw new Error("Profile settings are invalid or unsupported; contents withheld.") }
}

export async function collectSetup(agent: Agent, profile: string, home: string): Promise<Setup> {
  const root = profileDirectory(agent, profile, home), allow = ALLOW[agent]
  const files: SetupFile[] = [], homeFiles: SetupFile[] = []
  let bytes = 0
  const entry = async (path: string, base: string): Promise<SetupFile | undefined> => {
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) return
    if (bytes + info.size > 16 * 1024 * 1024 || files.length + homeFiles.length >= 2000) throw new Error("Profile setup exceeds 16 MiB or 2000 files; nothing was copied.")
    let data: Buffer
    try { data = await readFile(path) } catch { throw new Error("Could not read a setup file; contents withheld.") }
    bytes += data.length
    if (bytes > 16 * 1024 * 1024) throw new Error("Profile setup exceeds 16 MiB; nothing was copied.")
    const rel = relative(base, path)
    if (base === root && (rel === "settings.json" || rel === "config.toml")) data = Buffer.from(cleanConfig(agent, data.toString("utf8")))
    return { path: rel, data: data.toString("base64"), mode: info.mode & 0o100 ? 0o700 : 0o600 }
  }
  const add = async (path: string) => { const file = await entry(path, root); if (file) files.push(file) }
  const walk = async (dir: string): Promise<void> => {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (OMIT.has(item.name)) continue
      const path = join(dir, item.name)
      if (item.isDirectory()) await walk(path)
      else if (item.isFile() || item.isSymbolicLink()) await add(path)
    }
  }
  for (const name of (await readdir(root).catch(() => [])).sort()) {
    const path = join(root, name), info = await stat(path).catch(() => undefined)
    if (info?.isFile() && (allow.files.includes(name) || name.endsWith(".md"))) await add(path)
    else if (info?.isDirectory() && allow.directories.includes(name)) await walk(path)
  }
  if (agent === "claude") {
    const settings = files.find((file) => file.path === "settings.json")
    const commands = settings ? settingsCommands(JSON.parse(Buffer.from(settings.data, "base64").toString("utf8"))) : []
    const scripts: string[] = []
    for (const rel of referencedHomePaths(commands, home)) {
      const path = join(home, rel), info = await stat(path).catch(() => undefined)
      if (!info?.isFile() || info.size > 1024 * 1024 || path.startsWith(`${root}/`)) continue
      const file = await entry(path, home)
      if (file) { homeFiles.push(file); scripts.push(Buffer.from(file.data, "base64").toString("utf8")) }
    }
    if ([...commands, ...scripts].some((text) => text.includes("ccstatusline"))) {
      const file = await entry(join(home, ".config/ccstatusline/settings.json"), home)
      if (file && !homeFiles.some((other) => other.path === file.path)) homeFiles.push(file)
    }
  }
  return { hostHome: home, files, homeFiles, state: agent === "claude" ? await claudeState(profile, home) : {} }
}
