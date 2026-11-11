import { afterAll, expect, test } from "bun:test"
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addInclude, editorKey, hostBlock, includeLine, included, keyFingerprint, parseGuestSetup, parseSshSetup, remoteAliases, shellWord, updateRemoteAlias, validPublicKey, writeClientFiles } from "../../core/ssh"
import type { Manifest } from "../../core/types"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const manifest = (name: string, id: string, ssh = true) => ({ version: 1, name, id, engine: {} as Manifest["engine"], spec: {} as Manifest["spec"], createdAt: "",
  ...(ssh ? { ssh: { user: "root", home: "/root", unlocked: false, sshd: "/usr/sbin/sshd", hostKey: KEY, editorKey: "SHA256:x", at: "" } } : {}) }) as Manifest
const roots: string[] = []
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))))
const dirsIn = async (name = "pdk ssh-") => { const root = await mkdtemp(join(tmpdir(), name)); roots.push(root); return { state: join(root, "s"), config: join(root, "c"), root } }

test("a ProxyCommand word survives the shell and ssh's % tokens", async () => {
  expect(shellWord("/a b/it's 100%")).toBe(`'/a b/it'\\''s 100%%'`)
  // What /bin/sh makes of it once ssh has turned %% back into %.
  const child = Bun.spawn(["/bin/sh", "-c", `printf '%s\\n' ${shellWord("/a b/it's 100%").replace(/%%/g, "%")}`], { stdout: "pipe" })
  expect((await new Response(child.stdout).text()).trim()).toBe("/a b/it's 100%")
})

test("the host block pins the sandbox's id, its known hosts and the editor key, and forwards no agent", async () => {
  const dirs = await dirsIn()
  const block = hostBlock(dirs, manifest("demo", "abc123"), manifest("demo", "abc123").ssh!, ["/opt/pad dock/paddock"])
  expect(block).toContain("Host demo.paddock\n")
  expect(block).toContain(`  ProxyCommand '/usr/bin/env' 'PADDOCK_STATE_DIR=${dirs.state}' 'PADDOCK_CONFIG_DIR=${dirs.config}' '/opt/pad dock/paddock' 'ssh' 'proxy' 'demo'\n`)
  for (const line of ["HostKeyAlias paddock-abc123", "StrictHostKeyChecking yes", "GlobalKnownHostsFile /dev/null", "IdentitiesOnly yes", "IdentityAgent none", "ForwardAgent no", "GatewayPorts no",
    `UserKnownHostsFile "${join(dirs.state, "ssh", "known_hosts")}"`, `IdentityFile "${join(dirs.state, "ssh", "editor_ed25519")}"`, "User root"])
    expect(block).toContain(`  ${line}\n`)
  expect(() => hostBlock({ state: '/x"y', config: "/c" }, manifest("demo", "abc123"), manifest("demo", "abc123").ssh!)).toThrow("cannot write an SSH configuration")
})

test("the client files list only sandboxes that were set up, by id", async () => {
  const dirs = await dirsIn()
  await writeClientFiles(dirs, [manifest("one", "id1"), manifest("two", "id2", false)])
  const config = await readFile(join(dirs.state, "ssh", "config"), "utf8")
  expect(config).toContain("Host one.paddock"); expect(config).not.toContain("two.paddock")
  expect(await readFile(join(dirs.state, "ssh", "known_hosts"), "utf8")).toBe(`paddock-id1 ${KEY}\n`)
  expect((await lstat(join(dirs.state, "ssh", "config"))).mode & 0o777).toBe(0o600)
  await writeClientFiles(dirs, [])
  expect(await readFile(join(dirs.state, "ssh", "known_hosts"), "utf8")).toBe("")
})

test("the Include line is added once, first in the file, and a linked config is left alone", async () => {
  const dirs = await dirsIn(); const path = join(dirs.root, "home", ".ssh", "config")
  expect(await addInclude(dirs, path)).toBe(true)
  expect(await readFile(path, "utf8")).toBe(`${includeLine(dirs)}\n`)
  await writeFile(path, `${await readFile(path, "utf8")}Host other\n  User me\n`)
  expect(await addInclude(dirs, path)).toBe(false); expect(await included(dirs, path)).toBe(true)
  const fresh = join(dirs.root, "config2"); await writeFile(fresh, "Host *\n  ServerAliveInterval 5\n")
  await addInclude(dirs, fresh)
  expect((await readFile(fresh, "utf8")).split("\n").slice(0, 2)).toEqual([includeLine(dirs), "Host *"])
  const link = join(dirs.root, "linked"); await symlink(fresh, link)
  await writeFile(fresh, "Host *\n")
  await expect(addInclude(dirs, link)).rejects.toThrow("is a link")
  expect(await readFile(fresh, "utf8")).toBe("Host *\n")
})

test("the editor key is made once, here, and only its public half is read", async () => {
  const dirs = await dirsIn()
  const first = await editorKey(dirs); const second = await editorKey(dirs)
  expect(validPublicKey(first.publicKey)).toBe(true); expect(second.publicKey).toBe(first.publicKey)
  expect(first.fingerprint).toMatch(/^SHA256:/)
  expect((await lstat(first.path)).mode & 0o777).toBe(0o600); expect((await lstat(join(dirs.state, "ssh"))).mode & 0o777).toBe(0o700)
})

test("the guest's report is read strictly", () => {
  expect(parseGuestSetup(`installing…\nyes\n/root\n/usr/sbin/sshd\n${KEY} paddock-guest\n`)).toEqual({ unlocked: true, home: "/root", sshd: "/usr/sbin/sshd", hostKey: KEY })
  for (const bad of ["", "no\n/root\n/usr/sbin/sshd\nssh-rsa AAAA", `no\nroot\n/usr/sbin/sshd\n${KEY}`, `no\n/root\nsshd\n${KEY}`, `no\n/root\n/usr/sbin/sshd\n${KEY} two words`, `/root\n/usr/sbin/sshd\n${KEY}`])
    expect(() => parseGuestSetup(bad)).toThrow("did not report")
  expect(validPublicKey(`${KEY}\nssh-ed25519 ${KEY.split(" ")[1]}`)).toBe(false)
})

test("remote aliases pin both identities, keep the private key here, coexist with local aliases and are removed per host", async () => {
  const dirs = await dirsIn()
  const key = await editorKey(dirs)
  expect(keyFingerprint(key.publicKey)).toBe(key.fingerprint)
  const setup = parseSshSetup({ user: "root", home: "/root", unlocked: false, sshd: "/usr/sbin/sshd", hostKey: KEY, editorKey: key.fingerprint, at: "2026-11-11T00:00:00Z" })
  const entry = { host: "build", name: "demo", machineId: "a".repeat(32), sandboxId: "b".repeat(32), setup }
  await Promise.all([updateRemoteAlias(dirs, "build", "demo", entry), updateRemoteAlias(dirs, "other", "demo", { ...entry, host: "other", machineId: "c".repeat(32) })])
  await writeClientFiles(dirs, [manifest("demo", "local-id")])
  const config = await readFile(join(dirs.state, "ssh", "config"), "utf8")
  for (const name of ["demo.paddock", "demo.build.paddock", "demo.other.paddock"]) expect(config).toContain(`Host ${name}\n`)
  expect(config).toContain(`HostKeyAlias paddock-${entry.machineId}-${entry.sandboxId}`)
  expect(config).toContain(`'--host' 'build' 'ssh' 'proxy' 'demo' '--sandbox-id' '${entry.sandboxId}'`)
  expect(config).toContain(`IdentityFile "${key.path}"`)
  expect(JSON.stringify(await remoteAliases(dirs))).not.toContain("PRIVATE KEY")
  await updateRemoteAlias(dirs, "build")
  expect((await remoteAliases(dirs)).map((entry) => entry.host)).toEqual(["other"])
  for (const bad of [{ ...setup, user: "root\nProxyCommand id" }, { ...setup, home: "/root\nBad" }, { ...setup, hostKey: "ssh-rsa AAAA" }]) expect(() => parseSshSetup(bad)).toThrow()
})
