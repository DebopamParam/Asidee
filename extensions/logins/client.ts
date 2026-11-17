export type Result = { exitCode: number; stdout: string; stderr: string }
export type Runner = (argv: string[], stdin?: string) => Promise<Result>
export { profileName } from "../../core/credentials"

// Never include subprocess output or thrown spawn errors in diagnostics. Either can contain a credential.
export const run: Runner = async (argv, stdin) => {
  try {
    const child = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr }
  } catch { throw new Error("Could not run the login command. Check that asd and the requested host tool are on PATH.") }
}

export function agentName(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value
  throw new Error("Choose claude or codex.")
}
export type Agent = ReturnType<typeof agentName>

export function sandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error("Give a sandbox name of lowercase letters, digits and hyphens.")
  return value
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Input goes with --stream: a setup with skills can pass the 16 MiB a buffered exec takes.
export async function execute(runner: Runner, name: string, script: string, args: string[], stdin?: string): Promise<unknown> {
  let result: Result
  try { result = await runner(["asd", "exec", sandboxName(name), ...(stdin === undefined ? [] : ["--stream"]), "--", "node", "-e", script, ...args], stdin) }
  catch { throw new Error("The sandbox login command could not run. Check asd and that the sandbox is running with Node installed.") }
  if (result.exitCode === 67) throw new Error("A guest login already exists. Choose --replace explicitly to replace it.")
  if (result.exitCode === 68) throw new Error("No matching sandbox login was found. List its logins first.")
  if (result.exitCode === 77) throw new Error("GitHub did not accept that token (HTTP 401). Nothing was written in the sandbox.")
  if (result.exitCode === 75) throw new Error("Another login operation holds ~/.asidee-logins.lock in the sandbox. If it was interrupted, remove that empty directory only after checking no login operation is running.")
  if (result.exitCode !== 0) throw new Error(`The sandbox login command failed (exit ${result.exitCode}). No subprocess output is shown because it may contain secrets. Check that the sandbox is running (asd list); the image needs Node, and GitHub also needs gh and git.`)
  try { return JSON.parse(result.stdout) } catch { throw new Error("The sandbox returned an invalid login response; contents withheld.") }
}
