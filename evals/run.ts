#!/usr/bin/env bun
// The eval set: what Paddock says about itself, measured from outside it. `bun evals/run.ts` builds the binary, runs it
// with a state and config folder of its own against the first ready engine, and prints a scorecard.
//
// The evals do not ask Paddock whether a sandbox is isolated. They try the thing (a connection from inside the sandbox,
// a fork bomb, a rule slipped into the firewall) with plain engine commands, and compare what happened with what Paddock
// reported. A "blocked" result counts only beside a control that shows the same attempt works when nothing blocks it.
//
//   bun evals/run.ts                 every eval
//   bun evals/run.ts --only H,T03    groups or ids
//   bun evals/run.ts --write         also rewrite evals/SCORECARD.md

import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CHECKLIST } from "../core/checks"
import { HELPER_IMAGE } from "../core/providers/gvisor"
import HELPER_DOCKERFILE from "../core/providers/helper.Dockerfile" with { type: "text" }

const ROOT = join(dirname(Bun.main), "..")
const BUN = process.execPath
const REPLY = "paddock-eval-reply"
const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined
const PREFIX = `ev${Math.random().toString(36).slice(2, 6)}`
const A = `${PREFIX}-a`; const B = `${PREFIX}-b`

type Sh = { code: number; out: string; err: string }
async function sh(argv: string[], options: { stdin?: string; env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): Promise<Sh> {
  const child = Bun.spawn(argv, {
    stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]), stdout: "pipe", stderr: "pipe", cwd: options.cwd,
    env: { ...process.env, ...options.env }, timeout: options.timeoutMs ?? 240_000,
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code: child.signalCode ? 124 : code, out, err }
}

class Skip extends Error {}
const skip = (why: string): never => { throw new Skip(why) }
function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
const until = async (condition: () => Promise<boolean>, seconds: number) => {
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await Bun.sleep(1000)) if (await condition()) return true
  return false
}

// ---- the run's own Paddock: a temporary state and config folder, a port of its own
const tmp = await mkdtemp(join(tmpdir(), "pdk-"))
const env = { PADDOCK_STATE_DIR: join(tmp, "s"), PADDOCK_CONFIG_DIR: join(tmp, "c"), PADDOCK_PORT: "0" }
let BIN = join(ROOT, "dist", "paddock")
const pdk = (argv: string[], options: Parameters<typeof sh>[1] = {}) => sh([BIN, ...argv], { ...options, env: { ...env, ...options.env } })
const pdkJson = async (argv: string[], options: Parameters<typeof sh>[1] = {}) => {
  const run = await pdk(["--json", ...argv], options)
  let reply: { ok: boolean; data?: any; error?: { code: string; message: string } }
  try { reply = JSON.parse(run.out) } catch { throw new Error(`paddock --json ${argv.join(" ")} did not print JSON: ${run.out.slice(0, 200)} ${run.err.slice(0, 200)}`) }
  return { ...run, reply }
}
// Straight to the daemon's socket, for bodies the CLI would never send.
const socket = async (method: string, body: unknown) => {
  const post = () => fetch(`http://paddock/api/${method}`, { unix: join(env.PADDOCK_STATE_DIR, "daemon.sock"), method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) } as RequestInit)
  // No daemon (an eval stopped or killed it): any CLI command starts one.
  const response = await post().catch(async () => { await pdk(["list"]); return post() })
  return { status: response.status, reply: await response.json() as { ok: boolean; data?: any; error?: { code: string; message: string } } }
}
const daemonFile = async () => JSON.parse(await readFile(join(env.PADDOCK_STATE_DIR, "daemon.json"), "utf8")) as { pid: number; port: number; token: string; version: string }
const tcp = async (path: string, init: RequestInit & { token?: string | null; host?: string } = {}) => {
  const daemon = await daemonFile()
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? daemon.token}`
  if (init.host) headers.host = init.host
  return fetch(`http://127.0.0.1:${daemon.port}${path}`, { method: "POST", body: "{}", ...init, headers })
}

// ---- the engine, spoken to directly: this is what makes the measurements independent
let context = ""
const docker = (argv: string[], options: Parameters<typeof sh>[1] = {}) => sh(["docker", "--context", context, ...argv], options)
const containerOf = (name: string) => `paddock-${name}`
const asRoot = (script: string) => docker(["run", "--rm", "--privileged", "--network", "host", "--runtime", "runc", "-u", "0", HELPER_IMAGE, "sh", "-c", script])
const inspect = async (name: string) => { const out = await docker(["inspect", containerOf(name)]); return out.code === 0 ? JSON.parse(out.out)[0] : undefined }
const view = async (name: string) => (await socket("get", { name })).reply.data as { status: string; stopReason?: string; spec: Record<string, number | string>; lastVerify?: { results: Array<{ id: string; status: string; evidence: string; detail: string }> } } | undefined
const running = async (name: string) => (await inspect(name))?.State.Running === true
const sandboxIp = async (name: string) => (await docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerOf(name)])).out.trim()
const gatewayOf = async (name: string) => (await docker(["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", `paddock-net-${name}`])).out.trim()

async function ensure(name: string, spec: Record<string, unknown> = {}): Promise<void> {
  const current = await view(name)
  if (!current) {
    const made = await socket("create", { name, image: "alpine:latest", cpus: 1, memoryGb: 1, diskGb: 1, ...spec })
    expect(made.reply.ok, `could not create ${name}: ${made.reply.error?.message}`)
  } else if (current.status !== "running") {
    const started = await socket("start", { name })
    expect(started.reply.ok, `could not start ${name}: ${started.reply.error?.message}`)
  }
}

// A helper on the engine's host, outside Paddock: a listener on every host address, and listeners at one address in each
// private range and the tailnet range, inside a scratch network namespace the host routes to. They stand in for the
// host, a device on the LAN and a machine on the tailnet.
const HOST = `${PREFIX}-host`; const HOST_PORT = String(30_000 + Math.floor(Math.random() * 20_000)); const FAR_PORT = "7777"
const FAR = ["10.255.255.25", "172.31.255.25", "192.168.255.25", "100.127.255.25"]
let farAddresses: string[] = []
async function hostHelper(): Promise<void> {
  if ((await docker(["inspect", HOST])).code === 0) return
  const script = `set -e
nc -lk -p ${HOST_PORT} -e echo ${REPLY} &
ip netns add far; ip link add ${PREFIX}a type veth peer name ${PREFIX}b; ip link set ${PREFIX}b netns far; ip link set ${PREFIX}a up
ip netns exec far ip link set lo up; ip netns exec far ip link set ${PREFIX}b up
for a in ${FAR.join(" ")}; do
  [ -n "$(ip route show match \${a}4 | grep -v '^default')" ] && continue
  ip addr add \${a}3/30 dev ${PREFIX}a; ip netns exec far ip addr add \${a}4/30 dev ${PREFIX}b; echo "far \${a}4"
done
ip netns exec far ip route add default via ${FAR[0]}3 2>/dev/null || true
echo ready; exec ip netns exec far nc -lk -p ${FAR_PORT} -e echo ${REPLY}`
  const started = await docker(["run", "-d", "--rm", "--name", HOST, "--privileged", "--network", "host", "--runtime", "runc", HELPER_IMAGE, "sh", "-c", script])
  expect(started.code === 0, `the host helper did not start: ${started.err}`)
  expect(await until(async () => (await docker(["logs", HOST])).out.includes("ready"), 15), "the host helper did not get ready")
  farAddresses = (await docker(["logs", HOST])).out.split("\n").filter((line) => line.startsWith("far ")).map((line) => line.slice(4))
}
const answers = (output: Sh) => output.out.includes(REPLY)
const fromHost = async (ip: string, port: string) => { for (let i = 0; i < 5; i++) { if (answers(await docker(["exec", HOST, "nc", "-w", "2", ip, port]))) return true; await Bun.sleep(300) } return false }
// From inside the sandbox itself, through Paddock, with the sandbox's own tools.
const fromSandbox = async (name: string, ip: string, port: string) => answers(await pdk(["exec", name, "--", "nc", "-w", "2", ip, port], { timeoutMs: 20_000 }))
const hostAddresses = async () => (await docker(["exec", HOST, "ip", "-4", "-o", "addr", "show"])).out.split("\n")
  .map((line) => /inet (\d+\.\d+\.\d+\.\d+)/.exec(line)?.[1]).filter((ip): ip is string => Boolean(ip) && !ip!.startsWith("127.") && !FAR.some((far) => ip!.startsWith(far)))
const guardTamper = { insert: "nft insert rule inet paddock_guard prerouting accept", remove: "nft delete table inet paddock_guard; nft delete table bridge paddock_guard" }

// ---- a real browser for the dashboard, driven over the DevTools protocol
const BROWSERS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
async function browser(url: string) {
  let path: string | undefined
  for (const candidate of BROWSERS) if (await Bun.file(candidate).exists()) { path = candidate; break }
  if (!path) skip("no Chromium-based browser is installed")
  const profile = join(tmp, `browser-${Math.random().toString(36).slice(2, 8)}`)
  const child = Bun.spawn([path!, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdout: "ignore", stderr: "pipe" })
  let port = ""
  const reader = child.stderr.getReader(); const decoder = new TextDecoder(); let seen = ""
  for (const end = Date.now() + 20_000; Date.now() < end && !port;) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(20_000).then(() => undefined)])
    if (!chunk || chunk.done) break
    seen += decoder.decode(chunk.value); port = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(seen)?.[1] ?? ""
  }
  if (!port) { child.kill(); throw new Error(`the browser did not open a DevTools port: ${seen.slice(0, 200)}`) }
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json() as { webSocketDebuggerUrl: string }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0; const waiting = new Map<number, (value: any) => void>(); let promptText = ""
  const send = (method: string, params: object = {}) => new Promise<any>((resolve) => { waiting.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id) waiting.get(message.id)?.(message.result ?? message.error)
    if (message.method === "Page.javascriptDialogOpening") void send("Page.handleJavaScriptDialog", { accept: true, promptText })
  }
  await send("Page.enable"); await send("Page.navigate", { url })
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value
  return {
    evaluate, answerPromptsWith: (text: string) => { promptText = text },
    waitFor: (expression: string, seconds: number) => until(async () => Boolean(await evaluate(expression)), seconds),
    close: async () => { ws.close(); child.kill(); await child.exited; await rm(profile, { recursive: true, force: true }).catch(() => {}) },
  }
}
// The panel of one sandbox in the built-in dashboard, as an expression.
const panel = (name: string) => `[...document.querySelectorAll("#sandboxes .panel")].find((node) => node.querySelector(".name")?.textContent === ${JSON.stringify(name)})`

// ---- the evals
type Eval = { id: string; claim: string; run: () => Promise<string | void> }
const evals: Eval[] = []
const ev = (id: string, claim: string, run: Eval["run"]) => evals.push({ id, claim, run })

// H: what the checklist says is true when tried from inside.
ev("H01", "A sandbox runs on gVisor's kernel, not the host's", async () => {
  await ensure(A)
  const inside = await pdk(["exec", A, "--", "cat", "/proc/version"])
  expect(/gvisor/i.test(inside.out), `the kernel inside says: ${inside.out.trim()}`)
  const runtime = (await inspect(A)).HostConfig.Runtime as string
  const runtimes = JSON.parse((await docker(["info", "--format", "{{json .Runtimes}}"])).out) as Record<string, { path?: string }>
  expect(runtimes[runtime]?.path?.endsWith("/runsc"), `the container's runtime ${runtime} is ${runtimes[runtime]?.path}`)
  const hostKernel = (await asRoot("uname -r")).out.trim()
  expect(!inside.out.includes(hostKernel), "the sandbox reports the engine host's kernel version")
})

ev("H13", "Every network check in a fresh verify was probed live, not read from configuration", async () => {
  // Before the evals' own listeners take the stand-in addresses.
  await ensure(A)
  const checks = (await socket("verify", { name: A })).reply.data.checks as Array<{ id: string; evidence: string; status: string }>
  const weak = checks.filter((check) => ["net-host", "net-peers", "net-private"].includes(check.id) && !(check.status === "pass" && check.evidence === "probed"))
  expect(weak.length === 0, `not probed: ${weak.map((check) => `${check.id} (${check.status}, ${check.evidence})`).join(", ")}`)
})

ev("H02", "From inside a sandbox, no address of the engine's host answers", async () => {
  await ensure(A); await hostHelper()
  const targets = [...new Set([await gatewayOf(A), ...(await hostAddresses())])].slice(0, 6)
  const reached: string[] = []; let controls = 0
  for (const ip of targets) {
    if (!await fromHost(ip, HOST_PORT)) continue
    controls++
    if (await fromSandbox(A, ip, HOST_PORT)) reached.push(ip)
  }
  expect(controls > 0, "no control connection worked, so nothing was measured")
  expect(reached.length === 0, `the sandbox reached the host at ${reached.join(", ")}`)
  return `${controls} host addresses tried, each with a working control`
})

ev("H03", "From inside a sandbox, this computer (beyond the engine's VM) does not answer", async () => {
  await ensure(A)
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(peer) { peer.write(`${REPLY}\n`); peer.end() }, data() {} } })
  try {
    const port = String(server.port)
    const lookup = await docker(["run", "--rm", "--runtime", "runc", HELPER_IMAGE, "sh", "-c", `getent hosts host.docker.internal | cut -d' ' -f1; nc -w 2 host.docker.internal ${port}`])
    if (!answers(lookup)) skip("a container cannot reach a listener on this computer through host.docker.internal here, so there is no control")
    const ip = lookup.out.split("\n")[0]!.trim()
    expect(!await fromSandbox(A, ip, port), `the sandbox reached a listener on this computer at ${ip}`)
    expect(!await fromSandbox(A, "host.docker.internal", port), "the sandbox reached this computer by the name host.docker.internal")
    return `control: an ordinary container reached it at ${ip}`
  } finally { server.stop(true) }
})

ev("H04", "From inside a sandbox, another sandbox does not answer", async () => {
  await ensure(A); await ensure(B, { pids: 256 }); await hostHelper()
  const listener = Bun.spawn([BIN, "exec", B, "--", "nc", "-lk", "-p", "7777", "-e", "echo", REPLY], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" })
  try {
    const ip = await sandboxIp(B)
    expect(await fromHost(ip, "7777"), `control failed: the engine's host could not reach the listener in ${B}`)
    expect(!await fromSandbox(A, ip, "7777"), `${A} reached a listener inside ${B} at ${ip}`)
  } finally { listener.kill(); await pdk(["exec", B, "--", "pkill", "nc"]) }
})

ev("H05", "From inside a sandbox, private (LAN) and tailnet addresses do not answer", async () => {
  await ensure(A); await hostHelper()
  expect(farAddresses.length > 0, "no stand-in address could be set up on the engine's host")
  const reached: string[] = []; const tried: string[] = []
  for (const ip of farAddresses) {
    if (!await fromHost(ip, FAR_PORT)) continue
    tried.push(ip)
    if (await fromSandbox(A, ip, FAR_PORT)) reached.push(ip)
  }
  expect(tried.length > 0, "no control connection worked, so nothing was measured")
  expect(reached.length === 0, `the sandbox reached ${reached.join(", ")}`)
  return `stand-ins tried, each with a working control: ${tried.join(", ")}`
})

ev("H06", "From inside a sandbox, cloud metadata and IPv6 do not answer", async () => {
  await ensure(A)
  expect((await pdk(["exec", A, "--", "nc", "-w", "3", "169.254.169.254", "80"], { stdin: "" })).code !== 0, "the metadata address accepted a connection")
  expect((await pdk(["exec", A, "--", "nc", "-w", "3", "2606:4700:4700::1111", "443"], { stdin: "" })).code !== 0, "an IPv6 address on the internet accepted a connection")
  return "no control: nothing listens at these addresses on this machine"
})

ev("H07", "The engine object has no host folder, published port, privilege or host namespace", async () => {
  await ensure(A)
  const data = await inspect(A); const host = data.HostConfig
  expect(!host.Privileged && !(host.CapAdd ?? []).length && !(host.Devices ?? []).length, "privileged, capabilities or devices are set")
  expect(!(host.Binds ?? []).length && (data.Mounts ?? []).every((mount: { Type: string }) => mount.Type === "volume"), "a host folder is mounted")
  expect(!Object.keys(host.PortBindings ?? {}).length && !Object.keys(data.NetworkSettings.Ports ?? {}).some((port) => data.NetworkSettings.Ports[port]), "a port is published")
  expect([host.PidMode, host.IpcMode, host.UTSMode, host.UsernsMode, host.NetworkMode].every((mode) => mode !== "host"), "a host namespace is shared")
  expect(host.RestartPolicy?.Name === "no" || !host.RestartPolicy?.Name, "the engine would restart it without Paddock's checks")
  const socketInside = await pdk(["exec", A, "--", "sh", "-c", "ls /var/run/docker.sock /run/docker.sock 2>/dev/null"])
  expect(!socketInside.out.trim(), "the engine's socket is visible inside the sandbox")
})

ev("H08", "The process limit holds: a fork bomb ends at the limit, in failed forks or a killed sandbox, and the engine is unharmed", async () => {
  await ensure(B, { pids: 256 })
  const count = await pdk(["exec", B, "--", "sh", "-c", 'i=0; while [ $i -lt 600 ]; do sleep 20 & i=$((i+1)); done 2>/dev/null; ps | grep -c "[s]leep"'], { timeoutMs: 60_000 })
  expect((await docker(["info", "--format", "{{.ServerVersion}}"])).code === 0, "the engine stopped answering")
  if (!await running(B)) {
    // gVisor's own threads count against the limit, and it does not survive running out of them.
    const reason = (await view(B))?.stopReason ?? ""
    expect(/task limit/i.test(reason), `the sandbox died and the list does not say why: ${JSON.stringify(reason)}`)
    return "the sandbox was killed at its limit, and the list says so"
  }
  const alive = Number(count.out.trim().split("\n").pop())
  await pdk(["exec", B, "--", "pkill", "sleep"])
  expect(Number.isFinite(alive) && alive < 256, `${count.out.trim()} of 600 processes ran under a limit of 256`)
  return `${alive} of 600 started under a limit of 256`
})

ev("H09", "The memory limit holds: a process that passes it is killed, not the engine", async () => {
  await ensure(B, { pids: 256 })
  const hog = await pdk(["exec", B, "--", "sh", "-c", "tail /dev/zero"], { timeoutMs: 120_000 })
  expect(hog.code !== 0, "a process allocated without bound and ended normally")
  expect(hog.code !== 124, "the allocation was still growing after two minutes")
  expect((await docker(["info", "--format", "{{.ServerVersion}}"])).code === 0, "the engine stopped answering")
  const after = await view(B)
  return `exit ${hog.code}; the sandbox is ${after?.status}${after?.stopReason ? ` (${after.stopReason})` : ""}`
})

ev("H10", "A sandbox killed by its memory limit says so in the list", async () => {
  const current = await view(B)
  if (!current) skip("H09 did not run")
  if (current!.status === "running") skip("the engine killed only the process, so the sandbox kept running")
  expect(/memory/i.test(current!.stopReason ?? ""), `the list gives no reason: ${JSON.stringify(current!.stopReason)}`)
})

ev("H11", "The disk limit is what the checklist says: a sandbox past it is stopped within a minute", async () => {
  await ensure(B, { pids: 256 })
  const disk = (await socket("verify", { name: B })).reply.data.checks.find((check: { id: string }) => check.id === "disk")
  const write = await pdk(["exec", B, "--", "dd", "if=/dev/zero", "of=/big", "bs=1M", "count=1300"], { timeoutMs: 120_000 })
  if (disk.status === "pass") { expect(write.code !== 0, "the checklist says writes fail at the limit, and 1.3 GB was written under a 1 GB limit"); return "hard cap" }
  if (disk.status === "unsupported") return "the checklist says there is no limit here, which is what happened"
  expect(disk.status === "weak", `unexpected disk status ${disk.status}`)
  const started = Date.now()
  expect(await until(async () => (await view(B))?.status === "stopped", 75), "the sandbox still ran 75 s after passing its limit")
  expect(/disk/i.test((await view(B))?.stopReason ?? ""), "it stopped without saying it was the disk limit")
  const again = await socket("start", { name: B })
  expect(again.reply.ok, "a sandbox stopped by the disk watch could not be started to free space")
  await pdk(["exec", B, "--", "rm", "/big"])
  return `watched: stopped ${Math.round((Date.now() - started) / 1000)} s after the write ended`
})

ev("H12", "The disclosures are true: internet access and the logins found inside", async () => {
  await ensure(A)
  await pdk(["exec", A, "--stdin", "--", "sh", "-c", "cat > /root/.netrc"], { stdin: "machine example.com login x password y\n" })
  const open = (await pdk(["exec", A, "--", "nc", "-w", "4", "1.1.1.1", "443"], { stdin: "" })).code === 0
  const checks = (await socket("verify", { name: A })).reply.data.checks as Array<{ id: string; detail: string; status: string }>
  await pdk(["exec", A, "--", "rm", "/root/.netrc"])
  expect(checks.find((check) => check.id === "credentials")!.detail.includes("/root/.netrc"), "a login file planted in the sandbox was not disclosed")
  expect(checks.find((check) => check.id === "egress")!.detail.startsWith("Open") === open, `the checklist's word on internet access differs from what the sandbox could do (${open ? "open" : "closed"})`)
})

ev("H14", "Two sandboxes verified at the same moment are both probed, not one of them waved through", async () => {
  await ensure(A); await ensure(B, { pids: 256 })
  await docker(["rm", "-f", HOST])
  expect(await until(async () => !(await asRoot("ip -br link")).out.includes(`${PREFIX}a`), 15), "the evals' own listeners did not go away")
  const both = await Promise.all([socket("verify", { name: A }), socket("verify", { name: B })])
  for (const verify of both) {
    const weak = (verify.reply.data.checks as Array<{ id: string; evidence: string; status: string }>).filter((check) => check.id.startsWith("net-") && !(check.status === "pass" && check.evidence === "probed"))
    expect(weak.length === 0, `not probed: ${weak.map((check) => `${check.id} (${check.status}, ${check.evidence})`).join(", ")}`)
  }
})

// T: a sandbox that stops holding is caught.
ev("T01", "The evals can see an open path: with the guard removed, the same attempts connect", async () => {
  await ensure(A); await hostHelper()
  const gateway = await gatewayOf(A)
  await asRoot(guardTamper.remove)
  const host = await fromSandbox(A, gateway, HOST_PORT)
  const far = farAddresses[0] ? await fromSandbox(A, farAddresses[0], FAR_PORT) : undefined
  if (!await running(A)) skip("the daemon stopped the sandbox before the attempt was made")
  expect(host, "the attempt on the host failed even without the guard, so H02 proves nothing")
  expect(far !== false, "the attempt on a private address failed even without the guard, so H05 proves nothing")
})

ev("T02", "A removed guard is noticed without anyone asking: the daemon stops the sandbox within a minute", async () => {
  await ensure(A)
  await asRoot(guardTamper.remove)
  const started = Date.now()
  expect(await until(async () => !await running(A), 60), "the sandbox still ran 60 s after its guard was removed")
  const reason = (await view(A))?.stopReason ?? ""
  expect(/guard/i.test(reason), `the reason does not name the guard: ${reason}`)
  expect((await pdk(["list"])).out.includes("guard"), "`paddock list` does not show why it stopped")
  return `stopped after ${Math.round((Date.now() - started) / 1000)} s`
})

ev("T03", "Starting a sandbox puts the guard back, and the paths are closed again", async () => {
  await hostHelper()
  if (!await view(A)) await ensure(A)
  await asRoot(guardTamper.remove)
  await socket("stop", { name: A })
  const started = await pdk(["start", A])
  expect(started.code === 0, `start failed: ${started.err}`)
  expect(!await fromSandbox(A, await gatewayOf(A), HOST_PORT), "the host answered after the start")
  expect(!(await view(A))?.stopReason, "the old stop reason is still shown")
})

ev("T04", "A rule slipped in front of the guard's drops fails verify, with exit code 6, and stops the sandbox", async () => {
  await ensure(A)
  await asRoot(guardTamper.insert)
  const verify = await pdkJson(["verify", A])
  expect(verify.code === 6, `verify exited ${verify.code}`)
  const guard = verify.reply.data.checks.find((check: { id: string }) => check.id === "network-guard")
  expect(guard.status === "fail", `the guard check says ${guard.status}`)
  expect(!await running(A), "the sandbox is still running")
  expect((await pdk(["start", A])).code === 0, "it could not be started again")
})

ev("T05", "A sandbox attached to a second network behind Paddock's back is stopped", async () => {
  await ensure(A)
  expect((await docker(["network", "connect", "bridge", containerOf(A)])).code === 0, "could not attach the network")
  const stopped = await until(async () => !await running(A), 60)
  await docker(["network", "disconnect", "bridge", containerOf(A)])
  expect(stopped, "the sandbox still ran 60 s after it joined the engine's default network")
  expect(/network/i.test((await view(A))?.stopReason ?? ""), "the reason does not name the network")
  expect((await pdk(["start", A])).code === 0, "it could not be started again once the network was detached")
})

ev("T06", "A container put in a sandbox's place is never operated on", async () => {
  const name = `${PREFIX}-t`
  await ensure(name)
  await docker(["rm", "-f", containerOf(name)])
  expect((await docker(["run", "-d", "--name", containerOf(name), "--runtime", "runc", "alpine:latest", "sleep", "600"])).code === 0, "could not place the impostor")
  try {
    for (const command of [["start", name], ["exec", name, "--", "id"], ["verify", name], ["stop", name]]) {
      const run = await pdk(command)
      expect(run.code === 4, `paddock ${command[0]} exited ${run.code} instead of refusing: ${run.out}${run.err}`)
    }
    expect(await running(name), "the impostor was stopped or removed")
    expect((await pdk(["remove", name, "--confirm", name])).code === 4, "remove did not refuse")
    expect((await inspect(name)) !== undefined, "remove deleted a container Paddock did not create")
  } finally { await docker(["rm", "-f", containerOf(name)]) }
  expect((await pdk(["remove", name, "--confirm", name])).code === 0, "the sandbox could not be removed after the impostor was gone")
})

ev("T07", "A privileged container wearing a sandbox's labels is refused at start and stopped if running", async () => {
  const name = `${PREFIX}-t`
  await ensure(name)
  const id = JSON.parse(await readFile(join(env.PADDOCK_STATE_DIR, "sandboxes", `${name}.json`), "utf8")).id as string
  await docker(["rm", "-f", containerOf(name)])
  const made = await docker(["create", "--name", containerOf(name), "--label", `dev.paddock.name=${name}`, "--label", `dev.paddock.id=${id}`, "--runtime", "runc", "--privileged", "-v", "/tmp:/host",
    "--network", `paddock-net-${name}`, "alpine:latest", "sleep", "600"])
  expect(made.code === 0, `could not place the impostor: ${made.err}`)
  try {
    const start = await pdkJson(["start", name])
    expect(start.code === 6 && !await running(name), `start exited ${start.code} and the container is ${await running(name) ? "running" : "stopped"}`)
    for (const word of ["privileged", "/tmp"]) expect(start.reply.error!.message.includes(word), `the refusal does not mention ${word}`)
    await docker(["start", containerOf(name)])
    expect(await until(async () => !await running(name), 60), "the daemon let it run for 60 s")
  } finally { await docker(["rm", "-f", containerOf(name)]); await pdk(["remove", name, "--confirm", name]) }
})

ev("T08", "Checks still give an answer after the helper image is deleted", async () => {
  await ensure(A)
  await docker(["rmi", "-f", HELPER_IMAGE])
  try {
    const guard = (await socket("verify", { name: A })).reply.data.checks.find((check: { id: string }) => check.id === "network-guard")
    expect(guard.status === "pass", `the guard check says ${guard.status}: ${guard.detail}`)
  } finally { await docker(["build", "-q", "-t", HELPER_IMAGE, "-"], { stdin: HELPER_DOCKERFILE }) }
})

// R: no client can ask for an unsafe sandbox.
ev("R01", "Fields the API does not have (privileged, mounts, ports, runtime, network) change nothing", async () => {
  const name = `${PREFIX}-r`
  const made = await socket("create", { name, image: "alpine:latest", cpus: 1, memoryGb: 1, diskGb: 1, privileged: true, Privileged: true, binds: ["/:/host"], mounts: [{ source: "/", target: "/host" }],
    volumes: ["/:/host"], ports: ["8080:80"], publish: ["8080:80"], runtime: "runc", network: "host", capAdd: ["SYS_ADMIN"], user: "0", spec: { privileged: true }, data: { runtime: "runc" }, id: "x", HostConfig: { Privileged: true } })
  try {
    expect(made.reply.ok, `create failed: ${made.reply.error?.message}`)
    const data = await inspect(name); const host = data.HostConfig
    expect(!host.Privileged && !(host.Binds ?? []).length && !Object.keys(host.PortBindings ?? {}).length && !(host.CapAdd ?? []).length, "an extra field reached the engine")
    expect(host.Runtime !== "runc" && host.NetworkMode === `paddock-net-${name}`, `runtime ${host.Runtime}, network ${host.NetworkMode}`)
  } finally { await socket("remove", { name, confirm: name }) }
})

ev("R02", "Hostile names, images and sizes are refused before the engine is touched", async () => {
  const before = (await docker(["ps", "-aq"])).out
  const bodies: Array<Record<string, unknown>> = [
    ...["--privileged", "-v", "alpine --privileged", "alpine;id", "alpine\n--privileged", "$(id)", "alpine -v /:/host", ""].filter(Boolean).map((image) => ({ name: `${PREFIX}-x`, image })),
    ...["../x", "a b", "UPPER", "-rf", "a;id", "a\nb", "x".repeat(40), "", "a/b", "a.b"].map((name) => ({ name, image: "alpine:latest" })),
    ...[{ cpus: "1e9" }, { cpus: -1 }, { cpus: "NaN" }, { memoryGb: 0 }, { memoryGb: "1; id" }, { pids: 1 }, { diskGb: 1e12 }, { cpus: [] }, { memoryGb: {} }].map((sizes) => ({ name: `${PREFIX}-x`, image: "alpine:latest", ...sizes })),
    { name: [`${PREFIX}-x`], image: "alpine:latest" }, { name: { toString: "x" }, image: "alpine:latest" }, { name: `${PREFIX}-x`, image: ["alpine", "--privileged"] },
  ]
  for (const body of bodies) {
    const reply = await socket("create", body)
    expect(reply.status === 400 && reply.reply.error?.code === "usage", `accepted or mishandled ${JSON.stringify(body)}: ${reply.status} ${JSON.stringify(reply.reply).slice(0, 160)}`)
  }
  for (const raw of ["[]", "null", "\"x\"", "{", "1"]) expect((await socket("create", raw)).status === 400, `the body ${raw} was not refused as a usage error`)
  expect((await docker(["ps", "-aq"])).out === before, "a refused request left a container behind")
  expect(!await view(`${PREFIX}-x`), "a refused request left a sandbox in the list")
  return `${bodies.length + 5} requests refused`
})

ev("R03", "exec cannot smuggle engine options through its user or name", async () => {
  await ensure(A)
  for (const user of ["0 --privileged", "--privileged", "root;id", "-u"])
    expect((await socket("exec", { name: A, argv: ["id"], user })).status === 400, `the user ${JSON.stringify(user)} was accepted`)
  for (const name of ["--help", `${A} --privileged`, "../x"]) expect((await socket("exec", { name, argv: ["id"] })).status === 400, `the name ${JSON.stringify(name)} was not refused as a usage error`)
  for (const argv of [[], "id", [1], null, [["id"]]]) expect((await socket("exec", { name: A, argv })).status === 400, `argv ${JSON.stringify(argv)} was accepted`)
  // A command starting with a dash is the sandbox's business, not an engine flag.
  const dashed = await socket("exec", { name: A, argv: ["--privileged"] })
  expect(dashed.reply.ok && dashed.reply.data.exitCode !== 0 && (await inspect(A)).HostConfig.Privileged === false, "a dashed command was treated as an engine option")
})

ev("R04", "The dashboard's port refuses a missing token, a foreign Host, CLI-only methods and paths outside the UI folder", async () => {
  await ensure(A)
  expect((await tcp("/api/list", { token: null })).status === 401, "no token was accepted")
  expect((await tcp("/api/list", { token: "0".repeat(48) })).status === 401, "a wrong token was accepted")
  expect((await tcp("/api/list")).status === 200, "the right token was refused")
  expect((await tcp("/api/list", { host: "evil.example" })).status === 403, "a foreign Host header was accepted")
  for (const method of ["attach", "shutdown"]) expect((await tcp(`/api/${method}`)).status === 403, `${method} is available on the port`)
  expect((await tcp("/api/list", { method: "GET", body: undefined })).status === 404, "GET reached a method")
  const page = await tcp("/", { method: "GET", body: undefined, token: null })
  expect(page.status === 200 && page.headers.get("x-frame-options") === "DENY", "the page is missing or can be framed")
  for (const response of [page, await tcp("/api/list")]) expect(!response.headers.get("access-control-allow-origin"), "a cross-origin page may read responses")
  const daemon = await daemonFile()
  for (const path of ["/..%2f..%2fs%2fdaemon.json", "/%2e%2e/%2e%2e/s/daemon.json", "/../s/daemon.json", "//etc/passwd", "/..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd"]) {
    const raw = await sh(["curl", "-s", "--path-as-is", `http://127.0.0.1:${daemon.port}${path}`])
    expect(!raw.out.includes(daemon.token) && !raw.out.includes("root:"), `${path} read a file outside the UI folder`)
  }
})

ev("R05", "Removing needs the name twice, whichever client asks", async () => {
  await ensure(A)
  for (const confirm of [undefined, "", "yes", true, `${A} `, [A]]) expect((await socket("remove", { name: A, confirm })).status === 400, `remove went ahead with confirm ${JSON.stringify(confirm)}`)
  expect((await pdk(["remove", A])).code === 2, "the CLI removed without --confirm")
  expect(await view(A), "the sandbox is gone")
})

ev("R06", "State is private to the user, and the token is not printed by status", async () => {
  await pdk(["list"])
  const mode = async (path: string) => ((await stat(join(env.PADDOCK_STATE_DIR, path))).mode & 0o777).toString(8)
  expect(await mode("daemon.json") === "600" && await mode("daemon.sock") === "600" && await mode("") === "700" && await mode("sandboxes") === "700", "a state file or folder is readable by others")
  const status = await pdk(["--json", "daemon", "status"])
  expect(!status.out.includes((await daemonFile()).token), "daemon status prints the token")
})

ev("R07", "Only the core runs engine commands: the CLI, the dashboard and the example extension contain none", async () => {
  const offenders: string[] = []
  const files = ["cli/cli.ts", "ui/index.html", ...(await readdir(join(ROOT, "extensions/examples/agent-tools"))).map((file) => `extensions/examples/agent-tools/${file}`)]
  for (const file of files) {
    const text = await readFile(join(ROOT, file), "utf8")
    if (/["'`\[\s(]docker["'`,\s]|\bnft\b|\brunsc\b|\bsbx\b/.test(text.replace(/console\.log\(.*\)/g, "").replace(/\/\/.*$/gm, ""))) offenders.push(file)
  }
  expect(offenders.length === 0, `engine commands in ${offenders.join(", ")}`)
})

ev("R08", "An extension's form values reach its command as data, never as shell or options", async () => {
  await ensure(A)
  const dir = join(env.PADDOCK_CONFIG_DIR, "extensions", "probe")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "extension.json"), JSON.stringify({ name: "Probe", actions: [{ id: "echo", label: "Echo", scope: "sandbox", run: ["./echo.sh"],
    fields: [{ id: "text", label: "Text", type: "text", required: true }, { id: "size", label: "Size", type: "select", options: ["s", "m"] }, { id: "count", label: "Count", type: "number" }] }] }))
  await writeFile(join(dir, "echo.sh"), '#!/bin/sh\nprintf "%s|%s|%s" "$PADDOCK_SANDBOX" "$PADDOCK_FIELD_TEXT" "$#"\n'); await chmod(join(dir, "echo.sh"), 0o755)
  try {
    const marker = join(tmp, "pwned"); const hostile = `$(touch ${marker}); \`touch ${marker}\` && touch ${marker} --flag`
    const run = await socket("action", { extension: "probe", action: "echo", sandbox: A, values: { text: hostile } })
    expect(run.reply.data?.stdout === `${A}|${hostile}|0`, `the value arrived as ${JSON.stringify(run.reply.data?.stdout ?? run.reply.error)}`)
    expect(!await Bun.file(marker).exists(), "the value was run as a shell command")
    expect((await socket("action", { extension: "probe", action: "echo", sandbox: A, values: {} })).status === 400, "a required field was not required")
    expect((await socket("action", { extension: "probe", action: "echo", sandbox: A, values: { text: "x", size: "xl" } })).status === 400, "a value outside a select's options was accepted")
    expect((await socket("action", { extension: "probe", action: "echo", sandbox: A, values: { text: "x", count: "1; id" } })).status === 400, "a non-number was accepted for a number")
    for (const sandbox of ["nope-nope", "../x", undefined]) expect((await socket("action", { extension: "probe", action: "echo", sandbox, values: { text: "x" } })).status >= 400, `the sandbox ${String(sandbox)} was accepted`)
    expect((await socket("action", { extension: "../probe", action: "echo", sandbox: A, values: { text: "x" } })).status === 404, "an extension outside the folder was reachable")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// F: everything outside the core can be changed without touching it.
ev("F01", "The example extension works when copied into the config folder", async () => {
  await ensure(A)
  await cp(join(ROOT, "extensions/examples/agent-tools"), join(env.PADDOCK_CONFIG_DIR, "extensions", "agent-tools"), { recursive: true })
  const listed = await pdkJson(["ext", "list"])
  expect(listed.reply.data.extensions.some((extension: { id: string; actions: unknown[] }) => extension.id === "agent-tools" && extension.actions.length === 2), "the extension is not listed with its two actions")
  const info = await pdk(["ext", "run", "agent-tools", "info", A])
  expect(info.code === 0 && /gvisor/i.test(info.out), `the action printed: ${info.out}${info.err}`)
  const install = await pdk(["ext", "run", "agent-tools", "install-claude-code", A, "--set", "version=latest"])
  expect(install.code === 1 && install.err.includes("no npm"), "the action's own failure and message did not come through")
})

ev("F02", "A setup hook runs after create and may use any Paddock command on the new sandbox", async () => {
  const name = `${PREFIX}-h`; const dir = join(env.PADDOCK_CONFIG_DIR, "extensions", "hook")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "extension.json"), JSON.stringify({ name: "Hook", hooks: { postCreate: ["./setup.sh"] } }))
  await writeFile(join(dir, "setup.sh"), '#!/bin/sh\nset -e\npaddock exec "$PADDOCK_SANDBOX" -- sh -c "echo hooked > /hooked"\npaddock verify "$PADDOCK_SANDBOX" >/dev/null\npaddock stop "$PADDOCK_SANDBOX" >/dev/null\npaddock start "$PADDOCK_SANDBOX" >/dev/null\necho "set up $PADDOCK_SANDBOX"\n')
  await chmod(join(dir, "setup.sh"), 0o755)
  try {
    const made = await pdkJson(["create", name], { timeoutMs: 150_000 })
    expect(made.code !== 124, "create never returned: the hook waited on the sandbox it was running for")
    expect(made.reply.ok, `create failed: ${made.reply.error?.message}`)
    expect(made.reply.data.hooks[0]?.exitCode === 0 && made.reply.data.hooks[0].output.includes(`set up ${name}`), `the hook reported ${JSON.stringify(made.reply.data.hooks)}`)
    expect((await pdk(["exec", name, "--", "cat", "/hooked"])).out.trim() === "hooked", "the hook's change is not in the sandbox")
  } finally { await rm(dir, { recursive: true, force: true }); await pdk(["remove", name, "--confirm", name], { timeoutMs: 60_000 }) }
})

ev("F03", "A dashboard of your own replaces the built-in one, with the same API and the same token rule", async () => {
  const dir = join(env.PADDOCK_CONFIG_DIR, "ui")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "index.html"), "<!doctype html><title>mine</title><script src=app.js></script>"); await writeFile(join(dir, "app.js"), "window.mine = true")
  try {
    const page = await tcp("/", { method: "GET", body: undefined, token: null })
    expect((await page.text()).includes("<title>mine</title>"), "the built-in page was served")
    const script = await tcp("/app.js", { method: "GET", body: undefined, token: null })
    expect(script.status === 200 && /javascript/.test(script.headers.get("content-type") ?? ""), "a file beside it was not served as a script")
    expect((await tcp("/api/list", { token: null })).status === 401 && (await tcp("/api/list")).status === 200, "the API's token rule changed")
  } finally { await rm(dir, { recursive: true, force: true }) }
  expect((await (await tcp("/", { method: "GET", body: undefined, token: null })).text()).includes("<title>Paddock</title>"), "the built-in page did not come back")
})

ev("F04", "Defaults in config.json are used, and a config file with a mistake is reported, not silently ignored", async () => {
  const name = `${PREFIX}-d`
  // The run's config sets alpine and small sizes (see setup). A create without flags must pick them up.
  const made = await pdkJson(["create", name])
  try {
    expect(made.reply.ok, `create failed: ${made.reply.error?.message}`)
    const spec = made.reply.data.sandbox.spec
    expect(spec.image === "alpine:latest" && spec.cpus === 0.5 && spec.memoryGb === 0.5 && spec.diskGb === 1, `the spec is ${JSON.stringify(spec)}`)
    expect((await inspect(name)).HostConfig.NanoCpus === 5e8, "the engine was given other sizes than the spec")
  } finally { await pdk(["remove", name, "--confirm", name]) }
  const config = join(env.PADDOCK_CONFIG_DIR, "config.json"); const good = await readFile(config, "utf8")
  try {
    for (const bad of ["{ not json", JSON.stringify({ defaults: { cpus: "lots" } }), JSON.stringify({ defaults: { image: "--privileged" } }), JSON.stringify({ defaults: "x" }), JSON.stringify({ engine: 5 }), "[]", "null"]) {
      await writeFile(config, bad)
      const reply = await socket("create", { name: `${PREFIX}-x` })
      await socket("remove", { name: `${PREFIX}-x`, confirm: `${PREFIX}-x` })
      expect(reply.status === 400 && reply.reply.error!.message.includes("config.json"), `with the config ${bad}, a create answered ${reply.status}: ${JSON.stringify(reply.reply).slice(0, 200)}`)
      expect((await pdk(["list"])).code === 0, `with the config ${bad}, list failed`)
    }
  } finally { await writeFile(config, good) }
})

ev("F05", "A broken extension is reported and the others still load", async () => {
  const root = join(env.PADDOCK_CONFIG_DIR, "extensions")
  await mkdir(join(root, "broken"), { recursive: true }); await mkdir(join(root, "bad-action"), { recursive: true }); await mkdir(join(root, "fine"), { recursive: true }); await mkdir(join(root, "empty"), { recursive: true })
  await writeFile(join(root, "broken", "extension.json"), "{ nope"); await writeFile(join(root, "fine", "extension.json"), JSON.stringify({ name: "Fine" }))
  await writeFile(join(root, "bad-action", "extension.json"), JSON.stringify({ name: "Bad", actions: [null, 5, { id: "x" }] }))
  try {
    const listed = await pdkJson(["ext", "list"])
    expect(listed.reply.ok, `ext list failed: ${listed.reply.error?.message}`)
    expect(listed.reply.data.extensions.some((extension: { id: string }) => extension.id === "fine"), "the good extension did not load")
    for (const id of ["broken", "bad-action", "empty"]) expect(listed.reply.data.errors.some((error: string) => error.includes(id)), `nothing is said about ${id}`)
    expect((await pdk(["ext", "list"])).out.includes("! "), "the plain listing hides the errors")
  } finally { for (const id of ["broken", "bad-action", "fine", "empty"]) await rm(join(root, id), { recursive: true, force: true }) }
})

ev("F09", "An extension's action shows up in the dashboard as a form, and its output appears there", async () => {
  await ensure(A)
  await cp(join(ROOT, "extensions/examples/agent-tools"), join(env.PADDOCK_CONFIG_DIR, "extensions", "agent-tools"), { recursive: true })
  const page = await browser((await pdkJson(["ui"])).reply.data.url)
  try {
    const button = `[...(${panel(A)}?.querySelectorAll("form button") ?? [])].find((node) => node.textContent === "System info")`
    expect(await page.waitFor(`Boolean(${button})`, 15), "the action's button never appeared")
    expect(await page.evaluate(`${panel(A)}.querySelector('form input[name="version"]')?.value`) === "latest", "the other action's field does not show its default")
    await page.evaluate(`${button}.click()`)
    expect(await page.waitFor(`/gvisor/i.test(${panel(A)}?.querySelector("pre")?.textContent ?? "")`, 30), `the output never appeared: ${await page.evaluate(`${panel(A)}?.querySelector("pre")?.textContent`)}`)
  } finally { await page.close(); await rm(join(env.PADDOCK_CONFIG_DIR, "extensions", "agent-tools"), { recursive: true, force: true }) }
})

ev("F06", "Every command prints one line of JSON with --json, for results and for errors", async () => {
  await ensure(A)
  const commands = [["doctor"], ["list"], ["start", A], ["verify", A], ["exec", A, "--", "true"], ["ext", "list"], ["ui"], ["daemon", "status"], ["version"], ["help"],
    ["start", "nope-nope"], ["create", "UPPER"], ["remove", A], ["frobnicate"], ["exec", A], ["ext", "run", "nope", "nope"], ["ext", "run", "x", "y", "--bogus"], ["create", "x", "--bogus"], ["stop"]]
  const wrong: string[] = []
  for (const command of commands) {
    const run = await pdk(["--json", ...command])
    const lines = run.out.trim().split("\n")
    let ok: unknown
    try { ok = JSON.parse(lines[0]!).ok } catch {}
    // exec's exit code is the command's own.
    if (lines.length !== 1 || typeof ok !== "boolean" || (!command.includes("--") && ok !== (run.code === 0))) wrong.push(`${command.join(" ")} (exit ${run.code}): ${run.out.slice(0, 80)}`)
  }
  expect(wrong.length === 0, wrong.join(" | "))
  return `${commands.length} commands`
})

ev("F07", "The skill tells an agent only true things: its commands exist, and it lists exactly the API's methods", async () => {
  const skill = await readFile(join(ROOT, "skill/SKILL.md"), "utf8")
  const commands = new Set([...skill.matchAll(/`?paddock ([a-z]+)(?: (list|run|status|stop))?/g)].map((match) => match[1]!))
  for (const command of commands) {
    const run = await pdk([command, ...(command === "ext" ? ["list"] : command === "daemon" ? ["status"] : [])], { timeoutMs: 30_000 })
    expect(!(run.code === 2 && run.err.includes("Unknown command")), `the skill names \`paddock ${command}\`, which does not exist`)
  }
  const listed = /Methods:\s*([^.]+)\./.exec(skill)?.[1]?.match(/`([a-z]+)`/g)?.map((word) => word.slice(1, -1)) ?? []
  expect(listed.length > 0, "the skill does not list the API's methods")
  for (const method of listed) {
    const reply = await tcp(`/api/${method}`)
    expect(reply.status !== 403 && !(await reply.text()).includes("No such method"), `the skill lists ${method}, which the dashboard's port does not offer`)
  }
  const source = await readFile(join(ROOT, "core/daemon.ts"), "utf8")
  const offered = [...source.matchAll(/^\s{4}([a-z]+): \{ run:(.*)$/gm)].filter((match) => !match[2]!.includes("socketOnly")).map((match) => match[1]!)
  const unlisted = offered.filter((method) => !listed.includes(method) && method !== "version")
  expect(unlisted.length === 0, `the skill does not mention ${unlisted.join(", ")}`)
  for (const flag of [...skill.matchAll(/\[(--[a-z]+)/g)].map((match) => match[1]!)) expect((await pdk(["help"])).out.includes(flag), `the skill uses ${flag}, which help does not list`)
  const codes = /Exit codes: ([^\n]+)/.exec(skill)?.[1]; expect(codes && (await pdk(["help"])).out.includes(codes), "the skill's exit codes differ from the CLI's")
})

ev("F08", "The README and architecture notes name only commands, files and checks that exist", async () => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8"); const architecture = await readFile(join(ROOT, "docs/architecture.md"), "utf8")
  for (const command of new Set([...`${readme}\n${architecture}`.matchAll(/(?:bin\/)?paddock ([a-z]+)/g)].map((match) => match[1]!))) {
    const run = await pdk([command, ...(command === "ext" ? ["list"] : command === "daemon" ? ["status"] : [])], { timeoutMs: 30_000 })
    expect(!(run.code === 2 && run.err.includes("Unknown command")), `the docs name \`paddock ${command}\`, which does not exist`)
  }
  for (const path of new Set([...`${readme}\n${architecture}`.matchAll(/[`(]((?:core|cli|ui|skill|docs|extensions|evals)\/[A-Za-z0-9_./-]+)[`)]/g)].map((match) => match[1]!)))
    expect(await Bun.file(join(ROOT, path)).exists() || (await stat(join(ROOT, path)).catch(() => undefined))?.isDirectory(), `the docs point at ${path}, which does not exist`)
  const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version as string
  expect((await pdk(["version"])).out.trim() === version, "the binary's version differs from package.json")
  expect(readme.includes(version), `the README does not mention version ${version}`)
  const rows = architecture.split("\n").filter((line) => /^\| [A-Z].*\| (yes|no) \|/.test(line))
  expect(rows.length === CHECKLIST.length, `the architecture table has ${rows.length} checks and the checklist has ${CHECKLIST.length}`)
  rows.forEach((row, index) => expect((row.split("|")[2]!.trim() === "yes") === CHECKLIST[index]!.blocking, `the table says check ${index + 1} is ${row.split("|")[2]!.trim() === "yes" ? "" : "not "}blocking, and the checklist differs`))
})

// U: a person, or an agent, can use it without reading the source.
ev("U01", "Exit codes tell the kinds of failure apart, as the help says", async () => {
  await ensure(A)
  const cases: Array<[string[], number]> = [[["list"], 0], [["create", "UPPER"], 2], [["create"], 2], [["frobnicate"], 2], [["start", "nope-nope"], 3], [["verify", "nope-nope"], 3], [["exec", "nope-nope", "--", "id"], 3],
    [["remove", "nope-nope", "--confirm", "nope-nope"], 3], [["create", A], 4], [["create", `${PREFIX}-x`, "--engine", "gvisor:nope"], 5], [["exec", A, "--", "sh", "-c", "exit 7"], 7], [["ext", "run", "nope", "nope"], 3]]
  const wrong: string[] = []
  for (const [command, code] of cases) { const run = await pdk(command); if (run.code !== code) wrong.push(`${command.join(" ")} exited ${run.code}, expected ${code}`) }
  await socket("stop", { name: A })
  const stopped = await pdk(["exec", A, "--", "id"]); if (stopped.code !== 4) wrong.push(`exec on a stopped sandbox exited ${stopped.code}, expected 4`)
  await socket("start", { name: A })
  expect(wrong.length === 0, wrong.join("; "))
})

ev("U02", "Help lists every command, and errors say what to do next", async () => {
  const help = (await pdk(["help"])).out
  const source = await readFile(join(ROOT, "cli/cli.ts"), "utf8")
  const commands = [...source.matchAll(/^      case "([a-z]+)"/gm)].map((match) => match[1]!).filter((command) => !["help", "version"].includes(command))
  for (const command of commands) expect(new RegExp(`paddock ${command}\\b|\\| ${command} NAME`).test(help), `help does not mention ${command}`)
  expect((await pdk([])).out === help, "running paddock alone does not print help")
  const noEngine = await pdk(["create", `${PREFIX}-x`, "--engine", "gvisor:nope"]); expect(noEngine.err.includes("paddock doctor"), "a missing engine does not point at doctor")
  const stopped = `${PREFIX}-a`; await ensure(stopped)
  expect((await pdk(["exec", A])).err.includes("--"), "exec without a command does not show the form")
  expect((await pdk(["remove", A])).err.toLowerCase().includes("confirm"), "remove without --confirm does not say how to confirm")
  expect((await pdk(["start"])).err.includes("name"), "start without a name does not ask for one")
})

ev("U03", "The dashboard, in a real browser, shows each sandbox with the same check results the API gives", async () => {
  await ensure(A)
  const api = (await socket("verify", { name: A })).reply.data.checks as Array<{ id: string; status: string; detail: string }>
  const page = await browser((await pdkJson(["ui"])).reply.data.url)
  try {
    expect(await page.waitFor(`Boolean(${panel(A)})`, 15), `the sandbox never appeared: ${String(await page.evaluate("document.body.innerText")).slice(0, 300)}`)
    expect(await page.evaluate("location.hash === '' && !location.href.includes('token')"), "the token stays in the address bar")
    expect(await page.evaluate(`${panel(A)}.querySelector(".badge").textContent`) === "running", "the status badge is wrong")
    await page.evaluate(`[...${panel(A)}.querySelectorAll("button")].find((button) => /Checks|failed|Not verified/.test(button.textContent)).click()`)
    expect(await page.waitFor(`${panel(A)}.querySelectorAll("ul.checks li[class]").length >= ${api.length}`, 5), "the checks did not open")
    const shown = await page.evaluate(`[...${panel(A)}.querySelectorAll("ul.checks li")].filter((node) => node.querySelector(".mark")).map((node) => ({ status: node.className, text: node.innerText }))`) as Array<{ status: string; text: string }>
    expect(shown.length === api.length, `${shown.length} checks shown, ${api.length} in the API`)
    api.forEach((check, index) => {
      const title = CHECKLIST.find((item) => item.id === check.id)!.title
      expect(shown[index]!.status === check.status && shown[index]!.text.includes(title) && shown[index]!.text.includes(check.detail), `the dashboard shows "${shown[index]!.text.slice(0, 80)}" (${shown[index]!.status}) for ${check.id} (${check.status})`)
    })
    expect(await page.evaluate(`document.getElementById("engines").innerText.includes("ready")`), "no engine is shown as ready")
    expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "the page scrolls sideways")
  } finally { await page.close() }
})

ev("U04", "In a real browser, the dashboard creates a sandbox, refuses a mistyped removal, and removes it", async () => {
  const name = `${PREFIX}-u`
  const page = await browser((await pdkJson(["ui"])).reply.data.url)
  try {
    expect(await page.waitFor(`document.querySelector("#f-engine option")?.value`, 15), "the engine list never loaded")
    await page.evaluate(`document.getElementById("f-name").value = ${JSON.stringify(name)}; document.getElementById("create").requestSubmit(); true`)
    expect(await page.waitFor(`document.querySelector("#create button").textContent.includes("Creating")`, 3), "the button gives no sign that anything started")
    expect(await page.waitFor(`${panel(name)}?.querySelector(".badge").textContent === "running" && document.querySelector("#create button").textContent === "Create and verify"`, 120), `the sandbox never showed as running: ${await page.evaluate(`document.getElementById("create-error").textContent`)}`)
    expect(await page.evaluate(`${panel(name)}.querySelectorAll("ul.checks li.pass").length`) >= 8, "a new sandbox's checks are not open")
    const remove = `[...${panel(name)}.querySelectorAll("button")].find((button) => button.textContent === "Remove").click()`
    page.answerPromptsWith("something else"); await page.evaluate(remove)
    expect(await page.waitFor(`${panel(name)}?.querySelector("pre")?.textContent.includes("Confirm")`, 10), "a mistyped name gave no error")
    expect(await view(name), "a mistyped name removed the sandbox")
    page.answerPromptsWith(name); await page.evaluate(remove)
    expect(await page.waitFor(`!${panel(name)}`, 60), "the sandbox stayed on the page")
    expect(!await view(name), "the sandbox was not removed")
    await page.evaluate(`document.getElementById("f-name").value = "ok-name"; document.getElementById("f-image").value = "--privileged"; document.getElementById("create").requestSubmit(); true`)
    expect(await page.waitFor(`document.getElementById("create-error").textContent.includes("image")`, 10), "a refused create shows no error")
  } finally { await page.close(); await socket("remove", { name, confirm: name }) }
})

ev("U05", "It is quick enough to use: list under a second, verify under 30 s, create under 60 s", async () => {
  await ensure(A)
  const time = async (argv: string[]) => { const start = Date.now(); const run = await pdk(argv); expect(run.code === 0, `${argv.join(" ")} failed: ${run.err}`); return (Date.now() - start) / 1000 }
  const list = await time(["list"]); const verify = await time(["verify", A])
  const name = `${PREFIX}-q`; const create = await time(["create", name, "--image", "alpine:latest"]); await pdk(["remove", name, "--confirm", name])
  expect(list < 1 && verify < 30 && create < 60, `list ${list.toFixed(1)} s, verify ${verify.toFixed(1)} s, create ${create.toFixed(1)} s`)
  return `list ${list.toFixed(2)} s, verify ${verify.toFixed(1)} s, create ${create.toFixed(1)} s`
})

ev("U06", "`paddock shell` gives a working terminal session", async () => {
  await ensure(A)
  if ((await sh(["python3", "-c", "import pty"])).code !== 0) skip("python3 is needed to give the command a terminal")
  const wrap = (command: string[]) => ["python3", join(ROOT, "evals/terminal.py"), ...command]
  const session = await sh(wrap([BIN, "shell", A]), { stdin: "echo $((6*7)); [ -t 0 ] && echo on-a-terminal; exit\n", env, timeoutMs: 40_000 })
  expect(session.code === 0 && session.out.includes("42") && session.out.includes("\non-a-terminal"), `the session (exit ${session.code}) printed: ${session.out.slice(-300)} ${session.err.slice(0, 200)}`)
  const one = await sh(wrap([BIN, "shell", A, "--", "echo", "one-off"]), { stdin: "", env, timeoutMs: 30_000 })
  expect(one.out.includes("one-off"), "a command after -- did not run")
  expect((await sh(wrap([BIN, "shell", A, "--", "sh", "-c", "exit 9"]), { stdin: "", env, timeoutMs: 30_000 })).code === 9, "the session's exit code is lost")
})

ev("U07", "Progress goes to stderr and results to stdout, so output can be piped", async () => {
  const name = `${PREFIX}-p`
  const made = await pdk(["create", name, "--image", "alpine:latest"])
  try {
    expect(made.code === 0, `create failed: ${made.err}`)
    expect(made.err.includes("…") && !made.out.includes("…"), "progress lines are missing or on stdout")
    expect(CHECKLIST.every((item) => made.out.includes(item.title)), "create does not print every check")
    const json = await pdk(["--json", "verify", name]); expect(json.err === "", `--json wrote to stderr: ${json.err}`)
    const piped = await pdk(["exec", name, "--", "sh", "-c", "printf out; printf err >&2"]); expect(piped.out === "out" && piped.err === "err", "exec mixes the command's stdout and stderr")
    const binary = await pdk(["exec", name, "--stdin", "--", "wc", "-c"], { stdin: "x".repeat(200_000) }); expect(binary.out.trim() === "200000", "--stdin lost input")
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("U08", "A state folder whose path is too long for a socket is refused with a message that says so", async () => {
  const long = join(tmp, "x".repeat(120))
  const run = await pdk(["list"], { env: { PADDOCK_STATE_DIR: long }, timeoutMs: 30_000 })
  await sh(["pkill", "-f", long]).catch(() => {})
  expect(run.code !== 0 && /too long|shorter/i.test(run.err), `it said: ${run.err.trim().slice(0, 200)}`)
})

ev("U09", "A sandbox is usable: names resolve, HTTPS works, files survive a stop and start, and a 31-character name is fine", async () => {
  const name = `${PREFIX}-${"n".repeat(31 - PREFIX.length - 1)}`
  await ensure(name)
  try {
    const web = await pdk(["exec", name, "--", "wget", "-q", "-T", "10", "-O", "/dev/null", "https://example.com"])
    if (web.code !== 0 && (await sh(["curl", "-sf", "-m", "10", "-o", "/dev/null", "https://example.com"])).code !== 0) skip("this machine is offline")
    expect(web.code === 0, `https://example.com could not be fetched by name from inside: ${web.err.trim()}`)
    await pdk(["exec", name, "--", "sh", "-c", "echo kept > /root/note"])
    expect((await pdk(["stop", name])).code === 0 && (await pdk(["start", name])).code === 0, "stop or start failed")
    expect((await pdk(["exec", name, "--", "cat", "/root/note"])).out.trim() === "kept", "a file did not survive the stop and start")
    expect((await pdk(["exec", name, "--", "wget", "-q", "-T", "10", "-O", "/dev/null", "https://example.com"])).code === 0, "names stopped resolving after a restart")
    expect((await pdk(["exec", name, "--", "hostname"])).out.trim() === name, "the hostname is not the sandbox's name")
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("U10", "exec carries large output and a non-zero exit through unchanged", async () => {
  await ensure(A)
  const big = await pdk(["exec", A, "--", "sh", "-c", "head -c 6000000 /dev/zero | tr '\\0' x; exit 3"])
  expect(big.out.length === 6_000_000 && big.code === 3, `${big.out.length} bytes came back with exit ${big.code}`)
})

ev("U11", "The default image (no --image) makes a sandbox that passes every blocking check", async () => {
  const image = "docker/sandbox-templates:shell-docker"
  if ((await docker(["image", "inspect", image])).code !== 0) skip(`${image} is not on this engine, and the eval does not download it (it is large)`)
  const name = `${PREFIX}-i`
  const made = await socket("create", { name, image, cpus: 1, memoryGb: 2, diskGb: 20 })
  try {
    expect(made.reply.ok, `create failed: ${made.reply.error?.message}`)
    const bad = (made.reply.data.checks as Array<{ id: string; status: string }>).filter((check) => CHECKLIST.find((item) => item.id === check.id)!.blocking && check.status !== "pass")
    expect(bad.length === 0, `not passing: ${bad.map((check) => `${check.id} ${check.status}`).join(", ")}`)
    expect((await pdk(["exec", name, "--user", "agent", "--", "sh", "-c", "id -un && command -v git node"])).code === 0, "the image's agent user, git or node is missing")
  } finally { await socket("remove", { name, confirm: name }) }
})

// D: the daemon keeps its promises through crashes, races and upgrades.
ev("D01", "After the daemon is killed, the next command starts a new one that still knows every sandbox", async () => {
  await ensure(A)
  const before = await daemonFile()
  process.kill(before.pid, "SIGKILL"); await Bun.sleep(300)
  const list = await pdkJson(["list"])
  expect(list.reply.ok && list.reply.data.some((sandbox: { name: string; status: string }) => sandbox.name === A && sandbox.status === "running"), "the sandbox is not listed as running")
  expect((await daemonFile()).pid !== before.pid, "no new daemon started")
})

ev("D02", "Two creates of one name at the same moment: one succeeds, one is refused, and the list still answers", async () => {
  const name = `${PREFIX}-c`
  const first = pdk(["create", name]); const second = pdk(["create", name])
  await Bun.sleep(1500)
  const start = Date.now(); const list = await pdk(["list"]); const took = Date.now() - start
  const codes = [(await first).code, (await second).code].sort()
  try {
    expect(codes[0] === 0 && codes[1] === 4, `the exit codes were ${codes.join(" and ")}`)
    expect(list.code === 0 && took < 3000, `list took ${took} ms during a create`)
    expect(list.out.includes(name), "the sandbox being created is not in the list")
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("D03", "A second daemon refuses to run beside the first", async () => {
  await pdk(["list"])
  const second = await pdk(["daemon", "run"], { timeoutMs: 15_000 })
  expect(second.code === 4, `it exited ${second.code}: ${second.err}`)
  expect((await pdk(["list"])).code === 0, "the first daemon was disturbed")
})

ev("D04", "Stopping the daemon stops the sandboxes only it limits, says why, and a start brings them back", async () => {
  await ensure(A)
  const disk = (await socket("engines", {})).reply.data.find((engine: { ready: boolean }) => engine.ready).capabilities.diskLimit
  if (disk !== "watched") skip(`the disk limit here is ${disk}, so nothing depends on the daemon`)
  expect((await pdk(["daemon", "stop"])).code === 0, "daemon stop failed")
  expect(!await running(A), "a sandbox with a watched disk limit kept running with no daemon")
  expect(!await Bun.file(join(env.PADDOCK_STATE_DIR, "daemon.sock")).exists() && !await Bun.file(join(env.PADDOCK_STATE_DIR, "daemon.json")).exists(), "the socket or the token file was left behind")
  expect((await pdk(["list"])).out.includes("Stopped with the daemon"), "the list does not say why it stopped")
  expect((await pdk(["start", A])).code === 0 && await running(A) && !(await view(A))?.stopReason, "start did not bring it back clean")
})

ev("D05", "A sandbox whose container was deleted behind Paddock's back is shown as missing and can be removed", async () => {
  const name = `${PREFIX}-m`
  await ensure(name)
  await docker(["rm", "-f", containerOf(name)])
  expect((await view(name))?.status === "missing", "it is not shown as missing")
  expect((await pdk(["start", name])).code !== 0, "start claimed to work")
  expect((await pdk(["remove", name, "--confirm", name])).code === 0, "it could not be removed")
  expect((await docker(["network", "inspect", `paddock-net-${name}`])).code !== 0, "its network was left behind")
})

ev("D06", "A damaged state file does not hide the other sandboxes", async () => {
  await ensure(A)
  const file = join(env.PADDOCK_STATE_DIR, "sandboxes", "zz-damaged.json")
  await writeFile(file, "{ this is not json")
  try {
    const list = await pdkJson(["list"])
    expect(list.reply.ok, `list failed: ${list.reply.error?.message}`)
    expect(list.reply.data.some((sandbox: { name: string }) => sandbox.name === A), "the healthy sandbox is not listed")
    expect(JSON.stringify(list.reply.data).includes("zz-damaged"), "nothing is said about the damaged file")
    expect((await pdk(["verify", A])).code === 0, "the healthy sandbox cannot be verified")
  } finally { await rm(file, { force: true }) }
})

ev("D07", "A newer Paddock replaces the running daemon without stopping its sandboxes", async () => {
  await ensure(A)
  const next = join(tmp, "next"); await mkdir(next, { recursive: true })
  for (const part of ["core", "cli", "ui", "package.json", "tsconfig.json"]) await cp(join(ROOT, part), join(next, part), { recursive: true })
  const pkg = JSON.parse(await readFile(join(next, "package.json"), "utf8")); const version = `${pkg.version}-next`
  await writeFile(join(next, "package.json"), JSON.stringify({ ...pkg, version }))
  const built = await sh([BUN, "build", "--compile", "--outfile", join(next, "paddock"), "cli/cli.ts"], { cwd: next })
  expect(built.code === 0, `the second build failed: ${built.err}`)
  const before = await daemonFile()
  const list = await sh([join(next, "paddock"), "--json", "list"], { env })
  expect(list.code === 0 && (await sh([join(next, "paddock"), "version"], { env })).out.trim() === version, `the newer binary failed: ${list.err}`)
  const after = await daemonFile()
  expect(after.version === version && after.pid !== before.pid, `the daemon is still ${after.version}`)
  expect(await running(A), "the sandbox was stopped by the switch")
  expect((await pdk(["list"])).code === 0 && (await daemonFile()).version === pkg.version, "the original binary could not take the daemon back")
  expect(await running(A), "the sandbox was stopped by the switch back")
})

ev("D08", "A rebuilt binary of the same version replaces the daemon the old build left running", async () => {
  await ensure(A)
  const before = await daemonFile()
  const copy = join(tmp, "rebuilt"); await cp(BIN, copy); await Bun.sleep(1100); await sh(["touch", copy])
  expect((await sh([copy, "list"], { env })).code === 0, "the rebuilt binary failed")
  expect((await daemonFile()).pid !== before.pid, "the old build's daemon is still serving")
  expect(await running(A), "the sandbox was stopped by the switch")
  expect((await pdk(["list"])).code === 0 && await running(A), "the original binary could not take the daemon back")
})

// P: other platforms, as far as this machine can show.
ev("P01", "Standalone binaries build for macOS, Linux and Windows", async () => {
  const out = join(tmp, "cross"); const built: string[] = []
  for (const target of ["bun-darwin-arm64", "bun-linux-x64", "bun-linux-arm64", "bun-linux-arm64-musl", "bun-linux-x64-musl", "bun-windows-x64"]) {
    const run = await sh([BUN, "build", "--compile", "--minify", `--target=${target}`, "--outfile", join(out, target), "cli/cli.ts"], { cwd: ROOT, timeoutMs: 300_000 })
    expect(run.code === 0, `${target} did not build: ${run.err.slice(-300)}`)
    built.push(target.replace("bun-", ""))
  }
  return built.join(", ")
})

ev("P02", "The Linux binary, run on Linux, creates a sandbox that passes every blocking check", async () => {
  const arch = (await docker(["info", "--format", "{{.Architecture}}"])).out.trim()
  const target = /arm64|aarch64/.test(arch) ? "bun-linux-arm64-musl" : "bun-linux-x64-musl"
  const binary = join(tmp, "cross", target)
  if (!await Bun.file(binary).exists()) {
    const run = await sh([BUN, "build", "--compile", "--minify", `--target=${target}`, "--outfile", binary, "cli/cli.ts"], { cwd: ROOT, timeoutMs: 300_000 })
    expect(run.code === 0, `the Linux build failed: ${run.err.slice(-300)}`)
  }
  const name = `${PREFIX}-l`; const runner = `${PREFIX}-linux`
  // A Linux container that holds only the binary and a docker client, talking to the engine through its socket. The
  // sandbox it makes is a sibling on the same engine, so this exercises the CLI and daemon on Linux, not a second engine.
  const started = await docker(["run", "-d", "--rm", "--name", runner, "--runtime", "runc", "-v", "/var/run/docker.sock:/var/run/docker.sock", "docker:cli", "sleep", "900"], { timeoutMs: 300_000 })
  expect(started.code === 0, `the Linux container did not start: ${started.err}`)
  try {
    await docker(["exec", runner, "apk", "add", "--no-cache", "libstdc++", "libgcc"], { timeoutMs: 120_000 })
    expect((await docker(["cp", binary, `${runner}:/usr/local/bin/paddock`])).code === 0, "the binary could not be copied in")
    const inside = (argv: string[]) => docker(["exec", runner, "paddock", ...argv], { timeoutMs: 240_000 })
    const doctor = await inside(["doctor"]); expect(doctor.code === 0 && doctor.out.includes("✓"), `doctor on Linux: ${doctor.out}${doctor.err}`)
    const made = await inside(["--json", "create", name, "--image", "alpine:latest", "--cpus", "1", "--memory", "1", "--disk", "1"])
    const reply = JSON.parse(made.out || "{}")
    expect(reply.ok, `create on Linux failed: ${reply.error?.message ?? made.err}`)
    const bad = reply.data.checks.filter((check: { id: string; status: string }) => CHECKLIST.find((item) => item.id === check.id)!.blocking && check.status !== "pass")
    expect(bad.length === 0, `not passing: ${bad.map((check: { id: string; status: string }) => `${check.id} ${check.status}`).join(", ")}`)
    expect(/gvisor/i.test((await inside(["exec", name, "--", "cat", "/proc/version"])).out), "exec on Linux did not reach the sandbox")
    expect((await inside(["verify", name])).code === 0 && (await inside(["stop", name])).code === 0 && (await inside(["start", name])).code === 0, "verify, stop or start failed on Linux")
    expect((await inside(["remove", name, "--confirm", name])).code === 0, "remove failed on Linux")
    return `${target.replace("bun-", "")} in a ${arch} Linux container, against this machine's engine`
  } finally { await docker(["exec", runner, "paddock", "remove", name, "--confirm", name]); await docker(["rm", "-f", runner]) }
})

ev("P03", "The core has no code that only works on one operating system", async () => {
  const offenders: string[] = []
  for (const file of ["core/core.ts", "core/daemon.ts", "core/state.ts", "core/run.ts", "core/extensions.ts", "core/checks.ts", "core/providers/gvisor.ts", "cli/cli.ts"]) {
    const text = (await readFile(join(ROOT, file), "utf8")).replace(/\/\/.*$/gm, "")
    for (const word of ["osascript", "pbcopy", "launchctl", "/opt/homebrew", "security find-", "vm_stat"]) if (text.includes(word)) offenders.push(`${file}: ${word}`)
    // Every platform branch must name Windows as well as macOS, or name neither.
    if (/process\.platform/.test(text) && !/win32/.test(text)) offenders.push(`${file}: a platform branch without Windows`)
  }
  expect(offenders.length === 0, offenders.join("; "))
  expect(!/"win32" \? \[?"start"/.test(await readFile(join(ROOT, "cli/cli.ts"), "utf8")), "on Windows `start` is a shell builtin, so `ui --open` cannot spawn it")
})

// E: claims nobody has measured. They are listed so the scorecard does not read as if they had been.
for (const [id, claim, why] of [
  ["E01", "After the engine restarts, no sandbox runs without its guard", "restarting the engine would stop every other container on this machine"],
  ["E02", "The same checks hold on Docker Desktop, Colima and a Linux host's own Docker", "only one engine is installed here; run the evals on each"],
  ["E03", "The Windows binary runs (the daemon's socket, the dashboard, `ui --open`)", "there is no Windows machine here; the binary only builds"],
  ["E04", "A device on your real LAN or tailnet does not answer", "the evals use stand-in addresses and never contact your own devices"],
] as const) ev(id, claim, async () => skip(why))

ev("Z01", "Nothing is left on the engine or this machine when the run ends", async () => {
  await teardown()
  const containers = (await docker(["ps", "-a", "--format", "{{.Names}} {{.Labels}}"])).out.split("\n").filter((line) => line.includes(PREFIX) || line.includes("dev.paddock.probe"))
  const networks = (await docker(["network", "ls", "--format", "{{.Name}}"])).out.split("\n").filter((line) => line.includes(PREFIX) || line.startsWith("paddock-net-probe-"))
  // A network namespace takes a moment to go after its container.
  const leftLinks = async () => (await asRoot("ip -br link")).out.split("\n").filter((line) => line.startsWith(PREFIX) || /^pv[0-9a-f]{8}/.test(line))
  await until(async () => (await leftLinks()).length === 0, 15)
  const links = await leftLinks()
  const processes = (await sh(["pgrep", "-fl", tmp])).out.trim()
  expect(!containers.length && !networks.length && !links.length && !processes, `left behind: ${[...containers, ...networks, ...links, processes].filter(Boolean).join(", ")}`)
})

let tornDown = false
async function teardown(): Promise<void> {
  if (tornDown) return
  tornDown = true
  for (const sandbox of ((await pdkJson(["list"]).catch(() => undefined))?.reply.data ?? []) as Array<{ name: string }>) await pdk(["remove", sandbox.name, "--confirm", sandbox.name])
  await pdk(["daemon", "stop"])
  await docker(["rm", "-f", HOST])
  for (const line of (await docker(["ps", "-a", "--format", "{{.Names}}"])).out.split("\n").filter((name) => name.includes(PREFIX))) await docker(["rm", "-f", line])
  for (const line of (await docker(["network", "ls", "--format", "{{.Name}}"])).out.split("\n").filter((name) => name.includes(PREFIX))) await docker(["network", "rm", line])
}

// ---- run
const wanted = evals.filter((entry) => !only || only.some((key) => entry.id === key || (key.length === 1 && entry.id.startsWith(key))) || entry.id === "Z01")
console.error(`Building, and starting a Paddock of its own in ${tmp} (sandboxes are named ${PREFIX}-…)`)
const build = await sh([BUN, "build", "--compile", "--minify", "--outfile", BIN, "cli/cli.ts"], { cwd: ROOT })
if (build.code !== 0) { console.error(build.err); process.exit(1) }
await mkdir(env.PADDOCK_CONFIG_DIR, { recursive: true })
await writeFile(join(env.PADDOCK_CONFIG_DIR, "config.json"), JSON.stringify({ defaults: { image: "alpine:latest", cpus: 0.5, memoryGb: 0.5, diskGb: 1 } }))
const engines = (await pdkJson(["doctor"])).reply.data as Array<{ id: string; label: string; ready: boolean; data: { context: string; runtime: string }; capabilities?: { diskLimit: string } }>
const engine = engines.find((entry) => entry.ready)
if (!engine) { console.error("No engine is ready. Run `paddock doctor`."); process.exit(1) }
context = engine.data.context
// The tamper evals change the guard for the whole engine, which would stop sandboxes of the user's own Paddock.
const others = (await docker(["ps", "--filter", "label=dev.paddock.name", "--format", "{{.Names}}"])).out.trim()
if (others) { console.error(`Other Paddock sandboxes are running on this engine (${others.replace(/\n/g, ", ")}). The evals tamper with the guard they share, so stop them first.`); process.exit(1) }
await docker(["pull", "-q", "alpine:latest"], { timeoutMs: 300_000 })

type Outcome = { id: string; claim: string; result: "pass" | "fail" | "not measured"; note: string; seconds: number }
const outcomes: Outcome[] = []
const interrupted = () => { void teardown().then(() => process.exit(130)) }
process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted)
for (const entry of wanted) {
  const start = Date.now(); let result: Outcome["result"] = "pass"; let note = ""
  try { note = (await Promise.race([entry.run(), Bun.sleep(420_000).then(() => { throw new Error("no result after 7 minutes") })])) ?? "" }
  catch (error) { result = error instanceof Skip ? "not measured" : "fail"; note = (error as Error).message }
  outcomes.push({ id: entry.id, claim: entry.claim, result, note, seconds: Math.round((Date.now() - start) / 1000) })
  console.error(`${result === "pass" ? "✓" : result === "fail" ? "✗" : "–"} ${entry.id} ${entry.claim}${note ? `\n      ${note}` : ""}`)
}
await teardown()
await rm(tmp, { recursive: true, force: true })

const passed = outcomes.filter((entry) => entry.result === "pass").length; const failed = outcomes.filter((entry) => entry.result === "fail").length
const unmeasured = outcomes.length - passed - failed
const summary = `${passed} of ${outcomes.length} hold, ${failed} do not, ${unmeasured} could not be measured here`
console.log(`\n${summary}`)
if (args.includes("--write")) {
  const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version
  const commit = (await sh(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT })).out.trim(); const dirty = (await sh(["git", "status", "--porcelain", "--", "core", "cli", "ui", "skill", "extensions"], { cwd: ROOT })).out.trim() ? " plus uncommitted changes" : ""
  const mark = { pass: "✓", fail: "✗", "not measured": "–" }
  await writeFile(join(ROOT, "evals/SCORECARD.md"), `# Scorecard

Written by \`bun evals/run.ts --write\`. Do not edit by hand.

- Paddock ${version} at \`${commit}\`${dirty}
- Engine: ${engine.label}, runtime \`${engine.data.runtime}\`, disk limit ${engine.capabilities?.diskLimit}
- Run from ${process.platform} ${process.arch} on ${new Date().toISOString().slice(0, 10)}
- **${summary}.**

| | Id | Claim | Note |
|---|---|---|---|
${outcomes.map((entry) => `| ${mark[entry.result]} | ${entry.id} | ${entry.claim} | ${entry.note.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`).join("\n")}

✓ holds   ✗ does not hold   – could not be measured on this machine
`)
}
process.exit(failed ? 1 : 0)
