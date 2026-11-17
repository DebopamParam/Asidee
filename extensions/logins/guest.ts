// Only this fixed program and validated names enter argv. Credentials and setup enter through stdin.
export const GUEST = String.raw`
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process")
const home = path.resolve(os.homedir()), files = { claude: ".credentials.json", codex: "auth.json" }
const [mode, agent, profile, choice] = process.argv.slice(1)
const fail = (code = 65) => { const error = new Error(); error.loginCode = code; throw error }
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x)
const validProfile = (p) => typeof p === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(p)
const dir = (a, p) => path.join(home, p === "~" ? "." + a : "." + a + "-" + p)
const info = (p) => { try { return fs.lstatSync(p) } catch (e) { if (e.code === "ENOENT") return; throw e } }
function safe(p, directory = false) {
  const rel = path.relative(home, p)
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) fail()
  const parts = rel.split(path.sep).filter(Boolean)
  let at = home
  if (!info(home)?.isDirectory()) fail()
  for (let i = 0; i < parts.length; i++) {
    at = path.join(at, parts[i]); const got = info(at)
    if (got && (got.isSymbolicLink() || (i < parts.length - 1 || directory ? !got.isDirectory() : !got.isFile()))) fail()
  }
}
function mkdir(p) { safe(p, true); fs.mkdirSync(p, { recursive: true, mode: 0o700 }) }
function read(p) { safe(p); return info(p) ? fs.readFileSync(p, "utf8") : undefined }
function json(p) {
  const text = read(p)
  if (text === undefined) return {}
  const value = JSON.parse(text); if (!object(value)) fail(66)
  return value
}
function atomic(p, data, mode = 0o600, replace = true) {
  safe(p); mkdir(path.dirname(p))
  const tmp = path.join(path.dirname(p), ".login-" + crypto.randomBytes(12).toString("hex"))
  try {
    fs.writeFileSync(tmp, data, { flag: "wx", mode }); fs.chmodSync(tmp, mode)
    if (replace) fs.renameSync(tmp, p)
    else { try { fs.linkSync(tmp, p) } catch (e) { if (e.code === "EEXIST") fail(67); throw e } }
  } finally { try { fs.unlinkSync(tmp) } catch (e) { if (e.code !== "ENOENT") throw e } }
}
async function input() {
  let size = 0; const chunks = []
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 24 * 1024 * 1024) fail(66); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n")
const email = (x) => typeof x === "string" && x.length <= 254 && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(x) ? x : undefined
const githubUser = (x) => typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(x) ? x : undefined
const accountFile = (a, p) => a === "claude" ? (p === "~" ? path.join(home, ".claude.json") : path.join(dir(a, p), ".claude.json")) : path.join(dir(a, p), files.codex)
function account(a, p) {
  try {
    const value = json(accountFile(a, p))
    if (a === "claude") return email(value.oauthAccount?.emailAddress)
    if (value.OPENAI_API_KEY) return "API key"
    return email(JSON.parse(Buffer.from(value.tokens.id_token.split(".")[1], "base64url").toString("utf8")).email)
  } catch { return undefined }
}
const ghFile = path.resolve(process.env.GH_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "gh"), "hosts.yml")
function githubSection(text) {
  const lines = (text || "").split(/\r?\n/), headings = lines.map((line, index) => /^(?:github\.com|"github\.com"|'github\.com'):\s*$/.test(line) ? index : -1).filter(index => index >= 0)
  if (headings.length > 1) fail(66)
  const start = headings[0] ?? -1
  if (start < 0) {
    if (lines.some((line) => /^\S/.test(line) && !/^#|^[^:]+:\s*$/.test(line))) fail(66)
    return { rest: text || "", section: "" }
  }
  let end = start + 1
  while (end < lines.length && (!/^\S/.test(lines[end]) || /^#/.test(lines[end]))) end++
  return { rest: [...lines.slice(0, start), ...lines.slice(end)].join("\n"), section: lines.slice(start, end).join("\n") }
}
function list() {
  const out = []
  for (const a of ["claude", "codex"]) for (const name of fs.readdirSync(home).sort()) {
    const p = name === "." + a ? "~" : name.startsWith("." + a + "-") ? name.slice(a.length + 2) : undefined
    if (!(p === "~" || validProfile(p))) continue
    const d = dir(a, p), f = path.join(d, files[a])
    if (info(d)?.isDirectory() && info(f)?.isFile()) out.push({ agent: a, profile: p, account: account(a, p) })
  }
  const section = githubSection(read(ghFile)).section
  if (section) {
    const user = /^\s+user:\s*["']?([A-Za-z0-9-]+)["']?\s*$/m.exec(section)?.[1]
    out.push({ agent: "github", profile: "~", account: githubUser(user) })
  }
  return out
}
function commands(settings) {
  const out = []
  if (object(settings.hooks)) for (const groups of Object.values(settings.hooks)) if (Array.isArray(groups)) for (const group of groups) {
    if (Array.isArray(group?.hooks)) for (const hook of group.hooks) if (typeof hook?.command === "string") out.push(hook.command)
  }
  if (typeof settings.statusLine?.command === "string") out.push(settings.statusLine.command)
  return out
}
function missingCommands(settings) {
  const missing = new Set(), builtins = new Set(["cd", "export", "test", "[", "echo", "printf", "true", "false", ":", ".", "source", "exec"])
  const expand = (s) => s.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home)
  const found = (s) => {
    if (builtins.has(s)) return true
    const paths = s.includes("/") ? [s] : (process.env.PATH || "").split(path.delimiter).filter(Boolean).map((p) => path.join(p, s))
    return paths.some((p) => { try { return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true) } catch { return false } })
  }
  for (const command of commands(settings)) for (const part of command.split(/(?:&&|\|\||[;|\n])/)) {
    const tokens = (part.match(/"[^"]*"|'[^']*'|[^\s]+/g) || []).map((s) => expand(s.replace(/^(["'])(.*)\1$/, "$2")))
    while (tokens[0] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] || "")) tokens.shift()
    const first = tokens[0]
    if (first && !first.includes("$") && !found(first)) missing.add(first)
    if (/^(?:bash|sh|zsh|node|python3?|bun)$/.test(path.basename(first || ""))) {
      const script = tokens[1]
      if (script && script.includes("/") && !script.includes("$") && !fs.existsSync(script)) missing.add(script)
    }
  }
  return [...missing]
}
function installSetup(a, p, bundle) {
  const root = dir(a, p), pending = []
  if (!object(bundle) || typeof bundle.hostHome !== "string" || !Array.isArray(bundle.files) || !Array.isArray(bundle.homeFiles)) fail(66)
  const hostPrefix = bundle.hostHome.replace(/\/?$/, "/")
  const add = (file, base) => {
    if (!object(file) || typeof file.path !== "string" || !file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some((s) => s === ".." || ["auth.json", ".credentials.json", ".mcp.json"].includes(s)) || typeof file.data !== "string") fail(65)
    const target = path.resolve(base, file.path); if (!target.startsWith(base + path.sep)) fail()
    safe(target)
    let data = Buffer.from(file.data, "base64")
    const text = data.toString("utf8")
    if (!data.includes(0) && Buffer.from(text).equals(data)) {
      const encoded = file.path.endsWith(".json") || (base === root && file.path === "config.toml")
      const from = encoded ? JSON.stringify(hostPrefix).slice(1, -1) : hostPrefix
      const to = encoded ? JSON.stringify(home + "/").slice(1, -1) : home + "/"
      data = Buffer.from(text.split(from).join(to))
    }
    pending.push({ target, data, mode: file.mode === 0o700 ? 0o700 : 0o600 })
  }
  for (const file of bundle.files) add(file, root)
  for (const file of bundle.homeFiles) add(file, home)
  const stateFile = path.join(root, ".claude.json")
  const state = a === "claude" ? json(stateFile) : {}
  return () => {
    for (const file of pending) atomic(file.target, file.data, file.mode)
    if (a === "claude" && object(bundle.state)) {
      // Account metadata may have been written with the credential after preflight.
      Object.assign(state, json(stateFile))
      for (const key of ["hasCompletedOnboarding", "lastOnboardingVersion", "oauthAccount", "theme", "editorMode"]) if (Object.hasOwn(bundle.state, key)) state[key] = bundle.state[key]
      atomic(stateFile, JSON.stringify(state, null, 2) + "\n")
    }
    const missing = a === "claude" && bundle.files.some((file) => file.path === "settings.json") ? missingCommands(json(path.join(root, "settings.json"))) : []
    return { files: pending.length, missingCommands: missing.length, missingCommandNames: missing.map((name) => name.split(home + "/").join("~/")) }
  }
}
function stopSessions(a, p) {
  let stopped = 0, pids = []
  try { pids = fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x) && Number(x) !== process.pid) } catch {}
  const variable = a === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME", d = dir(a, p)
  for (const pid of pids) {
    let env, cmd
    try { env = fs.readFileSync("/proc/" + pid + "/environ", "utf8").split("\0"); cmd = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\0") } catch { continue }
    if (!env.includes("HOME=" + home) || !cmd.slice(0, 2).some((x) => path.basename(x) === a)) continue
    const selected = env.find((x) => x.startsWith(variable + "="))
    if (selected ? path.resolve(selected.slice(variable.length + 1)) !== d : p !== "~") continue
    try { process.kill(Number(pid), "SIGTERM"); stopped++ } catch {}
  }
  return stopped
}
function logout(login) {
  if (login.agent === "github") {
    const rest = githubSection(read(ghFile)).rest
    if (rest.trim()) atomic(ghFile, rest); else { safe(ghFile); fs.unlinkSync(ghFile) }
    return { ...login, removed: true, stopped: 0 }
  }
  const a = login.agent, p = login.profile, f = path.join(dir(a, p), files[a])
  const file = a === "claude" ? accountFile(a, p) : undefined, state = file ? json(file) : undefined
  safe(f); fs.unlinkSync(f)
  let stopped
  try { if (state?.oauthAccount) { delete state.oauthAccount; atomic(file, JSON.stringify(state, null, 2) + "\n") } }
  finally { stopped = stopSessions(a, p) }
  return { ...login, removed: true, stopped }
}
function githubAccount(token) {
  return new Promise((resolve, reject) => {
    const request = require("https").get("https://api.github.com/user", { headers: { Authorization: "Bearer " + token, "User-Agent": "asidee-login", Accept: "application/vnd.github+json" } }, (response) => {
      let data = ""
      response.on("error", reject)
      response.on("data", (chunk) => { data += chunk; if (data.length > 1024 * 1024) response.destroy(new Error()) })
      // 77: GitHub answered and refused the token, as distinct from GitHub not answering.
      response.on("end", () => { try { const user = githubUser(JSON.parse(data).login); if (response.statusCode !== 200 || !user) throw new Error(); resolve(user) } catch { reject(Object.assign(new Error(), { loginCode: response.statusCode === 401 ? 77 : 70 })) } })
    })
    request.setTimeout(15000, () => request.destroy(new Error())); request.on("error", reject)
  })
}
async function main() {
  if (mode === "list") return emit(list())
  if (mode === "logout") {
    if (!(agent === "all" || ((agent === "github" || Object.hasOwn(files, agent)) && (profile === "~" || validProfile(profile))))) fail(64)
    const targets = list().filter((x) => agent === "all" || (x.agent === agent && x.profile === profile))
    if (agent !== "all" && !targets.length) fail(68)
    return emit(targets.map(logout))
  }
  if (mode === "import") {
    if (!Object.hasOwn(files, agent) || !validProfile(profile) || !["create", "replace"].includes(choice)) fail(64)
    const payload = await input(), root = dir(agent, profile), dest = path.join(root, files[agent])
    safe(dest)
    if (info(dest) && choice !== "replace") fail(67)
    if (!object(payload) || typeof payload.credential !== "string" || Buffer.byteLength(payload.credential) > 1024 * 1024 || !object(JSON.parse(payload.credential))) fail(66)
    const setup = payload.setup ? installSetup(agent, profile, payload.setup) : undefined
    const settingsPath = path.join(root, "settings.json")
    // Claude prefers an API key over the imported subscription, including one copied in setup.
    if (agent === "claude") { const current = json(settingsPath); if (current.env !== undefined && !object(current.env)) fail(66) }
    let state, statePath
    if (agent === "claude" && object(payload.account)) { statePath = path.join(root, ".claude.json"); state = json(statePath); state.oauthAccount = payload.account }
    mkdir(root); fs.chmodSync(root, 0o700)
    atomic(dest, payload.credential, 0o600, choice === "replace")
    if (statePath) atomic(statePath, JSON.stringify(state, null, 2) + "\n")
    const result = setup ? setup() : { files: 0, missingCommands: 0, missingCommandNames: [] }
    result.missingCommandNames = result.missingCommandNames.filter((name) => /^[\x20-\x7e]{1,160}$/.test(name) && Array.isArray(payload.commandNames) && payload.commandNames.includes(name)).slice(0, 64)
    if (agent === "claude") {
      const settings = json(settingsPath)
      if (settings.env !== undefined && !object(settings.env)) fail(66)
      settings.env = { ...settings.env, ANTHROPIC_API_KEY: "" }
      atomic(settingsPath, JSON.stringify(settings, null, 2) + "\n")
    }
    return emit({ agent, profile, ...result })
  }
  if (mode === "github") {
    if (!["create", "replace"].includes(choice)) fail(64)
    safe(ghFile)
    const before = githubSection(read(ghFile))
    if (before.section && choice !== "replace") fail(67)
    const payload = await input(), token = payload?.token
    if (typeof token !== "string" || !/^[A-Za-z0-9_]{20,255}$/.test(token)) fail(66)
    for (const command of ["gh", "git"]) if (cp.spawnSync(command, ["--version"], { stdio: "ignore" }).status !== 0) fail(69)
    const user = await githubAccount(token)
    // gh consumes this file directly. There is no credential proxy in a gVisor container.
    const section = "github.com:\n    user: " + user + "\n    git_protocol: https\n    oauth_token: " + token + "\n    users:\n        " + user + ":\n            oauth_token: " + token + "\n"
    atomic(ghFile, before.rest.trimEnd() + (before.rest.trim() ? "\n" : "") + section, 0o600, info(ghFile) ? true : choice === "replace")
    for (const host of ["https://github.com", "https://gist.github.com"]) {
      for (const value of ["", "!gh auth git-credential"]) {
        const args = ["config", "--global", value ? "--add" : "--replace-all", "credential." + host + ".helper", value]
        if (cp.spawnSync("git", args, { stdio: "ignore" }).status !== 0) fail(69)
      }
    }
    return emit({ agent: "github", profile: "~", account: user, file: ghFile })
  }
  fail(64)
}
async function lockedMain() {
  const lock = path.join(home, ".asidee-logins.lock")
  if (mode === "list") return main()
  safe(lock, true)
  try { fs.mkdirSync(lock, { mode: 0o700 }) } catch (e) { if (e.code === "EEXIST") fail(75); throw e }
  try { return await main() } finally { fs.rmdirSync(lock) }
}
lockedMain().catch((error) => { process.stderr.write("Login operation failed; contents withheld.\n"); process.exitCode = error.loginCode || 70 })
`
