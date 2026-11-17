import { readdir, readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { AsideeError, type RunResult, type Runner } from "./types"
import type { Dirs } from "./state"

// Extensions are the flexible part: a folder with an extension.json that declares actions (a label, form fields, and a
// command) and hooks. The core never loads their code. It runs their commands as separate processes on this machine,
// which use the `asd` CLI like any other client, so an extension cannot change what a sandbox is or skip a check.
// Each UI draws an action's form from the declaration, so an action is written once.
// An extension's commands do run with the user's own rights on this machine, like any script the user installs.

export type Field = { id: string; label: string; type: "text" | "number" | "checkbox" | "select"; options?: string[]; default?: string | number | boolean; required?: boolean }
export type Action = { id: string; label: string; description?: string; scope: "sandbox" | "global"; fields: Field[]; run: string[] }
export type Extension = { id: string; name: string; description?: string; dir: string; actions: Action[]; hooks: { postCreate?: string[] } }

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/
const isCommand = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string")

export function parseExtension(id: string, dir: string, raw: unknown): Extension {
  const fail = (message: string): never => { throw new AsideeError("usage", `Extension ${id}: ${message}`) }
  if (!ID.test(id)) fail("its folder name must be lowercase letters, digits and hyphens")
  const data = raw as { name?: unknown; description?: unknown; actions?: unknown; hooks?: { postCreate?: unknown } }
  if (typeof data !== "object" || data === null || typeof data.name !== "string") fail("extension.json needs a name")
  const actions = (Array.isArray(data.actions) ? data.actions : []).map((entry: Record<string, unknown>): Action => {
    if (typeof entry.id !== "string" || !ID.test(entry.id)) fail("every action needs an id of lowercase letters, digits and hyphens")
    if (typeof entry.label !== "string") fail(`action ${entry.id} needs a label`)
    if (!isCommand(entry.run)) fail(`action ${entry.id} needs run: a command as a list of strings`)
    const fields = (Array.isArray(entry.fields) ? entry.fields : []).map((field: Record<string, unknown>): Field => {
      if (typeof field.id !== "string" || !/^[a-z][a-z0-9_]{0,30}$/.test(field.id)) fail(`action ${entry.id}: every field needs an id of lowercase letters, digits and underscores`)
      if (!["text", "number", "checkbox", "select"].includes(field.type as string)) fail(`action ${entry.id}: field ${field.id} has an unknown type`)
      if (field.type === "select" && !(Array.isArray(field.options) && field.options.every((option) => typeof option === "string"))) fail(`action ${entry.id}: field ${field.id} needs options`)
      return { id: field.id as string, label: typeof field.label === "string" ? field.label : field.id as string, type: field.type as Field["type"], options: field.options as string[] | undefined, default: field.default as Field["default"], required: field.required === true }
    })
    return { id: entry.id as string, label: entry.label as string, description: typeof entry.description === "string" ? entry.description : undefined, scope: entry.scope === "global" ? "global" : "sandbox", fields, run: entry.run as string[] }
  })
  const postCreate = data.hooks?.postCreate
  if (postCreate !== undefined && !isCommand(postCreate)) fail("hooks.postCreate must be a command as a list of strings")
  return { id, name: data.name as string, description: typeof data.description === "string" ? data.description : undefined, dir, actions, hooks: { postCreate: postCreate as string[] | undefined } }
}

export async function loadExtensions(dirs: Dirs): Promise<{ extensions: Extension[]; errors: string[] }> {
  const root = join(dirs.config, "extensions"); const extensions: Extension[] = []; const errors: string[] = []
  for (const entry of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const dir = join(root, entry.name)
    try { extensions.push(parseExtension(entry.name, dir, JSON.parse(await readFile(join(dir, "extension.json"), "utf8")))) }
    catch (error) { errors.push(error instanceof AsideeError ? error.message : `Extension ${entry.name}: ${(error as Error).message}`) }
  }
  return { extensions, errors }
}

export function fieldValues(action: Action, values: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const field of action.fields) {
    const given = values[field.id] ?? field.default
    if (given === undefined || given === "") {
      if (field.required) throw new AsideeError("usage", `${field.label} is required.`)
      continue
    }
    const text = String(given)
    if (text.includes("\0")) throw new AsideeError("usage", `${field.label} is not valid.`)
    if (field.type === "number" && !Number.isFinite(Number(text))) throw new AsideeError("usage", `${field.label} must be a number.`)
    if (field.type === "checkbox" && text !== "true" && text !== "false") throw new AsideeError("usage", `${field.label} must be true or false.`)
    if (field.type === "select" && !field.options!.includes(text)) throw new AsideeError("usage", `${field.label} must be one of: ${field.options!.join(", ")}.`)
    env[`ASIDEE_FIELD_${field.id.toUpperCase()}`] = text
  }
  return env
}

// cliDir: where the `asd` command lives, put first on PATH so the command can call back into the core.
export function runCommand(run: Runner, extension: Extension, command: string[], env: Record<string, string>, cliDir: string): Promise<RunResult> {
  const [program, ...args] = command
  const resolved = program!.startsWith("./") || (!isAbsolute(program!) && program!.includes("/")) ? join(extension.dir, program!) : program!
  return run([resolved, ...args], { cwd: extension.dir, timeoutMs: 1_800_000, env: { ...env, ASIDEE_EXTENSION_DIR: extension.dir, PATH: `${cliDir}:${process.env.PATH ?? ""}` } })
}
