import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { statSync } from "node:fs"
import { hostname } from "node:os"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join, normalize } from "node:path"
import { CHECKLIST, GPU_CHECKLIST } from "./checks"
import { Core, type SandboxView } from "./core"
import { browseFolders, chooseFolder, previewFolder } from "./folders"
import { APPROVAL_SECONDS, approvalText, dialogApprover, literal, word, type Answer, type Approval, type Approver } from "./approval"
import { CATALOG, hostName, isMethod, machineIdentity, Machines, type Hello } from "./machines"
import { Hosts } from "./hosts"
import { absolutePath, PROTOCOL, sshDestination } from "./transport"
import { Preparations } from "./prepare"
import { GvisorProvider } from "./providers/gvisor"
import { OUTPUT_LIMIT, systemRunner } from "./run"
import { includeLine, userConfig } from "./ssh"
import { checkSocketPath, daemonFile, DEFAULT_DISK_WATCH_SECONDS, DEFAULT_SPEC, socketPath, streamSocketPath, validDiskGb, validName, validTerminalCommand, type Dirs } from "./state"
import { sourceDigest } from "./source" with { type: "macro" }
import { serveStream } from "./stream"
import { openTerminal } from "./terminal"
import { AsideeError, type ErrorCode } from "./types"
import builtInUi from "../ui/index.html" with { type: "text" }
import pkg from "../package.json"
import { validArgv, validWorkspaceSpec, WORKSPACE_WATCH_MS, workspaceName, Workspaces } from "./workspaces"
import { HOST_TEMP_DISCLOSURE } from "./workspace-profile"

// Bun's types describe an .html import as a page bundle; with type "text" it is the file's text.
const BUILT_IN_UI = builtInUi as unknown as string
// The dashboard's places, as ui/index.html writes them in the address bar. One segment after sandboxes or extensions is
// a name, percent-encoded, so it never holds a slash.
const DASHBOARD_ROUTE = /^\/(?:sandboxes(?:\/[^/]+){0,2}|extensions(?:\/[^/]+)?|workspaces|templates|machines|settings|setup(?:\/(?:engine|setup|test|tools|first|open))?)$/

export const VERSION: string = pkg.version
// The version plus when this program file was written. A daemon left running by an older build of the same version
// (a rebuild during development) has another one, and the CLI replaces it.
export const BUILD: string = (() => { try { return `${VERSION}+${Math.round(statSync(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).mtimeMs)}` } catch { return VERSION } })()
const STARTED = new Date().toISOString()
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
// socketOnly: never on the dashboard's port. approve: on that port, what the person at the Mac must allow first
// (core/approval.ts), or undefined when this request needs no approval; it throws for a request that would be refused.
type Method = { run: (body: Body, signal?: AbortSignal) => Promise<unknown>; socketOnly?: boolean; approve?: (body: Body) => Approval | undefined | Promise<Approval | undefined> }

// The whole API. The CLI, the UI and extensions all come through this table, so each has exactly these abilities.
// keepSandboxes: the daemon is being replaced (an upgrade), not stopped, so the sandboxes it watches keep running.
export function methods(core: Core, shutdown: (keepSandboxes: boolean) => void, stopping: () => boolean = () => false, machines?: Machines, hosts = machines ? new Hosts(machines) : undefined, workspaces = new Workspaces(core.dirs)): Record<string, Method> {
  // Approvals name the request's own values, and refuse a host for what acts only here.
  const here = (body: Body) => { if (body.host !== undefined && body.host !== "local") throw new AsideeError("usage", "This acts on this machine only; leave out host.") }
  const remote = (body: Body) => body.host !== undefined && body.host !== "local" ? String(body.host) : undefined
  const only = (body: Body, keys: string[]) => { const extra = Object.keys(body).filter((key) => !["host", "machineId", ...keys].includes(key)); if (extra.length) throw new AsideeError("usage", keys.length ? `From the dashboard this takes only ${keys.join(", ")}.` : "From the dashboard this takes no options.") }
  const workspace = (body: Body) => { here(body); return workspaceName(body.name) }
  // A prepare calls this same table, as any client would.
  const preparations = new Preparations((method, body = {}) => table[method]!.run(body as Body) as never, core.dirs, systemRunner)
  const table: Record<string, Method> = {
    version: { run: async () => ({ version: VERSION, build: BUILD, stopping: stopping() }) },
    hello: { run: async () => machines?.hello, socketOnly: true },
    summary: { run: async () => ({ hello: machines?.hello, sandboxes: await core.list(), workspaces: process.platform === "darwin" ? await workspaces.summary() : [], checkedAt: new Date().toISOString() }) },
    // Workspaces run on this Mac, not in a sandbox. Reading them and verifying them (Asidee's own fixed probes) is open, as
    // for a sandbox; whatever creates, changes, runs or stops something there is asked first. A shell is a session.
    workspaceList: { run: () => workspaces.list() },
    workspaceGet: { run: (body) => workspaces.get(String(body.name), body.withSize !== false) },
    workspaceSet: { run: (body) => workspaces.set(String(body.name), body), approve: (body) => {
      const name = workspace(body); only(body, ["name", "diskGb", "hostTemp"])
      if ((body.diskGb === undefined) === (body.hostTemp === undefined)) throw new AsideeError("usage", "Set hostTemp or diskGb, one at a time.")
      if (body.hostTemp !== undefined && typeof body.hostTemp !== "boolean") throw new AsideeError("usage", "hostTemp must be a boolean.")
      return body.diskGb !== undefined
        ? { action: `Change the watched disk limit of the workspace ${literal(name)} on this Mac to ${validDiskGb(body.diskGb, "Disk (GiB)")} GiB.`, cli: `asd workspace set ${name} disk ${validDiskGb(body.diskGb, "Disk (GiB)")}` }
        : { action: `Turn ${body.hostTemp ? "on" : "off"} the workspace ${literal(name)}'s access to this user's shared temp folder.`, details: body.hostTemp ? [HOST_TEMP_DISCLOSURE] : [], cli: `asd workspace set ${name} host-temp ${body.hostTemp ? "on" : "off"}` }
    } },
    workspaceCreate: { run: (body) => workspaces.create(body), approve: (body) => {
      here(body); only(body, ["name", "copy", "reads", "path", "hostTemp", "diskGb", "logins", "loopback"])
      const spec = validWorkspaceSpec(body)
      return { action: `Create the workspace ${literal(spec.name)}: a new folder under ~/Asidee whose commands run on this Mac's own kernel, as you, with the network open. It is not a sandbox.`,
        details: [spec.copy ? `It copies ${literal(spec.copy)} into it.` : "It starts empty.", ...(spec.reads.length ? [`Its commands may also read ${spec.reads.map(literal).join(", ")}.`] : []),
          ...(spec.path.length ? [`Their PATH also has ${spec.path.map(literal).join(", ")}.`] : []), ...(spec.hostTemp ? ["It opens this user's shared temp folder to them."] : []), `Its disk use is watched at ${spec.diskGb} GiB.`,
          spec.logins.kind === "none" ? "No logins are copied in." : `It copies your Claude login profile ${literal(spec.logins.claude)} and Codex login profile ${literal(spec.logins.codex)} into it; reading a Keychain login may ask too.`],
        cli: ["asd workspace create", spec.name, ...(spec.copy ? ["--copy", word(spec.copy)] : []), ...spec.reads.flatMap((path) => ["--read", word(path)]), ...spec.path.flatMap((path) => ["--path", word(path)]),
          ...(spec.hostTemp ? ["--host-temp"] : []), "--disk", String(spec.diskGb), ...(spec.logins.kind === "none" ? ["--no-logins"] : ["--claude-profile", spec.logins.claude, "--codex-profile", spec.logins.codex])].join(" ") }
    } },
    // Each run is asked: a window of free runs would be exactly what a leaked token needs.
    workspaceExec: { run: (body, signal) => workspaces.exec(String(body.name), body.argv, execStdin(body), signal), approve: (body) => {
      const name = workspace(body); only(body, ["name", "argv", "stdin", "stdinBase64"])
      const argv = validArgv(body.argv); const given = execStdin(body)
      // The input is shown too: to bash or any interpreter it is the program. Text only, so the dialog can show all of it.
      let input: string | undefined
      try { input = given === undefined || typeof given === "string" ? given : new TextDecoder("utf-8", { fatal: true }).decode(given) } catch { throw new AsideeError("usage", "From the dashboard a workspace run takes text input only, which the dialog shows. Use the CLI for other input.") }
      return { action: `Run a command in the workspace ${literal(name)}, on this Mac as you. It is not a sandbox:`, details: [argv.map(literal).join(" "), ...(input !== undefined ? ["With this input:", literal(input)] : [])],
        cli: `asd workspace exec ${name}${input !== undefined ? " --stdin" : ""} -- ${argv.map(word).join(" ")}` }
    } },
    workspaceShell: { run: async (body) => ({ workspace: await workspaces.get(String(body.name), false), stream: "workspace", argv: ["/bin/zsh", "-l"] }), socketOnly: true },
    workspaceStop: { run: (body) => workspaces.stop(String(body.name)), approve: (body) => {
      const name = workspace(body); only(body, ["name"])
      return { action: `Stop every process of the workspace ${literal(name)} on this Mac.`, cli: `asd workspace stop ${name}` }
    } },
    workspaceRemove: { run: (body) => workspaces.remove(String(body.name), body.confirm), approve: async (body) => {
      const name = workspace(body); only(body, ["name", "confirm"])
      if (body.confirm !== name) throw new AsideeError("usage", `Removing a workspace deletes its files. Give confirm ${name}.`)
      return { action: `Delete the workspace ${literal(name)} and its folder ${literal((await workspaces.get(name, false)).folder)}, after stopping its processes.`, cli: `asd workspace remove ${name} --confirm ${name}` }
    } },
    workspaceVerify: { run: (body) => workspaces.verify(String(body.name)) },
    hostList: { run: async () => machines?.list() },
    fleet: { run: async (body) => machines?.fleet(body.refresh) },
    hostAttach: { run: async (body) => machines?.attach(body), approve: async (body) => {
      here(body); only(body, ["name", "ssh", "binary", "stateDir"]); await machines?.experimental()
      const name = hostName(body.name); const ssh = sshDestination(body.ssh); const binary = absolutePath(body.binary); const stateDir = absolutePath(body.stateDir)
      return { action: `Register the machine ${literal(name)}, reached with ssh ${literal(ssh)}. Asidee connects to it with your SSH configuration and keys whenever it is selected.`,
        details: [`Its asd: ${literal(binary)}`, `Its state folder: ${literal(stateDir)}`], cli: `asd host attach ${name} --ssh ${word(ssh)} --binary ${word(binary)} --state-dir ${word(stateDir)}` }
    } },
    // Enrollment is reviewed as a whole plan (privileged commands, file diffs, a Docker restart) and may ask for sudo in a
    // terminal; a dialog cannot show that, so it stays with the CLI.
    hostPlan: { run: async (body) => hosts?.plan(body), socketOnly: true },
    hostApply: { run: async (body) => hosts?.apply(body), socketOnly: true },
    hostRemove: { run: async (body) => machines?.remove(body), approve: async (body) => {
      here(body); only(body, ["name", "confirm"]); await machines?.experimental()
      const name = hostName(body.name)
      if (body.confirm !== name) throw new AsideeError("usage", "Confirm removal with confirm NAME. A prepared daemon and all remote data are retained.")
      return { action: `Forget the machine ${literal(name)} and end its open sessions and forwards. Its Asidee files and service there stay.`, cli: `asd host remove ${name} --confirm ${name}` }
    } },
    sessionTarget: { run: (body) => core.sessionTarget(body.name), socketOnly: true },
    sshPrepare: { run: (body) => core.sshSetup(String(body.name), false, typeof body.publicKey === "string" ? body.publicKey : ""), socketOnly: true },
    configGet: { run: () => core.configGet() },
    configSet: { run: async (body) => { const config = await core.configSet(body); if (!config.experimental) machines?.suspend(); return config } },
    // The custom terminal command runs on this Mac as the user (core/terminal.ts), so the dashboard sets one only once the
    // person at the Mac allows it. Clearing it runs nothing.
    terminalCommandSet: { approve: (body) => {
      here(body)
      if (typeof body.terminalCommand !== "string") return undefined
      const command = validTerminalCommand(body.terminalCommand)
      return { action: "Set the command the dashboard's Terminal buttons run. It runs on this Mac as you, each time one is used, with {command} replaced by a script's path:", details: [literal(command)], cli: `asd config set terminal-command ${word(command)}` }
    }, run: async (body) => {
      // Setting a command chooses it; clearing it goes back to the default terminal if it was chosen.
      const clear = typeof body.terminalCommand !== "string"
      return core.configSet({ terminalCommand: clear ? null : body.terminalCommand, ...(!clear ? { terminal: "custom" } : (await core.configGet()).terminal === "custom" ? { terminal: "default" } : {}) }, true)
    } },
    about: { run: async () => ({ version: VERSION, build: BUILD, platform: process.platform, arch: process.arch, pid: process.pid, startedAt: STARTED, stopping: stopping(), stateDir: core.dirs.state, configDir: core.dirs.config, cli: join(core.cliDir, "asd"), builtInDefaults: DEFAULT_SPEC }) },
    usage: { run: () => core.usage() },
    openTerminal: { run: (body) => openTerminal(core.dirs, core.cliDir, systemRunner, { name: String(body.name), kind: body.kind === undefined ? "sandbox" : body.kind as "sandbox", ...(typeof body.machine === "string" ? { machine: body.machine } : {}), ...(body.profile !== undefined ? { profile: body.profile as string } : {}) }) },
    // kind "gpu": a GPU container's checklist.
    checklist: { run: async (body) => body.kind === "gpu" ? GPU_CHECKLIST : CHECKLIST },
    engines: { run: () => core.engines() },
    list: { run: () => core.list() },
    get: { run: (body) => core.get(String(body.name)) },
    create: { run: (body) => core.create(body) },
    // A create that did not finish (Manifest.unfinished): its retry, each setup step's result, and keeping it as it is.
    createRetry: { run: (body) => core.createRetry(String(body.name)) },
    createStep: { run: (body) => core.createStep(String(body.name), body.step, body.ok) },
    createKeep: { run: (body) => core.createKeep(String(body.name)) },
    start: { run: (body) => core.start(String(body.name)) },
    stop: { run: (body) => core.stop(String(body.name)) },
    remove: { run: (body) => core.remove(String(body.name), body.confirm) },
    verify: { run: (body) => core.verify(String(body.name)) },
    resize: { run: (body) => core.resize(String(body.name), body) },
    snapshot: { run: (body) => core.snapshot(String(body.name), body.as) },
    templateList: { run: () => core.templateList() },
    templateRemove: { run: (body) => core.templateRemove(body.name, body.engine) },
    // A sandbox from the built-in image, set up, saved and removed (core/prepare.ts): nothing leaves the sandbox but the template.
    templatePrepare: { run: (body) => preparations.prepare(body) },
    templatePreparing: { run: async () => preparations.list() },
    templatePrepareInfo: { run: () => preparations.info() },
    exec: { run: (body, signal) => core.exec(String(body.name), body.argv, { user: typeof body.user === "string" ? body.user : undefined, stdin: execStdin(body), signal }) },
    extensions: { run: () => core.extensions() },
    extensionInstall: { run: (body) => core.installExtension(body.id) },
    extensionRemove: { run: (body) => core.removeExtension(body.id) },
    // machine: a registered machine whose sandbox the action is for. The extension still runs here, as this machine's,
    // with ASIDEE_HOST set so its asd commands act on that machine; get there first refuses a private or missing one.
    action: { run: async (body) => {
      if (body.machine === undefined || body.machine === "local") return core.runAction(body.extension, body.action, body.sandbox, body.values)
      if (!machines) throw new AsideeError("dependency", "Machine routing is unavailable.")
      const host = await machines.resolve(body.machine)
      await core.actionFor(body.extension, body.action, host.name)
      const sandbox = await machines.route("get", { host: host.name, name: validName(body.sandbox) }) as SandboxView
      return core.runAction(body.extension, body.action, sandbox.name, body.values, host.name)
    } },
    visibilitySet: { run: (body) => core.setVisibility(String(body.name), body.visibility) },
    // For picking a folder to copy in: folder names under the home, and what a copy would take. Names and sizes only.
    folderBrowse: { run: (body) => browseFolders(body.path === undefined ? "~" : String(body.path)) },
    folderPreview: { run: (body) => previewFolder(String(body.source ?? ""), body.logins === true) },
    folderChoose: { run: () => chooseFolder() },
    forwardAdd: { run: (body) => core.forwardAdd(String(body.name), body.port, body.localPort) },
    forwardList: { run: async (body) => core.forwardList(body.name) },
    forwardRemove: { run: async (body) => machines?.forwardRemove(body.id) ?? core.forwardRemove(body.id) },
    linkAdd: { run: (body) => core.links.add(body.from, body.to, body.port) },
    linkList: { run: (body) => core.links.list(body.name) },
    linkRemove: { run: (body) => core.links.remove(body.from, body.to, body.port) },
    sshAccess: { run: (body) => core.sshAccess(String(body.name)) },
    // Without writeConfig it writes only Asidee's own SSH files; with it, a line in the user's SSH configuration, which is asked.
    sshSetup: { run: (body) => core.sshSetup(String(body.name), body.writeConfig === true), approve: (body) => {
      if (body.writeConfig !== true) return undefined
      only(body, ["name", "writeConfig"])
      const name = validName(body.name); const host = remote(body)
      return { action: `Set up SSH for the sandbox ${literal(name)}${host ? ` on the machine ${literal(host)}` : ""}, and add this line at the top of your SSH configuration, ${literal(userConfig())}, unless it is there already:`,
        details: [literal(includeLine(core.dirs))], cli: `asd${host ? ` --host ${word(host)}` : ""} ssh setup ${name} --write-config` }
    } },
    shutdown: { run: async (body) => { setTimeout(() => shutdown(body.keepSandboxes === true), 50); return { stopping: true } }, approve: async (body) => {
      // Keeping sandboxes is the CLI's upgrade path, over the socket only; the page gets what asd daemon stop does.
      here(body); only(body, [])
      const running = (await core.list()).filter((sandbox) => sandbox.status === "running").map((sandbox) => literal(sandbox.name))
      return { action: "Stop the Asidee daemon on this Mac. The dashboard stops answering until an asd command starts it again.",
        details: [`It stops the running sandboxes whose disk limit it watches. Running now: ${running.join(", ") || "none"}.`], cli: "asd daemon stop" }
    } },
  }
  return table
}

// A routed request: one that another machine's Asidee sent through machine routing (Machines.route always names the
// machine it is for in x-asidee-machine; a routed stream names it as machineId, see Core.openSession). It sees and acts on
// public sandboxes only, can make one private but never public, creates only while this machine lets other machines
// create here (and what it creates is public), and cannot turn that setting on. Only the methods routing sends are
// taken. Enrollment's test sandbox is made by a request without the header, as the person enrolling approved.
// The dashboard is named only on a machine that has one: an enrolled machine's service answers on its socket only.
export const remoteCreateOff = (dashboard = process.env.ASIDEE_SOCKET_ONLY !== "1") => `This machine does not let other machines create sandboxes here. To allow it, run on this machine: asd config set remote-create on${dashboard ? " (or turn on “Let other machines create sandboxes here” in its dashboard's Settings)" : ""}.`
const NAMED: Partial<Record<string, (body: Body) => unknown>> = Object.fromEntries([
  ...["create", "get", "start", "stop", "remove", "verify", "resize", "snapshot", "exec", "createRetry", "createStep", "createKeep", "sessionTarget", "sshPrepare", "visibilitySet"].map((method) => [method, (body: Body) => body.name]),
  ["action", (body: Body) => body.sandbox]])
const shared = (sandboxes: SandboxView[]) => sandboxes.filter((sandbox) => sandbox.visibility === "public")
export async function routedRun(core: Core, name: string, method: Method, body: Body, signal?: AbortSignal): Promise<unknown> {
  if (!isMethod(name) || CATALOG[name][1] === "primary") throw new AsideeError("usage", `${name} is not available to other machines.`)
  const target = NAMED[name]?.(body)
  if (target !== undefined) await core.visible(target)
  if (name === "create") {
    if (!(await core.configGet()).remoteCreate) throw new AsideeError("usage", remoteCreateOff())
    return core.create(body, "public")
  }
  if (name === "configSet" && body.remoteCreate === true) throw new AsideeError("usage", "Only this machine can let other machines create sandboxes here: run asd config set remote-create on on it.")
  if (name === "visibilitySet") return core.setVisibility(String(body.name), body.visibility, true)
  const result = await method.run(body, signal)
  const names = async () => new Set(shared(await core.list()).map((sandbox) => sandbox.name))
  if (name === "list") return shared(result as SandboxView[])
  if (name === "summary") return { ...(result as object), sandboxes: shared((result as { sandboxes: SandboxView[] }).sandboxes), workspaces: [] }
  if (name === "usage") { const seen = await names(); return (result as Array<{ name: string }>).filter((entry) => seen.has(entry.name)) }
  if (name === "templateList" || name === "templateRemove") {
    const seen = await names(), hide = (template: { dependants: string[] }) => ({ ...template, dependants: template.dependants.filter((entry) => seen.has(entry)) })
    return Array.isArray(result) ? result.map(hide) : hide(result as { dependants: string[] })
  }
  return result
}

const STATUS: Record<ErrorCode, number> = { usage: 400, "not-found": 404, conflict: 409, dependency: 424, "check-failed": 422, "probes-required": 422, runtime: 500, offline: 503, incompatible: 409, "identity-changed": 409, "outcome-unknown": 504 }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const refuse = (status: number, message: string) => json(status, { ok: false, error: { code: "usage", message } })
// approval says why an approvable request did not run, for the page to tell apart; command is the CLI's way to do it.
const APPROVAL: Record<Exclude<Answer, "allow"> | "busy", [number, ErrorCode, string]> = {
  deny: [403, "usage", "Denied on this Mac. Nothing was done."],
  timeout: [403, "usage", `Nobody answered the dialog on this Mac within ${APPROVAL_SECONDS} seconds, so it was denied. Nothing was done.`],
  unavailable: [403, "usage", "This daemon cannot ask on this machine's screen (that needs macOS and a logged-in desktop session), so only the CLI can do this. Nothing was done."],
  busy: [409, "conflict", "Another request is waiting for an answer on this Mac. Nothing was done; answer that dialog first."],
}
const notApproved = (answer: keyof typeof APPROVAL, approval: Approval) => {
  const [status, code, message] = APPROVAL[answer]
  return json(status, { ok: false, error: { code, message: `${message} From the CLI: ${approval.cli}`, details: { approval: answer === "deny" ? "denied" : answer === "timeout" ? "timed-out" : answer, command: approval.cli } } })
}

// viaSocket: the request came over the Unix socket, which only this user can open. Otherwise it came over loopback TCP,
// where any local process or web page can try, so it must carry the token and name this server as its Host (a page on
// another site that resolves its own name to 127.0.0.1 does not). There a method with approve runs only once the person
// at the Mac allows it, one dialog at a time, so a token holder cannot stack them up. Only the daemon passes the real
// dialog; any other caller, a test included, gets "unavailable" and never puts one on the screen.
// core: this machine's sandboxes, for requests from other machines (routedRun); without it they are refused.
export function createHandler(table: Record<string, Method>, token: string, configDir: string, machines?: Machines, approver: Approver = async () => "unavailable", core?: Core) {
  let asking = false
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
          if (isMethod(name) && !viaSocket && CATALOG[name][0] === "socket") return refuse(403, "This method is only available to the CLI.")
          if ((payload.host === undefined || payload.host === "local") && payload.machineId !== undefined && payload.machineId !== machines.hello.machineId) throw new AsideeError("identity-changed", "The request names another machine identity.")
        }
        if (!viaSocket && method.approve) {
          const approval = await method.approve(payload)
          if (approval) {
            approvalText(approval)
            if (asking) return notApproved("busy", approval)
            asking = true
            let answer: Answer
            try { answer = await approver(approval) } catch { answer = "unavailable" } finally { asking = false }
            if (answer !== "allow") return notApproved(answer, approval)
          }
        }
        if (machines) {
          const name = url.pathname.slice(5)
          if (payload.host !== undefined && payload.host !== "local") {
            if (!isMethod(name)) throw new AsideeError("usage", "This method cannot be routed.")
            return json(200, { ok: true, data: await machines.route(name, payload, request.signal) })
          }
        } else if (payload.host !== undefined && payload.host !== "local") throw new AsideeError("dependency", "Machine routing is unavailable.")
        const { host: _host, machineId: _identity, ...local } = payload
        if (request.headers.has("x-asidee-machine")) {
          if (!core) throw new AsideeError("dependency", "This daemon cannot answer other machines.")
          return json(200, { ok: true, data: await routedRun(core, url.pathname.slice(5), method, local, request.signal) })
        }
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
    if (url.pathname !== "/" && !DASHBOARD_ROUTE.test(url.pathname)) return new Response("Not found", { status: 404 })
    // A place in the dashboard (/sandboxes/NAME, …) is the dashboard's page, which reads the path: the custom one if
    // there is one, so a copy of the built-in page survives a reload too.
    const customIndex = join(custom, "index.html")
    if (url.pathname !== "/" && await Bun.file(customIndex).exists()) return new Response(Bun.file(customIndex), { headers: { "x-frame-options": "DENY" } })
    return new Response(BUILT_IN_UI, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } })
  }
}

export async function runDaemon(dirs: Dirs, cliDir: string): Promise<void> {
  checkSocketPath(dirs)
  // Set only for an extension acting on another machine's sandbox; a daemon started from one must not pass it on to
  // every extension it runs.
  delete process.env.ASIDEE_HOST
  await mkdir(dirs.state, { recursive: true, mode: 0o700 })
  const socket = socketPath(dirs)
  const alive = await fetch("http://asidee/api/version", { unix: socket, method: "POST", body: "{}" } as RequestInit).then(() => true, () => false)
  if (alive) throw new AsideeError("conflict", "An Asidee daemon is already running.")
  await rm(socket, { force: true }); await rm(streamSocketPath(dirs), { force: true })

  const identity = await machineIdentity(dirs)
  const digest = new Bun.CryptoHasher("sha256")
  for await (const bytes of Bun.file(Bun.main.startsWith("/$bunfs/") ? process.execPath : Bun.main).stream()) digest.update(bytes)
  const providers = process.env.ASIDEE_WORKSPACE_ONLY === "1" ? [] : [new GvisorProvider(systemRunner, createHash("sha256").update(`${hostname()}\0${dirs.state}`).digest("hex").slice(0, 10))]
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
  const answer = createHandler(methods(core, (keep) => stop(keep), () => stopping, machines, hosts, workspaces), token, dirs.config, machines, dialogApprover(systemRunner), core)
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
