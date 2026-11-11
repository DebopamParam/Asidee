import { expect, test } from "bun:test"
import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addInclude, editorKey, hostBlock, includeLine, included, parseGuestSetup, shellWord, validPublicKey, writeClientFiles } from "../../core/ssh"
import type { Manifest } from "../../core/types"

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const manifest = (name: string, id: string, ssh = true) => ({ version: 1, name, id, engine: {} as Manifest["engine"], spec: {} as Manifest["spec"], createdAt: "",
  ...(ssh ? { ssh: { user: "root", home: "/root", unlocked: false, sshd: "/usr/sbin/sshd", hostKey: KEY, editorKey: "SHA256:x", at: "" } } : {}) }) as Manifest
const dirsIn = async (name = "pdk ssh-") => { const root = await mkdtemp(join(tmpdir(), name)); return { state: join(root, "s"), config: join(root, "c"), root } }

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
