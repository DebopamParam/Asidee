import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { parseExtension } from "../../core/extensions"
import { execute, type Runner } from "../../extensions/logins/client"
import { discoverProfiles, hostGithubToken, keychainServices, readCredential, type Host } from "../../extensions/logins/credentials"
import { GUEST } from "../../extensions/logins/guest"
import { main, readToken } from "../../extensions/logins/login"
import { importGithub, importLogin, listLogins, logout } from "../../extensions/logins/logins"
import { cleanConfig, collectSetup, referencedHomePaths } from "../../extensions/logins/setup"
import manifest from "../../extensions/logins/extension.json"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function home() { const path = await mkdtemp(join(tmpdir(), "asidee-login-unit-")); roots.push(path); return path }
async function put(root: string, name: string, text: string, mode = 0o600) {
  const path = join(root, name); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, text, { mode })
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"))
const secret = "ghp_unit_test_credential_never_in_argv_123456789"
const credential = JSON.stringify({ tokens: { id_token: `x.${Buffer.from(JSON.stringify({ email: "agent@example.com" })).toString("base64url")}.sig`, refresh_token: secret } })

// Fake the transport only. The exact guest program runs against a temporary HOME, without any sandbox or engine.
function guestRunner(guestHome: string, prefix = "") {
  const calls: Array<{ argv: string[]; stdin?: string }> = []
  const runner: Runner = async (argv, stdin) => {
    calls.push({ argv: [...argv], stdin })
    expect(argv[0]).toBe("asd"); expect(argv[1]).toBe("exec"); expect(argv[2]).toBe("demo")
    expect(argv.join(" ")).not.toContain(secret)
    const at = argv.indexOf("--")
    expect(argv.slice(at + 1, at + 3)).toEqual(["node", "-e"])
    expect(argv.includes("--stream")).toBe(stdin !== undefined)
    const child = Bun.spawn([process.execPath, "-e", prefix + argv[at + 3], ...argv.slice(at + 4)], {
      env: { ...process.env, HOME: guestHome, XDG_CONFIG_HOME: join(guestHome, ".config"), GH_CONFIG_DIR: join(guestHome, ".config/gh") },
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stdout).not.toContain(secret); expect(stderr).not.toContain(secret)
    return { exitCode, stdout, stderr }
  }
  return { runner, calls }
}
const host = (root: string, runner: Runner): Host => ({ home: root, platform: "linux", runner })

test("bundled manifest loads and exposes no secret input field", () => {
  const parsed = parseExtension("logins", "/unused", manifest)
  expect(parsed.actions.map((action) => action.id)).toEqual(["import", "github", "list", "logout", "profiles"])
  expect(parsed.actions.flatMap((action) => action.fields).some((field) => /token|secret/.test(field.id))).toBe(false)
})

test("imports one profile via stdin, writes 0600 atomically, overwrites on a second import, and keeps host logged in", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".codex-work/auth.json", credential); await put(h, ".codex-other/auth.json", '{"secret":"not-selected"}')
  expect(await discoverProfiles("codex", host(h, transport.runner))).toEqual(["other", "work"])
  const options = { name: "demo", agent: "codex", profile: "work", setup: false } satisfies Parameters<typeof importLogin>[1]
  expect(await importLogin(host(h, transport.runner), options)).toEqual({ agent: "codex", profile: "work", files: 0, missingCommands: 0, missingCommandNames: [] })
  const dest = join(g, ".codex-work/auth.json")
  expect(await readFile(dest, "utf8")).toBe(credential)
  expect((await stat(dest)).mode & 0o777).toBe(0o600)
  expect((await stat(join(g, ".codex-work"))).mode & 0o777).toBe(0o700)
  expect(await readdir(join(g, ".codex-work"))).toEqual(["auth.json"])
  expect(existsSync(join(g, ".codex-other"))).toBe(false)
  expect(transport.calls[0]?.stdin).toContain(secret)
  // Importing again is the choice to overwrite: a newer host login replaces the one inside.
  const newer = credential.replace("refresh_token", "refresh_token_newer")
  await put(h, ".codex-work/auth.json", newer)
  await importLogin(host(h, transport.runner), options)
  expect(await readFile(dest, "utf8")).toBe(newer)
  await put(h, ".codex-work/auth.json", credential)
  expect(await listLogins(transport.runner, "demo")).toEqual([{ agent: "codex", profile: "work", account: "agent@example.com" }])
  expect(await logout(transport.runner, "demo", { agent: "codex", profile: "work" })).toEqual([{ agent: "codex", profile: "work", account: "agent@example.com", removed: true, stopped: 0 }])
  expect(existsSync(dest)).toBe(false)
  expect(await readFile(join(h, ".codex-work/auth.json"), "utf8")).toBe(credential)
})

test("validates credential JSON and rejects symlinked, oversized or non-regular host sources without leaking content", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  for (const text of [secret, `{"oops":"${secret}",`, "[]", "null", "1"]) {
    await put(h, ".codex/auth.json", text)
    await expect(readCredential("codex", "default", host(h, transport.runner))).rejects.toThrow("contents withheld")
  }
  await put(h, ".codex/auth.json", " ".repeat(1024 * 1024 + 1))
  await expect(readCredential("codex", "default", host(h, transport.runner))).rejects.toThrow("1 MiB")
  await rm(join(h, ".codex/auth.json")); await symlink("/does-not-exist", join(h, ".codex/auth.json"))
  await expect(readCredential("codex", "default", host(h, transport.runner))).rejects.toThrow("Symlinked")
  await rm(join(h, ".codex"), { recursive: true }); await put(h, "elsewhere/auth.json", credential); await symlink(join(h, "elsewhere"), join(h, ".codex"))
  await expect(readCredential("codex", "default", host(h, transport.runner))).rejects.toThrow("Symlinked")
  expect(transport.calls).toHaveLength(0)
})

test("Keychain takes precedence, supports canonical and trailing-slash hashes and hex, and never leaks lookup output", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g), calls: string[][] = []
  await put(h, ".claude-work/.credentials.json", '{"access_token":"stale"}')
  const services = keychainServices("work", h), service = services[1]
  expect(keychainServices("default", h)[0]).toBe("Claude Code-credentials")
  const runner: Runner = async (argv, stdin) => {
    calls.push(argv); expect(argv.join(" ")).not.toContain(secret)
    if (argv[0] !== "security") return transport.runner(argv, stdin)
    return { exitCode: argv[3] === service ? 0 : 44, stdout: argv.includes("-w") ? Buffer.from(credential).toString("hex") : "attributes only", stderr: secret }
  }
  const source: Host = { home: h, platform: "darwin", runner }
  expect(await discoverProfiles("claude", source)).toEqual(["work"])
  expect(calls.every((argv) => !argv.includes("-w"))).toBe(true)
  await importLogin(source, { name: "demo", agent: "claude", profile: "work", setup: false })
  expect(await readFile(join(g, ".claude-work/.credentials.json"), "utf8")).toBe(credential)
  const denied: Runner = async (argv) => ({ exitCode: argv.includes("-w") ? 51 : 0, stdout: secret, stderr: secret })
  await expect(readCredential("claude", "work", { ...source, runner: denied })).rejects.toThrow("denied or failed; contents withheld")
})

test("guest validates JSON itself, rejects credential symlinks and unsafe setup ancestors, and publishes only complete files", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await expect(execute(transport.runner, "demo", GUEST, ["import", "codex", "work", "create"], JSON.stringify({ credential: secret }))).rejects.toThrow("failed")
  expect(existsSync(join(g, ".codex-work/auth.json"))).toBe(false)
  await put(h, "auth.json", "untouched")
  await mkdir(join(g, ".codex-work")); await symlink(join(h, "auth.json"), join(g, ".codex-work/auth.json"))
  await expect(execute(transport.runner, "demo", GUEST, ["import", "codex", "work"], JSON.stringify({ credential }))).rejects.toThrow("failed")
  expect(await readFile(join(h, "auth.json"), "utf8")).toBe("untouched")
  await rm(join(g, ".codex-work/auth.json")); await symlink(h, join(g, ".codex-work/skills"))
  const setup = { hostHome: h, files: [{ path: "skills/a.md", data: Buffer.from("setup").toString("base64") }], homeFiles: [] }
  await expect(execute(transport.runner, "demo", GUEST, ["import", "codex", "work", "create"], JSON.stringify({ credential, setup }))).rejects.toThrow("failed")
  expect(existsSync(join(h, "a.md"))).toBe(false); expect(existsSync(join(g, ".codex-work/auth.json"))).toBe(false)
  expect((await readdir(join(g, ".codex-work"))).some((name) => name.startsWith(".login-"))).toBe(false)
})

test("copies only allowlisted symlinked Claude setup, scripts and state, rewrites paths, and reports missing commands", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".claude-work/.credentials.json", credential)
  await put(h, ".claude/settings.json", JSON.stringify({ model: "opus", mcpServers: { private: { token: secret } }, enabledPlugins: { private: true }, hooks: { PreToolUse: [{ hooks: [{ command: "asidee-missing-unit-hook --argument secret" }, { command: `${h}/.claude-work/hooks/ok.sh` }] }] }, statusLine: { command: "sh ~/.config/ai/status.sh" } }))
  await symlink(join(h, ".claude/settings.json"), join(h, ".claude-work/settings.json"))
  await put(h, ".claude/skills/demo/SKILL.md", `read ${h}/project`)
  await put(h, ".claude/skills/demo/node_modules/skip.js", "skip")
  await symlink(join(h, ".claude/skills"), join(h, ".claude-work/skills"))
  await symlink(join(h, ".claude/skills"), join(h, ".claude/skills/demo/recursive-directory-link"))
  await put(h, ".claude-work/CLAUDE.md", "top-level")
  await put(h, ".claude-work/keybindings.json", "[]")
  await put(h, ".claude-work/hooks/ok.sh", "#!/bin/sh\n", 0o700)
  await put(h, ".claude-work/plugins/private/file", secret); await put(h, ".claude-work/history.jsonl", secret); await put(h, ".claude-work/projects/transcript.json", secret)
  await put(h, ".claude-work/.claude.json", JSON.stringify({ oauthAccount: { emailAddress: "claude@example.com" }, theme: "dark", projects: { secret }, mcpServers: { private: secret } }))
  await put(h, ".config/ai/status.sh", `#!/bin/sh\n# ${h}/project ccstatusline\n`, 0o700)
  await put(h, ".config/ccstatusline/settings.json", "{}")
  const bundle = await collectSetup("claude", "work", h)
  expect(bundle.files.map((file) => file.path)).toEqual(["CLAUDE.md", "hooks/ok.sh", "keybindings.json", "settings.json", "skills/demo/SKILL.md"])
  expect(bundle.homeFiles.map((file) => file.path)).toEqual([".config/ai/status.sh", ".config/ccstatusline/settings.json"])
  expect(JSON.stringify(bundle)).not.toContain(secret)
  const result = await importLogin(host(h, transport.runner), { name: "demo", agent: "claude", profile: "work", setup: true })
  expect(result.files).toBe(7); expect(result.missingCommands).toBe(1)
  expect(result.missingCommandNames).toEqual(["asidee-missing-unit-hook"])
  expect(await readFile(join(g, ".config/ai/status.sh"), "utf8")).toContain(`${g}/project`)
  expect(await readFile(join(g, ".claude-work/skills/demo/SKILL.md"), "utf8")).toBe(`read ${g}/project`)
  expect((await stat(join(g, ".claude-work/hooks/ok.sh"))).mode & 0o777).toBe(0o700)
  const settings = await readFile(join(g, ".claude-work/settings.json"), "utf8")
  expect(settings).not.toContain(h); expect(settings).not.toContain("mcpServers"); expect(settings).not.toContain("enabledPlugins")
  expect(await json(join(g, ".claude-work/.claude.json"))).toEqual({ oauthAccount: { emailAddress: "claude@example.com" }, theme: "dark" })
  expect(await listLogins(transport.runner, "demo")).toEqual([{ agent: "claude", profile: "work", account: "claude@example.com" }])
  await logout(transport.runner, "demo", "all")
  expect(await json(join(g, ".claude-work/.claude.json"))).toEqual({ theme: "dark" })
  expect(existsSync(join(g, ".claude-work/CLAUDE.md"))).toBe(true)
})

test("Codex setup follows a profile-directory link but strips every TOML spelling of MCP definitions", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, "dotfiles/config.toml", `model = "gpt-test"\ncwd = "${h}/project"\n[mcp_servers.private]\ncommand = "secret"\n[profiles.work]\nmodel = "other"\n`)
  await put(h, "dotfiles/AGENTS.md", "instructions"); await put(h, "dotfiles/prompts/a.md", "prompt")
  await symlink(join(h, "dotfiles"), join(h, ".codex-work"))
  const bundle = await collectSetup("codex", "work", h)
  expect(bundle.files.map((file) => file.path)).toEqual(["AGENTS.md", "config.toml", "prompts/a.md"])
  const setupResponse = await execute(transport.runner, "demo", GUEST, ["import", "codex", "work", "create"], JSON.stringify({ credential, setup: bundle }))
  expect(setupResponse).toMatchObject({ files: 3 })
  const copied = Bun.TOML.parse(await readFile(join(g, ".codex-work/config.toml"), "utf8"))
  expect(copied).toEqual({ model: "gpt-test", cwd: `${g}/project`, profiles: { work: { model: "other" } } })
  for (const text of ['"mcp_servers" = { private = { token = "secret" } }\nmodel="a"', 'mcp_servers.private.command="secret"\nmodel="a"', '["mcp_servers"."private"]\ncommand="secret"']) {
    expect(cleanConfig("codex", text)).not.toContain("secret")
  }
  expect(referencedHomePaths(["bash ~/.config/a.sh", "${HOME}/b.sh", "$HOME/c.sh", `${h}/d.sh`, "~/../escape"], h)).toEqual([".config/a.sh", "b.sh", "c.sh", "d.sh"])
})

// HTTPS and gh/git are fixtures here; no real account, credential store, or network is contacted.
const githubFixture = String.raw`
const childProcess = require("child_process")
childProcess.spawnSync = (command, args) => {
  const fs = require("fs"), file = require("path").join(require("os").homedir(), "git-calls.jsonl")
  fs.appendFileSync(file, JSON.stringify([command, ...args]) + "\n")
  return { status: 0 }
}
require("https").get = (_url, _opts, callback) => {
  const { EventEmitter } = require("events"), req = new EventEmitter(), res = new EventEmitter()
  req.setTimeout = () => {}; req.destroy = () => {}; res.statusCode = 200
  queueMicrotask(() => { callback(res); res.emit("data", '{"login":"octocat"}'); res.emit("end") })
  return req
}
`

test("GitHub token and named host gh login travel only on stdin; guest storage is private and logout preserves other hosts", async () => {
  const g = await home(), transport = guestRunner(g, githubFixture), hostCalls: string[][] = []
  await put(g, ".config/gh/hosts.yml", "enterprise.example:\n    user: enterprise\n    oauth_token: keep-enterprise\n")
  const runner: Runner = async (argv, stdin) => {
    if (argv[0] !== "gh") return transport.runner(argv, stdin)
    hostCalls.push(argv); return { exitCode: 0, stdout: `${secret}\n`, stderr: secret }
  }
  expect(await importGithub(runner, "demo", { kind: "host", account: "octocat" })).toEqual({ agent: "github", profile: "~", account: "octocat" })
  expect(hostCalls).toEqual([["gh", "auth", "token", "--hostname", "github.com", "--user", "octocat"]])
  const config = join(g, ".config/gh/hosts.yml")
  expect((await stat(config)).mode & 0o777).toBe(0o600)
  expect(await readFile(config, "utf8")).toContain(secret)
  expect(await readFile(join(g, "git-calls.jsonl"), "utf8")).not.toContain(secret)
  await importGithub(runner, "demo", { kind: "token", value: secret })
  expect(await listLogins(transport.runner, "demo")).toEqual([{ agent: "github", profile: "~", account: "octocat" }])
  await logout(transport.runner, "demo", { agent: "github", profile: "~" })
  expect(await readFile(config, "utf8")).toContain("keep-enterprise")
  expect(await readFile(config, "utf8")).not.toContain(secret)
  expect(await listLogins(transport.runner, "demo")).toEqual([])
})

test("listing includes canonical API-key profiles, logout all removes all copies, and symlinks are skipped", async () => {
  const g = await home(), outside = await home(), transport = guestRunner(g)
  await put(g, ".codex/auth.json", JSON.stringify({ OPENAI_API_KEY: secret })); await put(g, ".claude-work/.credentials.json", credential)
  await put(g, ".claude-work/.claude.json", JSON.stringify({ oauthAccount: { emailAddress: "claude@example.com" }, projects: { keep: true } }))
  await put(outside, "auth.json", credential); await symlink(outside, join(g, ".codex-linked"))
  await mkdir(join(g, ".codex-no-login"))
  expect(await listLogins(transport.runner, "demo")).toEqual([{ agent: "claude", profile: "work", account: "claude@example.com" }, { agent: "codex", profile: "~", account: "API key" }])
  expect(await logout(transport.runner, "demo", "all")).toHaveLength(2)
  expect(await json(join(g, ".claude-work/.claude.json"))).toEqual({ projects: { keep: true } })
  expect(await readFile(join(outside, "auth.json"), "utf8")).toBe(credential)
  expect(await listLogins(transport.runner, "demo")).toEqual([])
})

test("failed runner output, spawn errors, invalid JSON and CLI parsing never become secret-bearing errors", async () => {
  const errorRunner: Runner = async () => { throw new Error(secret) }
  const outputRunner: Runner = async () => ({ exitCode: 1, stdout: secret, stderr: secret })
  await expect(hostGithubToken(errorRunner)).rejects.toThrow("Could not read")
  for (const runner of [errorRunner, outputRunner]) {
    try { await importGithub(runner, "demo", { kind: "token", value: secret }); throw new Error("should fail") }
    catch (error) { expect(String(error)).not.toContain(secret) }
  }
  await expect(main(["github", "demo", "--token", secret])).rejects.toThrow("Never pass tokens in arguments")
  await expect(execute(async () => ({ exitCode: 0, stdout: secret, stderr: "" }), "demo", GUEST, ["list"])).rejects.toThrow("contents withheld")
})

test("terminal stdin and manifest fields work through a fake asd command without putting secrets in argv", async () => {
  const h = await home(), g = await home(), bin = join(h, "bin")
  await put(h, "bin/asd", `#!${process.execPath}\nconst fs = require("fs");\nfs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\nconst args = process.argv.slice(2), at = args.indexOf("--");\nconst child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(githubFixture)} + args[at + 3], ...args.slice(at + 4)], { env: { ...process.env, HOME: process.env.GUEST_HOME }, stdin: args.includes("--stream") ? new Blob([await Bun.stdin.text()]) : "ignore", stdout: "inherit", stderr: "inherit" });\nprocess.exitCode = await child.exited;\n`, 0o700)
  const env = { ...process.env, HOME: h, GH_CONFIG_DIR: join(g, ".config/gh"), XDG_CONFIG_HOME: join(g, ".config"), PATH: `${bin}:${process.env.PATH}`, GUEST_HOME: g, CALLS: join(h, "calls.jsonl") }
  const cli = join(import.meta.dir, "../../extensions/logins/login.ts")
  const invoke = async (args: string[], input?: string, fields: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { env: { ...env, ...fields }, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stdout).not.toContain(secret); expect(stderr).not.toContain(secret)
    return { exitCode, stdout, stderr }
  }
  const github = await invoke(["github", "demo"], `${secret}\n`)
  expect(github.exitCode).toBe(0); expect(github.stdout).toContain("There is no secret proxy")
  await put(h, ".codex-work/auth.json", credential)
  const imported = await invoke(["import"], undefined, { ASIDEE_SANDBOX: "demo", ASIDEE_FIELD_AGENT: "codex", ASIDEE_FIELD_PROFILE: "work", ASIDEE_FIELD_SETUP: "false", ASIDEE_FIELD_REPLACE: "false" })
  expect(imported.exitCode).toBe(0); expect(imported.stdout).toContain('CODEX_HOME="$HOME/.codex-work" codex')
  expect((await invoke(["list", "demo"])).stdout).toContain("octocat")
  expect((await invoke(["logout", "demo", "all"])).exitCode).toBe(0)
  expect(await readFile(env.CALLS, "utf8")).not.toContain(secret)
  expect(await readdir(g)).not.toContain(".asidee-logins.lock")
})

test("guest mutations refuse a concurrent writer and never advise replacing to bypass its lock", async () => {
  const g = await home(), transport = guestRunner(g)
  await mkdir(join(g, ".asidee-logins.lock"))
  await expect(importGithub(transport.runner, "demo", { kind: "token", value: secret })).rejects.toThrow("Another login operation")
  expect(existsSync(join(g, ".config/gh/hosts.yml"))).toBe(false)
})

test("logout session matching targets only the selected profile, HOME and agent using fake proc data", async () => {
  const g = await home()
  await put(g, ".codex-work/auth.json", credential)
  const prefix = `
    const fixtureFs = require("fs"), originalRead = fixtureFs.readFileSync, originalDir = fixtureFs.readdirSync;
    const h = require("os").homedir();
    fixtureFs.readdirSync = (p, ...args) => p === "/proc" ? ["101", "102", "103", "104"] : originalDir(p, ...args);
    fixtureFs.readFileSync = (p, ...args) => {
      if (!String(p).startsWith("/proc/")) return originalRead(p, ...args);
      const pid = p.split("/")[2];
      if (p.endsWith("/cmdline")) return (pid === "103" ? "bash" : "codex") + "\\0";
      return "HOME=" + (pid === "104" ? "/other" : h) + "\\0CODEX_HOME=" + h + (pid === "102" ? "/.codex-other" : "/.codex-work") + "\\0";
    };
    process.kill = (pid) => { if (pid !== 101) throw new Error("wrong process"); return true; };
  `
  const transport = guestRunner(g, prefix)
  expect(await logout(transport.runner, "demo", { agent: "codex", profile: "work" })).toEqual([{ agent: "codex", profile: "work", account: "agent@example.com", removed: true, stopped: 1 }])
})

test("hidden token prompt never echoes input and restores terminal mode on completion or cancellation", async () => {
  const modes: boolean[] = [], output: string[] = []
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode: (mode: boolean) => { modes.push(mode) } })
  const value = readToken(input, { write: (text) => output.push(text) })
  input.write(`${secret}x\u007f\r`)
  expect(await value).toBe(secret)
  expect(modes).toEqual([true, false]); expect(output.join("")).not.toContain(secret)
  const cancelled = readToken(input, { write: (text) => output.push(text) })
  input.write(`${secret}\u0003`)
  await expect(cancelled).rejects.toThrow("cancelled")
  expect(modes).toEqual([true, false, true, false]); expect(output.join("")).not.toContain(secret)
  expect(input.listenerCount("data")).toBe(0)
  input.destroy()
})

test("GitHub rejects an invalid account token without storing it or returning response contents", async () => {
  const g = await home(), prefix = githubFixture.replace('res.statusCode = 200', 'res.statusCode = 401')
  const transport = guestRunner(g, prefix)
  await expect(importGithub(transport.runner, "demo", { kind: "token", value: secret })).rejects.toThrow("GitHub did not accept that token")
  expect(existsSync(join(g, ".config/gh/hosts.yml"))).toBe(false)
  expect(existsSync(join(g, ".asidee-logins.lock"))).toBe(false)
})

test("successful guest login responses cannot return arbitrary account text or missing-command secrets", async () => {
  const h = await home()
  await put(h, ".codex-work/auth.json", credential)
  const response = (value: unknown): Runner => async () => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: secret })
  await expect(listLogins(response([{ agent: "codex", profile: "work", account: secret }]), "demo")).rejects.toThrow("withheld")
  // A C1 control (single-byte CSI) in a label could rewrite the terminal that prints it.
  await expect(listLogins(response([{ agent: "claude", profile: "work", account: "agent@ex\u009b2Jample.com" }]), "demo")).rejects.toThrow("withheld")
  for (const missingCommands of [["\u001b]0;spoof\u0007"], [1], -1]) {
    await expect(importLogin(host(h, response({ files: 0, missingCommands })), { name: "demo", agent: "codex", profile: "work", setup: false })).rejects.toThrow("withheld")
  }
  // Without a copied setup there is no command for the guest to report.
  await expect(importLogin(host(h, response({ files: 0, missingCommands: ["claude-statusline"] })), { name: "demo", agent: "codex", profile: "work", setup: false })).rejects.toThrow("withheld")
})

test("copied setup drops secret-named settings and TOML keys but keeps the rest", async () => {
  const h = await home()
  await put(h, ".claude-work/.credentials.json", credential)
  await put(h, ".claude-work/settings.json", JSON.stringify({ model: "opus", apiKeyHelper: "~/bin/key.sh", includeCoAuthoredBy: false, env: { OTHER: "keep", ANTHROPIC_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret, AWS_SECRET_ACCESS_KEY: secret, DB_PASSWORD: secret } }))
  const claude = await collectSetup("claude", "work", h)
  expect(claude.files.map((file) => Buffer.from(file.data, "base64").toString("utf8")).join("\n")).not.toContain(secret)
  expect(JSON.parse(Buffer.from(claude.files.find((file) => file.path === "settings.json")!.data, "base64").toString("utf8"))).toEqual({ model: "opus", apiKeyHelper: "~/bin/key.sh", includeCoAuthoredBy: false, env: { OTHER: "keep" } })
  const toml = `model = "gpt"\nmodel_max_output_tokens = 10\n[model_providers.corp]\nenv_key = "CORP_KEY"\nexperimental_bearer_token = "${secret}"\nhttp_headers = { Authorization = "${secret}" }\n[shell_environment_policy.set]\nGITHUB_TOKEN = "${secret}"\n`
  expect(cleanConfig("codex", toml)).not.toContain(secret)
  expect(Bun.TOML.parse(cleanConfig("codex", toml))).toEqual({ model: "gpt", model_max_output_tokens: 10, model_providers: { corp: { env_key: "CORP_KEY" } }, shell_environment_policy: { set: {} } })
})

test("Claude subscription imports clear a competing API key even without copying setup", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".claude-work/.credentials.json", credential)
  await put(g, ".claude-work/settings.json", JSON.stringify({ model: "keep", env: { OTHER: "keep", ANTHROPIC_API_KEY: secret } }))
  await importLogin(host(h, transport.runner), { name: "demo", agent: "claude", profile: "work", setup: false })
  expect(await json(join(g, ".claude-work/settings.json"))).toEqual({ model: "keep", env: { OTHER: "keep", ANTHROPIC_API_KEY: "" } })
})

test("a profile whose settings.json links to a shared one is imported into, and Claude's own signed-out file is no login", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".claude-deb/.credentials.json", credential)
  // As profile launchers lay a sandbox out: the profile links to the shared settings, and Claude logged out, leaving empty tokens.
  await put(g, ".claude/settings.json", JSON.stringify({ model: "shared" }))
  await mkdir(join(g, ".claude-deb"), { recursive: true })
  await symlink(join(g, ".claude/settings.json"), join(g, ".claude-deb/settings.json"))
  await put(g, ".claude-deb/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } }))
  expect(await listLogins(transport.runner, "demo")).toEqual([])
  await importLogin(host(h, transport.runner), { name: "demo", agent: "claude", profile: "deb", setup: false })
  expect(await readFile(join(g, ".claude-deb/.credentials.json"), "utf8")).toBe(credential)
  expect((await lstat(join(g, ".claude-deb/settings.json"))).isSymbolicLink()).toBe(true)
  expect(await json(join(g, ".claude/settings.json"))).toEqual({ model: "shared", env: { ANTHROPIC_API_KEY: "" } })
  // A link out of the home is still refused, and nothing is written through it.
  const outside = await home()
  await put(outside, "settings.json", "{}")
  await rm(join(g, ".claude-deb/settings.json")); await symlink(join(outside, "settings.json"), join(g, ".claude-deb/settings.json"))
  await expect(importLogin(host(h, transport.runner), { name: "demo", agent: "claude", profile: "deb", setup: false })).rejects.toThrow()
  expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("{}")
})

test("ambiguous duplicate GitHub YAML sections are refused before logout or replacement", async () => {
  const g = await home(), transport = guestRunner(g, githubFixture)
  const text = `github.com:\n    oauth_token: first\ngithub.com:\n    oauth_token: ${secret}\n`
  await put(g, ".config/gh/hosts.yml", text)
  await expect(logout(transport.runner, "demo", { agent: "github", profile: "~" })).rejects.toThrow("failed")
  expect(await readFile(join(g, ".config/gh/hosts.yml"), "utf8")).toBe(text)
})

test("invalid Claude logout metadata fails before deleting its credential", async () => {
  const g = await home(), transport = guestRunner(g)
  await put(g, ".claude-work/.credentials.json", credential)
  await put(g, ".claude-work/.claude.json", "invalid")
  await expect(logout(transport.runner, "demo", { agent: "claude", profile: "work" })).rejects.toThrow("failed")
  expect(await readFile(join(g, ".claude-work/.credentials.json"), "utf8")).toBe(credential)
})

test("a secret used as a missing hook name is withheld even in a successful setup response", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".claude-work/.credentials.json", credential)
  await put(h, ".claude-work/settings.json", JSON.stringify({ statusLine: { command: secret } }))
  const imported = await importLogin(host(h, transport.runner), { name: "demo", agent: "claude", profile: "work", setup: true })
  expect(imported.missingCommands).toBe(1)
  expect(JSON.stringify(imported)).not.toContain(secret)
})

test("missing command diagnostics accept only bounded printable names from the settings actually sent", async () => {
  const h = await home(), g = await home(), transport = guestRunner(g)
  await put(h, ".claude-work/.credentials.json", credential)
  await put(g, ".claude-work/settings.json", JSON.stringify({ statusLine: { command: "old-missing-hook" } }))
  const options = { name: "demo", agent: "claude", profile: "work", setup: true } as const
  expect((await importLogin(host(h, transport.runner), options)).missingCommands).toBe(0)
  await put(h, ".claude-work/settings.json", JSON.stringify({ statusLine: { command: "new-missing-hook" } }))
  for (const names of [[secret], ["not-sent"], ["bad\u001b"], ["a".repeat(161)], Array(65).fill("new-missing-hook")]) {
    const runner: Runner = async () => ({ exitCode: 0, stdout: JSON.stringify({ files: 1, missingCommands: 65, missingCommandNames: names }), stderr: "" })
    await expect(importLogin(host(h, runner), options)).rejects.toThrow("withheld")
  }
})

test("JSON and TOML home rewrites escape guest path characters", async () => {
  const h = await home(), root = await home(), g = join(root, 'guest"\\home')
  await mkdir(g)
  const transport = guestRunner(g)
  for (const agent of ["claude", "codex"] as const) {
    await put(h, `.${agent}-work/${agent === "claude" ? ".credentials.json" : "auth.json"}`, credential)
    await put(h, `.${agent}-work/${agent === "claude" ? "settings.json" : "config.toml"}`, agent === "claude" ? JSON.stringify({ model: "keep", extra: `${h}/project` }) : `cwd = ${JSON.stringify(`${h}/project`)}\n`)
    await importLogin(host(h, transport.runner), { name: "demo", agent, profile: "work", setup: true })
  }
  expect((await json(join(g, ".claude-work/settings.json"))).extra).toBe(`${g}/project`)
  expect(Bun.TOML.parse(await readFile(join(g, ".codex-work/config.toml"), "utf8"))).toEqual({ cwd: `${g}/project` })
})

test("GitHub import with missing gh or git fails before storing a token or making an API call", async () => {
  for (const missing of ["gh", "git"]) {
    const g = await home(), bin = join(g, "bin")
    await put(g, `bin/${missing === "gh" ? "git" : "gh"}`, "#!/bin/sh\nexit 0\n", 0o700)
    const prefix = `process.env.PATH = ${JSON.stringify(bin)}; require('https').get = () => { require('fs').writeFileSync(require('os').homedir() + '/network-called', 'bad'); throw new Error(); };`
    await expect(importGithub(guestRunner(g, prefix).runner, "demo", { kind: "token", value: secret })).rejects.toThrow("exit 69")
    expect(existsSync(join(g, ".config/gh/hosts.yml"))).toBe(false)
    expect(existsSync(join(g, "network-called"))).toBe(false)
    expect(existsSync(join(g, ".asidee-logins.lock"))).toBe(false)
  }
})
