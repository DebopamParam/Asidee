#!/usr/bin/env bun
import { homedir } from "node:os"
import { join } from "node:path"
import { checked, exec, json, object, run, sandboxName, type Runner } from "./client"
// Embedded, so the extension also runs from inside the asd binary.
import BROWSER from "./browser.cjs" with { type: "text" }
import DOWNLOAD from "./download.cjs" with { type: "text" }
import ENVIRONMENT from "./environment.cjs" with { type: "text" }
import INSTALL from "./install.cjs" with { type: "text" }
import PROVIDERS from "./providers.cjs" with { type: "text" }

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
  const value = json(await exec(runner, name, ["node", "-e", PROVIDERS]))
  if (!object(value) || typeof value.claude !== "number" || !Number.isInteger(value.claude) || value.claude < 0 || typeof value.codex !== "number" || !Number.isInteger(value.codex) || value.codex < 0) throw new Error("Invalid provider summary; contents withheld.")
  return { claude: value.claude, codex: value.codex }
}

// The core owns SSH access: `asd ssh setup NAME` prepares it, and this reads how the desktop app connects.
export type SshAccess = { alias: string; user: string; home: string; batchReady: boolean; loopbackForwarding: boolean }
// For a sandbox on another machine (ASIDEE_HOST), the alias names that machine too.
export async function sshAccess(runner: Runner, name: string, host = process.env.ASIDEE_HOST): Promise<SshAccess> {
  const reply = json(await checked(runner, ["asd", "ssh", "access", sandboxName(name), "--json"]))
  const data = object(reply) && reply.ok === true && object(reply.data) ? reply.data : undefined
  if (!data || data.alias !== `${name}${host ? `.${host}` : ""}.asidee` || typeof data.user !== "string" || typeof data.home !== "string" || typeof data.batchReady !== "boolean" || typeof data.loopbackForwarding !== "boolean") throw new Error("Invalid SSH access response; contents withheld.")
  return { alias: data.alias, user: data.user, home: data.home, batchReady: data.batchReady, loopbackForwarding: data.loopbackForwarding }
}

export async function setup(runner: Runner, name: string, home: string): Promise<{ version: string; runtime: "installed" | "present"; chromeSandboxOff: boolean; claude: number; codex: number; ssh: SshAccess }> {
  sandboxName(name)
  const version = await hostVersion(runner, home)
  const runtime = (await exec(runner, name, ["node", "-e", DOWNLOAD + INSTALL, version, RELEASES])).trim()
  if (runtime !== "installed" && runtime !== "present") throw new Error("Invalid T3 install response; contents withheld.")
  // Only a T3 server running as root needs Chrome's sandbox off for its browser.
  const environment = (await exec(runner, name, ["node", "-e", ENVIRONMENT])).trim()
  if (environment !== "set" && environment !== "not-root") throw new Error("Invalid T3 environment response; contents withheld.")
  return { version, runtime, chromeSandboxOff: environment === "set", ...await syncProviders(runner, name), ssh: await sshAccess(runner, name) }
}

// An error whose message is safe to print.
export class Shown extends Error {}

// The browser T3 pins (a Chrome for Testing headless shell), checked against T3's own SHA-256, then T3's own setup of
// its libraries and fonts. On failure only the installer's own message is shown, never other guest output.
export async function browser(runner: Runner, name: string, home: string): Promise<{ chrome: string; browser: "installed" | "present" }> {
  sandboxName(name)
  const version = await hostVersion(runner, home)
  let result
  try { result = await runner(["asd", "exec", name, "--", "node", "-e", DOWNLOAD + BROWSER, version]) }
  catch { throw new Shown("Could not run the T3 browser install.") }
  if (result.exitCode !== 0) throw new Shown(result.stderr.split("\n").findLast((line) => line.startsWith("t3-browser: "))?.slice(12, 312) || "T3's browser install failed; output withheld.")
  const value = json(result.stdout)
  if (!object(value) || typeof value.chrome !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(value.chrome) || (value.browser !== "installed" && value.browser !== "present")) throw new Error("Invalid T3 browser response; contents withheld.")
  return { chrome: value.chrome, browser: value.browser }
}

export async function main(argv: string[], env = process.env): Promise<void> {
  const [action, direct] = argv, name = direct ?? env.ASIDEE_SANDBOX ?? ""
  if (!action || action === "--help") { console.log("t3.ts setup|browser|sync|ssh NAME. Requires an already running sandbox with Node and tar. `asd ssh setup NAME` prepares the SSH access the app connects with."); return }
  if (argv.length > 2) throw new Error("Unexpected T3 arguments.")
  if (action === "setup") console.log(JSON.stringify(await setup(run, name, homedir())))
  else if (action === "browser") console.log(JSON.stringify(await browser(run, name, homedir())))
  else if (action === "sync") console.log(JSON.stringify(await syncProviders(run, name)))
  else if (action === "ssh") console.log(JSON.stringify(await sshAccess(run, name)))
  else throw new Error("Use setup, browser, sync or ssh.")
}
// The command line, run by Bun directly or from inside the asd binary for an installed extension.
export const command = (argv: string[]) => main(argv).catch((error) => { console.error(error instanceof Shown ? error.message : "T3 operation failed. Check the running sandbox, tools, version, checksums and install/login locks. Subprocess output withheld."); process.exitCode = 1 })
if (import.meta.main) command(process.argv.slice(2))
