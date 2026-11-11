import { expect, test } from "bun:test"
import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { arch } from "node:os"
import { join } from "node:path"
import { hostVersion, setup, syncProviders } from "../../extensions/t3/t3"
import { fixture, fakeExec, local, must, ok, put } from "./client-feature-fixtures"

const version = "0.1.1-nightly.20261020.3401"
test("T3 reads only the exact CLI version, falling back to the fake desktop launcher", async () => {
  const home = await fixture(), calls: string[][] = []
  expect(await hostVersion(async argv => { calls.push(argv); return argv[0] === "t3" ? { exitCode: 127, stdout: "", stderr: "secret" } : ok(`t3 v${version}\n`) }, home)).toBe(version)
  expect(calls).toEqual([["t3", "--version"], [join(home, ".t3/bin/t3"), "--version"]])
  await expect(hostVersion(async () => ok("version 1.2.3; injected"), home)).rejects.toThrow("No exact T3 version")
})
test("T3 setup only execs its installer and provider sync after resolving the host version", async () => {
  const home = await fixture(), calls: string[][] = []
  const ready = await setup(async argv => {
    calls.push(argv)
    if (argv[0] === "t3") return ok(`t3 ${version}`)
    return ok(argv.at(-1) === "https://github.com/pingdotgg/t3code/releases/download" ? "installed\n" : '{"claude":0,"codex":0}')
  }, "demo", home)
  expect(ready).toEqual({ version, runtime: "installed", claude: 0, codex: 0 })
  expect(calls.slice(1).every(argv => argv.slice(0, 3).join(" ") === "paddock exec demo")).toBe(true)
  await expect(setup(async () => { throw new Error("token-secret") }, "demo", home)).rejects.not.toThrow("token-secret")
})
test("guest install verifies the matching release before execution and publishes the app marker", async () => {
  const root = await fixture(), home = await fixture(), run = local(root), name = `t3-${version}-linux-${arch() === "arm64" ? "arm64" : "x64"}.tar.gz`
  await put(root, "release/t3", `#!/bin/sh\nprintf ran > "$HOME/executed"\nprintf 't3 v${version}\\n'\n`)
  await chmod(join(root, "release/t3"), 0o700)
  await must(run, ["tar", "-czf", join(root, name), "-C", root, "release"])
  const archive = await readFile(join(root, name)), hash = createHash("sha256").update(archive).digest("hex")
  let bad = true, duplicate = false, downloads = 0
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url); downloads++
    if (url.pathname === `/v${version}/SHA256SUMS`) return new Response(`${bad ? "0".repeat(64) : hash}  ${name}\n${duplicate ? `${hash} *${name}\n` : ""}`)
    if (url.pathname === `/v${version}/${name}`) return new Response(archive)
    return new Response("missing", { status: 404 })
  } })
  try {
    const script = await Bun.file(join(import.meta.dir, "../../extensions/t3/install.cjs")).text(), execute = local(home)
    const args = ["node", "-e", script, version, server.url.href.replace(/\/$/, "")]
    expect((await execute(args)).exitCode).not.toBe(0)
    expect(await Bun.file(join(home, "executed")).exists()).toBe(false)
    expect(await Bun.file(join(home, `.t3/runtime/versions/${version}/.install-complete`)).exists()).toBe(false)
    bad = false; duplicate = true
    expect((await execute(args)).exitCode).not.toBe(0)
    expect(await Bun.file(join(home, "executed")).exists()).toBe(false)
    duplicate = false
    expect(await must(execute, args)).toBe("installed")
    expect(await readFile(join(home, `.t3/runtime/versions/${version}/.install-complete`), "utf8")).toBe(version + "\n")
    expect(await Bun.file(join(home, "executed")).exists()).toBe(true)
    const before = downloads
    expect(await must(execute, args)).toBe("present"); expect(downloads).toBe(before)
  } finally { server.stop(true) }
})
test("provider sync discovers canonical/named logins and keeps custom providers through refresh and logout", async () => {
  const home = await fixture(), transport = fakeExec(home)
  await put(home, ".claude-work/.credentials.json", "credential-secret")
  await put(home, ".codex/auth.json", "credential-secret")
  await put(home, ".codex-personal/auth.json", "credential-secret")
  const custom = { driver: "codex", config: { homePath: "/custom/home" }, displayName: "Mine", environment: [{ name: "KEY", value: "secret" }] }
  await put(home, ".t3/userdata/settings.json", JSON.stringify({ theme: "light", providerInstances: { codex: custom, custom } }))
  expect(await syncProviders(transport.runner, "demo")).toEqual({ claude: 1, codex: 2 })
  let settings = JSON.parse(await readFile(join(home, ".t3/userdata/settings.json"), "utf8"))
  expect(settings.providerInstances.codex).toEqual(custom); expect(settings.providerInstances.custom).toEqual(custom)
  expect(settings.providerInstances["paddock-codex-canonical"].config.homePath).toBe(join(home, ".codex"))
  expect(settings.providerInstances.claudeAgent.environment).toContainEqual({ name: "ANTHROPIC_API_KEY", value: "", sensitive: false })
  expect(settings.theme).toBe("light"); expect((await lstat(join(home, ".t3/userdata/settings.json"))).mode & 0o777).toBe(0o600)
  expect(settings.paddockProviderInstances).toBeUndefined()
  expect((await lstat(join(home, ".t3/userdata/paddock-providers.json"))).mode & 0o777).toBe(0o600)
  await rm(join(home, ".codex-personal/auth.json"))
  expect(await syncProviders(transport.runner, "demo")).toEqual({ claude: 1, codex: 1 })
  settings = JSON.parse(await readFile(join(home, ".t3/userdata/settings.json"), "utf8"))
  expect(settings.providerInstances["codex-personal"]).toBeUndefined(); expect(settings.providerInstances.custom).toEqual(custom)
  expect(JSON.stringify(transport.calls)).not.toContain("credential-secret")
})
test("invalid or symlinked settings are not replaced and credential symlinks are skipped", async () => {
  const home = await fixture(), transport = fakeExec(home)
  await put(home, ".t3/userdata/settings.json", "broken-secret-json")
  await expect(syncProviders(transport.runner, "demo")).rejects.not.toThrow("broken-secret-json")
  expect(await readFile(join(home, ".t3/userdata/settings.json"), "utf8")).toBe("broken-secret-json")
  await rm(join(home, ".t3/userdata/settings.json")); await put(home, "outside.json", "{}")
  await symlink(join(home, "outside.json"), join(home, ".t3/userdata/settings.json"))
  await expect(syncProviders(transport.runner, "demo")).rejects.toThrow("failed")
  expect(await readFile(join(home, "outside.json"), "utf8")).toBe("{}")
  await rm(join(home, ".t3/userdata/settings.json"))
  await put(home, ".codex-work/placeholder", "")
  await symlink(join(home, "outside.json"), join(home, ".codex-work/auth.json"))
  expect(await syncProviders(transport.runner, "demo")).toEqual({ claude: 0, codex: 0 })
})

test("provider publication refuses to overwrite a T3 settings edit made during sync", async () => {
  const home = await fixture(), execute = local(home)
  await put(home, ".codex/auth.json", "credential")
  await put(home, ".t3/userdata/settings.json", '{"theme":"before"}')
  const prefix = `const f = require('fs'), originalWrite = f.writeFileSync; let edited = false;
    f.writeFileSync = (file, ...args) => {
      if (!edited && String(file).includes('paddock-providers.json.')) {
        edited = true; originalWrite(require('path').join(require('os').homedir(), '.t3/userdata/settings.json'), '{"theme":"concurrent"}');
      }
      return originalWrite(file, ...args);
    };`
  const script = await Bun.file(join(import.meta.dir, "../../extensions/t3/providers.cjs")).text()
  expect((await execute(["node", "-e", prefix + script])).exitCode).not.toBe(0)
  expect(JSON.parse(await readFile(join(home, ".t3/userdata/settings.json"), "utf8"))).toEqual({ theme: "concurrent" })
  expect(await syncProviders(fakeExec(home).runner, "demo")).toEqual({ claude: 0, codex: 1 })
})

test("the installer uses the verified archive bytes when its download path changes after hashing", async () => {
  const root = await fixture(), home = await fixture(), execute = local(root), name = `t3-${version}-linux-${arch() === "arm64" ? "arm64" : "x64"}.tar.gz`
  for (const label of ["verified", "substituted"]) {
    await put(root, `${label}/release/t3`, `#!/bin/sh\nprintf '${label}' > "$HOME/executed"\nprintf 't3 v${version}\\n'\n`)
    await chmod(join(root, label, "release/t3"), 0o700)
    await must(execute, ["tar", "-czf", join(root, label + ".tar.gz"), "-C", join(root, label), "release"])
  }
  const archive = await readFile(join(root, "verified.tar.gz")), hash = createHash("sha256").update(archive).digest("hex")
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    return new URL(request.url).pathname.endsWith("SHA256SUMS") ? new Response(`${hash}  ${name}\n`) : new Response(archive)
  } })
  const prefix = `const c = require('crypto'), originalHash = c.createHash;
    c.createHash = (...args) => {
      const hash = originalHash(...args), originalDigest = hash.digest.bind(hash);
      hash.digest = (...args) => {
        const result = originalDigest(...args), f = require('fs'), p = require('path');
        const root = p.join(require('os').homedir(), '.t3/runtime/versions');
        for (const name of f.readdirSync(root).filter(n => n.startsWith('.staging-'))) {
          const dir = p.join(root, name);
          for (const file of f.readdirSync(dir).filter(n => n.endsWith('.tar.gz'))) f.copyFileSync(${JSON.stringify(join(root, "substituted.tar.gz"))}, p.join(dir, file));
        }
        return result;
      };
      return hash;
    };`
  try {
    const script = await Bun.file(join(import.meta.dir, "../../extensions/t3/install.cjs")).text()
    expect(await must(local(home), ["node", "-e", prefix + script, version, server.url.href.replace(/\/$/, "")])).toBe("installed")
    expect(await readFile(join(home, "executed"), "utf8")).toBe("verified")
  } finally { server.stop(true) }
})
