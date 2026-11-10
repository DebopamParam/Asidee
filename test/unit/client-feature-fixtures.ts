import { afterEach } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { Result, Runner } from "../../extensions/t3/client"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
export async function fixture(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "paddock-client-unit-")); roots.push(root)
  await mkdir(join(root, ".config"))
  return root
}
export const ok = (stdout = ""): Result => ({ exitCode: 0, stdout, stderr: "" })
export async function put(home: string, relative: string, text: string | Buffer): Promise<void> {
  const file = join(home, relative); await mkdir(dirname(file), { recursive: true }); await writeFile(file, text, { mode: 0o600 })
}
export function local(home: string, extra: Record<string, string> = {}): Runner {
  return async (argv, stdin) => {
    const child = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: {
      ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".local/state"),
      GH_CONFIG_DIR: join(home, ".config/gh"), GH_TOKEN: "", GITHUB_TOKEN: "", T3CODE_HOME: join(home, ".t3"),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Unit Test", GIT_AUTHOR_EMAIL: "unit@example.invalid",
      GIT_COMMITTER_NAME: "Unit Test", GIT_COMMITTER_EMAIL: "unit@example.invalid", ...extra,
    } })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr }
  }
}
export function fakeExec(home: string, extra: Record<string, string> = {}): { calls: Array<{ argv: string[]; stdin?: string }>; runner: Runner } {
  const calls: Array<{ argv: string[]; stdin?: string }> = [], execute = local(home, extra)
  return { calls, runner: async (argv, stdin) => {
    calls.push({ argv, stdin })
    if (argv[0] === "paddock") {
      if (argv[1] !== "exec" || argv[2] !== "demo" || !argv.includes("--")) throw new Error("Fake transport refuses every operation except exec demo.")
      return execute(argv.slice(argv.indexOf("--") + 1), stdin)
    }
    if (argv[0] === "git") return execute(argv, stdin)
    throw new Error("Unexpected host tool in fake transport.")
  } }
}
export async function must(runner: Runner, argv: string[], stdin?: string): Promise<string> {
  const result = await runner(argv, stdin)
  if (result.exitCode !== 0) throw new Error(`Fixture command failed (exit ${result.exitCode}); details withheld.`)
  return result.stdout.trim()
}
