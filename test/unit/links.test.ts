import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECKLIST } from "../../core/checks"
import { Core } from "../../core/core"
import { FIN_QUIET_MS } from "../../core/forwards"
import { addressTrust, dialTcp, hostedTrust, LINK_CONNECTIONS, LINKS_PER_SANDBOX, pump, RETRY_MAX_MS, RETRY_MS, validAddress, type RemoteLinks } from "../../core/links"
import { readManifest } from "../../core/state"
import { CATALOG, FOLDERS_LOCAL, LINKS_LOCAL, Machines, type Hello } from "../../core/machines"
import { AsideeError, privateThere, type CheckResult, type Engine, type LinkSupport, type Provider, type Session, type Stage } from "../../core/types"

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
  // direct: an address outside Asidee that programs in a sandbox reach without the link, as if the guard let them.
  const state = { leak: false, nextPid: 100, refuseBind: false, direct: "" }
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
        if (state.direct && address === state.direct) return { connected: true, received: "" }
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

async function asidee(fake = world(), dirs?: Core["dirs"]) {
  const root = dirs ? undefined : await mkdtemp(join(tmpdir(), "asidee-links-"))
  return new Core([fake.provider], dirs ?? { state: join(root!, "state"), config: join(root!, "config") }, async () => ({ exitCode: 0, stdout: "", stderr: "" }), "/nowhere")
}

test("names, ports and the two ends are validated in the daemon before anything is recorded", async () => {
  const core = await asidee()
  await core.create({ name: "app" }); await core.create({ name: "db" })
  for (const [from, to, port] of [["App", "db", 5432], ["app", "db;rm", 5432], ["app", "db", 0], ["app", "db", 70_000], ["app", "db", "54x"], ["app", "app", 5432], ["app", "localhost", 5432]] as const)
    await expect(core.links.add(from, to, port)).rejects.toMatchObject({ code: "usage" })
  await expect(core.links.add("app", "nobody", 5432)).rejects.toMatchObject({ code: "not-found", message: "There is no sandbox named nobody." })
  await expect(core.links.remove("app", "db", 5432)).rejects.toMatchObject({ code: "not-found" })
  expect(await core.links.list()).toEqual([])
})

test("a link opens measured, carries a connection to its port only, and says what it trusts on both ends", async () => {
  const fake = world(); const core = await asidee(fake)
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.boxes.get("db")!.services.add(5432)
  const made = await core.links.add("app", "db", "5432")
  expect(made).toMatchObject({ from: "app", to: "db", port: 5432, address: "127.77.0.2", state: "open", measured: { status: "pass" } })
  // What app reported about itself is said to be so, beside what holds independently of it.
  expect(made.measured!.detail).toContain("The attempts from app used programs inside it, which its root could replace. Independently, the daemon dials only the link's own port")
  expect(made.trust).toBe("db sees these connections as local (from 127.0.0.1 inside db), so a service in db that trusts local connections trusts app.")
  expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.2\tdb\t# asidee-link"])
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
  const fake = world(); const core = await asidee(fake)
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
  const fake = world(); const core = await asidee(fake)
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
  // From db's side: its relay answers the test's own control and nothing after it, as a replaced /.asidee/busybox could.
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
  const fake = world(); const core = await asidee(fake)
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
  const fake = world(); const core = await asidee(fake)
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
  const fake = world(); const core = await asidee(fake)
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
  const again = await asidee(fake, core.dirs)
  expect((await again.links.list())[0]).toMatchObject({ from: "app", to: "db", port: 5432, state: "closed" })
  await again.enforce()
  expect((await again.links.list())[0]).toMatchObject({ state: "open" })
  again.closeSessions()
})

test("removing either sandbox removes its links, and a sandbox made again under the name inherits none", async () => {
  const fake = world(); const core = await asidee(fake)
  for (const name of ["app", "db", "cache"]) await core.create({ name })
  await core.links.add("app", "db", 5432); await core.links.add("cache", "app", 80); await core.links.add("app", "cache", 6379)
  await core.remove("db", "db")
  expect((await core.links.list()).map((link) => `${link.from}>${link.to}`)).toEqual(["cache>app", "app>cache"])
  expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.3\tcache\t# asidee-link"])
  await core.remove("app", "app")
  expect(await core.links.list()).toEqual([])
  expect(fake.listeners.size).toBe(0)
  // A record left for a name that now belongs to another sandbox is dropped, not reattached.
  await core.create({ name: "app" }); await core.create({ name: "db" })
  await core.links.add("app", "db", 5432)
  const file = join(core.dirs.state, "links.json"); const saved = await readFile(file, "utf8")
  await core.remove("db", "db"); await core.create({ name: "db" })
  await writeFile(file, saved)
  const fresh = await asidee(fake, core.dirs)
  expect(await fresh.links.list()).toEqual([])
})

test("a link closes when either sandbox restarts behind Asidee's back, and its connections check the run they were opened for", async () => {
  const fake = world(); const core = await asidee(fake)
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

test("a link whose listener keeps stopping is tried again less and less often, and a start or a steady run starts over", async () => {
  const fake = world(); const core = await asidee(fake)
  let clock = 1_000_000; core.links.now = () => clock
  await core.create({ name: "app" }); await core.create({ name: "db" })
  fake.boxes.get("db")!.services.add(5432)
  await core.links.add("app", "db", 5432)
  const opens = () => fake.dialed.filter((dial) => dial.name === "db" && dial.port !== 5432).length
  // `app` ends its listener as soon as it opens; each sync that opens the link runs its test again.
  const kill = async () => { fake.listen("app", "127.77.0.2", 5432)?.finish(); await Bun.sleep(10) }
  const waits: number[] = []
  await kill()
  for (let round = 0; round < 8; round++) {
    let waited = 0; const before = opens()
    while (opens() === before) { clock += RETRY_MS / 2; waited += RETRY_MS / 2; await core.links.sync() }
    waits.push(waited); await kill()
  }
  expect(waits).toEqual([RETRY_MS, 2 * RETRY_MS, 4 * RETRY_MS, 8 * RETRY_MS, 16 * RETRY_MS, 32 * RETRY_MS, RETRY_MAX_MS, RETRY_MAX_MS])
  expect((await core.links.list())[0]).toMatchObject({ state: "closed", reason: "its listener stopped soon after it opened; it is tried again in 30 minutes (9 failures in a row)" })
  // A start through Asidee tries it now.
  const before = opens()
  await core.start("app")
  expect(opens()).toBeGreaterThan(before)
  expect((await core.links.list())[0]).toMatchObject({ state: "open" })
  // A listener that stops after ten minutes open counts as working: the next sync opens it again.
  clock += 10 * 60_000; await kill()
  expect((await core.links.list())[0]).toMatchObject({ reason: "its listener stopped; it opens again within 30 seconds" })
  await core.links.sync()
  expect((await core.links.list())[0]).toMatchObject({ state: "open" })
  core.closeSessions()
}, 20_000)

test(`connections, links and the listener's output are bounded: ${LINK_CONNECTIONS} connections per link, ${LINKS_PER_SANDBOX} links per sandbox`, async () => {
  const fake = world(); const core = await asidee(fake)
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
  const fake = world(); const core = await asidee(fake)
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

test("a link connection whose client has ended goes once TO is silent for the allowed time, and stays while TO's reply keeps coming", async () => {
  expect(FIN_QUIET_MS).toBeLessThanOrEqual(60_000)
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
  const root = await mkdtemp(join(tmpdir(), "asidee-links-"))
  const hello: Hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), buildDigest: "c".repeat(64), sourceDigest: "9".repeat(64), version: "0.4.0", methods: Object.keys(CATALOG), protocols: [1], features: [] }
  let contacted = 0
  const machines = new Machines({ state: join(root, "state"), config: join(root, "config") }, hello, async () => ({ hello, sandboxes: [], checkedAt: "" }), { connectPeer: () => { contacted++; throw new Error("should not connect") } } as never)
  for (const method of ["linkAdd", "linkList", "linkRemove"] as const)
    await expect(machines.route(method, { host: "build", from: "app", to: "db", port: 5432 })).rejects.toMatchObject({ code: "usage", message: LINKS_LOCAL })
  // Picking a folder to copy in reads this Mac's home, so it is refused for another machine the same way.
  for (const method of ["folderBrowse", "folderPreview", "folderChoose"] as const)
    await expect(machines.route(method, { host: "build", source: "~/.agents" })).rejects.toMatchObject({ code: "usage", message: FOLDERS_LOCAL })
  expect(contacted).toBe(0)
  expect(LINKS_LOCAL.split(". ").length).toBe(1)
})

// A TCP service on this machine's loopback standing in for an address outside Asidee: it greets each connection and
// echoes what it is sent. Links refuse 127.0.0.0/8, so tests reach it through Links.dialAddress.
async function outsideService() {
  const dialed: Array<[string, number]> = []
  const server: Server = createServer({ allowHalfOpen: true }, (socket) => { socket.write("hello\n"); socket.on("data", (bytes) => socket.write(bytes)); socket.on("end", () => socket.end()) })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const dial = (address: string, wanted: number) => { dialed.push([address, wanted]); return dialTcp("127.0.0.1", port) }
  return { dial, dialed, close: () => server.close() }
}

test("an address link's address and name are validated in the daemon before anything is recorded", async () => {
  const core = await asidee()
  await core.create({ name: "app" }); await core.create({ name: "db" })
  for (const address of ["vm.local", "192.168.64", "192.168.064.5", "256.1.1.1", "::1", " 192.168.64.5", 3232252933])
    await expect(core.links.add("app", "vm", 22, address)).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("must be an IPv4 address") })
  await expect(core.links.add("app", "vm", 22, "127.0.0.1")).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("whether to allow that is not decided yet") })
  await expect(core.links.add("app", "vm", 22, "127.200.1.1")).rejects.toMatchObject({ code: "usage" })
  for (const address of ["0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255"])
    await expect(core.links.add("app", "vm", 22, address)).rejects.toMatchObject({ code: "usage" })
  // Its name is one a sandbox could have, is not localhost or the linking sandbox, and is not a sandbox's.
  for (const name of ["VM", "vm;rm", "localhost", "app"]) await expect(core.links.add("app", name, 22, "192.168.64.5")).rejects.toMatchObject({ code: "usage" })
  await expect(core.links.add("app", "db", 22, "192.168.64.5")).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("db is the name of a sandbox") })
  await expect(core.links.add("nobody", "vm", 22, "192.168.64.5")).rejects.toMatchObject({ code: "not-found" })
  expect(await core.links.list()).toEqual([])
  for (const address of ["192.168.64.5", "10.0.0.1", "172.16.0.1", "8.8.8.8", "169.254.1.1"]) expect(validAddress(address)).toBe(address)
})

test("an address link opens measured, relays each connection to its address from the daemon, says what it trusts, and is removed", async () => {
  const fake = world(); const core = await asidee(fake); const service = await outsideService()
  core.links.dialAddress = service.dial
  try {
    await core.create({ name: "app" })
    const made = await core.links.add("app", "vm", 22, "192.168.64.5")
    expect(made).toMatchObject({ from: "app", to: "vm", toAddress: "192.168.64.5", port: 22, address: "127.77.0.2", state: "open", measured: { status: "pass" } })
    expect(made.measured!.detail).toContain("The daemon opened a connection to 192.168.64.5:22 from this machine; a test connection from app to vm:")
    expect(made.measured!.detail).toContain("and app could not connect to 192.168.64.5:22 directly.")
    expect(made.measured!.detail).toContain("Not checked: what the service at 192.168.64.5:22 does with the connections, and what that address can reach (the internet, the local network); that is outside Asidee's checks.")
    expect(made.trust).toBe(addressTrust("app", "192.168.64.5", 22))
    expect(made.trust).toBe("app can open connections to 192.168.64.5:22 as this machine, so whatever there trusts this machine trusts app; and what that address can reach (the internet, the local network) is outside Asidee's checks.")
    expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.2\tvm\t# asidee-link"])
    expect([...fake.listeners.keys()]).toEqual(["app 127.77.0.2:22"])
    // The daemon dialed only the link's address and port, for its own check and for the test connection.
    expect(service.dialed.every(([address, port]) => address === "192.168.64.5" && port === 22)).toBe(true)
    // A connection made in app is relayed to the address, and what the service says comes back.
    const dials = service.dialed.length
    fake.listen("app", "127.77.0.2", 22)!.print("o 7\n")
    for (let wait = 0; wait < 100 && !fake.attached.get(7)?.toClient.written.includes("hello"); wait++) await Bun.sleep(10)
    expect(service.dialed.length).toBe(dials + 1)
    const halves = fake.attached.get(7)!
    halves.fromClient.print("ping\n")
    for (let wait = 0; wait < 100 && !halves.toClient.written.includes("ping"); wait++) await Bun.sleep(10)
    expect(halves.toClient.written).toBe("hello\nping\n")
    expect((await core.links.list("app"))[0]).toMatchObject({ toAddress: "192.168.64.5", state: "open", connections: 1 })
    // Its checks: the disclosure names the address and the trust; verify measures it again.
    const verified = await core.verify("app")
    expect(verified.checks.find((check) => check.id === "links")!.detail).toContain(`To vm (192.168.64.5, outside Asidee) on port 22: open; inside app, vm is 127.77.0.2. ${made.trust}`)
    expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "pass", evidence: "probed" })
    expect(verified.checks.find((check) => check.id === "net-peers")!.detail).toContain("this sandbox reaches 192.168.64.5 (named vm, outside Asidee) on port 22")
    expect(await core.links.remove("app", "vm", 22)).toMatchObject({ removed: { from: "app", to: "vm", port: 22 }, measured: "Measured: 127.77.0.2:22 now refuses connections inside app." })
    expect(await core.links.list()).toEqual([])
    expect(fake.boxes.get("app")!.hosts).toEqual([])
  } finally { core.closeSessions(); service.close() }
}, 20_000)

test("an address link the daemon cannot reach is not added unmeasured, and one the sandbox reaches directly is refused", async () => {
  const fake = world(); const core = await asidee(fake)
  await core.create({ name: "app" })
  core.links.dialAddress = async () => { throw new Error("connect ECONNREFUSED 192.168.64.5:22") }
  await expect(core.links.add("app", "vm", 22, "192.168.64.5")).rejects.toMatchObject({ code: "probes-required",
    message: expect.stringContaining("the daemon could not open a TCP connection to 192.168.64.5:22 from this machine (connect ECONNREFUSED 192.168.64.5:22), so a blocked attempt from app would prove nothing") })
  expect(await core.links.list()).toEqual([])
  const service = await outsideService(); core.links.dialAddress = service.dial
  try {
    fake.state.direct = "192.168.64.5"
    await expect(core.links.add("app", "vm", 22, "192.168.64.5")).rejects.toMatchObject({ code: "check-failed", message: expect.stringContaining("app opened a connection to 192.168.64.5:22 directly, not through the link.") })
    expect(await core.links.list()).toEqual([])
    expect(fake.listeners.size).toBe(0)
    // Measured again on verify: the link is cut and app, which reached the address itself, is stopped.
    fake.state.direct = ""
    await core.links.add("app", "vm", 22, "192.168.64.5")
    fake.state.direct = "192.168.64.5"
    const verified = await core.verify("app")
    expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "fail", detail: expect.stringContaining("The link was cut.") })
    expect((await core.get("app")).status).toBe("stopped")
    expect((await core.links.list())[0]).toMatchObject({ state: "cut" })
  } finally { core.closeSessions(); service.close() }
}, 20_000)

test("a links.json from before address links loads; an address link is recorded with its kind, counts against its sandbox, and goes with it", async () => {
  const fake = world(); const core = await asidee(fake); const service = await outsideService()
  core.links.dialAddress = service.dial
  try {
    await core.create({ name: "app" }); await core.create({ name: "db" })
    const file = join(core.dirs.state, "links.json")
    // Written as the daemon wrote it before address links existed.
    const id = async (name: string) => (await readManifest(core.dirs, name)).id
    const old = { version: 1, links: [{ id: "0a1b2c3d", from: { name: "app", sandboxId: await id("app") }, to: { name: "db", sandboxId: await id("db") }, port: 5432, address: "127.77.0.2", createdAt: "2026-11-01T00:00:00.000Z" }] }
    await writeFile(file, JSON.stringify(old))
    const again = await asidee(fake, core.dirs); again.links.dialAddress = service.dial
    expect(await again.links.list()).toMatchObject([{ from: "app", to: "db", port: 5432, address: "127.77.0.2" }])
    expect((await again.links.list())[0]!.toAddress).toBeUndefined()
    await again.links.add("app", "vm", 22, "192.168.64.5")
    const saved = JSON.parse(await readFile(file, "utf8"))
    expect(saved.version).toBe(1)
    expect(saved.links[1]).toMatchObject({ from: { name: "app" }, to: { name: "vm", address: "192.168.64.5" }, port: 22, address: "127.77.0.3" })
    expect(saved.links[1].to.sandboxId).toBeUndefined()
    again.closeSessions()
    // A record naming both kinds, or an address a link may not dial, makes the file unreadable rather than guessed at.
    for (const to of [{ name: "vm", address: "192.168.64.5", sandboxId: "a".repeat(32) }, { name: "vm", address: "127.0.0.1" }, { name: "vm", address: "vm.local" }]) {
      await writeFile(file, JSON.stringify({ version: 1, links: [{ ...saved.links[1], to }] }))
      await expect((await asidee(fake, core.dirs)).links.list()).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("a link record is malformed") })
    }
    await writeFile(file, JSON.stringify(saved))
    const third = await asidee(fake, core.dirs); third.links.dialAddress = service.dial
    // One name means one place inside a sandbox.
    await expect(third.links.add("app", "vm", 2222, "192.168.64.6")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Inside app, vm already names the address 192.168.64.5") })
    await third.create({ name: "vm" })
    await expect(third.links.add("app", "vm", 22)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Inside app, vm already names the address 192.168.64.5") })
    // The address link stays when a sandbox takes its name, and is bound to app only.
    expect((await third.links.list("app")).map((link) => `${link.to}:${link.port}`)).toEqual(["db:5432", "vm:22"])
    await third.remove("vm", "vm")
    expect((await third.links.list("app")).map((link) => `${link.to}:${link.port}`)).toEqual(["db:5432", "vm:22"])
    // Address links count against their sandbox's links.
    for (let port = 1; port <= LINKS_PER_SANDBOX - 2; port++) await third.links.add("app", "vm", 1000 + port, "192.168.64.5")
    await expect(third.links.add("app", "vm2", 22, "192.168.64.7")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining(`app already has ${LINKS_PER_SANDBOX} links`) })
    // Removing app removes its address links.
    await third.remove("app", "app")
    expect(await third.links.list()).toEqual([])
    expect(JSON.parse(await readFile(file, "utf8")).links).toEqual([])
    third.closeSessions()
  } finally { core.closeSessions(); service.close() }
}, 60_000)

test("the daemon's TCP dial is a session the relay can use: paused until resumed, its end a half-close", async () => {
  const service = await outsideService()
  try {
    const session = await service.dial("192.168.64.5", 22)
    let received = ""; let exit: { code?: number; error?: string } | undefined
    session.on("output", (stream, bytes) => { if (stream === "stdout") received += Buffer.from(bytes).toString() })
    session.on("end", (value) => { exit = value })
    await Bun.sleep(50)
    expect(received).toBe("")
    session.resume(); session.write(Buffer.from("ping\n")); session.end()
    for (let wait = 0; wait < 100 && !exit; wait++) await Bun.sleep(10)
    expect(received).toBe("hello\nping\n")
    expect(exit).toEqual({ code: 0 })
    await expect(dialTcp("127.0.0.1", 1, 2000)).rejects.toThrow()
  } finally { service.close() }
})

// A connected host as Links sees it through Machines: its record, its public and private sandboxes, and the relays its
// daemon holds. Each relay's dial is a session that greets the connection, as the service on the leased port would.
function hostWorld() {
  const BUILD = "d".repeat(32)
  type Remote = { sandboxId: string; running: boolean; private: boolean; run: number }
  const state = { machines: new Map<string, string>([["build", BUILD]]), reachable: true, addresses: ["192.168.1.20"] as string[], boxes: new Map<string, Remote>() }
  const relays: Array<{ to: { name: string; sandboxId: string }; port: number; dials: FakeSession[]; closed?: string; onEnd: (reason: string) => void }> = []
  const box = (host: string, name: string) => {
    if (!state.reachable) throw new AsideeError("offline", `${host} is unreachable: fixture`)
    const found = state.boxes.get(name)
    if (!found) throw new AsideeError("not-found", `There is no sandbox named ${name}.`)
    if (found.private) throw new AsideeError("not-found", privateThere(name))
    return found
  }
  const remote: RemoteLinks = {
    linkMachine: async (host) => state.machines.get(host),
    linkIdentity: async (host, name) => { const found = box(host, name); return { machineId: state.machines.get(host)!, sandboxId: found.sandboxId, running: found.running } },
    linkRelay: async (to, port, onEnd) => {
      const found = box(to.host, to.name)
      if (!found.running) throw new AsideeError("conflict", `${to.name} is not running. Start it with \`asd start ${to.name}\`.`)
      if (found.sandboxId !== to.sandboxId) throw new AsideeError("identity-changed", `${to.name} on ${to.host} was made again since the link was added.`)
      const relay: (typeof relays)[number] = { to, port, dials: [], onEnd }
      relays.push(relay)
      return { generation: `run-${found.run}`, close: (reason) => { relay.closed ??= reason },
        dial: async () => { const session: FakeSession = new FakeSession(() => session.finish()); relay.dials.push(session); setTimeout(() => session.print("remote hello\n"), 1); return session } }
    },
    linkAddresses: async () => state.addresses,
  }
  return { state, relays, remote, BUILD }
}

test("a link to a public sandbox on a host opens measured, relays through the host's dial session, says what it trusts, and is removed", async () => {
  const fake = world(); const core = await asidee(fake); const host = hostWorld()
  core.links.remote = host.remote
  host.state.boxes.set("db", { sandboxId: "e".repeat(32), running: true, private: false, run: 1 })
  try {
    await core.create({ name: "app" })
    const made = await core.links.add("app", "db", 5432, undefined, "build")
    expect(made).toMatchObject({ from: "app", to: "db", toHost: "build", port: 5432, address: "127.77.0.2", state: "open", measured: { status: "pass" } })
    expect(made.toAddress).toBeUndefined()
    expect(made.trust).toBe(hostedTrust("app", "db", "build"))
    expect(made.trust).toContain("over Asidee's SSH link to it")
    expect(made.measured!.detail).toContain("was carried by the daemon over SSH to build, whose daemon opened a relay to port 5432 on db's loopback")
    expect(made.measured!.detail).toContain("app could not connect to build directly at 192.168.1.20 on port 5432 or 22")
    expect(made.measured!.detail).toContain("Not checked: db's address on build's engine network")
    expect(fake.boxes.get("app")!.hosts).toEqual(["127.77.0.2\tdb\t# asidee-link"])
    // One relay, bound to db's identity and the link's port; the test connection went through its dial session.
    expect(host.relays).toHaveLength(1)
    expect(host.relays[0]).toMatchObject({ to: { name: "db", host: "build", machineId: host.BUILD, sandboxId: "e".repeat(32) }, port: 5432 })
    const tested = host.relays[0]!.dials.length
    expect(tested).toBeGreaterThan(0)
    // A connection made in app goes through a new dial session, and what db's port says comes back.
    fake.listen("app", "127.77.0.2", 5432)!.print("o 7\n")
    for (let wait = 0; wait < 100 && !fake.attached.get(7)?.toClient.written.includes("remote hello"); wait++) await Bun.sleep(10)
    expect(host.relays[0]!.dials.length).toBe(tested + 1)
    expect(fake.attached.get(7)!.toClient.written).toBe("remote hello\n")
    expect((await core.links.list("app"))[0]).toMatchObject({ toHost: "build", state: "open" })
    const verified = await core.verify("app")
    expect(verified.checks.find((check) => check.id === "links")!.detail).toContain(`To db on build on port 5432: open; inside app, db is 127.77.0.2. ${made.trust}`)
    expect(verified.checks.find((check) => check.id === "link-scope")).toMatchObject({ status: "pass", evidence: "probed" })
    expect(verified.checks.find((check) => check.id === "net-peers")!.detail).toContain("this sandbox reaches db on build on port 5432")
    expect(await core.links.remove("app", "db", 5432)).toMatchObject({ removed: { from: "app", to: "db", port: 5432 }, measured: "Measured: 127.77.0.2:5432 now refuses connections inside app." })
    expect(host.relays[0]!.closed).toBeDefined()
    expect(await core.links.list()).toEqual([])
  } finally { core.closeSessions() }
}, 30_000)

test("a link to a host is refused for a private sandbox, an unknown host, a name a sandbox here has, and one app reaches directly", async () => {
  const fake = world(); const core = await asidee(fake); const host = hostWorld()
  await core.create({ name: "app" }); await core.create({ name: "web" })
  await expect(core.links.add("app", "db", 5432, undefined, "build")).rejects.toMatchObject({ code: "dependency", message: "This daemon cannot reach other machines." })
  core.links.remote = host.remote
  host.state.boxes.set("db", { sandboxId: "e".repeat(32), running: true, private: true, run: 1 })
  await expect(core.links.add("app", "db", 5432, undefined, "build")).rejects.toMatchObject({ code: "not-found",
    message: "db is private on build, so it cannot be linked to from this machine. To allow it, make it public on its own machine: run `asd share db` on build." })
  await expect(core.links.add("app", "db", 5432, undefined, "other")).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("There is no host other") })
  await expect(core.links.add("app", "db", 5432, "192.168.64.5", "build")).rejects.toMatchObject({ code: "usage" })
  await expect(core.links.add("app", "db", 5432, undefined, "local")).rejects.toMatchObject({ code: "usage" })
  await expect(core.links.add("app", "app", 5432, undefined, "build")).rejects.toMatchObject({ code: "usage" })
  host.state.boxes.set("web", { sandboxId: "f".repeat(32), running: true, private: false, run: 1 })
  await expect(core.links.add("app", "web", 80, undefined, "build")).rejects.toMatchObject({ code: "usage", message: expect.stringContaining("web is also the name of a sandbox on this machine") })
  host.state.reachable = false
  await expect(core.links.add("app", "web2", 80, undefined, "build")).rejects.toMatchObject({ code: "offline", message: expect.stringContaining("could not be looked up, so nothing was added") })
  host.state.reachable = true
  host.state.boxes.get("db")!.private = false
  fake.state.direct = "192.168.1.20"
  await expect(core.links.add("app", "db", 5432, undefined, "build")).rejects.toMatchObject({ code: "check-failed", message: expect.stringContaining("app opened a connection to build directly (192.168.1.20:5432, 192.168.1.20:22), not through the link.") })
  expect(await core.links.list()).toEqual([])
  expect(host.relays.every((relay) => relay.closed)).toBe(true)
  core.closeSessions()
}, 30_000)

test("a link to a host waits while its sandbox is stopped, private or the host is unreachable, and opens again on its own", async () => {
  const fake = world(); const core = await asidee(fake); const host = hostWorld()
  core.links.remote = host.remote
  host.state.boxes.set("db", { sandboxId: "e".repeat(32), running: false, private: false, run: 1 })
  try {
    await core.create({ name: "app" })
    expect(await core.links.add("app", "db", 5432, undefined, "build")).toMatchObject({ state: "waiting", reason: "db is stopped on build" })
    // Each try contacts the host, so a waiting link is not tried again on every pass; a start of app tries it now.
    host.state.boxes.get("db")!.running = true
    await core.links.sync()
    expect((await core.links.list())[0]).toMatchObject({ state: "waiting" })
    await core.links.sync("app")
    expect((await core.links.list())[0]).toMatchObject({ state: "open" })
    // The host's daemon ends the lease (db stopped there): the link closes, and waits while the host cannot be reached.
    host.state.reachable = false
    host.relays.at(-1)!.onEnd("The remote daemon, sandbox run or SSH control link ended.")
    expect((await core.links.list())[0]).toMatchObject({ state: "closed", reason: expect.stringContaining("its relay to build ended") })
    await core.links.sync("app")
    expect((await core.links.list())[0]).toMatchObject({ state: "waiting", reason: expect.stringContaining("build cannot be used now: build is unreachable") })
    host.state.reachable = true; host.state.boxes.get("db")!.private = true
    await core.links.sync("app")
    expect((await core.links.list())[0]).toMatchObject({ state: "waiting", reason: expect.stringContaining("db is private on build; it opens once it is made public there") })
    host.state.boxes.get("db")!.private = false
    await core.links.sync("app")
    expect((await core.links.list())[0]).toMatchObject({ state: "open" })
    // app stopping closes it like any link.
    await core.stop("app")
    expect((await core.links.list())[0]).toMatchObject({ state: "waiting", reason: "app is stopped" })
  } finally { core.closeSessions() }
}, 30_000)

test("a link to a host goes when its sandbox is made again or removed there, or the host record goes, and counts against its sandbox", async () => {
  const fake = world(); const core = await asidee(fake); const host = hostWorld()
  core.links.remote = host.remote
  host.state.boxes.set("db", { sandboxId: "e".repeat(32), running: true, private: false, run: 1 })
  try {
    await core.create({ name: "app" })
    await core.links.add("app", "db", 5432, undefined, "build")
    const file = join(core.dirs.state, "links.json")
    expect(JSON.parse(await readFile(file, "utf8")).links[0].to).toEqual({ name: "db", host: "build", machineId: host.BUILD, sandboxId: "e".repeat(32) })
    // A record naming a host and an address, or a host named local, is malformed.
    const saved = JSON.parse(await readFile(file, "utf8"))
    for (const to of [{ ...saved.links[0].to, address: "192.168.64.5" }, { ...saved.links[0].to, host: "local" }, { ...saved.links[0].to, machineId: "x" }]) {
      await writeFile(file, JSON.stringify({ version: 1, links: [{ ...saved.links[0], to }] }))
      await expect((await asidee(fake, core.dirs)).links.list()).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("a link record is malformed") })
    }
    await writeFile(file, JSON.stringify(saved))
    const again = await asidee(fake, core.dirs); again.links.remote = host.remote
    // Made again under its name on the host: dropped at the next try, never followed.
    host.state.boxes.set("db", { sandboxId: "0".repeat(32), running: true, private: false, run: 2 })
    await again.links.sync("app")
    expect(await again.links.list()).toEqual([])
    expect(fake.boxes.get("app")!.hosts).toEqual([])
    // Removed there: dropped too.
    await again.links.add("app", "db", 5432, undefined, "build")
    host.state.boxes.delete("db")
    host.relays.at(-1)!.onEnd("ended")
    await again.links.sync("app")
    expect(await again.links.list()).toEqual([])
    // The host's record removed, or enrolled again as another machine: dropped.
    host.state.boxes.set("db", { sandboxId: "0".repeat(32), running: true, private: false, run: 3 })
    await again.links.add("app", "db", 5432, undefined, "build")
    host.state.machines.delete("build")
    await again.links.prune()
    expect(await again.links.list()).toEqual([])
    host.state.machines.set("build", host.BUILD)
    await again.links.add("app", "db", 5432, undefined, "build")
    host.state.machines.set("build", "1".repeat(32))
    expect(await again.links.list()).toEqual([])
    host.state.machines.set("build", host.BUILD)
    // Links to a host count against the sandbox they start from.
    for (let port = 1; port <= LINKS_PER_SANDBOX; port++) await again.links.add("app", "db", 1000 + port, undefined, "build")
    await expect(again.links.add("app", "db", 2000, undefined, "build")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining(`app already has ${LINKS_PER_SANDBOX} links`) })
    // Removing app removes them.
    await again.remove("app", "app")
    expect(await again.links.list()).toEqual([])
    again.closeSessions()
  } finally { core.closeSessions() }
}, 120_000)
