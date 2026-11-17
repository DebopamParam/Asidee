export type Result = { exitCode: number; stdout: string; stderr: string }
export type Runner = (argv: string[], stdin?: string) => Promise<Result>

// Child diagnostics can contain credentials, including ones printed by Git or a guest startup hook.
export const run: Runner = async (argv, stdin) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const spawned = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" }); child = spawned
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader(), chunks: Uint8Array[] = []; let size = 0
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break
          size += next.value.length
          if (size > 16 * 1024 * 1024) throw new Error()
          chunks.push(next.value)
        }
        return Buffer.concat(chunks).toString("utf8")
      } finally { await reader.cancel().catch(() => {}) }
    }
    const [exitCode, stdout, stderr] = await Promise.all([spawned.exited, read(spawned.stdout), read(spawned.stderr)])
    return { exitCode, stdout, stderr }
  } catch {
    try { child?.kill() } catch { /* A command may already have exited when its output limit is detected. */ }
    throw new Error("Could not run the client command or output exceeded 16 MiB; subprocess details withheld.")
  }
}

export function sandboxName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error("Give a sandbox name of lowercase letters, digits and hyphens.")
  return value
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export async function checked(runner: Runner, argv: string[], stdin?: string): Promise<string> {
  let result: Result
  try { result = await runner(argv, stdin) }
  catch { throw new Error("Client operation could not run; subprocess details withheld.") }
  if (result.exitCode !== 0) throw new Error(`Client operation failed (exit ${result.exitCode}); subprocess output withheld.`)
  return result.stdout
}

export function exec(runner: Runner, name: string, argv: string[], stdin?: string): Promise<string> {
  return checked(runner, ["asd", "exec", sandboxName(name), ...(stdin === undefined ? [] : ["--stdin"]), "--", ...argv], stdin)
}

export function json(text: string): unknown {
  try { return JSON.parse(text) } catch { throw new Error("Invalid client response; contents withheld.") }
}
