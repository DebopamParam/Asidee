export type Result = { exitCode: number; stdout: string; stderr: string }
export type Runner = (argv: string[], stdin?: string) => Promise<Result>

// Never include subprocess output or thrown spawn errors in diagnostics. Either can contain a credential.
export const run: Runner = async (argv, stdin) => {
  try {
    const child = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr }
  } catch { throw new Error("Could not run the login command. Check that Bun, paddock and the requested host tool are on PATH.") }
}

export function agentName(value: string): "claude" | "codex" {
  if (value === "claude" || value === "codex") return value
  throw new Error("Choose claude or codex.")
}
export type Agent = ReturnType<typeof agentName>

export function profileName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value)) throw new Error("Use 1–48 letters, digits, underscores or hyphens for a profile.")
  return value
}

export function sandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error("Give a sandbox name of lowercase letters, digits and hyphens.")
  return value
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function execute(runner: Runner, name: string, script: string, args: string[], stdin?: string): Promise<unknown> {
  let result: Result
  try { result = await runner(["paddock", "exec", sandboxName(name), ...(stdin === undefined ? [] : ["--stdin"]), "--", "node", "-e", script, ...args], stdin) }
  catch { throw new Error("The sandbox login command could not run. Check paddock and that the sandbox is running with Node installed.") }
  if (result.exitCode === 67) throw new Error("A guest login already exists. Choose --replace explicitly to replace it.")
  if (result.exitCode === 68) throw new Error("No matching sandbox login was found. List its logins first.")
  if (result.exitCode === 75) throw new Error("Another login operation holds ~/.paddock-logins.lock in the sandbox. If it was interrupted, remove that empty directory only after checking no login operation is running.")
  if (result.exitCode !== 0) throw new Error(`The sandbox login command failed (exit ${result.exitCode}). No subprocess output is shown because it may contain secrets. The image needs Node; GitHub also needs gh and git.`)
  try { return JSON.parse(result.stdout) } catch { throw new Error("The sandbox returned an invalid login response; contents withheld.") }
}
