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
import { connect, createServer, type AddressInfo } from "node:net"
import { networkInterfaces, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { CHECKLIST } from "../core/checks"
import { DOCKER_CAPABILITIES, DOCKER_DRIVER, DOCKER_START, HELPER_IMAGE } from "../core/providers/gvisor"
import { HOST_APPLY } from "../core/host-scripts"
import { GVISOR, GVISOR_FILES, GVISOR_RELEASE, type HostPlan } from "../core/hosts"
import type { HostView } from "../core/machines"
import { OUTPUT_LIMIT } from "../core/run"
import { FrameReader, frame } from "../core/stream"
import { WAIT_FOR_PROBE_ROUTES } from "../core/providers/probe"
import HELPER_DOCKERFILE from "../core/providers/helper.Dockerfile" with { type: "text" }
import { runWorkspaceEvals, workspaceSuite } from "./workspace"

const ROOT = join(dirname(Bun.main), "..")
const BUN = process.execPath
const REPLY = "paddock-eval-reply"
const args = process.argv.slice(2)
const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined
const scoreLabel = args.includes("--label") ? args[args.indexOf("--label") + 1] : undefined
if (args.includes("--label") && (!scoreLabel || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(scoreLabel))) throw new Error("--label needs 1 to 32 lowercase letters, digits or hyphens")
const PREFIX = `ev${Math.random().toString(36).slice(2, 6)}`
const A = `${PREFIX}-a`; const B = `${PREFIX}-b`
const INNER = `${PREFIX}-inner`
const DOCKER_IMAGE = "docker/sandbox-templates:shell-docker"

type Sh = { code: number; out: string; err: string }
async function sh(argv: string[], options: { stdin?: string | Uint8Array; env?: Record<string, string>; timeoutMs?: number; cwd?: string } = {}): Promise<Sh> {
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
if (only?.length && only.every((id) => id.startsWith("K"))) {
  const binary = join(ROOT, "dist", "paddock")
  const build = await sh([BUN, "build", "--compile", "--minify", "--outfile", binary, "cli/cli.ts"], { cwd: ROOT })
  if (build.code !== 0) { console.error(build.err); process.exit(1) }
  process.exit(await runWorkspaceEvals(args, binary))
}
const tmp = await mkdtemp(join(tmpdir(), "pdk-"))
// PADDOCK_SSH_CONFIG: what `paddock ssh setup --write-config` changes instead of ~/.ssh/config.
const env = { PADDOCK_STATE_DIR: join(tmp, "s"), PADDOCK_CONFIG_DIR: join(tmp, "c"), PADDOCK_PORT: "0", PADDOCK_SSH_CONFIG: join(tmp, "home", ".ssh", "config") }
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
  const script = `${WAIT_FOR_PROBE_ROUTES}
set -e
nc -lk -p ${HOST_PORT} -e echo ${REPLY} &
ip netns add far; ip link add ${PREFIX}a type veth peer name ${PREFIX}b; ip link set ${PREFIX}b netns far; ip link set ${PREFIX}a up
ip netns exec far ip link set lo up; ip netns exec far ip link set ${PREFIX}b up
for a in ${FAR.join(" ")}; do
  wait_probe_routes \${a}4
  route=$(ip route show match \${a}4 | grep -v '^default' || true)
  if [ -n "$route" ]; then echo "unavailable \${a}4: $route"; continue; fi
  ip addr add \${a}3/30 dev ${PREFIX}a; ip netns exec far ip addr add \${a}4/30 dev ${PREFIX}b
  ip netns exec far ip route add default via \${a}3 2>/dev/null || true; echo "far \${a}4"
done
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
const BROWSERS = [process.env.PADDOCK_EVAL_BROWSER ?? "", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
async function browser(url: string) {
  let path: string | undefined
  for (const candidate of BROWSERS) if (await Bun.file(candidate).exists()) { path = candidate; break }
  if (!path) skip("no Chromium-based browser found; set PADDOCK_EVAL_BROWSER to its executable path")
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
const workspaceEvals = workspaceSuite(BIN, skip)
evals.push(...workspaceEvals.evals)

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
  const leftover = await asRoot("ip -o link show; ip -o -4 route show; ip -o -6 route show")
  expect(leftover.code === 0 && !/\bpv[0-9a-f]{8}a(?:[@: ]|$)|\bpdkx[0-9a-f]{8}(?:[@: ]|$)/m.test(leftover.out), `verify returned before its links/routes disappeared: ${leftover.out}`)
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

ev("H03", "From inside a sandbox, this computer's controlled listener does not answer", async () => {
  await ensure(A)
  if (process.platform === "linux") {
    await hostHelper()
    const targets = await hostAddresses(), tried: string[] = []
    for (const ip of targets) {
      if (!await fromHost(ip, HOST_PORT)) continue
      tried.push(ip)
      expect(!await fromSandbox(A, ip, HOST_PORT), `the sandbox reached this Linux host at ${ip}`)
    }
    if (!tried.length) skip("none of the Linux host's addresses answered the host control")
    return `native Linux host addresses, each with a working control: ${tried.join(", ")}`
  }
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
  if (!farAddresses.length) skip(`no stand-in address was available: ${(await docker(["logs", HOST])).out}`)
  const reached: string[] = []; const tried: string[] = []; const unavailable: string[] = []
  for (const ip of farAddresses) {
    if (!await fromHost(ip, FAR_PORT)) { unavailable.push(`${ip}: host control failed`); continue }
    tried.push(ip)
    if (await fromSandbox(A, ip, FAR_PORT)) reached.push(ip)
  }
  if (!tried.length) skip(`no control connection worked: ${unavailable.join("; ")}`)
  expect(reached.length === 0, `the sandbox reached ${reached.join(", ")}`)
  return `stand-ins tried, each with a working control: ${tried.join(", ")}${unavailable.length ? `; unavailable: ${unavailable.join("; ")}` : ""}`
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
  // Where the logins extension imports a named profile.
  await pdk(["exec", A, "--stdin", "--", "sh", "-c", "mkdir -p /root/.claude-work && cat > /root/.claude-work/.credentials.json"], { stdin: "{}" })
  const open = (await pdk(["exec", A, "--", "nc", "-w", "4", "1.1.1.1", "443"], { stdin: "" })).code === 0
  const checks = (await socket("verify", { name: A })).reply.data.checks as Array<{ id: string; detail: string; status: string }>
  await pdk(["exec", A, "--", "rm", "-r", "/root/.netrc", "/root/.claude-work"])
  for (const file of ["/root/.netrc", "/root/.claude-work/.credentials.json"]) expect(checks.find((check) => check.id === "credentials")!.detail.includes(file), `a login file planted in the sandbox at ${file} was not disclosed`)
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

// I: Docker inside gVisor. These commands go straight to the engine, outside Paddock.
const innerDocker = (name: string, argv: string[], options: Parameters<typeof sh>[1] = {}) =>
  docker(["exec", ...(options.stdin === undefined ? [] : ["-i"]), "-u", "0", containerOf(name), "docker", "--host", "unix:///var/run/docker.sock", ...argv], options)
// Copies an image from the engine into a sandbox's inner Docker as bytes, so these evals do not spend Docker Hub pulls on
// it. `--pull never` below makes a missing copy fail loudly instead of pulling.
async function loadInner(name: string, image = "alpine:latest"): Promise<string> {
  const save = Bun.spawn(["docker", "--context", context, "save", image], { stdout: "pipe", stderr: "pipe" })
  const bytes = new Uint8Array(await new Response(save.stdout).arrayBuffer())
  expect(await save.exited === 0, `could not save ${image} on the engine: ${await new Response(save.stderr).text()}`)
  const load = Bun.spawn(["docker", "--context", context, "exec", "-i", "-u", "0", containerOf(name), "docker", "--host", "unix:///var/run/docker.sock", "load", "-q"], { stdin: bytes, stdout: "pipe", stderr: "pipe" })
  expect(await load.exited === 0, `could not load ${image} into ${name}: ${await new Response(load.stderr).text()}`)
  return (await innerDocker(name, ["image", "inspect", "--format", "{{.Id}}", image])).out.trim()
}
const seedAlpine = async (name: string) => { if ((await innerDocker(name, ["image", "inspect", "alpine:latest"])).code !== 0) await loadInner(name) }
const innerRun = (name: string, argv: string[], options: Parameters<typeof sh>[1] = {}) => innerDocker(name, ["run", "--rm", "--pull", "never", "alpine:latest", ...argv], options)
const innerReaches = async (name: string, ip: string, port: string) => {
  const attempt = await innerRun(name, ["nc", "-w", "2", ip, port], { timeoutMs: 20_000 })
  expect(attempt.code === 0 || attempt.code === 1, `the inner probe could not run (exit ${attempt.code}): ${attempt.err}`)
  return answers(attempt)
}
async function ensureInner(): Promise<void> {
  if (!await view(INNER)) {
    const made = await pdkJson(["create", INNER, "--docker", "--cpus", "1", "--memory", "1", "--disk", "4", "--image", DOCKER_IMAGE])
    expect(made.reply.ok, `Docker create failed: ${made.reply.error?.message}`)
  } else await ensure(INNER)
  await seedAlpine(INNER)
}
const dockerVolumeName = async (name: string): Promise<string> => (await inspect(name)).Mounts.find((mount: { Destination: string }) => mount.Destination === "/var/lib/docker")?.Name
const volumeBytes = async (volume: string) => {
  const du = await docker(["run", "--rm", "--runtime", "runc", "--network", "none", "--mount", `type=volume,src=${volume},dst=/data,readonly,volume-nocopy`, HELPER_IMAGE, "du", "-sk", "/data"])
  const bytes = Number(du.out.split(/\s/)[0]) * 1024
  expect(du.code === 0 && Number.isFinite(bytes), `could not measure Docker's data externally: ${du.err}`)
  return bytes
}

ev("I01", "NET_ADMIN and SYS_ADMIN are inclusion-minimal for copy-on-write pull, run, HTTPS and build", async () => {
  // Each subset runs Paddock's own start command, so the measured daemon is the one sandboxes get.
  await ensureInner()
  expect(JSON.stringify(DOCKER_CAPABILITIES) === JSON.stringify(["NET_ADMIN", "SYS_ADMIN"]), "update the measured capability set")
  const evidence: string[] = []
  for (const caps of [[], ["SYS_ADMIN"], ["NET_ADMIN"], [...DOCKER_CAPABILITIES]]) {
    const name = `${PREFIX}-caps`
    const exec = (argv: string[], options: Parameters<typeof sh>[1] = {}) => docker(["exec", "-i", "-u", "0", name, ...argv], options)
    try {
      const created = await docker(["run", "-d", "--name", name, "--runtime", engine!.data.runtime, "--network", `paddock-net-${INNER}`, "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "4096",
        "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=2", ...caps.flatMap((cap) => ["--cap-add", cap]), "--mount", "type=volume,dst=/var/lib/docker,volume-nocopy", "-u", "0", "--entrypoint", "sh", DOCKER_IMAGE, "-c", DOCKER_START])
      expect(created.code === 0, `the capability experiment could not start: ${created.err}`)
      let ready = false
      for (let attempt = 0; attempt < 40; attempt++) {
        if ((await exec(["docker", "info"])).code === 0) { ready = true; break }
        if ((await docker(["inspect", "--format", "{{.State.Running}}", name])).out.trim() !== "true") break
        await Bun.sleep(500)
      }
      const log = await docker(["logs", name])
      if (!caps.includes("NET_ADMIN")) {
        expect(!ready && /operation not permitted|permission denied/i.test(log.out + log.err) && /bridge|network controller/.test(log.out + log.err), `missing NET_ADMIN did not produce a bridge permission failure: ${log.out}${log.err}`)
        evidence.push(`${caps.join("+") || "none"}: bridge creation denied`)
        continue
      }
      expect(ready, `dockerd failed for an unrelated reason: ${log.out}${log.err}`)
      const driver = (await exec(["docker", "info", "--format", "{{.Driver}}"])).out.trim()
      expect(driver === DOCKER_DRIVER, `not copy-on-write: ${driver}`)
      const pulled = await exec(["docker", "pull", "alpine:latest"])
      if (!caps.includes("SYS_ADMIN")) {
        expect(pulled.code !== 0 && /operation not permitted|permission denied/i.test(pulled.out + pulled.err), `missing SYS_ADMIN did not deny extraction: ${pulled.out}${pulled.err}`)
        evidence.push(`NET_ADMIN: ${driver} image extraction denied (${pulled.err.trim().slice(-400)})`)
        continue
      }
      expect(pulled.code === 0, `full set pull failed: ${pulled.err}`)
      expect((await exec(["sh", "-ec", "iptables-legacy -t nat -A POSTROUTING -o eth0 -j MASQUERADE"])).code === 0, "could not set inner NAT")
      const bridge = (await docker(["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}', `paddock-net-${INNER}`])).out.trim()
      expect((await asRoot(`for port in /sys/class/net/${bridge}/brif/*; do ip link set "\${port##*/}" gso_max_segs 1; done`)).code === 0, "could not set segmentation")
      const online = await exec(["docker", "run", "--rm", "alpine:latest", "wget", "-T", "20", "-qO-", "https://example.com"])
      expect(online.code === 0 && online.out.includes("Example Domain"), `full set HTTPS failed: ${online.err}`)
      const built = await exec(["docker", "build", "-t", "cap-built", "-"], { stdin: "FROM alpine:latest\nRUN echo build-ok > /built\n" })
      expect(built.code === 0 && (await exec(["docker", "run", "--rm", "cap-built", "cat", "/built"])).out.trim() === "build-ok", `full set RUN build failed: ${built.err}`)
      evidence.push(`NET_ADMIN+SYS_ADMIN: ${driver}, pull, run, HTTPS, one-RUN build and its output passed`)
    } finally { await docker(["rm", "-f", "-v", name]) }
  }
  return `${evidence.join("; ")}. Relative to Docker's unchanged defaults, this image and engine; no other additions needed.`
})

ev("I02", "An inner container runs a small image and reaches the internet over HTTPS", async () => {
  await ensureInner()
  expect(/gvisor/i.test((await innerRun(INNER, ["cat", "/proc/version"])).out), "the inner container does not identify gVisor's kernel")
  const output = await innerRun(INNER, ["sh", "-c", "echo inner-ok; wget -T 20 -qO- https://example.com"])
  expect(output.code === 0 && output.out.startsWith("inner-ok\n") && output.out.includes("Example Domain"), `inner HTTPS failed: ${output.out}${output.err}`)
})

for (const kind of ["host", "peer", "private"] as const) ev({ host: "I03", peer: "I04", private: "I05" }[kind], `An inner container cannot reach the ${kind === "private" ? "stand-in LAN and tailnet addresses" : kind === "peer" ? "other sandbox" : "engine's host"}, with working controls`, async () => {
  await ensureInner(); await hostHelper()
  let listener: ReturnType<typeof Bun.spawn> | undefined
  let targets: string[]; let port: string
  if (kind === "peer") {
    await ensure(B, { pids: 256 })
    listener = Bun.spawn(["docker", "--context", context, "exec", containerOf(B), "nc", "-lk", "-p", "7777", "-e", "echo", REPLY], { stdout: "ignore", stderr: "ignore" })
    targets = [await sandboxIp(B)]; port = "7777"
  } else { targets = kind === "host" ? [await gatewayOf(INNER)] : farAddresses; port = kind === "host" ? HOST_PORT : FAR_PORT }
  try {
    expect(targets.length > 0, "no target was available")
    const controlled: string[] = [], unavailable: string[] = []
    for (const ip of targets) {
      if (!await fromHost(ip, port)) { unavailable.push(`${ip}: host control failed (the host firewall may block this stand-in)`); continue }
      controlled.push(ip)
      expect(!await innerReaches(INNER, ip, port), `an inner container reached ${ip}:${port}`)
    }
    if (!controlled.length) skip(`no working host control; ${unavailable.join("; ")}`)
    // Keep the enforcement timer from racing the deliberately open control window.
    expect((await socket("shutdown", { keepSandboxes: true })).reply.ok, "could not pause enforcement for the controls")
    expect(await until(async () => !await Bun.file(join(env.PADDOCK_STATE_DIR, "daemon.sock")).exists(), 15), "the daemon did not exit")
    await asRoot(guardTamper.remove)
    const measured: string[] = []
    for (const ip of controlled) {
      if (await innerReaches(INNER, ip, port)) measured.push(ip)
      else unavailable.push(`${ip}: the unguarded inner control did not connect; Docker's or the host's separate firewall remains in force`)
    }
    if (!measured.length) skip(`guarded attempts were blocked, but no unguarded positive control was available; ${unavailable.join("; ")}`)
    return `${measured.join(", ")}; host and unguarded inner controls answered, guarded inner attempts were blocked${unavailable.length ? `; unavailable: ${unavailable.join("; ")}` : ""}`
  } finally {
    const guard = await docker(["run", "--rm", "-i", "--privileged", "--network", "host", "--runtime", "runc", HELPER_IMAGE, "nft", "-f", "-"], { stdin: await readFile(join(ROOT, "core/providers/guard.nft"), "utf8") })
    expect(guard.code === 0, `could not restore the guard before restarting enforcement: ${guard.err}`)
    const restored = await socket("start", { name: INNER })
    expect(restored.reply.ok, `could not restore the guard: ${restored.reply.error?.message}`)
    if (listener) { listener.kill(); await docker(["exec", containerOf(B), "pkill", "nc"]) }
  }
})

ev("I06", "The checklist includes live network attempts from an inner container", async () => {
  await ensureInner()
  await docker(["rm", "-f", HOST])
  expect(await until(async () => !(await asRoot("ip -br link")).out.includes(`${PREFIX}a`), 15), "the eval listeners did not go away")
  const verify = await pdkJson(["verify", INNER])
  expect(verify.reply.ok && verify.reply.data.ok, `verify failed: ${verify.out}${verify.err}`)
  for (const id of ["net-host", "net-peers", "net-private"]) {
    const check = verify.reply.data.checks.find((entry: { id: string }) => entry.id === id)
    expect(check.status === "pass" && check.evidence === "probed" && /inner Docker container/.test(check.detail), `no inner evidence for ${id}: ${JSON.stringify(check)}`)
  }
})

ev("I07", "Inner Docker survives stop/start, a daemon enforce pass, and a daemon restart; its death stops the sandbox", async () => {
  await ensureInner()
  let stopMs = 0
  expect((await innerDocker(INNER, ["create", "--name", "persisted", "alpine:latest", "echo", "persisted-ok"])).code === 0, "could not create a persistent inner container")
  try {
    const stopping = Date.now()
    expect((await pdk(["stop", INNER])).code === 0, "stop failed")
    stopMs = Date.now() - stopping
    expect(stopMs < 10_000, `stop took ${stopMs} ms`)
    expect((await pdk(["start", INNER])).code === 0, "start failed")
    const persisted = await innerDocker(INNER, ["start", "-a", "persisted"])
    expect(persisted.code === 0 && persisted.out.trim() === "persisted-ok", `Docker data did not survive: ${persisted.out}${persisted.err}`)
    await Bun.sleep(32_000)
    expect((await innerRun(INNER, ["echo", "after-enforce"])).out.trim() === "after-enforce", "inner Docker did not survive the enforce pass")
    const daemon = await daemonFile(); process.kill(daemon.pid, "SIGKILL")
    expect((await pdk(["list"])).code === 0 && (await innerDocker(INNER, ["info"])).code === 0, "Docker did not survive daemon recovery")
    expect((await innerRun(INNER, ["wget", "-T", "20", "-qO-", "https://example.com"])).code === 0, "HTTPS failed after the restart")
  } finally { await innerDocker(INNER, ["rm", "-f", "persisted"]) }
  const kill = await docker(["exec", "-u", "0", containerOf(INNER), "sh", "-c", "kill -KILL $(pidof dockerd)"])
  expect(await until(async () => !await running(INNER), 15), `the sandbox stayed up after killing dockerd (exec exit ${kill.code}: ${kill.err})`)
  const dead = await inspect(INNER)
  expect(dead.State.ExitCode === 137 && !dead.State.OOMKilled, `dockerd did not exit from the requested kill: ${JSON.stringify(dead.State)}`)
  const stopped = await view(INNER)
  expect(/Docker.*ended/.test(stopped?.stopReason ?? ""), `the stop reason does not name Docker: ${JSON.stringify(stopped)}`)
  expect((await pdk(["start", INNER])).code === 0 && (await innerRun(INNER, ["echo", "recovered"])).out.trim() === "recovered", "start did not recover Docker")
  const logs = await docker(["logs", containerOf(INNER)])
  expect(/API listen/.test(logs.out + logs.err), "dockerd startup output did not reach the container log")
  return `stop took ${stopMs} ms; inner container persisted across stop/start; Docker survived enforcement and daemon restart; killing dockerd stopped the sandbox with exit 137; restart recovered it; dockerd output reached the container log`
})

ev("I08", "An inner container cannot exceed the sandbox's memory limit, even with its own privileged mode", async () => {
  const name = `${PREFIX}-imem`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, memoryGb: 1, diskGb: 2 })
  try {
    await seedAlpine(name)
    const control = await innerRun(name, ["sh", "-c", "head -c 16777216 /dev/zero | wc -c"])
    expect(control.code === 0 && control.out.trim() === "16777216", "the bounded memory control did not run")
    const hog = await innerDocker(name, ["run", "--rm", "--privileged", "--memory", "2g", "--pull", "never", "alpine:latest", "tail", "/dev/zero"], { timeoutMs: 120_000 })
    expect(hog.code !== 0 && hog.code !== 124, `the memory hog ended ${hog.code}: ${hog.err}`)
    // The inner client can return before the engine records the sandbox's death.
    await until(async () => !await running(name), 15)
    const after = await inspect(name)
    expect(!after.State.Running && after.State.OOMKilled, `the outer memory limit did not kill the sandbox: ${JSON.stringify(after.State)}`)
    expect((await docker(["info", "--format", "{{.ServerVersion}}"])).code === 0, "the engine was harmed")
    return `bounded 16 MiB control passed; hog exit ${hog.code}; outer OOMKilled=true under 1 GiB despite an inner 2 GiB limit`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I09", "Inner image pulls and writes are measured outside the sandbox, and the disk watch stops excess use", async () => {
  const name = `${PREFIX}-idisk`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 1 })
  const volume = await dockerVolumeName(name)
  try {
    const before = await volumeBytes(volume)
    expect((await innerDocker(name, ["pull", "busybox:stable"])).code === 0, "the inner image pull failed")
    const pulled = await volumeBytes(volume)
    expect(pulled > before + 1024 ** 2, `the image pull added only ${pulled - before} measured bytes`)
    await seedAlpine(name)
    const write = await innerDocker(name, ["run", "--name", "fill", "--pull", "never", "alpine:latest", "dd", "if=/dev/zero", "of=/big", "bs=1M", "count=1300"], { timeoutMs: 120_000 })
    const written = await volumeBytes(volume)
    const layer = Number((await docker(["inspect", "--size", "--format", "{{.SizeRw}}", containerOf(name)])).out.trim())
    expect(written > pulled + 512 * 1024 ** 2 && written + layer > 1024 ** 3, `the inner write is missing from the external measurement (${written - pulled} bytes, exit ${write.code})`)
    expect(await until(async () => !await running(name), 75), "the sandbox ran 75 s past its disk limit")
    expect(await until(async () => /disk watch/i.test((await view(name))?.stopReason ?? ""), 5), "it stopped for a reason other than the watched measurement")
    return `image pull +${pulled - before} B; inner write +${written - pulled} B; daemon stopped the 1 GiB sandbox for disk use`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I10", "A Docker sandbox with an extra capability or privileged mode is refused at start and stopped if running", async () => {
  const unavailable: string[] = []
  for (const tamper of [["--cap-add", "SYS_PTRACE"], ["--privileged"]]) {
    const name = `${PREFIX}-itamper`
    await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
    const original = await inspect(name)
    const volume = await dockerVolumeName(name)
    await docker(["rm", "-f", "-v", containerOf(name)])
    try {
      const made = await docker(["create", "--name", containerOf(name), "--label", `dev.paddock.name=${name}`, "--label", `dev.paddock.id=${original.Config.Labels["dev.paddock.id"]}`,
        "--runtime", engine!.data.runtime, "--network", `paddock-net-${name}`, "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "4096",
        ...DOCKER_CAPABILITIES.flatMap((cap) => ["--cap-add", cap]), "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=2", ...tamper, "--mount", `type=volume,src=${volume},dst=/var/lib/docker`, "--entrypoint", "sleep", DOCKER_IMAGE, "infinity"])
      expect(made.code === 0, `the tamper container could not be made: ${made.err}`)
      const refused = await pdkJson(["start", name])
      expect(refused.code === 6 && /capabilities|privileged/.test(refused.reply.error?.message ?? "") && !await running(name), `start failed to catch tamper: ${refused.out}${refused.err}`)
      const live = await docker(["start", containerOf(name)])
      if (live.code !== 0) {
        unavailable.push(`${tamper.join(" ")}: configuration refusal held; live enforcement unavailable because the engine refused to start it: ${live.err.trim()}`)
        continue
      }
      expect(await until(async () => !await running(name), 60), "the daemon did not stop the tamper container")
      expect(await until(async () => /undeclared capabilities/.test((await view(name))?.stopReason ?? ""), 5), "the daemon did not record the hardening failure")
    } finally { await pdk(["remove", name, "--confirm", name]) }
  }
  return unavailable.length ? unavailable.join("; ") : "both configuration refusals and live enforcement branches measured"
})

ev("I11", "Without --docker, no capabilities are added and even root cannot start the inner daemon", async () => {
  const name = `${PREFIX}-ino`
  await ensure(name, { image: DOCKER_IMAGE, docker: false, diskGb: 2 })
  try {
    const data = await inspect(name)
    expect(!data.HostConfig.Privileged && !(data.HostConfig.CapAdd ?? []).length, "a default sandbox gained extra capabilities")
    const daemon = await docker(["exec", "-u", "0", containerOf(name), "sh", "-c", DOCKER_START], { timeoutMs: 20_000 })
    expect(daemon.code !== 0 && daemon.code !== 124 && /operation not permitted|permission denied/i.test(daemon.out + daemon.err), `dockerd was not denied: ${daemon.code} ${daemon.out}${daemon.err}`)
    expect((await innerDocker(name, ["info"])).code !== 0, "an inner daemon answered without the option")
    return `no CapAdd (Docker mode adds exactly ${DOCKER_CAPABILITIES.join(" + ")}); Paddock's dockerd start command fails with a permission error even as root`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I12", "The docker default is a strict boolean and cannot smuggle engine flags", async () => {
  const config = join(env.PADDOCK_CONFIG_DIR, "config.json"); const good = await readFile(config, "utf8"); const name = `${PREFIX}-idefault`
  try {
    for (const docker of ["true", "false", 1, 0, null, {}, [true]]) {
      expect((await socket("create", { name, docker })).status === 400, `docker=${JSON.stringify(docker)} was accepted`)
      await writeFile(config, JSON.stringify({ defaults: { docker } }))
      expect((await pdkJson(["create", name])).code === 2, `invalid docker default ${JSON.stringify(docker)} was accepted`)
      await writeFile(config, good)
    }
    await writeFile(config, JSON.stringify({ defaults: { image: DOCKER_IMAGE, docker: true, diskGb: 2, memoryGb: 1 } }))
    const made = await pdkJson(["create", name])
    expect(made.reply.ok && made.reply.data.sandbox.spec.docker === true && (await innerDocker(name, ["info"])).code === 0, `docker default was not used: ${made.out}${made.err}`)
  } finally { await writeFile(config, good); await pdk(["remove", name, "--confirm", name]) }
})

ev("I13", "Removing a Docker sandbox removes its container, network, inner images and private volume", async () => {
  await ensureInner()
  const data = await inspect(INNER); const volume = await dockerVolumeName(INNER)
  expect(volume && data.Mounts.every((mount: { Type: string }) => mount.Type === "volume"), "Docker data is not a private engine volume")
  expect(!(data.HostConfig.Binds ?? []).length, "a host folder is mounted")
  expect((await innerDocker(INNER, ["image", "ls", "-q"])).out.trim(), "no inner image exists to remove")
  expect((await pdk(["remove", INNER, "--confirm", INNER])).code === 0, "remove failed")
  expect(!await inspect(INNER), "the container was left behind")
  expect((await docker(["network", "inspect", `paddock-net-${INNER}`])).code !== 0, "the network was left behind")
  expect((await docker(["volume", "inspect", volume])).code !== 0, "the Docker data volume was left behind")
  const missing = `${PREFIX}-imissing`
  await ensure(missing, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  const orphan = await dockerVolumeName(missing)
  expect((await docker(["rm", "-f", "-v", containerOf(missing)])).code === 0, "could not remove the container behind Paddock's back")
  expect((await pdk(["remove", missing, "--confirm", missing])).code === 0, "remove failed with a missing container")
  expect((await docker(["volume", "inspect", orphan])).code !== 0, "a missing container left its Docker volume behind")
})

ev("I14", "An engine volume backed by a host folder is refused before a Docker sandbox starts", async () => {
  const name = `${PREFIX}-ibind`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  const data = await inspect(name); const volume = await dockerVolumeName(name)
  try {
    expect((await pdk(["stop", name])).code === 0, "could not stop the volume test sandbox")
    expect((await docker(["rm", "-v", containerOf(name)])).code === 0, "could not remove its container")
    expect((await docker(["volume", "rm", volume])).code === 0, "could not replace its data volume")
    const made = await docker(["volume", "create", "--label", `dev.paddock.id=${data.Config.Labels["dev.paddock.id"]}`, "--label", `dev.paddock.name=${name}`, "--opt", "type=none", "--opt", "o=bind", "--opt", "device=/tmp", volume])
    expect(made.code === 0, `could not create the bind-backed control volume: ${made.err}`)
    const created = await docker(["create", "--name", containerOf(name), "--label", `dev.paddock.id=${data.Config.Labels["dev.paddock.id"]}`, "--label", `dev.paddock.name=${name}`,
      "--runtime", engine!.data.runtime, "--network", `paddock-net-${name}`, "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "4096", ...DOCKER_CAPABILITIES.flatMap((cap) => ["--cap-add", cap]), "--log-driver", "json-file", "--log-opt", "max-size=10m", "--log-opt", "max-file=2",
      "--mount", `type=volume,src=${volume},dst=/var/lib/docker,volume-nocopy`, "--entrypoint", "sleep", DOCKER_IMAGE, "infinity"])
    expect(created.code === 0 && (await inspect(name)).Mounts[0].Type === "volume", "the control does not look like an engine volume")
    const refused = await pdkJson(["start", name])
    expect(refused.code === 6 && /host-folder binds/.test(refused.reply.error?.message ?? "") && !await running(name), `the disguised host folder was not refused: ${refused.out}${refused.err}`)
    return "the engine reports Type=volume; volume inspect exposes device=/tmp,o=bind; start refuses it without running the container"
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I15", "Copy-on-write images share layer data across two pulled references and two running containers", async () => {
  const name = `${PREFIX}-icow`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  try {
    const driver = (await innerDocker(name, ["info", "--format", "{{.Driver}}"])).out.trim()
    expect(driver === DOCKER_DRIVER, `not the copy-on-write driver: ${driver}`)
    const volume = await dockerVolumeName(name)
    const before = await volumeBytes(volume)
    const pull = await innerDocker(name, ["pull", "busybox:stable"])
    expect(pull.code === 0, `pull failed: ${pull.err}`)
    const reference = (await innerDocker(name, ["image", "inspect", "--format", "{{index .RepoDigests 0}}", "busybox:stable"])).out.trim()
    const size = Number((await innerDocker(name, ["image", "inspect", "--format", "{{.Size}}", "busybox:stable"])).out.trim())
    const pulled = await volumeBytes(volume)
    expect(size > 1024 ** 2 && pulled > before + 1024 ** 2, "the control image did not add a measurable layer")
    expect((await innerDocker(name, ["pull", reference])).code === 0, "second pull of the same image failed")
    expect((await innerDocker(name, ["tag", reference, "cow-second:latest"])).code === 0, "second tag failed")
    const twice = await volumeBytes(volume)
    for (const [index, image] of ["busybox:stable", "cow-second:latest"].entries()) {
      const run = await innerDocker(name, ["run", "-d", "--name", `cow-${index}`, image, "sleep", "600"])
      expect(run.code === 0, `container failed: ${run.err}`)
    }
    const runningBytes = await volumeBytes(volume)
    const budget = (pulled - before) / 2
    expect(twice - pulled < budget && runningBytes - twice < budget, `layer duplication: image ${size} B, first pull ${pulled - before} B, second reference ${twice - pulled} B, two containers ${runningBytes - twice} B`)
    return `${driver}; engine-side du: before ${before} B, first pull ${pulled} B, second pull/tag ${twice} B, two containers ${runningBytes} B; image size ${size} B; each incremental step < half the first pull's allocated data`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I16", "A Docker build executes one RUN layer and its image runs", async () => {
  await ensureInner()
  const built = await innerDocker(INNER, ["build", "-t", "eval-built", "-"], { stdin: "FROM alpine:latest\nRUN echo build-ok > /built\n" })
  expect(built.code === 0, `build failed: ${built.out}${built.err}`)
  const run = await innerDocker(INNER, ["run", "--rm", "eval-built", "cat", "/built"])
  expect(run.code === 0 && run.out.trim() === "build-ok", `built image failed: ${run.out}${run.err}`)
  return "BuildKit executed RUN echo build-ok > /built; the resulting image returned build-ok"
})

ev("I17", "Docker compose up runs a one-service file with HTTPS", async () => {
  await ensureInner()
  const version = await innerDocker(INNER, ["compose", "version"])
  if (version.code !== 0) skip(`compose is not installed in ${DOCKER_IMAGE}; not measured: ${version.err.trim()}`)
  const file = "services:\n  web:\n    image: alpine:latest\n    command: [sh, -ec, 'wget -T 20 -qO- https://example.com; echo compose-ok']\n"
  try {
    const up = await innerDocker(INNER, ["compose", "-p", "eval-compose", "-f", "-", "up", "--abort-on-container-exit", "--exit-code-from", "web"], { stdin: file })
    expect(up.code === 0 && up.out.includes("compose-ok") && up.out.includes("Example Domain"), `compose up failed: ${up.out}${up.err}`)
    return `${version.out.trim()}; one service on compose's own bridge reached HTTPS and exited successfully`
  } finally {
    const down = await innerDocker(INNER, ["compose", "-p", "eval-compose", "-f", "-", "down", "--volumes", "--remove-orphans"], { stdin: file })
    expect(down.code === 0, `compose cleanup failed: ${down.err}`)
  }
})

ev("I18", "Inner containers inherit sandbox DNS; the engine resolver failure and public fallback are disclosed", async () => {
  await ensureInner()
  const names = [`${PREFIX}-dns-control`, `${PREFIX}-dns-gvisor`]
  try {
    for (const [index, runtime] of ["runc", engine!.data.runtime].entries()) {
      const made = await docker(["run", "-d", "--name", names[index]!, "--network", `paddock-net-${INNER}`, "--runtime", runtime, "--entrypoint", "sleep", DOCKER_IMAGE, "120"])
      expect(made.code === 0, `DNS control did not start: ${made.err}`)
    }
    const assigned = await docker(["exec", names[1]!, "cat", "/etc/resolv.conf"])
    expect(assigned.out.includes("nameserver 127.0.0.11"), `engine resolver changed: ${assigned.out}`)
    const control = await docker(["exec", names[0]!, "nslookup", "-timeout=1", "-retry=1", "example.com", "127.0.0.11"])
    const denied = await docker(["exec", names[1]!, "nslookup", "-timeout=1", "-retry=1", "example.com", "127.0.0.11"])
    expect(control.code === 0 && control.out.includes("example.com"), `runc resolver control failed: ${control.out}${control.err}`)
    expect(denied.code !== 0 && /refused/.test(denied.out + denied.err), `gVisor resolver failure changed: ${denied.out}${denied.err}`)
    const upstream = assigned.out.match(/ExtServers: \[host\(([\d.]+)\)/)?.[1]
    let upstreamNote = "upstream address not exposed by the engine"
    if (upstream) {
      const blocked = await docker(["exec", names[1]!, "nslookup", "-timeout=1", "-retry=1", "example.com", upstream])
      expect(blocked.code !== 0 && /timed out|no servers could be reached/.test(blocked.out + blocked.err), `upstream unexpectedly reachable: ${blocked.out}${blocked.err}`)
      upstreamNote = `engine upstream ${upstream} timed out behind the guard`
    }
    const outer = await docker(["exec", containerOf(INNER), "cat", "/etc/resolv.conf"])
    const inner = await innerRun(INNER, ["cat", "/etc/resolv.conf"])
    const servers = (text: string) => text.split("\n").filter((line) => line.startsWith("nameserver ")).join("; ")
    expect(inner.code === 0 && servers(outer.out) === servers(inner.out), `inner resolver differs: ${outer.out} vs ${inner.out}`)
    expect((await innerRun(INNER, ["nslookup", "example.com"])).code === 0, "inherited DNS did not resolve")
    // On a network of the inner daemon's own (as compose makes), its resolver at 127.0.0.11 forwards to the same servers.
    expect((await innerDocker(INNER, ["network", "create", "eval-dns"])).code === 0, "could not create an inner network")
    try {
      const own = await innerDocker(INNER, ["run", "--rm", "--network", "eval-dns", "alpine:latest", "sh", "-c", "grep -E '^nameserver|ExtServers' /etc/resolv.conf; nslookup example.com"])
      expect(own.code === 0 && own.out.includes("nameserver 127.0.0.11") && own.out.includes("host(1.1.1.1) host(8.8.8.8)"), `an inner user-defined network did not resolve through the inner daemon: ${own.out}${own.err}`)
    } finally { await innerDocker(INNER, ["network", "rm", "eval-dns"]) }
    // The DNS check carries the disclosure; the docker check only points to it.
    const checks = (await pdkJson(["verify", INNER])).reply.data.checks
    const dns = checks.find((check: { id: string }) => check.id === "dns")
    expect(dns?.status === "pass", `the DNS check did not pass: ${JSON.stringify(dns)}`)
    for (const word of ["fallback", "127.0.0.11", "1.1.1.1", "8.8.8.8"]) expect(dns.detail.includes(word), `missing DNS disclosure: ${dns.detail}`)
    expect(checks.find((check: { id: string }) => check.id === "docker")?.detail.includes("the separate DNS check"), "the docker check does not point to the DNS check")
    return `engine assigned 127.0.0.11: runc resolved, gVisor refused; ${upstreamNote}; outer and inner use ${servers(inner.out)} and resolve successfully; an inner user-defined network resolves through the inner daemon's 127.0.0.11, which forwards to them`
  } finally { await docker(["rm", "-f", ...names]) }
})

ev("I19", "Verify removes a probe image it loaded and preserves a pre-existing probe image and user tags", async () => {
  const name = `${PREFIX}-iprobe`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  try {
    expect((await innerDocker(name, ["image", "inspect", HELPER_IMAGE])).code !== 0, "create left its probe image behind")
    const user = await loadInner(name)
    expect((await innerDocker(name, ["image", "inspect", HELPER_IMAGE])).code !== 0, "probe absent control failed")
    const verify = async () => {
      const run = await pdkJson(["verify", name])
      expect(run.code === 0 && ["net-host", "net-peers", "net-private"].every((id) => run.reply.data.checks.find((check: { id: string }) => check.id === id)?.status === "pass"), `probe was not measured: ${run.out}${run.err}`)
    }
    await verify()
    expect((await innerDocker(name, ["image", "inspect", HELPER_IMAGE])).code !== 0, "verify left the probe image it loaded")
    expect((await innerDocker(name, ["image", "inspect", "--format", "{{.Id}}", "alpine:latest"])).out.trim() === user, "cleanup removed the user's tag")
    const before = await loadInner(name, HELPER_IMAGE)
    await verify()
    const after = await innerDocker(name, ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE])
    expect(after.code === 0 && after.out.trim() === before, "verify removed or changed an existing probe image")
    return "absent before -> absent after; present before -> same image ID after; alpine:latest user tag preserved; all network probes passed in both cases"
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I20", "Verify on a nearly full sandbox reports unknown with a disk reason and loads no probe image", async () => {
  expect((await socket("configGet", {})).reply.data.requireProbes === true, "this eval requires requireProbes on")
  const name = `${PREFIX}-ifull`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 1 })
  try {
    const volume = await dockerVolumeName(name)
    const layer = Number((await docker(["inspect", "--size", "--format", "{{.SizeRw}}", containerOf(name)])).out.trim())
    const count = Math.floor((1024 ** 3 - layer - await volumeBytes(volume)) / 1024 ** 2) - 24
    expect(count > 0, "no room for the near-full control")
    expect((await docker(["exec", "-u", "0", containerOf(name), "dd", "if=/dev/zero", "of=/var/lib/docker/eval-fill", "bs=1M", `count=${count}`])).code === 0, "could not fill to just below the watched limit")
    const used = layer + await volumeBytes(volume)
    expect(used < 1024 ** 3 && used > 1024 ** 3 - 64 * 1024 ** 2, `near-full control is invalid: ${used} B`)
    const verified = await pdkJson(["verify", name])
    expect(verified.reply.ok && await running(name), `verify crashed or stopped the below-limit sandbox: ${verified.out}${verified.err}`)
    for (const id of ["net-host", "net-peers", "net-private", "egress"]) {
      const check = verified.reply.data.checks.find((check: { id: string }) => check.id === id)
      expect(check?.status === "unknown" && /64 MiB.*nearly full/.test(check.detail), `false pass or unclear disk failure: ${JSON.stringify(check)}`)
    }
    expect((await innerDocker(name, ["image", "ls", "-q"])).out.trim() === "", "near-full verify loaded an image")
    return `${used} B used of 1 GiB; all four network results unknown with the 64 MiB headroom reason; no image loaded, no crash`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I21", "Repeated start keeps one NAT rule, segmentation at one, and an inner HTTPS workload running", async () => {
  await ensureInner()
  const started = await innerDocker(INNER, ["run", "-d", "--name", "start-online", "alpine:latest", "sh", "-ec", "while :; do wget -T 15 -qO /dev/null https://example.com && echo online || { echo FAILED; exit 1; }; sleep 1; done"])
  expect(started.code === 0, `could not start the live workload: ${started.err}`)
  try {
    const state = () => innerDocker(INNER, ["inspect", "--format", "{{.State.StartedAt}} {{.State.Running}}", "start-online"])
    const before = (await state()).out.trim()
    const nat = () => docker(["exec", "-u", "0", containerOf(INNER), "iptables-legacy", "-t", "nat", "-S", "POSTROUTING"])
    const rules = (await nat()).out
    expect(rules.split("\n").filter((line) => line === "-A POSTROUTING -o eth0 -j MASQUERADE").length === 1, `unexpected NAT control: ${rules}`)
    expect(await until(async () => (await innerDocker(INNER, ["logs", "start-online"])).out.includes("online"), 25), "HTTPS control failed before start")
    const logsBefore = (await innerDocker(INNER, ["logs", "start-online"])).out.length
    for (let i = 0; i < 3; i++) expect((await pdk(["start", INNER])).code === 0, "start on a running Docker sandbox failed")
    expect((await nat()).out === rules, "start changed or duplicated the NAT rules")
    const bridge = (await docker(["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}', `paddock-net-${INNER}`])).out.trim()
    const gso = await asRoot(`for port in /sys/class/net/${bridge}/brif/*; do ip -d link show "\${port##*/}"; done`)
    expect(gso.code === 0 && /gso_max_segs 1(?:\s|$)/.test(gso.out), `segmentation changed: ${gso.out}${gso.err}`)
    expect(await until(async () => (await innerDocker(INNER, ["logs", "start-online"])).out.length > logsBefore, 25), "HTTPS stopped after start")
    const logs = await innerDocker(INNER, ["logs", "start-online"])
    expect(!logs.out.includes("FAILED") && (await state()).out.trim() === before, `inner workload was interrupted: ${logs.out}${logs.err}`)
    return "three starts: identical NAT rules (one masquerade), gso_max_segs=1, same inner StartedAt, HTTPS successes before and after without failure"
  } finally { await innerDocker(INNER, ["rm", "-f", "start-online"]) }
})

// The size of the engine's log files for a container, read on the engine's host.
const hostLogBytes = async (name: string) => {
  const log = (await docker(["inspect", "--format", "{{.LogPath}}", name])).out.trim()
  expect(log.startsWith("/"), "engine did not expose its log path")
  const read = await docker(["run", "--rm", "--network", "none", "--runtime", "runc", "--mount", `type=bind,src=${dirname(log)},dst=/logs,readonly`, HELPER_IMAGE, "sh", "-ec", "wc -c /logs/*-json.log* | tail -1"])
  const n = Number(read.out.trim().split(/\s+/)[0])
  expect(read.code === 0 && Number.isFinite(n), `cannot read engine log size: ${read.out}${read.err}`)
  return n
}
const floodScript = (mib: number) => `yes paddock-log-control | head -c ${mib * 1024 ** 2} > /proc/1/fd/1`
const floodLog = async (name: string, mib: number) => {
  const run = await docker(["exec", "-u", "0", name, "sh", "-ec", floodScript(mib)])
  expect(run.code === 0, `log flood failed: ${run.err}`)
}
// Control: the same output, with a cap far above Paddock's, grows the host's log while the container's own layer stays
// the same. The engine merges its own default options into a container's, so the control names its cap.
let logControlNote: string | undefined
async function logControl(): Promise<string> {
  if (logControlNote) return logControlNote
  const control = `${PREFIX}-big-log`
  try {
    expect((await docker(["run", "-d", "--name", control, "--runtime", "runc", "--log-driver", "json-file", "--log-opt", "max-size=1g", HELPER_IMAGE, "sleep", "120"])).code === 0, "could not start the logging control")
    const layerBefore = (await docker(["inspect", "--size", "--format", "{{.SizeRw}}", control])).out.trim()
    await floodLog(control, 8); const first = await hostLogBytes(control)
    await floodLog(control, 8); const second = await hostLogBytes(control)
    expect((await docker(["inspect", "--size", "--format", "{{.SizeRw}}", control])).out.trim() === layerBefore, "the host log control changed the writable layer")
    expect(second > first + 8 * 1024 ** 2 && second > 42 * 1024 ** 2, `the control did not grow past Paddock's cap: ${first} -> ${second}`)
    const merged = JSON.stringify(JSON.parse((await docker(["inspect", control])).out)[0].HostConfig.LogConfig.Config)
    return logControlNote = `max-size=1g control (writable layer unchanged): host log ${first} -> ${second} B after two 8 MiB writes, merged options ${merged}`
  } finally { await docker(["rm", "-f", control]) }
}
const declaresLogCap = (data: any) => data.HostConfig.LogConfig.Type === "json-file" && data.HostConfig.LogConfig.Config["max-size"] === "10m" && data.HostConfig.LogConfig.Config["max-file"] === "2"

ev("I22", "Host daemon logs rotate within two 10 MiB files; a replacement with a larger cap fails the config check", async () => {
  await ensureInner()
  const controlNote = await logControl()
  const data = await inspect(INNER)
  expect(declaresLogCap(data), "outer daemon logging has no declared cap")
  await floodLog(containerOf(INNER), 16); const cappedFirst = await hostLogBytes(containerOf(INNER))
  await floodLog(containerOf(INNER), 16); const cappedSecond = await hostLogBytes(containerOf(INNER))
  expect(cappedFirst <= 21 * 1024 ** 2 && cappedSecond <= 21 * 1024 ** 2, `logs exceeded cap plus record overhead: ${cappedFirst}, ${cappedSecond}`)
  const name = `${PREFIX}-ilog-tamper`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  try {
    const original = await inspect(name); const volume = await dockerVolumeName(name)
    await docker(["rm", "-f", "-v", containerOf(name)])
    expect((await docker(["create", "--name", containerOf(name), "--label", `dev.paddock.id=${original.Config.Labels["dev.paddock.id"]}`, "--label", `dev.paddock.name=${name}`,
      "--runtime", engine!.data.runtime, "--network", `paddock-net-${name}`, "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "4096", ...DOCKER_CAPABILITIES.flatMap((cap) => ["--cap-add", cap]),
      "--log-driver", "json-file", "--log-opt", "max-size=1g", "--log-opt", "max-file=2", "--mount", `type=volume,src=${volume},dst=/var/lib/docker`, "--entrypoint", "sleep", DOCKER_IMAGE, "infinity"])).code === 0, "could not create an unbounded replacement")
    const refused = await pdkJson(["start", name])
    expect(refused.code === 6 && /host logs \(json-file/.test(refused.reply.error?.message ?? "") && !await running(name), `a larger log cap was accepted: ${refused.out}${refused.err}`)
  } finally { await pdk(["remove", name, "--confirm", name]) }
  return `${controlNote}; Paddock's sandbox: ${cappedFirst}, ${cappedSecond} B after two 16 MiB writes; a 1g cap refused at start`
})

ev("I23", "A sandbox without Docker cannot grow its host log past two 10 MiB files by writing to its own output; a larger cap fails the config check", async () => {
  const name = `${PREFIX}-log`
  await ensure(name)
  try {
    const controlNote = await logControl()
    expect(declaresLogCap(await inspect(name)), "a sandbox without Docker has no declared log cap")
    // As an agent would: through paddock exec, as the image's own user (root in alpine), into PID 1's output.
    const sizes: number[] = []
    for (let i = 0; i < 2; i++) {
      const run = await pdk(["exec", name, "--", "sh", "-ec", floodScript(16)], { timeoutMs: 120_000 })
      expect(run.code === 0, `the sandbox could not write to its own output: ${run.err}`)
      sizes.push(await hostLogBytes(containerOf(name)))
    }
    expect(sizes.every((size) => size <= 21 * 1024 ** 2), `logs exceeded cap plus record overhead: ${sizes.join(", ")}`)
    const original = await inspect(name)
    await docker(["rm", "-f", containerOf(name)])
    expect((await docker(["create", "--name", containerOf(name), "--label", `dev.paddock.id=${original.Config.Labels["dev.paddock.id"]}`, "--label", `dev.paddock.name=${name}`,
      "--runtime", engine!.data.runtime, "--network", `paddock-net-${name}`, "--memory", "1g", "--memory-swap", "1g", "--cpus", "1", "--pids-limit", "4096",
      "--log-driver", "json-file", "--log-opt", "max-size=1g", "--log-opt", "max-file=2", "--entrypoint", "sleep", "alpine:latest", "infinity"])).code === 0, "could not create an unbounded replacement")
    const refused = await pdkJson(["start", name])
    expect(refused.code === 6 && /host logs \(json-file/.test(refused.reply.error?.message ?? "") && !await running(name), `a larger log cap was accepted: ${refused.out}${refused.err}`)
    return `${controlNote}; a sandbox without Docker, as root through paddock exec: ${sizes.join(", ")} B after two 16 MiB writes; a 1g cap refused at start`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("I24", "Verify needs no registry: with the inner Docker cut off from Docker Hub, it probes from the engine's helper image, by that image's ID", async () => {
  const name = `${PREFIX}-ioffline`
  await ensure(name, { image: DOCKER_IMAGE, docker: true, diskGb: 2 })
  try {
    const helperId = (await docker(["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE])).out.trim()
    expect(/^sha256:/.test(helperId), "the helper image's ID could not be read")
    // Control: the block holds (a pull fails before reaching the registry) while the sandbox itself is online.
    expect((await docker(["exec", "-u", "0", containerOf(name), "sh", "-c", "printf '0.0.0.0 registry-1.docker.io auth.docker.io index.docker.io production.cloudflare.docker.com\\n' >> /etc/hosts"])).code === 0, "could not block the registry")
    const pull = await innerDocker(name, ["pull", "hello-world"])
    expect(pull.code !== 0 && /0\.0\.0\.0:443/.test(pull.err), `the registry block did not hold: ${pull.out}${pull.err}`)
    const online = await docker(["exec", containerOf(name), "curl", "-sS", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"])
    expect(online.code === 0 && online.out.trim() === "200", `the sandbox is offline, so the control proves nothing: ${online.out}${online.err}`)
    const clock = async () => (await docker(["exec", containerOf(name), "date", "+%s"])).out.trim()
    const since = await clock()
    const run = await pdkJson(["verify", name])
    const until_ = String(Number(await clock()) + 1)
    for (const id of ["net-host", "net-peers", "net-private"]) {
      const check = run.reply.data?.checks.find((entry: { id: string }) => entry.id === id)
      expect(check?.status === "pass" && check.evidence === "probed" && /inner Docker container/.test(check.detail), `offline verify did not probe ${id}: ${JSON.stringify(check)}`)
    }
    const images = (await innerDocker(name, ["events", "--since", since, "--until", until_, "--filter", "type=container", "--filter", "event=create", "--format", '{{index .Actor.Attributes "image"}}'])).out.split("\n").filter(Boolean)
    expect(images.length > 0 && images.every((image) => image === helperId), `inner probe containers ran from ${[...new Set(images)].join(", ") || "nothing"}, not the helper ${helperId}`)
    expect((await innerDocker(name, ["image", "inspect", HELPER_IMAGE])).code !== 0, "verify left the probe image it loaded")
    // An image under the helper's name with another ID is not used, and is left alone.
    const impostor = (await docker(["exec", "-u", "0", containerOf(name), "sh", "-ec", `mkdir -p /tmp/empty; tar -C /tmp/empty -c . | docker import - ${HELPER_IMAGE}`])).out.trim()
    expect(/^sha256:/.test(impostor) && impostor !== helperId, `could not make the impostor: ${impostor}`)
    expect((await socket("configGet", {})).reply.data.requireProbes === true, "this eval requires requireProbes on")
    const refused = await pdkJson(["verify", name])
    expect(refused.reply.ok && await running(name), "explicit verify stopped the sandbox for unknown probes")
    for (const id of ["net-host", "net-peers", "net-private"]) {
      const check = refused.reply.data?.checks.find((entry: { id: string }) => entry.id === id)
      expect(check?.status === "unknown" && /not Paddock's helper/.test(check.detail), `an impostor probe image was accepted for ${id}: ${JSON.stringify(check)}`)
    }
    expect((await innerDocker(name, ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE])).out.trim() === impostor, "verify removed or replaced the user's image")
    return `registry blocked (pull: connection refused at 0.0.0.0:443; HTTPS from the sandbox: 200); all three network checks probed; ${images.length} inner probe containers, all from ${helperId.slice(0, 19)}…, the engine's helper; loaded image removed afterwards; an impostor under the same name made the checks unknown and was kept`
  } finally { await pdk(["remove", name, "--confirm", name]) }
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

ev("T08", "With required probes on, explicit verify still answers and keeps a sandbox running after the helper image is deleted", async () => {
  expect((await socket("configGet", {})).reply.data.requireProbes === true, "this eval requires requireProbes on")
  await ensure(A)
  await docker(["rmi", "-f", HELPER_IMAGE])
  try {
    const guard = (await socket("verify", { name: A })).reply.data.checks.find((check: { id: string }) => check.id === "network-guard")
    expect(guard.status === "pass", `the guard check says ${guard.status}: ${guard.detail}`)
    expect(await running(A), "explicit verify stopped the sandbox for an unavailable probe")
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
  for (const method of ["shutdown", "sshSetup"]) expect((await tcp(`/api/${method}`)).status === 403, `${method} is available on the port`)
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
    for (const bad of ["{ not json", JSON.stringify({ defaults: { cpus: "lots" } }), JSON.stringify({ defaults: { image: "--privileged" } }), JSON.stringify({ defaults: "x" }), JSON.stringify({ engine: 5 }), JSON.stringify({ requireProbes: "off" }), JSON.stringify({ requireProbes: null }), "[]", "null"]) {
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
    ["start", "nope-nope"], ["create", "UPPER"], ["remove", A], ["frobnicate"], ["exec", A], ["ext", "run", "nope", "nope"], ["ext", "run", "x", "y", "--bogus"], ["create", "x", "--bogus"], ["stop"],
    ["template", "list"], ["resize", "nope-nope", "--memory", "1"], ["resize", A], ["snapshot", A], ["template", "remove", "nope-nope"]]
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

ev("F07", "The skill's Paddock commands and flags exist, and it lists exactly the API's methods", async () => {
  const skill = await readFile(join(ROOT, "skill/SKILL.md"), "utf8")
  const commands = new Set([...skill.matchAll(/`?paddock ([a-z]+)(?: (list|run|status|stop))?/g)].map((match) => match[1]!))
  for (const command of commands) {
    const run = await pdk([command, ...(command === "ext" ? ["list"] : command === "daemon" ? ["status"] : [])], { timeoutMs: 30_000 })
    expect(!(run.code === 2 && run.err.includes("Unknown command")), `the skill names \`paddock ${command}\`, which does not exist`)
  }
  const listed = /Methods:\s*([^.]+)\./.exec(skill)?.[1]?.match(/`([a-zA-Z]+)`/g)?.map((word) => word.slice(1, -1)) ?? []
  expect(listed.length > 0, "the skill does not list the API's methods")
  for (const method of listed) {
    const reply = await tcp(`/api/${method}`)
    expect(reply.status !== 403 && !(await reply.text()).includes("No such method"), `the skill lists ${method}, which the dashboard's port does not offer`)
  }
  const source = await readFile(join(ROOT, "core/daemon.ts"), "utf8")
  const offered = [...source.matchAll(/^\s{4}([a-zA-Z]+): \{ run:(.*)$/gm)].filter((match) => !match[2]!.includes("socketOnly")).map((match) => match[1]!)
  const unlisted = offered.filter((method) => !listed.includes(method) && method !== "version")
  expect(unlisted.length === 0, `the skill does not mention ${unlisted.join(", ")}`)
  const help = (await pdk(["help"])).out
  // Extension commands have their own flags; arguments after exec's -- belong to the command inside the sandbox.
  const commandsWithFlags = [...skill.matchAll(/\bpaddock ([^`\n]+)/g)].map((match) => match[1]!.split(" -- ")[0]!)
  for (const flag of new Set(commandsWithFlags.flatMap((command) => [...command.matchAll(/--[a-z][a-z-]*/g)].map((match) => match[0]))))
    expect(help.includes(flag), `the skill uses the Paddock flag ${flag}, which help does not list`)
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
    [["remove", "nope-nope", "--confirm", "nope-nope"], 3], [["create", A], 4], [["create", `${PREFIX}-x`, "--engine", "gvisor:nope"], 5], [["exec", A, "--", "sh", "-c", "exit 7"], 7], [["ext", "run", "nope", "nope"], 3],
    [["resize", "nope-nope", "--memory", "1"], 3], [["resize", A], 2], [["snapshot", A], 2], [["snapshot", "nope-nope", "--as", "x"], 3], [["template", "remove", "nope-nope"], 3], [["create", `${PREFIX}-x`, "--template", "nope-nope"], 3]]
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

// The dashboard's check rows for one sandbox, compared with what list/get returns: stored verification is history, so
// each row is marked unknown, says the current property is unknown, and shows the API's dated detail as it is.
async function shownHistory(page: Awaited<ReturnType<typeof browser>>, name: string) {
  const stored = (await view(name))?.lastVerify as { at: string; results: Array<{ id: string; status: string; evidence: string; detail: string }> } | undefined
  expect(stored, `the API has no stored verification for ${name}`)
  expect(await page.waitFor(`${panel(name)}?.innerText.includes(${JSON.stringify(`Last measured ${stored!.at}.`)}) && ${panel(name)}.querySelectorAll("ul.checks li[class]").length >= ${stored!.results.length}`, 10), `the dashboard does not show the verification measured at ${stored!.at}`)
  const shown = await page.evaluate(`[...${panel(name)}.querySelectorAll("ul.checks li")].filter((node) => node.querySelector(".mark")).map((node) => ({ status: node.className, text: node.innerText, detail: node.querySelector(".detail").textContent }))`) as Array<{ status: string; text: string; detail: string }>
  expect(shown.length === stored!.results.length, `${shown.length} checks shown, ${stored!.results.length} in the API`)
  stored!.results.forEach((check, index) => {
    const title = CHECKLIST.find((item) => item.id === check.id)!.title
    expect(check.status === "unknown" && shown[index]!.status === "unknown" && shown[index]!.text.includes(title) && shown[index]!.text.includes("current property unknown") && shown[index]!.detail === check.detail,
      `the dashboard shows "${shown[index]!.text.slice(0, 120)}" (${shown[index]!.status}) for ${check.id}, whose API row is ${check.status}: ${check.detail.slice(0, 120)}`)
  })
  expect(await page.evaluate(`${panel(name)}.querySelector(".badge.unknown")?.textContent === "Not verified"`), "the sandbox is not labelled Not verified")
  return stored!
}

ev("U03", "The dashboard, in a real browser, shows each sandbox's measured checks as the API gives them, dated and not current", async () => {
  await ensure(A)
  const verified = await socket("verify", { name: A })
  expect(verified.reply.ok, `verify failed: ${verified.reply.error?.message}`)
  const live = verified.reply.data.checks as Array<{ id: string; status: string; evidence: string; detail: string }>
  const page = await browser((await pdkJson(["ui"])).reply.data.url)
  try {
    expect(await page.waitFor(`Boolean(${panel(A)})`, 15), `the sandbox never appeared: ${String(await page.evaluate("document.body.innerText")).slice(0, 300)}`)
    expect(await page.evaluate("location.hash === '' && !location.href.includes('token')"), "the token stays in the address bar")
    expect(await page.evaluate(`${panel(A)}.querySelector(".badge").textContent`) === "running", "the status badge is wrong")
    expect(await page.evaluate(`${panel(A)}.querySelectorAll("ul.checks").length === 0`), "the checks are open before they were asked for")
    await page.evaluate(`[...${panel(A)}.querySelectorAll("button")].find((button) => button.textContent === "Past checks").click()`)
    const first = await shownHistory(page, A)
    // What the rows date is exactly what verify measured and returned live.
    expect(first.results.length === live.length && live.every((check, index) => first.results[index]!.detail === `Measured ${first.at}: ${check.status} (${check.evidence}). ${check.detail}`), "the stored history differs from what verify returned")
    // A verify started from the dashboard replaces the rows with its own, still dated measurement.
    await page.evaluate(`[...${panel(A)}.querySelectorAll("button")].find((button) => button.textContent === "Verify").click()`)
    expect(await until(async () => (await view(A))?.lastVerify !== undefined && (await view(A))!.lastVerify!.results[0]!.detail !== first.results[0]!.detail, 60), "the dashboard's Verify did not record a new measurement")
    expect(await page.waitFor(`[...${panel(A)}.querySelectorAll("button")].some((button) => button.textContent === "Verify")`, 30), "the Verify button stayed busy")
    const second = await shownHistory(page, A)
    expect(second.at !== first.at, "the rows still show the earlier measurement")
    expect(await page.evaluate(`document.getElementById("engines").innerText.includes("ready")`), "no engine is shown as ready")
    expect(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), "the page scrolls sideways")
    return `${live.length} rows equal the API's dated history of the live verify, all shown as unknown now; a dashboard verify replaced them with the measurement at ${second.at}`
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
    // Create opens its checks; they are the creation's measurement, dated, with no row claiming a current pass.
    const created = await shownHistory(page, name)
    const passed = created.results.filter((check) => check.detail.startsWith(`Measured ${created.at}: pass `)).length
    expect(passed >= 8, `only ${passed} checks were measured as passing at creation`)
    const remove = `[...${panel(name)}.querySelectorAll("button")].find((button) => button.textContent === "Remove").click()`
    page.answerPromptsWith("something else"); await page.evaluate(remove)
    expect(await page.waitFor(`${panel(name)}?.querySelector("pre")?.textContent.includes("Confirm")`, 10), "a mistyped name gave no error")
    expect(await view(name), "a mistyped name removed the sandbox")
    page.answerPromptsWith(name); await page.evaluate(remove)
    expect(await page.waitFor(`!${panel(name)}`, 60), "the sandbox stayed on the page")
    expect(!await view(name), "the sandbox was not removed")
    await page.evaluate(`document.getElementById("f-name").value = "ok-name"; document.getElementById("f-image").value = "--privileged"; document.getElementById("create").requestSubmit(); true`)
    expect(await page.waitFor(`document.getElementById("create-error").textContent.includes("image")`, 10), "a refused create shows no error")
    expect(!await view("ok-name"), "a refused create made a sandbox")
    return `${created.results.length} creation checks shown as dated history (${passed} measured passes, none shown as current); a mistyped removal refused; removal and an invalid image handled`
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

ev("U12", "exec output past 16 MiB is refused with an error that names the limit, the command is ended, and the daemon keeps answering", async () => {
  await ensure(A)
  const daemon = (await daemonFile()).pid
  const whole = await pdk(["exec", A, "--", "sh", "-c", `head -c ${OUTPUT_LIMIT} /dev/zero | tr '\\0' x`])
  expect(whole.code === 0 && whole.out.length === OUTPUT_LIMIT, `exactly ${OUTPUT_LIMIT} bytes did not come back whole: ${whole.out.length} bytes, exit ${whole.code}`)
  for (const [stream, command] of [["stdout", "yes paddock-flood"], ["stderr", "yes paddock-flood >&2"], ["stdout", "head -c 1073741824 /dev/zero | tr '\\0' x"]] as const) {
    const over = await pdkJson(["exec", A, "--", "sh", "-c", command], { timeoutMs: 60_000 })
    expect(over.code === 1 && over.reply.error?.message.includes(`16 MiB on ${stream}`) && /were ended/.test(over.reply.error.message), `${command}: ${over.out.slice(0, 300)}${over.err.slice(0, 300)}`)
  }
  expect((await daemonFile()).pid === daemon && (await pdk(["list"])).code === 0, "the daemon did not keep answering")
  const left = (await pdk(["exec", A, "--", "ps", "-o", "stat,args"])).out.split("\n").filter((line) => /paddock-flood|\/dev\/zero|tr /.test(line) && !/^\s*Z/.test(line))
  expect(left.length === 0, `the flooding commands still run: ${left.join("; ")}`)
  const rss = Number((await sh(["ps", "-o", "rss=", "-p", String(daemon)])).out.trim())
  return `exactly 16 MiB returned whole; 16 MiB+ on stdout, on stderr, and 1 GiB on stdout each refused naming the limit; no flooding process left running; same daemon (pid ${daemon}, ${Math.round(rss / 1024)} MiB resident) answered list`
})

ev("U13", "Processes an exec session leaves behind are reaped when they end, with and without Docker", async () => {
  const plain = `${PREFIX}-z`
  const seen: string[] = []
  try {
    await fresh(plain); await ensureInner()
    for (const name of [plain, INNER]) {
      const table = async () => (await pdk(["exec", name, "--", "ps", "-o", "pid,ppid,stat,args"])).out.split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((row) => row.length >= 4)
      const zombies = async () => (await table()).filter((row) => row[2]!.startsWith("Z"))
      const before = (await zombies()).length
      // Each of five sessions leaves four sleeps whose parent shells have exited; the kernel hands them to PID 1. Their
      // odd duration marks them. The daemon runs one exec of a sandbox at a time, so the sessions take a few seconds.
      const marker = "sleep 15.25"
      for (let i = 0; i < 5; i++) await pdk(["exec", name, "--", "sh", "-c", `for i in 1 2 3 4; do (${marker} &); done; true`])
      const pid1 = (await table()).find((row) => row[0] === "1")?.slice(3).join(" ")
      // Control: the orphans exist, run and are PID 1's children, so whatever happens next happens to them.
      const orphans = (await table()).filter((row) => row.slice(3).join(" ").includes(marker))
      expect(orphans.length === 20 && orphans.every((row) => row[1] === "1" && !row[2]!.startsWith("Z")), `control: ${orphans.length} running orphans of PID 1 in ${name}, not 20: ${JSON.stringify(orphans)}`)
      expect(await until(async () => !(await table()).some((row) => row.slice(3).join(" ").includes(marker)), 30), `the orphans in ${name} did not end`)
      await Bun.sleep(1000)
      const left = await zombies()
      expect(left.length === 0, `in ${name} (PID 1: ${pid1}) ${left.length} zombies remain after the orphans ended: ${JSON.stringify(left.slice(0, 5))}`)
      seen.push(`${name === plain ? "without" : "with"} Docker, PID 1 \`${pid1}\`: 20 orphans ended and no zombie was left (${before} before)` )
    }
    return seen.join("; ")
  } finally { await pdk(["remove", plain, "--confirm", plain]) }
})

ev("U17", "Starting over a watched disk limit warns in text and JSON while allowing cleanup; an under-limit start has no warning", async () => {
  const name = `${PREFIX}-diskstart`
  try {
    await ensure(name)
    await pdk(["stop", name])
    const under = await pdkJson(["start", name])
    expect(under.reply.ok && !under.reply.data.diskWarning, "under-limit start warned")
    expect((await pdk(["exec", name, "--", "dd", "if=/dev/zero", "of=/root/full", "bs=1048576", "count=1300"])).code === 0, "disk write failed")
    expect(await until(async () => (await view(name))?.status === "stopped", 45), "disk watch did not stop it")
    expect(/disk watch/.test((await view(name))?.stopReason ?? ""), "not a disk-watch stop")
    const text = await pdk(["start", name])
    expect(text.code === 0 && /uses 1\.[0-9]+ GB of its 1 GB/.test(text.out) && /30 seconds/.test(text.out) && text.out.includes(`paddock exec ${name} --`) && text.out.includes(`paddock resize ${name} --disk N`), `start warning: ${text.out}${text.err}`)
    const over = await pdkJson(["start", name])
    expect(over.reply.ok && over.reply.data.status === "running" && !over.reply.data.stopReason && over.reply.data.diskWarning?.usedBytes > over.reply.data.diskWarning?.limitBytes, `JSON warning missing: ${over.out}`)
    expect((await pdk(["exec", name, "--", "rm", "/root/full"])).code === 0, "could not free space while running")
    const freed = await pdkJson(["start", name])
    expect(freed.reply.ok && !freed.reply.data.diskWarning, "warning remained after freeing space")
    return `under limit: no warning; over limit: ${JSON.stringify(over.reply.data.diskWarning)}; after cleanup: no warning`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("U16", "A disconnected buffered exec client ends its command; a connected client receives its result", async () => {
  await ensure(A)
  const control = await pdk(["exec", A, "--", "sh", "-c", "sleep 1; echo connected; exit 3"])
  expect(control.code === 3 && control.out === "connected\n", `connected control: ${control.out}${control.err}`)
  const file = "/root/disconnected-exec.pid"
  const client = Bun.spawn([BIN, "exec", A, "--", "sh", "-c", `echo $$ > ${file}; exec sleep 120`], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" })
  let pid = ""
  try {
    expect(await until(async () => { pid = (await docker(["exec", containerOf(A), "cat", file])).out.trim(); return /^\d+$/.test(pid) }, 10), "command never started")
    expect((await docker(["exec", containerOf(A), "sh", "-c", `kill -0 ${pid}`])).code === 0, "control: command was not alive")
    client.kill("SIGKILL"); await client.exited
    expect(await until(async () => (await docker(["exec", containerOf(A), "sh", "-c", `! kill -0 ${pid} 2>/dev/null || grep -q '^State:.*Z' /proc/${pid}/status`])).code === 0, 10), `command PID ${pid} still runs after its CLI client died`)
    return "connected client received output and exit 3; disconnected client's sleeping command ended within 10 s"
  } finally {
    client.kill("SIGKILL")
    if (/^\d+$/.test(pid)) await docker(["exec", containerOf(A), "sh", "-c", `kill -KILL ${pid} 2>/dev/null || true; rm -f ${file}`])
  }
})

ev("U15", "An unavailable image leaves no record, network or Docker volume, and the name can be retried", async () => {
  const name = `${PREFIX}-badimage`
  try {
    const failed = await pdkJson(["create", name, "--docker", "--image", "does-not-exist:1"])
    const rows = (await pdkJson(["list"])).reply.data as Array<{ name: string }>
    const net = await docker(["network", "inspect", `paddock-net-${name}`])
    const volumes = await docker(["volume", "ls", "-q", "--filter", `label=dev.paddock.name=${name}`])
    expect(!rows.some((row) => row.name === name) && net.code !== 0 && !volumes.out.trim(), `failed create kept record=${rows.some((row) => row.name === name)}, network=${net.code === 0}, volumes=${volumes.out.trim()}`)
    expect(!failed.reply.ok && /cannot download.*image/i.test(failed.reply.error?.message ?? "") && /Nothing was kept/.test(failed.reply.error?.message ?? ""), `failure did not explain download and cleanup: ${failed.out}`)
    await ensure(name)
    expect(await running(name), "same name could not be created with a good image")
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

// Bun's fetch gives up after 360 seconds unless told otherwise; the CLI asked the daemon over fetch, so a longer exec
// came back as "The operation timed out." while its command went on.
ev("U14", "A buffered exec waits past Bun's 360-second fetch default and returns its command's output and exit code", async () => {
  await ensure(A)
  const began = Date.now()
  const long = await pdk(["exec", A, "--", "sh", "-c", "sleep 400; echo waited; exit 3"], { timeoutMs: 480_000 })
  const seconds = (Date.now() - began) / 1000
  expect(long.code === 3 && long.out === "waited\n" && seconds >= 400, `after ${seconds.toFixed(1)} s: exit ${long.code}, out ${JSON.stringify(long.out)}, err ${long.err.slice(0, 300)}`)
  return `exit 3 and its output after ${seconds.toFixed(1)} s`
})

ev("U11", "The default image (no --image) makes a sandbox that passes every blocking check", async () => {
  const image = "docker/sandbox-templates:shell-docker"
  if ((await docker(["image", "inspect", image])).code !== 0) skip(`${image} is not on this engine, and the eval does not download it (it is large)`)
  const name = `${PREFIX}-i`
  const made = await socket("create", { name, image, cpus: 1, memoryGb: 2, diskGb: 20 })
  try {
    expect(made.reply.ok, `create failed: ${made.reply.error?.message}`)
    const bad = (made.reply.data.checks as Array<{ id: string; status: string }>).filter((check) => CHECKLIST.find((item) => item.id === check.id)!.blocking && check.status !== "pass" && !(check.id === "docker" && check.status === "info" && !made.reply.data.sandbox.spec.docker))
    expect(bad.length === 0, `not passing: ${bad.map((check) => `${check.id} ${check.status}`).join(", ")}`)
    expect((await pdk(["exec", name, "--user", "agent", "--", "sh", "-c", "id -un && command -v git node"])).code === 0, "the image's agent user, git or node is missing")
  } finally { await socket("remove", { name, confirm: name }) }
})

// S: exec and shell sessions are daemon streams: raw bytes both ways, bounded, only on this machine's socket.
// A session from outside, through the CLI: a file goes in raw, stdout is hashed as it arrives (and kept when small),
// stderr stays apart. `stall` holds the reader back first, the way a slow consumer would.
async function streamed(argv: string[], options: { input?: string; stall?: () => Promise<void> } = {}) {
  const child = Bun.spawn([BIN, ...argv], { stdin: options.input ? Bun.file(options.input) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
  const hash = new Bun.CryptoHasher("sha256"); let bytes = 0; let out = ""
  const reading = (async () => {
    await options.stall?.()
    for await (const chunk of child.stdout) { hash.update(chunk); bytes += chunk.length; if (out.length < 4096) out += Buffer.from(chunk).toString("latin1") }
  })()
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited, reading])
  return { code, sha: hash.digest("hex"), bytes, out: out.slice(0, 4096), err }
}
// The daemon's resident memory, sampled until `work` settles.
async function daemonMemory<T>(work: Promise<T>): Promise<{ value: T; before: number; peak: number }> {
  const pid = (await daemonFile()).pid
  const rss = async () => Number((await sh(["ps", "-o", "rss=", "-p", String(pid)])).out.trim()) * 1024
  const before = await rss(); let peak = before; let settled = false
  void work.then(() => { settled = true }, () => { settled = true })
  while (!settled) { peak = Math.max(peak, await rss()); await Bun.sleep(200) }
  return { value: await work, before, peak }
}
const mib = (bytes: number) => `${Math.round(bytes / 1048576)} MiB`
const guestProcesses = async (name: string, marker: string) => (await pdk(["exec", name, "--", "ps", "-o", "args"])).out.split("\n").filter((line) => line.includes(marker))
// A terminal session driven by evals/terminal_steps.py, wrapped so the terminal's settings are printed after Paddock exits.
const onTerminal = (argv: string[], steps: unknown[]) =>
  sh(["python3", join(ROOT, "evals/terminal_steps.py"), "sh", "-c", `"$0" "$@"; echo "code=$?"; stty -a`, BIN, ...argv], { stdin: JSON.stringify(steps), env, timeoutMs: 60_000 })
const restored = (shown: string) => ["icanon", "isig", "echo"].every((flag) => new RegExp(`(^|\\s)${flag}(\\s|$)`, "m").test(shown))

ev("S01", "exec --stream carries 256 MiB of random bytes each way unchanged, and the daemon's memory stays bounded", async () => {
  await ensure(A)
  const file = join(tmp, "random.bin"); const size = 256 * 1048576
  expect((await sh(["sh", "-c", `head -c ${size} /dev/urandom > "$0"`, file])).code === 0, "could not write the test file")
  const hash = new Bun.CryptoHasher("sha256"); for await (const chunk of Bun.file(file).stream()) hash.update(chunk)
  const want = hash.digest("hex")
  try {
    const { value: [up, down], before, peak } = await daemonMemory((async () => {
      const up = await streamed(["exec", A, "--stream", "--", "sh", "-c", "cat > /root/stream.bin && sha256sum /root/stream.bin"], { input: file })
      return [up, await streamed(["exec", A, "--stream", "--", "cat", "/root/stream.bin"])] as const
    })())
    // The guest hashes what arrived and this machine hashes what came back, so each direction is checked on its own.
    expect(up.code === 0 && up.out.startsWith(`${want} `), `the upload arrived as ${up.out.slice(0, 64) || "nothing"} (exit ${up.code}): ${up.err.slice(0, 200)}`)
    expect(down.code === 0 && down.bytes === size && down.sha === want, `the download came back as ${down.bytes} bytes, ${down.sha === want ? "same" : "different"} hash (exit ${down.code})`)
    expect(peak - before < 64 * 1048576, `the daemon grew from ${mib(before)} to ${mib(peak)}`)
    return `guest and host hashes match for ${mib(size)} each way; daemon ${mib(before)} before, ${mib(peak)} at most`
  } finally { await pdk(["exec", A, "--", "rm", "-f", "/root/stream.bin"]); await rm(file, { force: true }) }
})

ev("S02", "exec --stream keeps stderr apart, returns the exit code, and delivers end of input", async () => {
  await ensure(A)
  const run = await pdk(["exec", A, "--stream", "--", "sh", "-c", "printf out; printf err >&2; exit 5"])
  expect(run.out === "out" && run.err === "err" && run.code === 5, `stdout ${JSON.stringify(run.out)}, stderr ${JSON.stringify(run.err)}, exit ${run.code}`)
  // The command finishes only if its input ends, and still writes after that.
  const eof = await pdk(["exec", A, "--stream", "--", "sh", "-c", "wc -c; echo after-eof"], { stdin: "x".repeat(100_000), timeoutMs: 30_000 })
  expect(eof.code === 0 && eof.out.trim() === "100000\nafter-eof", `with input: ${JSON.stringify(eof.out)} exit ${eof.code}`)
  const none = await pdk(["exec", A, "--stream", "--", "cat"], { timeoutMs: 30_000 })
  expect(none.code === 0 && none.out === "", `cat without input: exit ${none.code}`)
  const zero = await pdk(["exec", A, "--stream", "--", "true"])
  expect(zero.code === 0, `true exited ${zero.code}`)
})

ev("S03", "`paddock shell` has a terminal of this one's size that follows resizes, Ctrl-C reaches the sandbox, and the terminal is restored", async () => {
  await ensure(A)
  if ((await sh(["python3", "-c", "import pty"])).code !== 0) skip("python3 is needed to give the command a terminal")
  // `echo m-$((N))` shows m-N only when the sandbox's shell runs it, never as the typed echo.
  const run = await onTerminal(["shell", A], [["size", 30, 100], ["type", "echo m-$((0+1))\r"], ["wait", "m-1"],
    ["type", "stty size; echo m-$((1+1))\r"], ["wait", "m-2"], ["size", 40, 120], ["pause", 1],
    ["type", "stty size; echo m-$((2+1))\r"], ["wait", "m-3"],
    ["type", "sleep 600\r"], ["pause", 2], ["type", "\u0003"], ["pause", 1], ["type", "echo m-$((3+1))\r"], ["wait", "m-4"],
    ["type", "exit 7\r"], ["wait", "code="]])
  const shown = run.out.replace(/\r/g, "")
  expect(run.code !== 124, `the session did not finish (Ctrl-C did not end sleep?): ${shown.slice(-400)}`)
  expect(/\n30 100\n/.test(shown) && /\n40 120\n/.test(shown), `stty size inside did not show 30 100 then 40 120: ${shown.slice(-600)}`)
  expect(shown.includes("code=7"), `the shell's exit code was lost: ${shown.slice(-300)}`)
  expect(restored(shown.slice(shown.indexOf("code=7"))), `the terminal was not restored: ${shown.slice(shown.indexOf("code=7"), shown.indexOf("code=7") + 400)}`)
  // Control: the same check reads a raw terminal as not restored.
  const raw = await onTerminal(["shell", A, "--", "true"], [])
  expect(raw.out.includes("code=0") && restored(raw.out.slice(raw.out.indexOf("code="))), "a one-off command left the terminal raw")
  const control = await sh(["python3", join(ROOT, "evals/terminal_steps.py"), "sh", "-c", "stty raw -echo; stty -a"], { stdin: "[]", timeoutMs: 20_000 })
  expect(!restored(control.out), "the check cannot tell a raw terminal from a restored one")
  return "30×100 inside, 40×120 after a resize; Ctrl-C ended sleep 600; exit 7 came through; icanon, isig and echo back on"
})

ev("S04", "A session ends when its sandbox is stopped, and a stopped sandbox is refused, not started", async () => {
  await ensure(A)
  const marker = "sleep 6123"
  const plain = Bun.spawn([BIN, "exec", A, "--stream", "--", "sleep", "6123"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
  const terminal = (await sh(["python3", "-c", "import pty"])).code === 0 ? onTerminal(["shell", A], [["type", "echo m-$((0+1))\r"], ["wait", "m-1"], ["type", `${marker}\r`], ["wait", "code="]]) : undefined
  try {
    expect(await until(async () => (await guestProcesses(A, marker)).length === (terminal ? 2 : 1), 20), "the sessions did not start")
    const stopped = Date.now()
    expect((await pdk(["stop", A])).code === 0, "stop failed")
    const ended = await Promise.race([plain.exited, Bun.sleep(15_000).then(() => undefined)])
    const err = await new Response(plain.stderr).text()
    expect(ended !== undefined && ended !== 0 && /stopped/.test(err), `the exec session ${ended === undefined ? "was still open 15 s after stop" : `exited ${ended}: ${err.trim()}`}`)
    let note = `exec session ended ${((Date.now() - stopped) / 1000).toFixed(1)} s after stop with "${err.trim()}"`
    if (terminal) {
      const shown = (await terminal).out.replace(/\r/g, "")
      expect(/code=[1-9]/.test(shown) && restored(shown.slice(shown.indexOf("code="))), `the shell session ended as: ${shown.slice(-400)}`)
      note += "; the shell ended too, with its terminal restored"
    }
    const refused = await pdk(["exec", A, "--stream", "--", "true"])
    expect(refused.code !== 0 && /not running/.test(refused.err), `a session on a stopped sandbox: exit ${refused.code}, ${refused.err.trim()}`)
    expect(!(await running(A)), "opening a session started the sandbox")
    return `${note}; a new session was refused and the sandbox stayed stopped`
  } finally { plain.kill(); await ensure(A) }
})

ev("S05", "Sessions are offered only on the daemon's private socket: the dashboard's port and token cannot open one", async () => {
  await ensure(A)
  const daemon = await daemonFile()
  const open = frame("open", { kind: "exec", name: A, argv: ["echo", "session-opened"], tty: false })
  // Raw bytes to a socket, and whatever comes back before it closes or 5 s pass.
  const exchange = (target: { path: string } | { host: string; port: number }, bytes: Uint8Array) => new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []; const client = connect(target as { path: string }, () => client.write(bytes))
    client.on("data", (chunk: Buffer) => chunks.push(chunk)); client.on("error", () => {}); client.on("close", () => resolve(Buffer.concat(chunks)))
    setTimeout(() => client.destroy(), 5000)
  })
  const kinds = (bytes: Buffer) => { try { return new FrameReader().push(bytes).map((piece) => piece.kind) } catch { return [] } }
  const control = await exchange({ path: join(env.PADDOCK_STATE_DIR, "stream.sock") }, open)
  expect(kinds(control).includes("ready") && control.includes("session-opened"), "control: the same frames on the private socket did not open a session")
  const overTcp = await exchange({ host: "127.0.0.1", port: daemon.port }, open)
  expect(!kinds(overTcp).includes("ready") && !overTcp.includes("session-opened"), "the dashboard's port opened a session from raw frames")
  expect((await tcp("/api/list")).status === 200, "control: the token was refused for list")
  for (const path of ["/api/session", "/api/stream", "/api/attach", "/api/exec-stream", "/stream", "/session"]) {
    const reply = await tcp(path); const text = await reply.text()
    expect(reply.status === 404 && !text.includes("session-opened"), `${path} answered ${reply.status} with the token`)
  }
  const mode = (await stat(join(env.PADDOCK_STATE_DIR, "stream.sock"))).mode & 0o777
  expect(mode === 0o600, `stream.sock has mode ${mode.toString(8)}`)
  const listening = (await sh(["lsof", "-nP", "-a", "-p", String(daemon.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).out.split("\n").filter((line) => line.startsWith("n"))
  expect(listening.length === 1 && listening[0] === `n127.0.0.1:${daemon.port}`, `the daemon listens on ${listening.join(", ") || "nothing lsof can see"}`)
  return `raw frames: ready on stream.sock (mode 600), none on 127.0.0.1:${daemon.port}; six session-like paths 404 with the token; the daemon's only TCP listener is the dashboard's`
})

ev("S06", "A reader that stops reading holds the command in the sandbox back, not the daemon's memory", async () => {
  await ensure(A)
  const size = 1024 * 1048576; const marker = "paddock-slow-reader"
  const command = [BIN, "exec", A, "--stream", "--", "sh", "-c", `head -c ${size} /dev/zero; : ${marker}`]
  // A shell pipe, so the reader that sleeps is a real one: a child's pipe read by this process would be read ahead.
  const piped = (reader: string) => sh(["sh", "-c", `"$0" "$@" | { ${reader} wc -c; }`, ...command], { env, timeoutMs: 300_000 })
  // Control: read at once, the same output is done in this long.
  const start = Date.now(); const fast = await piped(""); const fastSeconds = (Date.now() - start) / 1000
  expect(fast.code === 0 && fast.out.trim() === String(size), `the control read ${fast.out.trim()} bytes (exit ${fast.code})`)
  const stallSeconds = Math.max(10, Math.ceil(fastSeconds * 3))
  const memory = daemonMemory(piped(`sleep ${stallSeconds};`))
  await Bun.sleep((stallSeconds - 3) * 1000)
  const held = (await guestProcesses(A, marker)).length > 0
  const { value: slow, before, peak } = await memory
  expect(held, `the command finished while nobody read, though it needs ${fastSeconds.toFixed(1)} s when read at once`)
  expect(slow.code === 0 && slow.out.trim() === String(size), `after the stall ${slow.out.trim()} bytes came back (exit ${slow.code})`)
  expect(peak - before < 64 * 1048576, `the daemon grew from ${mib(before)} to ${mib(peak)}`)
  return `1 GiB read at once in ${fastSeconds.toFixed(1)} s; with the reader asleep ${stallSeconds} s the command was still running ${stallSeconds - 3} s in, and all 1 GiB came after; daemon ${mib(before)} before, ${mib(peak)} at most`
})

// W: forwards. A service on a sandbox's own loopback, reached from this machine's loopback and from nowhere else.
const NONCE_PORT = 3000; const ECHO_PORT = 3100
// A one-line answer on the sandbox's loopback, from the image's own nc, for one connection at a time. Each eval gives
// its own port, since a service an earlier eval started keeps its port.
const nonceService = (name: string, nonce: string, port = NONCE_PORT) => pdk(["exec", name, "--", "sh", "-c", `(nc -lk -s 127.0.0.1 -p ${port} -e echo ${nonce} </dev/null >/dev/null 2>&1 &)`])
// What one TCP connection from this machine gets back before the other side closes; empty when nothing answers.
const tcpRead = (host: string, port: number, send: Uint8Array | string = "", seconds = 5, trace?: (event: string) => void) => new Promise<Buffer>((resolve) => {
  const chunks: Buffer[] = []; const client = connect(port, host, () => client.end(send))
  const timer = setTimeout(() => { trace?.("timeout"); client.destroy() }, seconds * 1000)
  client.on("data", (chunk: Buffer) => chunks.push(chunk)); client.on("error", (error) => trace?.(error.message)); client.on("close", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)) })
})
const refused = (port: number) => new Promise<boolean>((resolve) => {
  const client = connect(port, "127.0.0.1", () => { client.destroy(); resolve(false) }); client.on("error", () => resolve(true))
})
const forwardAdd = async (name: string, port: number, localPort?: number) => {
  const made = await pdkJson(["forward", "add", name, "--port", String(port), ...(localPort ? ["--local-port", String(localPort)] : [])])
  expect(made.reply.ok, `forward add failed: ${made.reply.error?.message}`)
  return made.reply.data as { id: string; localPort: number; sandboxId: string; generation: string }
}
const forwardsOf = async (name?: string) => (await pdkJson(["forward", "list", ...(name ? [name] : [])])).reply.data as Array<{ id: string; localPort: number; connections: number }>
// A listener of this run, on the given address of this machine, that answers REPLY: what a forward is compared with.
async function controlListener(host: string): Promise<{ port: number; close: () => void }> {
  const server = createServer((socket) => socket.end(`${REPLY}\n`))
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  return { port: (server.address() as AddressInfo).port, close: () => server.close() }
}
// What the engine host gets from an address and port, through the host helper's nc.
const hostReads = async (ip: string, port: number) => (await docker(["exec", HOST, "nc", "-w", "2", ip, String(port)], { timeoutMs: 20_000 })).out

ev("W01", "A forward reaches a service on the sandbox's own loopback from this machine's loopback, the engine publishes nothing, its host gets no new listener, and verify shows the forward", async () => {
  await ensure(A)
  const nonce = `${PREFIX}-w01-nonce`
  await nonceService(A, nonce)
  expect((await pdk(["exec", A, "--", "nc", "-w", "2", "127.0.0.1", String(NONCE_PORT)])).out.includes(nonce), "control: the service does not answer inside the sandbox")
  // Every listening socket on the engine's host, before and after.
  const listening = async () => new Set((await asRoot("ss -ltnH")).out.split("\n").map((line) => line.trim().split(/\s+/)[3]).filter(Boolean))
  const before = await listening()
  const forward = await forwardAdd(A, NONCE_PORT)
  try {
    expect((await tcpRead("127.0.0.1", forward.localPort)).toString().includes(nonce), `127.0.0.1:${forward.localPort} did not return the sandbox's nonce`)
    // Where the engine's host is this machine (native Linux), the daemon's own loopback listener is among them: a
    // listener of this run shows whether that is so, and lsof below shows that socket is the daemon's.
    const control = await controlListener("127.0.0.1")
    const here = (await listening()).has(`127.0.0.1:${control.port}`); control.close()
    const added = [...await listening()].filter((address) => !before.has(address) && !(here && address === `127.0.0.1:${forward.localPort}`))
    expect(added.length === 0, `new listeners on the engine's host: ${added.join(", ")}`)
    const engine = await inspect(A)
    const bound = Object.values(engine.NetworkSettings.Ports ?? {}).filter(Boolean)
    expect(!engine.HostConfig.PublishAllPorts && Object.keys(engine.HostConfig.PortBindings ?? {}).length === 0 && bound.length === 0, `the engine publishes ${JSON.stringify(engine.HostConfig.PortBindings)} ${JSON.stringify(bound)}`)
    const daemon = (await daemonFile()).pid
    const own = (await sh(["lsof", "-nP", "-a", "-p", String(daemon), "-iTCP", "-sTCP:LISTEN", "-Fn"])).out.split("\n").filter((line) => line.endsWith(`:${forward.localPort}`))
    expect(own.length === 1 && own[0] === `n127.0.0.1:${forward.localPort}`, `the daemon listens for the forward on ${own.join(", ") || "nothing lsof can see"}`)
    const shown = ((await pdkJson(["verify", A])).reply.data?.checks as Array<{ id: string; status: string; detail: string }> | undefined)?.find((check) => check.id === "forwards")
    expect(shown?.status === "info" && shown.detail.includes(`127.0.0.1:${forward.localPort} to port ${NONCE_PORT} (${forward.id})`), `verify did not disclose the forward: ${shown?.detail}`)
    return `the nonce came back on 127.0.0.1:${forward.localPort}, the daemon's only socket for it; no port bindings; ${before.size} listeners on the engine's host before and ${here ? "after, apart from the daemon's own, since that host is this machine" : "after"}; verify lists it`
  } finally { await pdk(["forward", "remove", forward.id]) }
})

ev("W02", "A forward answers on no other address: not this machine's others, not the engine host's, where a control listener does", async () => {
  await ensure(A); await hostHelper()
  const nonce = `${PREFIX}-w02-nonce`
  await nonceService(A, nonce, NONCE_PORT + 2)
  const forward = await forwardAdd(A, NONCE_PORT + 2); const control = await controlListener("0.0.0.0")
  try {
    expect((await tcpRead("127.0.0.1", forward.localPort)).toString().includes(nonce), "the forward does not work on loopback")
    const others = Object.values(networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => entry!.address)
    if (!others.length) skip("this machine has no address besides loopback")
    // An address this machine cannot reach itself at (such as a network address ending in .0) proves nothing either way.
    const tried: string[] = []
    for (const address of others) {
      if (!(await tcpRead(address, control.port, "", 2)).toString().includes(REPLY)) continue
      expect(!(await tcpRead(address, forward.localPort)).toString().includes(nonce), `${address}:${forward.localPort} returned the nonce`)
      tried.push(address)
    }
    expect(tried.length > 0, `control: no other address of this machine (${others.join(", ")}) answered`)
    const vm = await hostAddresses()
    expect(vm.length > 0, "the engine's host has no address to try")
    for (const ip of vm) {
      expect((await hostReads(ip, Number(HOST_PORT))).includes(REPLY), `control: the engine host's ${ip}:${HOST_PORT} did not answer`)
      expect(!(await hostReads(ip, forward.localPort)).includes(nonce), `the engine host's ${ip}:${forward.localPort} returned the nonce`)
    }
    return `refused at ${tried.join(", ")} on this machine (of ${others.length}) and ${vm.join(", ")} on the engine's host, where the control listeners answered`
  } finally { control.close(); await pdk(["forward", "remove", forward.id]) }
})

ev("W03", "Like any loopback service here, a forward is reachable from the engine's host through the engine's relay to this machine (OrbStack's host.docker.internal), and not from another sandbox", async () => {
  await ensure(A); await ensure(B); await hostHelper()
  const relay = (await docker(["exec", HOST, "getent", "hosts", "host.docker.internal"])).out.trim().split(/\s+/)[0]
  if (!relay) skip("the engine's host has no host.docker.internal")
  // Control: a listener of this run on 127.0.0.1 only, not a forward.
  const control = await controlListener("127.0.0.1")
  const nonce = `${PREFIX}-w03-nonce`
  await nonceService(A, nonce, NONCE_PORT + 3)
  const forward = await forwardAdd(A, NONCE_PORT + 3)
  try {
    if (!(await hostReads(relay!, control.port)).includes(REPLY)) skip(`this engine does not relay ${relay} to this machine's loopback`)
    expect((await hostReads(relay!, forward.localPort)).includes(nonce), `the engine's host did not reach the forward through ${relay}, though it reached a loopback listener`)
    // An ordinary container of the same engine, outside Paddock.
    const plain = await docker(["run", "--rm", "--runtime", "runc", "--name", `${PREFIX}-plain`, HELPER_IMAGE, "nc", "-w", "2", "host.docker.internal", String(forward.localPort)], { timeoutMs: 60_000 })
    const inside = await pdk(["exec", B, "--", "nc", "-w", "2", relay!, String(forward.localPort)], { timeoutMs: 20_000 })
    expect(!inside.out.includes(nonce) && !(await pdk(["exec", B, "--", "nc", "-w", "2", relay!, String(control.port)], { timeoutMs: 20_000 })).out.includes(REPLY), "another sandbox reached this machine's loopback")
    return `from the engine's host, ${relay} reached a loopback-only listener and the forward alike; a plain container ${plain.out.includes(nonce) ? "reached the forward too" : "did not reach it"}; another sandbox reached neither`
  } finally { control.close(); await pdk(["forward", "remove", forward.id]) }
})

ev("W04", "A forward ends when it is removed, when its sandbox stops or is restarted behind Paddock's back, and when the daemon exits", async () => {
  await ensure(A)
  const ends = async (what: string, act: (id: string) => Promise<unknown>) => {
    await ensure(A)
    const forward = await forwardAdd(A, NONCE_PORT)
    expect(!(await refused(forward.localPort)), `control: the forward for "${what}" did not listen`)
    await act(forward.id)
    expect(await until(async () => await refused(forward.localPort), 10), `127.0.0.1:${forward.localPort} still listens after ${what}`)
    expect(!(await forwardsOf()).some((entry) => entry.id === forward.id), `forward list still shows it after ${what}`)
  }
  await ends("forward remove", (id) => pdk(["forward", "remove", id]))
  await ends("paddock stop", () => pdk(["stop", A]))
  await ends("an engine restart of the container", () => docker(["restart", "-t", "1", containerOf(A)]))
  await ends("paddock daemon stop", () => pdk(["daemon", "stop"]))
  await ensure(A)
  return "each listener was gone within 10 s and left forward list"
})

ev("W05", "A sandbox recreated under the same name does not inherit its forward", async () => {
  const name = `${PREFIX}-w`
  await ensure(name)
  try {
    await nonceService(name, `${PREFIX}-old`)
    const first = await forwardAdd(name, NONCE_PORT)
    expect((await tcpRead("127.0.0.1", first.localPort)).toString().includes(`${PREFIX}-old`), "control: the first forward did not work")
    expect((await pdk(["remove", name, "--confirm", name])).code === 0, "remove failed")
    await ensure(name); await nonceService(name, `${PREFIX}-new`)
    expect(await refused(first.localPort) && (await forwardsOf(name)).length === 0, "the recreated sandbox has the old forward")
    const second = await forwardAdd(name, NONCE_PORT)
    expect(second.sandboxId !== first.sandboxId && (await tcpRead("127.0.0.1", second.localPort)).toString().includes(`${PREFIX}-new`), "a new forward did not reach the new sandbox")
    return `the old port refused and the list was empty after recreating; a new forward has a new sandbox id`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("W06", "An explicit local port that is in use is refused and nothing is recorded; once free, the same request binds it", async () => {
  await ensure(A)
  const holder = await controlListener("127.0.0.1")
  const taken = await pdkJson(["forward", "add", A, "--port", String(NONCE_PORT), "--local-port", String(holder.port)])
  holder.close(); await Bun.sleep(200)
  expect(taken.code === 4 && /in use/.test(taken.reply.error?.message ?? ""), `an occupied port: exit ${taken.code}, ${taken.reply.error?.message}`)
  expect(!(await forwardsOf(A)).some((entry) => entry.localPort === holder.port), "a refused forward was recorded")
  const freed = await forwardAdd(A, NONCE_PORT, holder.port)
  await pdk(["forward", "remove", freed.id])
  expect(freed.localPort === holder.port, `the freed port was not used: ${freed.localPort}`)
  return `127.0.0.1:${holder.port} in use: exit 4, "${taken.reply.error?.message}"; free: bound`
})

ev("W07", "A forward carries 64 MiB of random bytes each way unchanged, and passes on end of input", async () => {
  await ensure(A)
  // One connection, echoed back by the image's own nc and cat.
  await pdk(["exec", A, "--", "sh", "-c", `(nc -l -s 127.0.0.1 -p ${ECHO_PORT} -e cat </dev/null >/dev/null 2>&1 &)`])
  const forward = await forwardAdd(A, ECHO_PORT)
  try {
    const data = new Uint8Array(64 * 1048576); for (let at = 0; at < data.length; at += 65536) crypto.getRandomValues(data.subarray(at, at + 65536))
    const want = new Bun.CryptoHasher("sha256").update(data).digest("hex")
    const { value: back, before, peak } = await daemonMemory(tcpRead("127.0.0.1", forward.localPort, data, 120))
    const got = new Bun.CryptoHasher("sha256").update(back).digest("hex")
    expect(back.length === data.length && got === want, `${back.length} bytes came back, ${got === want ? "same" : "different"} hash`)
    return `64 MiB in and back with the same hash, the echo ending only after end of input; daemon ${mib(before)} before, ${mib(peak)} at most`
  } finally { await pdk(["forward", "remove", forward.id]) }
})

ev("W08", "A forward relays 50 connections at once, each with its own bytes, and leaves no relay running", async () => {
  await ensure(A)
  // The image's nc serves one connection at a time, so a concurrent echo server comes from the image's packages.
  const installed = await pdk(["exec", A, "--", "sh", "-c", "command -v socat || apk add --no-cache -q socat"], { timeoutMs: 120_000 })
  if (installed.code !== 0) skip("socat could not be installed in the sandbox (offline?)")
  // socat's default backlog of five drops part of a 50-connection burst before Paddock can relay it.
  await pdk(["exec", A, "--", "sh", "-c", `(socat -d -d TCP-LISTEN:${ECHO_PORT + 1},bind=127.0.0.1,fork,reuseaddr,backlog=128 EXEC:cat </dev/null >/dev/null 2>/tmp/w08-socat.log &)`])
  const control = `${PREFIX}-w08-control`
  expect(await until(async () => (await docker(["exec", "-i", containerOf(A), "nc", "-w", "2", "127.0.0.1", String(ECHO_PORT + 1)], { stdin: control })).out === control, 10), "the echo service did not answer its independent guest control")
  const forward = await forwardAdd(A, ECHO_PORT + 1)
  const diagnostics: string[] = []
  try {
    const one = async (index: number) => {
      const data = new Uint8Array(256 * 1024); crypto.getRandomValues(data.subarray(0, 65536)); data.fill(index, 65536)
      const back = await tcpRead("127.0.0.1", forward.localPort, data, 60, (event) => diagnostics.push(`${index}: ${event}`))
      const same = Buffer.compare(back, Buffer.from(data)) === 0
      if (!same) diagnostics.push(`${index}: ${back.length} of ${data.length} bytes`)
      return same
    }
    const start = Date.now(); const results = await Promise.all(Array.from({ length: 50 }, (_, index) => one(index)))
    const seconds = (Date.now() - start) / 1000
    if (!results.every(Boolean)) {
      const state = (await inspect(A))?.State
      const service = await docker(["exec", containerOf(A), "sh", "-c", "cat /tmp/w08-socat.log; cat /proc/net/netstat 2>/dev/null || true"])
      throw new Error(`${results.filter((ok) => !ok).length} of 50 connections came back wrong; ${diagnostics.join("; ")}; engine state ${JSON.stringify(state)}; echo service log: ${service.out}${service.err}`)
    }
    expect(await until(async () => (await forwardsOf(A)).find((entry) => entry.id === forward.id)?.connections === 0 && (await guestProcesses(A, "/.paddock/busybox nc")).length === 0, 15), "relays are still running after every connection closed")
    return `50 × 256 KiB echoed exactly in ${seconds.toFixed(1)} s; afterwards no open connection and no relay process`
  } finally { await pdk(["forward", "remove", forward.id]) }
})

// A: SSH for editors. Every ssh here reads only this run's configuration (-F), never ~/.ssh.
const SSH_CONFIG = env.PADDOCK_SSH_CONFIG
const sshArgs = (config = SSH_CONFIG) => ["-F", config, "-o", "BatchMode=yes", "-o", "ConnectTimeout=30"]
const sshTo = (name: string, argv: string[], options: { config?: string; extra?: string[] } = {}) => sh(["ssh", ...sshArgs(options.config), ...(options.extra ?? []), `${name}.paddock`, ...argv], { timeoutMs: 120_000 })
// Sets SSH up for a sandbox unless it is ready, so each eval can also run alone.
async function sshReady(name: string): Promise<void> {
  await ensure(name)
  if ((await pdkJson(["ssh", "access", name])).reply.data?.batchReady) return
  const done = await pdkJson(["ssh", "setup", name, "--write-config"], { timeoutMs: 300_000 })
  expect(done.reply.ok, `ssh setup failed: ${done.reply.error?.message}`)
}
// A free port on this machine's loopback, for an ssh -L of this run.
const freePort = async () => { const probe = await controlListener("127.0.0.1"); probe.close(); return probe.port }
// TCP listeners of these processes, as lsof names them.
const listenersOf = async (pids: number[]) => (await sh(["lsof", "-nP", "-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-Fn"])).out.split("\n").filter((line) => line.startsWith("n")).sort()

ev("A01", "After `paddock ssh setup`, `ssh NAME.paddock` logs in without asking anything, as exec's user, with no new listener here or on the engine's host", async () => {
  await ensure(A)
  const hostListeners = async () => (await asRoot("ss -ltnH")).out.split("\n").map((line) => line.trim().split(/\s+/)[3]).filter(Boolean).sort().join(" ")
  const daemon = (await daemonFile()).pid
  const [hostBefore, daemonBefore] = [await hostListeners(), await listenersOf([daemon])]
  await rm(SSH_CONFIG, { force: true })
  const plain = await pdkJson(["ssh", "setup", A], { timeoutMs: 300_000 })
  expect(plain.reply.ok, `ssh setup failed: ${plain.reply.error?.message}`)
  expect(!(await Bun.file(SSH_CONFIG).exists()) && plain.reply.data.included === false && plain.reply.data.batchReady === false && /^Include "/.test(plain.reply.data.include), "setup without --write-config changed the SSH configuration or claimed to be ready")
  await mkdir(dirname(SSH_CONFIG), { recursive: true }); await writeFile(SSH_CONFIG, "Host *\n  ServerAliveInterval 30\n")
  const written = await pdkJson(["ssh", "setup", A, "--write-config"], { timeoutMs: 300_000 }); await pdkJson(["ssh", "setup", A, "--write-config"], { timeoutMs: 300_000 })
  const lines = (await readFile(SSH_CONFIG, "utf8")).split("\n")
  expect(lines[0] === written.reply.data.include && lines.filter((line) => line.startsWith("Include")).length === 1 && lines[1] === "Host *", `the Include line is not there once and first: ${lines.slice(0, 3).join(" | ")}`)
  // A session held open while the listeners are counted.
  const held = Bun.spawn(["ssh", ...sshArgs(), `${A}.paddock`, "sleep 8"], { stdout: "ignore", stderr: "ignore" })
  await Bun.sleep(4000)
  const proxies = (await sh(["pgrep", "-f", `ssh proxy ${A}`])).out.trim().split("\n").filter(Boolean).map(Number)
  const [hostDuring, daemonDuring, clientDuring] = [await hostListeners(), await listenersOf([daemon]), await listenersOf([held.pid, ...proxies])]
  expect(await held.exited === 0, "the held ssh session failed")
  expect(proxies.length > 0, "control: no ProxyCommand was seen while the session was open")
  expect(hostDuring === hostBefore && daemonDuring.join() === daemonBefore.join() && clientDuring.length === 0, `new listeners: engine host ${hostDuring}, daemon ${daemonDuring}, ssh ${clientDuring}`)
  const viaSsh = await sshTo(A, ["id -un; echo $HOME"]); const viaExec = await pdk(["exec", A, "--", "sh", "-c", "id -un; echo $HOME"])
  expect(viaSsh.code === 0 && viaSsh.out === viaExec.out, `ssh: exit ${viaSsh.code} ${viaSsh.out}${viaSsh.err}; exec: ${viaExec.out}`)
  const access = (await pdkJson(["ssh", "access", A])).reply.data
  expect(access.alias === `${A}.paddock` && access.batchReady === true && access.loopbackForwarding === true && `${access.user}\n${access.home}\n` === viaExec.out, `sshAccess: ${JSON.stringify(access)}`)
  const shown = ((await pdkJson(["verify", A])).reply.data?.checks as Array<{ id: string; status: string; detail: string }>).find((check) => check.id === "ssh")
  expect(shown?.status === "info" && shown.detail.includes(written.reply.data.editorKey), `verify did not disclose the key: ${shown?.detail}`)
  return `logged in as ${viaSsh.out.trim().replace("\n", ", home ")}, like exec; the Include was written only with --write-config, once, first; while a session was open, the engine host had the same ${hostBefore.split(" ").length} listeners, the daemon the same, ssh and its ProxyCommand none`
})

ev("A02", "Files go to and from a sandbox over scp and SFTP unchanged", async () => {
  await sshReady(A)
  const data = new Uint8Array(4 * 1048576); for (let at = 0; at < data.length; at += 65536) crypto.getRandomValues(data.subarray(at, at + 65536))
  const local = join(tmp, "a02.bin"); await writeFile(local, data)
  const hash = async (path: string) => new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex")
  const up = await sh(["scp", "-q", ...sshArgs(), local, `${A}.paddock:/tmp/a02.bin`], { timeoutMs: 120_000 })
  const down = await sh(["scp", "-q", ...sshArgs(), `${A}.paddock:/tmp/a02.bin`, `${local}.scp`], { timeoutMs: 120_000 })
  const sftp = await sh(["sftp", "-q", ...sshArgs(), "-b", "-", `${A}.paddock`], { stdin: `put ${local} /tmp/a02s.bin\nget /tmp/a02s.bin ${local}.sftp\n`, timeoutMs: 120_000 })
  expect(up.code === 0 && down.code === 0 && sftp.code === 0, `scp ${up.code}/${down.code} ${up.err}${down.err}, sftp ${sftp.code} ${sftp.err}`)
  const want = await hash(local)
  expect(await hash(`${local}.scp`) === want && await hash(`${local}.sftp`) === want, "a file came back changed")
  const inside = (await pdk(["exec", A, "--", "sha256sum", "/tmp/a02.bin", "/tmp/a02s.bin"])).out
  expect(inside.split("\n").filter((line) => line.startsWith(want)).length === 2, "the copies inside differ")
  return "4 MiB of random bytes, in and out by scp and by SFTP, with the same hash here and inside"
})

ev("A03", "ssh -L reaches a service on the sandbox's loopback, and nothing else; no agent is forwarded", async () => {
  await sshReady(A)
  const nonce = `${PREFIX}-a03-nonce`
  await nonceService(A, nonce, NONCE_PORT + 4)
  const tunnel = async (target: string) => {
    const port = await freePort(); const log = join(tmp, `a03-${port}.log`)
    const child = Bun.spawn(["ssh", ...sshArgs(), "-N", "-E", log, "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:${target}`, `${A}.paddock`], { stdout: "ignore", stderr: "ignore" })
    await until(async () => !(await refused(port)), 20)
    const got = (await tcpRead("127.0.0.1", port, "HEAD / HTTP/1.0\r\n\r\n", 5)).toString()
    child.kill(); await child.exited
    return { got, log: await readFile(log, "utf8").catch(() => "") }
  }
  const loopback = await tunnel(`127.0.0.1:${NONCE_PORT + 4}`)
  expect(loopback.got.includes(nonce), `the tunnel to the sandbox's loopback did not return the nonce: ${loopback.log}`)
  // The same kind of service on the sandbox's own network address. Control: the sandbox reaches it there itself, so a
  // refusal is sshd's, not the network's.
  const ip = await sandboxIp(A); const wide = `${PREFIX}-a03-wide`
  await pdk(["exec", A, "--", "sh", "-c", `(nc -lk -p ${NONCE_PORT + 5} -e echo ${wide} </dev/null >/dev/null 2>&1 &)`])
  expect((await pdk(["exec", A, "--", "nc", "-w", "2", ip, String(NONCE_PORT + 5)])).out.includes(wide), `control: the sandbox does not reach its own ${ip}:${NONCE_PORT + 5}`)
  const outside = await tunnel(`${ip}:${NONCE_PORT + 5}`)
  expect(!outside.got.includes(wide) && /administratively prohibited/.test(outside.log), `a tunnel to ${ip} was not refused: ${outside.got.slice(0, 80)} ${outside.log}`)
  const agentSocket = join(tmp, "a03-agent.sock")
  const agent = await sh(["ssh-agent", "-a", agentSocket])
  try {
    const forwarded = await sshTo(A, ["echo ${SSH_AUTH_SOCK:-none}"], { extra: ["-o", "ForwardAgent=yes", "-o", `IdentityAgent=${agentSocket}`] })
    expect(agent.code === 0 && forwarded.code === 0 && forwarded.out.trim() === "none", `with an agent asked for: exit ${forwarded.code}, SSH_AUTH_SOCK ${forwarded.out.trim()}`)
  } finally { const pid = /SSH_AGENT_PID=(\d+)/.exec(agent.out)?.[1]; if (pid) process.kill(Number(pid)) }
  return `the nonce came through ssh -L; the sandbox's own ${ip}, where it reaches the same service itself, was refused by sshd; a client asking to forward its agent got none`
})

ev("A04", "A client key other than this machine's editor key is refused", async () => {
  await sshReady(A)
  const key = join(tmp, "a04-key"); await sh(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key])
  const config = join(tmp, "a04-config")
  await writeFile(config, (await readFile(join(env.PADDOCK_STATE_DIR, "ssh", "config"), "utf8")).replace(/^ {2}IdentityFile .*$/gm, `  IdentityFile "${key}"`))
  const wrong = await sshTo(A, ["true"], { config }); const right = await sshTo(A, ["true"])
  expect(right.code === 0, `control: the editor key did not log in: ${right.err}`)
  expect(wrong.code === 255 && wrong.err.includes("Permission denied"), `another key: exit ${wrong.code}, ${wrong.err.trim()}`)
  return `the editor key logged in; a new key with the same alias got "${wrong.err.trim().split("\n").at(-1)}"`
})

ev("A05", "A sandbox recreated under the same name is not trusted as the old one: an old alias fails, and its old host key fails verification after setup, until the new files are used", async () => {
  const name = `${PREFIX}-s`
  await sshReady(name)
  try {
    expect((await sshTo(name, ["true"])).code === 0, "control: the first sandbox did not log in")
    const old = join(tmp, "a05"); await mkdir(old, { recursive: true })
    const state = join(env.PADDOCK_STATE_DIR, "ssh")
    await writeFile(join(old, "known_hosts"), await readFile(join(state, "known_hosts")))
    await writeFile(join(old, "config"), (await readFile(join(state, "config"), "utf8")).replace(`"${join(state, "known_hosts")}"`, `"${join(old, "known_hosts")}"`))
    expect((await pdk(["remove", name, "--confirm", name])).code === 0, "remove failed")
    expect(!(await readFile(join(state, "config"), "utf8")).includes(`Host ${name}.paddock`), "the removed sandbox kept its alias")
    await ensure(name)
    const before = await sshTo(name, ["true"], { config: join(old, "config") })
    expect(before.code === 255 && before.err.includes("not set up"), `an old alias before setup: exit ${before.code}, ${before.err.trim()}`)
    await sshReady(name)
    const stale = await sshTo(name, ["true"], { config: join(old, "config") })
    expect(stale.code === 255 && /Host key verification failed/.test(stale.err), `the old host key after setup: exit ${stale.code}, ${stale.err.trim().split("\n").at(-1)}`)
    expect((await sshTo(name, ["true"])).code === 0, "the new files did not log in")
    return `before setup the old alias was refused (not set up); after it, the old host key failed verification; the new files logged in`
  } finally { await pdk(["remove", name, "--confirm", name]) }
})

ev("A06", "ssh to a stopped sandbox is refused and leaves it stopped", async () => {
  await sshReady(A)
  expect((await pdk(["stop", A])).code === 0, "stop failed")
  try {
    const tried = await sshTo(A, ["true"])
    await Bun.sleep(3000)
    const state = (await inspect(A))?.State
    expect(tried.code === 255 && tried.err.includes("not running"), `exit ${tried.code}: ${tried.err.trim()}`)
    expect(state && !state.Running, "the sandbox is running after an ssh attempt")
    expect((await pdkJson(["ssh", "access", A])).reply.data?.batchReady === false, "sshAccess says ready while stopped")
    return `"${tried.err.trim().split("\n")[0]}"; still stopped 3 s later; sshAccess not ready`
  } finally { await ensure(A) }
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
    const bad = reply.data.checks.filter((check: { id: string; status: string }) => CHECKLIST.find((item) => item.id === check.id)!.blocking && check.status !== "pass" && !(check.id === "docker" && check.status === "info" && !reply.data.sandbox.spec.docker))
    expect(bad.length === 0, `not passing: ${bad.map((check: { id: string; status: string }) => `${check.id} ${check.status}`).join(", ")}`)
    expect(/gvisor/i.test((await inside(["exec", name, "--", "cat", "/proc/version"])).out), "exec on Linux did not reach the sandbox")
    expect((await inside(["verify", name])).code === 0 && (await inside(["stop", name])).code === 0 && (await inside(["start", name])).code === 0, "verify, stop or start failed on Linux")
    expect((await inside(["remove", name, "--confirm", name])).code === 0, "remove failed on Linux")
    return `${target.replace("bun-", "")} in a ${arch} Linux container, against this machine's engine`
  } finally { await docker(["exec", runner, "paddock", "remove", name, "--confirm", name]); await docker(["rm", "-f", runner]) }
})

// Named capability gates: a feature that exists on one operating system only, switched off elsewhere with a
// platform-neutral answer. Each must appear exactly as written, once; anything else still needs to name Windows.
const CAPABILITY_GATES: Array<{ file: string; gate: string; why: string }> = [
  { file: "core/daemon.ts", gate: 'process.platform === "darwin" ? await workspaces.summary() : []', why: "workspaces are macOS-only; elsewhere the summary lists none" },
]

ev("P03", "The core has no code that only works on one operating system, except named capability gates", async () => {
  const offenders: string[] = []
  for (const file of ["core/core.ts", "core/daemon.ts", "core/state.ts", "core/run.ts", "core/stream.ts", "core/forwards.ts", "core/ssh.ts", "core/extensions.ts", "core/checks.ts", "core/providers/gvisor.ts", "cli/cli.ts"]) {
    let text = (await readFile(join(ROOT, file), "utf8")).replace(/\/\/.*$/gm, "")
    for (const { gate } of CAPABILITY_GATES.filter((entry) => entry.file === file)) {
      if (text.split(gate).length !== 2) offenders.push(`${file}: the capability gate \`${gate}\` is not there exactly once`)
      text = text.replace(gate, "")
    }
    for (const word of ["osascript", "pbcopy", "launchctl", "/opt/homebrew", "security find-", "vm_stat"]) if (text.includes(word)) offenders.push(`${file}: ${word}`)
    // Every platform branch must name Windows as well as macOS, or name neither.
    if (/process\.platform/.test(text) && !/win32/.test(text)) offenders.push(`${file}: a platform branch without Windows`)
  }
  expect(offenders.length === 0, offenders.join("; "))
  expect(!/"win32" \? \[?"start"/.test(await readFile(join(ROOT, "cli/cli.ts"), "utf8")), "on Windows `start` is a shell builtin, so `ui --open` cannot spawn it")
  return CAPABILITY_GATES.map((entry) => `${entry.file}: ${entry.why}`).join("; ")
})

// E: claims nobody has measured. They are listed so the scorecard does not read as if they had been.
for (const [id, claim, why] of [
  ["E01", "After the engine restarts, no sandbox runs without its guard", "restarting the engine would stop every other container on this machine"],
  ["E03", "The Windows binary runs (the daemon's socket, the dashboard, `ui --open`)", "there is no Windows machine here; the binary only builds"],
] as const) ev(id, claim, async () => skip(why))

ev("E02", "The run records the engine and operating system it actually measured", async () => {
  const info = await docker(["info", "--format", "{{json .}}"])
  expect(info.code === 0, `could not record the engine: ${info.err}`)
  const measured = JSON.parse(info.out)
  return `${process.platform} ${process.arch}; ${measured.OperatingSystem}; Docker ${measured.ServerVersion}; context ${context}; runtime ${engine!.data.runtime}. Other engine/OS combinations are not measured by this run.`
})

ev("E04", "An opt-in real LAN or tailnet target answers this host and is blocked from both the sandbox and inner Docker", async () => {
  const target = process.env.PADDOCK_EVAL_LAN_TARGET
  if (!target) return skip("no PADDOCK_EVAL_LAN_TARGET=IPv4:port supplied; real devices are opt-in")
  const match = /^(10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+):(\d+)$/.exec(target)
  expect(match && match[1]!.split(".").every((part) => Number(part) <= 255) && Number(match[2]) > 0 && Number(match[2]) <= 65535, "the opt-in target must be a private or tailnet IPv4 address and TCP port")
  const [, ip, port] = match
  const control = await new Promise<boolean>((resolve) => {
    const peer = connect(Number(port), ip!, () => { peer.destroy(); resolve(true) })
    peer.setTimeout(3000, () => { peer.destroy(); resolve(false) }); peer.on("error", () => resolve(false))
  })
  if (!control) skip(`${target}: required host TCP control did not connect`)
  await ensure(A); await ensureInner()
  const command = (address: string, service: string) => ["sh", "-c", 'nc -w 3 "$1" "$2" </dev/null', "connect", address, service]
  expect((await pdk(["exec", A, "--", ...command("1.1.1.1", "443")])).code === 0 && (await innerRun(INNER, command("1.1.1.1", "443"))).code === 0, "outer and inner internet controls must connect")
  const outer = await pdk(["exec", A, "--", ...command(ip!, port!)])
  const inner = await innerRun(INNER, command(ip!, port!))
  expect(outer.code === 1 && inner.code === 1, `${target}: outer exit ${outer.code}, inner exit ${inner.code}`)
  return `${target}: host TCP control connected; outer and inner attempts blocked beside working internet controls; no other real device was contacted`
})

const liveGuestPids = async (name: string, marker: string) => (await docker(["exec", containerOf(name), "ps", "-o", "pid,stat,args"])).out.split("\n")
  .filter((line) => line.includes(marker) && !/^\s*\d+\s+Z/.test(line)).map((line) => line.trim().split(/\s+/)[0]!)

async function rawSession(name: string, argv: string[], tty: boolean) {
  const reader = new FrameReader()
  const client = connect(join(env.PADDOCK_STATE_DIR, "stream.sock"), () => client.write(frame("open", { kind: "exec", name, argv, tty, cols: 80, rows: 24 })))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.destroy(); reject(new Error("stream did not become ready")) }, 10_000)
    client.on("error", reject)
    client.on("data", (chunk: Buffer) => {
      for (const piece of reader.push(chunk)) {
        if (piece.kind === "ready") { clearTimeout(timer); resolve() }
        if (piece.kind === "error") { clearTimeout(timer); reject(new Error(piece.payload.toString())) }
      }
    })
  })
  return client
}

ev("S07", "Killing a stream client or sending FIN ends its non-TTY and TTY command within five seconds; a connected control keeps running", async () => {
  await ensure(A)
  const control = await rawSession(A, ["sleep", "6195"], false)
  try {
    for (const tty of [false, true]) {
      const marker = `sleep ${tty ? 6197 : 6196}`
      const client = await rawSession(A, marker.split(" "), tty)
      try {
        expect(await until(async () => (await liveGuestPids(A, marker)).length === 1, 5), `${marker} did not start`)
        client.end()
        expect(await until(async () => !(await liveGuestPids(A, marker)).length, 5), `${tty ? "TTY" : "non-TTY"} command survived the client's FIN`)
        expect((await liveGuestPids(A, "sleep 6195")).length === 1, "the connected control was ended")
      } finally { client.destroy() }
    }
    const killed = Bun.spawn([BIN, "exec", A, "--stream", "--", "sleep", "6198"], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "ignore", stderr: "ignore" })
    try {
      expect(await until(async () => (await liveGuestPids(A, "sleep 6198")).length === 1, 5), "the CLI command did not start")
      killed.kill("SIGKILL"); await killed.exited
      expect(await until(async () => !(await liveGuestPids(A, "sleep 6198")).length, 5), "the command survived a killed CLI client")
      expect((await liveGuestPids(A, "sleep 6195")).length === 1, "the connected control was ended")
    } finally { killed.kill(); await killed.exited }
    return "non-TTY FIN, TTY FIN, and SIGKILL of the CLI each left no live command within 5 s; connected control stayed running"
  } finally { control.destroy() }
})

ev("W09", "A closed forward connection leaves no nc relay within five seconds where the port's service ends at end of input, while a connected control keeps its relay", async () => {
  await ensure(A)
  const port = 3110
  await pdk(["exec", A, "--", "sh", "-c", `(nc -lk -s 127.0.0.1 -p ${port} -e cat </dev/null >/dev/null 2>&1 &)`])
  const forward = await forwardAdd(A, port)
  const control = connect(forward.localPort, "127.0.0.1"), dropped = connect(forward.localPort, "127.0.0.1")
  control.on("error", () => {}); dropped.on("error", () => {})
  const marker = `/.paddock/busybox nc 127.0.0.1 ${port}`
  try {
    expect(await until(async () => (await liveGuestPids(A, marker)).length === 2, 10), "two relay controls did not start")
    await Bun.sleep(3000)
    expect((await liveGuestPids(A, marker)).length === 2, "a connected control ended without disconnection")
    dropped.destroy()
    expect(await until(async () => (await liveGuestPids(A, marker)).length === 1, 5), "a relay survived its client's dropped connection")
    expect((await forwardsOf(A)).find((entry) => entry.id === forward.id)?.connections === 1, "the connected control was not retained")
    control.destroy()
    expect(await until(async () => !(await liveGuestPids(A, marker)).length, 5), "a relay survived a dropped connection")
    return "both relays stayed running while connected; each closed connection ended its nc within 5 s (a port that ignores end of input keeps its relay until ten minutes of silence: a unit test, not this run)"
  } finally { control.destroy(); dropped.destroy(); await pdk(["forward", "remove", forward.id]) }
})

ev("W10", "A forward carries bytes in a sandbox whose guest looked up the relay's path before the first forward, beside a control where nothing looked; a guest that removes the relay gets a refusal that names the restart, and a restart repairs it", async () => {
  const looked = `${PREFIX}-wl`; const plain = `${PREFIX}-wc`
  try {
    await fresh(looked); await fresh(plain)
    // What an agent's `ls`, or a guest on purpose, can do before Paddock copies the relay in.
    const lookup = await pdk(["exec", looked, "--", "sh", "-c", "ls -la /.paddock /.paddock/busybox; stat /.paddock/busybox; true"])
    const carried: string[] = []
    for (const name of [plain, looked]) {
      const nonce = `${PREFIX}-w10-${name}`
      await nonceService(name, nonce)
      expect((await pdk(["exec", name, "--", "nc", "-w", "2", "127.0.0.1", String(NONCE_PORT)])).out.includes(nonce), `control: the service does not answer inside ${name}`)
      const forward = await forwardAdd(name, NONCE_PORT)
      try {
        const back = (await tcpRead("127.0.0.1", forward.localPort)).toString()
        const seen = await pdk(["exec", name, "--", "sh", "-c", "ls -la /.paddock 2>&1; true"])
        expect(back.includes(nonce), `${name === plain ? "control" : "after the lookup"}: the forward returned ${JSON.stringify(back)}; inside, ls /.paddock: ${seen.out.trim()}`)
        carried.push(name === plain ? "the control" : "the sandbox that looked first")
      } finally { await pdk(["forward", "remove", forward.id]) }
    }
    // Removing the relay while running hides any new copy until a restart: forward add must say so, not listen.
    await pdk(["exec", looked, "--", "sh", "-c", "rm -rf /.paddock; ls /.paddock; true"])
    const removed = await pdkJson(["forward", "add", looked, "--port", String(NONCE_PORT)])
    expect(!removed.reply.ok && /Stop and start/.test(removed.reply.error?.message ?? ""), `after the guest removed the relay, forward add said ${JSON.stringify(removed.reply)}`)
    expect(!(await forwardsOf(looked)).length, "a refused forward was recorded")
    expect((await pdk(["stop", looked])).code === 0 && (await pdk(["start", looked])).code === 0, "stop and start failed")
    const nonce = `${PREFIX}-w10-restarted`
    await nonceService(looked, nonce)
    const again = await forwardAdd(looked, NONCE_PORT)
    try { expect((await tcpRead("127.0.0.1", again.localPort)).toString().includes(nonce), "after a restart the forward did not carry the nonce") } finally { await pdk(["forward", "remove", again.id]) }
    return `the nonce came back through ${carried.join(" and ")}; the guest's lookup before the first forward said: ${(lookup.out + lookup.err).trim().split("\n")[0]}; after the guest removed the relay, forward add was refused (exit ${removed.code}) and worked after a restart`
  } finally { for (const name of [looked, plain]) await pdk(["remove", name, "--confirm", name]) }
})

ev("A07", "Killing an SSH proxy client leaves no sshd -i within five seconds, while a connected proxy keeps its sshd", async () => {
  await sshReady(A)
  const proxy = () => Bun.spawn([BIN, "ssh", "proxy", A], { env: { ...process.env, ...env }, stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  const control = proxy()
  let dropped: ReturnType<typeof proxy> | undefined
  const marker = "sshd"
  try {
    expect(await until(async () => (await liveGuestPids(A, marker)).length > 0, 10), "the sshd control did not start")
    const controlPids = await liveGuestPids(A, marker)
    dropped = proxy()
    let droppedPids: string[] = []
    expect(await until(async () => { droppedPids = (await liveGuestPids(A, marker)).filter((pid) => !controlPids.includes(pid)); return droppedPids.length > 0 }, 10), "the second sshd control did not start")
    await Bun.sleep(3000)
    expect((await liveGuestPids(A, marker)).some((pid) => droppedPids.includes(pid)), "a connected sshd control ended")
    dropped.kill("SIGKILL"); await dropped.exited
    expect(await until(async () => !(await liveGuestPids(A, marker)).some((pid) => droppedPids.includes(pid)), 5), "sshd survived a killed proxy client")
    expect((await liveGuestPids(A, marker)).some((pid) => controlPids.includes(pid)), "the connected sshd control was ended")
    control.kill("SIGKILL"); await control.exited
    expect(await until(async () => !(await liveGuestPids(A, marker)).length, 5), "sshd survived the last proxy client")
    return "two inetd sshd controls stayed running while connected; killing each proxy ended its sshd within 5 s, including renamed OpenSSH processes"
  } finally { control.kill(); dropped?.kill(); await Promise.all([control.exited, dropped?.exited]) }
})

// L: resized limits hold where resize says they do. Allocations and processes are tried inside; the limits are read
// from the sandbox's cgroup on the engine's host, not from Paddock.
const RS = `${PREFIX}-rs`
const MB700 = 734_003_200
// Holds the given number of bytes in one process (tail keeps the last line, and zeros have no line break).
const hog = (name: string, bytes = MB700) => pdk(["exec", name, "--", "sh", "-c", `head -c ${bytes} /dev/zero | tail -n 1 | wc -c`], { timeoutMs: 120_000 })
const held = (run: Sh, bytes = MB700) => run.code === 0 && run.out.trim() === String(bytes)
async function fresh(name: string, spec: Record<string, unknown> = {}): Promise<void> {
  if (await view(name)) await pdk(["remove", name, "--confirm", name])
  const made = await socket("create", { name, image: "alpine:latest", cpus: 1, memoryGb: 1, diskGb: 1, ...spec })
  expect(made.reply.ok, `could not create ${name}: ${made.reply.error?.message}`)
}
const hostLimits = async (name: string) => {
  const id = (await inspect(name))?.Id as string
  const read = await docker(["run", "--rm", "--privileged", "--cgroupns", "host", "--network", "none", "--runtime", "runc", "-u", "0", HELPER_IMAGE, "sh", "-c",
    `d=$(find /sys/fs/cgroup -maxdepth 4 -type d -name "*${id}*" | head -n 1); [ -n "$d" ] && cat "$d/memory.max" "$d/pids.max" "$d/cpu.max"`])
  expect(read.code === 0, `the sandbox's cgroup could not be read on the engine's host: ${read.err}`)
  const [memory, pids, cpu] = read.out.trim().split("\n")
  return { memory: Number(memory), pids: Number(pids), cpu: cpu! }
}
const resize = (name: string, flags: string[]) => pdkJson(["resize", name, ...flags])
const applies = (run: Awaited<ReturnType<typeof resize>>, limit: string) => (run.reply.data?.changes as Array<{ limit: string; applies: string }> | undefined)?.find((change) => change.limit === limit)?.applies

ev("L01", "Resize raises a running sandbox's memory at once: 700 MB that a 0.5 GB sandbox is killed for completes after a resize to 1 GB", async () => {
  await fresh(RS, { memoryGb: 0.5, pids: 512 })
  const control = await hog(RS)
  expect(!held(control), "control failed: 700 MB completed under a 0.5 GB limit, so a raise cannot be told apart")
  await ensure(RS)
  const memTotal = async () => Number(/MemTotal:\s+(\d+)/.exec((await pdk(["exec", RS, "--", "cat", "/proc/meminfo"])).out)?.[1]) * 1024
  const insideBefore = await memTotal()
  const raised = await resize(RS, ["--memory", "1"])
  expect(raised.reply.ok, `resize failed: ${raised.reply.error?.message}`)
  expect(applies(raised, "memoryGb") === "now", `resize said the new memory applies ${applies(raised, "memoryGb")}`)
  const host = await hostLimits(RS)
  expect(host.memory === 1024 ** 3, `the engine's host has memory.max ${host.memory}, not 1 GiB`)
  // What the docs tell users not to rely on: gVisor's own view keeps the start value.
  const inside = await memTotal()
  expect(inside > 0 && inside === insideBefore, `inside, /proc/meminfo showed ${insideBefore} bytes before the resize and ${inside} after, so the docs' warning is wrong`)
  const after = await hog(RS)
  expect(held(after) && await running(RS), `700 MB under the new 1 GB limit: exit ${after.code}, ${after.out.trim()}${await running(RS) ? "" : "; the sandbox is not running"}`)
  return `control: killed at 0.5 GB (exit ${control.code}); after resize, memory.max is 1 GiB on the engine's host and 700 MB completed, while /proc/meminfo inside still shows ${(inside / 1024 ** 2).toFixed(0)} MiB`
})

ev("L02", "Lowering a running sandbox's memory takes effect at once, and a stopped sandbox gets new limits at its next start", async () => {
  if ((await view(RS))?.spec.memoryGb !== 1) await fresh(RS, { memoryGb: 1, pids: 512 })
  await ensure(RS)
  expect(held(await hog(RS)), "control failed: 700 MB did not complete under 1 GB")
  const lowered = await resize(RS, ["--memory", "0.5"])
  expect(lowered.reply.ok && applies(lowered, "memoryGb") === "now", `lowering to 0.5 GB: ${lowered.reply.error?.message ?? applies(lowered, "memoryGb")}`)
  expect((await hostLimits(RS)).memory === 512 * 1024 ** 2, "the engine's host does not have memory.max at 512 MiB")
  expect(!held(await hog(RS)), "700 MB still completed after the limit was lowered to 0.5 GB")
  if (await running(RS)) await socket("stop", { name: RS })
  const stopped = await resize(RS, ["--memory", "1", "--pids", "1024"])
  expect(stopped.reply.ok && applies(stopped, "memoryGb") === "next start" && applies(stopped, "pids") === "next start", `a stopped sandbox's resize said: ${JSON.stringify(stopped.reply.data?.changes ?? stopped.reply.error)}`)
  const data = await inspect(RS)
  expect(data.HostConfig.Memory === 1024 ** 3 && data.HostConfig.PidsLimit === 1024, `the engine holds ${data.HostConfig.Memory} bytes and ${data.HostConfig.PidsLimit} tasks for the next start`)
  expect((await socket("start", { name: RS })).reply.ok, "the resized sandbox did not start")
  const host = await hostLimits(RS)
  expect(host.memory === 1024 ** 3 && host.pids === 1024, `after the start the engine's host has memory.max ${host.memory} and pids.max ${host.pids}`)
  const limits = (await socket("verify", { name: RS })).reply.data.checks.find((check: { id: string }) => check.id === "limits")
  expect(limits.status === "pass" && limits.detail.includes("1 GB memory, 1024 tasks"), `verify's limits check: ${limits.status} ${limits.detail}`)
  return "0.5 GB took effect on a running sandbox; 1 GB and 1024 tasks set while stopped held after the start"
})

ev("L03", "The task limit and CPUs change on a running sandbox: 300 sleeps fail under 256 tasks and run after a resize to 2048; busy loops get about one CPU, then two", async () => {
  await fresh(RS, { memoryGb: 1, pids: 256, cpus: 1 })
  const cpu = async () => {
    const loops = pdk(["exec", RS, "--", "sh", "-c", 'for i in 1 2 3; do timeout 10 sh -c "while :; do :; done" & done; wait'], { timeoutMs: 60_000 })
    await Bun.sleep(4000)
    const stats = await docker(["stats", "--no-stream", "--format", "{{.CPUPerc}}", containerOf(RS)])
    await loops
    return parseFloat(stats.out)
  }
  const nprocBefore = (await pdk(["exec", RS, "--", "nproc"])).out.trim()
  const one = await cpu()
  expect(one > 50 && one < 150, `control: three busy loops under 1 CPU used ${one}%`)
  const cpus = await resize(RS, ["--cpus", "2"])
  expect(applies(cpus, "cpus") === "now", `resize said the CPUs apply ${applies(cpus, "cpus")}`)
  const two = await cpu()
  expect(two > 160, `three busy loops after a resize to 2 CPUs used ${two}%`)
  const nproc = (await pdk(["exec", RS, "--", "nproc"])).out.trim()
  expect(nproc === nprocBefore, `inside, nproc said ${nprocBefore} before the resize to 2 CPUs and ${nproc} after, so the docs' warning is wrong`)
  const sleeps = 'i=0; while [ $i -lt 300 ]; do sleep 60 & i=$((i+1)); done 2>/dev/null; ps -o args | grep -cx "sleep 60"'
  const control = await pdk(["exec", RS, "--", "sh", "-c", sleeps], { timeoutMs: 60_000 })
  const ranBefore = await running(RS) ? Number(control.out.trim().split("\n").pop()) : 0
  expect(ranBefore < 300, `control: ${ranBefore} of 300 sleeps ran under 256 tasks`)
  if (await running(RS)) await pdk(["exec", RS, "--", "pkill", "-f", "sleep 60"])
  await ensure(RS)
  const raised = await resize(RS, ["--pids", "2048"])
  expect(applies(raised, "pids") === "now" && (await hostLimits(RS)).pids === 2048, `the task limit: ${applies(raised, "pids")}, pids.max ${(await hostLimits(RS)).pids}`)
  const after = await pdk(["exec", RS, "--", "sh", "-c", sleeps], { timeoutMs: 60_000 })
  const ran = Number(after.out.trim().split("\n").pop())
  await pdk(["exec", RS, "--", "pkill", "-f", "sleep 60"])
  expect(ran === 300 && await running(RS), `${ran} of 300 sleeps ran after the resize to 2048`)
  return `CPU ${one.toFixed(0)}% under 1, ${two.toFixed(0)}% under 2 (nproc inside ${nprocBefore} before and after); ${ranBefore} of 300 sleeps under 256 tasks${ranBefore === 0 ? " (the sandbox ended)" : ""}, 300 under 2048`
})

ev("L04", "Resize refuses, with clear exit codes, memory and tasks below what the sandbox uses (4), sizes below the minimums (2) and unknown sandboxes (3), and changes nothing", async () => {
  if ((await view(RS))?.spec.memoryGb !== 1 || (await view(RS))?.spec.pids !== 2048) await fresh(RS, { memoryGb: 1, pids: 2048 })
  await ensure(RS)
  // A file in a tmpfs that gVisor keeps in memory, which the engine counts as the sandbox's. /dev/shm is only 64 MiB on
  // Docker's default (native Linux), so the first tmpfs with room is used, and the write must succeed in full.
  const hold = (await pdk(["exec", RS, "--", "sh", "-c", 'for d in /tmp /dev/shm; do grep -q " $d tmpfs " /proc/mounts && [ "$(df -Pk $d | awk \'NR==2{print $4}\')" -gt 330000 ] && { echo $d/hold; exit; }; done'])).out.trim()
  if (!hold) skip("no tmpfs in the sandbox has 320 MiB free, so the engine cannot be shown 300 MiB in use")
  const wrote = await pdk(["exec", RS, "--", "sh", "-c", `head -c 314572800 /dev/zero > ${hold} && stat -c %s ${hold}`])
  expect(wrote.code === 0 && wrote.out.trim() === "314572800", `control: 300 MiB could not be written to ${hold}: exit ${wrote.code} ${wrote.out.trim()} ${wrote.err.trim()}`)
  const usage = (await docker(["stats", "--no-stream", "--format", "{{.MemUsage}}", containerOf(RS)])).out
  expect(/^\s*(\d+(\.\d+)?)MiB/.test(usage) && parseFloat(usage) >= 256, `control: the engine reports ${usage.trim()} in use, not over 256 MiB`)
  const before = (await inspect(RS)).HostConfig.Memory
  const refused = await pdk(["resize", RS, "--memory", "0.25"])
  expect(refused.code === 4 && /uses/.test(refused.err), `lowering memory below use: exit ${refused.code}, ${refused.err.trim()}`)
  expect((await inspect(RS)).HostConfig.Memory === before && (await view(RS))?.spec.memoryGb === 1 && await running(RS), "a refused resize changed the sandbox")
  const wrong: string[] = []
  for (const [flags, code] of [[["--memory", "0.1"], 2], [["--pids", "10"], 2], [["--cpus", "0"], 2], [["--disk", "0"], 2], [[], 2]] as Array<[string[], number]>) {
    const run = await pdk(["resize", RS, ...flags]); if (run.code !== code) wrong.push(`resize ${flags.join(" ")} exited ${run.code}`)
  }
  const unknown = await pdk(["resize", `${PREFIX}-nope`, "--memory", "1"]); if (unknown.code !== 3) wrong.push(`an unknown sandbox exited ${unknown.code}`)
  expect(wrong.length === 0, wrong.join("; "))
  // Tasks as the engine counts them, gVisor's own threads included.
  await pdk(["exec", RS, "--", "sh", "-c", 'i=0; while [ $i -lt 300 ]; do sleep 600 >/dev/null 2>&1 & i=$((i+1)); done'], { timeoutMs: 60_000 })
  const tasks = Number((await docker(["stats", "--no-stream", "--format", "{{.PIDs}}", containerOf(RS)])).out.trim())
  expect(tasks > 256, `control: the engine counts ${tasks} tasks, not over 256`)
  const fewer = await pdk(["resize", RS, "--pids", "256"])
  expect(fewer.code === 4 && (await inspect(RS)).HostConfig.PidsLimit === 2048 && await running(RS), `lowering tasks below use: exit ${fewer.code}, ${fewer.err.trim()}`)
  await pdk(["exec", RS, "--", "pkill", "-f", "sleep 60"])
  await pdk(["exec", RS, "--", "rm", hold])
  const allowed = await resize(RS, ["--memory", "0.5"])
  expect(allowed.reply.ok, `control: lowering to 0.5 GB once the memory was freed failed: ${allowed.reply.error?.message}`)
  return `300 MiB held in ${hold}; refused at ${usage.trim()} in use and at ${tasks} tasks for a limit of 256; allowed once the memory was freed`
})

ev("L05", "Verify judges limits against the resized values: a limit changed behind Paddock's back fails it and stops the sandbox", async () => {
  await ensure(RS)
  const control = (await socket("verify", { name: RS })).reply.data.checks.find((check: { id: string }) => check.id === "limits")
  expect(control.status === "pass", `control: verify's limits check did not pass before the change: ${control.detail}`)
  expect((await docker(["update", "--memory", "2g", "--memory-swap", "2g", containerOf(RS)])).code === 0, "docker update failed")
  const run = await pdk(["verify", RS])
  const stopped = !await running(RS)
  await pdk(["remove", RS, "--confirm", RS])
  expect(run.code === 6 && run.out.includes("not the ones Paddock set") && stopped, `verify exited ${run.code}${stopped ? "" : " and left the sandbox running"}`)
})

ev("L06", "A lowered disk limit is watched from the next pass: 1.3 GB runs under 2 GB, is refused as a 1 GB limit, and once freed and rewritten is stopped under 1 GB", async () => {
  await fresh(RS, { diskGb: 2, pids: 256 })
  if ((await socket("verify", { name: RS })).reply.data.checks.find((check: { id: string }) => check.id === "disk").status !== "weak") skip("this engine's disk limit is not watched")
  const write = () => pdk(["exec", RS, "--", "dd", "if=/dev/zero", "of=/big", "bs=1M", "count=1300"], { timeoutMs: 120_000 })
  try {
    expect((await write()).code === 0, "control: 1.3 GB could not be written under 2 GB")
    // Two passes of the watch, so a stop would have come.
    await Bun.sleep(65_000)
    expect(await running(RS), "control: 1.3 GB under a 2 GB limit was stopped")
    const refused = await pdk(["resize", RS, "--disk", "1"])
    expect(refused.code === 4 && (await view(RS))?.spec.diskGb === 2, `a 1 GB limit under 1.3 GB in use: exit ${refused.code}, ${refused.err.trim()}`)
    await pdk(["exec", RS, "--", "rm", "/big"])
    const lowered = await resize(RS, ["--disk", "1"])
    expect(lowered.reply.ok && applies(lowered, "diskGb") === "now", `resize --disk 1 after freeing: ${lowered.reply.error?.message ?? applies(lowered, "diskGb")}`)
    await write()
    const started = Date.now()
    expect(await until(async () => (await view(RS))?.status === "stopped", 75), "the sandbox still ran 75 s after passing its new 1 GB limit")
    expect(/disk watch/i.test((await view(RS))?.stopReason ?? ""), "it stopped without saying it was the disk watch")
    return `refused while 1.3 GB was in use; after the resize, 1.3 GB was stopped ${Math.round((Date.now() - started) / 1000)} s after the write ended`
  } finally { await pdk(["remove", RS, "--confirm", RS]) }
})

// C: templates. Files are looked for inside the new sandbox and, for what must be gone, in the image from the engine.
const TS = `${PREFIX}-ts`; const TC = `${PREFIX}-tc`; const TD = `${PREFIX}-td`
const TPL = `${PREFIX}-tpl`; const TPL2 = `${PREFIX}-tpl2`; const TPLD = `${PREFIX}-tpld`
const LOGINS = ["/root/.ssh/id_rsa", "/root/.claude-work/.credentials.json", "/home/dev/.git-credentials"]
let templateOwner = ""; let templateScanSaw = 0
let snapshotWindow: { events: string[]; startedAt: string; tmpInMemory: boolean } | undefined
// Every image carrying a template label whose source is one of this run's sandboxes, tagged or not.
async function templateImages(): Promise<Array<{ id: string; tags: string[]; source: string }>> {
  const ids = [...new Set((await docker(["image", "ls", "-a", "-q", "--no-trunc", "--filter", "label=dev.paddock.template"])).out.split("\n").filter(Boolean))]
  if (!ids.length) return []
  const images = JSON.parse((await docker(["image", "inspect", ...ids])).out || "[]") as Array<{ Id: string; RepoTags?: string[]; Config?: { Labels?: Record<string, string> } }>
  return images.map((image) => ({ id: image.Id, tags: image.RepoTags ?? [], source: image.Config?.Labels?.["dev.paddock.template.source"] ?? "" })).filter((image) => image.source.startsWith(PREFIX))
}
const imageExists = async (id: string) => (await docker(["image", "inspect", id])).code === 0
const templateOf = async (name: string) => ((await pdkJson(["template", "list"])).reply.data as Array<{ name: string; imageId: string; dependants: string[] }>).find((entry) => entry.name === name)

ev("C01", "Templates carry layer files and home folders, exclude engine hosts and hostname files and memory, and start with Paddock DNS", async () => {
  await fresh(TS)
  const planted = await pdk(["exec", TS, "--", "sh", "-c", `echo carried > /root/marker; mkdir -p /home/dev /opt/app && echo dev > /home/dev/notes && echo app > /opt/app/marker
echo shm > /dev/shm/marker; echo tmp > /tmp/marker; echo token > /root/.npmrc
for f in ${LOGINS.join(" ")}; do mkdir -p "\${f%/*}"; echo secret > "$f"; done
for f in /etc/hosts /etc/hostname /etc/resolv.conf; do echo "# ${PREFIX}-planted" >> "$f"; done
grep -l "${PREFIX}-planted" /etc/hosts /etc/hostname /etc/resolv.conf
grep -q " /tmp tmpfs" /proc/mounts && echo tmp-in-memory; sleep 600 >/dev/null 2>&1 &`])
  expect(planted.code === 0, `planting files failed: ${planted.err}`)
  for (const file of ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"]) expect(planted.out.split("\n").includes(file), `control: ${file} never had the planted line`)
  // Control: gVisor's writes reach the engine's layer at once, and the in-memory ones are there inside. A forward puts
  // Paddock's relay in the source, which the template must not carry (C02).
  expect((await docker(["cp", `${containerOf(TS)}:/root/marker`, "-"])).code === 0, "control: the engine cannot see a file written in the source")
  const forward = await pdkJson(["forward", "add", TS, "--port", "8080"])
  expect(forward.reply.ok && (await docker(["cp", `${containerOf(TS)}:/.paddock/busybox`, "-"])).code === 0, "control: a forward did not put the relay in the source")
  await pdk(["forward", "remove", forward.reply.data.id])
  expect((await pdk(["exec", TS, "--", "cat", "/dev/shm/marker", "/tmp/marker"])).out.includes("shm"), "control: the source cannot read its own /dev/shm")
  const etc = ["/etc/hosts", "/etc/hostname", "/etc/resolv.conf"]
  // A start on a running sandbox restores DNS too; enforcement may already have done so. Measure that behavior
  // explicitly instead of depending on whether the 30-second pass has happened since planting.
  expect((await pdk(["start", TS])).code === 0, "start did not restore the source's DNS")
  expect((await pdk(["exec", TS, "--", "cat", "/etc/resolv.conf"])).out === "nameserver 1.1.1.1\nnameserver 8.8.8.8\n", "source DNS was not restored")
  const planted_ = (await pdk(["exec", TS, "--", "grep", "-l", `${PREFIX}-planted`, ...etc])).out.trim().split("\n")
  expect(JSON.stringify(planted_) === JSON.stringify(etc.slice(0, 2)), `control: source hosts/hostname markers changed, or DNS was not restored: ${planted_.join(", ")}`)
  const { Id: sourceId, State: { StartedAt: startedAt } } = await inspect(TS)
  // Recorded as they happen: the engine keeps only its latest events, and later evals make many.
  const watch = Bun.spawn(["docker", "--context", context, "events", "--filter", `container=${sourceId}`, "--format", "{{.Action}}"], { stdout: "pipe", stderr: "ignore" })
  await Bun.sleep(1000)
  const saved = await pdkJson(["snapshot", TS, "--as", TPL], { timeoutMs: 600_000 })
  await Bun.sleep(1000); watch.kill()
  const events = (await new Response(watch.stdout).text()).split("\n").filter(Boolean)
  expect(saved.reply.ok, `snapshot failed: ${saved.reply.error?.message}`)
  snapshotWindow = { events, startedAt, tmpInMemory: planted.out.includes("tmp-in-memory") }
  const images = await templateImages()
  const image = images.find((entry) => entry.tags.some((tag) => tag.endsWith(`:${TPL}`)))
  expect(image && image.id === saved.reply.data.template.imageId, `the engine has no image tagged ${TPL} with the id snapshot reported`)
  templateScanSaw = images.length; templateOwner = image!.tags.find((tag) => tag.endsWith(`:${TPL}`))!.split(":")[0]!.replace(/^paddock-template-/, "")
  const made = await pdkJson(["create", TC, "--template", TPL])
  expect(made.reply.ok, `create --template failed: ${made.reply.error?.message}`)
  expect((await inspect(TC)).Image === image!.id, "the new sandbox's container does not run the template's image")
  const read = await pdk(["exec", TC, "--", "sh", "-c", "cat /root/marker /home/dev/notes /opt/app/marker; ls /dev/shm/marker /tmp/marker 2>&1"])
  for (const word of ["carried", "dev", "app"]) expect(read.out.includes(word), `a file written before the snapshot is missing: ${read.out}`)
  expect(/\/dev\/shm\/marker: No such file/.test(read.out), "/dev/shm carried into the template")
  const carried = (await pdk(["exec", TC, "--", "grep", "-l", `${PREFIX}-planted`, ...etc])).out.trim()
  expect(!carried, `the engine's files carried into the template: ${carried}`)
  expect((await pdk(["exec", TC, "--", "cat", "/etc/resolv.conf"])).out === "nameserver 1.1.1.1\nnameserver 8.8.8.8\n", "template sandbox did not start with Paddock DNS")
  if (snapshotWindow.tmpInMemory) expect(/\/tmp\/marker: No such file/.test(read.out), "an in-memory /tmp carried into the template")
  else expect(!/\/tmp\/marker: No such file/.test(read.out), "/tmp was on the layer, yet did not carry")
  const check = made.reply.data.checks.find((entry: { id: string }) => entry.id === "template")
  expect(check.status === "info" && check.detail.includes(`Template ${TPL}`) && made.reply.data.sandbox.template?.name === TPL, `the template check says: ${check.status} ${check.detail}`)
  return `/root, /home and /opt carried; /dev/shm did not; /tmp was ${snapshotWindow.tmpInMemory ? "in memory and did not" : "on the layer and did"}; source hosts/hostname markers persisted until snapshot and did not carry; source DNS was restored before snapshot, new sandbox DNS is the public fallback`
})

ev("C02", "Login files are left out of a template, as seen from the engine; other files with secrets, such as .npmrc, are carried, as the snapshot says", async () => {
  if (!await view(TC)) skip("C01 did not make a template sandbox")
  const source = (await socket("verify", { name: TS })).reply.data.checks.find((check: { id: string }) => check.id === "credentials")
  for (const file of LOGINS) expect(source.detail.includes(file), `control: the source's credentials check does not list ${file}`)
  const template = await templateOf(TPL)
  expect(template, "the template is not listed")
  const listed = ((await pdkJson(["template", "list"])).reply.data as Array<{ name: string; loginsRemoved: string[] }>).find((entry) => entry.name === TPL)!
  for (const file of LOGINS) expect(listed.loginsRemoved.includes(file), `the template does not say it left out ${file}`)
  // Straight from the image, with the engine's own copy: no Paddock code reads it.
  const peek = `${PREFIX}-peek`
  expect((await docker(["create", "--name", peek, "--network", "none", template!.imageId, "true"])).code === 0, "a container of the template's image could not be made")
  try {
    expect((await docker(["cp", `${peek}:/root/marker`, "-"])).code === 0, "control: the engine cannot copy a carried file out of the image")
    for (const file of LOGINS) expect((await docker(["cp", `${peek}:${file}`, "-"])).code !== 0, `${file} is in the template's image`)
    expect((await docker(["cp", `${peek}:/root/.npmrc`, "-"])).code === 0, "the snapshot says other secret files are carried, yet /root/.npmrc was not")
    const files = (await docker(["export", peek], { timeoutMs: 120_000 })).out
    expect(!/\.paddock\/busybox|\.paddock-snapshot-[0-9a-f]+\//.test(files), "Paddock's relay or the snapshot's busybox is in the template's image")
  } finally { await docker(["rm", "-f", peek]) }
  const inside = (await socket("verify", { name: TC })).reply.data.checks.find((check: { id: string }) => check.id === "credentials")
  expect(inside.detail.startsWith("None"), `the template sandbox's credentials check says: ${inside.detail}`)
  const saidContents = (await readFile(join(ROOT, "core/core.ts"), "utf8")).includes(".env files, package-manager tokens")
  expect(saidContents, "the snapshot no longer says loudly what else is inside")
})

ev("C03", "Saving a running sandbox pauses it for the save and leaves it running, with its processes", async () => {
  if (!snapshotWindow) skip("C01 did not take a snapshot")
  const { events } = snapshotWindow!
  expect(events.includes("commit"), `control: the engine's events for the source during the snapshot do not include its commit: ${events.join(", ") || "none"}`)
  expect(events.includes("pause") && events.includes("unpause"), `the engine's events for the source during the snapshot: ${events.join(", ")}`)
  expect(await running(TS) && (await inspect(TS)).State.StartedAt === snapshotWindow!.startedAt, "the source was restarted or stopped by the snapshot")
  const sleeper = await pdk(["exec", TS, "--", "pgrep", "-f", "sleep 600"])
  expect(sleeper.code === 0, "a process started before the snapshot is gone")
  return `events: ${events.join(", ")}`
})

ev("C04", "A sandbox made from a template passes every blocking check, and the host does not answer it", async () => {
  if (!await view(TC)) skip("C01 did not make a template sandbox")
  await ensure(TC)
  // The evals' own listeners take the stand-in addresses verify probes, as in H14.
  await docker(["rm", "-f", HOST])
  expect(await until(async () => !(await asRoot("ip -br link")).out.includes(`${PREFIX}a`), 15), "the evals' own listeners did not go away")
  const report = await socket("verify", { name: TC })
  expect(report.reply.data.ok, `verify: ${report.reply.data.checks.filter((check: { status: string }) => check.status === "fail").map((check: { id: string }) => check.id).join(", ")}`)
  const weak = (report.reply.data.checks as Array<{ id: string; status: string; evidence: string }>).filter((check) => ["net-host", "net-peers", "net-private"].includes(check.id) && !(check.status === "pass" && check.evidence === "probed"))
  expect(weak.length === 0, `not probed: ${weak.map((check) => `${check.id} (${check.status}, ${check.evidence})`).join(", ")}`)
  await hostHelper()
  expect(/gvisor/i.test((await pdk(["exec", TC, "--", "cat", "/proc/version"])).out), "the template sandbox does not run on gVisor")
  const gateway = await gatewayOf(TC)
  expect(await fromHost(gateway, HOST_PORT), "control: the host listener did not answer the host")
  expect(!await fromSandbox(TC, gateway, HOST_PORT), "the template sandbox reached the engine's host")
  const data = await inspect(TC)
  expect(!data.HostConfig.Privileged && !(data.HostConfig.CapAdd ?? []).length && data.HostConfig.NetworkMode === `paddock-net-${TC}`, "the template sandbox's container is not set up as Paddock sets up any other")
})

ev("C05", "Inner Docker's images are not in a template: a Docker sandbox made from one has the source's files, its own Docker, and none of the source's inner images", async () => {
  await ensureInner()
  const tmpInMemory = (await pdk(["exec", INNER, "--", "sh", "-c", 'echo inner > /root/inner-marker; echo tmp > /tmp/inner-marker; grep -q " /tmp tmpfs" /proc/mounts && echo tmp-in-memory'])).out.includes("tmp-in-memory")
  expect((await innerDocker(INNER, ["image", "inspect", "alpine:latest"])).code === 0, "control: the source's inner Docker has no alpine image")
  const saved = await pdkJson(["snapshot", INNER, "--as", TPLD], { timeoutMs: 600_000 })
  expect(saved.reply.ok, `snapshot of a Docker sandbox failed: ${saved.reply.error?.message}`)
  try {
    const made = await pdkJson(["create", TD, "--docker", "--template", TPLD, "--cpus", "1", "--memory", "1", "--disk", "4"], { timeoutMs: 600_000 })
    expect(made.reply.ok, `create --docker --template failed: ${made.reply.error?.message}`)
    expect((await pdk(["exec", TD, "--", "cat", "/root/inner-marker"])).out.includes("inner"), "a file from the Docker sandbox did not carry")
    const tmp = (await pdk(["exec", TD, "--", "cat", "/tmp/inner-marker"])).out.includes("tmp")
    expect(tmp === !tmpInMemory, `/tmp was ${tmpInMemory ? "in memory" : "on the layer"} in the source, yet it ${tmp ? "did" : "did not"} carry`)
    const image = await innerDocker(TD, ["image", "inspect", "alpine:latest"])
    expect(image.code !== 0 && /No such image/i.test(image.err), "an inner image of the source is in the template sandbox's Docker")
    expect(await dockerVolumeName(TD) !== await dockerVolumeName(INNER), "the template sandbox shares the source's Docker volume")
  } finally {
    await pdk(["remove", TD, "--confirm", TD])
    await pdk(["template", "remove", TPLD])
  }
  expect(!await imageExists(saved.reply.data.template.imageId), "a template that no sandbox used kept its image after removal")
  return `the inner image stayed with the source; /tmp was ${tmpInMemory ? "in memory and did not carry" : "on the layer and carried"}; the unused template's image was deleted with it`
})

ev("C06", "Templates are Paddock's own: names in its template space are refused as images, unknown and foreign templates are not found, a name in use is refused", async () => {
  if (!templateOwner) skip("C01 did not make a template, so this daemon's template space is unknown")
  const ours = `paddock-template-${templateOwner}:${PREFIX}-fake`; const theirs = `paddock-template-0000000000:${PREFIX}-other`
  await docker(["tag", "alpine:latest", ours]); await docker(["tag", "alpine:latest", theirs])
  try {
    const wrong: string[] = []
    for (const [argv, code] of [[["create", `${PREFIX}-x`, "--image", ours], 2], [["create", `${PREFIX}-x`, "--image", `paddock-snapshot-${templateOwner}:x`], 2],
      [["create", `${PREFIX}-x`, "--template", `${PREFIX}-fake`], 3], [["create", `${PREFIX}-x`, "--template", `${PREFIX}-other`], 3], [["create", `${PREFIX}-x`, "--template", "nope-nope"], 3],
      [["create", `${PREFIX}-x`, "--template", TPL, "--image", "alpine:latest"], 2], [["snapshot", TS, "--as", TPL], 4], [["snapshot", TS, "--as", "Bad"], 2], [["snapshot", `${PREFIX}-nope`, "--as", "x"], 3],
      [["template", "remove", `${PREFIX}-fake`], 3]] as Array<[string[], number]>) {
      const run = await pdk(argv); if (run.code !== code) wrong.push(`${argv.join(" ")} exited ${run.code}, expected ${code}`)
    }
    const names = ((await pdkJson(["template", "list"])).reply.data as Array<{ name: string }>).map((entry) => entry.name)
    if (names.some((name) => name.endsWith("-fake") || name.endsWith("-other"))) wrong.push(`template list shows images Paddock did not make: ${names.join(", ")}`)
    expect(wrong.length === 0, wrong.join("; "))
    expect(!await view(`${PREFIX}-x`), "a refused create left a sandbox")
  } finally { await docker(["rmi", ours, theirs]) }
  // An image given by its ID is not refused, so the checklist says whose it is.
  const template = await templateOf(TPL)
  const plain = await pdkJson(["create", `${PREFIX}-x`, "--image", template!.imageId])
  const check = plain.reply.data?.checks?.find((entry: { id: string }) => entry.id === "template")
  await pdk(["remove", `${PREFIX}-x`, "--confirm", `${PREFIX}-x`])
  expect(check?.detail.includes(`Paddock template ${TPL}'s`), `a template's image given by its ID is not disclosed: ${check?.detail ?? plain.reply.error?.message}`)
})

ev("C07", "Removing a template leaves the sandboxes made from it running and restartable; its image goes with the last of them, and a stopped sandbox can be saved", async () => {
  if (!await view(TC)) skip("C01 did not make a template sandbox")
  await ensure(TC)
  const template = await templateOf(TPL)
  expect(template?.dependants.includes(TC), `the template does not list ${TC} as using it`)
  const removed = await pdkJson(["template", "remove", TPL])
  expect(removed.reply.ok && removed.reply.data.dependants.includes(TC), `template remove: ${removed.reply.error?.message ?? JSON.stringify(removed.reply.data)}`)
  expect(!await templateOf(TPL), "the removed template is still listed")
  expect(await imageExists(template!.imageId), "the image was deleted while a sandbox used it")
  expect(await running(TC), "the dependant stopped")
  await socket("stop", { name: TC })
  expect((await socket("start", { name: TC })).reply.ok, "the dependant did not start again after its template was removed")
  const check = (await socket("verify", { name: TC })).reply.data.checks.find((entry: { id: string }) => entry.id === "template")
  expect(check.detail.includes("removed since"), `the template check does not say the template was removed: ${check.detail}`)
  await pdk(["remove", TC, "--confirm", TC])
  expect(!await imageExists(template!.imageId), "the removed template's image stayed after its last sandbox was removed")
  // A stopped source: saved without starting it.
  await socket("stop", { name: TS })
  const saved = await pdkJson(["snapshot", TS, "--as", TPL2], { timeoutMs: 600_000 })
  expect(saved.reply.ok && !await running(TS), `snapshot of a stopped sandbox: ${saved.reply.error?.message ?? "it was started"}`)
  await pdk(["template", "remove", TPL2]); await pdk(["remove", TS, "--confirm", TS])
  expect(!await imageExists(saved.reply.data.template.imageId), "a template no sandbox used kept its image after removal")
})

// M: a separately owned daemon on an explicitly named Linux machine. No host privileges or SSH files are changed.
const TEST_HOST = process.env.PADDOCK_EVAL_HOST
const MH = `${PREFIX}-host`; const MS = `${PREFIX}-machine`; const MC = `${PREFIX}-control`
let remoteDir = ""; let remoteReady = false
const word = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const remoteArgs = () => {
  expect(TEST_HOST && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(TEST_HOST), "PADDOCK_EVAL_HOST must be an SSH alias or user@hostname")
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=5", TEST_HOST!]
}
const remote = (argv: string[], options: Parameters<typeof sh>[1] = {}) => sh([...remoteArgs(), argv.map(word).join(" ")], options)
const remoteDocker = (argv: string[]) => remote(["docker", ...argv])
const remotePdk = (argv: string[]) => remote(["env", `PADDOCK_STATE_DIR=${remoteDir}/s`, `PADDOCK_CONFIG_DIR=${remoteDir}/c`, "PADDOCK_SOCKET_ONLY=1", `${remoteDir}/paddock`, ...argv])
const remoteInspect = async (name: string) => {
  const result = await remoteDocker(["inspect", containerOf(name)])
  return result.code === 0 ? JSON.parse(result.out)[0] : undefined
}
const remoteWrite = async (file: string, contents: string) => {
  const result = await remote(["sh", "-c", 'cat > "$1"; chmod 700 "$1"', "write", file], { stdin: contents })
  expect(result.code === 0, `could not write ${file} on the fixture: ${result.err}`)
}
async function machineFixture() {
  if (!TEST_HOST) skip("no PADDOCK_EVAL_HOST supplied; a disposable Linux SSH fixture is opt-in")
  if (remoteReady) return
  const arch = await remote(["uname", "-m"])
  expect(arch.code === 0, `SSH fixture unreachable: ${arch.err}`)
  expect(["x86_64", "aarch64"].includes(arch.out.trim()), `unsupported fixture architecture ${arch.out.trim()}`)
  const existing = await remoteDocker(["ps", "--filter", "label=dev.paddock.name", "--format", "{{.Names}}"])
  expect(existing.code === 0 && !existing.out.trim(), `the fixture has other Paddock sandboxes or Docker is unavailable: ${existing.out}${existing.err}`)
  const made = await remote(["sh", "-c", 'mktemp -d "$HOME/.pdk-machines-XXXXXX"'])
  remoteDir = made.out.trim()
  expect(made.code === 0 && /^\/home\/[A-Za-z0-9_.-]+\/\.pdk-machines-[A-Za-z0-9]+$/.test(remoteDir), "could not make a private fixture folder")
  const binary = join(tmp, "remote-paddock")
  const build = await sh([BUN, "build", "--compile", "--minify", `--target=bun-linux-${arch.out.trim() === "x86_64" ? "x64" : "arm64"}`, "--outfile", binary, "cli/cli.ts"], { cwd: ROOT })
  expect(build.code === 0, `remote build failed: ${build.err}`)
  const copy = Bun.spawn([...remoteArgs(), `umask 077; cat > ${word(`${remoteDir}/paddock`)}; chmod 700 ${word(`${remoteDir}/paddock`)}`], { stdin: Bun.file(binary), stdout: "pipe", stderr: "pipe" })
  const [copied, err] = await Promise.all([copy.exited, new Response(copy.stderr).text()])
  expect(copied === 0, `remote copy failed: ${err}`)
  const digest = new Bun.CryptoHasher("sha256").update(await readFile(binary)).digest("hex")
  expect((await remote(["sha256sum", `${remoteDir}/paddock`])).out.startsWith(`${digest} `), "remote artifact digest differs")
  const start = await remote(["sh", "-c", 'mkdir -m 700 "$1/c"; nohup env PADDOCK_STATE_DIR="$1/s" PADDOCK_CONFIG_DIR="$1/c" PADDOCK_SOCKET_ONLY=1 "$1/paddock" daemon run >"$1/daemon.log" 2>&1 </dev/null &', "fixture", remoteDir])
  expect(start.code === 0 && await until(async () => (await remote(["test", "-S", `${remoteDir}/s/daemon.sock`])).code === 0, 20), `remote daemon did not start: ${(await remote(["cat", `${remoteDir}/daemon.log`])).out}`)
  const attached = await pdkJson(["host", "attach", MH, "--ssh", TEST_HOST!, "--binary", `${remoteDir}/paddock`, "--state-dir", `${remoteDir}/s`])
  expect(attached.reply.ok, `attach failed: ${attached.out}${attached.err}`)
  remoteReady = true
}
const hosted = (argv: string[], options: Parameters<typeof sh>[1] = {}) => pdkJson(["--host", MH, ...argv], options)
async function remoteSandbox(name = MS) {
  await machineFixture()
  const state = await remoteInspect(name)
  if (!state) {
    const made = await hosted(["create", name, "--image", "alpine:latest", "--cpus", "1", "--memory", "1", "--disk", "1"])
    expect(made.reply.ok, `remote create failed: ${made.out}${made.err}`)
  } else if (!state.State.Running) expect((await hosted(["start", name])).reply.ok, "remote start failed")
}
// The registry entry of the run's host, changed for one measurement and always put back.
async function withRecord<T>(change: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const registry = join(env.PADDOCK_CONFIG_DIR, "hosts.json"); const original = await readFile(registry, "utf8")
  try {
    const data = JSON.parse(original); Object.assign(data.hosts.find((host: { name: string }) => host.name === MH), change)
    await writeFile(registry, JSON.stringify(data))
    return await run()
  } finally { await writeFile(registry, original) }
}
// What the fixture listens on (ss), and a listener of this run there: the positive control that ss and lsof see one.
const remoteListening = async () => {
  const run = await remote(["ss", "-ltnH"])
  expect(run.code === 0, `ss is needed on the fixture to see its listeners: ${run.err}`)
  return run.out.split("\n").map((line) => line.trim().split(/\s+/)[3]).filter((entry): entry is string => Boolean(entry)).sort()
}
async function remoteListener(): Promise<{ port: number; pid: number; close: () => Promise<void> }> {
  const code = "import os,socket,sys\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen()\nprint(s.getsockname()[1],os.getpid(),flush=True)\nsys.stdin.read()"
  const child = Bun.spawn([...remoteArgs(), ["python3", "-c", code].map(word).join(" ")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const reader = child.stdout.getReader(); let text = ""
  for (const end = Date.now() + 15_000; !text.includes("\n") && Date.now() < end;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value) }
  const [port, pid] = text.trim().split(/\s+/).map(Number)
  if (!port || !pid) { child.kill(); expect(false, `the fixture's listener control did not start (python3 is needed): ${text}${await new Response(child.stderr).text()}`) }
  return { port: port!, pid: pid!, close: async () => { child.kill(); await child.exited } }
}
// The fixture's relays for this run's daemon. [p] keeps pgrep's own command line from matching.
const remoteRelays = async () => {
  const run = await remote(["pgrep", "-fc", `${remoteDir}/[p]addock transport stdio`])
  expect(run.code === 0 || run.code === 1, `pgrep is needed on the fixture: ${run.err}`)
  return Number(run.out.trim())
}
// The remote daemon spoken to through its own transport, with bytes this run chooses. stdin stays open a moment so the
// reply arrives before the relay ends.
const rawArgv = (stream: boolean) => [...remoteArgs(), ["sh", "-c", `{ cat; sleep 2; } | env PADDOCK_STATE_DIR="$1/s" "$1/paddock" transport stdio --protocol 1${stream ? " --stream" : ""}`, "raw", remoteDir].map(word).join(" ")]
const rawTransport = (stdin: string) => sh(rawArgv(false), { stdin })
// Frames are bytes, so the stream's reply is read as bytes, not text.
const rawStream = async (open: Uint8Array) => {
  const child = Bun.spawn(rawArgv(true), { stdin: new Blob([open]), stdout: "pipe", stderr: "pipe", timeout: 30_000 })
  const [out] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited])
  return new FrameReader().push(Buffer.from(out))
}
const rawCall = async (method: string, body: object, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body)
  const run = await rawTransport(`POST /api/${method} HTTP/1.1\r\nHost: paddock\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${text}`)
  try { return JSON.parse(run.out.slice(run.out.indexOf("\r\n\r\n") + 4)) as { ok: boolean; data?: any; error?: { code: string; message: string } } } catch { throw new Error(`the raw transport returned no JSON: ${run.out.slice(0, 300)} ${run.err.slice(0, 300)}`) }
}

ev("M01", "Identical sandbox names on two machines have distinct identities and only the selected machine is mutated", async () => {
  await remoteSandbox(); await ensure(MS)
  const local = await inspect(MS); const target = await remoteInspect(MS)
  expect(local?.State.Running && target?.State.Running, "both running controls are required")
  expect(local.Config.Labels["dev.paddock.id"] !== target.Config.Labels["dev.paddock.id"], "sandbox identities collided")
  const primary = ((await pdkJson(["list"])).reply.data as Array<{ name: string; machineId: string }>).find((entry) => entry.name === MS)?.machineId
  const record = ((await pdkJson(["host", "list"])).reply.data as Array<{ host: { name: string; machineId: string } }>).find((entry) => entry.host.name === MH)?.host.machineId
  expect(primary && record && primary !== record, `the two machines' identities are missing or equal: ${primary} ${record}`)
  expect((await hosted(["stop", MS])).reply.ok && !(await remoteInspect(MS)).State.Running && await running(MS), "stop affected the wrong machine")
  expect((await hosted(["start", MS])).reply.ok, "remote start failed")
  const resized = await hosted(["resize", MS, "--memory", "2"])
  expect(resized.reply.ok && (await remoteInspect(MS)).HostConfig.Memory === 2 * 1024 ** 3 && (await inspect(MS)).HostConfig.Memory === 1024 ** 3, "resize affected the wrong engine")
  const verify = await hosted(["verify", MS])
  expect(verify.reply.ok && verify.reply.data.ok && verify.reply.data.sandbox.sandboxId === target.Config.Labels["dev.paddock.id"], `remote verification failed: ${verify.out}${verify.err}`)
  const who = await hosted(["exec", MS, "--", "sh", "-c", "uname -a; echo remote-only > /remote-only"])
  expect(who.reply.data?.exitCode === 0 && /gvisor/i.test(who.reply.data.stdout), "remote exec did not reach gVisor")
  expect((await pdk(["exec", MS, "--", "test", "-e", "/remote-only"])).code !== 0, "the remote file appeared locally")
  const template = `${PREFIX}-mtpl`
  const saved = await hosted(["snapshot", MS, "--as", template])
  expect(saved.reply.ok && (await hosted(["template", "list"])).reply.data.some((entry: { name: string }) => entry.name === template), "remote template was not listed")
  expect(!(await pdkJson(["template", "list"])).reply.data.some((entry: { name: string }) => entry.name === template), "remote template appeared locally")
  expect((await hosted(["template", "remove", template])).reply.ok, "remote template cleanup failed")
  const listed = (await hosted(["list"])).reply.data as Array<{ name: string; machineId: string }>
  expect(listed.some((entry) => entry.name === MS && entry.machineId === record), "the selected list did not carry the remote machine's identity")
  return `${TEST_HOST}; the primary is ${primary!.slice(0, 8)}…, the host ${record!.slice(0, 8)}…; stop/start, resize, exec, verify, snapshot and template list/remove selected only the remote engine; both copies of ${MS} existed`
})

ev("M02", "A host that is unreachable (missing binary, unroutable address) or silent is offline within its deadline, keeps its sandboxes unknown while local actions work; unknown hosts never fall back", async () => {
  await remoteSandbox(); await ensure(MS)
  expect((await pdkJson(["host", "list"])).reply.data.some((entry: { state: string }) => entry.state === "online"), "healthy SSH control failed")
  const offlineIn = async () => {
    const started = Date.now(); const listed = await pdkJson(["host", "list"]); const seconds = (Date.now() - started) / 1000
    const entry = listed.reply.data?.find((item: { host: { name: string } }) => item.host.name === MH)
    return { seconds, state: entry?.state as string, error: String(entry?.error ?? "") }
  }
  const notes: string[] = []
  await withRecord({ binary: `${remoteDir}/missing` }, async () => {
    const failed = await hosted(["stop", MS])
    expect(failed.code === 7 && failed.reply.error?.code === "offline" && (await remoteInspect(MS)).State.Running && await running(MS), "unreachable host was absent, passing or affected a sandbox")
    expect((await offlineIn()).state === "offline", "host list hid the failed machine")
    const fleet = (await pdkJson(["list", "--all"])).reply.data.machines.find((entry: { machine: { host: { name: string } } }) => entry.machine.host.name === MH)
    const cached = fleet?.cached?.sandboxes.find((entry: { name: string }) => entry.name === MS)
    expect(fleet?.stale && cached?.status === "unknown" && cached.lastVerify.results.every((check: { status: string }) => check.status === "unknown"), "cached green evidence survived the failed refresh")
    expect((await pdk(["exec", MS, "--", "true"])).code === 0, "failed host blocked a local action")
    const unknown = await pdkJson(["--host", "not-enrolled", "stop", MS])
    expect(unknown.code === 3 && await running(MS) && (await remoteInspect(MS)).State.Running, "unknown host fell back")
    notes.push("missing binary: stop exit 7, nothing stopped")
  })
  // TEST-NET-1 (RFC 5737) is routed nowhere: the SSH connect timeout (5 s) is what ends the attempt.
  const blackhole = await sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "192.0.2.1", "true"], { timeoutMs: 30_000 })
  expect(/timed out/i.test(blackhole.err), `control: 192.0.2.1 is not a blackhole from here (${blackhole.err.trim()}), so the connect timeout cannot be measured`)
  await withRecord({ ssh: "192.0.2.1" }, async () => {
    const result = await offlineIn()
    expect(result.state === "offline" && result.seconds < 12, `an unroutable host: ${result.state} after ${result.seconds} s (${result.error})`)
    notes.push(`unroutable address: offline after ${result.seconds.toFixed(1)} s (${result.error.slice(0, 80)})`)
  })
  // A daemon that never answers: the handshake's ten-second deadline ends the call.
  const silent = `${remoteDir}/silent-transport`
  // Not exec: the shell keeps the wrapper's name in the process list, so pgrep can see it while it runs and after.
  await remoteWrite(silent, "#!/bin/sh\ncat >/dev/null\n")
  const silentCount = async () => Number((await remote(["pgrep", "-fc", `${remoteDir}/[s]ilent-transport`])).out.trim())
  await withRecord({ binary: silent }, async () => {
    const pending = offlineIn()
    expect(await until(async () => await silentCount() >= 1, 8), "control: pgrep did not see the silent transport while the call waited")
    const result = await pending
    expect(result.state === "offline" && result.seconds >= 9 && result.seconds < 16 && /within 10 seconds/.test(result.error), `a silent daemon: ${result.state} after ${result.seconds} s (${result.error})`)
    notes.push(`silent daemon: offline after ${result.seconds.toFixed(1)} s`)
  })
  await pdk(["host", "list"])
  expect(await until(async () => await silentCount() === 0, 10), "the silent transport outlived its call on the fixture")
  return notes.join("; ")
})

// A gateway built from this source with one change; it replaces the run's primary daemon until the next pdk call.
async function otherGateway(name: string, change: (dir: string) => Promise<void>) {
  const next = join(tmp, name); await mkdir(next, { recursive: true })
  for (const part of ["core", "cli", "ui", "package.json"]) await cp(join(ROOT, part), join(next, part), { recursive: true })
  await change(next)
  const binary = join(next, "paddock")
  expect((await sh([BUN, "build", "--compile", "--outfile", binary, "cli/cli.ts"], { cwd: next })).code === 0, `could not build the ${name} gateway`)
  return binary
}
ev("M03", "A changed machine identity, daemon version or source build is refused before a remote mutation, by the primary, the remote daemon and its stream socket, beside working controls", async () => {
  await remoteSandbox()
  await withRecord({ machineId: "0".repeat(32) }, async () => {
    const changed = await hosted(["stop", MS])
    expect(changed.code === 9 && changed.reply.error?.code === "identity-changed" && (await remoteInspect(MS)).State.Running, "changed identity was accepted")
  })
  const older = await otherGateway("incompatible", async (dir) => {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")); await writeFile(join(dir, "package.json"), JSON.stringify({ ...pkg, version: `${pkg.version}-incompatible` }))
  })
  const same = await otherGateway("other-source", async (dir) => { await writeFile(join(dir, "core", "types.ts"), `${await readFile(join(dir, "core", "types.ts"), "utf8")}\n// another build of the same version\n`) })
  try {
    const bad = await sh([older, "--json", "--host", MH, "stop", MS], { env })
    expect(bad.code === 8 && JSON.parse(bad.out).error.code === "incompatible" && (await remoteInspect(MS)).State.Running, `version mismatch was accepted: ${bad.out}${bad.err}`)
    const other = await sh([same, "--json", "--host", MH, "stop", MS], { env })
    const message = JSON.parse(other.out).error?.message ?? ""
    expect(other.code === 8 && /other source/.test(message) && /bun build --compile/.test(message) && (await remoteInspect(MS)).State.Running, `a build of the same version from other source was accepted: ${other.out}${other.err}`)
  } finally { await pdk(["list"]) }
  expect((await hosted(["exec", MS, "--", "true"])).code === 0, "matching-version control failed")
  // The remote daemon's own check, with the gateway's headers as this run writes them.
  const hello = await rawCall("hello", {})
  expect(hello.ok && hello.data.machineId, `control: the raw transport did not reach the remote daemon: ${JSON.stringify(hello)}`)
  const headers = { "x-paddock-machine": hello.data.machineId, "x-paddock-protocol": "1", "x-paddock-version": hello.data.version, "x-paddock-build": hello.data.sourceDigest }
  expect((await rawCall("get", { name: MS }, headers)).ok, "control: the remote refused the gateway's own headers")
  const refusals: string[] = []
  for (const [header, value] of [["x-paddock-build", "0".repeat(64)], ["x-paddock-version", "0.0.0"], ["x-paddock-protocol", "2"]] as const) {
    const reply = await rawCall("stop", { name: MS }, { ...headers, [header]: value })
    if (reply.ok || reply.error?.code !== "incompatible") refusals.push(`${header} ${value}: ${JSON.stringify(reply).slice(0, 200)}`)
  }
  expect(refusals.length === 0 && (await remoteInspect(MS)).State.Running, `the remote daemon accepted a mismatched gateway: ${refusals.join("; ")}`)
  // The remote stream socket: an open naming another boot of the daemon is refused, the current one opens.
  const target = await rawCall("sessionTarget", { name: MS }, headers)
  const first = async (bootId: string) => (await rawStream(frame("open", { kind: "exec", name: MS, argv: ["true"], tty: false, machineId: hello.data.machineId, bootId, protocol: 1, version: hello.data.version, build: hello.data.sourceDigest, sandboxId: target.data.sandboxId, generation: target.data.generation })))[0]
  const good = await first(hello.data.bootId)
  expect(good?.kind === "ready", `control: a stream open with the current boot ID did not open: ${good?.kind}`)
  const stale = await first("0".repeat(32))
  expect(stale?.kind === "error" && JSON.parse(stale.payload.toString()).code === "identity-changed", `a stream open for another boot was accepted: ${stale?.kind} ${stale?.payload.toString()}`)
  return "the primary refused a changed identity (exit 9), another version and another source build of the same version (exit 8, saying how to update); the remote refused mismatched build, version and protocol headers and a stale boot ID on its stream socket; controls with the right values worked"
})

ev("M04", "Routing preserves the dashboard boundary, the remote daemon validates sandbox options itself, and it opens no TCP listener", async () => {
  await remoteSandbox()
  expect((await tcp("/api/list", { body: JSON.stringify({ host: MH }) })).status === 200, "control: routed dashboard list failed")
  for (const method of ["hello", "shutdown", "sshSetup", "sshPrepare", "sessionTarget", "hostAttach", "hostRemove", "hostPlan", "hostApply"]) expect((await tcp(`/api/${method}`, { body: JSON.stringify({ host: MH }) })).status === 403, `dashboard gained ${method} through SSH`)
  for (const method of ["attach", "session", "constructor", "__proto__"]) expect((await tcp(`/api/${method}`, { body: JSON.stringify({ host: MH }) })).status === 404, `arbitrary routed method ${method} was accepted`)
  // A tee in front of the remote transport records what the primary forwarded, so the refusal is shown to be the remote's.
  const log = `${remoteDir}/forwarded.log`; const tee = `${remoteDir}/tee-transport`
  await remoteWrite(tee, `#!/bin/sh\ncase "$*" in *--stream*) exec ${word(`${remoteDir}/paddock`)} "$@";; esac\ntee -a ${word(log)} | ${word(`${remoteDir}/paddock`)} "$@"\n`)
  const odd = `${PREFIX}-mval`; const plain = `${PREFIX}-mpriv`
  let note = ""
  await withRecord({ binary: tee }, async () => {
    const bad = await socket("create", { host: MH, name: odd, cpus: 1000, privileged: true, image: "alpine:latest" })
    const forwarded = (await remote(["cat", log])).out
    expect(/\/api\/create/.test(forwarded) && /"cpus":1000/.test(forwarded) && /"privileged":true/.test(forwarded), `the primary did not forward the request as sent: ${forwarded.slice(-400)}`)
    expect(bad.status === 400 && /cpu/i.test(bad.reply.error?.message ?? "") && !await remoteInspect(odd), `the remote daemon did not refuse 1000 CPUs itself: ${bad.status} ${JSON.stringify(bad.reply)}`)
    const made = await socket("create", { host: MH, name: plain, cpus: 1, memoryGb: 1, diskGb: 1, privileged: true, image: "alpine:latest" })
    try {
      const state = await remoteInspect(plain)
      expect(made.reply.ok && state && state.HostConfig.Privileged === false && state.HostConfig.Runtime !== "runc", `a forwarded privileged:true changed the remote sandbox: ${JSON.stringify(made.reply).slice(0, 200)}`)
    } finally { await socket("remove", { host: MH, name: plain, confirm: plain }) }
    note = `the remote refused cpus 1000 that the primary forwarded (${bad.reply.error?.message}); a forwarded privileged:true made an unprivileged gVisor sandbox`
  })
  const daemon = JSON.parse((await remote(["cat", `${remoteDir}/s/daemon.json`])).out)
  expect(daemon.port === 0, "remote daemon opened a dashboard port")
  if ((await remote(["sh", "-c", "command -v lsof"])).code !== 0) skip(`lsof is not on the fixture, so its listeners cannot be read; ${note}`)
  const control = await remoteListener()
  try {
    const seen = (await remote(["lsof", "-nP", "-a", "-p", String(control.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])).out
    expect(seen.includes(`n127.0.0.1:${control.port}`), `control: lsof did not show the fixture listener of this run: ${seen}`)
  } finally { await control.close() }
  const own = await remote(["lsof", "-nP", "-a", "-p", String(daemon.pid), "-iTCP", "-sTCP:LISTEN", "-Fn"])
  expect(own.out.split("\n").filter((line) => line.startsWith("n")).length === 0, `remote daemon has a TCP listener: ${own.out}`)
  return `the 403s came from the primary's socket-only check before SSH; ${note}; lsof saw a control listener and none for the remote daemon`
})

ev("M05", "With the primary stopped, the remote daemon stops a weakened sandbox and keeps an untampered control running", async () => {
  await remoteSandbox(); await remoteSandbox(MC)
  expect((await pdk(["daemon", "stop"])).code === 0, "could not stop the primary")
  try {
    expect((await remoteDocker(["network", "connect", "bridge", containerOf(MS)])).code === 0, "could not tamper with the disposable remote sandbox")
    expect(await until(async () => !(await remoteInspect(MS)).State.Running, 65), "remote enforcement depended on the primary")
    expect((await remoteInspect(MC)).State.Running, "untampered control stopped")
    const listed = await remotePdk(["--json", "list"])
    expect(/network/i.test(JSON.parse(listed.out).data.find((entry: { name: string }) => entry.name === MS).stopReason), "remote daemon did not report its own stop reason")
  } finally { await remoteDocker(["network", "disconnect", "bridge", containerOf(MS)]); await pdk(["list"]) }
  return "remote network tamper stopped within 65 s while the primary was absent; an untampered remote control kept running"
})

ev("M06", "Hosted streams carry binary stdin/stdout, separate stderr, EOF and exit status, and a remote shell receives terminal size and resize", async () => {
  await remoteSandbox()
  const file = join(tmp, "remote-stream.bin"); const bytes = new Uint8Array(8 * 1048576)
  for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536))
  await writeFile(file, bytes)
  const want = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  try {
    const run = await streamed(["--host", MH, "exec", MS, "--stream", "--", "sh", "-c", "cat; echo remote-stderr >&2; exit 5"], { input: file })
    expect(run.code === 5 && run.bytes === bytes.length && run.sha === want && run.err === "remote-stderr\n", `hosted stream changed data/status: ${run.code}, ${run.bytes}, ${run.err}`)
    const terminal = await onTerminal(["--host", MH, "shell", MS], [["size", 30, 100], ["type", "stty size; echo m-$((1))\r"], ["wait", "m-1"], ["size", 40, 120], ["pause", 1], ["type", "stty size; exit 7\r"], ["wait", "code="]])
    const shown = terminal.out.replace(/\r/g, "")
    expect(/\n30 100\n/.test(shown) && /\n40 120\n/.test(shown) && shown.includes("code=7") && restored(shown.slice(shown.indexOf("code=7"))), `remote terminal failed: ${shown.slice(-500)} ${terminal.err}`)
  } finally { await rm(file, { force: true }) }
  return "8 MiB random echo matched SHA-256, separate stderr, exit 5 after EOF; remote TTY 30x100 then 40x120, exit 7 and restored terminal"
})

async function hostedForward(port: number) {
  const made = await hosted(["forward", "add", MS, "--port", String(port)])
  expect(made.reply.ok, `remote forward failed: ${made.out}${made.err}`)
  return made.reply.data as { id: string; localPort: number }
}
const hostedNonce = (port: number, nonce: string) => hosted(["exec", MS, "--", "sh", "-c", `(nc -lk -s 127.0.0.1 -p ${port} -e echo ${nonce} </dev/null >/dev/null 2>&1 &)`])
ev("M07", "A hosted forward binds only primary loopback, reaches remote sandbox loopback, publishes no engine port and creates no listener on the remote host", async () => {
  await remoteSandbox()
  const port = 3123; const nonce = `${PREFIX}-remote-nonce`
  expect((await hostedNonce(port, nonce)).code === 0, "remote nonce service failed")
  expect((await remoteDocker(["exec", containerOf(MS), "nc", "-w", "2", "127.0.0.1", String(port)])).out.includes(nonce), "independent guest control failed")
  const listenControl = await remoteListener()
  try { expect((await remoteListening()).includes(`127.0.0.1:${listenControl.port}`), "control: ss did not show the fixture listener of this run") } finally { await listenControl.close() }
  const before = await remoteListening(); const forward = await hostedForward(port)
  try {
    expect((await tcpRead("127.0.0.1", forward.localPort)).toString().includes(nonce), "primary loopback did not reach remote sandbox loopback")
    const after = await remoteListening()
    expect(after.join() === before.join(), `forward added a listener on the remote host: ${after.filter((entry) => !before.includes(entry)).join(", ")}`)
    const owner = await daemonFile()
    expect((await listenersOf([owner.pid])).includes(`n127.0.0.1:${forward.localPort}`), "the primary daemon did not own its loopback listener")
    const control = await controlListener("0.0.0.0"); let tried = 0
    try {
      for (const address of Object.values(networkInterfaces()).flat().filter((entry) => entry && entry.family === "IPv4" && !entry.internal).map((entry) => entry!.address)) {
        if (!(await tcpRead(address, control.port, "", 2)).toString().includes(REPLY)) continue
        tried++; expect(!(await tcpRead(address, forward.localPort, "", 2)).toString().includes(nonce), "hosted forward answered off loopback")
      }
      expect(tried > 0, "no non-loopback positive control was available")
    } finally { control.close() }
    const data = await remoteInspect(MS)
    expect(!data.HostConfig.PublishAllPorts && Object.keys(data.HostConfig.PortBindings ?? {}).length === 0, "remote engine published a port")
    const checks = (await hosted(["verify", MS])).reply.data.checks
    expect(/SSH lease/.test(checks.find((check: { id: string }) => check.id === "forwards").detail), "remote verification hid its relay lease")
    return `the nonce came through 127.0.0.1:${forward.localPort}; ss on the fixture saw a control listener and the same ${before.length} listeners before and after; ${tried} non-loopback address(es) refused; no engine port; remote verify showed the lease`
  } finally { await hosted(["forward", "remove", forward.id]) }
})

const sshStreamPids = async () => {
  const daemon = (await daemonFile()).pid
  return (await sh(["ps", "-axo", "pid=,ppid=,command="])).out.split("\n").filter((line) => Number(line.trim().split(/\s+/)[1]) === daemon && line.includes(remoteDir) && line.includes("--stream")).map((line) => Number(line.trim().split(/\s+/)[0]))
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
// shutdown with keepSandboxes, posted to the remote daemon's own socket: the daemon exits, its sandboxes do not.
const KEEP = "import socket,sys\ns=socket.socket(socket.AF_UNIX)\ns.connect(sys.argv[1])\nb=b'{\"keepSandboxes\":true}'\ns.sendall(b'POST /api/shutdown HTTP/1.1\\r\\nHost: paddock\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\nConnection: close\\r\\n\\r\\n' % len(b) + b)\nprint(s.recv(4096).decode())"
ev("M08", "Hosted forwards end on stop, run replacement, daemon exit (sandbox kept) and SSH loss, leaving no relay on the remote; each side ends a lease the other stops renewing within seventeen seconds", async () => {
  await remoteSandbox()
  const one = async (act: () => Promise<unknown>) => {
    await remotePdk(["list"]); await remoteSandbox()
    const forward = await hostedForward(3123)
    expect(!await refused(forward.localPort), "forward listener control failed")
    await act()
    expect(await until(() => refused(forward.localPort), 17), "hosted listener survived its ending condition")
    return forward
  }
  const noRelays = async (when: string) => expect(await until(async () => await remoteRelays() === 0, 10), `a transport stdio relay stayed on the fixture after ${when}`)
  const notes: string[] = []
  await one(() => hosted(["stop", MS]))
  await one(() => remoteDocker(["restart", "-t", "1", containerOf(MS)]))
  // An engine restart behind Paddock's back leaves the guest with the engine's resolver; a Paddock start puts it back.
  await hosted(["stop", MS]); await remoteSandbox()
  await one(async () => {
    const said = await remote(["python3", "-c", KEEP, `${remoteDir}/s/daemon.sock`])
    expect(/"stopping":true/.test(said.out), `the remote daemon did not accept shutdown: ${said.out}${said.err}`)
  })
  expect((await remoteInspect(MS)).State.Running, "the remote daemon's exit with keepSandboxes stopped the sandbox")
  await noRelays("the remote daemon exited")
  notes.push("stop, run replacement and remote daemon exit (sandbox still running) closed the listener")
  await remotePdk(["list"]); await remoteSandbox()
  // Positive control for the relay count: one forward is one relay on the fixture.
  const control = await hostedForward(3123)
  expect(await remoteRelays() === 1, `control: one forward did not show as one relay (${await remoteRelays()})`)
  const before = new Set(await sshStreamPids())
  let link = 0
  const lost = await hostedForward(3123)
  try {
    const pids = (await sshStreamPids()).filter((pid) => !before.has(pid)); expect(pids.length === 1, `expected one new SSH control stream, saw ${pids}`); link = pids[0]!
    process.kill(link, "SIGSTOP"); const stoppedAt = Date.now()
    expect(await until(() => refused(lost.localPort), 17), "silent SSH control survived 17 seconds")
    notes.push(`a stopped control link closed its listener after ${((Date.now() - stoppedAt) / 1000).toFixed(0)} s`)
    expect(!await refused(control.localPort), "healthy control forward ended")
    expect(await until(async () => !alive(link), 5), "the primary left its stopped ssh process running")
    link = 0
    expect(await refused(lost.localPort), "SSH recovery recreated the old listener")
  } finally { if (link) { try { process.kill(link, "SIGCONT"); process.kill(link, "SIGKILL") } catch {} }; await hosted(["forward", "remove", control.id]) }
  await noRelays("the stopped link and the removed control")
  const killedBefore = new Set(await sshStreamPids()); const killed = await hostedForward(3123)
  const pid = (await sshStreamPids()).find((pid) => !killedBefore.has(pid)); expect(pid, "no SSH process to kill"); process.kill(pid!, "SIGKILL")
  expect(await until(() => refused(killed.localPort), 10), "killed SSH link retained listener")
  await noRelays("a killed SSH link")
  // A partition: the primary daemon stopped (SIGSTOP), so it neither renews nor closes; its SSH links stay up.
  const parted = await hostedForward(3123)
  expect(await remoteRelays() === 1, "control: the forward's relay is not on the fixture")
  const primary = (await daemonFile()).pid
  process.kill(primary, "SIGSTOP"); const partedAt = Date.now(); let partedFor = 0
  try {
    expect(await until(async () => await remoteRelays() === 0, 30), "the remote kept the lease of a primary that stopped renewing it for 30 s")
    partedFor = (Date.now() - partedAt) / 1000
  } finally { process.kill(primary, "SIGCONT") }
  expect(partedFor <= 20, `the remote ended the lease after ${partedFor} s, past fifteen seconds plus its two-second check and polling`)
  expect(await until(() => refused(parted.localPort), 5), "the primary kept the listener of a lease the remote ended")
  notes.push(`with the primary stopped, the remote ended the lease and its relay exited after ${partedFor.toFixed(0)} s`)
  await one(() => pdk(["daemon", "stop"]))
  await noRelays("the primary exited")
  await remotePdk(["list"]); await remoteSandbox()
  return `${notes.join("; ")}; killed SSH and primary exit closed listeners; no relay was left on the fixture after any of them; a healthy control stayed open; nothing was recreated`
})

ev("M09", "A remote SSH alias uses the primary editor key and pinned machine/sandbox identity without host listeners on either machine; stopped and recreated sandboxes refuse it", async () => {
  await remoteSandbox()
  const setup = await hosted(["ssh", "setup", MS, "--write-config"], { timeoutMs: 300_000 })
  expect(setup.reply.ok && setup.reply.data.alias === `${MS}.${MH}.paddock`, `hosted SSH setup failed: ${setup.out}${setup.err}`)
  const target = setup.reply.data.alias
  const oldConfig = join(tmp, "m09-old-config")
  await writeFile(oldConfig, await readFile(join(env.PADDOCK_STATE_DIR, "ssh", "config")))
  // Listeners on both machines while a session is open, each beside a listener of this run that they must show.
  const localListening = async () => (await sh(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"])).out.split("\n").filter((line) => line.startsWith("n")).sort()
  const localBefore = await localListening(); const remoteBefore = await remoteListening()
  const session = Bun.spawn(["ssh", ...sshArgs(), target, "echo up; sleep 8"], { stdout: "pipe", stderr: "pipe" })
  const localControl = await controlListener("127.0.0.1"); const remoteControl = await remoteListener()
  let localAdded: string[] = []; let remoteAdded: string[] = []
  try {
    const reader = session.stdout.getReader(); let said = ""
    for (const end = Date.now() + 30_000; !said.includes("up") && Date.now() < end;) { const { value, done } = await reader.read(); if (done) break; said += new TextDecoder().decode(value) }
    expect(said.includes("up"), `control: the SSH session did not open: ${await new Response(session.stderr).text()}`)
    const localDuring = await localListening(); const remoteDuring = await remoteListening()
    expect(localDuring.includes(`n127.0.0.1:${localControl.port}`), "control: lsof did not show this run's local listener")
    expect(remoteDuring.includes(`127.0.0.1:${remoteControl.port}`), "control: ss did not show this run's fixture listener")
    localAdded = localDuring.filter((entry) => !localBefore.includes(entry) && entry !== `n127.0.0.1:${localControl.port}`)
    remoteAdded = remoteDuring.filter((entry) => !remoteBefore.includes(entry) && entry !== `127.0.0.1:${remoteControl.port}`)
  } finally { localControl.close(); await remoteControl.close(); session.kill(); await session.exited }
  expect(localAdded.length === 0 && remoteAdded.length === 0, `an open session added listeners: here ${localAdded.join(", ") || "none"}, on the fixture ${remoteAdded.join(", ") || "none"}`)
  const run = await sh(["ssh", ...sshArgs(), target, "id -un; echo $HOME"])
  expect(run.code === 0 && run.out === `${setup.reply.data.user}\n${setup.reply.data.home}\n`, `remote SSH failed: ${run.out}${run.err}`)
  const remoteFiles = await remote(["sh", "-c", 'test ! -e "$1/s/ssh/editor_ed25519" && test ! -e "$1/s/ssh/config"', "check", remoteDir])
  expect(remoteFiles.code === 0, "an editor private key or client SSH config was created remotely")
  const marker = join(tmp, "m09.bin"); await writeFile(marker, crypto.getRandomValues(new Uint8Array(65536)))
  const transfer = await sh(["sftp", "-q", ...sshArgs(), "-b", "-", target], { stdin: `put ${marker} /tmp/m09.bin\nget /tmp/m09.bin ${marker}.back\n` })
  expect(transfer.code === 0 && Buffer.compare(await readFile(marker), await readFile(`${marker}.back`)) === 0, `remote SFTP changed bytes: ${transfer.err}`)
  await hosted(["stop", MS])
  const stopped = await sh(["ssh", ...sshArgs(), target, "true"])
  expect(stopped.code === 255 && /not running/.test(stopped.err) && !(await remoteInspect(MS)).State.Running, "remote SSH restarted a stopped sandbox")
  await hosted(["remove", MS, "--confirm", MS]); await remoteSandbox()
  const recreated = await sh(["ssh", ...sshArgs(oldConfig), target, "true"])
  expect(recreated.code === 255 && /recreated/.test(recreated.err) && (await remoteInspect(MS)).State.Running, `old alias was not refused by sandbox identity: ${recreated.err}`)
  return "login and 64 KiB SFTP round trip through the alias; with a session open, lsof here and ss on the fixture each showed this run's control listener and no new one; no editor key on the fixture; stopped and recreated sandboxes refused"
})

ev("M10", "Malformed, oversized and out-of-order remote stream frames and malformed or oversized remote replies are refused without crashing the primary, beside valid controls", async () => {
  await remoteSandbox()
  if ((await remote(["python3", "--version"])).code !== 0) skip("python3 is needed only for the hostile remote byte fixture")
  const wrapper = `${remoteDir}/hostile-transport`; const script = `${remoteDir}/hostile.py`; const relay = `${remoteDir}/relay.py`
  const daemon = (await daemonFile()).pid
  const primaryHolds = async (what: string) => expect((await daemonFile()).pid === daemon && (await pdk(["list"])).code === 0, `${what} crashed or replaced the primary`)
  const head = (kind: number, size: number) => { const out = Buffer.alloc(5); out[0] = kind; out.writeUInt32BE(size, 1); return out }
  const ready = frame("ready", { tty: false })
  const streams: Array<[string, Buffer, RegExp]> = [
    ["exit {", Buffer.concat([ready, frame("exit", "{")]), /Malformed remote/],
    ["error {", Buffer.concat([ready, frame("error", "{")]), /Malformed remote/],
    ["exit 1e20", Buffer.concat([ready, frame("exit", '{"code":100000000000000000000}')]), /Malformed remote/],
    ["a 65,000-character error", Buffer.concat([ready, frame("error", { code: "runtime", message: `${"A".repeat(65_000)}` })]), /^paddock: A{100}/],
    ["a 4 GiB length header", Buffer.concat([ready, head(4, 0xffffffff)]), /Malformed remote|at most 65536/],
    ["kind byte 200", Buffer.concat([ready, head(200, 0)]), /Malformed remote|Not a paddock-stream/],
    ["stdout before ready", Buffer.concat([frame("stdout", "early"), ready]), /did not send ready/],
  ]
  const results: string[] = []
  await remoteWrite(wrapper, `#!/bin/sh\ncase "$*" in *--stream*) exec python3 ${word(script)};; *) exec ${word(`${remoteDir}/paddock`)} "$@";; esac\n`)
  await withRecord({ binary: wrapper }, async () => {
    for (const [what, bytes, pattern] of streams) {
      await remoteWrite(script, `import sys,struct\nh=sys.stdin.buffer.read(5)\nn=struct.unpack('!I',h[1:])[0]\nsys.stdin.buffer.read(n)\nsys.stdout.buffer.write(bytes.fromhex('${bytes.toString("hex")}'))\nsys.stdout.buffer.flush()\nsys.stdin.buffer.read()\n`)
      const started = Date.now(); const result = await pdk(["--host", MH, "exec", MS, "--stream", "--", "true"], { timeoutMs: 30_000 })
      expect(result.code !== 0 && result.code !== 124 && pattern.test(result.err) && result.err.length < 4200, `${what} was not refused cleanly: exit ${result.code}, ${result.err.length} bytes: ${result.err.slice(0, 200)}`)
      await primaryHolds(what)
      results.push(`${what}: exit ${result.code} in ${((Date.now() - started) / 1000).toFixed(1)} s`)
    }
  })
  // Replies: a relay answers the handshake from the real daemon and then the hostile reply itself.
  await remoteWrite(relay, `import socket,sys
mode,path=sys.argv[1],sys.argv[2]
inp,out=sys.stdin.buffer,sys.stdout.buffer
def request():
  head=b''
  while b'\\r\\n\\r\\n' not in head:
    c=inp.read(1)
    if not c: return None
    head+=c
  size=int(([l.split(b':')[1] for l in head.split(b'\\r\\n') if l.lower().startswith(b'content-length:')] or [b'0'])[0])
  return head+inp.read(size)
while True:
  raw=request()
  if raw is None: break
  if raw.split(b' ')[1]==b'/api/hello':
    s=socket.socket(socket.AF_UNIX); s.connect(path); s.sendall(raw); got=b''
    while b'\\r\\n\\r\\n' not in got: got+=s.recv(65536)
    head,_,body=got.partition(b'\\r\\n\\r\\n')
    size=int([l.split(b':')[1] for l in head.split(b'\\r\\n') if l.lower().startswith(b'content-length:')][0])
    while len(body)<size: body+=s.recv(65536)
    s.close(); out.write(head+b'\\r\\n\\r\\n'+body); out.flush(); continue
  body={'shape':b'{"ok":true,"data":[{"name":1}]}','json':b'{not json','big':b'{"ok":true,"data":"'+b'x'*(9*1024*1024)+b'"}'}[mode]
  out.write(b'HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\n\\r\\n' % len(body)+body); out.flush()
`)
  for (const mode of ["shape", "json", "big"]) {
    await remoteWrite(wrapper, `#!/bin/sh\ncase "$*" in *--stream*) exec ${word(`${remoteDir}/paddock`)} "$@";; *) exec python3 ${word(relay)} ${mode} ${word(`${remoteDir}/s/daemon.sock`)};; esac\n`)
    await withRecord({ binary: wrapper }, async () => {
      const read = await pdkJson(["--host", MH, "template", "list"], { timeoutMs: 60_000 })
      expect(read.code === 8 && read.reply.error?.code === "incompatible", `a ${mode} reply to a read was not refused as incompatible: exit ${read.code} ${read.out.slice(0, 200)}`)
      const write = await pdkJson(["--host", MH, "stop", MS], { timeoutMs: 60_000 })
      expect(write.code === 10 && write.reply.error?.code === "outcome-unknown", `a ${mode} reply to a mutation was not outcome-unknown: exit ${write.code} ${write.out.slice(0, 200)}`)
      if (mode === "big") expect(/8 MiB/.test(read.reply.error!.message) && /8 MiB/.test(write.reply.error!.message), `the oversized replies did not say so: ${read.reply.error?.message} / ${write.reply.error?.message}`)
      await primaryHolds(`a ${mode} reply`)
      results.push(`${mode} reply: read exit 8, mutation exit 10`)
    })
  }
  const control = await pdk(["--host", MH, "exec", MS, "--stream", "--", "echo", "valid-stream"])
  expect(control.code === 0 && control.out === "valid-stream\n", "valid hosted stream control failed")
  expect((await hosted(["template", "list"])).code === 0, "valid buffered control failed")
  return `${results.join("; ")}; the same primary answered after each; valid stream and buffered controls worked`
})

ev("M11", "Stopping the primary while one of its SSH links is stopped (SIGSTOP) ends within seconds and still stops the local sandboxes whose disk limit it watches", async () => {
  await remoteSandbox(); await ensure(MS)
  const watched = engine!.capabilities?.diskLimit === "watched"
  expect(await running(MS), "control: the local sandbox is not running")
  const before = new Set(await sshStreamPids()); await hostedForward(3123)
  const link = (await sshStreamPids()).find((pid) => !before.has(pid)); expect(link, "no SSH link to stop")
  const primary = (await daemonFile()).pid
  process.kill(link!, "SIGSTOP")
  let seconds = 0
  try {
    const started = Date.now(); const stop = await pdk(["daemon", "stop"], { timeoutMs: 60_000 })
    expect(stop.code === 0 && await until(async () => !alive(primary), 15), `daemon stop did not end the primary with a stopped SSH link: exit ${stop.code} ${stop.err}`)
    seconds = (Date.now() - started) / 1000
    expect(seconds <= 10, `the primary took ${seconds} s to stop`)
    expect(!alive(link!), "the stopped ssh process outlived the primary")
    if (watched) expect(!await running(MS), "a local sandbox whose disk limit only the daemon watches kept running unwatched")
  } finally { if (alive(link!)) { try { process.kill(link!, "SIGCONT"); process.kill(link!, "SIGKILL") } catch {} }; await pdk(["list"]) }
  await noRelaysLeft()
  return `the primary stopped in ${seconds.toFixed(1)} s and killed the stopped ssh; ${watched ? "the local watched sandbox was stopped" : "this engine's disk limit is not watched, so no local sandbox had to stop"}; no relay was left on the fixture`
})
const noRelaysLeft = async () => expect(await until(async () => await remoteRelays() === 0, 10), "a transport stdio relay stayed on the fixture")

// N: host enrollment. Root installation is allowed only on an explicitly disposable OrbStack machine, never the M fixture.
const ENROLL_HOST = process.env.PADDOCK_EVAL_ENROLL_HOST
const DISPOSABLE = /^pdk-enroll-[a-z0-9-]+@orb$/
const NH = `${PREFIX}-enroll`
const RUNTIME_DIR = `/opt/paddock/gvisor/${GVISOR_RELEASE}`
let enrollmentArtifact = ""; let enrollmentDigest = ""; let enrollmentPlan: HostPlan | undefined
const disposable = (destination: string, argv: string[], options: Parameters<typeof sh>[1] = {}) =>
  sh(["ssh", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", destination, argv.map(word).join(" ")], options)
const enrollRemote = (argv: string[], options: Parameters<typeof sh>[1] = {}) => {
  if (!ENROLL_HOST || !DISPOSABLE.test(ENROLL_HOST)) skip("PADDOCK_EVAL_ENROLL_HOST must explicitly name a disposable pdk-enroll-*@orb machine; home-linux is never an installer fixture")
  return disposable(ENROLL_HOST!, argv, options)
}
// Every path an enrollment writes, with owner, mode, modification time and content hash, and any staging it left.
const enrollmentSnapshotScript = `
import glob, hashlib, json, os, stat

roots = ['/etc/docker/daemon.json', '/usr/local/bin/paddock', '/etc/systemd/system', '/opt/paddock', '/var/lib/paddock',
         os.path.expanduser('~/.docker'), os.path.expanduser('~/.config/paddock'), os.path.expanduser('~/.local/state/paddock')]
result = {'staging': sorted(glob.glob('/tmp/paddock-enroll-*'))}
for root in roots:
    paths = [root]
    if os.path.isdir(root):
        paths += [os.path.join(folder, name) for folder, _, names in os.walk(root) for name in sorted(names)]
    for path in paths:
        try:
            s = os.lstat(path)
            content = None
            if stat.S_ISLNK(s.st_mode):
                content = os.readlink(path)
            elif stat.S_ISREG(s.st_mode):
                h = hashlib.sha256()
                with open(path, 'rb') as f:
                    for chunk in iter(lambda: f.read(1048576), b''):
                        h.update(chunk)
                content = h.hexdigest()
            result[path] = [s.st_uid, s.st_gid, s.st_mode, s.st_mtime_ns, content]
        except FileNotFoundError:
            result[path] = None
        except PermissionError:
            result[path] = 'unreadable'
print(json.dumps(result, sort_keys=True))
`
const enrollSnapshot = async () => {
  const snapshot = await enrollRemote(["python3", "-c", enrollmentSnapshotScript])
  expect(snapshot.code === 0, `the fixture snapshot failed: ${snapshot.err}`)
  return snapshot.out
}
// A Linux build of this tree and its digest. Without minify the same source gives other bytes.
async function linuxBuild(arch: string, name: string, minify = true) {
  expect(["aarch64", "x86_64"].includes(arch), `unsupported fixture architecture ${arch}`)
  const artifact = join(tmp, name)
  const build = await sh([BUN, "build", "--compile", ...(minify ? ["--minify"] : []), `--target=bun-linux-${arch === "aarch64" ? "arm64" : "x64"}`, "--outfile", artifact, "cli/cli.ts"], { cwd: ROOT, timeoutMs: 300_000 })
  expect(build.code === 0, `the Linux build failed: ${build.err}`)
  return { artifact, digest: new Bun.CryptoHasher("sha256").update(await readFile(artifact)).digest("hex") }
}
async function enrollmentFixture() {
  if (enrollmentArtifact) return
  const arch = await enrollRemote(["uname", "-m"])
  expect(arch.code === 0, `enrollment fixture unreachable: ${arch.err}`)
  const built = await linuxBuild(arch.out.trim(), "enrollment-paddock")
  enrollmentArtifact = built.artifact; enrollmentDigest = built.digest
}
const enrollArgs = (extra: string[] = []) => ["host", "add", NH, "--ssh", ENROLL_HOST!, "--artifact", enrollmentArtifact, "--sha256", enrollmentDigest, ...extra]
const planned = async (extra: string[] = []): Promise<HostPlan> => {
  const plan = await pdkJson(enrollArgs(extra))
  expect(plan.code === 0 && plan.reply.ok, `plan failed: ${plan.out} ${plan.err}`)
  return plan.reply.data
}
const enrolledHost = async (name = NH): Promise<HostView | undefined> => ((await pdkJson(["host", "list"])).reply.data as HostView[]).find((view) => view.host.name === name)
const unregistered = async () => expect(!await enrolledHost(), "a refused or failed enrollment registered its host")
const forget = (name = NH) => pdk(["host", "remove", name, "--confirm", name])
// The engine an enrolled host's daemon would use: its runtime, and whether it offers Docker inside a sandbox.
const enrolledEngine = async () => {
  const engines = await pdkJson(["--host", NH, "doctor"])
  return (engines.reply.data as Array<{ id: string; data: { runtime: string }; capabilities?: { docker: boolean } }> | undefined)?.find((engine) => engine.id === "gvisor:default")
}
const checkPassed = (checks: Array<{ id: string; status: string }>, id: string) => checks.some((check) => check.id === id && check.status === "pass")
const enrollService = async () => `paddock@${(await enrollRemote(["id", "-u"])).out.trim()}.service`
const enrollConfig = async (text: string) => expect((await enrollRemote(["sudo", "-n", "tee", "/etc/docker/daemon.json"], { stdin: text })).code === 0, "could not write the fixture's Docker configuration")
const dockerStarted = async () => (await enrollRemote(["systemctl", "show", "docker.service", "--property=MainPID,ExecMainStartTimestamp"])).out
// The fixture daemon's own CLI, as its owner would run it there.
const enrollOwner = (plan: HostPlan, argv: string[]) => enrollRemote(["env", `PADDOCK_STATE_DIR=${plan.stateDir}`, `PADDOCK_CONFIG_DIR=${plan.stateDir}/config`, plan.binary, ...argv], { timeoutMs: 300_000 })
// A stand-in for ssh, first on the daemon's PATH. It sees every SSH command Paddock runs and hands the others on.
async function sshWrapper(name: string, body: string): Promise<Record<string, string>> {
  const folder = join(tmp, name); await mkdir(folder)
  const real = (await sh(["which", "ssh"])).out.trim()
  expect(real.startsWith("/"), "the ssh executable is not an absolute path")
  await writeFile(join(folder, "ssh"), `#!/usr/bin/env python3\nimport base64, http.client, json, os, signal, subprocess, sys\n\nreal = ${JSON.stringify(real)}\n${body}`, { mode: 0o700 })
  // The daemon keeps the PATH it started with.
  await pdk(["daemon", "stop"])
  return { PATH: `${folder}:${process.env.PATH}` }
}
const realSsh = async () => { await pdk(["daemon", "stop"]); await pdk(["list"]) }

ev("N01", "A read-only host plan against the routing fixture preserves system files, services, installation paths and the running engine, and reports actual Docker restart victims", async () => {
  if (!TEST_HOST) skip("no PADDOCK_EVAL_HOST supplied for read-only planning")
  const arch = await remote(["uname", "-m"])
  expect(arch.code === 0, `SSH fixture unreachable: ${arch.err}`)
  const { artifact, digest } = await linuxBuild(arch.out.trim(), "read-only-enrollment-paddock")
  const name = `${PREFIX}-readonly`
  // Docker's own process, each running container's start and the images held: what an installation would disturb.
  const engine = async () => {
    const state = await remote(["sh", "-c", 'systemctl show docker.service --property=MainPID,ExecMainStartTimestamp; docker images -q --no-trunc | sort; echo containers; docker ps -q --no-trunc | xargs -r docker inspect --format "{{.Id}} {{.State.StartedAt}}"'])
    expect(state.code === 0, `could not read the engine's state: ${state.err}`)
    const [fixed, containers] = state.out.split("containers\n")
    return { fixed, containers: containers!.split("\n").filter(Boolean) }
  }
  const before = await remote(["python3", "-c", enrollmentSnapshotScript]); const engineBefore = await engine()
  expect(before.code === 0, before.err)
  const containers = await remoteDocker(["ps", "--no-trunc", "--format", "{{json .}}"])
  expect(containers.code === 0, containers.err)
  const result = await pdkJson(["host", "add", name, "--ssh", TEST_HOST!, "--artifact", artifact, "--sha256", digest, "--accept-plan", "0".repeat(64)])
  expect(result.code === 0 && result.reply.ok, `--json with an accepted hash did not stay a plan: ${result.out}`)
  const plan: HostPlan = result.reply.data
  for (const row of containers.out.split("\n").filter(Boolean).map((line) => JSON.parse(line))) expect(plan.restart.containers.includes(`${row.Names} (${row.ID})`), `the plan omitted ${row.Names}`)
  // The same plan as a person reads it: without a terminal it is shown and not applied.
  const text = await pdk(["host", "add", name, "--ssh", TEST_HOST!, "--artifact", artifact, "--sha256", digest])
  expect(text.code === 2 && text.out.includes(`Plan hash: ${plan.hash}`), `the plan as text differed or was applied: exit ${text.code} ${text.err}`)
  for (const step of plan.steps) expect(text.out.includes(step.argv.join(" ")), `the plan as text omitted ${step.label}`)
  const after = await remote(["python3", "-c", enrollmentSnapshotScript]); const engineAfter = await engine()
  expect(after.code === 0 && before.out === after.out, "planning changed system files, service definitions or installation paths")
  expect(engineBefore.fixed === engineAfter.fixed, "planning restarted Docker or changed its images")
  expect(engineBefore.containers.every((line) => engineAfter.containers.includes(line)), "a container running before the plan was restarted or stopped")
  expect(!await enrolledHost(name), "a plan registered the host")
  return `${TEST_HOST} (${plan.destination.os.PRETTY_NAME}, ${plan.destination.arch}): unchanged hashes, ownership, modes, mtimes, links, Docker process and ${engineBefore.containers.length} running containers; ${plan.steps.length} planned commands; restart victims ${plan.restart.containers.join(", ") || "none at probe time"}; blockers ${plan.blockers.join("; ") || "none"}`
})

ev("N02", "The enrollment plan names every sudo argv and what it leaves, file bytes and hashes, the pinned gVisor archive and each file taken from it, the watched policy and restart victims, as JSON and as text, and planning writes nothing", async () => {
  await enrollmentFixture()
  const before = await enrollSnapshot()
  const plan = enrollmentPlan = await planned()
  expect(plan.blockers.length === 0, `fixture blocked: ${plan.blockers.join(" ")}`)
  expect(plan.mode === "install", "the fixture must start without a Paddock service")
  expect(plan.steps.length > 5 && plan.steps.every((step) => step.argv[0] === "sudo" && step.argv[1] === "-n"), "a planned command is not a sudo -n vector")
  for (const change of plan.changes) {
    expect(new Bun.CryptoHasher("sha256").update(change.after!).digest("hex") === change.sha256, `wrong file hash for ${change.path}`)
    expect(plan.steps.some((step) => step.argv.includes(change.path) && step.argv.includes(`${plan.stageDir}/${change.staged}`) && step.leaves.includes(change.path)), `no step installs ${change.path}`)
  }
  expect(plan.uploads.some((upload) => upload.kind === "artifact" && upload.checksum === enrollmentDigest), "the artifact upload is missing")
  const runtime = plan.uploads.find((upload) => upload.kind === "download" && upload.name === "gvisor.tar.bz2")
  expect(runtime?.kind === "download" && /^[a-f0-9]{128}$/.test(runtime.checksum) && runtime.url.includes(`/${GVISOR_RELEASE}/${plan.destination.arch}/`) && runtime.extract, "gVisor is not a pinned, checksummed archive")
  for (const name of GVISOR_FILES) {
    expect(/^[a-f0-9]{64}$/.test(runtime.extract.files[name] ?? ""), `no checksum for the gVisor file ${name}`)
    expect(plan.steps.some((step) => step.argv.includes(`${plan.stageDir}/gvisor/${name}`) && step.leaves.includes(`${RUNTIME_DIR}/${name}`)), `no step installs the gVisor file ${name}`)
  }
  expect(plan.options.diskPolicy === "watched" && !JSON.stringify(plan.steps).includes("paddock-disk"), "a hard-disk installation leaked into the plan")
  expect(!plan.runtime.innerDocker && !plan.runtime.runtimeArgs.includes("--net-raw"), "inner Docker was planned without being asked for")
  // Docker is installed here, so apt is not consulted and none of its files are evidence.
  expect(!Object.keys(plan.destination.apt).length && !Object.keys(plan.destination.repositories).length, "apt evidence was gathered where Docker is installed")
  const text = await pdk(enrollArgs())
  expect(text.code === 2 && text.out.includes(`Plan hash: ${plan.hash}`), `the plan as text differed or was applied: exit ${text.code} ${text.err}`)
  for (const step of plan.steps) expect(text.out.includes(step.argv.join(" ")) && step.leaves.every((left) => text.out.includes(left)), `the plan as text omitted ${step.label}`)
  expect(before === await enrollSnapshot(), "planning made installation changes")
  await unregistered()
  return `${plan.steps.length} exact sudo vectors, ${plan.changes.length} content changes, ${plan.uploads.length} verified deliveries with ${GVISOR_FILES.length} gVisor files; no writes`
})

ev("N03", "Changed Docker configuration and container inventory invalidate consent before writes, and the revised plan lists the newly running container", async () => {
  await enrollmentFixture()
  const control = `${PREFIX}-enroll-impact`
  const old = await planned(); const before = await enrollSnapshot()
  const started = await enrollRemote(["sudo", "-n", "docker", "run", "-d", "--name", control, "alpine:latest", "sleep", "600"])
  expect(started.code === 0, started.err)
  try {
    const stale = await pdk(enrollArgs(["--accept-plan", old.hash]))
    expect(stale.code === 4 && stale.err.includes("stale"), "consent for another container inventory was accepted")
    const api = await socket("hostApply", { hash: old.hash, accepted: true })
    expect(api.status === 409 && !api.reply.ok && api.reply.error?.message.includes("stale"), "the daemon accepted consent for another container inventory")
    const revised = await planned()
    expect(revised.hash !== old.hash && revised.restart.containers.some((entry) => entry.startsWith(`${control} (`)), "the revised plan omitted the container a restart would interrupt")
    expect(before === await enrollSnapshot(), "stale consent wrote installation files")
    await unregistered()
  } finally { await enrollRemote(["sudo", "-n", "docker", "rm", "-f", control]) }
  const config = await enrollRemote(["cat", "/etc/docker/daemon.json"])
  expect(config.code === 0, "the fixture needs a Docker configuration for this control")
  const consented = await planned()
  try {
    await enrollConfig(`${JSON.stringify({ ...JSON.parse(config.out), labels: [`paddock-enrollment-stale=${PREFIX}`] })}\n`)
    const baseline = await enrollSnapshot()
    const stale = await pdk(enrollArgs(["--accept-plan", consented.hash]))
    expect(stale.code === 4, "consent for another Docker configuration was accepted")
    const api = await socket("hostApply", { hash: consented.hash, accepted: true })
    expect(api.status === 409 && !api.reply.ok && api.reply.error?.message.includes("stale"), "the daemon accepted consent for another Docker configuration")
    expect(baseline === await enrollSnapshot(), "stale consent changed files")
    await unregistered()
  } finally { await enrollConfig(config.out) }
})

ev("N04", "A wrong artifact checksum, absent consent, sudo-never without a complete installation, a host key SSH did not report and dashboard installation requests are refused without registration or remote writes", async () => {
  await enrollmentFixture()
  const before = await enrollSnapshot()
  const bad = await pdk(["host", "add", NH, "--ssh", ENROLL_HOST!, "--artifact", enrollmentArtifact, "--sha256", "0".repeat(64), "--json"])
  expect(bad.code === 2 && bad.out.includes("checksum"), "a checksum that does not match the artifact was accepted")
  const piped = await pdk(enrollArgs(), { stdin: "yes\n" })
  expect(piped.code === 2 && piped.err.includes("terminal"), "a piped yes counted as consent")
  const never = await planned(["--sudo", "never"])
  expect(never.steps.length === 0 && never.uploads.length === 0 && never.blockers.some((blocker) => blocker.includes("Owner setup")), "sudo never planned an installation")
  for (const method of ["hostPlan", "hostApply"]) {
    const denied = await tcp(`/api/${method}`, { method: "POST", body: JSON.stringify({ hash: enrollmentPlan!.hash, accepted: true }) })
    expect(denied.status === 403, `the dashboard reached ${method}`)
  }
  const denied = await socket("hostApply", { hash: enrollmentPlan!.hash, accepted: false })
  expect(!denied.reply.ok, "the API applied a plan without accepted:true")
  // An ssh that drops Paddock's KnownHostsCommand, so it reports no key it verified: the plan could not name the machine.
  const silent = await sshWrapper("silent-host-key", `
args = sys.argv[1:]
kept = [a for i, a in enumerate(args) if not a.startswith('KnownHostsCommand=') and not (a == '-o' and i + 1 < len(args) and args[i + 1].startswith('KnownHostsCommand='))]
sys.exit(subprocess.run([real] + kept, stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer).returncode)
`)
  try {
    const refused = await pdkJson(enrollArgs(), { env: silent })
    expect(refused.code === 5 && refused.reply.error?.message.includes("exactly one host key"), `a plan was made without the host key SSH verified: ${refused.out.slice(0, 300)}`)
  } finally { await realSsh() }
  const control = (await planned()).destination
  expect(control.hostKey.startsWith("SHA256:") && control.hostPublicKey.split(" ").length === 2, "the unwrapped ssh control did not report a host key")
  expect(before === await enrollSnapshot(), "a refusal changed remote files")
  await unregistered()
})

ev("N11", "Corrupting one uploaded binary byte is refused by the destination's checksum before any installation step, and the refusal says nothing was changed", async () => {
  await enrollmentFixture()
  const corrupting = await sshWrapper("corrupt-upload", `
if 'base64.b64decode' not in sys.argv[-1]:
    os.execv(real, [real] + sys.argv[1:])
plan = json.load(sys.stdin)
artifact = bytearray(base64.b64decode(plan['artifactBytes']))
artifact[0] ^= 1
plan['artifactBytes'] = base64.b64encode(artifact).decode()
result = subprocess.run([real] + sys.argv[1:], input=json.dumps(plan).encode(), capture_output=True)
sys.stdout.buffer.write(result.stdout)
sys.stderr.buffer.write(result.stderr)
sys.exit(result.returncode)
`)
  const before = await enrollSnapshot()
  try {
    const plan = await pdkJson(enrollArgs(), { env: corrupting })
    expect(plan.code === 0 && plan.reply.data.mode === "install" && plan.reply.data.uploads.some((upload: { kind: string }) => upload.kind === "artifact"), `the fixture must still need the artifact: ${plan.out.slice(0, 300)}`)
    const failed = await pdk(enrollArgs(["--accept-plan", plan.reply.data.hash]), { env: corrupting })
    expect(failed.code !== 0 && failed.err.includes("checksum mismatch"), "the destination accepted a byte changed after the primary verified the artifact")
    expect(failed.err.includes("No installation step ran") && !failed.err.includes("retained"), `the refusal did not say that nothing was changed: ${failed.err.slice(0, 600)}`)
    expect(before === await enrollSnapshot(), "a checksum failure wrote installation files, staging or the journal")
    await unregistered()
  } finally { await realSsh() }
})

ev("N05", "A failed approved installation leaves no registry entry and reports the completed steps, what each left and the interrupted step, as the destination journal records them", async () => {
  await enrollmentFixture()
  const config = await enrollRemote(["cat", "/etc/docker/daemon.json"])
  expect(config.code === 0, config.err)
  try {
    const invalid = { ...JSON.parse(config.out), debug: "invalid-boolean" }
    delete invalid.runtimes?.["paddock-runsc"]
    await enrollConfig(`${JSON.stringify(invalid)}\n`)
    const plan = await planned()
    const failed = await pdk(enrollArgs(["--accept-plan", plan.hash]))
    expect(failed.code !== 0 && failed.err.includes("Host is unregistered"), `an invalid Docker configuration did not fail the installation: ${failed.err.slice(0, 600)}`)
    for (const text of ["They left, and it is retained:", plan.binary, `${RUNTIME_DIR}/runsc`, "Interrupted step: Validate merged Docker configuration, which may also have left: nothing", `${plan.stateDir}/enrollment.json`])
      expect(failed.err.includes(text), `the failure did not report ${text}: ${failed.err.slice(0, 2500)}`)
    // Steps that never started are not reported as having left anything.
    expect(!failed.err.includes("/etc/systemd/system") && !failed.err.includes(plan.verification.name), "the failure named something no step had written")
    const journal = JSON.parse((await enrollRemote(["cat", `${plan.stateDir}/enrollment.json`])).out)
    expect(journal.completed.includes("Install verified Paddock binary") && journal.started === "Validate merged Docker configuration", "the journal omitted the partial installation")
    expect((await enrollRemote(["sha256sum", plan.binary])).out.startsWith(enrollmentDigest), "a step reported complete did not leave what it names")
    expect((await enrollRemote(["cat", "/etc/docker/daemon.json"])).out.trim() === JSON.stringify(invalid), "a failed validation replaced the Docker configuration")
    expect((await enrollRemote(["sh", "-c", "ls -d /tmp/paddock-enroll-* 2>/dev/null"])).out.trim() === "", "the failed installation left its staging")
    await unregistered()
  } finally { await enrollConfig(config.out) }
})

ev("N06", "Accepted enrollment runs exactly the planned steps, installs the declared digests and an enabled system service, preserves unrelated Docker settings, interrupts the container it named, passes sandbox blocking checks, measures watched disk use and refuses inner Docker it did not register", async () => {
  await enrollmentFixture()
  const config = await enrollRemote(["cat", "/etc/docker/daemon.json"])
  expect(config.code === 0, config.err)
  const unrelated = { ...JSON.parse(config.out), labels: ["paddock-enrollment-eval=preserve"] }
  delete unrelated.runtimes?.["paddock-runsc"]
  await enrollConfig(`${JSON.stringify(unrelated)}\n`)
  const victim = `${PREFIX}-restart-victim`
  expect((await enrollRemote(["sudo", "-n", "docker", "run", "-d", "--name", victim, "alpine:latest", "sleep", "600"])).code === 0, "the restart control did not start")
  let plan: HostPlan
  try {
    plan = await planned()
    expect(plan.blockers.length === 0, plan.blockers.join(" "))
    expect(plan.restart.required && plan.restart.containers.some((entry) => entry.startsWith(`${victim} (`)), "the restart plan omitted its running control")
    const applied = await pdk(enrollArgs(["--accept-plan", plan.hash]), { timeoutMs: 600_000 })
    expect(applied.code === 0, `${applied.err} ${applied.out.slice(-300)}`)
    const interrupted = await enrollRemote(["sudo", "-n", "docker", "inspect", "--format", "{{.State.Running}}", victim])
    expect(interrupted.code === 0 && interrupted.out.trim() === "false", "the Docker restart did not interrupt the running control on this fixture")
  } finally { await enrollRemote(["sudo", "-n", "docker", "rm", "-f", victim]) }
  // The installer ran the plan's steps and no others, and left no staging.
  const journal = JSON.parse((await enrollRemote(["cat", `${plan.stateDir}/enrollment.json`])).out)
  expect(journal.hash === plan.hash && JSON.stringify(journal.completed) === JSON.stringify(plan.steps.map((step) => step.label)) && journal.started === null, "the journal's steps are not the plan's")
  expect((await enrollRemote(["sh", "-c", `ls -d /tmp/paddock-enroll-* ${plan.requestPath} 2>/dev/null`])).out.trim() === "", "the installation left its staging")
  // The pinned checksums themselves: an earlier failed attempt may have installed gVisor, so this plan need not name it.
  const pinned = GVISOR[plan.destination.arch === "aarch64" ? "aarch64" : "x86_64"].files
  const installed = await enrollRemote(["sh", "-c", `cd ${RUNTIME_DIR} && sha256sum ${GVISOR_FILES.join(" ")} && stat -c "%u %a %n" ${GVISOR_FILES.join(" ")}`])
  for (const name of GVISOR_FILES) {
    expect(installed.out.includes(`${pinned[name]}  ${name}\n`), `the installed gVisor file ${name} differs from the pinned checksum`)
    expect(installed.out.includes(`0 755 ${name}\n`), `the installed gVisor file ${name} is not root's, mode 0755`)
  }
  expect((await enrollRemote(["sha256sum", plan.binary])).out.startsWith(enrollmentDigest), "the installed artifact's checksum differs")
  for (const change of plan.changes) expect((await enrollRemote(["sha256sum", change.path])).out.startsWith(change.sha256!), `the installed file ${change.path} differs from the approved bytes`)
  const recorded = await enrolledHost()
  expect(recorded?.state === "online" && recorded.host.service === "systemd" && recorded.hello?.buildDigest === enrollmentDigest, "the registration does not name the verified service")
  const unit = (await enrollRemote(["systemctl", "show", plan.service, "--property=User,ActiveState,UnitFileState,SupplementaryGroups"])).out.split("\n")
  for (const wanted of [`User=${plan.destination.user}`, "ActiveState=active", "UnitFileState=enabled", "SupplementaryGroups=docker"]) expect(unit.includes(wanted), `the unit lacks ${wanted}`)
  const after = JSON.parse((await enrollRemote(["cat", "/etc/docker/daemon.json"])).out)
  expect(JSON.stringify(after.labels) === JSON.stringify(unrelated.labels), "unrelated Docker settings were lost")
  expect(JSON.stringify(after.runtimes["paddock-runsc"]) === JSON.stringify({ path: `${RUNTIME_DIR}/runsc`, runtimeArgs: ["--allow-suid", "--overlay2=none"] }), "the registered runtime is not the planned one")
  const engine = await enrolledEngine()
  expect(engine?.data.runtime === "paddock-runsc" && engine.capabilities?.docker === false, "the installed runtime is not the managed one, or it offered inner Docker that was not registered")
  const inner = await pdk(["--host", NH, "create", `${PREFIX}-no-inner`, "--docker", "--image", "alpine:latest"])
  expect(inner.code === 5, "a request for inner Docker the host does not offer was accepted")
  const name = `${PREFIX}-enrolled`
  try {
    const made = await pdkJson(["--host", NH, "create", name, "--image", "alpine:latest", "--cpus", "0.5", "--memory", "0.5", "--disk", "1"])
    expect(made.code === 0, made.out + made.err)
    for (const check of CHECKLIST.filter((item) => item.blocking && item.id !== "docker")) expect(checkPassed(made.reply.data.checks, check.id), `the enrolled sandbox's ${check.id} check did not pass`)
    const write = await pdk(["--host", NH, "exec", name, "--", "dd", "if=/dev/zero", "of=/eval-disk", "bs=1048576", "count=2"])
    expect(write.code === 0, write.err)
    const verified = await pdkJson(["--host", NH, "verify", name])
    expect(verified.code === 0 && verified.reply.data.ok && verified.reply.data.diskUsedBytes >= 2097152, "the watcher did not measure the bytes written")
  } finally { await pdk(["--host", NH, "remove", name, "--confirm", name]) }
  return `${ENROLL_HOST}, ${plan.destination.os.PRETTY_NAME}, ${plan.destination.arch}, gVisor ${GVISOR_RELEASE}, systemd as ${plan.destination.user}; ${plan.steps.length} steps as planned; every applicable blocking check passed; reboot not measured`
})

ev("N07", "Removing an enrolled host retains the service, and sudo never can re-enroll it without installation, a service restart or a Docker restart", async () => {
  await enrollmentFixture()
  const previous = await enrolledHost()
  if (!previous) return skip("a successful N06 enrollment is required")
  const removed = await forget()
  expect(removed.code === 0, removed.err)
  await unregistered()
  const plan = await planned(["--sudo", "never"])
  expect(plan.blockers.length === 0 && plan.mode === "reuse", `reuse refused: ${plan.blockers.join(" ")}`)
  expect(!plan.steps.length && !plan.uploads.length && !plan.changes.length && !plan.authentication.length && !plan.restart.required && !plan.restart.service, "a reuse plan installs, authenticates or restarts")
  const identity = plan.destination.files[`${plan.stateDir}/machine-id`]
  expect(identity?.kind === "file" && identity.text?.trim() === previous.host.machineId, "the plan omitted the prepared daemon's machine identity")
  const state = async () => (await enrollRemote(["sh", "-c", `systemctl show ${plan.service} --property=MainPID,ExecMainStartTimestamp; cat /etc/docker/daemon.json`])).out + await dockerStarted()
  const before = await state()
  const readded = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", plan.hash]), { timeoutMs: 300_000 })
  expect(readded.code === 0, readded.err)
  expect(before === await state(), "reuse restarted the service or Docker, or changed the Docker configuration")
  await forget()
  await unregistered()
})

ev("N08", "A fresh Ubuntu machine receives exactly the checksum-verified distro Docker package transaction, then enrolls with a working system service and no login group edits", async () => {
  const destination = process.env.PADDOCK_EVAL_ENROLL_PACKAGES_HOST
  if (!destination || !DISPOSABLE.test(destination)) skip("PADDOCK_EVAL_ENROLL_PACKAGES_HOST must name another disposable pdk-enroll-*@orb machine with apt metadata and no Docker")
  const run = (argv: string[]) => disposable(destination!, argv)
  expect((await run(["which", "docker"])).code !== 0, "the package fixture must start without Docker")
  const groups = await run(["id", "-Gn"])
  expect(groups.code === 0, groups.err)
  const { artifact, digest } = await linuxBuild((await run(["uname", "-m"])).out.trim(), "package-enrollment-paddock")
  const name = `${PREFIX}-packages`; const argv = ["host", "add", name, "--ssh", destination!, "--artifact", artifact, "--sha256", digest]
  const made = await pdkJson(argv)
  expect(made.code === 0, made.out + made.err)
  const plan: HostPlan = made.reply.data
  expect(plan.blockers.length === 0, plan.blockers.join(" "))
  expect(plan.packageRecipe.downloads.some((download) => download.package === "docker.io") && plan.packageRecipe.downloads.every((download) => /^[a-f0-9]{64}$/.test(download.sha256)), "the plan lacks a checksummed Docker package transaction")
  // Docker is absent here, so the apt sources, keys and indexes that chose the packages are part of the plan.
  expect(Object.keys(plan.packageRecipe.repositories).length > 0 && Object.keys(plan.packageRecipe.repositoryHashes).length > 0, "the plan omitted the apt evidence its package list came from")
  const applied = await pdk([...argv, "--accept-plan", plan.hash], { timeoutMs: 600_000 })
  expect(applied.code === 0, applied.err + applied.out.slice(-500))
  try {
    for (const download of plan.packageRecipe.downloads) {
      const installed = await run(["dpkg-query", "-W", "-f=${Version}", download.package])
      expect(installed.code === 0 && installed.out === download.version, `the installed ${download.package} differs from the plan`)
    }
    expect(groups.out === (await run(["id", "-Gn"])).out, "the installer edited login group membership")
    expect((await enrolledHost(name))?.state === "online", "the new Docker installation did not enroll")
    return `${destination}, ${plan.packageRecipe.downloads.length} checksum-verified .deb files; systemd service, isolation and disk smoke verification passed`
  } finally { await forget(name) }
})

// Runs a command on a terminal of its own, answers the consent question, types a password when sudo asks for one, and
// can send Ctrl-C two seconds after consenting. Prints the terminal's output and how the command ended.
const enrollmentTerminalScript = `
import json, os, pty, select, sys, termios, time

argv = json.loads(sys.argv[1])
answer = sys.argv[2]
password = sys.argv[3] if len(sys.argv) > 3 else None
interrupt = len(sys.argv) > 4 and sys.argv[4] == 'interrupt'
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
output = b''
consent = secret = interrupted = False
status = interrupt_at = None
try:
    end = time.time() + 300
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
            if not consent and b'Enter yes:' in output:
                os.write(fd, (answer + '\\n').encode())
                consent = True
                interrupt_at = time.time() + 2
            if password and consent and not secret and b'[sudo] password for' in output:
                os.write(fd, (password + '\\n').encode())
                secret = True
        if interrupt and consent and not interrupted and time.time() >= interrupt_at:
            os.write(fd, b'\\x03')
            interrupted = True
        done, value = os.waitpid(pid, os.WNOHANG)
        if done:
            status = value
            break
    else:
        os.kill(pid, 15)
        raise RuntimeError('interactive enrollment timed out')
    if status is None:
        _, status = os.waitpid(pid, 0)
    flags = termios.tcgetattr(fd)[3]
    restored = bool(flags & termios.ICANON and flags & termios.ISIG and flags & termios.ECHO)
    sys.stdout.buffer.write(output)
    print('\\nTERMINAL-RESULT ' + json.dumps(dict(
        code=os.waitstatus_to_exitcode(status), consent=consent, passwordPrompt=secret, interrupted=interrupted, terminalRestored=restored)))
finally:
    os.close(fd)
`
async function enrollmentTerminal(extra: string[], answer: string, password = "", interrupt = false) {
  const terminal = await sh(["python3", "-c", enrollmentTerminalScript, JSON.stringify([BIN, ...enrollArgs(extra)]), answer, password, ...(interrupt ? ["interrupt"] : [])], { env, timeoutMs: 400_000 })
  expect(terminal.code === 0 && terminal.out.includes("TERMINAL-RESULT "), `the terminal control failed: ${terminal.out.slice(-800)} ${terminal.err}`)
  const result = JSON.parse(terminal.out.split("TERMINAL-RESULT ").at(-1)!) as { code: number; consent: boolean; passwordPrompt: boolean; interrupted: boolean; terminalRestored: boolean }
  return { ...result, out: terminal.out }
}

ev("N09", "Interactive enrollment requires the literal word yes; a different terminal response declines without installation or registration", async () => {
  await enrollmentFixture()
  const before = await enrollSnapshot()
  const terminal = await enrollmentTerminal([], "y")
  expect(terminal.code === 4 && terminal.consent && terminal.out.includes("declined"), "an interactive y was accepted, or the terminal never reached the consent question")
  expect(terminal.out.includes("Privileged commands") && terminal.out.includes("Plan hash: "), "the plan was not shown before the consent question")
  expect(before === await enrollSnapshot(), "declining changed installation files")
  await unregistered()
})

ev("N10", "Interactive sudo authentication and installation share one SSH terminal, work with tty-scoped sudo credentials and keep the password out of plans and journals", async () => {
  await enrollmentFixture()
  const fixture = ENROLL_HOST!.slice(0, -4); const user = (await enrollRemote(["id", "-un"])).out.trim(); const service = await enrollService()
  const root = (argv: string[], stdin?: string) => sh(["orb", "run", "-m", fixture, "-u", "root", ...argv], { stdin })
  expect((await root(["true"])).code === 0, "OrbStack's root control of the fixture is unavailable")
  const password = `paddock-disposable-${PREFIX}`; const rule = "/etc/sudoers.d/zz-paddock-enrollment-eval"
  // Without its unit the service has to be installed again, which needs sudo.
  await root(["systemctl", "disable", "--now", service])
  await root(["rm", "-f", `/etc/systemd/system/${service}`])
  await root(["systemctl", "daemon-reload"])
  expect((await root(["chpasswd"], `${user}:${password}\n`)).code === 0, "could not set the disposable fixture's password")
  const setup = await root(["python3", "-c", "import os,sys; p=sys.argv[1]; f=open(p,'w'); f.write(sys.argv[2]); f.close(); os.chmod(p,0o440)", rule, `Defaults timestamp_type=tty\n${user} ALL=(ALL:ALL) PASSWD: ALL\n`])
  expect(setup.code === 0, setup.err)
  try {
    expect((await root(["visudo", "-c"])).code === 0, "the fixture's sudoers rule is invalid")
    await enrollRemote(["sudo", "-k"])
    expect((await enrollRemote(["sudo", "-n", "true"])).code !== 0, "passwordless sudo still worked, so the password path was not exercised")
    const plan = await planned()
    expect(plan.blockers.length === 0 && plan.mode === "install", plan.blockers.join(" "))
    expect(!JSON.stringify(plan).includes(password), "the password appeared in the plan")
    const terminal = await enrollmentTerminal([], "yes", password)
    expect(terminal.code === 0 && terminal.passwordPrompt && terminal.out.includes(`Enrolled ${NH}.`) && !terminal.out.includes(password), `enrollment through a sudo password prompt failed: ${terminal.out.slice(-2500)}`)
    const journal = await enrollRemote(["cat", `${plan.stateDir}/enrollment.json`])
    expect(journal.code === 0 && !journal.out.includes(password), "the password appeared in the journal, or the journal was unreadable")
    expect((await enrollRemote(["test", "-e", plan.requestPath])).code !== 0, "the interactive request file remained")
    return "sudo -n was refused; an interactive yes and the disposable password installed and verified with timestamp_type=tty"
  } finally {
    await root(["rm", "-f", rule])
    await forget()
  }
})

ev("N15", "A service enabled only until the next boot is refused for sudo-never enrollment and needs one privileged step otherwise; the same service permanently enabled is reused", async () => {
  await enrollmentFixture()
  const service = await enrollService()
  await forget()
  try {
    expect((await enrollRemote(["sudo", "-n", "systemctl", "disable", service])).code === 0, "could not remove the permanent enablement")
    expect((await enrollRemote(["sudo", "-n", "systemctl", "enable", "--runtime", service])).code === 0, "could not enable the service for this boot only")
    const state = (await enrollRemote(["systemctl", "show", service, "--property=ActiveState,UnitFileState"])).out.split("\n")
    expect(state.includes("ActiveState=active") && state.includes("UnitFileState=enabled-runtime"), "the active, runtime-only control was not established")
    const plan = await planned(["--sudo", "never"])
    expect(plan.steps.length === 0 && plan.blockers.some((blocker) => blocker.includes("Owner setup")), "a runtime-only service was described as enabled at boot")
    const rejected = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", plan.hash]))
    expect(rejected.code === 5, "a runtime-only service was enrolled")
    await unregistered()
    // With sudo allowed, the one thing missing is planned, and the running service is left running.
    const ask = await planned()
    expect(ask.blockers.length === 0 && ask.steps.some((step) => step.label === "Enable service at boot") && !ask.restart.required && !ask.restart.service && !ask.uploads.length, "enabling the service was not the plan")
  } finally {
    await enrollRemote(["sudo", "-n", "systemctl", "disable", "--runtime", service])
    await enrollRemote(["sudo", "-n", "systemctl", "enable", service])
  }
  const permanent = await planned(["--sudo", "never"])
  expect(permanent.mode === "reuse" && permanent.blockers.length === 0, `the permanently enabled control was refused: ${permanent.blockers.join(" ")}`)
})

ev("N16", "The managed pinned runtime is used even when an unrelated usable gVisor runtime sorts first, without deleting that runtime", async () => {
  await enrollmentFixture()
  await forget()
  const service = await enrollService()
  const before = await enrollRemote(["cat", "/etc/docker/daemon.json"])
  expect(before.code === 0, before.err)
  const directory = (await enrollRemote(["mktemp", "-d", `/tmp/${PREFIX}-runtime-XXXXXX`])).out.trim()
  expect(directory.startsWith(`/tmp/${PREFIX}-runtime-`), "could not make a folder for the control runtime")
  const name = "aaa-enrollment-control"
  try {
    // A second copy of the same gVisor, registered under a name that sorts first and with inner Docker's arguments.
    expect((await enrollRemote(["sh", "-c", 'chmod 0755 "$1" && cp -R "$2" "$1/gvisor"', "copy", directory, RUNTIME_DIR])).code === 0, "could not copy the pinned runtime as a control")
    const config = JSON.parse(before.out)
    config.runtimes[name] = { path: `${directory}/gvisor/runsc`, runtimeArgs: ["--allow-suid", "--overlay2=none", "--net-raw"] }
    await enrollConfig(`${JSON.stringify(config)}\n`)
    expect((await enrollRemote(["sudo", "-n", "systemctl", "restart", "docker"])).code === 0, "could not reload the fixture's runtimes")
    expect((await enrollRemote(["sudo", "-n", "systemctl", "start", service])).code === 0, "could not start the fixture's service again")
    const control = await enrollRemote(["sudo", "-n", "docker", "run", "--rm", "--runtime", name, "alpine:latest", "uname", "-a"])
    expect(control.code === 0, `the unrelated gVisor control did not run: ${control.err}`)
    const plan = await planned(["--sudo", "never"])
    expect(plan.blockers.length === 0, plan.blockers.join(" "))
    const enrolled = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", plan.hash]), { timeoutMs: 300_000 })
    expect(enrolled.code === 0, enrolled.err)
    const engine = await enrolledEngine()
    expect(engine?.data.runtime === "paddock-runsc" && engine.capabilities?.docker === false, "a runtime that sorts earlier displaced the managed one")
    const current = JSON.parse((await enrollRemote(["cat", "/etc/docker/daemon.json"])).out)
    expect(JSON.stringify(current.runtimes[name]) === JSON.stringify(config.runtimes[name]), "the unrelated runtime was changed")
    return "the unrelated --net-raw control ran; Paddock selected paddock-runsc without inner Docker and preserved the other entry"
  } finally {
    await forget()
    await enrollConfig(before.out)
    await enrollRemote(["sudo", "-n", "systemctl", "restart", "docker"])
    await enrollRemote(["sudo", "-n", "systemctl", "start", service])
    await enrollRemote(["python3", "-c", "import shutil,sys; shutil.rmtree(sys.argv[1])", directory])
  }
})

ev("N14", "A failed or unknown final smoke result refuses registration even after creation passed, and the same enrollment with the result unaltered registers", async () => {
  await enrollmentFixture()
  await forget()
  const modeFile = join(tmp, "final-verify-mode"); const proofFile = join(tmp, "final-verify-proof.json")
  // Stands between the primary and the fixture's daemon, request by request, and rewrites the reply to the smoke
  // sandbox's final verify as the mode file says. Every other reply, and every other SSH command, passes unchanged.
  const altering = await sshWrapper("failed-final-verify", `
if len(sys.argv) < 3 or sys.argv[-2] != ${JSON.stringify(ENROLL_HOST)} or "'transport' 'stdio'" not in sys.argv[-1] or "'--stream'" in sys.argv[-1]:
    os.execv(real, [real] + sys.argv[1:])

class NoClose:
    def __init__(self, stream):
        self.stream = stream
    def __getattr__(self, name):
        return getattr(self.stream, name)
    def close(self):
        pass

class Pipe:
    def __init__(self, stream):
        self.stream = stream
    def makefile(self, *args, **kwargs):
        return NoClose(self.stream)

def interrupted(number, frame):
    raise SystemExit(128 + number)

signal.signal(signal.SIGTERM, interrupted)
relay = subprocess.Popen([real] + sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None)
try:
    while True:
        first = sys.stdin.buffer.readline()
        if not first:
            break
        headers = []
        length = 0
        while True:
            line = sys.stdin.buffer.readline()
            headers.append(line)
            if line in (b'\\r\\n', b'\\n', b''):
                break
            if line.lower().startswith(b'content-length:'):
                length = int(line.split(b':', 1)[1])
        relay.stdin.write(first + b''.join(headers) + sys.stdin.buffer.read(length))
        relay.stdin.flush()
        response = http.client.HTTPResponse(Pipe(relay.stdout))
        response.begin()
        data = response.read()
        if b'/api/verify ' in first:
            payload = json.loads(data)
            value = payload['data']
            kind = open(${JSON.stringify(modeFile)}).read().strip()
            kernel = next(check for check in value['checks'] if check['id'] == 'kernel')
            with open(${JSON.stringify(proofFile)}, 'w') as proof:
                json.dump(dict(originalOk=value['ok'], originalKernel=kernel['status'], kind=kind), proof)
            if kind == 'ok':
                value['ok'] = False
            elif kind != 'unaltered':
                kernel.update(status=kind, evidence='none', detail='injected final smoke control')
            data = json.dumps(payload).encode()
        out = ('HTTP/1.1 ' + str(response.status) + ' ' + response.reason + '\\r\\n').encode()
        for key, value in response.getheaders():
            if key.lower() not in ['content-length', 'transfer-encoding', 'connection', 'keep-alive']:
                out += (key + ': ' + value + '\\r\\n').encode()
        out += ('Content-Length: ' + str(len(data)) + '\\r\\nConnection: keep-alive\\r\\n\\r\\n').encode()
        sys.stdout.buffer.write(out + data)
        sys.stdout.buffer.flush()
except SystemExit:
    relay.terminate()
    raise
finally:
    # At the end of input the real ssh ends by itself, as it does without this wrapper.
    relay.stdin.close()
    try:
        relay.wait(timeout=15)
    except subprocess.TimeoutExpired:
        relay.kill()
        relay.wait()
`)
  try {
    // ok: the result says it did not hold. fail, unknown: the kernel check's status. unaltered: the control.
    for (const kind of ["ok", "fail", "unknown", "unaltered"]) {
      await writeFile(modeFile, kind)
      const plan = await pdkJson(enrollArgs(["--sudo", "never"]), { env: altering })
      expect(plan.code === 0 && !plan.reply.data.blockers.length, plan.out.slice(0, 400))
      const applied = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", plan.reply.data.hash]), { env: altering, timeoutMs: 300_000 })
      const proof = JSON.parse(await readFile(proofFile, "utf8"))
      expect(proof.originalOk === true && proof.originalKernel === "pass" && proof.kind === kind, "the healthy final result did not reach the wrapper")
      if (kind === "unaltered") expect(applied.code === 0 && (await enrolledHost())?.state === "online", `the same enrollment with its result unaltered did not register: ${applied.err.slice(0, 400)}`)
      else {
        expect(applied.code === 6 && applied.err.includes("Host is unregistered"), `a final result altered to ${kind} was not refused as a failed check: exit ${applied.code} ${applied.err.slice(0, 300)}`)
        // Reuse installed nothing, and the refusal says so.
        expect(applied.err.includes("This run installed nothing"), "the refusal did not say that the run installed nothing")
        await unregistered()
      }
    }
  } finally {
    await forget()
    await realSsh()
  }
})

ev("N13", "Ctrl-C during enrollment verification cancels with exit 130, restores the terminal and leaves no host registered", async () => {
  await enrollmentFixture()
  await forget()
  const plan = await planned(["--sudo", "never"])
  expect(plan.mode === "reuse" && plan.blockers.length === 0, `an earlier eval must leave the verified service prepared: ${plan.blockers.join(" ")}`)
  try {
    const terminal = await enrollmentTerminal(["--sudo", "never"], "yes", "", true)
    expect(terminal.consent && terminal.interrupted && terminal.code === 130 && terminal.terminalRestored, `Ctrl-C did not cancel the verification: ${terminal.out.slice(-1800)}`)
    await unregistered()
    // The cancelled verification removed its smoke sandbox, so the next enrollment is not refused for it.
    expect(!(await enrollRemote(["sudo", "-n", "docker", "ps", "-a", "--format", "{{.Names}}"])).out.includes(plan.verification.name), "the cancelled verification left its smoke sandbox")
    return "a literal yes began verification; Ctrl-C cancelled it and the service was retained without registration"
  } finally { await forget() }
})

ev("N18", "A sandbox already holding the smoke name on the host is not touched: enrollment is refused with the command that removes it, and enrolls once that command has run", async () => {
  await enrollmentFixture()
  await forget()
  const plan = await planned(["--sudo", "never"])
  expect(plan.mode === "reuse" && plan.blockers.length === 0, `an earlier eval must leave the verified service prepared: ${plan.blockers.join(" ")}`)
  const name = plan.verification.name
  // What an earlier attempt whose create reply was lost leaves behind: made here by the host's owner.
  const kept = await enrollOwner(plan, ["create", name, "--image", "alpine:latest", "--cpus", "0.5", "--memory", "0.5", "--disk", "1"])
  expect(kept.code === 0, `could not make the kept sandbox on the fixture: ${kept.err.slice(0, 400)}`)
  try {
    // It is a running container, so it is part of the plan that is consented to.
    const current = await planned(["--sudo", "never"])
    expect(current.hash !== plan.hash && current.verification.name === name && current.blockers.length === 0, "the kept sandbox did not change the plan, or changed the smoke name")
    const refused = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", current.hash]), { timeoutMs: 300_000 })
    expect(refused.code === 4 && refused.err.includes(name) && refused.err.includes("It was not touched"), `enrollment over a kept sandbox was not refused: exit ${refused.code} ${refused.err.slice(0, 400)}`)
    await unregistered()
    const running = await enrollRemote(["sudo", "-n", "docker", "inspect", "--format", "{{.State.Running}}", containerOf(name)])
    expect(running.out.trim() === "true", "the refused enrollment stopped or removed the kept sandbox")
    const remedy = refused.err.match(/`(ssh [^`]+)`/)?.[1]
    expect(remedy?.includes(` remove ${name} --confirm ${name}`), `the refusal did not give the command that removes it: ${refused.err.slice(0, 600)}`)
    // The command exactly as the refusal printed it, as its reader would paste it.
    const cleared = await sh(["sh", "-c", remedy!], { timeoutMs: 120_000 })
    expect(cleared.code === 0 && (await enrollRemote(["sudo", "-n", "docker", "inspect", containerOf(name)])).code !== 0, `the printed command did not remove the kept sandbox: ${cleared.err}`)
    const enrolled = await pdk(enrollArgs(["--sudo", "never", "--accept-plan", (await planned(["--sudo", "never"])).hash]), { timeoutMs: 300_000 })
    expect(enrolled.code === 0 && (await enrolledHost())?.state === "online", `enrollment after the remedy failed: ${enrolled.err.slice(0, 400)}`)
  } finally {
    await enrollOwner(plan, ["remove", name, "--confirm", name])
    await forget()
  }
})

ev("N17", "A nonzero installer SSH exit refuses registration despite a successful report; a binary-only update restarts Paddock without restarting Docker, and its plan names the running sandbox that restart stops", async () => {
  await enrollmentFixture()
  await forget()
  // A sandbox on the fixture's daemon, made through this primary while the host is enrolled, then left running there.
  const prepared = await planned(["--sudo", "never"])
  expect(prepared.mode === "reuse" && prepared.blockers.length === 0, `an earlier eval must leave the verified service prepared: ${prepared.blockers.join(" ")}`)
  expect((await pdk(enrollArgs(["--sudo", "never", "--accept-plan", prepared.hash]), { timeoutMs: 300_000 })).code === 0, "could not enroll the prepared service")
  const victim = `${PREFIX}-update-victim`
  const made = await pdk(["--host", NH, "create", victim, "--image", "alpine:latest", "--cpus", "0.5", "--memory", "0.5", "--disk", "1"])
  await forget()
  const victimRunning = async () => (await enrollRemote(["sudo", "-n", "docker", "inspect", "--format", "{{.State.Running}}", containerOf(victim)])).out.trim()
  // The exit status of an installer session that did everything and reported it: 77 instead of 0.
  const failing = await sshWrapper("failed-installer-exit", `
if 'base64.b64decode' not in sys.argv[-1]:
    os.execv(real, [real] + sys.argv[1:])
result = subprocess.run([real] + sys.argv[1:], stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer)
if result.returncode == 0:
    open(${JSON.stringify(join(tmp, "installer-exit-used"))}, 'w').write('successful report, exit 77')
    sys.exit(77)
sys.exit(result.returncode)
`)
  let update: HostPlan | undefined
  try {
    expect(made.code === 0 && await victimRunning() === "true", `the sandbox a service restart would stop did not start: ${made.err.slice(0, 300)}`)
    // The same source built without minify: another artifact, and nothing else about the host changes.
    const other = await linuxBuild(prepared.destination.arch, "unminified-enrollment-paddock", false)
    expect(other.digest !== enrollmentDigest, "the second build is the same artifact")
    const command = ["host", "add", NH, "--ssh", ENROLL_HOST!, "--artifact", other.artifact, "--sha256", other.digest]
    const plan = await pdkJson(command, { env: failing })
    expect(plan.code === 0 && plan.reply.data.blockers.length === 0, plan.out.slice(0, 400))
    update = plan.reply.data as HostPlan
    expect(update.mode === "install" && !update.restart.required && update.restart.service, "another artifact did not plan a Paddock restart alone")
    expect(update.restart.sandboxes.some((entry) => entry.startsWith(`${containerOf(victim)} (`)) && update.warnings.some((warning) => warning.includes(containerOf(victim)) && warning.includes("does not start them again")), "the plan did not name the running sandbox its service restart stops")
    expect(update.steps.at(-1)?.label === "Restart the Paddock service" && update.uploads.length === 1 && update.uploads[0]!.kind === "artifact", "the update plans more than a new binary and a service restart")
    expect(!update.changes.some((change) => change.path === "/etc/docker/daemon.json"), "another artifact planned a change to Docker's configuration")
    const docker = await dockerStarted()
    const failed = await pdk([...command, "--accept-plan", update.hash], { env: failing, timeoutMs: 300_000 })
    expect(await Bun.file(join(tmp, "installer-exit-used")).exists(), "the installer never reported success, so the exit status was not what failed")
    expect(failed.code === 10 && failed.err.includes("exit 77") && failed.err.includes("Host is unregistered"), `an installer session that ended with exit 77 was not refused as an unknown outcome: exit ${failed.code} ${failed.err.slice(0, 400)}`)
    await unregistered()
    expect(docker === await dockerStarted(), "a binary-only update restarted Docker")
    expect((await enrollRemote(["sha256sum", update.binary])).out.startsWith(other.digest), "the new binary was not installed")
    const journal = JSON.parse((await enrollRemote(["cat", `${update.stateDir}/enrollment.json`])).out)
    expect(JSON.stringify(journal.completed) === JSON.stringify(update.steps.map((step) => step.label)), "the journal's steps are not the plan's")
    expect(await victimRunning() === "false", "the sandbox the plan named was still running after the service restart")
    return `exit 77 after a complete report was refused (outcome unknown); Docker kept its process; the service restart stopped ${containerOf(victim)}, as the plan said`
  } finally {
    // Removed by the daemon that owns it, with whichever binary that daemon now runs.
    const removed = await enrollOwner(update ?? prepared, ["remove", victim, "--confirm", victim])
    if (removed.code !== 0 && update) await enrollOwner(prepared, ["remove", victim, "--confirm", victim])
    await forget()
    await realSsh()
  }
})

ev("N19", "Enrolling with --docker registers gVisor with raw sockets, shows it in the plan and its hash, verifies inner Docker in the smoke sandbox, and a sandbox made through this primary runs Docker inside with every blocking check passing", async () => {
  await enrollmentFixture()
  await forget()
  const plain = await planned(); const plan = await planned(["--docker"])
  expect(plan.blockers.length === 0, plan.blockers.join(" "))
  expect(plan.hash !== plain.hash && plan.runtime.innerDocker && plan.verification.docker && plan.runtime.runtimeArgs.includes("--net-raw"), "the Docker option is not in the plan and its hash")
  const change = plan.changes.find((entry) => entry.path === "/etc/docker/daemon.json")
  expect(plan.mode === "install" && plan.restart.required && change?.diff.includes('+        "--net-raw"'), "registering raw sockets is not shown as a Docker configuration change and restart")
  const text = await pdk(enrollArgs(["--docker"]))
  expect(text.code === 2 && text.out.includes("Docker inside sandboxes: offered") && text.out.includes('+        "--net-raw"') && text.out.includes(`Plan hash: ${plan.hash}`), "the plan as text does not show the Docker option")
  const applied = await pdk(enrollArgs(["--docker", "--accept-plan", plan.hash]), { timeoutMs: 900_000 })
  expect(applied.code === 0, `${applied.err.slice(0, 1500)} ${applied.out.slice(-300)}`)
  const name = `${PREFIX}-inner-docker`
  try {
    const config = JSON.parse((await enrollRemote(["cat", "/etc/docker/daemon.json"])).out)
    expect(JSON.stringify(config.runtimes["paddock-runsc"].runtimeArgs) === JSON.stringify(["--allow-suid", "--overlay2=none", "--net-raw"]) && config.labels?.includes("paddock-enrollment-eval=preserve"), "the registered runtime is not the planned one, or unrelated settings were lost")
    const engine = await enrolledEngine()
    expect(engine?.data.runtime === "paddock-runsc" && engine.capabilities?.docker === true, "the enrolled host does not offer inner Docker")
    const made = await pdkJson(["--host", NH, "create", name, "--docker", "--image", plan.verification.image, "--cpus", "1", "--memory", "1", "--disk", "2", "--pids", "4096"], { timeoutMs: 600_000 })
    expect(made.code === 0, (made.out + made.err).slice(0, 1500))
    for (const check of CHECKLIST.filter((item) => item.blocking)) expect(checkPassed(made.reply.data.checks, check.id), `the Docker sandbox's ${check.id} check did not pass`)
    const inner = await pdk(["--host", NH, "exec", name, "--", "docker", "run", "--rm", "alpine:3.24", "echo", "inner-ok"], { timeoutMs: 300_000 })
    expect(inner.code === 0 && inner.out.includes("inner-ok"), `a container inside the sandbox did not run: ${inner.err.slice(-600)}`)
    // Enrolling again without the option would take raw sockets away, and the plan says what that breaks.
    await forget()
    const downgrade = await planned()
    expect(downgrade.mode === "install" && downgrade.warnings.some((warning) => warning.includes("removes --net-raw")), "a plan that removes raw sockets did not say so")
    return `${ENROLL_HOST}: gVisor ${GVISOR_RELEASE} with --net-raw; the smoke sandbox and a sandbox from ${plan.verification.image} ran Docker inside; every blocking check passed, inner Docker's included`
  } finally {
    await enrollOwner(plan, ["remove", name, "--confirm", name])
    await forget()
  }
})

ev("N12", "The documented manual uninstall removes the disposable fixture's Paddock service, firewall tables, runtime and files while preserving unrelated Docker settings and a working engine", async () => {
  await enrollmentFixture()
  const uid = (await enrollRemote(["id", "-u"])).out.trim(); const service = `paddock@${uid}.service`
  const before = await enrollRemote(["cat", "/etc/docker/daemon.json"])
  expect(before.code === 0, before.err)
  const config = JSON.parse(before.out)
  expect(config.runtimes?.["paddock-runsc"], "the control did not find the installed runtime")
  const containers = await enrollRemote(["sudo", "-n", "docker", "ps", "-a", "--format", "{{.Names}} {{.State}} {{.Label \"dev.paddock.name\"}}"])
  expect(containers.code === 0 && !containers.out.split("\n").some((line) => / running /.test(line) || line.trim().split(" ").length > 2), `the fixture still has running containers or sandboxes: ${containers.out}`)
  const nft = (argv: string[]) => enrollRemote(["sudo", "-n", "docker", "run", "--rm", "--network", "host", "--cap-add", "NET_ADMIN", "--runtime", "runc", HELPER_IMAGE, "nft", ...argv])
  // The steps of docs/host-enrollment.md, in its order.
  expect((await enrollRemote(["sudo", "-n", "systemctl", "disable", "--now", service])).code === 0, "could not stop and disable the service")
  // The tables outlive the service that loaded them.
  expect((await nft(["list", "tables"])).out.includes("paddock_guard"), "the control did not find Paddock's firewall tables after the service stopped")
  for (const family of ["inet", "bridge"]) expect((await nft(["delete", "table", family, "paddock_guard"])).code === 0, `could not delete the ${family} firewall table`)
  delete config.runtimes["paddock-runsc"]
  if (!Object.keys(config.runtimes).length) delete config.runtimes
  const candidate = `/tmp/${PREFIX}-uninstall.json`
  expect((await enrollRemote(["tee", candidate], { stdin: `${JSON.stringify(config, null, 2)}\n` })).code === 0, "could not stage the Docker configuration without the runtime")
  expect((await enrollRemote(["sudo", "-n", "dockerd", "--validate", "--config-file", candidate])).code === 0, "the Docker configuration without the runtime is invalid")
  expect((await enrollRemote(["sudo", "-n", "install", "-m", "0644", candidate, "/etc/docker/daemon.json"])).code === 0, "could not install the Docker configuration without the runtime")
  await enrollRemote(["rm", "-f", candidate])
  expect((await enrollRemote(["sudo", "-n", "systemctl", "restart", "docker"])).code === 0, "Docker did not restart without the runtime")
  // Listed the way they were found above, while the helper image is still there to list them.
  const tables = await nft(["list", "tables"])
  expect(tables.code === 0 && !tables.out.includes("paddock"), `Paddock's firewall tables remained, or could not be listed: ${tables.out}${tables.err}`)
  const removed =await enrollRemote(["sudo", "-n", "sh", "-c", `rm -f /usr/local/bin/paddock /etc/systemd/system/${service} /etc/systemd/system/${service}.paddock-* /etc/docker/daemon.json.paddock-* && systemctl daemon-reload && rm -rf /opt/paddock /var/lib/paddock/${uid} && rmdir /var/lib/paddock`])
  expect(removed.code === 0, removed.err)
  const images = await enrollRemote(["sudo", "-n", "docker", "images", "--filter", "reference=paddock-helper:*", "--format", "{{.Repository}}:{{.Tag}}"])
  if (images.out.trim()) expect((await enrollRemote(["sudo", "-n", "docker", "rmi", ...images.out.trim().split("\n")])).code === 0, "the helper image was still in use")
  // Nothing of Paddock's is left where it installs, in systemd, in Docker or in the kernel's firewall.
  const left = await enrollRemote(["sudo", "-n", "sh", "-c", `find /etc /opt /usr/local /var/lib /tmp -xdev \\( -path /var/lib/docker -o -path /var/lib/containerd \\) -prune -o \\( -iname "*paddock*" -o -iname "*gvisor*" \\) -print; systemctl list-unit-files "paddock*" --no-legend; docker ps -a --filter label=dev.paddock.name --format "{{.Names}}"; docker network ls --format "{{.Name}}" | grep -i paddock; docker volume ls -q | grep -i paddock; docker images --format "{{.Repository}}" | grep -i paddock; docker info --format "{{json .Runtimes}}" | grep -o paddock-runsc; echo searched`])
  expect(left.out.trim() === "searched", `the uninstall left, or the search failed: ${left.out}${left.err}`)
  const after = JSON.parse((await enrollRemote(["cat", "/etc/docker/daemon.json"])).out)
  expect(JSON.stringify(after) === JSON.stringify(config) && after.labels?.includes("paddock-enrollment-eval=preserve"), "the uninstall changed unrelated Docker settings")
  expect((await enrollRemote(["sudo", "-n", "docker", "run", "--rm", "alpine:latest", "true"])).code === 0, "the engine does not run a container after the uninstall")
  return `${ENROLL_HOST}: unit, release, runtime, state, backups, firewall tables and helper image removed; pulled sandbox images and distro Docker packages retained; fixture can be deleted`
})

ev("N20", "The installer takes from a downloaded archive only the files the plan names, each with its planned checksum, and runs no step when the archive, the staging folder or the destination is not what the plan says", async () => {
  const folder = join(tmp, "installer"); await mkdir(join(folder, "state"), { recursive: true })
  // The planned archive, and ones with other bytes in a file, an entry that climbs out, a link, and a file missing.
  const archives = await sh(["python3", "-c", `
import hashlib, io, json, sys, tarfile

folder = sys.argv[1]
files = [('runsc', b'runtime'), ('gvisor-bin/sentry', b'sentry')]

def archive(name, members):
    path = folder + '/' + name + '.tar.bz2'
    with tarfile.open(path, 'w:bz2') as tar:
        directory = tarfile.TarInfo('gvisor-bin')
        directory.type = tarfile.DIRTYPE
        tar.addfile(directory)
        for member, content in members:
            info = tarfile.TarInfo(member)
            if content is None:
                info.type = tarfile.SYMTYPE
                info.linkname = '/etc/passwd'
                tar.addfile(info)
            else:
                info.size = len(content)
                tar.addfile(info, io.BytesIO(content))
    return hashlib.sha512(open(path, 'rb').read()).hexdigest()

print(json.dumps(dict(
    files={member: hashlib.sha256(content).hexdigest() for member, content in files},
    checksums=dict(
        planned=archive('planned', files),
        changed=archive('changed', [('runsc', b'other'), files[1]]),
        climbing=archive('climbing', files + [('../escape', b'x')]),
        link=archive('link', [files[1], ('runsc', None)]),
        missing=archive('missing', files[:1])))))
`, folder])
  expect(archives.code === 0, `could not make the control archives: ${archives.err}`)
  const { files, checksums } = JSON.parse(archives.out) as { files: Record<string, string>; checksums: Record<string, string> }
  const destination = { machine: "m", uid: 501 }; const installed = join(folder, "installed"); const stage = join(folder, "stage")
  // The installer itself, on this machine, with one unprivileged step that copies what was staged.
  const install = async (archive: string, change: { checksum?: string; probed?: object } = {}) => {
    await rm(installed, { recursive: true, force: true })
    const run = await sh(["python3", "-c", HOST_APPLY], { stdin: JSON.stringify({
      hash: "0".repeat(64), stateDir: join(folder, "state"), stageDir: stage, changes: [], destination: { ...destination, hostKey: "SHA256:control" },
      uploads: [{ kind: "download", name: "gvisor.tar.bz2", algorithm: "sha512", checksum: change.checksum ?? checksums[archive], url: `file://${folder}/${archive}.tar.bz2`, extract: { directory: "gvisor", files } }],
      probeScript: `import sys\nsys.stdout.write(${JSON.stringify(JSON.stringify(change.probed ?? destination))})`, probeRequest: {},
      steps: [{ label: "Copy what was staged", argv: ["cp", "-R", `${stage}/gvisor`, installed], leaves: [installed] }],
    }) })
    const copied = await Bun.file(join(installed, "runsc")).exists()
    return { code: run.code, report: JSON.parse(run.out.trim().split("\n").at(-1)!) as { ok: boolean; stale?: boolean; error?: string; completed: string[] }, copied, staged: await Bun.file(stage).exists() || (await sh(["test", "-e", stage])).code === 0 }
  }
  const good = await install("planned")
  expect(good.code === 0 && good.report.ok && good.report.completed.length === 1 && good.copied, `the planned archive was not installed: ${JSON.stringify(good.report)}`)
  expect(await readFile(join(installed, "gvisor-bin", "sentry"), "utf8") === "sentry" && !good.staged, "the planned files were not what was staged, or staging remained")
  const refusals: Array<[string, Parameters<typeof install>[1], string]> = [
    ["changed", {}, "file runsc checksum mismatch"], ["climbing", {}, "unexpected entry '../escape'"], ["link", {}, "unexpected entry 'runsc'"], ["missing", {}, "lacks gvisor-bin/sentry"],
    ["changed", { checksum: checksums.planned }, "gvisor.tar.bz2 checksum mismatch"],
  ]
  for (const [archive, change, reason] of refusals) {
    const refused = await install(archive, change)
    expect(refused.code === 1 && !refused.report.ok && refused.report.error?.includes(reason) && refused.report.error.includes("nothing installed"), `the ${archive} archive was not refused for "${reason}": ${JSON.stringify(refused.report)}`)
    expect(!refused.copied && refused.report.completed.length === 0 && !refused.staged && !await Bun.file(join(folder, "escape")).exists(), `the ${archive} archive ran a step, left staging or wrote outside it`)
  }
  // A destination that no longer answers the probe as the plan recorded it: nothing runs, and the reply says stale.
  const stale = await install("planned", { probed: { ...destination, machine: "another" } })
  expect(stale.code === 0 && stale.report.stale === true && !stale.report.ok && !stale.copied && !stale.staged, `a destination that changed after consent was installed on: ${JSON.stringify(stale.report)}`)
  // A staging folder someone else made first is not used, and not removed.
  await mkdir(stage); await writeFile(join(stage, "planted"), "x")
  const planted = await install("planned")
  expect(planted.code === 1 && !planted.report.ok && !planted.copied && await Bun.file(join(stage, "planted")).exists(), `a staging folder that already existed was used or removed: ${JSON.stringify(planted.report)}`)
  await rm(stage, { recursive: true })
  return `the planned archive installed; ${refusals.length} altered archives, a changed destination and a planted staging folder ran no step`
})

ev("Z01", "Nothing is left on the engine or this machine when the run ends", async () => {
  // Control: the scan sees this run's daemon while it runs, so an empty scan after teardown means none is left.
  await pdk(["list"])
  const live = (await daemonFile()).pid
  expect((await evalDaemons()).includes(live), `the process scan does not see this run's daemon (pid ${live})`)
  await teardown()
  const containers = (await docker(["ps", "-a", "--format", "{{.Names}} {{.Labels}}"])).out.split("\n").filter((line) => line.includes(PREFIX) || line.includes("dev.paddock.probe"))
  const networks = (await docker(["network", "ls", "--format", "{{.Name}}"])).out.split("\n").filter((line) => line.includes(PREFIX) || line.startsWith("paddock-net-probe-"))
  // A network namespace takes a moment to go after its container.
  const leftLinks = async () => (await asRoot("ip -br link")).out.split("\n").filter((line) => line.startsWith(PREFIX) || /^pv[0-9a-f]{8}/.test(line))
  await until(async () => (await leftLinks()).length === 0, 15)
  const links = await leftLinks()
  const processes = [(await sh(["pgrep", "-fl", tmp])).out.trim(), ...(await evalDaemons()).map((pid) => `paddock daemon run (pid ${pid})`)].filter(Boolean)
  // Templates: the same scan found this run's template images while they existed (C01).
  const images = [...(await templateImages()).map((image) => `template image ${image.tags.join(",") || image.id}`),
    ...(templateOwner ? (await docker(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])).out.split("\n").filter((line) => line.startsWith(`paddock-snapshot-${templateOwner}`) || line.startsWith(`paddock-template-${templateOwner}:${PREFIX}`) || line.includes(`${PREFIX}-other`)) : []),
    ...(await docker(["ps", "-a", "--format", "{{.Names}}"])).out.split("\n").filter((line) => templateOwner && line.startsWith(`paddock-snapshot-${templateOwner}-`))]
  expect(!containers.length && !networks.length && !links.length && !processes.length && !images.length, `left behind: ${[...containers, ...networks, ...links, ...processes, ...images].join(", ")}`)
  return templateScanSaw ? `the template scan saw ${templateScanSaw} image(s) during the run and none after it` : "no template was made in this run"
})

// A daemon's command line is only `paddock daemon run`; its state folder is in its environment, which ps shows for the
// user's own processes. Every state folder the evals use is under tmp.
async function evalDaemons(): Promise<number[]> {
  const listed = await sh(process.platform === "darwin" ? ["ps", "-axEww", "-o", "pid=,command="] : ["ps", "axeww", "-o", "pid=,command="])
  return listed.out.split("\n").filter((line) => line.includes(" daemon run") && line.includes(`PADDOCK_STATE_DIR=${tmp}`)).map((line) => Number(line.trim().split(/\s+/)[0]))
}
const killDaemons = async () => { for (const pid of await evalDaemons()) try { process.kill(pid, "SIGKILL") } catch {} }

let tornDown = false
async function teardown(): Promise<void> {
  if (tornDown) return
  tornDown = true
  await workspaceEvals.close()
  if (remoteDir) {
    for (const name of [MS, MC]) await remotePdk(["remove", name, "--confirm", name])
    const templates = await remotePdk(["--json", "template", "list"])
    for (const template of JSON.parse(templates.out || "{}").data ?? []) if (template.name.startsWith(PREFIX)) await remotePdk(["template", "remove", template.name])
    await pdk(["host", "remove", MH, "--confirm", MH])
    await remotePdk(["daemon", "stop"])
    const left = await remoteDocker(["ps", "-a", "--format", "{{.Names}}"])
    expect(!left.out.split("\n").some((name) => name.includes(PREFIX)), `remote fixture left a container: ${left.out}`)
    await remote(["rm", "-rf", remoteDir])
    remoteDir = ""
  }
  for (const sandbox of ((await pdkJson(["list"]).catch(() => undefined))?.reply.data ?? []) as Array<{ name: string }>) await pdk(["remove", sandbox.name, "--confirm", sandbox.name])
  for (const template of ((await pdkJson(["template", "list"]).catch(() => undefined))?.reply.data ?? []) as Array<{ name: string }>) await pdk(["template", "remove", template.name])
  await pdk(["daemon", "stop"])
  for (const image of await templateImages().catch(() => [])) await docker(["rmi", "-f", ...image.tags, image.id])
  await docker(["rm", "-f", HOST])
  for (const line of (await docker(["ps", "-a", "--format", "{{.Names}}"])).out.split("\n").filter((name) => name.includes(PREFIX))) await docker(["rm", "-f", "-v", line])
  for (const line of (await docker(["network", "ls", "--format", "{{.Name}}"])).out.split("\n").filter((name) => name.includes(PREFIX))) await docker(["network", "rm", line])
}

// ---- run
const wanted = evals.filter((entry) => !only || only.some((key) => entry.id === key || (key.length === 1 && entry.id.startsWith(key))) || entry.id === "Z01" || entry.id === "K15" && only.some((key) => key.startsWith("K")))
console.error(`Building, and starting a Paddock of its own in ${tmp} (sandboxes are named ${PREFIX}-…)`)
const build = await sh([BUN, "build", "--compile", "--minify", "--outfile", BIN, "cli/cli.ts"], { cwd: ROOT })
if (build.code !== 0) { console.error(build.err); process.exit(1) }
await mkdir(env.PADDOCK_CONFIG_DIR, { recursive: true })
await writeFile(join(env.PADDOCK_CONFIG_DIR, "config.json"), JSON.stringify({ requireProbes: true, defaults: { image: "alpine:latest", cpus: 0.5, memoryGb: 0.5, diskGb: 1 } }))
const engines = (await pdkJson(["doctor"])).reply.data as Array<{ id: string; label: string; ready: boolean; data: { context: string; runtime: string }; capabilities?: { diskLimit: string } }>
const engine = engines.find((entry) => entry.ready)
if (!engine) { console.error("No engine is ready. Run `paddock doctor`."); process.exit(1) }
context = engine.data.context
// The tamper evals change the guard for the whole engine, which would stop sandboxes of the user's own Paddock.
const others = (await docker(["ps", "--filter", "label=dev.paddock.name", "--format", "{{.Names}}"])).out.trim()
if (others) { console.error(`Other Paddock sandboxes are running on this engine (${others.replace(/\n/g, ", ")}). The evals tamper with the guard they share, so stop them first.`); process.exit(1) }
// The one engine-side Docker Hub pull, only when the image is missing. evals/README.md counts the rest.
if ((await docker(["image", "inspect", "alpine:latest"])).code !== 0) await docker(["pull", "-q", "alpine:latest"], { timeoutMs: 300_000 })

type Outcome = { id: string; claim: string; result: "pass" | "fail" | "not measured"; note: string; seconds: number }
const outcomes: Outcome[] = []
let workspaceControl = false
const interrupted = () => { void teardown().then(killDaemons).then(() => process.exit(130)) }
process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted)
for (const entry of wanted) {
  const start = Date.now(); let result: Outcome["result"] = "pass"; let note = ""
  try {
    if (entry.id.startsWith("K") && entry.id !== "K15" && !workspaceControl) skip("K15's finder control did not pass; workspace lifecycle evals are disabled.")
    note = (await Promise.race([entry.run(), Bun.sleep(420_000).then(() => { throw new Error("no result after 7 minutes") })])) ?? ""
  }
  catch (error) { result = error instanceof Skip ? "not measured" : "fail"; note = (error as Error).message }
  if (entry.id === "K15") workspaceControl = result === "pass"
  outcomes.push({ id: entry.id, claim: entry.claim, result, note, seconds: Math.round((Date.now() - start) / 1000) })
  console.error(`${result === "pass" ? "✓" : result === "fail" ? "✗" : "–"} ${entry.id} ${entry.claim}${note ? `\n      ${note}` : ""}`)
}
await teardown()
// Z01 has already failed for any daemon still alive; none may outlive the run.
await killDaemons()
await rm(tmp, { recursive: true, force: true })

const passed = outcomes.filter((entry) => entry.result === "pass").length; const failed = outcomes.filter((entry) => entry.result === "fail").length
const unmeasured = outcomes.length - passed - failed
const summary = `${passed} of ${outcomes.length} hold, ${failed} do not, ${unmeasured} could not be measured here`
console.log(`\n${summary}`)
if (args.includes("--write")) {
  const version = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version
  const commit = process.env.PADDOCK_EVAL_REVISION ?? (await sh(["git", "rev-parse", "--short", "HEAD"], { cwd: ROOT })).out.trim(); const dirty = (await sh(["git", "status", "--porcelain", "--", "core", "cli", "ui", "skill", "extensions"], { cwd: ROOT })).out.trim() ? " plus uncommitted changes" : ""
  const mark = { pass: "✓", fail: "✗", "not measured": "–" }
  await writeFile(join(ROOT, `evals/SCORECARD${scoreLabel ? `.${scoreLabel}` : ""}.md`), `# Scorecard

Written by \`bun evals/run.ts --write${scoreLabel ? ` --label ${scoreLabel}` : ""}\`. Do not edit by hand.

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
