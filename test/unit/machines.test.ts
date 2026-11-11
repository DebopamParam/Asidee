import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandler } from "../../core/daemon"
import { CATALOG, compatible, hostName, hostOption, machineIdentity, Machines, parseHello, parseHosts, parseSummary, staleSummary, type Hello, type HostRecord, type MachineSummary } from "../../core/machines"
import { MAX_REPLY, parseReply, sshArgv, sshDestination, transportCommand } from "../../core/transport"
import { PaddockError, type ErrorCode } from "../../core/types"

const LOCAL: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: ["machines"] }
const REMOTE: Hello = { ...LOCAL, machineId: "d".repeat(32), bootId: "e".repeat(32) }
const HOST: HostRecord = { name: "build", ssh: "home-linux", binary: "/opt/paddock/bin", stateDir: "/home/me/state", machineId: REMOTE.machineId, addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "prepared" }
const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pdk-machines-")); folders.push(root)
  const dirs = { state: join(root, "s"), config: join(root, "c") }
  await mkdir(dirs.config)
  return dirs
}
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
  expect(parseHosts({ version: 1, hosts: [HOST] })).toEqual([HOST])
  for (const value of [{}, { version: 2, hosts: [] }, { version: 1, hosts: [HOST, HOST] }, { version: 1, hosts: [{ ...HOST, binary: "relative" }] }, { version: 1, hosts: [{ ...HOST, machineId: "bad" }] }]) expect(() => parseHosts(value)).toThrow()
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
  compatible(REMOTE, LOCAL.version, HOST.machineId)
  for (const [hello, expected] of [[{ ...REMOTE, version: "old" }, "incompatible"], [{ ...REMOTE, protocols: [2] }, "incompatible"], [{ ...REMOTE, machineId: LOCAL.machineId }, "identity-changed"]] satisfies Array<[Hello, ErrorCode]>) {
    try { compatible(hello, LOCAL.version, HOST.machineId); throw new Error("accepted") } catch (error) { expect(error).toBeInstanceOf(PaddockError); expect((error as PaddockError).code).toBe(expected) }
  }
  for (const value of [null, {}, { ...REMOTE, buildDigest: "mtime" }, { ...REMOTE, methods: [1] }, { ...REMOTE, protocols: ["1"] }]) expect(() => parseHello(value)).toThrow()
  for (const value of [null, {}, { ok: true }, { ok: false, error: { code: "made-up", message: "bad" } }]) expect(() => parseReply(value)).toThrow()
  expect(MAX_REPLY).toBe(8 * 1024 ** 2)
})

test("routing strips the host, handshakes first and never retries a mutation or falls back locally", async () => {
  const dirs = await setup(); const calls: Array<{ method: string; body: object }> = []; let closed = 0; let bad: Hello | undefined
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), () => ({ async close() { closed++ }, async call(method, body = {}) { calls.push({ method, body }); if (method === "hello") return bad ?? REMOTE; if (method === "stop") throw new PaddockError("outcome-unknown", "link lost"); return "remote" } }))
  await machines.attach(HOST)
  expect((await stat(join(dirs.config, "hosts.json"))).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(join(dirs.config, "hosts.json"), "utf8")).hosts[0].machineId).toBe(REMOTE.machineId)
  calls.length = 0
  expect(await machines.route("get", { host: "build", name: "demo" })).toBe("remote")
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
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), () => { connected++; throw new Error("should not connect") })
  const table = Object.fromEntries(Object.entries(CATALOG).map(([method, [access]]) => [method, { run: async () => "local", socketOnly: access === "socket" }]))
  const handle = createHandler(table, "token", dirs.config, machines)
  for (const method of ["hello", "sshSetup", "shutdown", "hostAttach", "hostRemove"]) {
    const response = await handle(new Request(`http://127.0.0.1:7717/api/${method}`, { method: "POST", headers: { host: "127.0.0.1:7717", authorization: "Bearer token" }, body: JSON.stringify({ host: "build", name: "demo" }) }), false, 7717)
    expect(response.status).toBe(403)
  }
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
  const machines = new Machines(dirs, LOCAL, async () => summary(LOCAL), () => ({ async close() {}, async call(method) { if (fail) throw new PaddockError("offline", "unreachable"); return method === "hello" ? REMOTE : summary() } }))
  await machines.attach(HOST); await machines.list()
  fail = true; await machines.list()
  const fleet = await machines.fleet()
  expect(fleet.machines[0]?.machine.state).toBe("online")
  expect(fleet.machines[1]).toMatchObject({ machine: { state: "offline" }, stale: true, cached: { sandboxes: [{ name: "demo", status: "unknown" }] } })
})
