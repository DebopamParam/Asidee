import { cc, dlopen, ptr } from "bun:ffi"
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AsideeError } from "./types"
import wrapper from "./workspace-check.c" with { type: "text" }

export function requireMac(platform = process.platform): void {
  if (platform !== "darwin") throw new AsideeError("dependency", "Workspaces are available only on macOS. A workspace is not a sandbox.")
}

function library() {
  requireMac()
  // TinyCC opens an OS file, so Bun's embedded /$bunfs paths cannot be passed directly.
  const temporary = mkdtempSync("/private/tmp/asidee-ffi-")
  const source = join(temporary, "check.c")
  const check = (() => {
    try {
      writeFileSync(source, wrapper, { mode: 0o600 })
      return cc({ source, symbols: { asidee_sandbox_check: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" } } })
    } finally { rmSync(temporary, { recursive: true, force: true }) }
  })()
  const proc = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_pidpath: { args: ["i32", "ptr", "u32"], returns: "i32" },
    proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  })
  return { check, proc }
}
type Library = ReturnType<typeof library>
let loaded: Library | undefined
const lib = () => loaded ??= library()
const cstr = (value: string) => Buffer.from(`${value}\0`)

const liveInputs = new Set<{ operation: Buffer | null; argument: Buffer }>()

export function decision(pid: number, operation: string | null, filter = 0, argument = ""): number {
  const input = { operation: operation === null ? null : cstr(operation), argument: cstr(argument) }
  // The FFI sees raw pointers; keep their buffers reachable while native code runs.
  liveInputs.add(input)
  try { return lib().check.symbols.asidee_sandbox_check(pid, input.operation ? ptr(input.operation) : null, filter | (operation === null ? 0 : 0x40000000), ptr(input.argument)) }
  finally { liveInputs.delete(input) }
}

export function controlledDecision(pid: number, control: number, operation: string, filter = 0, argument = ""): "allowed" | "denied" | "unknown" {
  if (decision(pid, null) !== 1 || decision(control, null) !== 1 || decision(control, operation, filter, argument) !== 0) return "unknown"
  const answer = decision(pid, operation, filter, argument)
  return answer === 0 ? "allowed" : answer === 1 ? "denied" : "unknown"
}

function paths(folder: string): void {
  if (!lstatSync(folder).isDirectory() || !lstatSync(join(folder, ".asidee-tag")).isFile())
    throw new AsideeError("check-failed", "The workspace folder and regular tag must exist before its processes can be identified.")
}

export function belongs(pid: number, folder: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
  // proc_bsdshortinfo from the macOS SDK: 64 bytes, current uid at offset 36.
  const info = new Uint8Array(64)
  if (lib().proc.symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength || new DataView(info.buffer).getUint32(36, true) !== process.getuid?.()) return false
  return decision(pid, null) === 1 && decision(pid, "file-read-data", 1, folder) === 0
    && decision(pid, "file-write-create", 1, folder) === 0 && decision(pid, "file-read-data", 1, join(folder, ".asidee-tag")) === 1
}

// The facts belongs() weighs, in words, for a refusal that has to say why a pid did not qualify.
export function profileEvidence(pid: number, folder: string): string {
  const info = new Uint8Array(64)
  if (!Number.isSafeInteger(pid) || pid <= 1 || lib().proc.symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength) return `pid ${pid} not found`
  const executable = Buffer.alloc(4096)
  const length = lib().proc.symbols.proc_pidpath(pid, ptr(executable), executable.byteLength)
  const path = length > 0 ? JSON.stringify(executable.subarray(0, length).toString().replace(/\0.*$/, "")) : "unknown"
  const parent = new DataView(info.buffer).getUint32(4, true)
  const answer = (value: number) => value === 0 ? "allowed" : value === 1 ? "denied" : `unknown (${value})`
  return `pid ${pid} executable ${path}; parent ${parent}; uid ${new DataView(info.buffer).getUint32(36, true)} (Asidee's ${process.getuid?.()}); sandboxed ${decision(pid, null) === 1 ? "yes" : "no"}; `
    + `folder read ${answer(decision(pid, "file-read-data", 1, folder))} and write ${answer(decision(pid, "file-write-create", 1, folder))} (expected allowed); `
    + `tag read ${answer(decision(pid, "file-read-data", 1, join(folder, ".asidee-tag")))} (expected denied)`
}

export function workspacePids(folder: string): number[] {
  paths(folder)
  for (let attempt = 0; attempt < 4; attempt++) {
    const count = lib().proc.symbols.proc_listallpids(null, 0)
    if (count <= 0) throw new AsideeError("runtime", "macOS could not enumerate processes; nothing was signalled.")
    const pids = new Int32Array(count + 512 * (attempt + 1))
    const found = lib().proc.symbols.proc_listallpids(ptr(pids), pids.byteLength)
    if (found <= 0) throw new AsideeError("runtime", "macOS returned no process inventory; nothing was signalled.")
    if (found >= pids.length) continue
    return [...pids.subarray(0, found)].filter((pid) => belongs(pid, folder))
  }
  throw new AsideeError("runtime", "The process inventory kept growing; no complete count is available.")
}

export function signalWorkspacePid(pid: number, folder: string, signal: "SIGSTOP" | "SIGKILL"): boolean {
  paths(folder)
  // No await between the full profile re-check and kill. Never trust a previously listed pid.
  if (!belongs(pid, folder)) return false
  try { process.kill(pid, signal); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

export async function stopWorkspaceProcesses(folder: string): Promise<void> {
  for (let round = 0; round < 100; round++) {
    const pids = workspacePids(folder)
    if (!pids.length) return
    for (const pid of pids) signalWorkspacePid(pid, folder, "SIGSTOP")
    for (const pid of pids) signalWorkspacePid(pid, folder, "SIGKILL")
    await Bun.sleep(25)
  }
  throw new AsideeError("check-failed", "Workspace processes remain after 100 stop rounds. Its folder and manifest were retained.")
}
