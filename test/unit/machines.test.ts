import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { connect, createServer, type Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler } from "../../core/daemon"
import type { Core } from "../../core/core"
import { Hosts } from "../../core/hosts"
import { CATALOG, compatible, type MachineIo, hostName, hostOption, machineIdentity, Machines, parseHello, parseHosts, parseSummary, staleSummary, type Hello, type HostRecord, type MachineSummary } from "../../core/machines"
import { frame, FrameReader, type Frame } from "../../core/stream"
import { MAX_REPLY, parseReply, RemoteSession, sshArgv, sshDestination, transportCommand } from "../../core/transport"
import { AsideeError, type ErrorCode } from "../../core/types"

const LOCAL: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "9".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: ["machines", "remote-streams", "remote-forwards", "lease-renewal"] }
const REMOTE: Hello = { ...LOCAL, machineId: "d".repeat(32), bootId: "e".repeat(32) }
const HOST: HostRecord = { name: "build", ssh: "home-linux", binary: "/opt/asidee/bin", stateDir: "/home/me/state", machineId: REMOTE.machineId, addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "prepared" }
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
// Other machines are experimental, so each test that uses them turns the setting on, as a person would.
async function setup(experimental = true) {
  const root = await mkdtemp(join(tmpdir(), "asd-machines-")); folders.push(root)
  const dirs = { state: join(root, "s"), config: join(root, "c") }
  await mkdir(dirs.config)
  if (experimental) await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: true }))
  return dirs
}
const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8"
const identity: Partial<MachineIo> = { sshIdentity: async () => ({ user: "builder", hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: PUBLIC_KEY }) }
// This machine's sandboxes as routed requests see them (daemon.ts, routedRun): every one shared.
const SHARED = { visible: async () => {}, list: async () => [] } as unknown as Core
const summary = (hello = REMOTE): MachineSummary => ({ hello, checkedAt: "2026-11-11T00:00:00Z", sandboxes: [{ machineId: hello.machineId, sandboxId: "f".repeat(32), name: "demo", status: "running", engine: "remote-engine", createdAt: "2026-11-11",
  spec: { name: "demo", image: "alpine", cpus: 1, memoryGb: 1, diskGb: 1, pids: 512, docker: false }, lastVerify: { at: "2026-11-11", results: [{ id: "kernel", status: "pass", evidence: "probed", detail: "remote probe" }] } }] })

test("--host selects exactly one host anywhere before -- and preserves guest argv", () => {
  for (const argv of [["--host", "build", "exec", "demo", "--", "echo", "--host", "guest"], ["exec", "--host=build", "demo", "--", "echo", "--host", "guest"]])
    expect(hostOption(argv)).toEqual({ host: "build", argv: ["exec", "demo", "--", "echo", "--host", "guest"] })
  expect(hostOption(["--host", "local", "list"]).host).toBe("local")
  for (const args of [["list", "--host"], ["list", "--host="], ["--host", "a", "--host", "b"], ["--host", "Bad"]]) expect(() => hostOption(args)).toThrow()
})

test("host records reject destinations, paths, identities and aliases that can change transport meaning", () => {
  for (const value of ["local", "../a", "UPPER", "a.b", "-a", "a\nfoo"]) expect(() => hostName(value)).toThrow()
  for (const value of ["-oProxyCommand=id", "host -p 22", "a;id", "$(id)", "user@-host", "a\nb", "a@b@c"]) expect(() => sshDestination(value)).toThrow()
  expect(sshDestination("alice@build.example")).toBe("alice@build.example")
  expect(parseHosts({ version: 1, hosts: [HOST] }).hosts).toEqual([HOST])
  const pinned = { ...HOST, hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: PUBLIC_KEY }
  expect(parseHosts({ version: 1, hosts: [pinned] }).hosts).toEqual([pinned])
  for (const value of [{}, { version: 2, hosts: [] }]) expect(() => parseHosts(value)).toThrow()
  for (const value of [{ version: 1, hosts: [HOST, HOST] }, { version: 1, hosts: [{ ...HOST, binary: "relative" }] }, { version: 1, hosts: [{ ...HOST, machineId: "bad" }] }, { version: 1, hosts: [{ ...HOST, hostKey: "SHA256:short" }] }, { version: 1, hosts: [{ ...HOST, hostKey: `SHA256:${"A".repeat(43)}`, hostPublicKey: PUBLIC_KEY }] }, { version: 1, hosts: [{ ...HOST, hostPublicKey: PUBLIC_KEY }] }])
    expect(parseHosts(value).unknown).toHaveLength(1)
  const argv = sshArgv(HOST.ssh, transportCommand({ ...HOST, binary: "/path/a'b" }))
  for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "UpdateHostKeys=no", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "ControlMaster=no", "ControlPath=none"]) expect(argv).toContain(option)
  expect(argv.at(-1)).toContain("'/path/a'\\''b'")
  expect(argv.join(" ")).not.toMatch(/-L|-R|-D|StrictHostKeyChecking=no/)
})

test("machine identity persists across daemon boots and refuses damage", async () => {
  const dirs = await setup()
  const first = await machineIdentity(dirs)
  expect(await machineIdentity(dirs)).toBe(first)
  expect((await stat(join(dirs.state, "machine-id"))).mode & 0o777).toBe(0o600)
  await writeFile(join(dirs.state, "machine-id"), "broken")
  await expect(machineIdentity(dirs)).rejects.toThrow("damaged")
})

test("handshake refuses incompatible versions, protocols, identity changes and malformed replies", () => {
  expect(parseHello(REMOTE)).toEqual(REMOTE)
  compatible(REMOTE, LOCAL, HOST.machineId)
  for (const [hello, expected] of [[{ ...REMOTE, version: "old" }, "incompatible"], [{ ...REMOTE, protocols: [2] }, "incompatible"], [{ ...REMOTE, machineId: LOCAL.machineId }, "identity-changed"]] satisfies Array<[Hello, ErrorCode]>) {
    try { compatible(hello, LOCAL, HOST.machineId); throw new Error("accepted") } catch (error) { expect(error).toBeInstanceOf(AsideeError); expect((error as AsideeError).code).toBe(expected) }
  }
  for (const value of [null, {}, { ...REMOTE, buildDigest: "mtime" }, { ...REMOTE, sourceDigest: undefined }, { ...REMOTE, listener: "public" }, { ...REMOTE, methods: [1] }, { ...REMOTE, protocols: ["1"] }]) expect(() => parseHello(value)).toThrow()
  for (const value of [null, {}, { ok: true }, { ok: false, error: { code: "made-up", message: "bad" } }]) expect(() => parseReply(value)).toThrow()
  expect(MAX_REPLY).toBe(8 * 1024 ** 2)
})

test("routing strips the host, handshakes first and never retries a mutation or falls back locally", async () => {
  const dirs = await setup(); const calls: Array<{ method: string; body: object }> = []; let closed = 0; let bad: Hello | undefined
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: () => ({ async close() { closed++ }, async call(method: string, body: object = {}) { calls.push({ method, body }); if (method === "hello") return bad ?? REMOTE; if (method === "stop") throw new AsideeError("outcome-unknown", "link lost"); return summary().sandboxes[0] } }) })
  await machines.attach(HOST)
  expect((await stat(join(dirs.config, "hosts.json"))).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(join(dirs.config, "hosts.json"), "utf8")).hosts[0].machineId).toBe(REMOTE.machineId)
  calls.length = 0
  expect(await machines.route("get", { host: "build", name: "demo" })).toMatchObject({ name: "demo", status: "running" })
  expect(calls).toEqual([{ method: "hello", body: {} }, { method: "get", body: { name: "demo" } }])
  calls.length = 0
  await expect(machines.route("stop", { host: "build", name: "demo" })).rejects.toThrow("link lost")
  expect(calls.filter((call) => call.method === "stop")).toHaveLength(1)
  calls.length = 0
  await expect(machines.route("get", { host: "missing", name: "demo" })).rejects.toThrow("No local fallback")
  expect(calls).toHaveLength(0)
  bad = { ...REMOTE, version: "old" }
  await expect(machines.route("create", { host: "build", name: "demo" })).rejects.toThrow("incompatible")
  expect(calls.map((call) => call.method)).toEqual(["hello"])
  expect(closed).toBe(4)
})

test("a dashboard request cannot gain socket authority by routing it", async () => {
  const dirs = await setup(); let connected = 0
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { connectPeer: () => { connected++; throw new Error("should not connect") } })
  const table = Object.fromEntries(Object.entries(CATALOG).map(([method, [access]]) => [method, { run: async () => "local", socketOnly: access === "socket", ...(access === "approve" ? { approve: () => ({ action: method, cli: method }) } : {}) }]))
  // Approvable methods are asked on the Mac before any routing; here the person denies.
  const asked: string[] = []
  const handle = createHandler(table, "token", dirs.config, machines, async (approval) => { asked.push(approval.cli); return "deny" })
  for (const method of ["hello", "hostPlan", "hostApply", "sshPrepare", "sshSetup", "shutdown", "hostAttach", "hostRemove", "terminalCommandSet"]) {
    const response = await handle(new Request(`http://127.0.0.1:7717/api/${method}`, { method: "POST", headers: { host: "127.0.0.1:7717", authorization: "Bearer token" }, body: JSON.stringify({ host: "build", name: "demo" }) }), false, 7717)
    expect(response.status).toBe(403)
  }
  expect(asked).toEqual(["sshSetup", "shutdown", "hostAttach", "hostRemove", "terminalCommandSet"])
  expect(connected).toBe(0)
})

test("bad summaries cannot replace evidence; stale sandboxes and checks are unknown", () => {
  const parsed = parseSummary(summary(), REMOTE)
  const stale = staleSummary(parsed)
  expect(stale.sandboxes[0]?.status).toBe("unknown")
  expect(stale.sandboxes[0]?.lastVerify?.results[0]).toMatchObject({ status: "unknown", evidence: "none" })
  expect(parsed.sandboxes[0]?.status).toBe("running")
  for (const value of [null, {}, { ...summary(), hello: LOCAL }, { ...summary(), sandboxes: [{ ...summary().sandboxes[0], machineId: LOCAL.machineId }] }]) expect(() => parseSummary(value, REMOTE)).toThrow()
})

test("fleet returns while a failed host refresh is pending and retains unknown last-known sandboxes", async () => {
  const dirs = await setup(); let fail = false
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: () => ({ async close() {}, async call(method: string) { if (fail) throw new AsideeError("offline", "unreachable"); return method === "hello" ? REMOTE : summary() } }) })
  await machines.attach(HOST); await machines.list()
  fail = true; await machines.list()
  const fleet = await machines.fleet()
  expect(fleet.machines[0]?.machine.state).toBe("online")
  expect(fleet.machines[1]).toMatchObject({ machine: { state: "offline" }, stale: true, cached: { sandboxes: [{ name: "demo", status: "unknown" }] } })
})

// ---- fixtures for the remote side: buffered calls by a table, streams over a local socket that records what arrives

const ROW = summary().sandboxes[0]!
const TARGET = { name: "demo", machineId: REMOTE.machineId, sandboxId: ROW.sandboxId!, generation: "run-1" }
type Answer = (method: string, body: Record<string, unknown>, options: Record<string, unknown>) => unknown
const answers = (extra: Record<string, unknown> = {}): Answer => (method) => method in extra ? extra[method] : ({ hello: REMOTE, get: ROW, list: [ROW], summary: summary(), sessionTarget: TARGET } as Record<string, unknown>)[method]
function fakePeers(answer: Answer) {
  const log = { connected: 0, calls: [] as Array<{ method: string; body: Record<string, unknown>; options: Record<string, unknown> }> }
  const connectPeer = () => { log.connected++; return { async close() {}, async call(method: string, body: object = {}, options: object = {}) { log.calls.push({ method, body: body as Record<string, unknown>, options: options as Record<string, unknown> }); return await answer(method, body as Record<string, unknown>, options as Record<string, unknown>) } } }
  return { log, connectPeer }
}
const opened: Array<{ request: Record<string, unknown>; frames: Frame[]; session: RemoteSession }> = []
const servers: Array<() => void> = []
afterEach(() => { for (const close of servers.splice(0)) close(); opened.length = 0 })
async function openStream(_endpoint: unknown, request: object): Promise<RemoteSession> {
  const root = await mkdtemp(join(tmpdir(), "asd-stream-")); folders.push(root); const path = join(root, "s.sock")
  const record = { request: request as Record<string, unknown>, frames: [] as Frame[], session: undefined as unknown as RemoteSession }
  const server = createServer((socket: Socket) => { const reader = new FrameReader(); let first = true; socket.on("error", () => {})
    socket.on("data", (chunk) => { for (const got of reader.push(chunk as Buffer)) { record.frames.push(got); if (first) { first = false; socket.write(frame("ready", { tty: false })) } } }) })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  const wire = connect(path); wire.on("error", () => {}); const closed = new Promise<void>((resolve) => wire.once("close", resolve))
  servers.push(() => { wire.destroy(); server.close() })
  record.session = await RemoteSession.open(HOST, request as never, { wire, diagnostic: () => "fixture", close: async () => { wire.destroy(); await closed } })
  opened.push(record); return record.session
}
const outcome = (promise: Promise<unknown>) => promise.then((value) => ({ value }), (error: AsideeError) => ({ code: error.code, message: error.message }))
async function attached(answer: Answer, io: Partial<MachineIo> = {}) {
  const dirs = await setup(); const peers = fakePeers(answer)
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: peers.connectPeer, openStream, ...io })
  await machines.attach(HOST); peers.log.calls.length = 0; peers.log.connected = 0
  return { dirs, machines, log: peers.log }
}

test("one sandbox row in a form this Asidee cannot read is shown damaged; the machine stays online with its other rows", async () => {
  const odd = { ...ROW, name: "odd", status: "paused" }
  const { machines } = await attached(answers({ summary: { ...summary(), sandboxes: [ROW, odd] } }))
  const [view] = await machines.list()
  expect(view?.state).toBe("online")
  const fleet = await machines.fleet()
  expect(fleet.machines[1]?.cached?.sandboxes.map((row) => [row.name, row.status])).toEqual([["demo", "running"], ["odd", "damaged"]])
  expect(fleet.machines[1]?.cached?.sandboxes[1]?.stopReason).toContain("cannot read")
  // A row of another machine still rejects the whole reply: it is an identity error, not damage.
  const foreign = await attached(answers({ summary: { ...summary(), sandboxes: [{ ...ROW, machineId: LOCAL.machineId }] } }))
  expect((await foreign.machines.list())[0]?.state).toBe("incompatible")
})

test("a remote reply that does not have its method's shape is refused: incompatible for a read, outcome unknown for a mutation", async () => {
  const { machines } = await attached(answers({ get: { ...ROW, status: 7 }, templateList: [{ name: "base" }], start: "remote", exec: { exitCode: "0", stdout: "", stderr: "" }, remove: { removed: 1 } }))
  expect(await outcome(machines.route("get", { host: "build", name: "demo" }))).toMatchObject({ value: { status: "damaged" } })
  expect(await outcome(machines.route("templateList", { host: "build" }))).toMatchObject({ code: "incompatible", message: expect.stringContaining("malformed") })
  for (const method of ["start", "exec", "remove"] as const)
    expect(await outcome(machines.route(method, { host: "build", name: "demo", argv: ["true"] }))).toMatchObject({ code: "outcome-unknown", message: expect.stringContaining("not retried") })
})

test("a request that names another machine identity is refused before any connection, on every routed path", async () => {
  const { machines, log } = await attached(answers())
  const other = "0".repeat(32)
  for (const method of ["get", "stop", "sshAccess", "forwardAdd", "forwardList"] as const)
    expect(await outcome(machines.route(method, { host: "build", name: "demo", port: 3000, machineId: other }))).toMatchObject({ code: "identity-changed" })
  expect(await outcome(machines.openSession({ kind: "exec", name: "demo", argv: ["true"], tty: false, host: "build", machineId: other }, async () => { throw new Error("local") }))).toMatchObject({ code: "identity-changed" })
  expect(log.connected).toBe(0); expect(opened).toHaveLength(0)
})

test("a removal that happened remotely is reported even when this machine's alias file cannot be updated", async () => {
  const { dirs, machines, log } = await attached(answers({ remove: { removed: "demo" } }))
  await mkdir(join(dirs.state, "ssh"), { recursive: true }); await writeFile(join(dirs.state, "ssh", "remotes.json"), "{}")
  const result = await machines.route("remove", { host: "build", name: "demo", confirm: "demo" }) as { removed: string; warning: string }
  expect(result.removed).toBe("demo")
  expect(result.warning).toContain("could not be updated")
  expect(log.calls.filter((call) => call.method === "remove")).toHaveLength(1)
})

test("removing a host while a list, fleet or forward waits for it leaves it out instead of failing", async () => {
  let release = () => {}; let gate = Promise.resolve()
  const hold = () => { gate = new Promise<void>((resolve) => { release = resolve }) }
  const base = answers()
  const { machines } = await attached(async (method, body, options) => { if (method === "hello") await gate; return base(method, body, options) })
  hold(); const listing = machines.list(); await Bun.sleep(20)
  await machines.remove({ name: "build", confirm: "build" }); release()
  expect(await listing).toEqual([])
  await machines.attach(HOST); await machines.list()
  let summaryGate = () => {}; const slow = new Machines(machines.dirs, LOCAL, () => new Promise((resolve) => { summaryGate = () => resolve(summary(LOCAL)) }), { ...identity, connectPeer: fakePeers(answers()).connectPeer })
  const fleet = slow.fleet(); await Bun.sleep(20)
  await slow.remove({ name: "build", confirm: "build" }); summaryGate()
  expect((await fleet).machines).toHaveLength(1)
  await machines.attach(HOST)
  let openGate = () => {}
  const opening = await attached(answers(), { openStream: async (endpoint, request) => { await new Promise<void>((resolve) => { openGate = resolve }); return openStream(endpoint, request) } })
  const adding = outcome(opening.machines.route("forwardAdd", { host: "build", name: "demo", port: 3000 })); await Bun.sleep(20)
  await opening.machines.remove({ name: "build", confirm: "build" }); openGate()
  expect(await adding).toMatchObject({ code: "conflict", message: expect.stringContaining("was removed") })
  expect(opening.machines.forwardList("build")).toEqual([])
  await opened[0]?.session.closed
})

test("removing a host ends its open sessions and forwards", async () => {
  const { machines } = await attached(answers())
  const session = await machines.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false, host: "build" }, async () => { throw new Error("local") })
  let ended = ""; session.on("end", (exit) => { ended = exit.error ?? "" }); session.resume()
  const forward = await machines.route("forwardAdd", { host: "build", name: "demo", port: 3000 }) as { id: string }
  expect(machines.forwardList("build").map((view) => view.id)).toEqual([forward.id])
  await machines.remove({ name: "build", confirm: "build" })
  await Promise.all(opened.map((record) => record.session.closed))
  expect(ended).toContain("removed")
  expect(machines.forwardList("build")).toEqual([])
})

test("the primary renews a hosted forward's lease while it lasts", async () => {
  const { machines } = await attached(answers()); machines.renewMs = 30
  await machines.route("forwardAdd", { host: "build", name: "demo", port: 3000 })
  await Bun.sleep(200)
  const lease = opened.find((record) => record.request.kind === "lease")!
  expect(lease.request).toMatchObject({ machineId: REMOTE.machineId, build: LOCAL.sourceDigest, sandboxId: TARGET.sandboxId })
  expect(lease.frames.filter((got) => got.kind === "stdin").length).toBeGreaterThanOrEqual(3)
  await machines.close()
})

test("a mutation has a finite deadline, and a client that goes away ends its SSH call with an unknown outcome", async () => {
  const { machines, log } = await attached(answers({ stop: ROW }))
  await machines.route("stop", { host: "build", name: "demo" })
  const stop = log.calls.find((call) => call.method === "stop")!
  expect(stop.options).toMatchObject({ mutation: true, build: LOCAL.sourceDigest })
  expect(Number.isFinite(stop.options.timeoutMs)).toBe(true)
  // A real HTTP peer over a socket whose daemon never answers stop.
  const root = await mkdtemp(join(tmpdir(), "asd-http-")); folders.push(root); const path = join(root, "d.sock")
  const server = Bun.serve({ unix: path, fetch: async (request) => new URL(request.url).pathname === "/api/hello" ? Response.json({ ok: true, data: REMOTE }) : new Promise<Response>(() => {}) })
  servers.push(() => server.stop(true))
  const { HttpPeer } = await import("../../core/transport")
  const io = { connectPeer: (endpoint: Parameters<MachineIo["connectPeer"]>[0]) => { const wire = connect(path); wire.on("error", () => {}); const closed = new Promise<void>((resolve) => wire.once("close", resolve)); return new HttpPeer(endpoint, { wire, diagnostic: () => "fixture", close: async () => { wire.destroy(); await closed } }) } }
  const hung = await attached(answers(), io)
  const controller = new AbortController(); const cancelled = outcome(hung.machines.route("stop", { host: "build", name: "demo" }, controller.signal))
  await Bun.sleep(100); controller.abort()
  expect(await cancelled).toMatchObject({ code: "outcome-unknown", message: expect.stringContaining("cancelled by its client") })
  const stopping = outcome(hung.machines.route("start", { host: "build", name: "demo" })); await Bun.sleep(100)
  const started = Date.now(); await hung.machines.close()
  expect(Date.now() - started).toBeLessThan(1000)
  expect(await stopping).toMatchObject({ code: "outcome-unknown", message: expect.stringContaining("primary daemon stopped") })
})

test("stopping the primary is bounded even when an SSH link never closes", async () => {
  const { machines } = await attached(answers())
  const session = await machines.openSession({ kind: "exec", name: "demo", argv: ["sh"], tty: false, host: "build" }, async () => { throw new Error("local") })
  // As a stopped ssh child would: its close never finishes.
  Object.defineProperty(session, "closed", { value: new Promise(() => {}) })
  const started = Date.now(); await machines.close()
  expect(Date.now() - started).toBeLessThan(6000)
  expect(await outcome(machines.route("get", { host: "build", name: "demo" }))).toMatchObject({ code: "conflict" })
}, 10_000)

test("the hosts file is read record by record: an unknown or damaged record is shown and refused, and the others work", async () => {
  const dirs = await setup(); const peers = fakePeers(answers())
  const later = { name: "later", ssh: "far", kind: "managed", service: "managed", diskPolicy: "hard" }
  await writeFile(join(dirs.config, "hosts.json"), JSON.stringify({ version: 1, hosts: [HOST, later, "garbage"] }))
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: peers.connectPeer, openStream })
  const views = await machines.list()
  expect(views.map((view) => [view.host.name, view.state])).toEqual([["build", "online"], ["later", "unknown-record"], ["record-3", "unknown-record"]])
  expect(views[1]?.error).toContain("does not know")
  expect((await machines.fleet()).machines.map((entry) => entry.machine.state)).toEqual(["online", "online", "unknown-record", "unknown-record"])
  peers.log.connected = 0
  expect(await outcome(machines.route("get", { host: "later", name: "demo" }))).toMatchObject({ code: "incompatible" })
  expect(peers.log.connected).toBe(0)
  expect(await outcome(machines.attach({ ...HOST, name: "later" }))).toMatchObject({ code: "conflict" })
  // Attaching another host keeps the records it does not understand exactly as they were, and records SSH's account and key.
  const second = { ...HOST, name: "second", machineId: "7".repeat(32) }
  const two = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: fakePeers((method) => method === "hello" ? { ...REMOTE, machineId: second.machineId } : undefined).connectPeer })
  expect(await two.attach(second)).toMatchObject({ sshUser: "builder", hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: PUBLIC_KEY })
  // Enrollment names the key its plan was made for; another one now is refused before anything is registered.
  expect(await outcome(two.attach({ ...second, name: "third", machineId: "8".repeat(32), hostKey: `SHA256:${"B".repeat(43)}`, hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }))).toMatchObject({ code: "identity-changed" })
  const written = JSON.parse(await readFile(join(dirs.config, "hosts.json"), "utf8")).hosts
  expect(written.slice(0, 3)).toEqual([HOST, later, "garbage"])
  await machines.remove({ name: "later", confirm: "later" })
  expect(JSON.parse(await readFile(join(dirs.config, "hosts.json"), "utf8")).hosts.map((entry: { name?: string }) => entry.name ?? entry)).toEqual(["build", "garbage", "second"])
})

test("two builds of one version are refused in both directions, saying how to update the other machine", async () => {
  try { compatible({ ...REMOTE, sourceDigest: "8".repeat(64) }, LOCAL, HOST.machineId, HOST.binary); throw new Error("accepted") } catch (error) {
    expect((error as AsideeError).code).toBe("incompatible")
    expect((error as Error).message).toContain("other source")
    expect((error as Error).message).toContain(`bun build --compile`)
    expect((error as Error).message).toContain(HOST.binary)
  }
  const dirs = await setup(); let ran = 0
  const machines = new Machines(dirs, REMOTE, async () => summary())
  const handle = createHandler({ get: { run: async () => { ran++; return ROW } } }, "token", dirs.config, machines, undefined, SHARED)
  const call = (build: string) => handle(new Request("http://asidee/api/get", { method: "POST", headers: { "x-asidee-machine": REMOTE.machineId, "x-asidee-protocol": "1", "x-asidee-version": REMOTE.version, "x-asidee-build": build }, body: JSON.stringify({ name: "demo" }) }), true, 0)
  const refused = await (await call("8".repeat(64))).json() as { ok: boolean; error: { code: string; message: string } }
  expect(refused).toMatchObject({ ok: false, error: { code: "incompatible" } }); expect(ran).toBe(0)
  expect(await (await call(REMOTE.sourceDigest)).json()).toMatchObject({ ok: true }); expect(ran).toBe(1)
})

test("closing Machines and an SSH process leaves no timer that keeps a stopping daemon alive", async () => {
  const dirs = await setup(); const bin = join(dirs.config, "bin"); await mkdir(bin)
  await writeFile(join(bin, "ssh"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 })
  const script = join(dirs.config, "close.ts")
  await writeFile(script, `import { Machines } from ${JSON.stringify(join(import.meta.dir, "../../core/machines"))}
import { sshConnection } from ${JSON.stringify(join(import.meta.dir, "../../core/transport"))}
await sshConnection(${JSON.stringify(HOST)}).close()
await new Machines(${JSON.stringify(dirs)}, ${JSON.stringify(LOCAL)}, async () => { throw new Error("unused") }).close()
console.log(Date.now())
`)
  const child = Bun.spawn([process.execPath, script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe" })
  const done = Number((await new Response(child.stdout).text()).trim()); await child.exited
  expect(child.exitCode).toBe(0)
  expect(Date.now() - done).toBeLessThan(1000)
}, 15_000)

test("with experimental off, the daemon refuses host commands and --host and contacts no machine, keeping the registry as it was", async () => {
  const dirs = await setup(false); const peers = fakePeers(answers()); let streams = 0
  const registry = JSON.stringify({ version: 1, hosts: [HOST] })
  await writeFile(join(dirs.config, "hosts.json"), registry)
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity, connectPeer: peers.connectPeer, openStream: async () => { streams++; throw new Error("should not open") } })
  const ran: string[] = []
  const table = Object.fromEntries(["hostList", "fleet", "hostAttach", "hostRemove", "hostPlan", "hostApply", "list", "forwardAdd", "sshSetup"].map((method) => [method, { run: async (body: Record<string, unknown>) => {
    ran.push(method)
    if (method === "hostList") return machines.list()
    if (method === "fleet") return machines.fleet()
    if (method === "hostAttach") return machines.attach(body)
    if (method === "hostRemove") return machines.remove(body)
    return "local"
  } }]))
  const handle = createHandler(table, "token", dirs.config, machines)
  const call = async (method: string, body: object) => await (await handle(new Request(`http://asidee/api/${method}`, { method: "POST", body: JSON.stringify(body) }), true, 0)).json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } }
  const off = { ok: false, error: { code: "dependency" as const, message: "Other machines are experimental and off on this machine: they are not yet proven on enough machines. To turn them on: asd config set experimental on" } }
  for (const [method, body] of [["hostList", {}], ["fleet", {}], ["hostAttach", { name: "other", ssh: HOST.ssh, binary: HOST.binary, stateDir: HOST.stateDir }], ["hostRemove", { name: "build", confirm: "build" }], ["list", { host: "build" }], ["forwardAdd", { host: "build", name: "demo", port: 80 }], ["sshSetup", { host: "build", name: "demo" }]] as const)
    expect(await call(method, body)).toEqual(off)
  expect(await outcome(machines.openSession({ kind: "exec", name: "demo", argv: ["true"], tty: false, host: "build" }, async () => { throw new Error("local") }))).toEqual(off.error)
  expect(await outcome(machines.route("get", { host: "build", name: "demo" }))).toEqual(off.error)
  expect(await call("list", { host: "local" })).toEqual({ ok: true, data: "local" })
  expect(ran).toEqual(["hostList", "fleet", "hostAttach", "hostRemove", "list"])
  expect(peers.log.connected).toBe(0); expect(streams).toBe(0)
  expect(await readFile(join(dirs.config, "hosts.json"), "utf8")).toBe(registry)
  // On, the same registry is used as before.
  await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: true }))
  expect(await call("list", { host: "build" })).toMatchObject({ ok: true, data: [{ name: "demo" }] })
  expect((await machines.list())[0]).toMatchObject({ state: "online" })
})

test("hosts refuse enrollment while experimental is off, before reading the artifact", async () => {
  const dirs = await setup(false)
  const hosts = new Hosts(new Machines(dirs, LOCAL, async () => summary(LOCAL)))
  for (const attempt of [hosts.plan({ name: "build", ssh: "home-linux", artifact: { path: "/nonexistent", sha256: "0".repeat(64) } }), hosts.apply({ hash: "0".repeat(64), accepted: true })])
    expect(await outcome(attempt)).toMatchObject({ code: "dependency", message: expect.stringContaining("asd config set experimental on") })
})

test("the target side answers another machine's primary whatever its own experimental setting", async () => {
  const dirs = await setup(false)
  const machines = new Machines(dirs, REMOTE, async () => summary())
  const handle = createHandler({ hello: { run: async () => REMOTE, socketOnly: true }, get: { run: async () => ROW }, summary: { run: async () => summary() } }, "token", dirs.config, machines, undefined, SHARED)
  const headers = { "x-asidee-machine": REMOTE.machineId, "x-asidee-protocol": "1", "x-asidee-version": REMOTE.version, "x-asidee-build": REMOTE.sourceDigest }
  for (const method of ["hello", "get", "summary"])
    expect(await (await handle(new Request(`http://asidee/api/${method}`, { method: "POST", headers, body: JSON.stringify({ name: "demo" }) }), true, 0)).json()).toMatchObject({ ok: true })
  let local = 0
  await machines.openSession({ kind: "exec", name: "demo", argv: ["true"], tty: false, machineId: REMOTE.machineId, bootId: REMOTE.bootId, protocol: 1, version: REMOTE.version, build: REMOTE.sourceDigest } as never, async () => { local++; return {} as never })
  expect(local).toBe(1)
})

test("an enrollment update rechecks the old record, host key and daemon identity before replacing it", async () => {
  const dirs = await setup(); let remote = REMOTE; let key = PUBLIC_KEY
  const io: Partial<MachineIo> = {
    sshIdentity: async () => ({ user: "builder", hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: key }),
    connectPeer: () => ({ async close() {}, async call() { return remote } }),
  }
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), io)
  const old = await machines.attach(HOST)
  const path = join(dirs.config, "hosts.json"); const before = await readFile(path, "utf8")
  const input = { ...old, binary: "/opt/asidee/releases/new/asd", service: "systemd" }
  remote = { ...REMOTE, machineId: "1".repeat(32) }
  await expect(machines.attach(input, undefined, old)).rejects.toMatchObject({ code: "identity-changed" })
  expect(await readFile(path, "utf8")).toBe(before)
  remote = REMOTE; key = "different-key"
  await expect(machines.attach(input, undefined, old)).rejects.toMatchObject({ code: "identity-changed" })
  expect(await readFile(path, "utf8")).toBe(before)
  key = PUBLIC_KEY
  const changed = { ...old, addedAt: "2026-11-12T00:00:00Z" }
  await expect(machines.attach(input, undefined, changed)).rejects.toThrow("registration changed")
  expect(await readFile(path, "utf8")).toBe(before)
  const updated = await machines.attach(input, undefined, old)
  expect(updated).toMatchObject({ name: old.name, machineId: old.machineId, addedAt: old.addedAt, binary: input.binary, service: "systemd" })
  expect(JSON.parse(await readFile(path, "utf8")).hosts).toEqual([updated])
  await machines.close()
})

test("host list source mismatches name host add with the registered alias and SSH destination", async () => {
  const dirs = await setup(); let remote = REMOTE
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), { ...identity,
    connectPeer: () => ({ async close() {}, async call() { return remote } }),
  })
  await machines.attach(HOST)
  remote = { ...REMOTE, sourceDigest: "1".repeat(64) }
  const [view] = await machines.list()
  expect(view).toMatchObject({ state: "incompatible" })
  expect(view?.error).toContain("asd host add build --ssh home-linux --artifact PATH --sha256 HASH")
  expect(view?.error).not.toContain("put it in place")
  await machines.close()
})

test("a link's relay to a sandbox on a host is a renewed lease plus a dial session per connection, bound to the sandbox's identity", async () => {
  const { machines, log } = await attached(answers()); machines.renewMs = 30
  expect(await machines.linkMachine("build")).toBe(REMOTE.machineId)
  expect(await machines.linkMachine("other")).toBeUndefined()
  expect(await machines.linkIdentity("build", "demo")).toEqual({ machineId: REMOTE.machineId, sandboxId: ROW.sandboxId!, running: true })
  expect(log.calls.filter((call) => call.method === "get")).toHaveLength(1)
  let ended = ""
  const relay = await machines.linkRelay({ host: "build", machineId: REMOTE.machineId, name: "demo", sandboxId: ROW.sandboxId! }, 5432, (reason) => { ended = reason })
  expect(relay.generation).toBe("run-1")
  await relay.dial(); await relay.dial()
  await Bun.sleep(150)
  const lease = opened.find((record) => record.request.kind === "lease")!
  expect(lease.request).toMatchObject({ machineId: REMOTE.machineId, sandboxId: ROW.sandboxId, generation: "run-1", port: 5432 })
  expect(lease.frames.filter((got) => got.kind === "stdin").length).toBeGreaterThanOrEqual(2)
  const dials = opened.filter((record) => record.request.kind === "dial")
  expect(dials).toHaveLength(2)
  expect(dials.every((record) => record.request.leaseId === lease.request.leaseId && record.request.port === 5432)).toBe(true)
  // Removing the host ends the lease, and the link hears why.
  await machines.remove({ name: "build", confirm: "build" })
  await lease.session.closed
  expect(ended).toBe("The remote daemon, sandbox run or SSH control link ended.")
  // A sandbox made again under the name, or a record now naming another machine, opens nothing.
  const again = await attached(answers())
  expect(await outcome(again.machines.linkRelay({ host: "build", machineId: REMOTE.machineId, name: "demo", sandboxId: "0".repeat(32) }, 5432, () => {}))).toMatchObject({ code: "identity-changed" })
  expect(await outcome(again.machines.linkRelay({ host: "build", machineId: "0".repeat(32), name: "demo", sandboxId: ROW.sandboxId! }, 5432, () => {}))).toMatchObject({ code: "identity-changed" })
  expect(opened.filter((record) => record.request.kind === "lease")).toHaveLength(1)
  await machines.close(); await again.machines.close()
})

test("a link to a private sandbox on a host is refused with that machine's own words, and a link's lookups need other machines on", async () => {
  const { privateThere } = await import("../../core/types")
  const base = answers()
  const { machines, dirs } = await attached((method, body, options) => { if (method === "get" || method === "sessionTarget") throw new AsideeError("not-found", privateThere("demo")); return base(method, body, options) })
  expect(await outcome(machines.linkIdentity("build", "demo"))).toMatchObject({ code: "not-found", message: privateThere("demo") })
  expect(await outcome(machines.linkRelay({ host: "build", machineId: REMOTE.machineId, name: "demo", sandboxId: ROW.sandboxId! }, 5432, () => {}))).toMatchObject({ message: privateThere("demo") })
  expect(opened).toHaveLength(0)
  await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: false }))
  expect(await outcome(machines.linkIdentity("build", "demo"))).toMatchObject({ code: "dependency" })
})
