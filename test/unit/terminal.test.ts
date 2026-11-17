import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeConfig } from "../../core/state"
import { launchArgv, openTerminal, quote, terminalArgv } from "../../core/terminal"

test("the command opens only a shell in the named sandbox or workspace, with names checked", () => {
  expect(terminalArgv("/opt/bin", { name: "demo", kind: "sandbox" })).toEqual(["/opt/bin/asd", "shell", "demo"])
  expect(terminalArgv("/opt/bin", { name: "demo", kind: "sandbox", machine: "home-linux" })).toEqual(["/opt/bin/asd", "--host", "home-linux", "shell", "demo"])
  expect(terminalArgv("/opt/bin", { name: "demo", kind: "sandbox", machine: "local" })).toEqual(["/opt/bin/asd", "shell", "demo"])
  expect(terminalArgv("/opt/bin", { name: "notes", kind: "workspace" })).toEqual(["/opt/bin/asd", "workspace", "shell", "notes"])
  for (const target of [{ name: "demo; rm -rf ~", kind: "sandbox" }, { name: "-x", kind: "sandbox" }, { name: "demo", kind: "sandbox", machine: "a b" }, { name: "notes", kind: "workspace", machine: "home-linux" }, { name: "demo", kind: "other" }])
    expect(() => terminalArgv("/opt/bin", target as never)).toThrow()
})

test("an agent opens with asd claude or asd codex, and a profile only for those, checked", () => {
  expect(terminalArgv("/opt/bin", { name: "demo", kind: "claude" })).toEqual(["/opt/bin/asd", "claude", "demo"])
  expect(terminalArgv("/opt/bin", { name: "demo", kind: "codex", profile: "work_1", machine: "home-linux" })).toEqual(["/opt/bin/asd", "--host", "home-linux", "codex", "demo", "work_1"])
  for (const target of [{ name: "demo", kind: "claude", profile: "--setup" }, { name: "demo", kind: "claude", profile: "a b" }, { name: "demo", kind: "claude", profile: 5 }, { name: "demo", kind: "sandbox", profile: "deb" }])
    expect(() => terminalArgv("/opt/bin", target as never)).toThrow("profile")
})

test("each terminal opens the script; a custom command gets it quoted", () => {
  expect(launchArgv("default", "/s/x.command")).toEqual(["/usr/bin/open", "/s/x.command"])
  expect(launchArgv("terminal", "/s/x.command")).toEqual(["/usr/bin/open", "-a", "Terminal", "/s/x.command"])
  expect(launchArgv("ghostty", "/s/x.command")).toEqual(["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "/bin/sh", "/s/x.command"])
  expect(launchArgv("custom", "/s/it's.command", "kitty sh -c {command}")).toEqual(["/bin/sh", "-c", `kitty sh -c '/s/it'\\''s.command'`])
  expect(() => launchArgv("custom", "/s/x.command")).toThrow("terminal-command")
  expect(quote("a'b")).toBe(`'a'\\''b'`)
})

test.skipIf(process.platform !== "darwin")("opening writes a private script that removes itself and runs asd with this daemon's folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "asidee-terminal-")); const dirs = { state: join(root, "state"), config: join(root, "config") }
  await writeConfig(dirs, { terminal: "ghostty" })
  const ran: string[][] = []
  const opened = await openTerminal(dirs, "/opt/bin", async (argv) => { ran.push([...argv]); return { exitCode: 0, stdout: "", stderr: "" } }, { name: "demo", kind: "sandbox" })
  expect(opened).toEqual({ opened: "demo", terminal: "ghostty", command: "'/opt/bin/asd' 'shell' 'demo'" })
  const [script] = await readdir(join(dirs.state, "terminal"))
  const path = join(dirs.state, "terminal", script!)
  expect(ran).toEqual([["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "/bin/sh", path]])
  expect((await stat(path)).mode & 0o777).toBe(0o700)
  expect(await readFile(path, "utf8")).toBe(`#!/bin/sh\nrm -f "$0"\nexport ASIDEE_STATE_DIR=${quote(dirs.state)} ASIDEE_CONFIG_DIR=${quote(dirs.config)}\nexec '/opt/bin/asd' 'shell' 'demo'\n`)
  // A terminal that does not open leaves no script behind and says what to run instead.
  await expect(openTerminal(dirs, "/opt/bin", async () => ({ exitCode: 1, stdout: "", stderr: "Unable to find application named 'Ghostty'" }), { name: "demo", kind: "sandbox" })).rejects.toThrow("'/opt/bin/asd' 'shell' 'demo'")
  expect(await readdir(join(dirs.state, "terminal"))).toEqual([script!])
})
