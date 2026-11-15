import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import type { WorkspaceManifest } from "./types"
import base from "./workspace.sb" with { type: "text" }

export const WORKSPACE_DISCLOSURE = "Workspace, not a sandbox. Same Mac kernel and user; no CPU, memory, disk, GPU or process limits. Use workspace shell/exec; entering the folder alone does not confine programs. Internet, LAN, tailnet and loopback are open, including services started later. Reads outside home are open. Outside command lines are visible. Inner sandboxes may fail; Paddock passes no agent flags. Homebrew and nix daemon installs outside the folder are refused. Remote effects, unified logs and backups can survive removal. Apple events, TCC services, camera, microphone, Keychain additions, other IOKit devices, Bluetooth and Spotlight retention are not covered. Hard links placed from outside can share changes. Unnamed daemon channels are not covered."

export const HOST_TEMP_DISCLOSURE = "Shared host temp is open to files by this workspace's host-temp setting. Other programs' temp files there are readable and writable by this workspace, which can also delete their socket files and create listening sockets there that outside programs can connect to. Connecting to Unix sockets there stays refused. Other workspaces with host-temp on share it. Files left there are not removed by workspace remove and are not counted in its size."
export const workspaceDisclosure = (hostTemp: boolean) => hostTemp ? `${WORKSPACE_DISCLOSURE} ${HOST_TEMP_DISCLOSURE}` : WORKSPACE_DISCLOSURE

export const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent === "/" ? "" : parent}/`)

export function workspaceProfile(manifest: Pick<WorkspaceManifest, "folder" | "home" | "userVar" | "reads" | "tag"> & { spec?: Pick<WorkspaceManifest["spec"], "hostTemp"> }): { text: string; params: string[]; hash: string } {
  const params = [`WS=${manifest.folder}`, `HOME_REAL=${manifest.home}`, `USER_VAR=${manifest.userVar}`, `TAGFILE=${manifest.tag}`]
  const lines = [base]
  if (manifest.spec?.hostTemp) {
    params.push(`HOST_TEMP=${join(manifest.userVar, "T")}`)
    lines.push('(allow file-read* file-write* (subpath (param "HOST_TEMP")))')
  }
  manifest.reads.forEach((read, index) => {
    params.push(`READ_${index}=${read.canonical}`)
    lines.push(`(allow file-read* (subpath (param "READ_${index}")))`)
  })
  const ancestors = new Set<string>()
  for (const path of [manifest.folder, ...manifest.reads.map((read) => read.canonical)]) {
    for (let parent = dirname(path); within(parent, manifest.home); parent = dirname(parent)) { ancestors.add(parent); if (parent === "/") break }
  }
  [...ancestors].sort().forEach((path, index) => {
    params.push(`ANC_${index}=${path}`)
    lines.push(`(allow file-read-metadata (literal (param "ANC_${index}")))`)
  })
  // These must follow every read allowance, including broad declarations supplied by a caller.
  lines.push('(deny file-read-data (literal (param "TAGFILE")))', '(deny file-write* (literal (param "TAGFILE")))')
  const text = `${lines.join("\n")}\n`
  return { text, params, hash: createHash("sha256").update(text).digest("hex") }
}

export function workspaceEnvironment(manifest: Pick<WorkspaceManifest, "folder" | "name" | "spec">, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = join(manifest.folder, "home")
  const env: Record<string, string> = {
    HOME: home, TMPDIR: `${manifest.folder}/tmp/`, PADDOCK_WORKSPACE: manifest.name, GIT_CEILING_DIRECTORIES: dirname(manifest.folder),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"),
    NPM_CONFIG_PREFIX: join(home, ".local"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"),
    PATH: [join(home, ".local/bin"), join(home, ".cargo/bin"), join(home, ".bun/bin"), ...manifest.spec.path, "/opt/homebrew/bin", "/opt/homebrew/sbin", "/run/current-system/sw/bin", `/etc/profiles/per-user/${inherited.USER ?? ""}/bin`, "/nix/var/nix/profiles/default/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  }
  for (const key of ["USER", "LOGNAME", "SHELL", "TERM", "LANG"]) if (inherited[key]) env[key] = inherited[key]
  return env
}
