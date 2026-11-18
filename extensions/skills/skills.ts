#!/usr/bin/env bun
import { lstat, readdir, readlink, realpath } from "node:fs/promises"
import { homedir, platform } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"

// What agents read as skills, plugins, subagents and commands. Memory, settings and credentials are never among them.
export const PARTS = [".agents/skills", ".agents/plugins", ".claude/skills", ".claude/agents", ".claude/commands"]
export const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"]
const OMIT = new Set([".DS_Store", ".git", "node_modules", "__pycache__"])
const MAX_BYTES = 256 * 1024 * 1024, MAX_ENTRIES = 20000

export function sandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error("Give a sandbox name of lowercase letters, digits and hyphens.")
  return value
}
function workspace(value: string): string {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error("Give a guest folder.")
  return value
}
function expand(source: string, home: string): string {
  const path = source === "~" ? home : source.startsWith("~/") ? join(home, source.slice(2)) : source
  if (!isAbsolute(path)) throw new Error("Give the host folder as an absolute path or one starting with ~/.")
  return resolve(path)
}

export type Selection = { root: string; paths: string[]; files: number; links: number; bytes: number }
// The paths to copy, relative to the folder. Every link must stay inside what is copied, so the copies work as they do here.
export async function select(source: string, instructions: boolean, home = homedir()): Promise<Selection> {
  const given = expand(source, home), root = await realpath(given).catch(() => given)
  if (!(await lstat(root).catch(() => undefined))?.isDirectory()) throw new Error(`${given} is not a folder.`)
  const paths: string[] = []
  for (const path of [...PARTS, ...(instructions ? INSTRUCTIONS : [])]) if (await lstat(join(root, path)).catch(() => undefined)) paths.push(path)
  if (!paths.some((path) => PARTS.includes(path))) throw new Error(`${root} has none of ${PARTS.join(", ")}.`)
  const inside = (path: string) => paths.some((part) => path === part || path.startsWith(part + sep))
  const selection: Selection = { root, paths, files: 0, links: 0, bytes: 0 }
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(join(root, path))
    if (++selection.files + selection.links > MAX_ENTRIES || (selection.bytes += info.isFile() ? info.size : 0) > MAX_BYTES) throw new Error("More than 256 MiB or 20000 entries; nothing was copied.")
    if (info.isSymbolicLink()) {
      selection.files--; selection.links++
      const target = await readlink(join(root, path)), resolved = relative(root, resolve(root, dirname(path), target))
      if (isAbsolute(target) || resolved.startsWith("..") || !inside(resolved)) throw new Error(`${path} links to ${target}, outside what is copied; nothing was copied.`)
    } else if (info.isDirectory()) {
      selection.files--
      for (const name of (await readdir(join(root, path))).sort()) if (!OMIT.has(name)) await visit(join(path, name))
    } else if (!info.isFile()) throw new Error(`${path} is not a file, folder or link; nothing was copied.`)
  }
  for (const path of paths) await visit(path)
  return selection
}

// Runs in the guest with the archive on stdin. A path already there is replaced only if Asidee imported it, or when asked.
const IMPORT = `set -eu
case "$1" in /*) dest="$1" ;; *) dest="$HOME/$1" ;; esac
replace="$2"; shift 2
mkdir -p "$dest"
marker="$dest/.asidee-imported"
for p in "$@"; do
  if { [ -e "$dest/$p" ] || [ -L "$dest/$p" ]; } && [ "$replace" != true ] && ! grep -qxF "$p" "$marker" 2>/dev/null; then
    echo "skills: $p is already in the guest folder and was not imported by Asidee; nothing was changed." >&2; exit 3
  fi
done
stage="$(mktemp -d "$dest/.asidee-import.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -x --no-same-owner -C "$stage" -f -
for p in "$@"; do
  rm -rf "$dest/$p"; mkdir -p "$(dirname "$dest/$p")"; mv "$stage/$p" "$dest/$p"
  grep -qxF "$p" "$marker" 2>/dev/null || printf '%s\\n' "$p" >> "$marker"
done
printf 'ok\\n'
`
const REMOVE = `set -eu
case "$1" in /*) dest="$1" ;; *) dest="$HOME/$1" ;; esac
marker="$dest/.asidee-imported"
[ -f "$marker" ] || { printf '0\\n'; exit 0; }
count=0
while IFS= read -r p; do
  case "$p" in ""|/*|*..*) continue ;; esac
  rm -rf "$dest/$p"; count=$((count + 1))
done < "$marker"
rm -f "$marker"
for d in "$dest/.agents" "$dest/.claude"; do rmdir "$d" 2>/dev/null || true; done
printf '%s\\n' "$count"
`

export type Spawner = (argv: string[], options: { stdin?: ReadableStream<Uint8Array> | "ignore"; env?: Record<string, string | undefined> }) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> }
const spawner: Spawner = (argv, options) => Bun.spawn(argv, { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: options.env })
// Only a message the guest script wrote reaches the user; other guest output can hold anything.
const guestMessage = (stderr: string) => stderr.split("\n").findLast((line) => line.startsWith("skills: "))?.slice(8, 308)

export async function importSkills(name: string, options: { source: string; instructions: boolean; workspace: string; replace: boolean }, spawn = spawner, home = homedir()): Promise<Selection> {
  sandboxName(name); workspace(options.workspace)
  const selection = await select(options.source, options.instructions, home)
  // macOS tar would add resource forks and extended attributes that Linux tar warns about. The system tar is named
  // because a GNU tar earlier on PATH does not take these options.
  const tar = spawn([...platform() === "darwin" ? ["/usr/bin/tar", "-c", "--no-mac-metadata", "--no-xattrs"] : ["tar", "-c"], ...[...OMIT].flatMap((name) => ["--exclude", name]), "-C", selection.root, "-f", "-", ...selection.paths], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
  const guest = spawn(["asd", "exec", name, "--stream", "--", "sh", "-c", IMPORT, "sh", options.workspace, String(options.replace), ...selection.paths], { stdin: tar.stdout })
  const [packed, exitCode, stdout, stderr] = await Promise.all([tar.exited, guest.exited, new Response(guest.stdout).text(), new Response(guest.stderr).text(), new Response(tar.stderr).text()])
  // A guest that refuses stops reading, which also fails tar, so its reason comes first.
  if (exitCode !== 0 || stdout.trim() !== "ok") throw new Error(guestMessage(stderr) ?? (packed !== 0 ? "Could not pack the host folder; nothing was copied." : "The sandbox did not take the copy; output withheld."))
  if (packed !== 0) throw new Error("Could not pack the host folder; nothing was copied.")
  return selection
}

export async function removeSkills(name: string, folder: string, spawn = spawner): Promise<number> {
  sandboxName(name); workspace(folder)
  const guest = spawn(["asd", "exec", name, "--", "sh", "-c", REMOVE, "sh", folder], {})
  const [exitCode, stdout] = await Promise.all([guest.exited, new Response(guest.stdout).text(), new Response(guest.stderr).text()])
  const count = Number(stdout.trim())
  if (exitCode !== 0 || !Number.isInteger(count)) throw new Error("Could not remove the imported copies; output withheld.")
  return count
}

const HELP = "skills.ts import NAME --source DIR [--instructions] [--workspace DIR] [--replace] | remove NAME [--workspace DIR]"
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { source: { type: "string" }, instructions: { type: "boolean" }, workspace: { type: "string" }, replace: { type: "boolean" }, help: { type: "boolean" } } })
  const [action, direct] = positionals, name = direct ?? env.ASIDEE_SANDBOX ?? ""
  const field = (key: string) => env[`ASIDEE_FIELD_${key.toUpperCase()}`]
  if (values.help || !action) { console.log(HELP); return }
  const folder = values.workspace ?? field("workspace") ?? "workspace"
  if (action === "import") {
    const source = values.source ?? field("source")
    if (!source) throw new Error("Give the host folder with --source.")
    const done = await importSkills(name, { source, instructions: values.instructions ?? field("instructions") === "true", workspace: folder, replace: values.replace ?? field("replace") === "true" })
    console.log(`Copied ${done.paths.join(", ")} (${done.files} files, ${done.links} links, ${(done.bytes / 1048576).toFixed(1)} MiB) into ${folder} in ${name}.`)
  } else if (action === "remove") {
    const count = await removeSkills(name, folder)
    console.log(count ? `Removed ${count} imported paths from ${folder} in ${name}.` : `Nothing imported in ${folder} in ${name}.`)
  } else throw new Error(HELP)
}
// The command line, run by Bun directly or from inside the asd binary for an installed extension.
export const command = (argv: string[]) => main(argv).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Skills operation failed."); process.exitCode = 1 })
if (import.meta.main) command(process.argv.slice(2))
