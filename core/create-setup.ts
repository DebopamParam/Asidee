import { profileName } from "./credentials"
import { BUNDLED_RUN } from "./extensions"
import { AsideeError, type CreateSetup } from "./types"

// `asd create NAME --gh --claude P… --codex P… --repo OWNER/REPO --copy DIR[:DEST]… --t3 --t3-browser`: after the create, the bundled extensions' own
// commands, in the order each needs the one before (a private clone needs GitHub; T3 finds the logins). The client runs
// them and reports each to the daemon, which records them with the sandbox (Manifest.unfinished), so a failed one can
// be retried from where it stopped. A step is known by its label.
export type { CreateSetup }
export type SetupStep = { label: string; argv: string[] }
export type StepResult = { label: string; exitCode: number; output: string }
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/

const SETUP_FLAGS = { gh: "boolean", claude: "list", codex: "list", repo: "string", copy: "list", t3: "boolean", "t3-browser": "boolean" } as const

// A setup as a client sends it, checked as the CLI's flags are. Undefined when it asks for nothing.
export function validSetup(name: string, value: unknown): CreateSetup | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object" || Array.isArray(value)) throw new AsideeError("usage", "setup must be an object of the create's setup flags.")
  const setup: Record<string, unknown> = {}
  for (const [key, given] of Object.entries(value)) {
    const kind = SETUP_FLAGS[key as keyof typeof SETUP_FLAGS]
    if (!kind) throw new AsideeError("usage", `setup takes ${Object.keys(SETUP_FLAGS).join(", ")}; not ${key}.`)
    if (given === undefined || given === null || given === false) continue
    const fits = kind === "boolean" ? given === true : kind === "string" ? typeof given === "string" : Array.isArray(given) && given.every((entry) => typeof entry === "string")
    if (!fits) throw new AsideeError("usage", `setup.${key} must be ${kind === "boolean" ? "true" : kind === "string" ? "a string" : key === "copy" ? "a list of folders" : "a list of profile names"}.`)
    if (kind !== "list" || (given as string[]).length) setup[key] = given
  }
  return createSteps(name, setup).length ? setup as CreateSetup : undefined
}

// The steps a setup still has to run, after those done.
export const remainingSteps = (name: string, setup: CreateSetup | undefined, done: readonly string[]) => setup ? createSteps(name, setup).filter((step) => !done.includes(step.label)) : []

// --copy DIR[:DEST]: a folder of this Mac and, after the first : followed by ~ or /, where it goes in the sandbox.
export function copyFlag(value: string): { source: string; dest?: string } {
  const at = value.search(/:[~/]/)
  const source = at < 0 ? value : value.slice(0, at), dest = at < 0 ? undefined : value.slice(at + 1)
  if (!source.trim() || /[\0\r\n]/.test(value)) throw new AsideeError("usage", "--copy takes a folder of this Mac, as DIR or DIR:DEST.")
  return { source, ...(dest ? { dest } : {}) }
}

export function createSteps(name: string, options: CreateSetup): SetupStep[] {
  const profile = (agent: string, value: string) => { try { return profileName(value) } catch { throw new AsideeError("usage", `--${agent} takes a login profile name, as \`asd ext run logins profiles\` lists them.`) } }
  if (options.repo !== undefined && (!REPOSITORY.test(options.repo) || options.repo.endsWith(".git"))) throw new AsideeError("usage", "--repo takes a GitHub OWNER/REPO.")
  const steps: SetupStep[] = []
  if (options.gh) steps.push({ label: "GitHub login", argv: ["logins", "github", name, "--gh"] })
  for (const agent of ["claude", "codex"] as const) {
    // Each profile is its own guest login, so several of one agent sit side by side. A repeat is imported once.
    for (const value of new Set(options[agent] ?? [])) steps.push({ label: `${agent === "claude" ? "Claude" : "Codex"} login ${value}`, argv: ["logins", "import", name, agent, "--profile", profile(agent, value), "--setup"] })
  }
  if (options.repo !== undefined) steps.push({ label: `Clone ${options.repo}`, argv: ["repo", "clone", name, options.repo] })
  // After the clone, which needs an empty ~/workspace. Each in the order given; a repeat is copied once.
  for (const value of new Set(options.copy ?? [])) {
    const { source, dest } = copyFlag(value)
    steps.push({ label: `Copy ${source}${dest ? ` to ${dest}` : ""}`, argv: ["folders", "copy", name, "--source", source, ...(dest ? ["--dest", dest] : [])] })
  }
  // The browser goes into T3's runtime, so it sets T3 up first.
  if (options.t3 || options["t3-browser"]) steps.push({ label: "T3 Code", argv: ["t3", "setup", name] })
  if (options["t3-browser"]) steps.push({ label: "T3's browser", argv: ["t3", "browser", name] })
  return steps
}

// Each step runs as `asd extension-run …` from this binary, and report hears each result before the next starts. The
// first failure stops the rest; the sandbox is kept for a retry.
export async function runCreateSteps(self: string[], env: Record<string, string | undefined>, steps: SetupStep[], progress: (line: string) => void, report: (result: StepResult) => Promise<unknown> = async () => {}): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const step of steps) {
    progress(`${step.label}…`)
    const child = Bun.spawn([...self, BUNDLED_RUN, ...step.argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    results.push({ label: step.label, exitCode, output: `${stdout}${stderr}`.trim() })
    await report(results.at(-1)!)
    if (exitCode !== 0) break
  }
  return results
}
