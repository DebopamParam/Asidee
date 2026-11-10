const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto")
const mode = process.argv[1], modes = ["off", "claude", "codex", "claude,codex"]
const home = os.homedir(), dir = path.join(home, ".t3/account-rotator"), script = path.join(dir, "rotate.py"), pidFile = path.join(dir, "pid"), log = path.join(dir, "rotator.log")
function info(p) { try { return fs.lstatSync(p) } catch (e) { if (e.code !== "ENOENT") throw e } }
function safe(p, directory = false) {
  let at = home
  for (const part of path.relative(home, p).split(path.sep).filter(Boolean)) {
    if (part === "..") throw new Error()
    at = path.join(at, part); const got = info(at)
    if (got && (got.isSymbolicLink() || (at !== p || directory ? !got.isDirectory() : !got.isFile()))) throw new Error()
  }
}
function read(p) { safe(p); return info(p) ? fs.readFileSync(p, "utf8") : "" }
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  const result = cp.spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" })
  return result.status === 0 && result.stdout.trim().endsWith(script + " --watch --providers " + read(path.join(dir, "providers")).trim())
}
function pid() { const text = read(pidFile).trim(); return /^\d+$/.test(text) ? Number(text) : 0 }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function stop() {
  const selected = pid()
  if (identity(selected)) {
    process.kill(selected, "SIGTERM")
    for (let i = 0; i < 20 && identity(selected); i++) await delay(100)
    if (identity(selected)) process.kill(selected, "SIGKILL")
  }
  for (const file of [pidFile, path.join(dir, "providers")]) { safe(file); fs.rmSync(file, { force: true }) }
}
function summary() {
  const configured = read(path.join(dir, "providers")).trim(), running = identity(pid())
  if (running && !modes.includes(configured)) throw new Error()
  const text = info(log) ? (() => {
    safe(log); const fd = fs.openSync(log, "r")
    try { const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 64 * 1024)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString("utf8") }
    finally { fs.closeSync(fd) }
  })() : ""
  // The unchanged upstream script logs thread titles and exceptions. Export only fixed event categories.
  const lines = text.split(/\r?\n/).filter(Boolean).slice(-20).map(line => {
    const at = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00 /.exec(line)?.[0] || ""
    const event = line.slice(at.length)
    return at + (event.startsWith("rotating ") ? "watching" : event.startsWith("rotate ") ? "rotation requested" : event.startsWith("resume ") ? "resume requested" : event.startsWith("check failed:") ? "check failed" : "log entry (details withheld)")
  })
  return { mode: running ? configured : "off", log: lines }
}
async function main() {
  if (mode !== "status" && !modes.includes(mode)) throw new Error()
  safe(dir, true)
  if (mode === "status") return summary()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const lock = path.join(dir, ".lock"); safe(lock, true); fs.mkdirSync(lock, { mode: 0o700 })
  try {
    if (mode === "off") { await stop(); return summary() }
    const settings = path.join(home, ".t3/userdata/settings.json"); safe(settings)
    if (!info(settings)?.isFile() || cp.spawnSync("python3", ["--version"], { stdio: "ignore" }).status !== 0) throw new Error()
    let data = ""
    for await (const chunk of process.stdin) { data += chunk; if (Buffer.byteLength(data) > 1024 * 1024) throw new Error() }
    if (!data.startsWith("#!/usr/bin/env python3")) throw new Error()
    await stop()
    safe(script); safe(log)
    const tmp = script + "." + crypto.randomBytes(8).toString("hex")
    try { fs.writeFileSync(tmp, data, { flag: "wx", mode: 0o600 }); fs.renameSync(tmp, script) }
    finally { fs.rmSync(tmp, { force: true }) }
    fs.writeFileSync(path.join(dir, "providers"), mode + "\n", { mode: 0o600 })
    const fd = fs.openSync(log, "a", 0o600); fs.fchmodSync(fd, 0o600)
    try {
      const child = cp.spawn("python3", ["-u", script, "--watch", "--providers", mode], { detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, T3CODE_HOME: path.join(home, ".t3") } })
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject) })
      fs.writeFileSync(pidFile, String(child.pid) + "\n", { mode: 0o600 }); child.unref()
    } finally { fs.closeSync(fd) }
    await delay(300)
    if (!identity(pid())) { await stop(); throw new Error() }
    return summary()
  } finally { fs.rmdirSync(lock) }
}
main().then(value => process.stdout.write(JSON.stringify(value) + "\n")).catch(() => { process.stderr.write("Rotator operation failed; output withheld. Check Node, ps, Python, T3 settings and the rotator lock.\n"); process.exitCode = 1 })
