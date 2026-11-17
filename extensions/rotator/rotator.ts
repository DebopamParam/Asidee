#!/usr/bin/env bun
import { exec, json, object, run, type Runner } from "./client"
// Embedded, so the extension also runs from inside the asd binary.
import CONTROL from "./control.cjs" with { type: "text" }
import ROTATOR from "./t3-account-rotator.py" with { type: "text" }

export function mode(value: string): "off" | "claude" | "codex" | "claude,codex" {
  if (value === "off" || value === "claude" || value === "codex" || value === "claude,codex") return value
  throw new Error("Choose claude, codex, claude,codex or off.")
}
export type Mode = ReturnType<typeof mode>
export async function rotator(runner: Runner, name: string, choice?: Mode): Promise<{ mode: Mode; log: string[] }> {
  if (choice !== undefined) mode(choice)
  const starting = choice !== undefined && choice !== "off"
  const payload = starting ? ROTATOR : undefined
  const value = json(await exec(runner, name, ["node", "-e", CONTROL, choice ?? "status"], payload))
  if (!object(value) || typeof value.mode !== "string" || !Array.isArray(value.log) || !value.log.every((line): line is string => typeof line === "string")) throw new Error("Invalid rotator response; contents withheld.")
  // The receiver exports only timestamps and these fixed categories, never upstream free-form log text.
  if (value.log.length > 20 || value.log.some(line => !/^(?:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00 )?(?:watching|rotation requested|resume requested|check failed|log entry \(details withheld\))$/.test(line))) throw new Error("Invalid rotator log summary; contents withheld.")
  return { mode: mode(value.mode), log: value.log }
}
export async function main(argv: string[], env = process.env): Promise<void> {
  if (argv.includes("--help")) { console.log("rotator.ts NAME [claude|codex|claude,codex|off]. With no mode, show state and the last 20 sanitized log lines."); return }
  if (argv.length > 2) throw new Error("Unexpected rotator arguments.")
  const name = argv[0] ?? env.ASIDEE_SANDBOX ?? "", choice = argv[1] ?? env.ASIDEE_FIELD_MODE
  console.log(JSON.stringify(await rotator(run, name, choice && choice !== "status" ? mode(choice) : undefined)))
}
// The command line, run by Bun directly or from inside the asd binary for an installed extension.
export const command = (argv: string[]) => main(argv).catch(() => { console.error("Rotator operation failed. Check the running guest, Python, ps, T3 setup and rotator lock. Subprocess output withheld."); process.exitCode = 1 })
if (import.meta.main) command(process.argv.slice(2))
