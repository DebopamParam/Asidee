#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"
import { exec, json, object, run, sandboxName, type Runner } from "./client"

export const RELEASES = "https://github.com/pingdotgg/t3code/releases/download"
const VERSION = /^(?:t3\s+)?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)\s*$/

export async function hostVersion(runner: Runner, home: string): Promise<string> {
  for (const binary of ["t3", join(home, ".t3/bin/t3")]) {
    try {
      const result = await runner([binary, "--version"])
      const version = result.exitCode === 0 ? VERSION.exec(result.stdout.trim())?.[1] : undefined
      if (version && version.length <= 120) return version
    } catch { /* The desktop launcher is the fallback when PATH has no usable t3. */ }
  }
  throw new Error("No exact T3 version found on PATH or at ~/.t3/bin/t3. Open the desktop app once.")
}

export async function syncProviders(runner: Runner, name: string): Promise<{ claude: number; codex: number }> {
  const value = json(await exec(runner, name, ["node", "-e", await Bun.file(join(import.meta.dir, "providers.cjs")).text()]))
  if (!object(value) || typeof value.claude !== "number" || !Number.isInteger(value.claude) || value.claude < 0 || typeof value.codex !== "number" || !Number.isInteger(value.codex) || value.codex < 0) throw new Error("Invalid provider summary; contents withheld.")
  return { claude: value.claude, codex: value.codex }
}

export async function setup(runner: Runner, name: string, home: string): Promise<{ version: string; runtime: "installed" | "present"; claude: number; codex: number }> {
  sandboxName(name)
  const version = await hostVersion(runner, home)
  const runtime = (await exec(runner, name, ["node", "-e", await Bun.file(join(import.meta.dir, "install.cjs")).text(), version, RELEASES])).trim()
  if (runtime !== "installed" && runtime !== "present") throw new Error("Invalid T3 install response; contents withheld.")
  return { version, runtime, ...await syncProviders(runner, name) }
}

export async function main(argv: string[], env = process.env): Promise<void> {
  const [action, direct] = argv, name = direct ?? env.PADDOCK_SANDBOX ?? ""
  if (!action || action === "--help") { console.log("t3.ts setup|sync NAME. Requires an already running sandbox with Node and tar. SSH access is a separate core feature."); return }
  if (argv.length > 2) throw new Error("Unexpected T3 arguments.")
  if (action === "setup") console.log(JSON.stringify(await setup(run, name, homedir())))
  else if (action === "sync") console.log(JSON.stringify(await syncProviders(run, name)))
  else throw new Error("Use setup or sync.")
}
if (import.meta.main) main(process.argv.slice(2)).catch(() => { console.error("T3 operation failed. Check the running sandbox, tools, version, checksums and install/login locks. Subprocess output withheld."); process.exitCode = 1 })
