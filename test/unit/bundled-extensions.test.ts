import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { availableExtensions, installExtension, loadExtensions, removeExtension, runCommand } from "../../core/extensions"
import { BUNDLED } from "../../extensions/catalog"
import type { RunResult } from "../../core/types"

const dirs = async () => { const root = await mkdtemp(join(tmpdir(), "asidee-bundled-")); return { state: join(root, "state"), config: join(root, "config") } }

test("installing a bundled extension writes only a marker, and its actions run inside asd with the declared arguments", async () => {
  const where = await dirs()
  expect(availableExtensions([]).map((entry) => [entry.id, entry.installed])).toEqual(Object.keys(BUNDLED).map((id) => [id, false]))
  const installed = await installExtension(where, "logins")
  const folder = join(where.config, "extensions", "logins")
  expect(await readdir(folder)).toEqual(["extension.json"])
  expect(JSON.parse(await readFile(join(folder, "extension.json"), "utf8"))).toEqual({ bundled: "logins" })
  expect(installed.bundled).toBe(true)
  const declared = (BUNDLED.logins as { actions: Array<{ id: string; run: string[] }> }).actions
  expect(installed.actions.map((action) => [action.id, action.run])).toEqual(declared.map((action) => [action.id, ["asd", "extension-run", "logins", ...action.run.slice(1)]]))
  const loaded = await loadExtensions(where)
  expect(loaded.extensions.map((extension) => extension.id)).toEqual(["logins"])
  expect(availableExtensions(loaded.extensions).find((entry) => entry.id === "logins")?.installed).toBe(true)
  // Installing again keeps it as it is.
  await installExtension(where, "logins")
  expect(JSON.parse(await readFile(join(folder, "extension.json"), "utf8"))).toEqual({ bundled: "logins" })
  // asd in a command is the daemon's own binary, whatever PATH says.
  const ran: Array<readonly string[]> = []
  await runCommand(async (argv) => { ran.push(argv); return { exitCode: 0, stdout: "", stderr: "" } satisfies RunResult }, installed, installed.actions[0]!.run, {}, "/opt/asidee/bin")
  expect(ran[0]![0]).toBe("/opt/asidee/bin/asd")
  expect(await removeExtension(where, "logins")).toEqual({ removed: "logins" })
  expect((await loadExtensions(where)).extensions).toEqual([])
})

test("a folder of the user's own is never written over or removed, and only bundled names are accepted", async () => {
  const where = await dirs()
  const own = join(where.config, "extensions", "repo")
  await mkdir(own, { recursive: true })
  const declaration = `{"name": "My repo tool", "actions": []}`
  await writeFile(join(own, "extension.json"), declaration)
  await expect(installExtension(where, "repo")).rejects.toThrow("not the bundled repo")
  await expect(removeExtension(where, "repo")).rejects.toThrow("leaves it alone")
  expect(await readFile(join(own, "extension.json"), "utf8")).toBe(declaration)
  for (const id of ["nope", "constructor", "__proto__", "../logins", 7]) await expect(installExtension(where, id)).rejects.toThrow("No bundled extension")
  await expect(removeExtension(where, "t3")).rejects.toThrow("not installed")
  // A marker that names another bundled extension, or one this asd lacks, is reported, not loaded.
  await mkdir(join(where.config, "extensions", "t3"), { recursive: true })
  await writeFile(join(where.config, "extensions", "t3", "extension.json"), `{"bundled": "logins"}`)
  const loaded = await loadExtensions(where)
  expect(loaded.extensions.map((extension) => extension.id)).toEqual(["repo"])
  expect(loaded.errors.join(" ")).toContain("t3")
})

test("an installed extension that is no longer bundled is reported with what replaced it, and can still be removed", async () => {
  const where = await dirs()
  await mkdir(join(where.config, "extensions", "skills"), { recursive: true })
  await writeFile(join(where.config, "extensions", "skills", "extension.json"), `{"bundled":"skills"}\n`)
  await installExtension(where, "folders")
  const loaded = await loadExtensions(where)
  expect(loaded.extensions.map((extension) => extension.id)).toEqual(["folders"])
  expect(loaded.errors).toEqual(["Extension skills: Skills and plugins is no longer bundled: Folders copies any folder in, such as ~/.agents. Remove it with `asd ext remove skills`, and install Folders with `asd ext install folders`."])
  expect(availableExtensions(loaded.extensions).map((entry) => entry.id)).not.toContain("skills")
  await expect(installExtension(where, "skills")).rejects.toThrow("No bundled extension")
  expect(await removeExtension(where, "skills")).toEqual({ removed: "skills" })
  expect((await loadExtensions(where)).errors).toEqual([])
})
