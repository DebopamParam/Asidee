import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { hostName } from "./machines"
import { readConfig, validName, type Dirs, type Terminal } from "./state"
import { AsideeError, type Runner } from "./types"

// Opens a shell in a sandbox or workspace in a terminal window on this Mac, for the dashboard's Terminal button. The
// caller chooses only what to open, never the command: the window runs `asd shell NAME` (or `asd workspace shell NAME`,
// or `asd claude|codex NAME [PROFILE]`), which the caller could run anyway, and nothing the window prints comes back. The command is written to a script that
// deletes itself when it starts, so any terminal that can run a file can open it.
export type TerminalTarget = { name: string; kind: "sandbox" | "workspace" | "claude" | "codex"; machine?: string; profile?: string }
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/

export const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

export function terminalArgv(cliDir: string, target: TerminalTarget): string[] {
  const machine = target.machine === undefined || target.machine === "local" ? undefined : hostName(target.machine)
  if (target.kind === "workspace" && machine) throw new AsideeError("usage", "Workspaces run on this Mac; there is no workspace on another machine.")
  if (!["sandbox", "workspace", "claude", "codex"].includes(target.kind)) throw new AsideeError("usage", "kind must be sandbox, workspace, claude or codex.")
  const agent = target.kind === "claude" || target.kind === "codex"
  if (target.profile !== undefined && (!agent || typeof target.profile !== "string" || !PROFILE.test(target.profile))) throw new AsideeError("usage", "A login profile is 1 to 48 letters, digits, underscores or hyphens, for claude or codex.")
  return [join(cliDir, "asd"), ...(machine ? ["--host", machine] : []), ...(target.kind === "workspace" ? ["workspace", "shell"] : agent ? [target.kind] : ["shell"]), validName(target.name), ...(target.profile ? [target.profile] : [])]
}

// What opens the script in each terminal. custom: the user's own command, set through the CLI only (core/state.ts).
export function launchArgv(terminal: Terminal, script: string, custom?: string): string[] {
  switch (terminal) {
    case "default": return ["/usr/bin/open", script]
    case "terminal": return ["/usr/bin/open", "-a", "Terminal", script]
    case "iterm": return ["/usr/bin/open", "-a", "iTerm", script]
    // -n: a new Ghostty process, so the window opens even when Ghostty runs; -e: the command it runs in that window.
    case "ghostty": return ["/usr/bin/open", "-na", "Ghostty", "--args", "-e", "/bin/sh", script]
    case "custom":
      if (!custom) throw new AsideeError("usage", "The terminal is custom but no command is set. Run asd config set terminal-command '…'.")
      return ["/bin/sh", "-c", custom.replaceAll("{command}", quote(script))]
  }
}

export async function openTerminal(dirs: Dirs, cliDir: string, run: Runner, target: TerminalTarget): Promise<{ opened: string; terminal: Terminal; command: string }> {
  if (process.platform !== "darwin") throw new AsideeError("dependency", "Opening a terminal window is available on macOS only. Run the command shown instead.")
  const argv = terminalArgv(cliDir, target)
  const config = await readConfig(dirs)
  const folder = join(dirs.state, "terminal")
  await mkdir(folder, { recursive: true, mode: 0o700 })
  // Scripts a terminal never ran are removed after an hour.
  for (const entry of await readdir(folder).catch(() => [])) {
    const path = join(folder, entry); const info = await stat(path).catch(() => undefined)
    if (info && Date.now() - info.mtimeMs > 3_600_000) await rm(path, { force: true })
  }
  const command = argv.map(quote).join(" ")
  const script = join(folder, `${target.kind}-${target.name}-${crypto.randomUUID().slice(0, 8)}.command`)
  // The daemon's own folders, so the shell reaches this daemon whatever the terminal's environment says.
  await writeFile(script, `#!/bin/sh\nrm -f "$0"\nexport ASIDEE_STATE_DIR=${quote(dirs.state)} ASIDEE_CONFIG_DIR=${quote(dirs.config)}\nexec ${command}\n`, { mode: 0o700 })
  await chmod(script, 0o700)
  const launch = launchArgv(config.terminal, script, config.terminalCommand)
  // open returns once the app has the file; a custom command may stay as long as its window, so it is not waited for.
  if (config.terminal === "custom") {
    const child = Bun.spawn(launch, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }); child.unref()
  } else {
    const result = await run(launch, { timeoutMs: 15_000 })
    if (result.exitCode !== 0) { await rm(script, { force: true }); throw new AsideeError("dependency", `The terminal could not be opened (${config.terminal}): ${result.stderr.trim() || `exit ${result.exitCode}`}. Choose another in Settings, or run ${command} yourself.`) }
  }
  return { opened: target.name, terminal: config.terminal, command }
}
