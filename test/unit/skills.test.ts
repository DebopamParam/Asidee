import { expect, test } from "bun:test"
import { lstat, readFile, readlink, readdir, symlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { importSkills, removeSkills, select, type Spawner } from "../../extensions/skills/skills"
import { fixture, put } from "./client-feature-fixtures"

// A folder laid out like a vendored plugin whose skills are linked from .agents/skills and .claude/skills.
async function source(): Promise<string> {
  const root = await fixture()
  await put(root, ".agents/plugins/kit/skills/alpha/SKILL.md", "---\nname: alpha\n---\n")
  await put(root, ".agents/plugins/kit/agents/helper.md", "helper")
  await put(root, ".agents/skills/own/SKILL.md", "---\nname: own\n---\n")
  await put(root, ".agents/skills/own/.DS_Store", "junk")
  await put(root, ".agents/memory/MEMORY.md", "private lessons")
  await put(root, ".claude/settings.local.json", "{}")
  await put(root, "AGENTS.md", "instructions")
  await symlink("AGENTS.md", join(root, "CLAUDE.md"))
  await symlink("../plugins/kit/skills/alpha", join(root, ".agents/skills/alpha"))
  await symlink("../.agents/skills", join(root, ".claude/skills"))
  await put(root, ".claude/agents/.keep", "")
  await symlink("../../.agents/plugins/kit/agents/helper.md", join(root, ".claude/agents/helper.md"))
  return root
}

test("only skills, plugins, subagents and commands are selected, and every link must stay inside them", async () => {
  const root = await source()
  const chosen = await select(root, false)
  expect(chosen.paths).toEqual([".agents/skills", ".agents/plugins", ".claude/skills", ".claude/agents"])
  expect(chosen.links).toBe(3)
  expect((await select(root, true)).paths).toEqual([".agents/skills", ".agents/plugins", ".claude/skills", ".claude/agents", "AGENTS.md", "CLAUDE.md"])
  expect((await select(`~/${basename(root)}`, false, dirname(root))).root).toBe(root)
  await symlink("../memory/MEMORY.md", join(root, ".agents/skills/leak"))
  await expect(select(root, false)).rejects.toThrow(".agents/skills/leak links to ../memory/MEMORY.md, outside what is copied")
  const other = await source()
  await symlink("/etc/passwd", join(other, ".claude/agents/abs.md"))
  await expect(select(other, false)).rejects.toThrow("outside what is copied")
  await expect(select("relative", false)).rejects.toThrow("absolute path")
  await expect(select(await fixture(), false)).rejects.toThrow("has none of")
})

// Runs the extension's guest commands on this machine, with a temporary HOME as the sandbox.
function local(home: string): { spawn: Spawner; calls: string[][] } {
  const calls: string[][] = []
  return { calls, spawn: (argv, options) => {
    calls.push(argv)
    const guest = argv[0] === "asd" ? argv.slice(argv.indexOf("--") + 1) : argv
    const child = Bun.spawn(guest, { stdin: options.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...options.env, ...argv[0] === "asd" ? { HOME: home } : {} } })
    return { stdout: child.stdout, stderr: child.stderr, exited: child.exited }
  } }
}

test("an import copies the links as links into the guest folder, replaces only its own copies, and removes them", async () => {
  const root = await source(), home = await fixture(), guest = local(home), work = join(home, "workspace")
  const done = await importSkills("demo", { source: root, instructions: false, workspace: "workspace", replace: false }, guest.spawn)
  expect(guest.calls[1]!.slice(0, 5)).toEqual(["asd", "exec", "demo", "--stream", "--"])
  expect(done.paths).toHaveLength(4)
  expect(await readlink(join(work, ".claude/skills"))).toBe("../.agents/skills")
  expect(await readFile(join(work, ".claude/skills/alpha/SKILL.md"), "utf8")).toContain("name: alpha")
  expect(await readFile(join(work, ".claude/agents/helper.md"), "utf8")).toBe("helper")
  expect(await lstat(join(work, ".agents/skills/own/.DS_Store")).catch(() => undefined)).toBeUndefined()
  expect(await lstat(join(work, ".agents/memory")).catch(() => undefined)).toBeUndefined()
  expect(await lstat(join(work, ".claude/settings.local.json")).catch(() => undefined)).toBeUndefined()
  // A second import replaces its own copies; a file the guest made itself is refused unless replace is asked for.
  await importSkills("demo", { source: root, instructions: false, workspace: "workspace", replace: false }, guest.spawn)
  await put(home, "workspace/AGENTS.md", "mine")
  await expect(importSkills("demo", { source: root, instructions: true, workspace: "workspace", replace: false }, guest.spawn)).rejects.toThrow(/^AGENTS\.md is already in the guest folder and was not imported by Asidee; nothing was changed\.$/)
  expect(await readFile(join(work, "AGENTS.md"), "utf8")).toBe("mine")
  await importSkills("demo", { source: root, instructions: true, workspace: "workspace", replace: true }, guest.spawn)
  expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toBe("instructions")
  expect(await removeSkills("demo", "workspace", guest.spawn)).toBe(6)
  expect(await readdir(work)).toEqual([])
  expect(await removeSkills("demo", "workspace", guest.spawn)).toBe(0)
  await expect(importSkills("../x", { source: root, instructions: false, workspace: "workspace", replace: false }, guest.spawn)).rejects.toThrow("lowercase")
})
