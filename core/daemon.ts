import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { statSync } from "node:fs"
import { hostname } from "node:os"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, normalize } from "node:path"
import { CHECKLIST } from "./checks"
import { Core } from "./core"
import { CATALOG, isMethod, machineIdentity, Machines, type Hello } from "./machines"
import { Hosts } from "./hosts"
import { PROTOCOL } from "./transport"
import { DockerSandboxesProvider } from "./providers/docker-sandboxes"
import { GvisorProvider } from "./providers/gvisor"
import { OUTPUT_LIMIT, systemRunner } from "./run"
import { checkSocketPath, daemonFile, DEFAULT_DISK_WATCH_SECONDS, socketPath, streamSocketPath, type Dirs } from "./state"
import { sourceDigest } from "./source" with { type: "macro" }
import { serveStream } from "./stream"
import { AsideeError, type ErrorCode } from "./types"
import builtInUi from "../ui/index.html" with { type: "text" }
import pkg from "../package.json"
import { WORKSPACE_WATCH_MS, Workspaces } from "./workspaces"

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

// Buffered exec input, held in memory like its output and limited the same way. stdinBase64 carries bytes exactly; a
// string stdin, as older clients send, is still taken and sent as UTF-8.
export function execStdin(body: Body): string | Uint8Array | undefined {
  const limit = `Buffered exec input is limited to ${OUTPUT_LIMIT / 1024 ** 2} MiB; use --stream for more.`
  if (body.stdinBase64 !== undefined) {
    if (body.stdin !== undefined) throw new AsideeError("usage", "Send stdin or stdinBase64, not both.")
    const encoded = body.stdinBase64
    if (typeof encoded !== "string" || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AsideeError("usage", "stdinBase64 must be standard padded base64.")
    if (encoded.length / 4 * 3 > OUTPUT_LIMIT + 2) throw new AsideeError("usage", limit)
    const bytes = Buffer.from(encoded, "base64")
    if (bytes.length > OUTPUT_LIMIT) throw new AsideeError("usage", limit)
    return new Uint8Array(bytes)
  }
  if (body.stdin === undefined) return undefined
  if (typeof body.stdin !== "string") throw new AsideeError("usage", "stdin must be a string; send bytes as stdinBase64.")
  if (Buffer.byteLength(body.stdin) > OUTPUT_LIMIT) throw new AsideeError("usage", limit)
  return body.stdin
}
type Method = { run: (body: Body, signal?: AbortSignal) => Promise<unknown>; socketOnly?: boolean }

// The whole API. The CLI, the UI and extensions all come through this table, so each has exactly these abilities.
// keepSandboxes: the daemon is being replaced (an upgrade), not stopped, so the sandboxes it watches keep running.
export function methods(core: Core, shutdown: (keepSandboxes: boolean) => void, stopping: () => boolean = () => false, machines?: Machines, hosts = machines ? new Hosts(machines) : undefined, workspaces = new Workspaces(core.dirs)): Record<string, Method> {
  return {
    version: { run: async () => ({ version: VERSION, build: BUILD, stopping: stopping() }) },
    hello: { run: async () => machines?.hello, socketOnly: true },
    summary: { run: async () => ({ hello: machines?.hello, sandboxes: await core.list(), workspaces: process.platform === "darwin" ? await workspaces.summary() : [], checkedAt: new Date().toISOString() }) },
    workspaceList: { run: () => workspaces.list(), socketOnly: true },
    workspaceGet: { run: (body) => workspaces.get(String(body.name), body.withSize !== false), socketOnly: true },
    workspaceSet: { run: (body) => workspaces.set(String(body.name), body), socketOnly: true },
    workspaceCreate: { run: (body) => workspaces.create(body), socketOnly: true },
    workspaceExec: { run: (body, signal) => workspaces.exec(String(body.name), body.argv, execStdin(body), signal), socketOnly: true },
    workspaceShell: { run: async (body) => ({ workspace: await workspaces.get(String(body.name), false), stream: "workspace", argv: ["/bin/zsh", "-l"] }), socketOnly: true },
    workspaceStop: { run: (body) => workspaces.stop(String(body.name)), socketOnly: true },
    workspaceRemove: { run: (body) => workspaces.remove(String(body.name), body.confirm), socketOnly: true },
    workspaceVerify: { run: (body) => workspaces.verify(String(body.name)), socketOnly: true },
    hostList: { run: async () => machines?.list() },
    fleet: { run: async (body) => machines?.fleet(body.refresh) },
    hostAttach: { run: async (body) => machines?.attach(body), socketOnly: true },
    hostPlan: { run: async (body) => hosts?.plan(body), socketOnly: true },
    hostApply: { run: async (body) => hosts?.apply(body), socketOnly: true },
    hostRemove: { run: async (body) => machines?.remove(body), socketOnly: true },
    sessionTarget: { run: (body) => core.sessionTarget(body.name), socketOnly: true },
    sshPrepare: { run: (body) => core.sshSetup(String(body.name), false, typeof body.publicKey === "string" ? body.publicKey : ""), socketOnly: true },
    configGet: { run: () => core.configGet() },
    configSet: { run: async (body) => { const config = await core.configSet(body); if (!config.experimental) machines?.suspend(); return config } },
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
    exec: { run: (body, signal) => core.exec(String(body.name), body.argv, { user: typeof body.user === "string" ? body.user : undefined, stdin: execStdin(body), signal }) },
    extensions: { run: () => core.extensions() },
    action: { run: (body) => core.runAction(body.extension, body.action, body.sandbox, body.values) },
    forwardAdd: { run: (body) => core.forwardAdd(String(body.name), body.port, body.localPort) },
    forwardList: { run: async (body) => core.forwardList(body.name) },
    forwardRemove: { run: async (body) => machines?.forwardRemove(body.id) ?? core.forwardRemove(body.id) },
    linkAdd: { run: (body) => core.links.add(body.from, body.to, body.port) },
    linkList: { run: (body) => core.links.list(body.name) },
    linkRemove: { run: (body) => core.links.remove(body.from, body.to, body.port) },
    sshAccess: { run: (body) => core.sshAccess(String(body.name)) },
    // It writes to the user's SSH configuration, so a web page cannot ask for it.
    sshSetup: { run: (body) => core.sshSetup(String(body.name), body.writeConfig === true), socketOnly: true },
    shutdown: { run: async (body) => { setTimeout(() => shutdown(body.keepSandboxes === true), 50); return { stopping: true } }, socketOnly: true },
  }
}

const STATUS: Record<ErrorCode, number> = { usage: 400, "not-found": 404, conflict: 409, dependency: 424, "check-failed": 422, "probes-required": 422, runtime: 500, offline: 503, incompatible: 409, "identity-changed": 409, "outcome-unknown": 504 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const refuse = (status: number, message: string) => json(status, { ok: false, error: { code: "usage", message } })

// viaSocket: the request came over the Unix socket, which only this user can open. Otherwise it came over loopback TCP,
// where any local process or web page can try, so it must carry the token and name this server as its Host (a page on
// another site that resolves its own name to 127.0.0.1 does not).
export function createHandler(table: Record<string, Method>, token: string, configDir: string, machines?: Machines) {
  return async (request: Request, viaSocket: boolean, port: number): Promise<Response> => {
    let url: URL; let pathname: string
    try {
      url = new URL(request.url)
      pathname = decodeURIComponent(url.pathname)
      if (/[\x00-\x1f\x7f]/.test(pathname + decodeURIComponent(url.search))) throw new URIError()
    } catch { return refuse(400, "Malformed request URL.") }
    if (!viaSocket && !["127.0.0.1", "localhost"].some((host) => request.headers.get("host") === `${host}:${port}`)) return refuse(403, "Unexpected Host header.")
    if (url.pathname.startsWith("/api/")) {
      const method = Object.hasOwn(table, url.pathname.slice(5)) ? table[url.pathname.slice(5)] : undefined
      if (request.method !== "POST" || !method) return json(404, { ok: false, error: { code: "not-found", message: "No such method." } })
      if (!viaSocket) {
        const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""); const expected = Buffer.from(token)
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return refuse(401, "Open the dashboard with the link from `asd ui`.")
        if (method.socketOnly) return refuse(403, "This method is only available to the CLI.")
      }
      try {
        const text = await request.text()
        const body = text ? JSON.parse(text) as unknown : {}
        if (typeof body !== "object" || body === null || Array.isArray(body)) return refuse(400, "The request body must be a JSON object.")
        const payload = body as Body
        if (payload.host !== undefined && (typeof payload.host !== "string" || !payload.host)) throw new AsideeError("usage", "host must be a registered host name or local.")
        if (machines) {
          const expected = request.headers.get("x-asidee-machine")
          if (expected && expected !== machines.hello.machineId) throw new AsideeError("identity-changed", "The daemon's machine identity differs from the selected machine.")
          if (expected && (request.headers.get("x-asidee-protocol") !== String(PROTOCOL) || request.headers.get("x-asidee-version") !== VERSION || request.headers.get("x-asidee-build") !== machines.hello.sourceDigest))
            throw new AsideeError("incompatible", `This daemon is Asidee ${VERSION}, protocol ${PROTOCOL}, built from source ${machines.hello.sourceDigest.slice(0, 12)}; the gateway's request differs. Nothing was done.`)
          const name = url.pathname.slice(5)
          if (isMethod(name) && !viaSocket && CATALOG[name][0] !== "dashboard") return refuse(403, "This method is only available to the CLI.")
          if (payload.host !== undefined && payload.host !== "local") {
            if (!isMethod(name)) throw new AsideeError("usage", "This method cannot be routed.")
            return json(200, { ok: true, data: await machines.route(name, payload, request.signal) })
          }
          if (payload.machineId !== undefined && payload.machineId !== machines.hello.machineId) throw new AsideeError("identity-changed", "The request names another machine identity.")
        } else if (payload.host !== undefined && payload.host !== "local") throw new AsideeError("dependency", "Machine routing is unavailable.")
        const { host: _host, machineId: _identity, ...local } = payload
        return json(200, { ok: true, data: await method.run(local, request.signal) })
      } catch (error) {
        const code: ErrorCode = error instanceof AsideeError ? error.code : error instanceof SyntaxError ? "usage" : "runtime"
        return json(STATUS[code], { ok: false, error: { code, message: (error as Error).message, details: error instanceof AsideeError ? error.details : undefined } })
      }
    }
    if (viaSocket || request.method !== "GET") return json(404, { ok: false, error: { code: "not-found", message: "Not found." } })
    // A folder at CONFIG/ui replaces the built-in dashboard: it is a client of the same API, with the same token.
    const custom = join(configDir, "ui"); const path = normalize(join(custom, url.pathname === "/" ? "index.html" : pathname))
    if (path.startsWith(`${custom}/`) && await Bun.file(path).exists()) return new Response(Bun.file(path), { headers: { "x-frame-options": "DENY" } })
    if (url.pathname === "/") return new Response(BUILT_IN_UI, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } })
    return new Response("Not found", { status: 404 })
  }
}

export async function runDaemon(dirs: Dirs, cliDir: string): Promise<void> {
  checkSocketPath(dirs)
  await mkdir(dirs.state, { recursive: true, mode: 0o700 })
  const socket = socketPath(dirs)
  const alive = await fetch("http://asidee/api/version", { unix: socket, method: "POST", body: "{}" } as RequestInit).then(() => true, () => false)
  if (alive) throw new AsideeError("conflict", "An Asidee daemon is already running.")
  await rm(socket, { force: true }); await rm(streamSocketPath(dirs), { force: true })

  const identity = await machineIdentity(dirs)
  const digest = new Bun.CryptoHasher("sha256")
  for await (const bytes of Bun.file(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).stream()) digest.update(bytes)
  const providers = process.env.ASIDEE_WORKSPACE_ONLY === "1" ? [] : [new GvisorProvider(systemRunner, createHash("sha256").update(`${hostname()}\0${dirs.state}`).digest("hex").slice(0, 10)), new DockerSandboxesProvider(systemRunner)]
  const core = new Core(providers, dirs, systemRunner, cliDir, identity)
  const workspaces = new Workspaces(dirs)
  // service: systemd sets INVOCATION_ID for each unit it starts; a daemon started by hand or by the CLI has none.
  const hello: Hello = { machineId: identity, bootId: randomBytes(16).toString("hex"), version: VERSION, buildDigest: digest.digest("hex"), sourceDigest: SOURCE, protocols: [PROTOCOL], methods: Object.keys(CATALOG),
    features: ["machines", "remote-streams", "remote-forwards", "ssh", "lease-renewal"], listener: process.env.ASIDEE_SOCKET_ONLY === "1" ? "socket-only" : "dashboard", service: process.env.INVOCATION_ID ? "systemd" : "none" }
  const machines = new Machines(dirs, hello, async () => ({ hello, sandboxes: await core.list(), checkedAt: new Date().toISOString() }))
  const hosts = new Hosts(machines)
  const token = randomBytes(24).toString("hex")
  let stop: (keepSandboxes: boolean) => void = () => {}
  // A daemon that is stopping still answers `version`, so a client waits for it instead of starting a second one, and
  // takes no new work: a sandbox started now would be stopped, or left unwatched, a moment later.
  let stopping = false
  const answer = createHandler(methods(core, (keep) => stop(keep), () => stopping, machines, hosts, workspaces), token, dirs.config, machines)
  const handle = (request: Request, viaSocket: boolean, port: number): Promise<Response> =>
    stopping && URL.canParse(request.url) && new URL(request.url).pathname !== "/api/version"
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
    serveStream(connection, (request) => request.kind === "workspace"
      ? workspaces.open(request.name, request.argv, request)
      : machines.openSession(request, (request) => core.openSession(request)), (hash) => hosts.session(hash))
  })
  await new Promise<void>((resolve, reject) => { streams.once("error", reject); streams.listen(streamSocketPath(dirs), () => resolve()) })
  await chmod(streamSocketPath(dirs), 0o600)
  const wanted = Number(process.env.ASIDEE_PORT ?? DEFAULT_PORT)
  let tcpPort = 0
  const serveTcp = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (request: Request): Promise<Response> => handle(request, false, tcpPort) })
  let tcp: ReturnType<typeof serveTcp> | undefined
  if (process.env.ASIDEE_SOCKET_ONLY !== "1") {
    try { tcp = serveTcp(wanted) } catch { tcp = serveTcp(0) }
    tcpPort = tcp.port!
  }
  await writeFile(daemonFile(dirs), `${JSON.stringify({ pid: process.pid, port: tcpPort, token, version: VERSION })}\n`, { mode: 0o600 })

  // One pass at a time: a slow engine must not stack them up. The first pass covers the time no daemon was running.
  let enforcing = false
  const enforce = async () => { if (enforcing) return; enforcing = true; try { await core.enforce() } catch (error) { process.stderr.write(`${JSON.stringify({ event: "enforcement-error", message: (error as Error).message })}\n`) } finally { enforcing = false } }
  void core.sweep().then(enforce)
  const timer = setInterval(() => { void enforce() }, ENFORCE_MS)
  // The watched disk limit has a faster pass of its own between those. The next one starts diskWatchSeconds after the
  // last ended, so slow measurements never stack up, and a changed setting applies from the next pass.
  let diskTimer: ReturnType<typeof setTimeout> | undefined
  const watchDisk = async () => {
    // A config file with a mistake must not stop the watch; the default is used until it is fixed.
    const seconds = await core.configGet().then((config) => config.diskWatchSeconds, () => DEFAULT_DISK_WATCH_SECONDS)
    try { await core.watchDisk() } catch (error) { process.stderr.write(`${JSON.stringify({ event: "disk-watch-error", message: (error as Error).message })}\n`) }
    if (!stopping) diskTimer = setTimeout(() => { void watchDisk() }, seconds * 1000)
  }
  void watchDisk()
  // Workspaces have a pass of their own, so a slow du never holds up a sandbox's. It does not stop workspaces when the
  // daemon stops: nothing watches them then, and the docs say so.
  let watching = false
  const watch = async () => { if (watching || process.platform !== "darwin") return; watching = true; try { await workspaces.watch() } catch (error) { process.stderr.write(`${JSON.stringify({ event: "workspace-watch-error", message: (error as Error).message })}\n`) } finally { watching = false } }
  void watch()
  const watchTimer = setInterval(() => { void watch() }, WORKSPACE_WATCH_MS)
  const keepSandboxes = await new Promise<boolean>((resolve) => {
    stop = resolve
    process.on("SIGTERM", () => resolve(false)); process.on("SIGINT", () => resolve(false))
  })
  stopping = true
  clearInterval(timer); clearInterval(watchTimer); clearTimeout(diskTimer)
  hosts.close()
  core.closeSessions()
  workspaces.closeSessions()
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
