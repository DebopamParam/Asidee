import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Window } from "happy-dom"
import { workspaceDisclosure, HOST_TEMP_DISCLOSURE } from "../../core/workspace-profile"
import { CHECKLIST, historical } from "../../core/checks"
import { CATALOG } from "../../core/machines"
import type { CheckResult } from "../../core/types"

// Runs the dashboard's own script against a DOM, with the daemon's API replaced by canned replies. It checks what the
// page does, not how it looks. Stored checks are shaped as the core returns them.
const check = (id: string, status: string, detail: string) => ({ id, status, evidence: "probed", detail })
const sandbox = (over: object = {}) => ({
  name: "demo", status: "running", engine: "Fake engine", createdAt: "", spec: { name: "demo", image: "x", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 },
  lastVerify: historical({ at: "2026-11-10T10:00:00Z", results: [check("kernel", "pass", "gVisor answers."), check("net-host", "fail", "A connection reached the host."), check("disk", "weak", "Watched, not capped.")] as CheckResult[] }),
  ...over,
})
const extension = { id: "tools", name: "Tools", actions: [{ id: "install", label: "Install thing", scope: "sandbox", run: ["./x"], fields: [{ id: "version", label: "Version", type: "text", default: "latest" }, { id: "force", label: "Force", type: "checkbox" }] }] }

async function page(replies: Record<string, (body: any) => unknown>, url = "http://127.0.0.1:7717/#token=secret") {
  const html = await readFile(join(import.meta.dir, "..", "..", "ui", "index.html"), "utf8")
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"))
  const window = new Window({ url })
  window.document.write(html.replace(/<script>[\s\S]*<\/script>/, ""))
  const calls: Array<{ method: string; body: any; authorization: string | null }> = []
  const fetch = async (path: string, init: { headers: Record<string, string>; body: string }) => {
    const method = path.slice(5); const body = JSON.parse(init.body)
    calls.push({ method, body, authorization: init.headers.authorization ?? null })
    try { return { json: async () => ({ ok: true, data: await (replies[method] ?? (() => { throw new Error(`no reply for ${method}`) }))(body) }) } }
    catch (error) { return { json: async () => ({ ok: false, error: { message: (error as Error).message, code: (error as { code?: string }).code, details: (error as { details?: unknown }).details } }) } }
  }
  const prompts: string[] = []
  const globals = { window, document: window.document, location: window.location, history: window.history, sessionStorage: window.sessionStorage, fetch,
    setInterval: () => 0, prompt: (text: string) => { prompts.push(text); return "demo" }, FormData: window.FormData, URLSearchParams, Event: window.Event }
  new Function(...Object.keys(globals), script)(...Object.values(globals))
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
  await settle()
  const text = (selector: string) => (window.document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ")
  // While a pop-up is open, only its buttons can be clicked.
  const button = (label: string) => [...(window.document.querySelector("#modal:not([hidden])") ?? window.document).querySelectorAll("button")].find((node) => node.textContent === label)!
  // Opens the pop-up behind a card on a sandbox.
  const tile = async (title: string) => { ([...window.document.querySelectorAll("#sandboxes .tile")].find((node) => node.querySelector(".t")!.textContent === title) as any).click(); await settle() }
  return { window, calls, prompts, settle, text, button, tile }
}

const base = { configGet: () => ({ defaults: {}, requireProbes: true }), checklist: () => CHECKLIST, engines: () => [{ id: "fake:1", label: "Fake engine", ready: true, problems: [], capabilities: { kernelIsolation: "gvisor", networkGuard: true, diskLimit: "watched" } }], extensions: () => ({ extensions: [extension], errors: [] }) }

test("workspaces appear separately with their disclosure, and unavailable inventory is unknown", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [{ name: "render", status: "idle", processes: 0, folder: "/fixture/render", disclosure: "Workspace, not a sandbox. Loopback open; no limits." }] }) })
  expect(ui.text("#workspaces")).toContain("render: workspace, not a sandbox")
  expect(ui.text("#workspaces")).toContain("Loopback open; no limits")
  expect(ui.text("#sandboxes")).not.toContain("render")
  const unavailable = await page({ ...base, list: () => [], summary: () => { throw new Error("Inventory unavailable") } })
  expect(unavailable.text("#workspaces")).toContain("Workspaces unknown: Inventory unavailable")
  expect(unavailable.text("#workspaces")).not.toContain("No workspaces")
})

test("the dashboard lists sandboxes, sends the token, and hides it from the address bar", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  expect(ui.text("#sandboxes")).toContain("demo running")
  expect(ui.text("#sandboxes")).toContain("2 CPU · 4 GB memory · 20 GB disk · Fake engine")
  expect(ui.calls.every((call) => call.authorization === "Bearer secret")).toBe(true)
  expect(ui.window.location.hash).toBe("")
  expect(ui.text("#engines")).toContain("Kernel isolation: gvisor")
})

test("past checks show what they measured and when, always as a past result", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  expect(ui.text("#sandboxes")).toContain(`Checked ${new Date("2026-11-10T10:00:00Z").toLocaleString()}: 1 fail · 1 weak · 1 pass (past result; it may have changed since)`)
  ui.button("Checks…").click(); await ui.settle()
  expect(ui.text("#modal")).toContain("That is a past result: what holds now is unknown until the next check.")
  const checks = ui.text("ul.checks")
  expect(checks).toContain("✗Cannot reach the host — does not hold then, probedA connection reached the host.")
  expect(checks).toContain("— holds in a weaker form then, probedWatched, not capped.")
  expect(checks).toContain("— held then, probedgVisor answers.")
  expect(checks).not.toContain("current"); expect(checks).not.toContain("Previous")
})

test("verify, stop and remove call the API; remove sends the typed name as the confirmation", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], verify: () => ({}), stop: () => ({}), remove: () => ({}) })
  ui.button("Checks…").click(); await ui.settle()
  ui.button("Check now").click(); await ui.settle()
  ui.button("Close").click(); await ui.settle()
  ui.button("Stop").click(); await ui.settle()
  ui.button("Remove").click(); await ui.settle()
  expect(ui.prompts[0]).toContain("deletes demo")
  const sent = ui.calls.filter((call) => ["verify", "stop", "remove"].includes(call.method)).map((call) => [call.method, call.body])
  expect(sent).toEqual([["verify", { name: "demo" }], ["stop", { name: "demo" }], ["remove", { name: "demo", confirm: "demo" }]])
})

test("an extension's action is drawn as a form from its declaration and sends its fields", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], action: () => ({ exitCode: 0, stdout: "installed 1.2\n", stderr: "" }) })
  await ui.tile("Tools")
  const form = ui.button("Install thing").closest("form") as any
  expect(form.elements.namedItem("version").value).toBe("latest")
  form.elements.namedItem("version").value = "1.2"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.find((call) => call.method === "action")!.body).toEqual({ extension: "tools", action: "install", sandbox: "demo", values: { version: "1.2", force: "false" } })
  expect(ui.text("#modal pre")).toBe("installed 1.2")
})

test("a stopped sandbox shows why it stopped, offers Start, and has no extension actions", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ status: "stopped", stopReason: "Stopped by the disk watch: it used 2.1 GB of its 2 GB." })] })
  expect(ui.text("#sandboxes")).toContain("Stopped by the disk watch")
  expect(ui.button("Start")).toBeDefined()
  expect(ui.button("Install thing")).toBeUndefined()
})

test("an enforcement failure is visible without opening historical checks", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ enforcementProblem: { at: "2026-11-12T00:00:00Z", message: "guard unreadable" } })] })
  expect(ui.text("#sandboxes")).toContain("Enforcement problem at 2026-11-12T00:00:00Z: guard unreadable")
  expect(ui.text("ul.checks")).toBe("")
})

test("creating sends the form, and an error from the core is shown as it is", async () => {
  let made = false
  const ui = await page({ ...base, list: () => made ? [sandbox({ name: "fresh", lastVerify: undefined })] : [], create: (body) => {
    if (body.name === "bad") throw new Error("bad was not started: No host folders are mounted")
    made = true; return { sandbox: { name: "fresh" } }
  } })
  expect(ui.text("#sandboxes")).toContain("No sandboxes yet")
  const form = ui.window.document.getElementById("create") as any
  const submit = async (name: string) => { form.elements.namedItem("name").value = name; form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle() }
  await submit("bad")
  expect(ui.text("#create-error")).toBe("bad was not started: No host folders are mounted")
  await submit("fresh")
  expect(ui.calls.find((call) => call.method === "create" && call.body.name === "fresh")!.body).toMatchObject({ name: "fresh", engine: "fake:1", image: "" })
  expect(ui.text("#sandboxes")).toContain("fresh running")
})

test("without a token the page says how to open it", async () => {
  const ui = await page({ ...base, list: () => { throw new Error("Open the dashboard with the link from `asd ui`.") } }, "http://127.0.0.1:7717/")
  expect(ui.text("#notice")).toContain("asd ui")
})

test("a refresh that changes nothing leaves a half-filled form alone", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  await ui.tile("Tools")
  const input = (ui.button("Install thing").closest("form") as any).elements.namedItem("version")
  input.value = "typing"
  // The page's own refresh, as its timer would call it.
  await (ui.window as any).asideeRefresh(); await ui.settle()
  expect(ui.window.document.contains(input)).toBe(true)
})

test("an unknown-probe create refusal opens Settings and focuses the toggle without changing the requirement", async () => {
  const ui = await page({ ...base, list: () => [], create: () => { throw Object.assign(new Error("Cannot reach the host: helper unavailable. Use asd config set require-probes off."), { code: "probes-required" }) } })
  const form = ui.window.document.getElementById("create") as any
  form.elements.namedItem("name").value = "demo"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.text("#create-error")).toContain("helper unavailable")
  const toggle = ui.window.document.getElementById("require-probes") as any
  expect(toggle.checked).toBe(true)
  ui.button("Open settings").click(); await ui.settle()
  expect(ui.window.document.getElementById("settings-section")!.hasAttribute("hidden")).toBe(false)
  expect(ui.window.document.getElementById("sandbox-section")!.hasAttribute("hidden")).toBe(true)
  expect(ui.window.document.activeElement).toBe(toggle)
  expect(toggle.checked).toBe(true)
  expect(ui.calls.some((call) => call.method === "configSet")).toBe(false)
  ui.button("Sandboxes").click()
  expect(ui.window.document.getElementById("sandbox-section")!.hasAttribute("hidden")).toBe(false)
})

test("Settings reads the daemon value, changes only on input, and restores the value on a refused write", async () => {
  let requireProbes = false
  const ui = await page({ ...base, list: () => [], configGet: () => ({ requireProbes }), configSet: (body) => {
    if (body.requireProbes === false) throw new Error("Settings could not be saved.")
    requireProbes = body.requireProbes; return { requireProbes }
  } })
  ui.button("Settings").click()
  expect(ui.text("#settings-section")).toContain("sandboxes can be created without their isolation probes having run; they show as not verified")
  const toggle = ui.window.document.getElementById("require-probes") as any
  expect(toggle.checked).toBe(false); expect(toggle.disabled).toBe(false)
  toggle.checked = true; toggle.dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "configSet").map((call) => call.body)).toEqual([{ requireProbes: true }])
  expect(toggle.checked).toBe(true)
  toggle.checked = false; toggle.dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.text("#settings-error")).toBe("Settings could not be saved.")
  expect(toggle.checked).toBe(true); expect(toggle.disabled).toBe(false)
})

test("an unavailable setting cannot be changed and a sandbox with unknown probes is visibly not verified", async () => {
  const ui = await page({ ...base, configGet: () => { throw new Error("config unreadable") }, list: () => [sandbox({ lastVerify: historical({ at: "2026-11-15T00:00:00Z", results: [{ id: "net-host", status: "unknown", evidence: "none", detail: "The control did not answer." }] }) })] })
  expect((ui.window.document.getElementById("require-probes") as any).disabled).toBe(true)
  expect(ui.text("#settings-error")).toContain("config unreadable")
  expect(ui.text("#sandboxes")).toContain(": 1 unknown (past result; it may have changed since)")
  expect(ui.text("#sandboxes")).not.toContain("✓")
  ui.button("Checks…").click(); await ui.settle()
  expect(ui.text("ul.checks")).toContain("— could not be checked then, noneThe control did not answer.")
})


test("a workspace row shows why the daemon stopped it and a disk watch it could not make; every control that acts on the Mac says it asks there", async () => {
  const stopReason = "Stopped by the daemon at 2026-11-16T10:00:00Z: render uses 2.00 GB of its 1 GB disk limit. Free space in /w/render, or raise the limit: asd workspace set render disk N"
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [{ name: "render", status: "idle", processes: 0, folder: "/w/render", spec: { hostTemp: false, diskGb: 1 }, disclosure: workspaceDisclosure(false), stopReason,
    enforcementProblem: { at: "2026-11-16T10:00:30Z", message: "Its size could not be measured." } }] }) })
  const row = ui.window.document.querySelector("#workspaces .panel")!
  expect(row.textContent).toContain(stopReason)
  expect(row.textContent).toContain("Disk watch unknown at 2026-11-16T10:00:30Z: Its size could not be measured.")
  expect([...row.querySelectorAll("button")].map((node) => node.textContent).filter((label) => !["Terminal", "Verify", "Copy"].includes(label!) && !label!.endsWith(" (asks on the Mac)"))).toEqual([])
  expect([...row.querySelectorAll("form")].every((form) => form.querySelector("button")!.textContent!.endsWith(" (asks on the Mac)"))).toBe(true)
  expect(row.textContent).toContain("asd workspace stop render")
})

test("each workspace row shows host-temp state and the shared-temp disclosure", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [false, true].map((hostTemp) => ({ name: hostTemp ? "shared" : "closed", status: "idle", spec: { hostTemp }, disclosure: workspaceDisclosure(hostTemp) })) }) })
  const rows = [...ui.window.document.querySelectorAll("#workspaces .panel")].map((row) => row.textContent)
  expect(rows[0]).toContain("host-temp off"); expect(rows[0]).not.toContain(HOST_TEMP_DISCLOSURE)
  expect(rows[1]).toContain("host-temp on (shared, weaker)"); expect(rows[1]).toContain(HOST_TEMP_DISCLOSURE)
})

const usageOf = (over: object = {}) => ({ name: "demo", running: true, cpus: 2, memoryLimitBytes: 4 * 1024 ** 3, pidsLimit: 4096, diskLimitBytes: 20 * 1024 ** 3, cpuPercent: 37.5, memoryBytes: 512 * 1024 ** 2, tasks: 40, diskBytes: 3 * 1024 ** 3, diskMeasuredAt: "2026-11-18T10:00:00Z", ...over })

test("live usage is written in place, so a form being typed in survives it", async () => {
  let cpuPercent = 37.5
  const ui = await page({ ...base, list: () => [sandbox()], usage: () => [usageOf({ cpuPercent })] })
  expect(ui.text("[data-usage=demo]")).toContain("CPU 37.5% of 200% · memory 512 MB of 4.00 GB · 40 of 4096 tasks · disk 3.00 GB of 20.00 GB")
  await ui.tile("Resize")
  const input = (ui.button("Resize").closest("form") as any).elements.namedItem("cpus")
  input.value = "3"
  cpuPercent = 180
  await (ui.window as any).asideeRefresh(); await ui.settle()
  expect(ui.text("[data-usage=demo]")).toContain("CPU 180% of 200%")
  expect(ui.window.document.contains(input)).toBe(true)
  ui.button("Close").click(); await ui.settle()
  ui.button("Usage").click(); await ui.settle()
  const cells = [...ui.window.document.querySelectorAll("#usage tbody td")].map((cell) => cell.textContent)
  expect(cells.slice(0, 5)).toEqual(["demo", "running", "180% of 200%", "512 MB of 4.00 GB", "40 of 4096"])
  expect(cells[5]).toStartWith("3.00 GB of 20.00 GB at ")
})

test("Terminal asks the daemon to open a window for that sandbox or workspace and shows what it ran", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [{ name: "notes", status: "idle", spec: { hostTemp: false }, disclosure: "Workspace, not a sandbox." }] }),
    openTerminal: (body) => ({ opened: body.name, terminal: "ghostty", command: `'/x/asd' 'shell' '${body.name}'` }) })
  ui.button("Terminal").click(); await ui.settle()
  expect(ui.text("#sandboxes pre")).toContain("Opened in ghostty. If no window appeared, run: '/x/asd' 'shell' 'demo'")
  ;(ui.window.document.querySelector("#workspaces button") as any).click(); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "openTerminal").map((call) => call.body)).toEqual([{ name: "demo", kind: "sandbox" }, { name: "notes", kind: "workspace" }])
})

test("a sandbox's tool cards resize, runs a command, adds a forward and a link, and saves a template", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], forwardList: () => [], linkList: () => [],
    resize: () => ({ changes: [{ limit: "cpus", from: 2, to: 3, applies: "now" }], checks: [] }), exec: () => ({ exitCode: 0, stdout: "hi\n", stderr: "" }),
    forwardAdd: (body) => ({ id: "f1", name: "demo", localPort: 8080, port: Number(body.port), connections: 0 }), linkAdd: (body) => ({ ...body, address: "other:5432", trust: "trusted" }),
    snapshot: (body) => ({ template: { name: body.as }, contents: "files" }) })
  const submit = async (card: string, label: string, values: Record<string, string>) => {
    await ui.tile(card)
    const form = ui.button(label).closest("form") as any
    for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value
    form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  }
  await submit("Resize", "Resize", { cpus: "3" }); expect(ui.text("#modal pre")).toContain("cpus: 2 → 3, now")
  await submit("Run a command", "Run", { command: "echo hi" }); expect(ui.text("#modal pre")).toBe("hi")
  await submit("Ports", "Add forward", { port: "8080" })
  await submit("Ports", "Add link", { to: "other", port: "5432" })
  await submit("Save as a template", "Save", { as: "base" }); expect(ui.text("#modal pre")).toContain("Saved template base.")
  const sent = ui.calls.filter((call) => ["resize", "exec", "forwardAdd", "linkAdd", "snapshot"].includes(call.method)).map((call) => [call.method, call.body])
  expect(sent).toEqual([["resize", { name: "demo", cpus: "3" }], ["exec", { name: "demo", argv: ["sh", "-c", "echo hi"] }], ["forwardAdd", { name: "demo", port: "8080" }],
    ["linkAdd", { from: "demo", to: "other", port: "5432" }], ["snapshot", { name: "demo", as: "base" }]])
  await ui.tile("SSH and editors")
  expect(ui.text("#modal")).toContain("asd ssh setup demo --write-config")
})

test("Settings shows every setting; each saves on its own, and the defaults save together", async () => {
  let config: any = { defaults: { cpus: 1 }, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" }
  const ui = await page({ ...base, list: () => [], about: () => ({ build: "0.4.0+1", builtInDefaults: { image: "img", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, docker: false }, platform: "darwin", arch: "arm64", pid: 1, startedAt: "2026-11-18T00:00:00Z", stateDir: "/s", configDir: "/c", cli: "/x/asd" }),
    configGet: () => config, configSet: (body) => { config = { ...config, ...body }; for (const key of Object.keys(body)) if (body[key] === null) delete config[key]; if (body.defaults === null) config.defaults = {}; return config } })
  ui.button("Settings").click(); await ui.settle()
  const get = (id: string) => ui.window.document.getElementById(id) as any
  expect(get("disk-watch").value).toBe("5"); expect(get("terminal").value).toBe("default"); expect(get("d-cpus").value).toBe("1"); expect(get("d-memory").placeholder).toBe("4")
  expect(get("terminal").querySelector("option[value=custom]").disabled).toBe(true)
  expect(ui.text("#about")).toContain("/x/asd")
  get("disk-watch").value = "2"; get("disk-watch").dispatchEvent(new ui.window.Event("change")); await ui.settle()
  get("terminal").value = "ghostty"; get("terminal").dispatchEvent(new ui.window.Event("change")); await ui.settle()
  get("d-cpus").value = ""; get("d-docker").value = "true"; get("default-engine").value = "fake:1"
  get("defaults").dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "configSet").map((call) => call.body)).toEqual([{ diskWatchSeconds: 2 }, { terminal: "ghostty" }, { defaults: { docker: true }, engine: "fake:1" }])
  expect(config).toMatchObject({ diskWatchSeconds: 2, terminal: "ghostty", defaults: { docker: true }, engine: "fake:1" })
  expect(ui.text("#settings-section")).toContain("asd config set terminal-command")
})

test("extensions list their actions; a global action runs with no sandbox, a sandbox action asks which", async () => {
  const global = { ...extension, id: "acct", name: "Accounts", actions: [{ id: "sync", label: "Sync", scope: "global", run: ["./sync"], fields: [] }, extension.actions[0]] }
  const ui = await page({ ...base, extensions: () => ({ extensions: [global], errors: ["broken: extension.json is not valid JSON"] }), list: () => [sandbox()], action: () => ({ exitCode: 0, stdout: "synced", stderr: "" }) })
  ui.button("Extensions").click(); await ui.settle()
  expect(ui.text("#extensions")).toContain("broken: extension.json is not valid JSON")
  const forms = [...ui.window.document.querySelectorAll("#extensions form")] as any[]
  forms[0].dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(forms[1].elements.namedItem("asidee-sandbox").value).toBe("demo")
  forms[1].dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "action").map((call) => call.body)).toEqual([{ extension: "acct", action: "sync", values: {} }, { extension: "acct", action: "install", sandbox: "demo", values: { version: "latest", force: "false" } }])
  expect(ui.text("#extensions pre")).toBe("synced")
})

test("templates are listed, can seed a new sandbox, and can be removed", async () => {
  const template = { name: "base", engine: "fake:1", imageId: "sha256:x", source: "demo", sourceImage: "img", createdAt: "2026-11-18T00:00:00Z", sizeBytes: 2 * 1024 ** 3, loginsRemoved: [".claude"], dependants: [] }
  const ui = await page({ ...base, list: () => [], templateList: () => [template], templateRemove: () => ({ removed: "base", imageId: "x", dependants: [], note: "Removed." }) })
  ui.button("Templates").click(); await ui.settle()
  expect(ui.text("#templates")).toContain("base · 2.00 GB · from demo (img)")
  ui.button("New sandbox from it").click(); await ui.settle()
  expect((ui.window.document.getElementById("f-template") as any).value).toBe("base")
  ui.button("Templates").click(); await ui.settle()
  ;(ui.window.document.querySelector("#templates button.danger") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "templateRemove")!.body).toEqual({ name: "base", engine: "fake:1" })
})

test("machines are off until experimental is on; then remote sandboxes are routed by host", async () => {
  const off = await page({ ...base, list: () => [] })
  off.button("Machines").click(); await off.settle()
  expect(off.text("#machines")).toContain("experimental and off")
  expect(off.calls.some((call) => call.method === "fleet")).toBe(false)
  const remote = sandbox({ name: "soak" })
  const ui = await page({ ...base, list: () => [], configGet: () => ({ defaults: {}, requireProbes: true, experimental: true }), stop: () => ({}), usage: (body) => body.host ? [usageOf({ name: "soak" })] : [],
    fleet: () => ({ machines: [{ machine: { host: { name: "local", machineId: "a" }, state: "online" }, stale: false }, { machine: { host: { name: "home-linux", ssh: "home-linux" }, state: "online", hello: { version: "0.4.0", service: "systemd" } }, cached: { sandboxes: [remote] }, stale: false }] }) })
  ui.button("Machines").click(); await ui.settle()
  expect(ui.text("#machines")).toContain("home-linux online")
  ;(ui.window.document.querySelector("#machines button.small") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "stop")!.body).toEqual({ name: "soak", host: "home-linux" })
  ui.button("Usage").click(); await ui.settle()
  expect([...ui.window.document.querySelectorAll("#usage tbody td")].slice(0, 2).map((cell) => cell.textContent)).toEqual(["soak (home-linux)", "running"])
})

test("the page calls only methods open to the dashboard", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({}) })
  for (const tab of ["Usage", "Workspaces", "Templates", "Machines", "Extensions", "Settings", "Sandboxes"]) { ui.button(tab).click(); await ui.settle() }
  const used = [...new Set(ui.calls.map((call) => call.method))]
  expect(used.filter((method) => (CATALOG as Record<string, readonly string[]>)[method]?.[0] !== "dashboard")).toEqual([])
})

test("create sends Docker inside only when chosen, and shows the same create as a CLI command", async () => {
  const ui = await page({ ...base, list: () => [], create: (body) => ({ sandbox: { name: body.name } }) })
  const form = ui.window.document.getElementById("create") as any
  const submit = async (name: string, docker: string) => { form.elements.namedItem("name").value = name; form.elements.namedItem("dockerInside").value = docker; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
    const shown = ui.text("#create-command"); form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle(); return shown }
  expect(await submit("one", "true")).toContain("asd create one --docker")
  expect(await submit("two", "")).toContain("asd create two")
  const bodies = ui.calls.filter((call) => call.method === "create").map((call) => call.body)
  expect(bodies[0]).toMatchObject({ name: "one", docker: true }); expect(bodies[0]).not.toHaveProperty("dockerInside")
  expect(bodies[1]).not.toHaveProperty("docker")
})

test("create runs the chosen setup steps after the create, in the CLI's order, and stops at the first failure", async () => {
  const bundled = ["logins", "repo", "skills", "t3"].map((id) => ({ id, name: id, actions: [] }))
  const ui = await page({ ...base, list: () => [sandbox({ name: "fresh" })], extensions: () => ({ extensions: bundled, errors: [] }), create: (body) => ({ sandbox: { name: body.name } }),
    action: (body) => body.action === "profiles" ? { exitCode: 0, stdout: `noise <b>\n${JSON.stringify({ agent: body.values.agent, profiles: ["work", "home", "../x", "<b>"], token: "s3cret" })}\n`, stderr: "" }
      : body.action === "clone" ? { exitCode: 2, stdout: "<i>no access</i>", stderr: "" } : { exitCode: 0, stdout: `${body.action} ok`, stderr: "" } })
  const doc = ui.window.document as any
  expect([...doc.querySelectorAll('#create-setup input[data-agent="claude"]')].map((box: any) => box.dataset.profile)).toEqual(["work", "home"])
  expect(ui.text("#create-setup")).toContain("anything running there can read it")
  expect(ui.text("#create-setup")).not.toContain("s3cret")
  const form = doc.getElementById("create")
  form.elements.namedItem("name").value = "fresh"; doc.getElementById("setup-gh").checked = true; doc.getElementById("setup-claude-work").checked = true; doc.getElementById("setup-claude-home").checked = true; doc.getElementById("setup-t3").checked = true
  doc.getElementById("setup-repo").value = "acme/app.git"; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("asd create fresh --gh --claude work --claude home --repo acme/app.git --t3")
  // Skills and plugins come after the clone, which needs an empty ~/workspace.
  doc.getElementById("setup-skills").value = "~/hq"; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("--repo acme/app.git --skills ~/hq --t3")
  doc.getElementById("setup-skills").value = ""
  // The browser sets T3 up first, so its one flag stands for both.
  doc.getElementById("setup-t3-browser").checked = true; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("--repo acme/app.git --t3-browserCopy")
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.text("#create-error")).toBe("Repository takes a GitHub OWNER/REPO.")
  expect(ui.calls.some((call) => call.method === "create")).toBe(false)
  doc.getElementById("setup-repo").value = "acme/app"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  const create = ui.calls.find((call) => call.method === "create")!.body
  expect(Object.keys(create).some((key) => key.startsWith("setup"))).toBe(false)
  const steps = ui.calls.filter((call) => call.method === "action" && !["profiles", "list"].includes(call.body.action)).map((call) => call.body)
  expect(steps).toEqual([{ extension: "logins", action: "github", sandbox: "fresh", values: {} }, { extension: "logins", action: "import", sandbox: "fresh", values: { agent: "claude", profile: "work", setup: true } },
    { extension: "logins", action: "import", sandbox: "fresh", values: { agent: "claude", profile: "home", setup: true } }, { extension: "repo", action: "clone", sandbox: "fresh", values: { repository: "acme/app" } }])
  const shown = ui.text("#sandboxes pre")
  expect(shown).toContain("GitHub login: done"); expect(shown).toContain("Claude login work: done")
  expect(shown).toContain("Clone acme/app: failed with exit 2 <i>no access</i>")
  expect(shown).toContain("Clone acme/app failed; the steps after it did not run. fresh is kept.")
  expect(doc.querySelector("#sandboxes pre i")).toBe(null)
})

test("setup inputs appear only for installed extensions", async () => {
  const ui = await page({ ...base, list: () => [], extensions: () => ({ extensions: [{ id: "repo", name: "repo", actions: [] }], errors: [] }) })
  const doc = ui.window.document
  expect(doc.getElementById("setup-repo")).not.toBe(null)
  for (const id of ["gh", "claude", "codex", "t3"]) expect(doc.getElementById(`setup-${id}`)).toBe(null)
  expect(ui.text("#create-setup")).not.toContain("token")
  expect(ui.calls.some((call) => call.method === "action")).toBe(false)
})

test("the Prepare form starts from this machine's versions and sends one templatePrepare, the CLI's own method", async () => {
  const done = { template: { name: "uitest", engine: "fake:1", sizeBytes: 2 * 1024 ** 3 }, versions: { claude: "2.1.310", codex: "0.164.0" }, tools: ["2.1.310 (Claude Code)"], default: false, lines: ["Creating the sandbox x…"] }
  const ui = await page({ ...base, list: () => [], templateList: () => [], templatePreparing: () => [], templatePrepare: () => done,
    templatePrepareInfo: () => ({ versions: { claude: "2.1.310", codex: "0.164.0" }, script: { path: "/Users/me/.config/asidee/agent-template.sh", exists: true } }) })
  ui.button("Templates").click(); await ui.settle()
  const form = ui.window.document.getElementById("prepare") as any
  expect(form.elements.namedItem("claude").value).toBe("2.1.310")
  expect(ui.text("#p-script")).toContain("/Users/me/.config/asidee/agent-template.sh")
  form.elements.namedItem("name").value = "uitest"; form.elements.namedItem("script").value = "file"; form.elements.namedItem("replace").checked = true
  form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#prepare-command")).toContain("asd template prepare uitest --claude 2.1.310 --codex 0.164.0 --script /Users/me/.config/asidee/agent-template.sh --replace")
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "templatePrepare").map((call) => call.body)).toEqual([{ name: "uitest", claude: "2.1.310", codex: "0.164.0", engine: "fake:1", replace: true, default: false, scriptFile: true }])
  expect(ui.text("#prepare-progress")).toContain("Saved template uitest (2.00 GB) on fake:1")
  form.elements.namedItem("script").value = "paste"; form.elements.namedItem("scriptText").value = "echo hi"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "templatePrepare").at(-1)!.body).toMatchObject({ script: "echo hi" })
  expect(ui.calls.filter((call) => call.method === "templatePrepare").at(-1)!.body).not.toHaveProperty("scriptFile")
})

test("actions asked on the Mac say so before the click, show the wait, and offer the CLI command when refused", async () => {
  let answer!: (value: unknown) => void
  const refusal = Object.assign(new Error("No dialog can be shown on this Mac, so only the CLI can do this. From the CLI: asd config set terminal-command 'kitty sh -c {command}'"),
    { code: "forbidden", details: { approval: "unavailable", command: "asd config set terminal-command 'kitty sh -c {command}'" } })
  const workspace = { name: "render", status: "idle", processes: 0, folder: "/fixture/render", disclosure: "Not a sandbox.", spec: { hostTemp: false, diskGb: 20 } }
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [workspace] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({ platform: "darwin" }),
    terminalCommandSet: () => new Promise((resolve, reject) => { answer = (value) => value instanceof Error ? reject(value) : resolve(value) }),
    workspaceStop: () => ({}), workspaceRemove: (body) => ({ removed: body.name, notRemoved: [] }), workspaceExec: () => ({ exitCode: 0, stdout: "hi", stderr: "" }) })
  ui.button("Settings").click(); await ui.settle()
  expect(ui.text("#terminal-custom")).toContain("A dialog on this Mac asks you to allow it first; no answer in 60 seconds denies it.")
  const form = ui.window.document.querySelector("#terminal-custom form") as any
  form.elements.namedItem("command").value = "kitty sh -c {command}"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.text("#terminal-custom")).toContain("Waiting for Allow on the Mac…")
  expect(ui.calls.find((call) => call.method === "terminalCommandSet")!.body).toEqual({ terminalCommand: "kitty sh -c {command}" })
  answer(refusal); await ui.settle()
  expect(ui.text("#terminal-custom pre")).toContain("only the CLI can do this")
  expect([...ui.window.document.querySelectorAll("#terminal-custom code")].map((node) => node.textContent)).toContain("asd config set terminal-command 'kitty sh -c {command}'")
  expect(ui.button("Set (asks on the Mac)")).toBeDefined()
  // Workspaces: each changing action is labelled, and remove sends the typed name.
  ui.button("Workspaces").click(); await ui.settle()
  expect(ui.text("#workspaces")).toContain("A dialog on this Mac asks you")
  ui.button("Stop (asks on the Mac)").click(); await ui.settle()
  ui.button("Remove (asks on the Mac)").click(); await ui.settle()
  expect(ui.calls.filter((call) => call.method.startsWith("workspace")).map((call) => [call.method, call.body])).toEqual([["workspaceStop", { name: "render" }], ["workspaceRemove", { name: "render", confirm: "demo" }]])
  expect(ui.prompts.at(-1)).toContain("/fixture/render")
  expect(ui.text("#workspace-commands")).toContain("It is not a sandbox.")
  expect(ui.button("Create workspace (asks on the Mac)")).toBeDefined()
})

test("on a machine without the dialog, the buttons say the CLI command is offered instead", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({ platform: "linux" }) })
  ui.button("Settings").click(); await ui.settle()
  expect(ui.text("#about")).toContain("This machine has no dialog to allow it, so it is refused and its CLI command offered.")
  expect(ui.button("Stop the daemon (asks on the Mac)")).toBeDefined()
})

test("the T3 card sets T3 up, then gives the SSH host to paste, and shows each result in its pop-up", async () => {
  const t3 = { id: "t3", name: "T3 Code", actions: ["setup", "sync", "ssh"].map((id) => ({ id, label: id, scope: "sandbox", fields: [], run: ["./t3.ts", id] })) }
  const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [t3], errors: [] }), sshAccess: () => ({ alias: "demo.asidee", user: "root", home: "/root", batchReady: false, loopbackForwarding: true }),
    action: (body) => body.action === "setup" ? { exitCode: 0, stdout: JSON.stringify({ version: "1.2.3", runtime: "installed", claude: 2, codex: 1, ssh: {} }), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" } })
  expect(ui.text("#sandboxes")).toContain("Connect T3 CodeSet up SSH first")
  await ui.tile("Connect T3 Code")
  expect(ui.text("#modal")).toContain("Set up SSH (asks on the Mac)")
  expect(ui.window.document.querySelector("#modal .cmd code")!.textContent).toBe("demo.asidee")
  ui.button("Set up T3 Code").click(); await ui.settle()
  expect(ui.text("#modal pre")).toBe("T3 1.2.3 installed. Logins it found: Claude 2, Codex 1.")
  expect(ui.text("#sandboxes pre")).toBe("")
})

test("the Logins pop-up lists the sandbox's logins as cards, re-imports or adds one, and tells T3", async () => {
  const logins = { id: "logins", name: "Agent logins", actions: ["import", "github", "list", "logout"].map((id) => ({ id, label: id, scope: "sandbox", fields: [], run: ["./login.ts", id] })) }
  const t3 = { id: "t3", name: "T3 Code", actions: [{ id: "sync", label: "sync", scope: "sandbox", fields: [], run: ["./t3.ts", "sync"] }] }
  let inside = "claude/~ (a@example.com)\nclaude/work (w@example.com)\ngithub/~ (me)\n"
  const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [logins, t3], errors: [] }), sshAccess: () => ({ alias: "demo.asidee", batchReady: true }), openTerminal: () => ({ terminal: "default", command: "x" }),
    action: (body) => body.action === "profiles" ? { exitCode: 0, stdout: JSON.stringify({ agent: body.values.agent, profiles: body.values.agent === "claude" ? ["work", "home"] : [] }), stderr: "" }
      : body.action === "list" ? { exitCode: 0, stdout: inside, stderr: "" }
      : body.action === "import" ? (inside += body.values.replace === "true" ? "" : `claude/${body.values.profile} (h@example.com)\n`, { exitCode: 0, stdout: "Imported.\nCopied 0 setup files.", stderr: "" })
      : { exitCode: 0, stdout: '{"claude":3,"codex":0}', stderr: "" } })
  expect(ui.text("#sandboxes")).toContain("LoginsClaude: main login, work · GitHub")
  await ui.tile("Logins")
  const card = (title: string, section = 0) => [...ui.window.document.querySelectorAll("#modal .cards")[section]!.querySelectorAll(".card")].find((node) => node.querySelector(".t")!.textContent === title) as any
  expect(card("Claude · work").textContent).toContain("w@example.com")
  // This Mac's work login is in the sandbox already, so only home is offered to add.
  expect([...ui.window.document.querySelectorAll("#modal .cards")[1]!.querySelectorAll(".t")].map((node) => node.textContent)).toEqual(["Claude · home"])
  ;[...card("Claude · work").querySelectorAll("button")].find((node: any) => node.textContent === "Re-import")!.click(); await ui.settle()
  expect(ui.text("#modal pre")).toBe("Re-imported Claude · work. T3 Code sees it now.")
  ;[...card("Claude · home", 1).querySelectorAll("button")].find((node: any) => node.textContent === "Add")!.click(); await ui.settle()
  const sent = ui.calls.filter((call) => call.method === "action" && ["import", "sync"].includes(call.body.action)).map((call) => [call.body.action, call.body.values])
  expect(sent).toEqual([["import", { agent: "claude", profile: "work", target: "", setup: "false", replace: "true" }], ["sync", {}], ["import", { agent: "claude", profile: "home", target: "", setup: "false", replace: "false" }], ["sync", {}]])
  expect(card("Claude · home").textContent).toContain("h@example.com")
  // With named logins, asd claude cannot pick the canonical one, so Open agent offers only the named ones.
  ui.button("Close").click(); await ui.settle()
  ui.button("Open agent…").click(); await ui.settle()
  expect([...ui.window.document.querySelectorAll("#modal .card .t")].map((node) => node.textContent)).toEqual(["Claude · work", "Claude · home"])
  ;(ui.window.document.querySelector("#modal .card") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "openTerminal")!.body).toEqual({ name: "demo", kind: "claude", profile: "work" })
})

test("the default template is offered once, as itself, and creating with it sends no template", async () => {
  const template = (name: string) => ({ name, engine: "fake:1", sizeBytes: 1, source: "x", sourceImage: "y", createdAt: "2026-11-18T00:00:00Z", dependants: [], loginsRemoved: [] })
  const ui = await page({ ...base, list: () => [], configGet: () => ({ defaults: { template: "agent" }, requireProbes: true }), templateList: () => [template("agent"), template("other")], create: (body) => ({ sandbox: { name: body.name } }) })
  const pills = [...ui.window.document.querySelectorAll("#template-pills label")].map((node) => node.textContent)
  expect(pills).toEqual(["agent (default)", "other"])
  const form = ui.window.document.getElementById("create") as any
  form.elements.namedItem("name").value = "fresh"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.find((call) => call.method === "create")!.body).not.toHaveProperty("template")
})
