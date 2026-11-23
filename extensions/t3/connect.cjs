// T3 Connect, so the T3 Code app on a phone or the web reaches this sandbox through T3's relay. Sign-in is approved on
// another device with a URL and code. T3 leaves its server to a systemd user service, which a sandbox has none of, so
// this starts `t3 serve --no-lan` itself and the extension's postStart hook starts it again with the sandbox.
// argv: MODE VERSION, MODE one of connect, status, ensure, disconnect. Prints one JSON line.
const fs = require("fs"), path = require("path"), os = require("os"), { spawn, spawnSync } = require("child_process")
const [mode, version] = process.argv.slice(1)
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || "")) throw new Error("version")
const home = os.homedir(), t3 = path.join(home, ".t3/runtime/versions", version, "t3")
const dir = path.join(home, ".t3/asidee"), signin = path.join(dir, "connect.log"), served = path.join(dir, "serve.log")
const say = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
if (!fs.existsSync(t3)) { say({ state: "not-set-up" }); process.exit(0) }
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

const status = () => {
  const result = spawnSync(t3, ["connect", "status", "--json"], { encoding: "utf8", timeout: 30_000 })
  try { return JSON.parse(result.stdout) } catch { return undefined }
}
const cmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0") } catch { return [] } }
const pids = (test) => fs.readdirSync("/proc").filter((pid) => /^\d+$/.test(pid) && test(cmdline(pid))).map(Number)
// Any T3 server of this user, whoever started it (the desktop app starts one over SSH).
const servers = () => pids((argv) => argv[0] === t3 && argv[1] === "serve")
const signing = () => pids((argv) => argv[0] === t3 && argv[1] === "up" && argv.includes("--connect"))
const tail = (file) => { try { const text = fs.readFileSync(file, "utf8"); return text.slice(-65_536) } catch { return "" } }
// Root runs Chrome without its own sandbox, as the extension's setup arranges for SSH-started servers.
const env = () => process.getuid() === 0 ? { ...process.env, T3CODE_SERVER_BROWSER_SANDBOX: "0" } : process.env
const detached = (argv, log) => {
  const out = fs.openSync(log, "a", 0o600)
  spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out], env: env() }).unref()
}
const serve = () => { fs.writeFileSync(served, "", { mode: 0o600 }); detached([t3, "serve", "--no-lan"], served) }
const stop = (list) => { for (const pid of list) try { process.kill(pid, "SIGTERM") } catch { /* already gone */ } }
// T3's own reason this machine is not reachable, without anything else from its logs.
const why = (now) => {
  if (/tunnel limit reached/i.test(tail(served))) return "Your T3 account has no room for another machine (T3 Connect allows 3). Deregister one you no longer use: in the T3 Code app, account menu → T3 Connect, or Settings → T3 Connect on the phone. Then press Connect again."
  return typeof now?.reachability?.reason === "string" ? now.reachability.reason.slice(0, 300) : undefined
}
const approval = async () => {
  for (let at = 0; at < 60; at++) {
    const text = tail(signin)
    const url = /https:\/\/accounts\.t3\.codes\/device\?user_code=[A-Z0-9-]{4,20}/.exec(text)?.[0], code = /Code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1]
    if (url && code) return { url, code }
    if (/Signed in to T3 Connect/.test(text) || !signing().length) return undefined
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return undefined
}

const connected = (now, server) => ({ state: now.linked ? "connected" : "signed-in", server, ...(now.linked ? {} : { reason: why(now) }) })

async function main() {
  const now = status()
  if (!now) throw new Error("status")
  if (mode === "status") return say({ ...connected(now, servers().length ? "running" : "stopped"), ...(now.authenticated && now.desired ? {} : { state: "off" }) })
  if (mode === "ensure") {
    if (!now.authenticated || !now.desired || servers().length) return say({ state: "unchanged" })
    serve(); return say({ state: "started" })
  }
  if (mode === "disconnect") {
    stop(signing())
    spawnSync(t3, ["connect", "logout"], { encoding: "utf8", timeout: 60_000 })
    // Only the server this started; one the desktop app started keeps running, now without T3 Connect.
    stop(pids((argv) => argv[0] === t3 && argv[1] === "serve" && argv[2] === "--no-lan"))
    return say({ state: "off" })
  }
  if (mode !== "connect") throw new Error("mode")
  if (now.authenticated && now.desired) {
    const running = servers()
    // A server that started before the sign-in, or that the account had no room for, applies the link only when it starts.
    if (running.length && !now.linked) { stop(running); await new Promise((resolve) => setTimeout(resolve, 2000)); serve(); return say({ ...connected(now, "restarted") }) }
    if (!running.length) { serve(); return say(connected(now, "started")) }
    return say(connected(now, "running"))
  }
  if (!signing().length) {
    fs.writeFileSync(signin, "", { mode: 0o600 })
    // After approval it starts the server, whose link to T3 Connect is applied when it starts.
    const script = `"$0" up --connect --headless </dev/null; "$0" connect status --json | grep -q '"linked": true' && exit 0
for f in /proc/[0-9]*/cmdline; do tr '\\0' ' ' < "$f" 2>/dev/null | grep -q "^$0 serve" && kill "$(basename "$(dirname "$f")")"; done
sleep 2; exec "$0" serve --no-lan >> "$1" 2>&1`
    detached(["/bin/sh", "-c", script, t3, served], signin)
  }
  const shown = await approval()
  if (!shown) { const after = status(); return after?.authenticated ? say(connected(after, servers().length ? "running" : "stopped")) : say({ state: "failed" }) }
  say({ state: "approve", ...shown })
}
main().catch(() => { say({ state: "failed" }); process.exitCode = 1 })
