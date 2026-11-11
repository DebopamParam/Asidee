#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { checked, exec, json, object, run, sandboxName, type Runner } from "./client"
import { inspectBundle } from "./bundle"

// The inflated limits in bundle.ts allow about 128 MiB of pack; the transfer cap matches them.
export const MAX_BUNDLE_BYTES = 128 * 1024 * 1024
const HEADER_BYTES = 4096
export type Streamer = (argv: string[], stdin: string, limit: number) => Promise<{ exitCode: number; stdout: Buffer }>
// Binary-safe and bounded. Stderr is dropped because guest diagnostics can contain credentials.
export const stream: Streamer = async (argv, stdin, limit) => {
  const child = Bun.spawn(argv, { stdin: new Blob([stdin]), stdout: "pipe", stderr: "ignore" }), reader = child.stdout.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break
      if ((size += next.value.length) > limit) throw new Error("Export exceeded its size limit; contents withheld.")
      chunks.push(next.value)
    }
  } catch (error) { child.kill(); throw error } finally { await reader.cancel().catch(() => {}) }
  return { exitCode: await child.exited, stdout: Buffer.concat(chunks) }
}
export function repository(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value) || value.endsWith(".git")) throw new Error("Give OWNER/REPO, without a URL, credentials or .git suffix.")
  return value
}
function workspace(value: string): string {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error("Give a guest workspace path.")
  return value
}
const source = () => Bun.file(join(import.meta.dir, "guest.cjs")).text()
async function guest(runner: Runner, name: string, input: { action: "clone"; repository: string; workspace: string }): Promise<unknown> {
  return json(await exec(runner, name, ["node", "-e", await source()], JSON.stringify(input)))
}
export async function clone(runner: Runner, name: string, repo: string, work: string): Promise<void> {
  const result = await guest(runner, name, { action: "clone", repository: repository(repo), workspace: workspace(work) })
  if (!object(result) || result.cloned !== true) throw new Error("Invalid clone response; contents withheld.")
}
type Bundle = { branch: string; tip: string; ref: string; data: Buffer }
// The guest's save output: one JSON header line, then exactly `size` raw bundle bytes.
export function parseBundle(output: Buffer): Bundle {
  const end = output.subarray(0, HEADER_BYTES).indexOf(10)
  let value: unknown
  try { value = JSON.parse(output.subarray(0, end).toString("utf8")) } catch { value = undefined }
  if (end < 0 || !object(value) || typeof value.branch !== "string" || /[\0\r\n]/.test(value.branch) || typeof value.tip !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.tip) || typeof value.ref !== "string" || !/^refs\/paddock-export\/[a-f0-9-]{36}$/.test(value.ref) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_BUNDLE_BYTES) throw new Error("Invalid or oversized export; needs a bundle no larger than 128 MiB. Contents withheld.")
  const data = output.subarray(end + 1)
  if (data.length !== value.size || createHash("sha256").update(data).digest("hex") !== value.sha256) throw new Error("Export checksum or size mismatch; contents withheld.")
  return { branch: value.branch, tip: value.tip, ref: value.ref, data }
}
async function safeTarget(target: string): Promise<void> {
  const absolute = resolve(target), parts: string[] = []
  let parent = absolute
  while (parent !== resolve(parent, "..")) { parts.push(parent); parent = resolve(parent, "..") }
  for (const part of parts.reverse()) {
    const info = await lstat(part).catch((error: unknown) => { if (object(error) && error.code === "ENOENT") return; throw new Error("Cannot inspect export target; details withheld.") })
    if (info && !info.isDirectory()) throw new Error("Export target and its parents must be regular directories.")
  }
}
export async function save(runner: Runner, options: { name: string; workspace: string; target: string; branch?: string }, streamer: Streamer = stream): Promise<{ branch: string; commit: string; target: string }> {
  sandboxName(options.name); workspace(options.workspace)
  if (!isAbsolute(options.target) || /[\0\r\n]/.test(options.target)) throw new Error("Give an absolute host export target.")
  if (options.branch !== undefined && (!options.branch || /[\0\r\n]/.test(options.branch))) throw new Error("Invalid source branch.")
  let output
  try { output = await streamer(["paddock", "exec", sandboxName(options.name), "--stream", "--", "node", "-e", await source()], JSON.stringify({ action: "save", workspace: options.workspace, branch: options.branch }), HEADER_BYTES + MAX_BUNDLE_BYTES) }
  catch { throw new Error("Client operation could not run or the export exceeded 128 MiB; subprocess details withheld.") }
  if (output.exitCode !== 0) throw new Error(`Client operation failed (exit ${output.exitCode}); subprocess output withheld.`)
  const bundle = parseBundle(output.stdout)
  const inspected = inspectBundle(bundle.data, bundle.tip, bundle.ref)
  const git = (args: string[]) => checked(runner, ["git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", "-c", "fetch.recurseSubmodules=false", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-c", "pack.threads=1", ...args])
  await git(["check-ref-format", "refs/heads/" + bundle.branch])
  const temporary = await mkdtemp(join(await realpath(tmpdir()), "paddock-save-")), file = join(temporary, "history.bundle")
  const targetBranch = "saved/" + options.name + "/" + randomUUID()
  try {
    await writeFile(file, bundle.data, { mode: 0o600, flag: "wx" })
    const quarantine = join(temporary, "verify.git"), pack = join(temporary, "history.pack")
    await writeFile(pack, inspected.pack, { mode: 0o600, flag: "wx" })
    await git(["init", "--bare", "--template=", "--object-format=" + inspected.format, "--", quarantine])
    await git(["-C", quarantine, "index-pack", "--strict", pack])
    await safeTarget(options.target)
    if (!await lstat(options.target).catch(() => undefined)) {
      await mkdir(options.target, { recursive: true, mode: 0o700 })
      await git(["init", "--bare", "--template=", "--object-format=" + inspected.format, "--", options.target])
    }
    // Explicit destinations may be existing user clones. Fetch writes a new branch, never a worktree or existing branch.
    const bare = (await git(["-C", options.target, "rev-parse", "--is-bare-repository"])).trim()
    const root = (await git(["-C", options.target, "rev-parse", bare === "true" ? "--absolute-git-dir" : "--show-toplevel"])).trim()
    if (await realpath(root) !== await realpath(options.target)) throw new Error("Export target must be a repository root, not a subfolder of another repository.")
    await git(["-C", options.target, "bundle", "verify", file])
    const heads = (await git(["bundle", "list-heads", file])).trim().split("\n")
    if (heads.length !== 1 || heads[0] !== bundle.tip + " " + bundle.ref) throw new Error("Bundle advertised unexpected history; contents withheld.")
    await git(["-C", options.target, "-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-write-fetch-head", file, bundle.ref + ":refs/heads/" + targetBranch])
    const commit = (await git(["-C", options.target, "rev-parse", "--verify", "refs/heads/" + targetBranch + "^{commit}"])).trim()
    if (commit !== bundle.tip) throw new Error("Export tip mismatch. The saved branch is retained for inspection.")
    return { branch: targetBranch, commit, target: options.target }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
export async function main(argv: string[], env = process.env): Promise<void> {
  let parsed
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: { workspace: { type: "string" }, target: { type: "string" }, branch: { type: "string" }, help: { type: "boolean" } } }) }
  catch { throw new Error("Invalid repository arguments; do not pass credentials in arguments.") }
  const { values, positionals } = parsed, [action, direct, repo] = positionals
  if (!action || values.help) { console.log("repo.ts clone NAME OWNER/REPO [--workspace workspace]\nrepo.ts save NAME [--workspace workspace] [--target /host/bare.git] [--branch BRANCH]\nSave transfers one committed branch, at most 128 MiB as a checksummed binary bundle. Tokens belong only in the logins extension."); return }
  if (positionals.length > (action === "clone" ? 3 : 2)) throw new Error("Unexpected repository arguments.")
  const name = sandboxName(direct ?? env.PADDOCK_SANDBOX ?? ""), work = values.workspace ?? env.PADDOCK_FIELD_WORKSPACE ?? "workspace"
  if (action === "clone") { await clone(run, name, repo ?? env.PADDOCK_FIELD_REPOSITORY ?? "", work); console.log("Cloned repository inside the sandbox.") }
  else if (action === "save") {
    const target = values.target ?? env.PADDOCK_FIELD_TARGET ?? join(env.XDG_STATE_HOME || join(homedir(), ".local/state"), "paddock-repo", name + ".git")
    console.log(JSON.stringify(await save(run, { name, workspace: work, target, branch: (values.branch ?? env.PADDOCK_FIELD_BRANCH) || undefined })))
  } else throw new Error("Use clone or save.")
}
if (import.meta.main) main(process.argv.slice(2)).catch(() => { console.error("Repository operation failed. Clone needs a new guest path; save needs a committed branch, host Git and an export of at most 128 MiB. Subprocess output withheld."); process.exitCode = 1 })
