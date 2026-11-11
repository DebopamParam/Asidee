import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { statSync } from "node:fs"
import { hostname } from "node:os"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, normalize } from "node:path"
import { CHECKLIST } from "./checks"
import { Core } from "./core"
import { CATALOG, isMethod, machineIdentity, Machines, type Hello } from "./machines"
import { PROTOCOL } from "./transport"
import { DockerSandboxesProvider } from "./providers/docker-sandboxes"
import { GvisorProvider } from "./providers/gvisor"
import { systemRunner } from "./run"
import { checkSocketPath, daemonFile, socketPath, streamSocketPath, type Dirs } from "./state"
import { sourceDigest } from "./source" with { type: "macro" }
import { serveStream } from "./stream"
import { PaddockError, type ErrorCode } from "./types"
import builtInUi from "../ui/index.html" with { type: "text" }
import pkg from "../package.json"

// Bun's types describe an .html import as a page bundle; with type "text" it is the file's text.
const BUILT_IN_UI = builtInUi as unknown as string

export const VERSION: string = pkg.version
// The version plus when this program file was written. A daemon left running by an older build of the same version
// (a rebuild during development) has another one, and the CLI replaces it.
export const BUILD: string = (() => { try { return `${VERSION}+${Math.round(statSync(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).mtimeMs)}` } catch { return VERSION } })()
// What this program was built from: two machines talk only when it is the same (core/machines.ts, compatible).
export const SOURCE: string = sourceDigest()
const DEFAULT_PORT = 7717
const ENFORCE_MS = 30_000

type Body = Record<string, unknown>
type Method = { run: (body: Body) => Promise<unknown>; socketOnly?: boolean }

// The whole API. The CLI, the UI and extensions all come through this table, so each has exactly these abilities.
// keepSandboxes: the daemon is being replaced (an upgrade), not stopped, so the sandboxes it watches keep running.
export function methods(core: Core, shutdown: (keepSandboxes: boolean) => void, stopping: () => boolean = () => false, machines?: Machines): Record<string, Method> {
  return {
    version: { run: async () => ({ version: VERSION, build: BUILD, stopping: stopping() }) },
    hello: { run: async () => machines?.hello, socketOnly: true },
    summary: { run: async () => ({ hello: machines?.hello, sandboxes: await core.list(), checkedAt: new Date().toISOString() }) },
    hostList: { run: async () => machines?.list() },
    fleet: { run: async (body) => machines?.fleet(body.refresh) },
    hostAttach: { run: async (body) => machines?.attach(body), socketOnly: true },
    hostRemove: { run: async (body) => machines?.remove(body), socketOnly: true },
    sessionTarget: { run: (body) => core.sessionTarget(body.name), socketOnly: true },
    sshPrepare: { run: (body) => core.sshSetup(String(body.name), false, typeof body.publicKey === "string" ? body.publicKey : ""), socketOnly: true },
    checklist: { run: async () => CHECKLIST },
    engines: { run: () => core.engines() },
    list: { run: () => core.list() },
    get: { run: (body) => core.get(String(body.name)) },
    create: { run: (body) => core.create(body) },
    start: { run: (body) => core.start(String(body.name)) },
    stop: { run: (body) => core.stop(String(body.name)) },
    remove: { run: (body) => core.remove(String(body.name), body.confirm) },
    verify: { run: (body) => core.verify(String(body.name)) },
    resize: { run: (body) => core.resize(String(body.name), body) },
    snapshot: { run: (body) => core.snapshot(String(body.name), body.as) },
    templateList: { run: () => core.templateList() },
    templateRemove: { run: (body) => core.templateRemove(body.name, body.engine) },
    exec: { run: (body) => core.exec(String(body.name), body.argv, { user: typeof body.user === "string" ? body.user : undefined, stdin: typeof body.stdin === "string" ? body.stdin : undefined }) },
    extensions: { run: () => core.extensions() },
    action: { run: (body) => core.runAction(body.extension, body.action, body.sandbox, body.values) },
    forwardAdd: { run: (body) => core.forwardAdd(String(body.name), body.port, body.localPort) },
    forwardList: { run: async (body) => core.forwardList(body.name) },
    forwardRemove: { run: async (body) => machines?.forwardRemove(body.id) ?? core.forwardRemove(body.id) },
    sshAccess: { run: (body) => core.sshAccess(String(body.name)) },
    // It writes to the user's SSH configuration, so a web page cannot ask for it.
    sshSetup: { run: (body) => core.sshSetup(String(body.name), body.writeConfig === true), socketOnly: true },
    shutdown: { run: async (body) => { setTimeout(() => shutdown(body.keepSandboxes === true), 50); return { stopping: true } }, socketOnly: true },
  }
}

const STATUS: Record<ErrorCode, number> = { usage: 400, "not-found": 404, conflict: 409, dependency: 424, "check-failed": 422, runtime: 500, offline: 503, incompatible: 409, "identity-changed": 409, "outcome-unknown": 504 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const refuse = (status: number, message: string) => json(status, { ok: false, error: { code: "usage", message } })

// viaSocket: the request came over the Unix socket, which only this user can open. Otherwise it came over loopback TCP,
// where any local process or web page can try, so it must carry the token and name this server as its Host (a page on
// another site that resolves its own name to 127.0.0.1 does not).
export function createHandler(table: Record<string, Method>, token: string, configDir: string, machines?: Machines) {
  return async (request: Request, viaSocket: boolean, port: number): Promise<Response> => {
    const url = new URL(request.url)
    if (!viaSocket && !["127.0.0.1", "localhost"].some((host) => request.headers.get("host") === `${host}:${port}`)) return refuse(403, "Unexpected Host header.")
    if (url.pathname.startsWith("/api/")) {
      const method = Object.hasOwn(table, url.pathname.slice(5)) ? table[url.pathname.slice(5)] : undefined
      if (request.method !== "POST" || !method) return json(404, { ok: false, error: { code: "not-found", message: "No such method." } })
      if (!viaSocket) {
        const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""); const expected = Buffer.from(token)
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse(401, "Open the dashboard with the link from `paddock ui`.")
        if (method.socketOnly) return refuse(403, "This method is only available to the CLI.")
      }
      try {
        const text = await request.text()
        const body = text ? JSON.parse(text) as unknown : {}
        if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "The request body must be a JSON object.")
        const payload = body as Body
        if (payload.host !== undefined && (typeof payload.host !== "string" || !payload.host)) throw new PaddockError("usage", "host must be a registered host name or local.")
        if (machines) {
          const expected = request.headers.get("x-paddock-machine")
          if (expected && expected !== machines.hello.machineId) throw new PaddockError("identity-changed", "The daemon's machine identity differs from the selected machine.")
          if (expected && (request.headers.get("x-paddock-protocol") !== String(PROTOCOL) || request.headers.get("x-paddock-version") !== VERSION || request.headers.get("x-paddock-build") !== machines.hello.sourceDigest))
            throw new PaddockError("incompatible", `This daemon is Paddock ${VERSION}, protocol ${PROTOCOL}, built from source ${machines.hello.sourceDigest.slice(0, 12)}; the gateway's request differs. Nothing was done.`)
          const name = url.pathname.slice(5)
          if (isMethod(name) && !viaSocket && CATALOG[name][0] !== "dashboard") return refuse(403, "This method is only available to the CLI.")
          if (payload.host !== undefined && payload.host !== "local") {
            if (!isMethod(name)) throw new PaddockError("usage", "This method cannot be routed.")
            return json(200, { ok: true, data: await machines.route(name, payload, request.signal) })
          }
          if (payload.machineId !== undefined && payload.machineId !== machines.hello.machineId) throw new PaddockError("identity-changed", "The request names another machine identity.")
        } else if (payload.host !== undefined && payload.host !== "local") throw new PaddockError("dependency", "Machine routing is unavailable.")
        const { host: _host, machineId: _identity, ...local } = payload
        return json(200, { ok: true, data: await method.run(local) })
      } catch (error) {
        const code: ErrorCode = error instanceof PaddockError ? error.code : error instanceof SyntaxError ? "usage" : "runtime"
        return json(STATUS[code], { ok: false, error: { code, message: (error as Error).message, details: error instanceof PaddockError ? error.details : undefined } })
      }
    }
    if (viaSocket || request.method !== "GET") return json(404, { ok: false, error: { code: "not-found", message: "Not found." } })
    // A folder at CONFIG/ui replaces the built-in dashboard: it is a client of the same API, with the same token.
    const custom = join(configDir, "ui"); const path = normalize(join(custom, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)))
    if (path.startsWith(`${custom}/`) && await Bun.file(path).exists()) return new Response(Bun.file(path), { headers: { "x-frame-options": "DENY" } })
    if (url.pathname === "/") return new Response(BUILT_IN_UI, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } })
    return new Response("Not found", { status: 404 })
  }
}

export async function runDaemon(dirs: Dirs, cliDir: string): Promise<void> {
  checkSocketPath(dirs)
  await mkdir(dirs.state, { recursive: true, mode: 0o700 })
  const socket = socketPath(dirs)
  const alive = await fetch("http://paddock/api/version", { unix: socket, method: "POST", body: "{}" } as RequestInit).then(() => true, () => false)
  if (alive) throw new PaddockError("conflict", "A Paddock daemon is already running.")
  await rm(socket, { force: true }); await rm(streamSocketPath(dirs), { force: true })

  const identity = await machineIdentity(dirs)
  const digest = new Bun.CryptoHasher("sha256")
  for await (const bytes of Bun.file(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).stream()) digest.update(bytes)
  const core = new Core([new GvisorProvider(systemRunner, createHash("sha256").update(`${hostname()}\0${dirs.state}`).digest("hex").slice(0, 10)), new DockerSandboxesProvider(systemRunner)], dirs, systemRunner, cliDir, identity)
  // service: systemd sets INVOCATION_ID for each unit it starts; a daemon started by hand or by the CLI has none.
  const hello: Hello = { machineId: identity, bootId: randomBytes(16).toString("hex"), version: VERSION, buildDigest: digest.digest("hex"), sourceDigest: SOURCE, protocols: [PROTOCOL], methods: Object.keys(CATALOG),
    features: ["machines", "remote-streams", "remote-forwards", "ssh", "lease-renewal"], listener: process.env.PADDOCK_SOCKET_ONLY === "1" ? "socket-only" : "dashboard", service: process.env.INVOCATION_ID ? "systemd" : "none" }
  const machines = new Machines(dirs, hello, async () => ({ hello, sandboxes: await core.list(), checkedAt: new Date().toISOString() }))
  const token = randomBytes(24).toString("hex")
  let stop: (keepSandboxes: boolean) => void = () => {}
  // A daemon that is stopping still answers `version`, so a client waits for it instead of starting a second one, and
  // takes no new work: a sandbox started now would be stopped, or left unwatched, a moment later.
  let stopping = false
  const answer = createHandler(methods(core, (keep) => stop(keep), () => stopping, machines), token, dirs.config, machines)
  const handle = (request: Request, viaSocket: boolean, port: number): Promise<Response> =>
    stopping && new URL(request.url).pathname !== "/api/version"
      ? Promise.resolve(json(STATUS.conflict, { ok: false, error: { code: "conflict", message: "The daemon is stopping. Try again in a moment." } }))
      : answer(request, viaSocket, port)

  // idleTimeout 0: creating a sandbox can take minutes (an image download), and Bun otherwise drops a quiet request
  // after 10 s. Its types do not list the option for a Unix socket.
  const unix = Bun.serve({ unix: socket, idleTimeout: 0, fetch: (request: Request) => handle(request, true, 0) } as unknown as Parameters<typeof Bun.serve>[0])
  await chmod(socket, 0o600)
  // Sessions (shell, exec --stream) have a Unix socket of their own and no TCP listener at all, so neither the
  // dashboard's port nor its token can reach them. It is a raw socket because a slow reader must slow the command
  // down: each side pauses until the other has taken what it was given.
  const streams = createServer({ allowHalfOpen: true }, (connection) => {
    if (stopping) return connection.destroy()
    serveStream(connection, (request) => machines.openSession(request, (request) => core.openSession(request)))
  })
  await new Promise<void>((resolve, reject) => { streams.once("error", reject); streams.listen(streamSocketPath(dirs), () => resolve()) })
  await chmod(streamSocketPath(dirs), 0o600)
  const wanted = Number(process.env.PADDOCK_PORT ?? DEFAULT_PORT)
  let tcpPort = 0
  const serveTcp = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (request: Request): Promise<Response> => handle(request, false, tcpPort) })
  let tcp: ReturnType<typeof serveTcp> | undefined
  if (process.env.PADDOCK_SOCKET_ONLY !== "1") {
    try { tcp = serveTcp(wanted) } catch { tcp = serveTcp(0) }
    tcpPort = tcp.port!
  }
  await writeFile(daemonFile(dirs), `${JSON.stringify({ pid: process.pid, port: tcpPort, token, version: VERSION })}\n`, { mode: 0o600 })

  // One pass at a time: a slow engine must not stack them up. The first pass covers the time no daemon was running.
  let enforcing = false
  const enforce = async () => { if (enforcing) return; enforcing = true; try { await core.enforce() } finally { enforcing = false } }
  void core.sweep().then(enforce)
  const timer = setInterval(() => { void enforce() }, ENFORCE_MS)
  const keepSandboxes = await new Promise<boolean>((resolve) => {
    stop = resolve
    process.on("SIGTERM", () => resolve(false)); process.on("SIGINT", () => resolve(false))
  })
  stopping = true
  clearInterval(timer)
  core.closeSessions()
  // Bounded (Machines.close), and never a reason to skip the next line.
  await machines.close().catch(() => {})
  if (!keepSandboxes) await core.stopWatched()
  streams.close()
  await Promise.all([unix.stop(true), tcp?.stop(true)])
  await rm(socket, { force: true }); await rm(streamSocketPath(dirs), { force: true }); await rm(daemonFile(dirs), { force: true })
}

export async function readDaemonFile(dirs: Dirs): Promise<{ pid: number; port: number; token: string; version: string } | undefined> {
  try { return JSON.parse(await readFile(daemonFile(dirs), "utf8")) } catch { return undefined }
}
