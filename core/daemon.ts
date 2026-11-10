import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { statSync } from "node:fs"
import { hostname } from "node:os"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, normalize } from "node:path"
import { CHECKLIST } from "./checks"
import { Core } from "./core"
import { DockerSandboxesProvider } from "./providers/docker-sandboxes"
import { GvisorProvider } from "./providers/gvisor"
import { systemRunner } from "./run"
import { checkSocketPath, daemonFile, socketPath, type Dirs } from "./state"
import { PaddockError, type ErrorCode } from "./types"
import builtInUi from "../ui/index.html" with { type: "text" }
import pkg from "../package.json"

// Bun's types describe an .html import as a page bundle; with type "text" it is the file's text.
const BUILT_IN_UI = builtInUi as unknown as string

export const VERSION: string = pkg.version
// The version plus when this program file was written. A daemon left running by an older build of the same version
// (a rebuild during development) has another one, and the CLI replaces it.
export const BUILD: string = (() => { try { return `${VERSION}+${Math.round(statSync(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).mtimeMs)}` } catch { return VERSION } })()
const DEFAULT_PORT = 7717
const ENFORCE_MS = 30_000

type Body = Record<string, unknown>
type Method = { run: (body: Body) => Promise<unknown>; socketOnly?: boolean }

// The whole API. The CLI, the UI and extensions all come through this table, so each has exactly these abilities.
// keepSandboxes: the daemon is being replaced (an upgrade), not stopped, so the sandboxes it watches keep running.
export function methods(core: Core, shutdown: (keepSandboxes: boolean) => void, stopping: () => boolean = () => false): Record<string, Method> {
  return {
    version: { run: async () => ({ version: VERSION, build: BUILD, stopping: stopping() }) },
    checklist: { run: async () => CHECKLIST },
    engines: { run: () => core.engines() },
    list: { run: () => core.list() },
    get: { run: (body) => core.get(String(body.name)) },
    create: { run: (body) => core.create(body) },
    start: { run: (body) => core.start(String(body.name)) },
    stop: { run: (body) => core.stop(String(body.name)) },
    remove: { run: (body) => core.remove(String(body.name), body.confirm) },
    verify: { run: (body) => core.verify(String(body.name)) },
    exec: { run: (body) => core.exec(String(body.name), body.argv, { user: typeof body.user === "string" ? body.user : undefined, stdin: typeof body.stdin === "string" ? body.stdin : undefined }) },
    attach: { run: (body) => core.attach(String(body.name), body.argv), socketOnly: true },
    extensions: { run: () => core.extensions() },
    action: { run: (body) => core.runAction(body.extension, body.action, body.sandbox, body.values) },
    shutdown: { run: async (body) => { setTimeout(() => shutdown(body.keepSandboxes === true), 50); return { stopping: true } }, socketOnly: true },
  }
}

const STATUS: Record<ErrorCode, number> = { usage: 400, "not-found": 404, conflict: 409, dependency: 424, "check-failed": 422, runtime: 500 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const refuse = (status: number, message: string) => json(status, { ok: false, error: { code: "usage", message } })

// viaSocket: the request came over the Unix socket, which only this user can open. Otherwise it came over loopback TCP,
// where any local process or web page can try, so it must carry the token and name this server as its Host (a page on
// another site that resolves its own name to 127.0.0.1 does not).
export function createHandler(table: Record<string, Method>, token: string, configDir: string) {
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
        return json(200, { ok: true, data: await method.run(body as Body) })
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
  await rm(socket, { force: true })

  const core = new Core([new GvisorProvider(systemRunner, createHash("sha256").update(`${hostname()}\0${dirs.state}`).digest("hex").slice(0, 10)), new DockerSandboxesProvider(systemRunner)], dirs, systemRunner, cliDir)
  const token = randomBytes(24).toString("hex")
  let stop: (keepSandboxes: boolean) => void = () => {}
  // A daemon that is stopping still answers `version`, so a client waits for it instead of starting a second one, and
  // takes no new work: a sandbox started now would be stopped, or left unwatched, a moment later.
  let stopping = false
  const answer = createHandler(methods(core, (keep) => stop(keep), () => stopping), token, dirs.config)
  const handle = (request: Request, viaSocket: boolean, port: number): Promise<Response> =>
    stopping && new URL(request.url).pathname !== "/api/version"
      ? Promise.resolve(json(STATUS.conflict, { ok: false, error: { code: "conflict", message: "The daemon is stopping. Try again in a moment." } }))
      : answer(request, viaSocket, port)

  // idleTimeout 0: creating a sandbox can take minutes (an image download), and Bun otherwise drops a quiet request
  // after 10 s. Its types do not list the option for a Unix socket.
  const unix = Bun.serve({ unix: socket, idleTimeout: 0, fetch: (request: Request) => handle(request, true, 0) } as unknown as Parameters<typeof Bun.serve>[0])
  await chmod(socket, 0o600)
  const wanted = Number(process.env.PADDOCK_PORT ?? DEFAULT_PORT)
  let tcpPort = 0
  const serveTcp = (port: number) => Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: (request: Request): Promise<Response> => handle(request, false, tcpPort) })
  let tcp
  try { tcp = serveTcp(wanted) } catch { tcp = serveTcp(0) }
  tcpPort = tcp.port!
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
  if (!keepSandboxes) await core.stopWatched()
  await Promise.all([unix.stop(true), tcp.stop(true)])
  await rm(socket, { force: true }); await rm(daemonFile(dirs), { force: true })
}

export async function readDaemonFile(dirs: Dirs): Promise<{ pid: number; port: number; token: string; version: string } | undefined> {
  try { return JSON.parse(await readFile(daemonFile(dirs), "utf8")) } catch { return undefined }
}
