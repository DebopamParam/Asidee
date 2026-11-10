import { PaddockError, type RunResult, type Runner } from "./types"

// Never throws on a non-zero exit: callers decide with `must`. Arguments are passed as a vector, never through a shell.
export const systemRunner: Runner = async (argv, options = {}) => {
  let child
  try {
    child = Bun.spawn([...argv], {
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe", stderr: "pipe", cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      timeout: options.timeoutMs,
    })
  } catch (error) {
    return { exitCode: 127, stdout: "", stderr: `${argv[0]}: ${(error as Error).message}` }
  }
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode: child.signalCode ? 124 : exitCode, stdout, stderr: child.signalCode ? `${stderr}\n(killed: ${child.signalCode})`.trim() : stderr }
}

export function must(result: RunResult, what: string): RunResult {
  if (result.exitCode !== 0) throw new PaddockError("runtime", `${what} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`)
  return result
}
