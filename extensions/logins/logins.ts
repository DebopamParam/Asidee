import { execute, object, profileName, type Agent, type Runner } from "./client"
import { githubToken, hostGithubToken, readCredential, type Host } from "./credentials"
import { GUEST } from "./guest"
import { claudeState, collectSetup } from "./setup"

export type Login = { agent: Agent | "github"; profile: string; account?: string }
export type Imported = { agent: Agent; profile: string; files: number; missingCommands: string[] }

export async function importLogin(host: Host, options: { name: string; agent: Agent; profile: string; target?: string; replace: boolean; setup: boolean }): Promise<Imported> {
  const target = profileName(options.target ?? options.profile)
  const credential = await readCredential(options.agent, options.profile, host)
  const setup = options.setup ? await collectSetup(options.agent, options.profile, host.home) : undefined
  const state = options.agent === "claude" ? (setup?.state ?? await claudeState(options.profile, host.home)) : undefined
  const result = await execute(host.runner, options.name, GUEST, ["import", options.agent, target, options.replace ? "replace" : "create"], JSON.stringify({ credential, setup, account: state?.oauthAccount }))
  if (!object(result) || !Number.isInteger(result.files) || typeof result.files !== "number" || !Array.isArray(result.missingCommands) || !result.missingCommands.every((command): command is string => typeof command === "string")) throw new Error("Invalid import response; contents withheld.")
  return { agent: options.agent, profile: target, files: result.files, missingCommands: result.missingCommands }
}

export type GithubSource = { kind: "token"; value: string } | { kind: "host"; account?: string }
export async function importGithub(runner: Runner, name: string, source: GithubSource, replace: boolean): Promise<Login> {
  const token = source.kind === "host" ? await hostGithubToken(runner, source.account) : githubToken(source.value)
  const result = await execute(runner, name, GUEST, ["github", "github", "~", replace ? "replace" : "create"], JSON.stringify({ token }))
  if (!object(result) || typeof result.account !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(result.account)) throw new Error("Invalid GitHub import response; contents withheld.")
  return { agent: "github", profile: "~", account: result.account }
}

function login(value: unknown): Login {
  if (!object(value) || !(value.agent === "claude" || value.agent === "codex" || value.agent === "github") || typeof value.profile !== "string" || (value.profile !== "~" && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value.profile)) || (value.account !== undefined && typeof value.account !== "string")) throw new Error("Invalid login listing; contents withheld.")
  return { agent: value.agent, profile: value.profile, ...(typeof value.account === "string" ? { account: value.account } : {}) }
}

export async function listLogins(runner: Runner, name: string): Promise<Login[]> {
  const result = await execute(runner, name, GUEST, ["list"])
  if (!Array.isArray(result)) throw new Error("Invalid login listing; contents withheld.")
  return result.map(login)
}

export async function logout(runner: Runner, name: string, which: { agent: Login["agent"]; profile: string } | "all"): Promise<Array<Login & { removed: boolean; stopped: number }>> {
  if (which !== "all" && which.profile !== "~") profileName(which.profile)
  const result = await execute(runner, name, GUEST, ["logout", ...(which === "all" ? ["all"] : [which.agent, which.profile])])
  if (!Array.isArray(result)) throw new Error("Invalid logout response; contents withheld.")
  return result.map((value: unknown) => {
    const selected = login(value)
    if (!object(value) || typeof value.removed !== "boolean" || typeof value.stopped !== "number") throw new Error("Invalid logout response; contents withheld.")
    return { ...selected, removed: value.removed, stopped: value.stopped }
  })
}
