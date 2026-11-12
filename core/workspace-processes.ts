import { cc, dlopen, ptr } from "bun:ffi"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import { PaddockError } from "./types"
import wrapper from "./workspace-check.c" with { type: "file" }

export function requireMac(platform = process.platform): void {
  if (platform !== "darwin") throw new PaddockError("dependency", "Workspaces are available only on macOS. A workspace is not a sandbox.")
}

function library() {
  requireMac()
  const check = cc({ source: wrapper, symbols: { paddock_sandbox_check: { args: ["i32", "ptr", "i32", "ptr"], returns: "i32" } } })
  const proc = dlopen("/usr/lib/libSystem.B.dylib", {
    proc_listallpids: { args: ["ptr", "i32"], returns: "i32" },
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  })
  return { check, proc }
}
type Library = ReturnType<typeof library>
let loaded: Library | undefined
const lib = () => loaded ??= library()
const cstr = (value: string) => Buffer.from(`${value}\0`)

export function decision(pid: number, operation: string | null, filter = 0, argument = ""): number {
  const op = operation === null ? null : cstr(operation); const arg = cstr(argument)
  return lib().check.symbols.paddock_sandbox_check(pid, op ? ptr(op) : null, filter | (operation === null ? 0 : 0x40000000), ptr(arg))
}

function paths(folder: string): void {
  if (!lstatSync(folder).isDirectory() || !lstatSync(join(folder, ".paddock-tag")).isFile())
    throw new PaddockError("check-failed", "The workspace folder and regular tag must exist before its processes can be identified.")
}

export function belongs(pid: number, folder: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false
  // proc_bsdshortinfo from the macOS SDK: 64 bytes, current uid at offset 36.
  const info = new Uint8Array(64)
  if (lib().proc.symbols.proc_pidinfo(pid, 13, 0, ptr(info), info.byteLength) !== info.byteLength || new DataView(info.buffer).getUint32(36, true) !== process.getuid?.()) return false
  return decision(pid, null) === 1 && decision(pid, "file-read-data", 1, folder) === 0
    && decision(pid, "file-write-create", 1, folder) === 0 && decision(pid, "file-read-data", 1, join(folder, ".paddock-tag")) === 1
}

export function workspacePids(folder: string): number[] {
  paths(folder)
  for (let attempt = 0; attempt < 4; attempt++) {
    const count = lib().proc.symbols.proc_listallpids(null, 0)
    if (count <= 0) throw new PaddockError("runtime", "macOS could not enumerate processes; nothing was signalled.")
    const pids = new Int32Array(count + 512 * (attempt + 1))
    const found = lib().proc.symbols.proc_listallpids(ptr(pids), pids.byteLength)
    if (found <= 0) throw new PaddockError("runtime", "macOS returned no process inventory; nothing was signalled.")
    if (found >= pids.length) continue
    return [...pids.subarray(0, found)].filter((pid) => belongs(pid, folder))
  }
  throw new PaddockError("runtime", "The process inventory kept growing; no complete count is available.")
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
  throw new PaddockError("check-failed", "Workspace processes remain after 100 stop rounds. Its folder and manifest were retained.")
}
