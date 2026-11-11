import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { Dirs } from "./state"
import { PaddockError, type Manifest, type SshSetup } from "./types"

// SSH for editors. `ssh NAME.paddock` runs a ProxyCommand that opens a session on the daemon's stream socket, and the
// session runs the sandbox's sshd in inetd mode (-i) on that one connection: no port is opened on this machine, the
// engine's host or the sandbox. Everything on this side lives in the state folder; the user's own SSH files are read,
// and changed only by one Include line on request.
export type SshAccess = { alias: string; user: string; home: string; batchReady: boolean; loopbackForwarding: boolean }

// Inside the sandbox. A folder of Paddock's own, so the user's ~/.ssh is neither read nor trusted by this sshd.
export const GUEST_SSH = "/.paddock/ssh"
export const alias = (name: string) => `${name}.paddock`
export const hostKeyAlias = (manifest: Manifest) => `paddock-${manifest.id}`
const files = (dirs: Dirs) => ({ folder: join(dirs.state, "ssh"), key: join(dirs.state, "ssh", "editor_ed25519"), config: join(dirs.state, "ssh", "config"), knownHosts: join(dirs.state, "ssh", "known_hosts") })
// The user's SSH configuration; PADDOCK_SSH_CONFIG names another one, which the evals use so ~/.ssh is never touched.
export const userConfig = (env: Record<string, string | undefined> = process.env) => resolve(env.PADDOCK_SSH_CONFIG ?? join(homedir(), ".ssh", "config"))
export const includeLine = (dirs: Dirs) => `Include ${quote(files(dirs).config)}`

// ssh_config takes double-quoted arguments without escapes, so a path with a double quote or a line break cannot be said.
function quote(path: string): string {
  if (/["\n\r]/.test(path)) throw new PaddockError("usage", `Paddock cannot write an SSH configuration for the path ${JSON.stringify(path)}.`)
  return `"${path}"`
}
// ProxyCommand goes to /bin/sh after ssh expands %-tokens, so each word is single-quoted and each % doubled.
export const shellWord = (word: string) => `'${word.replace(/'/g, `'\\''`).replace(/%/g, "%%")}'`

const run = async (argv: string[]) => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new PaddockError("dependency", `${argv[0]} failed: ${err.trim() || `exit ${code}`}`)
  return out
}

export const validPublicKey = (text: string) => /^ssh-ed25519 [A-Za-z0-9+/]{68}(?:==)?(?: [\x21-\x7e]{0,64})?$/.test(text.trim())

// One key pair for this machine's editors, made here and never copied: only its public half goes into a sandbox.
export async function editorKey(dirs: Dirs): Promise<{ path: string; publicKey: string; fingerprint: string }> {
  const { folder, key } = files(dirs)
  await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o700)
  if (!(await Bun.file(key).exists())) await run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "paddock-editor", "-f", key])
  const publicKey = (await readFile(`${key}.pub`, "utf8")).trim()
  if (!validPublicKey(publicKey)) throw new PaddockError("runtime", `${key}.pub is not an Ed25519 public key. Remove ${key} and its .pub to make a new one.`)
  return { path: key, publicKey, fingerprint: (await run(["ssh-keygen", "-l", "-E", "sha256", "-f", `${key}.pub`])).split(/\s+/)[1] ?? "" }
}

// Run as root inside the sandbox with the login user and the editor's public key as $1 and $2. It installs OpenSSH's
// server from the image's own package manager when there is none, makes a fresh host key whose private half never
// leaves the sandbox, and writes a configuration that accepts only that key and forwards only to the sandbox's loopback.
export const GUEST_SETUP = `set -eu
user=$1; key=$2; dir=${GUEST_SSH}
home=$(awk -F: -v u="$user" '$1 == u { print $6 }' /etc/passwd)
[ -n "$home" ] || { echo "The user $user is not in /etc/passwd." >&2; exit 3; }
sshd=$(command -v sshd || true); [ -n "$sshd" ] || { [ -x /usr/sbin/sshd ] && sshd=/usr/sbin/sshd; } || true
if [ -z "$sshd" ]; then
  if command -v apk >/dev/null; then apk add --no-cache -q openssh-server >&2
  elif command -v apt-get >/dev/null; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >&2 && apt-get install -y -qq --no-install-recommends openssh-server >&2
  elif command -v dnf >/dev/null; then dnf install -y -q openssh-server >&2
  else echo "The image has no sshd and no apk, apt-get or dnf to install one." >&2; exit 4; fi
  sshd=/usr/sbin/sshd
fi
[ -x "$sshd" ] || { echo "OpenSSH's server was not installed." >&2; exit 4; }
mkdir -p /run/sshd /var/empty "$dir"; chmod 755 /.paddock "$dir"
rm -f "$dir/host_ed25519" "$dir/host_ed25519.pub"
ssh-keygen -q -t ed25519 -N "" -C paddock-guest -f "$dir/host_ed25519"
printf '%s\\n' "$key" > "$dir/authorized_keys"; chmod 644 "$dir/authorized_keys"
cat > "$dir/sshd_config" <<EOF
HostKey $dir/host_ed25519
AuthorizedKeysFile $dir/authorized_keys
AllowUsers $user
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
PermitUserEnvironment no
AllowAgentForwarding no
AllowStreamLocalForwarding no
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitListen none
AllowTcpForwarding local
PermitOpen 127.0.0.1:* localhost:*
Subsystem sftp internal-sftp
LogLevel ERROR
EOF
# sshd refuses even a key for an account whose password is locked (a leading !). * still allows no password.
unlocked=no
if [ -w /etc/shadow ] && grep -q "^$user:!" /etc/shadow; then sed -i "s/^$user:![^:]*:/$user:*:/" /etc/shadow; unlocked=yes; fi
"$sshd" -t -f "$dir/sshd_config"
printf '%s\\n%s\\n%s\\n%s\\n' "$unlocked" "$home" "$sshd" "$(cat "$dir/host_ed25519.pub")"
`

export function parseGuestSetup(output: string): { unlocked: boolean; home: string; sshd: string; hostKey: string } {
  const [unlocked, home, sshd, hostKey] = output.trim().split("\n").slice(-4).map((line) => line.trim())
  if (!["yes", "no"].includes(unlocked!) || !home?.startsWith("/") || !sshd?.startsWith("/") || !hostKey || !validPublicKey(hostKey)) throw new PaddockError("runtime", "The sandbox did not report its SSH setup.")
  return { unlocked: unlocked === "yes", home, sshd, hostKey: hostKey.split(" ").slice(0, 2).join(" ") }
}

// This executable, by absolute path: an editor runs the ProxyCommand with its own PATH, or none.
export function selfCommand(): string[] {
  return /^bun(?:\.exe)?$/.test(process.execPath.split("/").at(-1) ?? "") ? [process.execPath, resolve(Bun.main)] : [process.execPath]
}

export function hostBlock(dirs: Dirs, manifest: Manifest, setup: SshSetup, self = selfCommand()): string {
  const { key, knownHosts } = files(dirs)
  const proxy = ["/usr/bin/env", `PADDOCK_STATE_DIR=${resolve(dirs.state)}`, `PADDOCK_CONFIG_DIR=${resolve(dirs.config)}`, ...self, "ssh", "proxy", manifest.name].map(shellWord).join(" ")
  return [`Host ${alias(manifest.name)}`, `  HostName ${alias(manifest.name)}`, `  User ${setup.user}`, `  ProxyCommand ${proxy}`,
    `  HostKeyAlias ${hostKeyAlias(manifest)}`, `  UserKnownHostsFile ${quote(knownHosts)}`, "  GlobalKnownHostsFile /dev/null", "  StrictHostKeyChecking yes",
    "  UpdateHostKeys no", "  CheckHostIP no", `  IdentityFile ${quote(key)}`, "  IdentitiesOnly yes", "  IdentityAgent none", "  ForwardAgent no", "  GatewayPorts no",
    "  ForwardX11 no", "  PreferredAuthentications publickey", "  PasswordAuthentication no", "  KbdInteractiveAuthentication no", ""].join("\n")
}

// Both files are made again from the manifests, so a removed sandbox leaves no alias and no trusted host key.
export async function writeClientFiles(dirs: Dirs, manifests: Manifest[]): Promise<void> {
  const { folder, config, knownHosts } = files(dirs)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const set = manifests.filter((manifest) => manifest.ssh).sort((a, b) => a.name.localeCompare(b.name))
  const write = async (file: string, text: string) => { const temp = `${file}.tmp-${process.pid}`; await writeFile(temp, text, { mode: 0o600 }); await rename(temp, file) }
  await write(config, `# Written by Paddock; \`paddock ssh setup NAME\` changes it.\n${set.map((manifest) => hostBlock(dirs, manifest, manifest.ssh!)).join("\n")}`)
  await write(knownHosts, set.map((manifest) => `${hostKeyAlias(manifest)} ${manifest.ssh!.hostKey}\n`).join(""))
}

export async function included(dirs: Dirs, path = userConfig()): Promise<boolean> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").some((line) => line.trim() === includeLine(dirs))
}

// The Include goes first: ssh_config reads an Include after a Host line only for that host, and the first value wins.
export async function addInclude(dirs: Dirs, path = userConfig()): Promise<boolean> {
  if (await included(dirs, path)) return false
  // Replacing a link would cut it from the file it points to, which may be managed elsewhere.
  if ((await lstat(path).catch(() => undefined))?.isSymbolicLink()) throw new PaddockError("conflict", `${path} is a link. Add this line at its top yourself: ${includeLine(dirs)}`)
  const before = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.paddock-${process.pid}`
  await writeFile(temp, `${includeLine(dirs)}\n${before ?? ""}`, { mode: 0o600 })
  try { await rename(temp, path) } catch (error) { await rm(temp, { force: true }); throw error }
  return true
}
