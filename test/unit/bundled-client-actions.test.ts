import { expect, test } from "bun:test"
import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseExtension, fieldValues } from "../../core/extensions"
import { run } from "../../extensions/t3/client"
import { fixture, local, must, put } from "./client-feature-fixtures"

test("all four bundled clients load as standalone extension declarations with executable entry points", async () => {
  const client = await Bun.file(join(import.meta.dir, "../../extensions/t3/client.ts")).text()
  for (const id of ["t3", "rotator", "env-docs", "repo"]) {
    const dir = join(import.meta.dir, "../../extensions", id), extension = parseExtension(id, dir, JSON.parse(await readFile(join(dir, "extension.json"), "utf8")))
    expect(extension.actions.length).toBeGreaterThan(0)
    expect(await Bun.file(join(dir, "client.ts")).text()).toBe(client)
    for (const action of extension.actions) {
      expect(action.scope).toBe("sandbox")
      const executable = action.run[0]
      if (!executable) throw new Error("Missing action command.")
      expect((await lstat(join(dir, executable))).mode & 0o111).not.toBe(0)
      expect(await Bun.file(join(dir, executable)).text()).toStartWith("#!/usr/bin/env bun\n")
      expect(action.fields.some(field => /token|password|secret/i.test(field.id))).toBe(false)
      expect(() => fieldValues(action, { repository: "owner/repo" })).not.toThrow()
    }
  }
})
test("the bounded transport withholds spawn failures and oversized output", async () => {
  const home = await fixture()
  await expect(run([join(home, "does-not-exist")])).rejects.not.toThrow(home)
  await expect(run(["env", "HOME=" + home, "XDG_CONFIG_HOME=" + join(home, ".config"), process.execPath, "-e", "process.stdout.write('private-output'.repeat(1300000))"])).rejects.toThrow("16 MiB")
})
test("each direct client provides help without invoking paddock or reading the real home", async () => {
  const home = await fixture(), execute = local(home)
  await put(home, "placeholder", "")
  for (const [id, entry] of [["t3", "t3.ts"], ["rotator", "rotator.ts"], ["env-docs", "env-docs.ts"], ["repo", "repo.ts"]]) {
    if (!id || !entry) throw new Error("Missing fixture entry.")
    expect((await must(execute, [process.execPath, join(import.meta.dir, "../../extensions", id, entry), "--help"])).length).toBeGreaterThan(0)
  }
})
