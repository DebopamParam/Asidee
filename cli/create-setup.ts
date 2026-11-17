import { profileName } from "../core/credentials"
import { BUNDLED_RUN } from "../core/extensions"
import { AsideeError } from "../core/types"

// `asd create NAME --gh --claude P --codex P --repo OWNER/REPO --t3`: after the create, the bundled extensions' own
// commands, in the order each needs the one before (a private clone needs GitHub; T3 finds the logins).
export type CreateSetup = { gh?: boolean; claude?: string; codex?: string; repo?: string; t3?: boolean }
export type SetupStep = { label: string; argv: string[] }
export type StepResult = { label: string; exitCode: number; output: string }
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/

export function createSteps(name: string, options: CreateSetup): SetupStep[] {
  const profile = (agent: string, value: string) => { try { return profileName(value) } catch { throw new AsideeError("usage", `--${agent} takes a login profile name, as \`asd ext run logins profiles\` lists them.`) } }
  if (options.repo !== undefined && (!REPOSITORY.test(options.repo) || options.repo.endsWith(".git"))) throw new AsideeError("usage", "--repo takes a GitHub OWNER/REPO.")
  const steps: SetupStep[] = []
  if (options.gh) steps.push({ label: "GitHub login", argv: ["logins", "github", name, "--gh"] })
  for (const agent of ["claude", "codex"] as const) {
    const value = options[agent]
    if (value !== undefined) steps.push({ label: `${agent === "claude" ? "Claude" : "Codex"} login ${value}`, argv: ["logins", "import", name, agent, "--profile", profile(agent, value), "--setup"] })
  }
  if (options.repo !== undefined) steps.push({ label: `Clone ${options.repo}`, argv: ["repo", "clone", name, options.repo] })
  if (options.t3) steps.push({ label: "T3 Code", argv: ["t3", "setup", name] })
  return steps
}

// Each step runs as `asd extension-run …` from this binary. The first failure stops the rest; the sandbox is kept.
export async function runCreateSteps(self: string[], env: Record<string, string | undefined>, steps: SetupStep[], progress: (line: string) => void): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const step of steps) {
    progress(`${step.label}…`)
    const child = Bun.spawn([...self, BUNDLED_RUN, ...step.argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    results.push({ label: step.label, exitCode, output: `${stdout}${stderr}`.trim() })
    if (exitCode !== 0) break
  }
  return results
}
