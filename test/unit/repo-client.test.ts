import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { clone, MAX_BUNDLE_BYTES, parseBundle, repository, save } from "../../extensions/repo/repo"
import { inspectBundle, MAX_OBJECT_BYTES, MAX_OBJECTS } from "../../extensions/repo/bundle"
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
  const result = await save(transport.runner, { name: "demo", workspace: work, target }, transport.streamer)
  const host = (args: string[]) => must(run, ["git", "-C", target, ...args])
  expect(result.commit).toBe(tip); expect(result.branch).toMatch(/^saved\/demo\//)
  expect(await host(["rev-parse", `${result.branch}:binary`])).toBe(binary)
  expect(await host(["show", `${result.branch}:tracked`])).toBe("committed")
  expect(await host(["ls-tree", "-r", "--name-only", result.branch])).toBe("binary\ntracked")
  expect(await host(["for-each-ref", "--format=%(refname)"])).toBe(`refs/heads/${result.branch}`)
  expect((await run(["git", "-C", target, "cat-file", "-e", other])).exitCode).not.toBe(0)
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/asidee-export"])).toBe("")
  expect(await git(["status", "--porcelain"])).toContain("MM tracked")
  expect(transport.calls.filter(call => call.argv[0] === "asd").every(call => call.argv[1] === "exec" && call.argv[3] === "--stream")).toBe(true)
  expect(JSON.stringify(transport.calls)).not.toContain("untracked-secret")
  const second = await save(transport.runner, { name: "demo", workspace: work, target, branch: "main" }, transport.streamer)
  expect(second.branch).not.toBe(result.branch)
  expect(await host(["rev-parse", result.branch])).toBe(tip)
})
test("save into a host working clone preserves its checked-out branch and dirty worktree", async () => {
  const guest = await repositoryFixture(), host = await repositoryFixture(), transport = fakeExec(guest.home)
  await put(host.home, "workspace/tracked", "host dirty")
  const before = await host.git(["rev-parse", "HEAD"])
  const saved = await save(transport.runner, { name: "demo", workspace: guest.work, target: host.work }, transport.streamer)
  expect(saved.commit).toBe(guest.tip)
  expect(await host.git(["rev-parse", "HEAD"])).toBe(before)
  expect(await readFile(join(host.work, "tracked"), "utf8")).toBe("host dirty")
})
test("export rejects corrupt or oversized payloads before touching a host target", () => {
  const data = Buffer.from([98, 0, 255, 10, 13, 128]), header = { branch: "main", tip: "a".repeat(40), ref: "refs/asidee-export/12345678-1234-1234-1234-123456789abc", size: data.length, sha256: createHash("sha256").update(data).digest("hex") }
  const output = (value: object, body = data) => Buffer.concat([Buffer.from(JSON.stringify(value) + "\n"), body])
  expect(parseBundle(output(header)).data).toEqual(data)
  for (const changed of [output({ ...header, size: MAX_BUNDLE_BYTES + 1 }), output(header, Buffer.concat([data, Buffer.from("\n")])), output(header, data.subarray(1)), output({ ...header, sha256: "0".repeat(64) }), output({ ...header, ref: "refs/heads/main" }), data, Buffer.concat([Buffer.alloc(5000, 32), output(header)])]) expect(() => parseBundle(changed)).toThrow()
  expect(() => repository("https://token-secret@github.com/owner/repo")).toThrow("OWNER/REPO")
  expect(() => repository("owner/repo.git")).toThrow("OWNER/REPO")
})
test("a host subfolder cannot silently select its parent repository as the export destination", async () => {
  const { home, work, git } = await repositoryFixture(), transport = fakeExec(home)
  await put(home, "workspace/subfolder/keep", "host file")
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(work, "subfolder") }, transport.streamer)).rejects.toThrow("repository root")
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/heads/saved"])).toBe("")
})
test("an oversized guest bundle fails before transfer and cleans up its export ref", async () => {
  const { home, work, git } = await repositoryFixture(), transport = fakeExec(home)
  const data = new Uint8Array(MAX_BUNDLE_BYTES + 65536); crypto.getRandomValues(data.subarray(0, 65536))
  // Repeating random chunks would compress; use independent chunks across the whole fixture.
  for (let offset = 65536; offset < data.length; offset += 65536) crypto.getRandomValues(data.subarray(offset, Math.min(data.length, offset + 65536)))
  await put(home, "workspace/large", Buffer.from(data)); await git(["add", "large"]); await git(["commit", "-qm", "Large fixture"])
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(home, "never.git") }, transport.streamer)).rejects.toThrow("exit 73")
  expect(await Bun.file(join(home, "never.git/HEAD")).exists()).toBe(false)
  expect(await git(["for-each-ref", "--format=%(refname)", "refs/asidee-export"])).toBe("")
}, 30_000)
test("save carries a raw bundle beyond the 16 MiB text exec limit", async () => {
  const { home, work, run, git } = await repositoryFixture(), transport = fakeExec(home), target = join(home, "large.git")
  for (const file of ["one", "two", "three"]) {
    const data = new Uint8Array(8 * 1024 * 1024)
    for (let offset = 0; offset < data.length; offset += 65536) crypto.getRandomValues(data.subarray(offset, offset + 65536))
    await put(home, "workspace/" + file, Buffer.from(data))
  }
  await git(["add", "one", "two", "three"]); await git(["commit", "-qm", "Large history"])
  const saved = await save(transport.runner, { name: "demo", workspace: work, target }, transport.streamer)
  for (const file of ["one", "two", "three"]) expect(await must(run, ["git", "-C", target, "rev-parse", `${saved.branch}:${file}`])).toBe(await git(["rev-parse", `HEAD:${file}`]))
}, 30_000)
test("blank repositories and invalid branches fail without exporting work", async () => {
  const { home, work } = await repositoryFixture(), transport = fakeExec(home)
  await expect(save(transport.runner, { name: "demo", workspace: work, target: join(home, "out.git"), branch: "../escape" }, transport.streamer)).rejects.toThrow("failed")
  await put(home, "blank/only-untracked", "private")
  await expect(save(transport.runner, { name: "demo", workspace: join(home, "blank"), target: join(home, "out.git") }, transport.streamer)).rejects.toThrow("failed")
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
  // An empty directory, as images ship ~/workspace, takes the clone; one with anything in it does not.
  await mkdir(join(home, "empty"))
  await clone(transport.runner, "demo", "owner/repo", "empty")
  expect(await Bun.file(join(home, "empty/tracked")).text()).toBe("committed")
  await put(home, "busy/note", "mine")
  await expect(clone(transport.runner, "demo", "owner/repo", "busy")).rejects.toThrow("failed")
  expect(await readdir(join(home, "busy"))).toEqual(["note"])
})

test("save cannot prune existing host tags or run hooks under aggressive host fetch settings", async () => {
  const guest = await repositoryFixture(), host = await repositoryFixture(), transport = fakeExec(guest.home)
  await host.git(["tag", "host-keep"])
  await host.git(["config", "fetch.prune", "true"]); await host.git(["config", "fetch.pruneTags", "true"])
  await put(host.home, "workspace/.git/hooks/reference-transaction", '#!/bin/sh\nprintf ran > "$HOME/hook-ran"\n')
  await chmod(join(host.work, ".git/hooks/reference-transaction"), 0o700)
  await save(transport.runner, { name: "demo", workspace: guest.work, target: host.work }, transport.streamer)
  expect(await host.git(["rev-parse", "refs/tags/host-keep"])).toBe(host.tip)
  expect(await Bun.file(join(guest.home, "hook-ran")).exists()).toBe(false)
})

test("a highly compressed large object is rejected before host Git or target creation", async () => {
  const guest = await repositoryFixture(), transport = fakeExec(guest.home), target = join(guest.home, "never.git")
  await put(guest.home, "workspace/expanded", Buffer.alloc(33 * 1024 * 1024, 65))
  await guest.git(["add", "expanded"]); await guest.git(["commit", "-qm", "Compressed large object"])
  const calls: string[][] = []
  await expect(save(async (argv, stdin) => { calls.push(argv); return transport.runner(argv, stdin) }, { name: "demo", workspace: guest.work, target }, transport.streamer)).rejects.toThrow("expanded")
  expect(calls.some(argv => argv[0] === "git")).toBe(false)
  expect(await Bun.file(join(target, "HEAD")).exists()).toBe(false)
})

test("dishonest guest bundles cannot add refs, depend on host history or change their pack checksum", async () => {
  const guest = await repositoryFixture(), transport = fakeExec(guest.home), target = join(guest.home, "never.git")
  const exported = await transport.streamer(["asd", "exec", "demo", "--stream", "--", "node", "-e", await Bun.file(join(import.meta.dir, "../../extensions/repo/guest.cjs")).text()], JSON.stringify({ action: "save", workspace: guest.work }), MAX_BUNDLE_BYTES + 4096)
  expect(exported.exitCode).toBe(0)
  const bundle = parseBundle(exported.stdout), end = bundle.data.indexOf("\n\n"), pack = bundle.data.subarray(end + 2)
  const header = bundle.data.subarray(0, end).toString(), reference = bundle.tip + " " + bundle.ref
  const corruptPack = Buffer.from(pack); corruptPack[corruptPack.length - 1] = corruptPack[corruptPack.length - 1]! ^ 1
  for (const bytes of [
    Buffer.concat([Buffer.from(header + "\n" + bundle.tip + " refs/heads/other\n\n"), pack]),
    Buffer.concat([Buffer.from(`# v2 git bundle\n-${bundle.tip} prerequisite\n${reference}\n\n`), pack]),
    Buffer.concat([Buffer.from(`# v3 git bundle\n@filter=blob:none\n${reference}\n\n`), pack]),
    Buffer.concat([bundle.data.subarray(0, end + 2), corruptPack]),
  ]) {
    const stdout = Buffer.concat([Buffer.from(JSON.stringify({ branch: "main", tip: bundle.tip, ref: bundle.ref, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) + "\n"), bytes])
    await expect(save(transport.runner, { name: "demo", workspace: guest.work, target }, async () => ({ exitCode: 0, stdout }))).rejects.toThrow("expanded")
    expect(await Bun.file(join(target, "HEAD")).exists()).toBe(false)
  }
})

test("pack resource checks include delta result sizes, aggregate expansion and object count", () => {
  const variable = (number: number) => {
    const bytes: number[] = []
    do { const low = number % 128; number = Math.floor(number / 128); bytes.push(low | (number ? 128 : 0)) } while (number)
    return Buffer.from(bytes)
  }
  const object = (data: Buffer) => {
    let size = Math.floor(data.length / 16)
    const bytes = [(7 << 4) | (data.length & 15) | (size ? 128 : 0)]
    while (size) { const low = size % 128; size = Math.floor(size / 128); bytes.push(low | (size ? 128 : 0)) }
    return Buffer.concat([Buffer.from(bytes), Buffer.alloc(20), deflateSync(data)])
  }
  const tip = "a".repeat(40), ref = "refs/asidee-export/12345678-1234-1234-1234-123456789abc"
  const bundle = (objects: Buffer[], count = objects.length) => {
    const header = Buffer.alloc(12); header.write("PACK"); header.writeUInt32BE(2, 4); header.writeUInt32BE(count, 8)
    const body = Buffer.concat([header, ...objects])
    return Buffer.concat([Buffer.from(`# v2 git bundle\n${tip} ${ref}\n\n`), body, createHash("sha1").update(body).digest()])
  }
  const tooLarge = object(Buffer.concat([variable(0), variable(MAX_OBJECT_BYTES + 1)]))
  expect(() => inspectBundle(bundle([tooLarge]), tip, ref)).toThrow("expanded")
  const delta = object(Buffer.concat([variable(0), variable(MAX_OBJECT_BYTES)]))
  expect(() => inspectBundle(bundle(Array.from({ length: 5 }, () => delta)), tip, ref)).toThrow("expanded")
  expect(() => inspectBundle(bundle([], MAX_OBJECTS + 1), tip, ref)).toThrow("expanded")
})

test("strict quarantine rejects a Git tree containing .git before creating a host destination", async () => {
  const guest = await repositoryFixture(), transport = fakeExec(guest.home), target = join(guest.home, "never.git")
  const blob = await guest.git(["hash-object", "-w", "--stdin"], "malicious metadata")
  const tree = await guest.git(["mktree"], `100644 blob ${blob}\t.git\n`)
  const tip = await guest.git(["commit-tree", tree, "-m", "Unsafe tree"])
  await guest.git(["update-ref", "refs/heads/unsafe", tip])
  await expect(save(transport.runner, { name: "demo", workspace: guest.work, target, branch: "unsafe" }, transport.streamer)).rejects.toThrow("failed")
  expect(await Bun.file(join(target, "HEAD")).exists()).toBe(false)
})

test("valid delta-packed history still round-trips through quarantine", async () => {
  const guest = await repositoryFixture(), transport = fakeExec(guest.home), target = join(guest.home, "deltas.git")
  const text = "shared fixture line\n".repeat(2048)
  for (let revision = 0; revision < 4; revision++) {
    await put(guest.home, "workspace/delta", text + revision)
    await guest.git(["add", "delta"]); await guest.git(["commit", "-qm", "Revision " + revision])
  }
  await guest.git(["repack", "-adf", "--window=10", "--depth=10"])
  const saved = await save(transport.runner, { name: "demo", workspace: guest.work, target }, transport.streamer)
  expect(await must(guest.run, ["git", "-C", target, "show", saved.branch + ":delta"])).toBe(text + "3")
})
