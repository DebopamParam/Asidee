import { expect, test } from "bun:test"
import { chmod, lstat, readFile, rm, symlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { arch } from "node:os"
import { join } from "node:path"
import { browser, hostVersion, setup, sshAccess, syncProviders } from "../../extensions/t3/t3"
import { fixture, fakeExec, local, must, ok, put } from "./client-feature-fixtures"

const version = "0.1.1-nightly.20261020.3401"
// The guest scripts as t3.ts sends them: concatenated, in this order.
const guest = async (...files: string[]) => (await Promise.all(files.map((file) => Bun.file(join(import.meta.dir, "../../extensions/t3", file)).text()))).join("")
test("T3 reads only the exact CLI version, falling back to the fake desktop launcher", async () => {
  const home = await fixture(), calls: string[][] = []
  expect(await hostVersion(async argv => { calls.push(argv); return argv[0] === "t3" ? { exitCode: 127, stdout: "", stderr: "secret" } : ok(`t3 v${version}\n`) }, home)).toBe(version)
  expect(calls).toEqual([["t3", "--version"], [join(home, ".t3/bin/t3"), "--version"]])
  await expect(hostVersion(async () => ok("version 1.2.3; injected"), home)).rejects.toThrow("No exact T3 version")
})
const access = { alias: "demo.asidee", user: "agent", home: "/home/agent", batchReady: true, loopbackForwarding: true }
test("SSH access is read from the core and checked field by field", async () => {
  expect(await sshAccess(async () => ok(JSON.stringify({ ok: true, data: { ...access, extra: "dropped" } })), "demo")).toEqual(access)
  for (const reply of [{ ok: false, error: { code: "not-found", message: "x" } }, { ok: true, data: { ...access, alias: "other.asidee" } }, { ok: true, data: { ...access, batchReady: "yes" } }, { ok: true, data: { ...access, home: 1 } }])
    await expect(sshAccess(async () => ok(JSON.stringify(reply)), "demo")).rejects.toThrow("Invalid SSH access response")
  await expect(sshAccess(async () => ok("{}"), "../x")).rejects.toThrow("lowercase")
})
test("T3 setup only execs its installer and provider sync after resolving the host version", async () => {
  const home = await fixture(), calls: string[][] = []
  const ready = await setup(async argv => {
    calls.push(argv)
    if (argv[0] === "t3") return ok(`t3 ${version}`)
    if (argv[1] === "ssh") return ok(JSON.stringify({ ok: true, data: access }))
    if (argv.at(-1) === "https://github.com/pingdotgg/t3code/releases/download") return ok("installed\n")
    return ok(argv.at(-1)?.includes("T3CODE_SERVER_BROWSER_SANDBOX") ? "set\n" : '{"claude":0,"codex":0}')
  }, "demo", home)
  expect(ready).toEqual({ version, runtime: "installed", chromeSandboxOff: true, claude: 0, codex: 0, ssh: access })
  expect(calls.slice(1, -1).every(argv => argv.slice(0, 3).join(" ") === "asd exec demo")).toBe(true)
  expect(calls.at(-1)).toEqual(["asd", "ssh", "access", "demo", "--json"])
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
    const script = await guest("download.cjs", "install.cjs"), execute = local(home)
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
  expect(settings.providerInstances["asidee-codex-canonical"].config.homePath).toBe(join(home, ".codex"))
  expect(settings.providerInstances.claudeAgent.environment).toContainEqual({ name: "ANTHROPIC_API_KEY", value: "", sensitive: false })
  expect(settings.providerInstances.claudeAgent.environment).toContainEqual({ name: "IS_SANDBOX", value: "1", sensitive: false })
  expect(settings.theme).toBe("light"); expect((await lstat(join(home, ".t3/userdata/settings.json"))).mode & 0o777).toBe(0o600)
  expect(settings.asideeProviderInstances).toBeUndefined()
  expect((await lstat(join(home, ".t3/userdata/asidee-providers.json"))).mode & 0o777).toBe(0o600)
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
      if (!edited && String(file).includes('asidee-providers.json.')) {
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
    const script = await guest("download.cjs", "install.cjs")
    expect(await must(local(home), ["node", "-e", prefix + script, version, server.url.href.replace(/\/$/, "")])).toBe("installed")
    expect(await readFile(join(home, "executed"), "utf8")).toBe("verified")
  } finally { server.stop(true) }
})

test("T3 setup turns Chrome's sandbox off only for a root T3, in a block at the top of ~/.bashrc", async () => {
  const home = await fixture(), execute = local(home), file = join(home, ".bashrc")
  const block = "# Asidee T3 extension: T3 runs as root here, and Chrome refuses its own sandbox as root, so T3's browser runs without it.\nexport T3CODE_SERVER_BROWSER_SANDBOX=0\n# End of the Asidee T3 extension block.\n"
  await put(home, ".bashrc", "[ -z \"$PS1\" ] && return\nalias x=y\n")
  const script = await guest("environment.cjs")
  expect(await must(execute, ["node", "-e", script])).toBe("not-root")
  expect(await readFile(file, "utf8")).toBe("[ -z \"$PS1\" ] && return\nalias x=y\n")
  for (let run = 0; run < 2; run++) {
    expect(await must(execute, ["node", "-e", "process.getuid = () => 0;" + script])).toBe("set")
    expect(await readFile(file, "utf8")).toBe(block + "[ -z \"$PS1\" ] && return\nalias x=y\n")
  }
  await rm(file)
  expect(await must(execute, ["node", "-e", "process.getuid = () => 0;" + script])).toBe("set")
  expect(await readFile(file, "utf8")).toBe(block)
})

test("the browser install takes T3's pinned Chrome only when it matches T3's checksum, then runs T3's own setup", async () => {
  const root = await fixture(), home = await fixture(), execute = local(root), top = "chrome-headless-shell-linux-arm64"
  await put(root, `${top}/chrome-headless-shell`, "#!/bin/sh\n"); await chmod(join(root, top, "chrome-headless-shell"), 0o755)
  await must(execute, ["sh", "-c", `cd "$1" && zip -qr browser.zip ${top}`, "sh", root])
  const zip = await readFile(join(root, "browser.zip")), sha = createHash("sha256").update(zip).digest("hex")
  const t3 = (hash: string) => `#!/bin/sh\necho "$@" > "$HOME/setup-ran"\n: 'var init_PreviewBrowserHost = 1;\nvar init_PreviewBrowser = x;\n\tVERSION = "157.0.8103.38";\n\tARCHIVES = {\n\t\t"linux-arm64": {\n\t\t\tbytes: ${zip.length},\n\t\t\tsha256: "${hash}"\n\t\t}\n\t};\n\turl: \`https://storage.googleapis.com/chrome-for-testing-public/\${VERSION}/\${chrome}/chrome-headless-shell-\${chrome}.zip\`'\n`
  const binary = join(home, `.t3/runtime/versions/${version}/t3`)
  const fake = `require("os").platform = () => "linux"; require("os").arch = () => "arm64"; process.getuid = () => 0;
    function download(url, file) { require("fs").appendFileSync(require("path").join(require("os").homedir(), "downloads"), url + "\\n"); require("fs").copyFileSync(${JSON.stringify(join(root, "browser.zip"))}, file); return Promise.resolve() }\n`
  const script = await guest("download.cjs") + fake + await guest("browser.cjs"), run = local(home)
  const dest = join(home, ".t3/tools/chrome-headless-shell/linux-arm64/157.0.8103.38/chrome-headless-shell")
  await put(home, `.t3/runtime/versions/${version}/t3`, t3("0".repeat(64))); await chmod(binary, 0o755)
  const refused = await run(["node", "-e", script, version])
  expect(refused.exitCode).not.toBe(0); expect(refused.stderr).toContain("t3-browser: The browser download did not match T3's checksum")
  expect(await Bun.file(dest).exists()).toBe(false); expect(await Bun.file(join(home, "setup-ran")).exists()).toBe(false)
  await put(home, `.t3/runtime/versions/${version}/t3`, t3(sha))
  expect(JSON.parse(await must(run, ["node", "-e", script, version]))).toEqual({ chrome: "157.0.8103.38", browser: "installed" })
  expect(await Bun.file(dest).exists()).toBe(true)
  expect(await readFile(join(home, "setup-ran"), "utf8")).toBe(`browser setup --base-dir ${join(home, ".t3")}\n`)
  expect(await readFile(join(home, "downloads"), "utf8")).toBe("https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux-arm64/chrome-headless-shell-linux-arm64.zip\n".repeat(2))
  expect(JSON.parse(await must(run, ["node", "-e", script, version]))).toEqual({ chrome: "157.0.8103.38", browser: "present" })
  expect((await readFile(join(home, "downloads"), "utf8")).split("\n").length).toBe(3)
})

test("a failed browser install shows only the installer's own message", async () => {
  const home = await fixture()
  const reply = (stderr: string) => async (argv: string[]) => argv[0] === "t3" ? ok(`t3 ${version}`) : { exitCode: 1, stdout: "", stderr }
  await expect(browser(reply("token-secret\nt3-browser: Set up T3 Code first.\n"), "demo", home)).rejects.toThrow(/^Set up T3 Code first\.$/)
  await expect(browser(reply("token-secret\n"), "demo", home)).rejects.toThrow("T3's browser install failed; output withheld.")
  await expect(browser(reply("t3-browser: x"), "../x", home)).rejects.toThrow("lowercase")
})
