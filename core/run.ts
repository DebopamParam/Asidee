import { PaddockError, type RunResult, type Runner } from "./types"

// What one command may print on each stream. Much of what the core runs prints what a sandbox chooses (exec, and the
// sandbox's own tools during checks), and all of it is held in the daemon's memory, so a sandbox could otherwise exhaust
// it. A command that passes the limit is killed and its output discarded: a cut-off result is never returned as whole.
export const OUTPUT_LIMIT = 16 * 1024 ** 2

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
  const abort = () => { child.kill("SIGKILL") }
  options.signal?.addEventListener("abort", abort, { once: true })
  if (options.signal?.aborted) abort()
  const limit = options.maxOutputBytes ?? OUTPUT_LIMIT
  let overflow: "stdout" | "stderr" | undefined
  const collect = async (stream: ReadableStream<Uint8Array>, which: "stdout" | "stderr") => {
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of stream) {
      size += chunk.byteLength
      if (size > limit) { overflow ??= which; child.kill("SIGKILL"); break }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  const [stdout, stderr, exitCode] = await Promise.all([collect(child.stdout, "stdout"), collect(child.stderr, "stderr"), child.exited])
  options.signal?.removeEventListener("abort", abort)
  if (overflow) return { exitCode: 124, stdout: "", stderr: `${argv[0]} printed more than ${limit / 1024 ** 2} MiB on ${overflow} and was stopped; its output was discarded.`, overflow }
  return { exitCode: child.signalCode ? 124 : exitCode, stdout: stdout.toString("utf8"), stderr: child.signalCode ? `${stderr.toString("utf8")}\n(killed: ${child.signalCode})`.trim() : stderr.toString("utf8"),
    ...(options.binary ? { raw: new Uint8Array(stdout) } : {}) }
}

export function must(result: RunResult, what: string): RunResult {
  if (result.exitCode !== 0) throw new PaddockError("runtime", `${what} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`)
  return result
}
