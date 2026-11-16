import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKLIST } from "../../core/checks"
import { Core } from "../../core/core"
import { FIN_QUIET_MS } from "../../core/forwards"
import { LINK_CONNECTIONS, LINKS_PER_SANDBOX, pump } from "../../core/links"
import { CATALOG, LINKS_LOCAL, Machines, type Hello } from "../../core/machines"
import { type CheckResult, type Engine, type LinkSupport, type Provider, type Session, type Stage } from "../../core/types"

const engine: Engine = { id: "fake:1", provider: "fake", label: "Fake engine", ready: true, problems: [], data: {}, capabilities: { kernelIsolation: "gvisor", diskLimit: "none", networkGuard: true, docker: false, execStream: true, loopbackRelay: true, resize: "live", snapshot: false } }
const allPass = (stage: Stage): CheckResult[] => CHECKLIST.filter((item) => item.stage === stage).map((item) => ({ id: item.id, status: "pass", evidence: "inspected", detail: "ok" }))

// A session whose other end is the test: what the daemon writes is recorded, and the test makes it print or end.
class FakeSession extends EventEmitter implements Session {
  readonly tty = false; written = ""; ended = false; closed = false; inputEnded = false
  constructor(private readonly onEnd?: () => void) { super() }
  write(bytes: Uint8Array) { this.written += Buffer.from(bytes).toString(); return true }
  end() { this.inputEnded = true; this.onEnd?.() }
  async resize() {}
  pause() {}
  resume() {}
  print(text: string) { this.emit("output", "stdout", Buffer.from(text)) }
  finish(exit: { code?: number; error?: string } = { code: 0 }) { if (this.ended) return; this.ended = true; this.emit("end", exit) }
  close(reason = "closed") { this.closed = true; this.finish({ error: reason }) }
}

// Sandboxes by name on one fake engine. A link's listener, its connections and the relay into `to` are simulated far
// enough for the daemon's side to run unchanged: a connection made inside `from` is announced on the listener, waits
// for the daemon to attach to it and to dial `to`, and receives what `to`'s port answers.
function world() {
  type Box = { running: boolean; run: number; hosts: string[]; canaries: Map<number, { reply: string; everywhere: boolean }>; services: Set<number> }
  const boxes = new Map<string, Box>()
  const listeners = new Map<string, FakeSession>()
  const attached = new Map<number, { fromClient: FakeSession; toClient: FakeSession }>()
  const dialed: Array<{ name: string; port: number; session: FakeSession }> = []
  const state = { leak: false, nextPid: 100, refuseBind: false }
  const box = (name: string) => boxes.get(name)!
  const listen = (name: string, address: string, port: number) => listeners.get(`${name} ${address}:${port}`)
  const support: LinkSupport = {
    listen: async (manifest, _dir, address, port) => {
      const key = `${manifest.name} ${address}:${port}`
      const session: FakeSession = new FakeSession(() => { if (listeners.get(key) === session) listeners.delete(key); session.finish() })
      session.on("end", () => { if (listeners.get(key) === session) listeners.delete(key) })
      listeners.set(key, session)
      setTimeout(() => session.print(state.refuseBind ? "e bind\n" : "r\n"), 1)
      return session
    },
    attach: async (_manifest, _dir, pid) => {
      const halves = { fromClient: new FakeSession(), toClient: new FakeSession() }
      halves.toClient.end = () => { halves.toClient.inputEnded = true; halves.toClient.finish() }
      attached.set(pid, halves); return halves
    },
    hosts: async (manifest, lines) => { box(manifest.name).hosts = [...lines]; return `127.0.0.1\tlocalhost\n${lines.join("\n")}\n` },
    canary: async (manifest, port, reply, everywhere) => {
      box(manifest.name).canaries.set(port, { reply, everywhere })
      return new FakeSession(() => {})
    },
    dial: async (manifest, host, port) => {
      const line = box(manifest.name).hosts.find((entry) => entry.split("\t")[1] === host)
      const address = line ? line.split("\t")[0]! : host
      if (!address.startsWith("127.77.")) {
        const peer = [...boxes.values()].find((entry) => entry.canaries.get(port)?.everywhere)
        return state.leak && peer ? { connected: true, received: `${peer.canaries.get(port)!.reply}\n` } : { connected: false, received: "" }
      }
      const listener = listen(manifest.name, address, port)
      if (!listener) return { connected: false, received: "" }
      const pid = state.nextPid++
      listener.print(`o ${pid}\n`)
      for (let wait = 0; wait < 100 && !attached.get(pid)?.toClient.ended; wait++) {
        const halves = attached.get(pid)
        // The client sends nothing: its end of input reaches `to` as soon as it is attached.
        if (halves && !halves.fromClient.ended) halves.fromClient.finish()
        await Bun.sleep(5)
      }
      return { connected: true, received: attached.get(pid)?.toClient.written ?? "" }
    },
    address: async () => "10.9.0.2",
    hostDial: async (manifest, _ip, port) => { const canary = box(manifest.name).canaries.get(port); return canary?.everywhere ? `${canary.reply}\n` : "" },
  }
  const provider: Provider = {
    id: "fake",
    detect: async () => [engine],
    create: async (manifest) => { boxes.set(manifest.name, { running: false, run: 0, hosts: [], canaries: new Map(), services: new Set() }) },
    prepare: async () => {},
    start: async (manifest) => { const entry = box(manifest.name); entry.running = true; entry.run++; entry.hosts = [] },
    stop: async (manifest) => { box(manifest.name).running = false },
    remove: async (manifest) => { boxes.delete(manifest.name) },
    status: async (manifest) => !boxes.has(manifest.name) ? "missing" : box(manifest.name).running ? "running" : "stopped",
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    openExec: async () => new FakeSession(),
    generation: async (manifest) => boxes.get(manifest.name)?.running ? `${manifest.name}-run-${box(manifest.name).run}` : undefined,
    prepareLoopback: async () => {},
    // A canary answers once and ends; a service stays open; any other port refuses.
    dialLoopback: async (manifest, port) => {
      const session = new FakeSession(); const entry = box(manifest.name)
      dialed.push({ name: manifest.name, port, session })
      const canary = entry.canaries.get(port)
      setTimeout(() => { if (canary) { session.print(`${canary.reply}\n`); session.finish() } else if (!entry.services.has(port)) session.finish({ code: 1 }) }, 1)
      return session
    },
    checks: async (_manifest, stage) => allPass(stage),
    diskUsedBytes: async () => 0,
    stoppedWhy: async () => undefined,
    sweep: async () => {},
    resize: async () => undefined,
    usage: async () => undefined,
    snapshot: async () => { throw new Error("no snapshots") },
    templates: async () => [],
    removeTemplate: async () => { throw new Error("no templates") },
    links: support,
  }
  return { provider, boxes, listeners, attached, dialed, state, listen }
}

async function paddock(fake = world(), dirs?: Core["dirs"]) {
  const root = dirs ? undefined : await mkdtemp(join(tmpdir(), "paddock-links-"))
  return new Core([fake.provider], dirs ?? { state: join(root!, "state"), config: join(root!, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("names, ports and the two ends are validated in the daemon before anything is recorded", async () => {
  const core = await paddock()
  await core.create({ name: "app" }); await core.create({ name: "db" })
  for (const [from, to, port] of [["App", "db", 5432], ["app", "db;rm", 5432], ["app", "db", 0], ["app", "db", 70_000], ["app", "db", "54x"], ["app", "app", 5432], ["app", "localhost", 5432]] as const)
    await expect(core.links.add(from, to, port)).rejects.toMatchObject({ code: "usage" })
  await expect(core.links.add("app", "nobody", 5432)).rejects.toMatchObject({ code: "not-found", message: "There is no sandbox named nobody." })
  await expect(core.links.remove("app", "db", 5432)).rejects.toMatchObject({ code: "not-found" })
  expect(await core.links.list()).toEqual([])
})

test("a link opens measured, carries a connection to its port only, and says what it trusts on both ends", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.boxes.get("db")!.services.add(5432)
  const made = await core.links.add("app", "db", "5432")
  expect(made).toMatchObject({ from: "app", to: "db", port: 5432, address: "127.77.0.2", state: "open", measured: { status: "pass" } })
  expect(made.trust).toBe("db sees these connections as local (from 127.0.0.1 inside db), so a service in db that trusts local connections trusts app.")
  expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.2\tdb\t# paddock-link"])
  // The test ran on two other ports and left nothing listening in app but the link's port.
  expect([...fake.listeners.keys()]).toEqual(["app 127.77.0.2:5432"])
  const listener = fake.listen("app", "127.77.0.2", 5432)!
  listener.print("o 7\n")
  await Bun.sleep(20)
  expect(fake.dialed.at(-1)).toMatchObject({ name: "db", port: 5432 })
  expect((await core.links.list("db"))[0]).toMatchObject({ state: "open", connections: 1 })
  for (const name of ["app", "db"]) {
    const links = (await core.verify(name)).checks.find((check) => check.id === "links")!
    expect(links.detail).toContain(made.trust)
  }
  const scope = (await core.verify("db")).checks.find((check) => check.id === "link-scope")!
  expect(scope).toMatchObject({ status: "pass", evidence: "probed" })
  expect((await core.verify("app")).checks.find((check) => check.id === "net-peers")!.detail).toContain("Links are not network paths: through the daemon, this sandbox reaches db on port 5432")
})

test("a link whose test reaches what it does not name is refused at add, and cut with only the verified sandbox stopped", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.state.leak = true
  await expect(core.links.add("app", "db", 5432)).rejects.toMatchObject({ code: "check-failed", message: expect.stringContaining("app reached db at its network address 10.9.0.2") })
  expect(await core.links.list()).toEqual([])
  expect(fake.boxes.get("app")!.hosts).toEqual([])
  fake.state.leak = false
  await core.links.add("app", "db", 5432)
  fake.state.leak = true
  const verified = await core.verify("db")
  expect(verified.ok).toBe(false)
  expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "fail", detail: expect.stringContaining("The link was cut.") })
  expect((await core.get("db")).status).toBe("stopped")
  expect((await core.get("app")).status).toBe("running")
  expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
  expect(fake.listeners.size).toBe(0)
  expect(fake.boxes.get("app")!.hosts).toEqual([])
  // A cut link stays cut through restarts; adding it again measures it again.
  fake.state.leak = false
  await core.start("db")
  expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
  expect(await core.links.add("app", "db", 5432)).toMatchObject({ state: "open" })
})

test("a link that does not carry what it names is cut and reported, and stops neither sandbox, whichever is verified", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  await core.links.add("app", "db", 5432)
  // From app's side: something in app names db first in /etc/hosts, so by name the test reaches nothing.
  const hosts = fake.provider.links!.hosts
  fake.provider.links!.hosts = async (manifest, lines) => { await hosts(manifest, lines); fake.boxes.get(manifest.name)!.hosts.unshift("127.0.0.9\tdb"); return `127.0.0.9\tdb\n${lines.join("\n")}\n` }
  for (const name of ["app", "db"]) {
    const verified = await core.verify(name)
    expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "info",
      detail: expect.stringContaining("did not come through the link from app by the name db (another line of /etc/hosts in app names db first), though it answered db's own loopback. The link was cut. A link that does not carry what it names stops neither sandbox.") })
    expect(verified.ok).toBe(true)
    expect((await core.get("app")).status).toBe("running"); expect((await core.get("db")).status).toBe("running")
    expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
    expect(fake.listeners.size).toBe(0)
    fake.provider.links!.hosts = hosts
    await core.links.add("app", "db", 5432)
    fake.provider.links!.hosts = async (manifest, lines) => { await hosts(manifest, lines); fake.boxes.get(manifest.name)!.hosts.unshift("127.0.0.9\tdb"); return `127.0.0.9\tdb\n${lines.join("\n")}\n` }
  }
  fake.provider.links!.hosts = hosts
  // From db's side: its relay answers the test's own control and nothing after it, as a replaced /.paddock/busybox could.
  const dialLoopback = fake.provider.dialLoopback
  const seen = new Set<number>()
  fake.provider.dialLoopback = async (manifest, port) => {
    if (manifest.name !== "db" || port === 5432 || !seen.has(port)) { seen.add(port); return dialLoopback(manifest, port) }
    const session = new FakeSession(); setTimeout(() => session.finish({ code: 1 }), 1); return session
  }
  const verified = await core.verify("app")
  expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "info", detail: expect.stringContaining("A link that does not carry what it names stops neither sandbox.") })
  expect(verified.ok).toBe(true)
  expect((await core.get("app")).status).toBe("running"); expect((await core.get("db")).status).toBe("running")
  expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
}, 30_000)

test("a link that reaches what it does not name fails the check; one seen only inside the linking sandbox does not stop the sandbox it links to", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  await core.links.add("app", "db", 5432)
  // app's relay replays what its first dial of a port received, so the closed test route seems to answer still.
  const dial = fake.provider.links!.dial
  const received = new Map<number, string>()
  fake.provider.links!.dial = async (manifest, host, port) => {
    if (received.has(port)) return { connected: true, received: received.get(port)! }
    const result = await dial(manifest, host, port); received.set(port, result.received); return result
  }
  const excused = await core.verify("db")
  expect(excused.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "info",
    detail: expect.stringMatching(/after its test route closed, app still reached db's port \d+\. The link was cut\. This was seen only inside app, so db is not stopped for it\./) })
  expect(excused.ok).toBe(true)
  expect((await core.get("db")).status).toBe("running"); expect((await core.get("app")).status).toBe("running")
  expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
  // The same failure on app's own verify stops app, and only app.
  fake.provider.links!.dial = dial
  await core.links.add("app", "db", 5432)
  received.clear()
  fake.provider.links!.dial = async (manifest, host, port) => {
    if (received.has(port)) return { connected: true, received: received.get(port)! }
    const result = await dial(manifest, host, port); received.set(port, result.received); return result
  }
  const failed = await core.verify("app")
  expect(failed.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "fail" })
  expect(failed.ok).toBe(false)
  expect((await core.get("app")).status).toBe("stopped"); expect((await core.get("db")).status).toBe("running")
})

test("the test never uses a port another link of the pair names, so that link's answer is not taken for a leak", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  const ports = Array.from({ length: 15 }, (_, at) => 20_000 + at)
  for (const port of ports) await core.links.add("app", "db", port)
  const used: number[] = []
  const canary = fake.provider.links!.canary
  fake.provider.links!.canary = async (manifest, port, reply, everywhere) => { used.push(port); return canary(manifest, port, reply, everywhere) }
  const random = Math.random
  // The first pick lands on a named port each time.
  let calls = 0; Math.random = () => (calls++ % 2 === 0 ? (ports[calls % ports.length]! - 20_000) / 40_000 : random())
  try { await core.links.add("app", "db", 30_000) } finally { Math.random = random }
  expect(used.length).toBe(2)
  expect(used.some((port) => ports.includes(port))).toBe(false)
})

test("links are recorded: they wait while a side is stopped and open again after a start and a daemon restart", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  await core.stop("db")
  expect(await core.links.add("app", "db", 5432)).toMatchObject({ state: "waiting", reason: "db is stopped" })
  await core.start("db")
  expect((await core.links.list())[0]).toMatchObject({ state: "open" })
  await core.stop("app")
  expect(fake.listeners.size).toBe(0)
  expect((await core.links.list())[0]).toMatchObject({ state: "waiting", reason: "app is stopped" })
  await core.start("app")
  expect((await core.links.list())[0]).toMatchObject({ state: "open" })
  expect(JSON.parse(await readFile(join(core.dirs.state, "links.json"), "utf8")).links).toHaveLength(1)
  // A new daemon on the same state: the link is listed, and its first pass opens it.
  core.closeSessions()
  expect(fake.listeners.size).toBe(0)
  const again = await paddock(fake, core.dirs)
  expect((await again.links.list())[0]).toMatchObject({ from: "app", to: "db", port: 5432, state: "closed" })
  await again.enforce()
  expect((await again.links.list())[0]).toMatchObject({ state: "open" })
  again.closeSessions()
})

test("removing either sandbox removes its links, and a sandbox made again under the name inherits none", async () => {
  const fake = world(); const core = await paddock(fake)
  for (const name of ["app", "db", "cache"]) await core.create({ name })
  await core.links.add("app", "db", 5432); await core.links.add("cache", "app", 80); await core.links.add("app", "cache", 6379)
  await core.remove("db", "db")
  expect((await core.links.list()).map((link) => `${link.from}>${link.to}`)).toEqual(["cache>app", "app>cache"])
  expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.3\tcache\t# paddock-link"])
  await core.remove("app", "app")
  expect(await core.links.list()).toEqual([])
  expect(fake.listeners.size).toBe(0)
  // A record left for a name that now belongs to another sandbox is dropped, not reattached.
  await core.create({ name: "app" }); await core.create({ name: "db" })
  await core.links.add("app", "db", 5432)
  const file = join(core.dirs.state, "links.json"); const saved = await readFile(file, "utf8")
  await core.remove("db", "db"); await core.create({ name: "db" })
  await writeFile(file, saved)
  const fresh = await paddock(fake, core.dirs)
  expect(await fresh.links.list()).toEqual([])
})

test("a link closes when either sandbox restarts behind Paddock's back, and its connections check the run they were opened for", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.boxes.get("db")!.services.add(5432)
  await core.links.add("app", "db", 5432)
  const listener = fake.listen("app", "127.77.0.2", 5432)!
  fake.boxes.get("db")!.run++
  const dials = fake.dialed.length
  listener.print("o 9\n")
  await Bun.sleep(20)
  // No relay was dialed for a connection made after db's run changed; it was ended inside app.
  expect(fake.dialed.length).toBe(dials)
  expect(listener.written).toContain("x 9\n")
  await Bun.sleep(2100)
  expect((await core.links.list())[0]).toMatchObject({ state: "closed", reason: expect.stringContaining("stopped or restarted") })
  expect(listener.closed).toBe(true)
  await core.enforce()
  expect((await core.links.list())[0]).toMatchObject({ state: "open" })
  core.closeSessions()
}, 10_000)

test(`connections, links and the listener's output are bounded: ${LINK_CONNECTIONS} connections per link, ${LINKS_PER_SANDBOX} links per sandbox`, async () => {
  const fake = world(); const core = await paddock(fake)
  core.links.opensPerSecond = 1000
  const names = Array.from({ length: LINKS_PER_SANDBOX + 1 }, (_, at) => `peer${at}`)
  for (const name of ["app", "db", ...names]) await core.create({ name })
  fake.boxes.get("db")!.services.add(5432)
  await core.links.add("app", "db", 5432)
  const listener = fake.listen("app", "127.77.0.2", 5432)!
  for (let pid = 1000; pid < 1000 + LINK_CONNECTIONS + 1; pid++) listener.print(`o ${pid}\n`)
  await Bun.sleep(50)
  expect((await core.links.list())[0]).toMatchObject({ connections: LINK_CONNECTIONS })
  expect(listener.written).toContain(`x ${1000 + LINK_CONNECTIONS}\n`)
  expect(listener.written).not.toContain("x 1000\n")
  // One ends, and the next is taken.
  fake.attached.get(1000)!.toClient.finish()
  listener.print("o 2000\n")
  await Bun.sleep(20)
  expect(listener.written).toContain("x 1000\n")
  expect(listener.written).not.toContain("x 2000\n")
  for (const name of names.slice(0, LINKS_PER_SANDBOX - 1)) await core.links.add("app", name, 22)
  await expect(core.links.add("app", names.at(-1)!, 22)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining(`app already has ${LINKS_PER_SANDBOX} links`) })
  await expect(core.links.add(names.at(-1)!, "app", 22)).rejects.toMatchObject({ code: "conflict" })
  // A listener that prints anything but its few short lines is closed, with every connection it carried.
  listener.print("o 3000 and more\n")
  await Bun.sleep(20)
  expect(listener.closed).toBe(true)
  expect((await core.links.list("db"))[0]).toMatchObject({ connections: 0 })
  core.closeSessions()
}, 20_000)

test("new connections past the rate are refused inside the sandbox, not relayed", async () => {
  const fake = world(); const core = await paddock(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.boxes.get("db")!.services.add(5432)
  await core.links.add("app", "db", 5432)
  const listener = fake.listen("app", "127.77.0.2", 5432)!
  for (let pid = 1; pid <= 25; pid++) listener.print(`o ${pid}\n`)
  await Bun.sleep(30)
  expect((await core.links.list())[0]!.connections).toBe(20)
  expect(listener.written.match(/x \d+\n/g)?.length).toBe(5)
  core.closeSessions()
})

test("a link connection whose client has ended goes once TO is silent for seconds, and stays while TO's reply keeps coming", async () => {
  expect(FIN_QUIET_MS).toBeLessThanOrEqual(30_000)
  const connection = () => {
    const halves = { fromClient: new FakeSession(), toClient: new FakeSession(), target: new FakeSession() }
    let finished = 0
    halves.toClient.end = () => { halves.toClient.inputEnded = true; halves.toClient.finish() }
    pump(halves.fromClient, halves.toClient, halves.target, () => { finished++ }, 200)
    return { ...halves, finished: () => finished }
  }
  // The client sent its request and FIN; TO says nothing more.
  const idle = connection()
  idle.fromClient.finish()
  expect(idle.target.inputEnded).toBe(true)
  await Bun.sleep(100); expect(idle.finished()).toBe(0)
  await Bun.sleep(200); expect(idle.finished()).toBe(1)
  // The same, while TO's reply streams for longer than the allowed silence, never silent that long; then TO ends.
  const streaming = connection()
  streaming.fromClient.finish()
  for (let i = 0; i < 6; i++) { await Bun.sleep(100); streaming.target.print("part"); expect(streaming.finished()).toBe(0) }
  expect(streaming.toClient.written).toBe("part".repeat(6))
  streaming.target.finish()
  expect(streaming.toClient.inputEnded).toBe(true); expect(streaming.finished()).toBe(1)
})

test("links are refused for another machine in one sentence, before any machine is contacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-links-"))
  const hello: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "9".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: [] }
  let contacted = 0
  const machines = new Machines({ state: join(root, "state"), config: join(root, "config") }, hello, async () => ({ hello, sandboxes: [], checkedAt: "" }), { connectPeer: () => { contacted++; throw new Error("should not connect") } } as never)
  for (const method of ["linkAdd", "linkList", "linkRemove"] as const)
    await expect(machines.route(method, { host: "build", from: "app", to: "db", port: 5432 })).rejects.toMatchObject({ code: "usage", message: LINKS_LOCAL })
  expect(contacted).toBe(0)
  expect(LINKS_LOCAL.split(". ").length).toBe(1)
})
