import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { AsideeError } from "./types"

// A folder of this Mac copied into a sandbox (the bundled folders extension): which folders may be picked, which of
// their files go, and what is left out. Only names, kinds and sizes are read here, never a file's contents.

// Login files are left out unless asked for, wherever they are: the agents' tokens (as the logins extension reads them),
// GitHub's, git's, SSH and AWS keys, netrc, keys and certificates, and .env files.
const LOGIN_NAMES = new Set([".credentials.json", "auth.json", ".claude.json", ".mcp.json", "hosts.yml", ".git-credentials", ".netrc", ".ssh", ".aws", ".gnupg"])
const LOGIN_PATTERNS = [/\.(pem|key|p12|pfx)$/, /^\.env/]
// History, sessions and caches are always left out, but only directly inside an agent's own folder (.claude, .claude-*,
// .codex, .codex-*, opencode), where these names mean that. As laid out on this Mac on 2026-11-21: Claude Code 2.1,
// Codex 0.13x and OpenCode's ~/.local/share/opencode.
const AGENT_FOLDER = /^(\.(claude|codex)(-.+)?|opencode)$/
const HISTORY_NAMES = new Set([
  "history.jsonl", "projects", "file-history", "paste-cache", "shell-snapshots", "session-env", "sessions", "todos", "statsig", "telemetry", "cache", "backups", "debug", "ide", "jobs", "daemon", ".last-cleanup",
  "session_index.jsonl", "archived_sessions", "shell_snapshots", "log", "logs", "tmp", ".tmp", "sqlite", "ipc", "app-server-control", "app-server-daemon", "thread-writer-locks", "mcp-oauth-locks", "models_cache.json",
  "storage", "snapshot"])
const HISTORY_PATTERNS = [/\.(sqlite|db)(-shm|-wal|-journal)?$/, /\.lock$/, /^(policy-limits|remote-settings|daemon\.status)\.json/, /^\.codex-global-state\.json/]
// Never worth copying, and not listed.
const JUNK = new Set([".DS_Store"])

export const isLoginFile = (name: string) => LOGIN_NAMES.has(name) || LOGIN_PATTERNS.some((pattern) => pattern.test(name))
export const isHistory = (name: string) => HISTORY_NAMES.has(name) || HISTORY_PATTERNS.some((pattern) => pattern.test(name))

// Shown as quick picks when they exist.
export const FOLDER_PICKS = [
  { path: "~/.agents", label: "Shared skills (.agents)" }, { path: "~/.claude", label: "Claude Code" }, { path: "~/.codex", label: "Codex" }, { path: "~/.config/opencode", label: "OpenCode" },
]
// Above either, a preview warns; nothing is refused for size.
export const LARGE_BYTES = 500_000_000, LARGE_ENTRIES = 20_000

const tilde = (path: string, home: string) => path === home ? "~" : `~/${relative(home, path)}`
const under = (path: string, home: string) => path.startsWith(home + sep)

// A folder in this user's home, given as ~/… or an absolute path. Links are resolved first, so one that leads out of
// the home is refused. path: the real folder; shown: as ~/…; mirror: where it goes in the sandbox by default, the same
// place under the sandbox user's home as the path given (before links) has under this one.
export async function homeFolder(given: string, home = homedir(), allowHome = false): Promise<{ path: string; shown: string; mirror: string }> {
  if (typeof given !== "string" || !given.trim() || /[\0\r\n]/.test(given)) throw new AsideeError("usage", "Give a folder in your home, as ~/… or an absolute path.")
  const text = given.trim(), expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text
  if (!isAbsolute(expanded)) throw new AsideeError("usage", "Give the folder as ~/… or an absolute path.")
  const realHome = await realpath(home), lexical = resolve(expanded)
  const path = await realpath(lexical).catch(() => { throw new AsideeError("not-found", `${text} does not exist.`) })
  if (!(await stat(path)).isDirectory()) throw new AsideeError("usage", `${text} is not a folder.`)
  if (path === realHome && !allowHome) throw new AsideeError("usage", "Pick a folder inside your home, not the whole home.")
  if (!under(path, realHome) && path !== realHome) throw new AsideeError("usage", `${text} is outside your home folder${lexical !== path ? " once its links are followed" : ""}. Only folders in your home can be picked.`)
  const mirrored = under(lexical, home) ? relative(home, lexical) : relative(realHome, path)
  return { path, shown: tilde(path, realHome), mirror: `~/${mirrored}` }
}

// Where a copy goes in the sandbox: ~, ~/…, an absolute path, or a path under the sandbox user's home.
export function guestFolder(value: string): string {
  const text = value.trim().replace(/(.)\/+$/, "$1")
  if (!text || text.length > 4096 || /[\0\r\n]/.test(text) || text.split("/").includes("..")) throw new AsideeError("usage", "Give the folder in the sandbox as ~/…, an absolute path, or a path under its home, without ..")
  if (text === "/") throw new AsideeError("usage", "Give a folder in the sandbox, not / itself.")
  return text
}

export type Skip = { path: string; reason: string }
export type FolderWalk = {
  root: string; entries: string[]; files: number; links: number; folders: number; bytes: number
  excluded: Skip[]; skipped: Skip[]; partial: boolean; largest: Array<{ path: string; bytes: number; entries: number }>
}

// Every path to copy, relative to the folder, parents before children. A link is copied as a link when it points
// inside the folder; one that points outside it, or by an absolute path, is skipped, never followed. limit: stop after
// that many entries (a preview), marking the walk partial.
export async function walkFolder(root: string, options: { logins?: boolean; limit?: number } = {}): Promise<FolderWalk> {
  const walk: FolderWalk = { root, entries: [], files: 0, links: 0, folders: 0, bytes: 0, excluded: [], skipped: [], partial: false, largest: [] }
  const top = new Map<string, { bytes: number; entries: number }>()
  const count = (path: string, bytes: number) => {
    const head = path.split(sep)[0]!, sum = top.get(head) ?? { bytes: 0, entries: 0 }
    sum.bytes += bytes; sum.entries++; top.set(head, sum)
  }
  const visit = async (folder: string): Promise<void> => {
    let names: string[]
    try { names = (await readdir(join(root, folder))).sort() } catch { walk.skipped.push({ path: folder, reason: "could not be read" }); return }
    const agentFolder = AGENT_FOLDER.test(basename(folder ? join(root, folder) : root))
    for (const name of names) {
      if (walk.partial) return
      const path = folder ? join(folder, name) : name
      if (JUNK.has(name)) continue
      if (/[\r\n]/.test(name)) { walk.skipped.push({ path, reason: "its name has a line break" }); continue }
      if (!options.logins && isLoginFile(name)) { walk.excluded.push({ path, reason: "login file" }); continue }
      if (agentFolder && isHistory(name)) { walk.excluded.push({ path, reason: "history or cache" }); continue }
      if (options.limit !== undefined && walk.entries.length >= options.limit) { walk.partial = true; return }
      const info = await lstat(join(root, path)).catch(() => undefined)
      if (!info) { walk.skipped.push({ path, reason: "could not be read" }); continue }
      if (info.isSymbolicLink()) {
        const target = await readlink(join(root, path))
        if (isAbsolute(target)) { walk.skipped.push({ path, reason: "points outside the folder" }); continue }
        const inside = relative(root, resolve(root, dirname(path), target))
        if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) { walk.skipped.push({ path, reason: "points outside the folder" }); continue }
        walk.entries.push(path); walk.links++; count(path, 0)
      } else if (info.isDirectory()) {
        walk.entries.push(path); walk.folders++; count(path, 0)
        await visit(path)
      } else if (info.isFile()) {
        walk.entries.push(path); walk.files++; walk.bytes += info.size; count(path, info.size)
      } else walk.skipped.push({ path, reason: "not a file, folder or link" })
    }
  }
  await visit("")
  walk.largest = [...top].map(([path, sum]) => ({ path, ...sum })).filter((entry) => entry.entries > 1 || entry.bytes > 0).sort((a, b) => b.bytes - a.bytes || b.entries - a.entries).slice(0, 3)
  return walk
}

export type FolderPreview = {
  source: string; mirror: string; files: number; links: number; folders: number; bytes: number; partial: boolean
  excluded: Skip[]; excludedCount: number; skipped: Skip[]; skippedCount: number; largest: FolderWalk["largest"]; warnings: string[]
}
const LISTED = 200
// What a copy would take and leave out, for the dashboard before it runs. Large is warned about, not refused.
export async function previewFolder(source: string, logins = false, home = homedir()): Promise<FolderPreview> {
  const folder = await homeFolder(source, home)
  const walk = await walkFolder(folder.path, { logins, limit: 200_000 })
  const entries = walk.files + walk.links + walk.folders, warnings: string[] = []
  const heavy = walk.bytes > LARGE_BYTES, many = entries > LARGE_ENTRIES || walk.partial
  if (heavy || many) {
    const big = walk.largest.filter((entry) => heavy && entry.bytes > walk.bytes / 4 || many && entry.entries > entries / 4).map((entry) => entry.path)
    warnings.push(`This is a large copy${walk.partial ? " (counting stopped at 200000 entries)" : ""}; it can take a while and uses the sandbox's disk.${big.length ? ` Most of it is in ${big.join(", ")}.` : ""}`)
  }
  return { source: folder.shown, mirror: folder.mirror, files: walk.files, links: walk.links, folders: walk.folders, bytes: walk.bytes, partial: walk.partial,
    excluded: walk.excluded.slice(0, LISTED), excludedCount: walk.excluded.length, skipped: walk.skipped.slice(0, LISTED), skippedCount: walk.skipped.length, largest: walk.largest, warnings }
}

// The folders inside one folder of the home, names only, for picking a folder. A link to a folder is listed when it
// stays in the home. picks: the quick picks that exist.
export async function browseFolders(given = "~", home = homedir()): Promise<{ path: string; parent?: string; folders: string[]; picks: typeof FOLDER_PICKS; finder: boolean }> {
  const folder = await homeFolder(given, home, true), realHome = await realpath(home)
  const folders: string[] = []
  for (const entry of await readdir(folder.path, { withFileTypes: true }).catch(() => { throw new AsideeError("runtime", `${folder.shown} could not be read.`) })) {
    if (/[\r\n]/.test(entry.name)) continue
    if (entry.isDirectory()) folders.push(entry.name)
    else if (entry.isSymbolicLink()) {
      const target = await realpath(join(folder.path, entry.name)).catch(() => undefined)
      if (target && under(target, realHome) && (await stat(target)).isDirectory()) folders.push(entry.name)
    }
  }
  // Ordinary folders first, then hidden ones, each alphabetically.
  folders.sort((a, b) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b))
  const picks = []
  for (const pick of FOLDER_PICKS) if (await homeFolder(pick.path, home).then(() => true, () => false)) picks.push(pick)
  return { path: folder.shown, ...(folder.path !== realHome ? { parent: tilde(dirname(folder.path), realHome) } : {}), folders, picks, finder: FINDER }
}

// On a Mac, a folder can also be picked in Finder's own window, opened by this service. One window at a time; no path
// when it is cancelled.
const FINDER = process.platform === "darwin"
const CHOOSE = ['tell current application to activate', 'POSIX path of (choose folder with prompt "Pick a folder to copy into the sandbox" default location (path to home folder))']
let choosing = false
export async function chooseFolder(home = homedir(), argv = ["osascript", ...CHOOSE.flatMap((line) => ["-e", line])]): Promise<{ path?: string }> {
  if (!FINDER) throw new AsideeError("usage", "Finder is only on a Mac. Type the folder or use Browse.")
  if (choosing) throw new AsideeError("conflict", "A Finder window to pick a folder is already open.")
  choosing = true
  try {
    const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) {
      if (/-128/.test(err)) return {}
      throw new AsideeError("runtime", "Finder's window could not be opened. Type the folder or use Browse.")
    }
    return { path: (await homeFolder(out.trim().replace(/(.)\/$/, "$1"), home)).shown }
  } finally { choosing = false }
}
