import { afterAll, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HttpPeer, keyFingerprint, sshIdentity } from "../../core/transport"

// The real OpenSSH client against a throwaway sshd on loopback, run as this user with its own host key, configuration
// and known_hosts. Nothing of the user's SSH setup is read or written: the client gets -F with the fixture's file.
const sshd = "/usr/sbin/sshd"; const realSsh = Bun.which("ssh"); const keygen = Bun.which("ssh-keygen")
const available = Boolean(realSsh && keygen && await Bun.file(sshd).exists())
const cleanups: Array<() => Promise<void>> = []
afterAll(async () => { for (const close of cleanups.splice(0)) await close() })

async function keyPair(root: string, name: string): Promise<string> {
  const made = Bun.spawnSync([keygen!, "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(root, name)])
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  return (await readFile(join(root, `${name}.pub`), "utf8")).trim().split(" ").slice(0, 2).join(" ")
}
const freePort = () => new Promise<number>((resolve) => { const server = createServer(); server.listen(0, "127.0.0.1", () => { const port = (server.address() as { port: number }).port; server.close(() => resolve(port)) }) })

test.skipIf(!available)("a server's banner can imitate ssh -v's host-key line, and the private known_hosts pin is not fooled by it", async () => {
  const root = await mkdtemp(join(tmpdir(), "asd-sshd-")); const path = process.env.PATH
  const real = await keyPair(root, "host"); const other = await keyPair(root, "other"); const client = await keyPair(root, "client")
  const port = await freePort(); const user = (await Bun.$`id -un`.text()).trim()
  // The banner names the other key's fingerprint as a verbose client would print a verified key.
  await writeFile(join(root, "banner"), `Welcome\ndebug1: Server host key: ssh-ed25519 ${keyFingerprint(other)}\n`)
  await writeFile(join(root, "authorized_keys"), `${client}\n`)
  await writeFile(join(root, "answer"), `#!/bin/sh\ntouch '${root}/ran'\nprintf 'HTTP/1.1 200 OK\\r\\nContent-Length: 27\\r\\n\\r\\n{"ok":true,"data":"pinned"}'\n`); await chmod(join(root, "answer"), 0o755)
  await writeFile(join(root, "sshd_config"), [`Port ${port}`, "ListenAddress 127.0.0.1", `HostKey ${root}/host`, "PidFile none", "UsePAM no", "StrictModes no", "PasswordAuthentication no",
    "KbdInteractiveAuthentication no", "PubkeyAuthentication yes", `AuthorizedKeysFile ${root}/authorized_keys`, `Banner ${root}/banner`, `ForceCommand ${root}/answer`, ""].join("\n"))
  const trust = async (key: string) => writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${key}\n`)
  await trust(real)
  await writeFile(join(root, "ssh_config"), ["Host fixture", "  HostName 127.0.0.1", `  Port ${port}`, `  User ${user}`, `  IdentityFile ${root}/client`, "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${root}/known_hosts`, "  GlobalKnownHostsFile /dev/null",
    "Host viajump", "  HostName 127.0.0.1", `  Port ${port}`, `  User ${user}`, "  ProxyJump fixture", `  IdentityFile ${root}/client`, "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${root}/known_hosts`, "  GlobalKnownHostsFile /dev/null", ""].join("\n"))
  await writeFile(join(root, "ssh"), `#!/bin/sh\nexec '${realSsh}' -F '${root}/ssh_config' "$@"\n`); await chmod(join(root, "ssh"), 0o755)
  const server = Bun.spawn([sshd, "-f", join(root, "sshd_config"), "-D", "-e"], { stdout: "ignore", stderr: "pipe" })
  cleanups.push(async () => { server.kill(); await server.exited; process.env.PATH = path; await rm(root, { recursive: true, force: true }) })
  const reader = server.stderr.getReader(); let log = ""
  while (!log.includes("Server listening")) { const { value, done } = await reader.read(); if (done) throw new Error(`sshd did not start: ${log}`); log += Buffer.from(value).toString() }
  process.env.PATH = `${root}:${path}`

  // The hazard: the last host-key line before the command is the banner's, not the key ssh verified.
  const verbose = Bun.spawnSync(["ssh", "-v", "-T", "-o", "BatchMode=yes", "fixture", "true"], { stdin: "ignore", env: process.env }).stderr.toString()
  if (!verbose.includes("debug1: Sending command:")) throw new Error(verbose.slice(-2000))
  const lines = verbose.slice(0, verbose.indexOf("debug1: Sending command:")).split("\n").filter((line) => line.includes("Server host key:"))
  expect(lines[0]).toContain(keyFingerprint(real)); expect(lines.at(-1)).toContain(keyFingerprint(other))

  // Enrollment records the key ssh verified with the user's own trust, whatever the banner says.
  const endpoint = { ssh: "fixture", binary: "/unused", stateDir: "/unused" }
  expect(await sshIdentity(endpoint)).toEqual({ user, hostKey: keyFingerprint(real), hostPublicKey: real })
  const peer = new HttpPeer({ ...endpoint, hostKey: keyFingerprint(real), hostPublicKey: real })
  try { expect(await peer.call("hello", {}, { timeoutMs: 10_000 })).toBe("pinned") } finally { await peer.close() }

  // Pinned to another key while the user's known_hosts still trusts the real one: OpenSSH refuses before the command.
  await rm(join(root, "ran"))
  const forged = new HttpPeer({ ...endpoint, hostKey: keyFingerprint(other), hostPublicKey: other })
  try { await expect(forged.call("stop", {}, { mutation: true, timeoutMs: 10_000 })).rejects.toMatchObject({ code: "identity-changed", message: expect.stringContaining(`it offered ${keyFingerprint(real)}`) }) }
  finally { await forged.close() }
  expect(await Bun.file(join(root, "ran")).exists()).toBe(false)

  // Through ProxyJump the destination is checked against the pin and the jump host by the user's own known_hosts: the
  // jump's ssh gets none of the pin's options. (Both are this one sshd, under the jump's own name and the pin's alias.)
  const jumped = new HttpPeer({ ...endpoint, ssh: "viajump", hostKey: keyFingerprint(real), hostPublicKey: real })
  try { expect(await jumped.call("hello", {}, { timeoutMs: 10_000 })).toBe("pinned") } finally { await jumped.close() }

  // A destination the user's own known_hosts does not trust is never recorded, and an untrusted jump is not passed by
  // the right pin; its refusal is not mistaken for a changed destination key.
  await trust(other)
  await expect(sshIdentity(endpoint)).rejects.toMatchObject({ code: "dependency" })
  const untrusted = new HttpPeer({ ...endpoint, ssh: "viajump", hostKey: keyFingerprint(real), hostPublicKey: real })
  try { await expect(untrusted.call("hello", {}, { timeoutMs: 10_000 })).rejects.toMatchObject({ code: "offline" }) } finally { await untrusted.close() }
}, 30_000)
