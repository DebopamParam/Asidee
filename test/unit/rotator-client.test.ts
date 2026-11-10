import { expect, test } from "bun:test"
import { chmod, readFile } from "node:fs/promises"
import { join } from "node:path"
import { mode, rotator } from "../../extensions/rotator/rotator"
import { fixture, fakeExec, put } from "./client-feature-fixtures"

test("the rotator script matches the reference byte for byte", async () => {
  const actual = await Bun.file(join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")).arrayBuffer()
  const reference = Bun.file(join(import.meta.dir, "../../../sandbox-manager/src/guest/t3-account-rotator.py"))
  // The source checkout is optional for people cloning only Paddock.
  if (await reference.exists()) expect(Buffer.from(actual)).toEqual(Buffer.from(await reference.arrayBuffer()))
  expect(new Bun.CryptoHasher("sha256").update(actual).digest("hex")).toBe("8667212855ade3cf462efe109d745f625bee80a96cf11dd1ecf780176195e248")
})
test("rotator status is read-only, bad modes fail and guest errors do not disclose secrets", async () => {
  const home = await fixture(), transport = fakeExec(home)
  expect(await rotator(transport.runner, "demo")).toEqual({ mode: "off", log: [] })
  expect(await Bun.file(join(home, ".t3/account-rotator/pid")).exists()).toBe(false)
  expect(transport.calls[0]?.stdin).toBeUndefined()
  expect(() => mode("all")).toThrow("Choose")
  await expect(rotator(async () => ({ exitCode: 1, stdout: "token-secret", stderr: "token-secret" }), "demo", "claude")).rejects.not.toThrow("token-secret")
  await expect(rotator(async () => ({ exitCode: 0, stdout: '{"mode":"off","log":["token-secret"]}', stderr: "" }), "demo")).rejects.not.toThrow("token-secret")
})
test("starting transfers the unchanged script on stdin, detaches, replaces the watcher and stops only its PID", async () => {
  const home = await fixture(), bin = join(home, "fake-bin")
  await put(home, ".t3/userdata/settings.json", "{}")
  await put(home, "fake-bin/python3", `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.exit(0)\nconsole.log('2026-11-11T00:00:00+00:00 rotate thread title-token-secret')\nsetInterval(() => {}, 1000)\n`)
  await chmod(join(bin, "python3"), 0o700)
  const transport = fakeExec(home, { PATH: bin + ":" + process.env.PATH })
  try {
    const first = await rotator(transport.runner, "demo", "claude,codex")
    expect(first.mode).toBe("claude,codex"); expect(first.log).toEqual(["2026-11-11T00:00:00+00:00 rotation requested"])
    const originalPid = await readFile(join(home, ".t3/account-rotator/pid"), "utf8")
    expect(await readFile(join(home, ".t3/account-rotator/rotate.py"), "utf8")).toBe(await Bun.file(join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")).text())
    expect(transport.calls[0]?.stdin).toBe(await Bun.file(join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")).text())
    expect(transport.calls[0]?.argv).not.toContain(transport.calls[0]?.stdin ?? "")
    expect((await rotator(transport.runner, "demo")).mode).toBe("claude,codex")
    expect((await rotator(transport.runner, "demo", "codex")).mode).toBe("codex")
    expect(await readFile(join(home, ".t3/account-rotator/pid"), "utf8")).not.toBe(originalPid)
    expect((await rotator(transport.runner, "demo", "off")).mode).toBe("off")
    expect(transport.calls.at(-1)?.stdin).toBeUndefined()
    await put(home, ".t3/account-rotator/pid", String(process.pid))
    await put(home, ".t3/account-rotator/providers", "claude")
    expect((await rotator(transport.runner, "demo", "off")).mode).toBe("off")
    expect(process.kill(process.pid, 0)).toBe(true)
  } finally { await rotator(transport.runner, "demo", "off") }
})
