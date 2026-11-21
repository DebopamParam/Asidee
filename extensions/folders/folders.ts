#!/usr/bin/env bun
import { homedir, platform } from "node:os"
import { parseArgs } from "node:util"
import { guestFolder, homeFolder, walkFolder, type Skip } from "../../core/folders"

export function sandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error("Give a sandbox name of lowercase letters, digits and hyphens.")
  return value
}

// The guest's half, in sh so it runs in any image. Each takes the folder in the sandbox as $1: ~, ~/…, absolute, or
// under $HOME. What a copy put there is recorded in ~/.asidee/copies/KEY (KEY from the folder's full path): its files
// and links, where it came from, when, and whether the copy made the folder. Only a message the script writes with
// "folders: " in front reaches the user.
const WHERE = `case "$1" in "~") dest="$HOME" ;; "~/"*) dest="$HOME/\${1#"~/"}" ;; /*) dest="$1" ;; *) dest="$HOME/$1" ;; esac
store="$HOME/.asidee/copies"
record="$store/$(printf '%s' "$dest" | cksum | cut -d ' ' -f 1)"
# Paths a record lists, without any that could leave the folder.
safe() { grep -v -E -e '^/' -e '(^|/)\\.\\.(/|$)' "$1" || true; }
# Removes the listed paths' parent folders that are left empty, deepest first.
prune() { awk -F/ '{ p = $1; for (i = 2; i <= NF; i++) { print p; p = p "/" $i } }' "$1" | LC_ALL=C sort -ru | (cd "$dest" && tr '\\n' '\\0' | xargs -0 -r rmdir 2>/dev/null) || true; }
`
// The archive comes on stdin and is unpacked beside the folder first. A path already there that an earlier copy did not
// put there stops the copy, with nothing changed, unless $2 is true. Files an earlier copy put there that the folder
// no longer has are removed, so a copy again updates it.
export const COPY = `set -eu
${WHERE}replace="$2"; source="$3"
if { [ -e "$dest" ] || [ -L "$dest" ]; } && [ ! -d "$dest" ]; then echo "folders: $1 is already in the sandbox and is not a folder; nothing was changed." >&2; exit 3; fi
made=false; [ -d "$dest" ] || made=true; [ -f "$record/made" ] && made="$(cat "$record/made")"
mkdir -p "$dest" "$store"
work="$(mktemp -d "$store/.work.XXXXXX")"; stage="$(mktemp -d "$dest/.asidee-copy.XXXXXX")"
trap 'rm -rf "$work" "$stage"' EXIT
tar -x --no-same-owner -C "$stage" -f -
old="$record/files"; [ -f "$old" ] || old=/dev/null
cd "$stage"
find . -mindepth 1 ! -type d | sed 's|^\\./||' | LC_ALL=C sort > "$work/new"
find . -mindepth 1 | sed 's|^\\./||' | while IFS= read -r p; do
  if [ -e "$dest/$p" ] || [ -L "$dest/$p" ]; then
    if [ -d "$p" ] && [ ! -L "$p" ] && [ -d "$dest/$p" ] && [ ! -L "$dest/$p" ]; then continue; fi
    printf '%s\\n' "$p"
  fi
done | LC_ALL=C sort > "$work/present"
LC_ALL=C comm -23 "$work/present" "$old" > "$work/foreign"
if [ -s "$work/foreign" ] && [ "$replace" != true ]; then
  n="$(wc -l < "$work/foreign" | tr -d ' ')"; more=""; [ "$n" -gt 3 ] && more=", …"
  echo "folders: $n of the paths are already in $1 and were not copied by Asidee: $(head -n 3 "$work/foreign" | paste -sd ',' - | sed 's/,/, /g')$more. Nothing was changed; set replace to replace them." >&2
  exit 3
fi
safe "$old" | LC_ALL=C sort | LC_ALL=C comm -23 - "$work/new" > "$work/gone"
mkdir -p "$record"
LC_ALL=C sort -u "$old" "$work/new" > "$record/files"
cat "$work/gone" "$work/present" | (cd "$dest" && tr '\\n' '\\0' | xargs -0 -r rm -rf --)
prune "$work/gone"
find . -mindepth 1 -maxdepth 1 | tar -c -f - -T - | (cd "$dest" && tar -x --no-same-owner -f -)
cp "$work/new" "$record/files"
printf '%s\\n' "$dest" > "$record/dest"; printf '%s\\n' "$source" > "$record/source"; printf '%s\\n' "$made" > "$record/made"
date -u +%Y-%m-%dT%H:%M:%SZ > "$record/at"
printf 'ok\\n'
`
export const REMOVE = `set -eu
${WHERE}[ -f "$record/files" ] || { printf '0\\n'; exit 0; }
safe "$record/files" > "$record/safe"
count="$(wc -l < "$record/safe" | tr -d ' ')"
if [ -d "$dest" ]; then
  (cd "$dest" && tr '\\n' '\\0' < "$record/safe" | xargs -0 -r rm -f --) || true
  prune "$record/safe"
  [ "$(cat "$record/made" 2>/dev/null)" = true ] && rmdir "$dest" 2>/dev/null || true
fi
rm -rf "$record"
printf '%s\\n' "$count"
`
export const LIST = `set -eu
printf 'home\\t%s\\n' "$HOME"
for r in "$HOME/.asidee/copies"/*/; do
  [ -f "$r/dest" ] && [ -f "$r/files" ] || continue
  printf 'copy\\t%s\\t%s\\t%s\\t%s\\n' "$(cat "$r/dest")" "$(cat "$r/source" 2>/dev/null)" "$(cat "$r/at" 2>/dev/null)" "$(wc -l < "$r/files" | tr -d ' ')"
done
`

export type Spawner = (argv: string[], options: { stdin?: ReadableStream<Uint8Array> | Uint8Array | "ignore"; env?: Record<string, string | undefined>; cwd?: string }) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> }
const spawner: Spawner = (argv, options) => Bun.spawn(argv, { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: options.env, cwd: options.cwd })
const guestMessage = (stderr: string) => stderr.split("\n").findLast((line) => line.startsWith("folders: "))?.slice(9, 409)

export type Copied = { source: string; dest: string; files: number; links: number; folders: number; bytes: number; excluded: Skip[]; skipped: Skip[] }
export async function copyFolder(name: string, options: { source: string; dest?: string; logins: boolean; replace: boolean }, spawn = spawner, home = homedir()): Promise<Copied> {
  sandboxName(name)
  const folder = await homeFolder(options.source, home)
  const dest = guestFolder(options.dest?.trim() || folder.mirror)
  const walk = await walkFolder(folder.path, { logins: options.logins })
  if (!walk.entries.length) throw new Error(`${folder.shown} has nothing to copy once login files, history and caches are left out.`)
  // Exactly the walked paths, NUL-separated, without recursion: nothing left out is packed. macOS tar would add resource
  // forks and extended attributes that Linux tar warns about; the system tar is named because a GNU tar earlier on PATH
  // does not take these options.
  const list = new TextEncoder().encode(walk.entries.map((path) => `${path}\0`).join(""))
  const tar = spawn([...platform() === "darwin" ? ["/usr/bin/tar", "-c", "--no-mac-metadata", "--no-xattrs"] : ["tar", "-c"], "--no-recursion", "--null", "-T", "-", "-f", "-"], { stdin: list, cwd: folder.path, env: { ...process.env, COPYFILE_DISABLE: "1" } })
  const guest = spawn(["asd", "exec", name, "--stream", "--", "sh", "-c", COPY, "sh", dest, String(options.replace), folder.shown], { stdin: tar.stdout })
  const [packed, exitCode, stdout, stderr] = await Promise.all([tar.exited, guest.exited, new Response(guest.stdout).text(), new Response(guest.stderr).text(), new Response(tar.stderr).text()])
  // A guest that refuses stops reading, which also fails tar, so its reason comes first.
  if (exitCode !== 0 || stdout.trim() !== "ok") throw new Error(guestMessage(stderr) ?? (packed !== 0 ? "Could not pack the folder; nothing was copied." : "The sandbox did not take the copy; output withheld."))
  if (packed !== 0) throw new Error("Could not pack the folder; nothing was copied.")
  return { source: folder.shown, dest, files: walk.files, links: walk.links, folders: walk.folders, bytes: walk.bytes, excluded: walk.excluded, skipped: walk.skipped }
}

export async function removeCopy(name: string, dest: string, spawn = spawner): Promise<number> {
  sandboxName(name)
  const guest = spawn(["asd", "exec", name, "--", "sh", "-c", REMOVE, "sh", guestFolder(dest)], {})
  const [exitCode, stdout] = await Promise.all([guest.exited, new Response(guest.stdout).text(), new Response(guest.stderr).text()])
  const count = Number(stdout.trim())
  if (exitCode !== 0 || !Number.isInteger(count)) throw new Error("Could not remove the copy; output withheld.")
  return count
}

export type CopyRecord = { dest: string; source: string; at: string; files: number }
export async function listCopies(name: string, spawn = spawner): Promise<CopyRecord[]> {
  sandboxName(name)
  const guest = spawn(["asd", "exec", name, "--", "sh", "-c", LIST, "sh"], {})
  const [exitCode, stdout] = await Promise.all([guest.exited, new Response(guest.stdout).text(), new Response(guest.stderr).text()])
  if (exitCode !== 0) throw new Error("Could not list the copies; output withheld.")
  const lines = stdout.split("\n").map((line) => line.split("\t"))
  const home = lines.find((line) => line[0] === "home")?.[1]
  // Shown as ~/… where it is under the sandbox user's home, as it was given.
  const shown = (path: string) => home && path === home ? "~" : home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
  return lines.filter((line) => line[0] === "copy" && line.length === 5).map(([, dest, source, at, files]) => ({ dest: shown(dest!), source: source!, at: at!, files: Number(files) }))
    .sort((a, b) => a.dest.localeCompare(b.dest))
}

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`
const SHOWN = 20
const listed = (title: string, entries: Skip[]) => entries.length ? [`${title} (${entries.length}):`, ...entries.slice(0, SHOWN).map((entry) => `  ${entry.path} (${entry.reason})`), ...entries.length > SHOWN ? [`  and ${entries.length - SHOWN} more`] : []] : []

const HELP = "folders.ts copy NAME --source DIR [--dest DIR] [--logins] [--replace] | remove NAME --dest DIR | list NAME"
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { source: { type: "string" }, dest: { type: "string" }, logins: { type: "boolean" }, replace: { type: "boolean" }, help: { type: "boolean" } } })
  const [action, direct] = positionals, name = direct ?? env.ASIDEE_SANDBOX ?? ""
  const field = (key: string) => env[`ASIDEE_FIELD_${key.toUpperCase()}`]
  if (values.help || !action) { console.log(HELP); return }
  if (action === "copy") {
    const source = values.source ?? field("source")
    if (!source) throw new Error("Give the folder with --source.")
    const done = await copyFolder(name, { source, dest: values.dest ?? field("dest"), logins: values.logins ?? field("logins") === "true", replace: values.replace ?? field("replace") === "true" })
    console.log([`Copied ${done.source} to ${done.dest} in ${name}: ${done.files} files, ${done.links} links, ${mib(done.bytes)}.`,
      ...listed("Left out", done.excluded), ...listed("Skipped", done.skipped)].join("\n"))
  } else if (action === "remove") {
    const dest = values.dest ?? field("dest")
    if (!dest) throw new Error("Give the copied folder in the sandbox with --dest, as `list` shows it.")
    const count = await removeCopy(name, dest)
    console.log(count ? `Removed the ${count} files and links Asidee copied to ${dest} in ${name}.` : `Asidee copied nothing to ${dest} in ${name}.`)
  } else if (action === "list") {
    const copies = await listCopies(name)
    console.log(copies.length ? copies.map((copy) => `${copy.dest}  from ${copy.source}, ${copy.files} files and links, ${copy.at}`).join("\n") : `No folders copied into ${name}.`)
  } else throw new Error(HELP)
}
// The command line, run by Bun directly or from inside the asd binary for an installed extension.
export const command = (argv: string[]) => main(argv).catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Folder copy failed."); process.exitCode = 1 })
if (import.meta.main) command(process.argv.slice(2))
