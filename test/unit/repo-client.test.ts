import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, readFile } from "node:fs/promises"
import { join } from "node:path"
import { clone, MAX_BUNDLE_BYTES, parseBundle, repository, save } from "../../extensions/repo/repo"
import { fixture, fakeExec, local, must, put } from "./client-feature-fixtures"

async function repositoryFixture() {
  const home = await fixture(), work = join(home, "workspace"), run = local(home)
  const git = (args: string[], stdin?: string) => must(run, ["git", "-C", work, ...args], stdin)
  await must(run, ["git", "init", "-q", "-b", "main", work])
  await put(home, "workspace/binary", Buffer.from([0, 1, 128, 255, 10, 13, 0]))
  await put(home, "workspace/tracked", "committed")
  await git(["add", "binary", "tracked"]); await git(["commit", "-qm", "Initial fixture"])
  const tip = await git(["rev-parse", "HEAD"]), binary = await git(["rev-parse", "HEAD:binary"])
  return { home, work, run, git, tip, binary }
}
test("save round-trips binary committed history only into a new host branch without mounts", async () => {
  const { home, work, run, git, tip, binary } = await repositoryFixture(), transport = fakeExec(home), target = join(home, "host.git")
  await put(home, "workspace/tracked", "staged change"); await git(["add", "tracked"])
  await put(home, "workspace/tracked", "unstaged change"); await put(home, "workspace/untracked", "untracked-secret")
  const blob = await git(["hash-object", "-w", "--stdin"], "unrelated-secret")
  const tree = await git(["mktree"], `100644 blob ${blob}\tunrelated\n`)
  const other = await git(["commit-tree", tree, "-m", "Unrelated branch"])
  await git(["update-ref", "refs/heads/unrelated", other])
  const result = await save(transport.runner, { name: "demo", workspace: work, target })
  const host = (args: string[]) => must(run, ["git", "-C", target, ...args])
  expect(result.commit).toBe(tip); expect(result.branch).toMatch(/^saved\/demo\//)
  expect(await host(["rev-parse", `${result.branch}:binary`])).toBe(binary)
  expect(await host(["show", `${result.branch}:tracked`])).toBe("committed")
  expect(await host(["ls-tree", "-r", "--name-only", result.branch])).toBe("binary\ntracked")
  expect(await host(["for-each-ref", "--format=%(refname)"])).toBe(`refs/heads/${result.branch}`)
  expect((await run(["git", "-C", target, "cat-file", "-e", other])).exitCode).not.toBe(0)
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/paddock-export"])).toBe("")
  expect(await git(["status", "--porcelain"])).toContain("MM tracked")
  expect(transport.calls.filter(call => call.argv[0] === "paddock").every(call => call.argv[1] === "exec" && call.argv.includes("--stdin"))).toBe(true)
  expect(JSON.stringify(transport.calls)).not.toContain("untracked-secret")
  const second = await save(transport.runner, { name: "demo", workspace: work, target, branch: "main" })
  expect(second.branch).not.toBe(result.branch)
  expect(await host(["rev-parse", result.branch])).toBe(tip)
})
test("save into a host working clone preserves its checked-out branch and dirty worktree", async () => {
  const guest = await repositoryFixture(), host = await repositoryFixture(), transport = fakeExec(guest.home)
  await put(host.home, "workspace/tracked", "host dirty")
  const before = await host.git(["rev-parse", "HEAD"])
  const saved = await save(transport.runner, { name: "demo", workspace: guest.work, target: host.work })
  expect(saved.commit).toBe(guest.tip)
  expect(await host.git(["rev-parse", "HEAD"])).toBe(before)
  expect(await readFile(join(host.work, "tracked"), "utf8")).toBe("host dirty")
})
test("export rejects corrupt or oversized payloads before touching a host target", () => {
  const data = Buffer.from("binary\0\xff"), envelope = { branch: "main", tip: "a".repeat(40), ref: "refs/paddock-export/12345678-1234-1234-1234-123456789abc", size: data.length, sha256: createHash("sha256").update(data).digest("hex"), data: data.toString("base64") }
  expect(parseBundle(envelope).data).toEqual(data)
  for (const changed of [{ ...envelope, size: MAX_BUNDLE_BYTES + 1 }, { ...envelope, data: envelope.data + "\n" }, { ...envelope, sha256: "0".repeat(64) }, { ...envelope, ref: "refs/heads/main" }]) expect(() => parseBundle(changed)).toThrow()
  expect(() => repository("https://token-secret@github.com/owner/repo")).toThrow("OWNER/REPO")
  expect(() => repository("owner/repo.git")).toThrow("OWNER/REPO")
})
test("a host subfolder cannot silently select its parent repository as the export destination", async () => {
  const { home, work, git } = await repositoryFixture(), transport = fakeExec(home)
  await put(home, "workspace/subfolder/keep", "host file")
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(work, "subfolder") })).rejects.toThrow("repository root")
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/heads/saved"])).toBe("")
})
test("an oversized guest bundle fails before base64 transfer and cleans up its export ref", async () => {
  const { home, work, git } = await repositoryFixture(), transport = fakeExec(home)
  const data = new Uint8Array(MAX_BUNDLE_BYTES + 65536); crypto.getRandomValues(data.subarray(0, 65536))
  // Repeating random chunks would compress; use independent chunks across the whole fixture.
  for (let offset = 65536; offset < data.length; offset += 65536) crypto.getRandomValues(data.subarray(offset, Math.min(data.length, offset + 65536)))
  await put(home, "workspace/large", Buffer.from(data)); await git(["add", "large"]); await git(["commit", "-qm", "Large fixture"])
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(home, "never.git") })).rejects.toThrow("exit 73")
  expect(await Bun.file(join(home, "never.git/HEAD")).exists()).toBe(false)
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/paddock-export"])).toBe("")
})
test("blank repositories and invalid branches fail without exporting work", async () => {
  const { home, work } = await repositoryFixture(), transport = fakeExec(home)
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(home, "out.git"), branch: "../escape" })).rejects.toThrow("failed")
  await put(home, "blank/only-untracked", "private")
  await expect(save(transport.runner, { name: "demo", workspace: join(home, "blank"), target: join(home, "out.git") })).rejects.toThrow("failed")
  expect(await Bun.file(join(home, "out.git/HEAD")).exists()).toBe(false)
})
test("clone uses only a guest gh helper, leaves a clean credential-free remote, and refuses an existing path", async () => {
  const source = await repositoryFixture(), home = await fixture(), bin = join(home, "fake-bin"), realGit = Bun.which("git")
  if (!realGit) throw new Error("Git is required for this unit fixture.")
  await put(home, "fake-bin/gh", "#!/bin/sh\nexit 0\n"); await chmod(join(bin, "gh"), 0o700)
  await put(home, "fake-bin/git", `#!/usr/bin/env node\nconst fs = require('fs'), cp = require('child_process')\nconst args = process.argv.slice(2)\nfs.appendFileSync(process.env.HOME + '/git-args', JSON.stringify(args) + '\\n')\nconst replaced = args.map(x => x === 'https://github.com/owner/repo.git' ? process.env.UNIT_REMOTE : x)\nprocess.exit(cp.spawnSync(process.env.UNIT_GIT, replaced, {stdio:'inherit'}).status ?? 1)\n`)
  await chmod(join(bin, "git"), 0o700)
  const transport = fakeExec(home, { PATH: bin + ":" + process.env.PATH, UNIT_REMOTE: source.work, UNIT_GIT: realGit })
  await clone(transport.runner, "demo", "owner/repo", "workspace")
  const args = await readFile(join(home, "git-args"), "utf8")
  expect(args).toContain("credential.https://github.com.helper=!gh auth git-credential")
  expect(transport.calls[0]?.stdin).toContain('"repository":"owner/repo"')
  expect(transport.calls[0]?.argv).not.toContain("owner/repo")
  expect(await Bun.file(join(home, "workspace/tracked")).text()).toBe("committed")
  const config = await readFile(join(home, "workspace/.git/config"), "utf8")
  expect(config).not.toContain("credential")
  expect(config).not.toContain("token")
  await expect(clone(transport.runner, "demo", "owner/repo", "workspace")).rejects.toThrow("failed")
})
