import { execute, object, profileName, type Agent, type Runner } from "./client"
import { githubToken, hostGithubToken, readCredential, type Host } from "./credentials"
import { GUEST } from "./guest"
import { claudeState, collectSetup, settingsCommands, type Setup } from "./setup"

export type Login = { agent: Agent | "github"; profile: string; account?: string }
export type Imported = { agent: Agent; profile: string; files: number; missingCommands: number; missingCommandNames: string[] }

function diagnosticNames(setup: Setup | undefined, credential: string): string[] {
  const settings = setup?.files.find((file) => file.path === "settings.json")
  if (!settings || !setup) return []
  const privateValues: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === "string" && value.length) privateValues.push(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (object(value)) Object.values(value).forEach(collect)
  }
  collect(JSON.parse(credential))
  const names = settingsCommands(JSON.parse(Buffer.from(settings.data, "base64").toString("utf8")))
    .flatMap((command) => command.split(/(?:&&|\|\||[;|\n])/).flatMap((part) => {
      const tokens = (part.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((token) => token.replace(/^(["'])(.*)\1$/, "$2"))
      while (tokens[0] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) tokens.shift()
      return [tokens[0], ...(/^(?:bash|sh|zsh|node|python3?|bun)$/.test(tokens[0]?.split("/").at(-1) ?? "") && tokens[1]?.includes("/") ? [tokens[1]] : [])]
    }))
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.replace(/^(?:\$HOME|\$\{HOME\})(?=\/)/, "~").split(setup.hostHome + "/").join("~/"))
    .filter((name) => /^[\x20-\x7e]{1,160}$/.test(name) && !name.includes("$") && !privateValues.some((value) => name.includes(value)))
  return [...new Set(names)].slice(0, 64)
}

export async function importLogin(host: Host, options: { name: string; agent: Agent; profile: string; target?: string; replace: boolean; setup: boolean }): Promise<Imported> {
  const target = profileName(options.target ?? options.profile)
  const credential = await readCredential(options.agent, options.profile, host)
  const setup = options.setup ? await collectSetup(options.agent, options.profile, host.home) : undefined
  const state = options.agent === "claude" ? (setup?.state ?? await claudeState(options.profile, host.home)) : undefined
  const names = options.agent === "claude" ? diagnosticNames(setup, credential) : []
  const result = await execute(host.runner, options.name, GUEST, ["import", options.agent, target, options.replace ? "replace" : "create"], JSON.stringify({ credential, setup, account: state?.oauthAccount, commandNames: names }))
  if (!object(result) || typeof result.files !== "number" || !Number.isSafeInteger(result.files) || result.files < 0 || result.files > 2000 || typeof result.missingCommands !== "number" || !Number.isSafeInteger(result.missingCommands) || result.missingCommands < 0 || result.missingCommands > 1_000_000 || (result.missingCommands > 0 && !(setup?.files.some((file) => file.path === "settings.json") && options.agent === "claude"))) throw new Error("Invalid import response; contents withheld.")
  if (!Array.isArray(result.missingCommandNames) || result.missingCommandNames.length > 64 || result.missingCommandNames.length > result.missingCommands || !result.missingCommandNames.every((name: unknown) => typeof name === "string" && /^[\x20-\x7e]{1,160}$/.test(name) && names.includes(name))) throw new Error("Invalid import response; contents withheld.")
  return { agent: options.agent, profile: target, files: result.files, missingCommands: result.missingCommands, missingCommandNames: result.missingCommandNames }
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
  if (typeof value.account === "string" && !(value.agent === "github" ? /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.account) : (value.agent === "codex" && value.account === "API key") || (value.account.length <= 254 && /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/.test(value.account)))) throw new Error("Invalid account label; contents withheld.")
  return { agent: value.agent, profile: value.profile, ...(typeof value.account === "string" ? { account: value.account } : {}) }
}

export async function listLogins(runner: Runner, name: string): Promise<Login[]> {
  const result = await execute(runner, name, GUEST, ["list"])
  if (!Array.isArray(result) || result.length > 2000) throw new Error("Invalid login listing; contents withheld.")
  return result.map(login)
}

export async function logout(runner: Runner, name: string, which: { agent: Login["agent"]; profile: string } | "all"): Promise<Array<Login & { removed: boolean; stopped: number }>> {
  if (which !== "all" && which.profile !== "~") profileName(which.profile)
  const result = await execute(runner, name, GUEST, ["logout", ...(which === "all" ? ["all"] : [which.agent, which.profile])])
  if (!Array.isArray(result) || result.length > 2000) throw new Error("Invalid logout response; contents withheld.")
  return result.map((value: unknown) => {
    const selected = login(value)
    if (!object(value) || typeof value.removed !== "boolean" || typeof value.stopped !== "number" || !Number.isSafeInteger(value.stopped) || value.stopped < 0 || value.stopped > 1_000_000) throw new Error("Invalid logout response; contents withheld.")
    return { ...selected, removed: value.removed, stopped: value.stopped }
  })
}
