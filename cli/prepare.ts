import { randomUUID } from "node:crypto"
import { DEFAULT_SPEC, type Config } from "../core/state"
import { AsideeError, type Engine, type RunResult, type Runner, type Template } from "../core/types"

// `asd template prepare`: a template for coding agents, made only from what any client may do (create, exec, snapshot,
// remove), so it holds whatever checks a create holds. The tools come from the image's own package sources and npm.
export const AGENT_APT = ["tmux", "fd-find", "zip", "htop", "vim", "nano"]
export const AGENT_NPM = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" } as const
export type Agent = keyof typeof AGENT_NPM
const VERSION = /^(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/

export type PrepareOptions = { name: string; engine?: string; versions: Record<Agent, string>; script?: string; replace: boolean }
export type Prepared = { template: Template; versions: Record<Agent, string>; tools: string[] }
export type Call = <T>(method: string, body?: object, watch?: string) => Promise<T>

export function validVersion(agent: Agent, value: string): string {
  if (!VERSION.test(value)) throw new AsideeError("usage", `--${agent} takes a version such as 2.1.0, or latest.`)
  return value
}

// The version this machine runs, so a login and setup copied from here meet the same program inside; latest when the
// program is not here or prints no version.
export async function hostVersion(run: Runner, agent: Agent): Promise<string> {
  const result = await run([agent, "--version"], { timeoutMs: 15_000, maxOutputBytes: 4096 })
  return result.exitCode === 0 ? /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/.exec(result.stdout)?.[1] ?? "latest" : "latest"
}

// Each step is one command inside the sandbox, run as root or as the image's user.
export function prepareSteps(options: PrepareOptions): Array<{ label: string; user?: string; argv: string[]; stdin?: string }> {
  return [
    { label: `Installing ${AGENT_APT.join(", ")}`, user: "root", argv: ["sh", "-c",
      `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends "$@" >/dev/null && { [ -e /usr/local/bin/fd ] || ln -s "$(command -v fdfind)" /usr/local/bin/fd; } && apt-get clean && rm -rf /var/lib/apt/lists/*`, "apt", ...AGENT_APT] },
    { label: `Installing Claude Code ${options.versions.claude} and Codex ${options.versions.codex}`, argv: ["sh", "-c",
      `npm install --global --no-fund --no-audit "$1" "$2" >/dev/null && npm cache clean --force 2>/dev/null`, "npm", `${AGENT_NPM.claude}@${options.versions.claude}`, `${AGENT_NPM.codex}@${options.versions.codex}`] },
    ...(options.script === undefined ? [] : [{ label: "Running your script", argv: ["bash", "-s"], stdin: options.script }]),
    { label: "Checking the tools", argv: ["sh", "-c", `claude --version && codex --version && tmux -V && fd --version && gh --version | head -1 && git --version && node --version`] },
  ]
}

export async function prepareTemplate(call: Call, options: PrepareOptions, progress: (line: string) => void): Promise<Prepared> {
  // The engine is chosen here, as create would choose it, so only that engine's template of this name is replaced.
  const engine = options.engine ?? (await call<Config>("configGet")).engine ?? (await call<Engine[]>("engines")).find((entry) => entry.ready)?.id
  if (!engine) throw new AsideeError("dependency", "No engine is ready for sandboxes. Run `asd doctor` to see what each one needs.")
  const existing = (await call<Template[]>("templateList")).filter((template) => template.name === options.name && template.engine === engine)
  if (existing.length && !options.replace) throw new AsideeError("conflict", `A template named ${options.name} exists. Add --replace to make it again (sandboxes made from the old one keep working), or choose another name.`)
  const name = `template-prep-${randomUUID().slice(0, 6)}`
  progress(`Creating the sandbox ${name} from the default image…`)
  // The built-in image, never the default template, which may be the one being made.
  await call("create", { name, image: DEFAULT_SPEC.image, engine }, name)
  try {
    let checked: RunResult | undefined
    for (const step of prepareSteps(options)) {
      progress(`${step.label}…`)
      const result = await call<RunResult>("exec", { name, argv: step.argv, ...(step.user ? { user: step.user } : {}), ...(step.stdin !== undefined ? { stdinBase64: Buffer.from(step.stdin).toString("base64") } : {}) })
      if (result.exitCode !== 0) throw new AsideeError("runtime", `${step.label} failed with exit ${result.exitCode}. Nothing was saved.\n${`${result.stderr}${result.stdout}`.trim().split("\n").slice(-15).join("\n")}`)
      checked = result
    }
    for (const template of existing) {
      progress(`Removing the old template ${template.name}; if saving the new one fails, run asd template prepare again…`)
      await call("templateRemove", { name: template.name, engine: template.engine })
    }
    progress(`Saving it as template ${options.name}…`)
    const saved = await call<{ template: Template }>("snapshot", { name, as: options.name }, name)
    return { template: saved.template, versions: options.versions, tools: checked!.stdout.trim().split("\n") }
  } finally {
    progress(`Removing the sandbox ${name}…`)
    await call("remove", { name, confirm: name }).catch((error) => progress(`Could not remove ${name}: ${error instanceof Error ? error.message : String(error)}. Remove it with asd remove ${name} --confirm ${name}.`))
  }
}
