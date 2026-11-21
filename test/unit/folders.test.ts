import { expect, test } from "bun:test"
import { lstat, mkdir, readFile, readlink, readdir, realpath, symlink, truncate } from "node:fs/promises"
import { join } from "node:path"
import { browseFolders, homeFolder, previewFolder, walkFolder } from "../../core/folders"
import { copyFolder, listCopies, removeCopy, type Spawner } from "../../extensions/folders/folders"
import { fixture, put } from "./client-feature-fixtures"

// A home laid out like this Mac's: shared skills in ~/.agents linked from ~/.claude, and the agents' tokens, history
// and caches beside their settings.
async function home(): Promise<string> {
  const root = await realpath(await fixture())
  await put(root, ".agents/skills/own/SKILL.md", "---\nname: own\n---\n")
  await put(root, ".agents/skills/own/.DS_Store", "junk")
  await put(root, ".agents/plugins/kit/skills/alpha/SKILL.md", "---\nname: alpha\n---\n")
  await symlink("../plugins/kit/skills/alpha", join(root, ".agents/skills/alpha"))
  await put(root, ".agents/memory/MEMORY.md", "lessons")
  await put(root, ".agents/.env", "TOKEN=x")
  await put(root, ".agents/plugins/kit/server.pem", "key")
  await put(root, ".claude/settings.json", "{}")
  await put(root, ".claude/CLAUDE.md", "instructions")
  await put(root, ".claude/.credentials.json", "secret")
  await put(root, ".claude/history.jsonl", "history")
  await put(root, ".claude/projects/-Users-me/a.jsonl", "transcript")
  await put(root, ".claude/cache/x", "cache")
  await put(root, ".claude/skills/mine/SKILL.md", "---\nname: mine\n---\n")
  await put(root, ".codex/auth.json", "secret")
  await put(root, ".codex/config.toml", "model = 'x'")
  await put(root, ".codex/state_5.sqlite", "db")
  await put(root, ".codex/sessions/2026/a.jsonl", "session")
  await put(root, ".codex/prompts/p.md", "prompt")
  await put(root, "notes/sessions/today.md", "my own sessions folder")
  return root
}

test("login files are left out everywhere unless asked for; history and caches only inside an agent's own folder", async () => {
  const root = await home()
  const claude = await walkFolder(join(root, ".claude"))
  expect(claude.entries).toEqual(["CLAUDE.md", "settings.json", "skills", "skills/mine", "skills/mine/SKILL.md"])
  expect(claude.excluded).toEqual([
    { path: ".credentials.json", reason: "login file" }, { path: "cache", reason: "history or cache" },
    { path: "history.jsonl", reason: "history or cache" }, { path: "projects", reason: "history or cache" }])
  const codex = await walkFolder(join(root, ".codex"))
  expect(codex.entries).toEqual(["config.toml", "prompts", "prompts/p.md"])
  expect(codex.excluded.map((entry) => entry.path)).toEqual(["auth.json", "sessions", "state_5.sqlite"])
  // Credential files are left out of ~/.agents too, and .DS_Store silently. A folder named sessions elsewhere is copied.
  const agents = await walkFolder(join(root, ".agents"))
  expect(agents.excluded).toEqual([{ path: ".env", reason: "login file" }, { path: "plugins/kit/server.pem", reason: "login file" }])
  expect(agents.entries).not.toContain("skills/own/.DS_Store")
  expect((await walkFolder(join(root, "notes"))).entries).toEqual(["sessions", "sessions/today.md"])
  // Asked for, login files go; history still does not.
  const all = await walkFolder(join(root, ".claude"), { logins: true })
  expect(all.entries).toContain(".credentials.json")
  expect(all.excluded.map((entry) => entry.path)).toEqual(["cache", "history.jsonl", "projects"])
})

test("a link inside the folder is kept; one that points outside it is skipped and listed, never followed", async () => {
  const root = await home(), agents = join(root, ".agents")
  await symlink("../../memory/MEMORY.md", join(agents, "skills/own/inside.md"))
  await symlink("../../../.claude/settings.json", join(agents, "skills/own/up.md"))
  await symlink(join(agents, "memory"), join(agents, "absolute"))
  await symlink("/etc", join(agents, "etc"))
  const walk = await walkFolder(agents)
  expect(walk.entries).toContain("skills/alpha")
  expect(walk.entries).toContain("skills/own/inside.md")
  expect(walk.links).toBe(2)
  expect(walk.skipped).toEqual([
    { path: "absolute", reason: "points outside the folder" }, { path: "etc", reason: "points outside the folder" },
    { path: "skills/own/up.md", reason: "points outside the folder" }])
})

test("only folders in the home can be picked or browsed, links resolved first", async () => {
  const root = await home(), outside = await realpath(await fixture())
  await put(outside, "secret/a.txt", "x")
  await symlink(join(outside, "secret"), join(root, "escape"))
  await symlink(join(root, ".agents"), join(root, "shared"))
  expect(await homeFolder("~/.agents", root)).toEqual({ path: join(root, ".agents"), shown: "~/.agents", mirror: "~/.agents" })
  // A link in the home keeps its own place for the copy, but is read where it leads.
  expect(await homeFolder("~/shared", root)).toEqual({ path: join(root, ".agents"), shown: "~/.agents", mirror: "~/shared" })
  await expect(homeFolder("~/escape", root)).rejects.toThrow("outside your home folder once its links are followed")
  await expect(homeFolder(outside, root)).rejects.toThrow("outside your home folder")
  await expect(homeFolder(`${root}/../`, root)).rejects.toThrow("outside your home folder")
  await expect(homeFolder("~", root)).rejects.toThrow("not the whole home")
  await expect(homeFolder("notes", root)).rejects.toThrow("~/… or an absolute path")
  await expect(homeFolder("~/nope", root)).rejects.toThrow("does not exist")
  await expect(homeFolder("~/.claude/CLAUDE.md", root)).rejects.toThrow("is not a folder")
  // Browsing lists folder names only, ordinary ones first; a link out of the home is not listed and cannot be opened.
  const top = await browseFolders("~", root)
  expect(top).toEqual({ path: "~", folders: ["notes", "shared", ".agents", ".claude", ".codex", ".config"], picks: [
    { path: "~/.agents", label: "Shared skills (.agents)" }, { path: "~/.claude", label: "Claude Code" }, { path: "~/.codex", label: "Codex" }] })
  expect(await browseFolders("~/.claude", root)).toMatchObject({ path: "~/.claude", parent: "~", folders: ["cache", "projects", "skills"] })
  await expect(browseFolders("~/escape", root)).rejects.toThrow("outside your home folder")
  await expect(browseFolders("/", root)).rejects.toThrow("outside your home folder")
})

test("a preview counts what goes, lists what is left out, and warns about a large copy without refusing it", async () => {
  const root = await home()
  const claude = await previewFolder("~/.claude", false, root)
  expect(claude).toMatchObject({ source: "~/.claude", mirror: "~/.claude", files: 3, links: 0, folders: 2, bytes: 2 + 12 + 19, partial: false, excludedCount: 4, skippedCount: 0, warnings: [] })
  expect(await previewFolder("~/.claude", true, root)).toMatchObject({ files: 4, excludedCount: 3 })
  // 600 MB in one sparse file: no disk used, but over the warning line.
  await put(root, "big/node_modules/blob", "")
  await truncate(join(root, "big/node_modules/blob"), 600_000_000)
  await put(root, "big/README.md", "hi")
  const big = await previewFolder("~/big", false, root)
  expect(big.bytes).toBe(600_000_002)
  expect(big.warnings).toEqual(["This is a large copy; it can take a while and uses the sandbox's disk. Most of it is in node_modules."])
  expect(big.largest[0]).toEqual({ path: "node_modules", bytes: 600_000_000, entries: 2 })
})

// Runs the extension's guest commands on this machine, with a temporary HOME as the sandbox's.
function local(guestHome: string): { spawn: Spawner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, spawn: (argv, options) => {
    calls.push(argv)
    const guest = argv[0] === "asd" ? argv.slice(argv.indexOf("--") + 1) : argv
    const child = Bun.spawn(guest, { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", cwd: options.cwd, env: { ...process.env, ...options.env, ...argv[0] === "asd" ? { HOME: guestHome } : {} } })
    return { stdout: child.stdout, stderr: child.stderr, exited: child.exited }
  } }
}

test("a copy lands in the same place under the sandbox's home, updates on a second copy, and removes only its own files", async () => {
  const root = await home(), guestHome = await realpath(await fixture()), guest = local(guestHome), copied = join(guestHome, ".agents")
  await symlink("/etc", join(root, ".agents/etc"))
  const done = await copyFolder("demo", { source: "~/.agents", logins: false, replace: false }, guest.spawn, root)
  expect(guest.calls[1]!.slice(0, 5)).toEqual(["asd", "exec", "demo", "--stream", "--"])
  expect(done).toMatchObject({ source: "~/.agents", dest: "~/.agents", files: 3, links: 1, skipped: [{ path: "etc", reason: "points outside the folder" }] })
  expect(done.excluded.map((entry) => entry.path)).toEqual([".env", "plugins/kit/server.pem"])
  expect(await readlink(join(copied, "skills/alpha"))).toBe("../plugins/kit/skills/alpha")
  expect(await readFile(join(copied, "skills/alpha/SKILL.md"), "utf8")).toContain("name: alpha")
  for (const absent of [".env", "plugins/kit/server.pem", "etc", "skills/own/.DS_Store"]) expect(await lstat(join(copied, absent)).catch(() => undefined)).toBeUndefined()
  expect(await readdir(copied)).toEqual(["memory", "plugins", "skills"])
  expect(await listCopies("demo", guest.spawn)).toEqual([{ dest: "~/.agents", source: "~/.agents", at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/), files: 4 }])

  // Copied again, it follows the folder: a changed file is updated and a deleted one goes. A file the sandbox made itself
  // stays, and one in the way of the copy stops it, unless replace is set.
  await put(root, ".agents/memory/MEMORY.md", "newer")
  await Bun.$`rm -r ${join(root, ".agents/plugins")}`
  await put(guestHome, ".agents/mine.txt", "made in the sandbox")
  await copyFolder("demo", { source: "~/.agents", logins: false, replace: false }, guest.spawn, root)
  expect(await readFile(join(copied, "memory/MEMORY.md"), "utf8")).toBe("newer")
  expect(await lstat(join(copied, "plugins")).catch(() => undefined)).toBeUndefined()
  expect(await readFile(join(copied, "mine.txt"), "utf8")).toBe("made in the sandbox")
  await put(root, ".agents/mine.txt", "from the Mac")
  await expect(copyFolder("demo", { source: "~/.agents", logins: false, replace: false }, guest.spawn, root)).rejects.toThrow(/^1 of the paths are already in ~\/\.agents and were not copied by Asidee: mine\.txt\. Nothing was changed; set replace to replace them\.$/)
  expect(await readFile(join(copied, "mine.txt"), "utf8")).toBe("made in the sandbox")
  expect(await readFile(join(copied, "memory/MEMORY.md"), "utf8")).toBe("newer")
  await copyFolder("demo", { source: "~/.agents", logins: false, replace: true }, guest.spawn, root)
  expect(await readFile(join(copied, "mine.txt"), "utf8")).toBe("from the Mac")

  // Somewhere else, with login files asked for. Removing a copy leaves what the sandbox put there itself.
  await mkdir(join(guestHome, "kit"))
  await put(guestHome, "kit/keep.txt", "the sandbox's own")
  const second = await copyFolder("demo", { source: "~/.claude", dest: "kit", logins: true, replace: false }, guest.spawn, root)
  expect(second.dest).toBe("kit")
  expect(await readFile(join(guestHome, "kit/.credentials.json"), "utf8")).toBe("secret")
  expect((await listCopies("demo", guest.spawn)).map((copy) => copy.dest)).toEqual(["~/.agents", "~/kit"])
  expect(await removeCopy("demo", "kit", guest.spawn)).toBe(4)
  expect(await readdir(join(guestHome, "kit"))).toEqual(["keep.txt"])
  expect(await removeCopy("demo", "~/.agents", guest.spawn)).toBe(4)
  expect(await lstat(copied).catch(() => undefined)).toBeUndefined()
  expect(await listCopies("demo", guest.spawn)).toEqual([])
  expect(await removeCopy("demo", "~/.agents", guest.spawn)).toBe(0)
  await expect(copyFolder("../x", { source: "~/.agents", logins: false, replace: false }, guest.spawn, root)).rejects.toThrow("lowercase")
  await expect(copyFolder("demo", { source: "~/.agents", dest: "~/../etc", logins: false, replace: false }, guest.spawn, root)).rejects.toThrow("without ..")
})

test("a destination the sandbox's user cannot write is named with that user; remove takes away only the parents the copy made", async () => {
  const root = await home(), guestHome = await realpath(await fixture()), guest = local(guestHome)
  const user = (await Bun.$`id -un`.text()).trim()
  await mkdir(join(guestHome, "locked"))
  await Bun.$`chmod 555 ${join(guestHome, "locked")}`
  await expect(copyFolder("demo", { source: "~/notes", dest: join(guestHome, "locked/deep/notes"), logins: false, replace: false }, guest.spawn, root))
    .rejects.toThrow(`${user} (the sandbox's user) cannot write to ${join(guestHome, "locked/deep/notes")}; nothing was copied. Its home is ${guestHome}.`)
  expect(await readdir(join(guestHome, "locked"))).toEqual([])
  await Bun.$`chmod 755 ${join(guestHome, "locked")}`

  // Made parents go once empty; a parent that was there before stays, and so does one that holds something else.
  await mkdir(join(guestHome, "kept"))
  await copyFolder("demo", { source: "~/notes", dest: "~/a/b/notes", logins: false, replace: false }, guest.spawn, root)
  await copyFolder("demo", { source: "~/notes", dest: "~/kept/x/notes", logins: false, replace: false }, guest.spawn, root)
  await copyFolder("demo", { source: "~/notes", dest: "~/c/d/notes", logins: false, replace: false }, guest.spawn, root)
  await put(guestHome, "c/other.txt", "the sandbox's own")
  for (const dest of ["~/a/b/notes", "~/kept/x/notes", "~/c/d/notes"]) expect(await removeCopy("demo", dest, guest.spawn)).toBe(1)
  for (const gone of ["a", "kept/x", "c/d"]) expect(await lstat(join(guestHome, gone)).catch(() => undefined)).toBeUndefined()
  expect(await readdir(join(guestHome, "kept"))).toEqual([])
  expect(await readdir(join(guestHome, "c"))).toEqual(["other.txt"])
})
