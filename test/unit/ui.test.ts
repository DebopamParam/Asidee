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

// setupDone: whether this browser finished the first-run steps before, which keeps them from opening by themselves.
async function page(replies: Record<string, (body: any) => unknown>, url = "http://127.0.0.1:7717/#token=secret", { setupDone = true } = {}) {
  const html = await readFile(join(import.meta.dir, "..", "..", "ui", "index.html"), "utf8")
  const script = html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>"))
  const window = new Window({ url })
  if (setupDone) window.localStorage.setItem("asidee-setup-done", "1")
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
    setInterval: () => 0, prompt: (text: string) => { prompts.push(text); return "demo" }, confirm: (text: string) => { prompts.push(text); return true }, FormData: window.FormData, URLSearchParams, Event: window.Event }
  new Function(...Object.keys(globals), script)(...Object.values(globals))
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
  await settle()
  const doc = window.document as any
  const text = (selector: string) => (doc.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ")
  // While a form is open on the right, only its buttons can be clicked.
  const button = (label: string) => [...(doc.querySelector("#modal:not([hidden])") ?? doc).querySelectorAll("button")].find((node) => node.textContent === label)!
  const click = async (label: string) => { button(label).click(); await settle() }
  // Opens a sandbox's page from the list.
  const open = async (name: string) => { (doc.querySelector(`#sandboxes button.lrow[data-name="${name}"]`) as any).click(); await settle() }
  // Closes any open form, then picks an item from a menu on the page.
  const pick = async (label: string) => { if (!doc.getElementById("modal")!.hidden) await click("Close"); await click(label) }
  const submit = async (form: any, values: Record<string, string> = {}) => {
    for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value
    form.dispatchEvent(new window.Event("submit", { cancelable: true })); await settle()
  }
  return { window, doc, calls, prompts, settle, text, button, click, open, pick, submit }
}

const ready = { id: "fake:1", label: "Fake engine", ready: true, problems: [], capabilities: { kernelIsolation: "gvisor", networkGuard: true, diskLimit: "watched" } }
const base = { configGet: () => ({ defaults: {}, requireProbes: true }), checklist: () => CHECKLIST, engines: () => [ready], extensions: () => ({ extensions: [extension], errors: [] }) }
const usageOf = (over: object = {}) => ({ name: "demo", running: true, cpus: 2, memoryLimitBytes: 4 * 1024 ** 3, pidsLimit: 4096, diskLimitBytes: 20 * 1024 ** 3, cpuPercent: 37.5, memoryBytes: 512 * 1024 ** 2, tasks: 40, diskBytes: 3 * 1024 ** 3, diskMeasuredAt: "2026-11-18T10:00:00Z", ...over })
const later = (minutes: number) => new Date(Date.now() + minutes * 60000).toISOString()

test("workspaces appear separately with their disclosure, and unavailable inventory is unknown", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [{ name: "render", status: "idle", processes: 0, folder: "/fixture/render", disclosure: "Workspace, not a sandbox. Loopback open; no limits." }] }) })
  expect(ui.text("#workspaces")).toContain("renderWorkspace")
  expect(ui.text("#workspaces")).toContain("Note Workspace, not a sandbox. Loopback open; no limits.")
  expect(ui.text("#workspace-section .lead")).toContain("It is not a sandbox")
  expect(ui.text("#sandboxes")).not.toContain("render")
  expect(ui.doc.getElementById("workspaces-tab")!.getAttribute("data-count")).toBe("1")
  const unavailable = await page({ ...base, list: () => [], summary: () => { throw new Error("Inventory unavailable") } })
  expect(unavailable.text("#workspaces")).toContain("Workspaces unknown: Inventory unavailable")
  expect(unavailable.text("#workspaces")).not.toContain("No workspaces")
})

test("the dashboard lists sandboxes, sends the token, and hides it from the address bar", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("demo")
  // With every row a sandbox, the Type column says nothing and is left out.
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).not.toContain("Sandbox")
  expect(ui.doc.querySelector("#sandboxes .kind-col")).toBe(null)
  expect(ui.doc.getElementById("sandboxes-tab")!.textContent).toBe("Sandboxes")
  expect(ui.doc.getElementById("sandboxes-tab")!.getAttribute("data-count")).toBe("1")
  await ui.open("demo")
  expect(ui.text("#sandbox-page h1")).toBe("demo")
  expect(ui.text("#sandbox-page .sub")).toBe("2 CPUs · 4 GB memory · 20 GB disk · Fake engine")
  expect(ui.calls.every((call) => call.authorization === "Bearer secret")).toBe(true)
  expect(ui.window.location.hash).toBe("")
  ui.doc.getElementById("settings-tab")!.click(); await ui.settle()
  expect(ui.text("#engines")).toContain("Walled off from your Mac")
  expect(ui.doc.querySelector("#engines [data-tip]")!.getAttribute("data-tip")).toContain("gVisor")
})

test("the sidebar has five places and Settings, with no Usage tab; Machines shows only with Experimental on", async () => {
  const ui = await page({ ...base, list: () => [] })
  expect([...ui.doc.querySelectorAll("nav.side button")].map((node) => node.textContent)).toEqual(["Sandboxes", "Workspaces", "Templates", "Extensions", "Machines", "Settings"])
  expect(ui.doc.getElementById("machines-tab")!.hidden).toBe(true)
  expect(ui.doc.getElementById("usage")).toBe(null)
  const on = await page({ ...base, list: () => [], configGet: () => ({ defaults: {}, requireProbes: true, experimental: true }) })
  expect(on.doc.getElementById("machines-tab")!.hidden).toBe(false)
})

test("past checks show what they measured and when, as a past result, never green", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  const at = new Date("2026-11-10T10:00:00Z").toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Running · 1 check failed")
  expect(ui.doc.querySelector("#sandboxes .lrow[data-name=demo] .si.fail")).not.toBe(null)
  await ui.open("demo")
  const card = ui.text("#checks-demo")
  expect(card).toContain("1 required check failed")
  expect(card).toContain(`Last checked ${at}. A past result: it may have changed since.`)
  // What needs a look shows first: the failed required check and the partly disk limit.
  expect(card).toContain("Can't reach your Mac")
  expect(card).toContain("Failed")
  expect(card).toContain("Disk limitPartly · checked every 5 s · not a hard cap")
  expect(card).not.toContain("Walled off from your Mac")
  await ui.click("Show all 3 · 2 required, 1 good to know")
  expect(ui.text("#checks-demo")).toContain("Required · 2")
  expect(ui.text("#checks-demo")).toContain("Walled off from your Mac")
  // A pass from the past is an outline, never the green filled mark.
  expect(ui.doc.querySelectorAll("#checks-demo .mk.ok.past").length).toBe(1)
  expect(ui.doc.querySelectorAll("#checks-demo .mk.ok:not(.past)").length).toBe(0)
  // The plain words carry the exact title on hover or focus.
  // A row's help has no underline: only short terms are marked.
  expect(ui.doc.querySelectorAll("#checks-demo .row-l:not(.more) .hv").length).toBe(1)
  expect(ui.text("#checks-demo .row-l .hv")).toBe("not a hard cap")
  const plain = [...ui.doc.querySelectorAll("#checks-demo .tp")].find((node) => node.textContent === "Can't reach your Mac")!
  expect(plain.getAttribute("data-tip")).toBe("Cannot reach the host (net-host)")
  plain.dispatchEvent(new ui.window.FocusEvent("focusin", { bubbles: true }))
  expect(ui.text("#ftip")).toBe("Cannot reach the host (net-host)")
  const failed = [...ui.doc.querySelectorAll("#checks-demo .tp")].find((node) => node.textContent === "Failed")!
  expect(failed.getAttribute("data-tip")).toContain("A connection reached the host.")
})

test("Walled off from your Mac is said only of a sandbox on a gVisor engine", async () => {
  const runc = { ...ready, capabilities: { ...ready.capabilities, kernelIsolation: "runc" } }
  const ui = await page({ ...base, engines: () => [runc], list: () => [sandbox()] })
  await ui.open("demo")
  await ui.click("Show all 3 · 2 required, 1 good to know")
  expect(ui.text("#checks-demo")).not.toContain("Walled off")
  expect(ui.text("#checks-demo")).toContain(CHECKLIST.find((entry) => entry.id === "kernel")!.title)
  const empty = await page({ ...base, engines: () => [runc], list: () => [] })
  expect(empty.text("#sandboxes")).toContain("A sandbox is a small Linux computer. Your agent works there")
  expect(empty.text("#sandboxes")).not.toContain("walled off")
  const walled = await page({ ...base, list: () => [] })
  expect(walled.text("#sandboxes")).toContain("walled off from your Mac")
})

test("a sandbox made from a template names it, from the object the daemon sends", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ template: { name: "agent", imageId: "sha256:abc", source: "base", createdAt: "2026-11-01T00:00:00Z" } })] })
  await ui.open("demo")
  expect(ui.text("#sandbox-page .sub")).toContain("from agent · 2 CPUs")
  expect(ui.text("#sandbox-page")).not.toContain("[object Object]")
})

test("a required check that only reports is not counted as passed, and its row says what it found", async () => {
  const results = [check("kernel", "pass", "gVisor answers."), check("net-host", "pass", "Refused."), check("link-scope", "info", "No links: nothing to measure. Other sandboxes are covered by \"Cannot reach other sandboxes\".")] as CheckResult[]
  const ui = await page({ ...base, list: () => [sandbox({ lastVerify: historical({ at: "2026-11-10T10:00:00Z", results }) })] })
  await ui.open("demo")
  const card = ui.text("#checks-demo")
  expect(card).toContain("2 required checks passed · 1 has nothing to pass")
  expect(card).not.toContain("All 3 required checks passed")
  expect(card).toContain("No links")
  expect(card).not.toContain("Note")
})

test("verify, stop and remove call the API; remove sends the typed name as the confirmation", async () => {
  let gone = false
  const ui = await page({ ...base, list: () => gone ? [] : [sandbox()], verify: () => ({}), stop: () => ({}), remove: () => { gone = true; return {} } })
  await ui.open("demo")
  await ui.click("Check now")
  await ui.click("Stop")
  await ui.click("Remove…")
  expect(ui.prompts[0]).toContain("deletes demo")
  const sent = ui.calls.filter((call) => ["verify", "stop", "remove"].includes(call.method)).map((call) => [call.method, call.body])
  expect(sent).toEqual([["verify", { name: "demo" }], ["stop", { name: "demo" }], ["remove", { name: "demo", confirm: "demo" }]])
  // The page of a removed sandbox goes back to the list.
  expect(ui.doc.getElementById("sandbox-page")!.hidden).toBe(true)
  expect(ui.text("#sandboxes")).toContain("No sandboxes yet")
})

test("an extension's action is drawn as a form from its declaration and sends its fields", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], action: () => ({ exitCode: 0, stdout: "installed 1.2\n", stderr: "" }) })
  await ui.open("demo")
  expect(ui.text("#sandbox-page .part[data-extension=tools]")).toContain("ToolsInstall thing")
  ;(ui.doc.querySelector("#sandbox-page .part[data-extension=tools] button") as any).click(); await ui.settle()
  const form = ui.button("Install thing").closest("form") as any
  expect(form.elements.namedItem("version").value).toBe("latest")
  expect(ui.text("#modal .cmd code")).toBe("asd ext run tools install demo --set version=latest")
  await ui.submit(form, { version: "1.2" })
  expect(ui.calls.find((call) => call.method === "action")!.body).toEqual({ extension: "tools", action: "install", sandbox: "demo", values: { version: "1.2", force: "false" } })
  expect(ui.text("#modal pre")).toBe("installed 1.2")
})

test("a stopped sandbox shows why it stopped, offers Start, and has no extension actions", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ status: "stopped", stopReason: "Stopped by the disk watch: it used 2.1 GB of its 2 GB." }), sandbox({ name: "idle", status: "stopped" })] })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Stopped by Asidee")
  expect(ui.doc.querySelector("#sandboxes .lrow[data-name=demo] [data-tip]")!.getAttribute("data-tip")).toContain("Stopped by the disk watch")
  expect(ui.text("#sandboxes .lrow[data-name=idle]")).toContain("Stopped")
  expect(ui.doc.querySelector("#sandboxes .lrow[data-name=idle] .si.off")).not.toBe(null)
  await ui.open("demo")
  expect(ui.text("#sandbox-page")).toContain("Stopped by the disk watch")
  expect(ui.button("Start")).toBeDefined()
  expect(ui.doc.querySelector("#sandbox-page .part")).toBe(null)
  expect(ui.text("#sandbox-page")).toContain("Start it to open agents, ports and its extensions.")
})

test("an enforcement failure is visible without opening the checks", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ enforcementProblem: { at: "2026-11-12T00:00:00Z", message: "guard unreadable" } })] })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Running · a limit is not being checked")
  expect(ui.doc.querySelector("#sandboxes .lrow[data-name=demo] .si.part")).not.toBe(null)
  await ui.open("demo")
  expect(ui.text("#sandbox-page .banner.bad")).toContain("A limit was not checked at 2026-11-12T00:00:00Z: guard unreadable")
})

test("creating sends the form and opens the new sandbox; an error from the core is shown as it is", async () => {
  let made = false
  const ui = await page({ ...base, list: () => made ? [sandbox({ name: "fresh", lastVerify: undefined })] : [], create: (body) => {
    if (body.name === "bad") throw new Error("bad was not started: No host folders are mounted")
    made = true; return { sandbox: { name: "fresh" } }
  } })
  expect(ui.text("#sandboxes")).toContain("No sandboxes yet")
  expect(ui.text("#sandboxes .cmd code")).toBe("asd create my-app")
  await ui.click("New sandbox")
  expect(ui.doc.getElementById("create-drawer")!.hidden).toBe(false)
  const form = ui.doc.getElementById("create") as any
  await ui.submit(form, { name: "bad" })
  expect(ui.text("#create-error")).toBe("bad was not started: No host folders are mounted")
  await ui.submit(form, { name: "fresh" })
  const body = ui.calls.find((call) => call.method === "create" && call.body.name === "fresh")!.body
  expect(body).toMatchObject({ name: "fresh", engine: "fake:1", image: "" })
  expect(body).not.toHaveProperty("template-pick")
  expect(ui.doc.getElementById("create-drawer")!.hidden).toBe(true)
  expect(ui.text("#sandbox-page h1")).toBe("fresh")
  expect(ui.text("#sandbox-page")).toContain("Running · not checked")
})

test("without a token the page says how to open it", async () => {
  const ui = await page({ ...base, list: () => { throw new Error("Open the dashboard with the link from `asd ui`.") } }, "http://127.0.0.1:7717/")
  expect(ui.text("#notice")).toContain("asd ui")
  expect(ui.text("#island")).toBe("Not connected")
})

test("each place has a path: a deep link opens it, a move pushes it, Back returns, and the token stays out of it", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] }, "http://127.0.0.1:7717/sandboxes/demo#token=secret")
  expect(ui.window.location.pathname).toBe("/sandboxes/demo")
  expect(ui.window.location.href).not.toContain("secret")
  expect(ui.window.sessionStorage.getItem("asidee-token")).toBe("secret")
  expect(ui.doc.getElementById("sandbox-page")!.hidden).toBe(false)
  expect(ui.text("#sandbox-page h1")).toBe("demo")
  expect(ui.doc.title).toBe("demo · Asidee")
  expect(ui.calls.every((call) => call.authorization === "Bearer secret")).toBe(true)
  const depth = ui.window.history.length
  await ui.click("Sandboxes /")
  expect(ui.window.location.pathname).toBe("/sandboxes")
  expect(ui.doc.title).toBe("Sandboxes · Asidee")
  await ui.click("Extensions")
  ;(ui.doc.querySelector("#extensions button.lrow[data-extension=tools]") as any).click(); await ui.settle()
  expect(ui.window.location.pathname).toBe("/extensions/tools")
  expect(ui.doc.title).toBe("Tools · Asidee")
  expect(ui.window.history.length).toBe(depth + 3)
  // Back and Forward go through the same places.
  const back = async (path: string) => { ui.window.history.replaceState(null, "", path); ui.window.dispatchEvent(new ui.window.PopStateEvent("popstate")); await ui.settle() }
  await back("/extensions")
  expect(ui.doc.getElementById("extension-list")!.hidden).toBe(false)
  await back("/sandboxes/demo")
  expect(ui.doc.getElementById("extension-section")!.hidden).toBe(true)
  expect(ui.text("#sandbox-page h1")).toBe("demo")
  expect(ui.window.history.length).toBe(depth + 3)
})

test("a path to a sandbox or extension that is gone says so, / and Machines while off are replaced, and a tab with no token says how to sign in", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] }, "http://127.0.0.1:7717/sandboxes/old-app#token=secret")
  expect(ui.text("#sandbox-page")).toContain("old-app is not here any more")
  await ui.click("All sandboxes")
  expect(ui.window.location.pathname).toBe("/sandboxes")
  expect(ui.text("#sandboxes")).toContain("demo")
  const ext = await page({ ...base, list: () => [sandbox()] }, "http://127.0.0.1:7717/extensions/gone#token=secret")
  expect(ext.text("#extension-page")).toContain("gone is not here any more")
  const root = await page({ ...base, list: () => [sandbox()] }, "http://127.0.0.1:7717/#token=secret")
  expect(root.window.location.pathname).toBe("/sandboxes")
  expect(root.window.history.length).toBe(1)
  const off = await page({ ...base, list: () => [sandbox()] }, "http://127.0.0.1:7717/machines#token=secret")
  expect(off.window.location.pathname).toBe("/sandboxes")
  expect(off.doc.getElementById("sandbox-section")!.hidden).toBe(false)
  const steps = await page({ ...base, list: () => [] }, "http://127.0.0.1:7717/setup/tools#token=secret", { setupDone: false })
  expect(steps.window.location.pathname).toBe("/setup/tools")
  expect(steps.doc.querySelector(".rail [aria-current=step]")!.textContent).toContain("Coding tools")
  const signedOut = await page({ ...base, list: () => { throw new Error("Open the dashboard with the link from `asd ui`.") } }, "http://127.0.0.1:7717/sandboxes/demo")
  expect(signedOut.text("#notice")).toBe("This tab is not signed in. Run asd ui in a terminal and open the link it prints.")
  expect(signedOut.text("#sandbox-page")).not.toContain("not here")
  expect(signedOut.window.location.pathname).toBe("/sandboxes/demo")
})

test("a refresh that changes nothing leaves a half-filled form alone", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  await ui.open("demo")
  ;(ui.doc.querySelector("#sandbox-page .part[data-extension=tools] button") as any).click(); await ui.settle()
  const input = (ui.button("Install thing").closest("form") as any).elements.namedItem("version")
  input.value = "typing"
  // The page's own refresh, as its timer would call it.
  await (ui.window as any).asideeRefresh(); await ui.settle()
  expect(ui.doc.contains(input)).toBe(true)
})

test("an unknown-probe create refusal opens Settings and focuses the toggle without changing the requirement", async () => {
  const ui = await page({ ...base, list: () => [], create: () => { throw Object.assign(new Error("Cannot reach the host: helper unavailable. Use asd config set require-probes off."), { code: "probes-required" }) } })
  await ui.submit(ui.doc.getElementById("create"), { name: "demo" })
  expect(ui.text("#create-error")).toContain("helper unavailable")
  const toggle = ui.doc.getElementById("require-probes") as any
  expect(toggle.checked).toBe(true)
  await ui.click("Open settings")
  expect(ui.doc.getElementById("settings-section")!.hasAttribute("hidden")).toBe(false)
  expect(ui.doc.getElementById("sandbox-section")!.hasAttribute("hidden")).toBe(true)
  expect(ui.doc.getElementById("create-drawer")!.hidden).toBe(true)
  expect(ui.doc.activeElement).toBe(toggle)
  expect(toggle.checked).toBe(true)
  expect(ui.calls.some((call) => call.method === "configSet")).toBe(false)
  ui.button("Sandboxes").click()
  expect(ui.doc.getElementById("sandbox-section")!.hasAttribute("hidden")).toBe(false)
})

test("Settings reads the daemon value, changes only on input, and restores the value on a refused write", async () => {
  let requireProbes = false
  const ui = await page({ ...base, list: () => [], configGet: () => ({ requireProbes }), configSet: (body) => {
    if (body.requireProbes === false) throw new Error("Settings could not be saved.")
    requireProbes = body.requireProbes; return { requireProbes }
  } })
  await ui.click("Settings")
  expect(ui.text("#settings-section")).toContain("sandboxes can be created without it having run; they show as not checked")
  expect(ui.doc.querySelector("#settings-section [data-tip^=require-probes]")!.textContent).toBe("Require the network test")
  const toggle = ui.doc.getElementById("require-probes") as any
  expect(toggle.checked).toBe(false); expect(toggle.disabled).toBe(false)
  toggle.checked = true; toggle.dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "configSet").map((call) => call.body)).toEqual([{ requireProbes: true }])
  expect(toggle.checked).toBe(true)
  toggle.checked = false; toggle.dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.text("#settings-error")).toBe("Settings could not be saved.")
  expect(toggle.checked).toBe(true); expect(toggle.disabled).toBe(false)
})

test("an unavailable setting cannot be changed and a sandbox with unknown probes is visibly not checked", async () => {
  const ui = await page({ ...base, configGet: () => { throw new Error("config unreadable") }, list: () => [sandbox({ lastVerify: historical({ at: "2026-11-15T00:00:00Z", results: [{ id: "net-host", status: "unknown", evidence: "none", detail: "The control did not answer." }] }) })] })
  expect((ui.doc.getElementById("require-probes") as any).disabled).toBe(true)
  expect(ui.text("#settings-error")).toContain("config unreadable")
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Running · not checked")
  expect(ui.doc.querySelector("#sandboxes .si.unk")).not.toBe(null)
  expect(ui.doc.querySelector("#sandboxes .si.ok, #sandboxes .si.past")).toBe(null)
  await ui.open("demo")
  expect(ui.text("#checks-demo")).toContain("1 required check not checked")
  expect(ui.text("#checks-demo")).toContain("Can't reach your MacNot checked")
  expect(ui.doc.querySelector("#checks-demo .mk.unk")).not.toBe(null)
  expect([...ui.doc.querySelectorAll("#checks-demo [data-tip]")].some((node) => node.getAttribute("data-tip")!.includes("The control did not answer."))).toBe(true)
})

test("a workspace shows why the daemon stopped it and a disk check it could not make; every control that acts on the Mac says it asks there", async () => {
  const stopReason = "Stopped by the daemon at 2026-11-16T10:00:00Z: render uses 2.00 GB of its 1 GB disk limit. Free space in /w/render, or raise the limit: asd workspace set render disk N"
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [{ name: "render", status: "idle", processes: 0, folder: "/w/render", spec: { hostTemp: false, diskGb: 1 }, disclosure: workspaceDisclosure(false), stopReason,
    enforcementProblem: { at: "2026-11-16T10:00:30Z", message: "Its size could not be measured." } }] }) })
  const row = ui.doc.getElementById("workspace-render")!
  expect(row.textContent).toContain(stopReason)
  expect(row.textContent).toContain("Disk limit not checked at 2026-11-16T10:00:30Z: Its size could not be measured.")
  // Each button that acts on the Mac carries the mark; the card says once what it means.
  // The menu items that open a form are plain; the form's own button carries the mark.
  const plain = ["Terminal", "Check now", "Change the disk limit…", "Run a command…", "Commands for a terminal"]
  expect([...row.querySelectorAll("button")].filter((node) => !plain.includes(node.textContent!) && !node.classList.contains("mac")).map((node) => node.textContent)).toEqual([])
  expect(row.textContent!.split("Buttons marked ⌘ ask on your Mac").length - 1).toBe(1)
  expect(row.querySelector("button.mac")!.getAttribute("data-tip")).toContain("No answer within 60 s means no.")
  // The disk limit and a command open as forms on the right, each with the mark and its note.
  for (const [item, label] of [["Change the disk limit…", "Set disk limit"], ["Run a command…", "Run"]] as const) {
    await ui.pick(item)
    expect(ui.button(label).classList.contains("mac")).toBe(true)
    expect(ui.text("#modal")).toContain("Buttons marked ⌘ ask on your Mac")
  }
  await ui.pick("Commands for a terminal")
  expect(ui.text("#modal")).toContain("asd workspace stop render")
})

test("each workspace shows its shared temp folder and the shared-temp disclosure", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [false, true].map((hostTemp) => ({ name: hostTemp ? "shared" : "closed", status: "idle", spec: { hostTemp }, disclosure: workspaceDisclosure(hostTemp) })) }) })
  const rows = [...ui.doc.querySelectorAll("#workspaces .col > .lp")].map((row) => row.textContent)
  expect(rows[0]).toContain("Shared temp folder off"); expect(rows[0]).not.toContain(HOST_TEMP_DISCLOSURE)
  expect(rows[1]).toContain("Shared temp folder on (weaker)"); expect(rows[1]).toContain(HOST_TEMP_DISCLOSURE)
  expect(ui.doc.querySelector("#workspaces [data-tip^=host-temp]")).not.toBe(null)
})

test("use is shown in the list and on the page, written in place, so a form being typed in survives it", async () => {
  let cpuPercent = 37.5
  const ui = await page({ ...base, list: () => [sandbox()], usage: () => [usageOf({ cpuPercent })] })
  expect(ui.text("#sandboxes [data-disk=demo]")).toBe("3.0 GB of 20.0 GB")
  await ui.open("demo")
  const use = () => ui.text("[data-usage=demo]")
  expect(use()).toContain("CPU19% of 2 CPUs"); expect(use()).toContain("Memory512 MB of 4.0 GB"); expect(use()).toContain("Processes40 of 4096"); expect(use()).toContain("Disk3.0 GB of 20.0 GB")
  await ui.click("Resize")
  const input = (ui.button("Resize").closest("form") as any).elements.namedItem("cpus")
  input.value = "3"
  cpuPercent = 180
  await (ui.window as any).asideeRefresh(); await ui.settle()
  expect(use()).toContain("CPU90% of 2 CPUs")
  expect(ui.doc.contains(input)).toBe(true)
})

test("Terminal asks the daemon to open a window for that sandbox or workspace and shows what it ran", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [{ name: "notes", status: "idle", spec: { hostTemp: false }, disclosure: "Workspace, not a sandbox." }] }),
    openTerminal: (body) => ({ opened: body.name, terminal: "ghostty", command: `'/x/asd' 'shell' '${body.name}'` }) })
  await ui.open("demo")
  await ui.click("Terminal")
  expect(ui.text("#sandbox-page pre")).toContain("Opened in ghostty. If no window appeared, run: '/x/asd' 'shell' 'demo'")
  ;([...ui.doc.querySelectorAll("#workspaces button")].find((node) => node.textContent === "Terminal") as any).click(); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "openTerminal").map((call) => call.body)).toEqual([{ name: "demo", kind: "sandbox" }, { name: "notes", kind: "workspace" }])
})

test("links to addresses outside Asidee are listed with their address, removed, and added from the Ports form", async () => {
  const link = { from: "demo", to: "vm", toAddress: "192.168.64.5", port: 22, address: "127.77.0.2", state: "open", connections: 0, trust: "demo can open connections to 192.168.64.5:22 as this machine" }
  // A sandbox named like the address link is not taken for its other end.
  const ui = await page({ ...base, list: () => [sandbox(), sandbox({ name: "vm", status: "stopped" })], forwardList: () => [], linkList: () => [link], linkRemove: () => ({ removed: { from: "demo", to: "vm", port: 22 }, measured: "ok" }),
    linkAdd: (body) => ({ ...link, ...body, toAddress: body.address, trust: "trusted" }) })
  await ui.open("demo")
  expect(ui.text("#sandbox-page")).toContain("1 connection with other sandboxes or addresses")
  await ui.pick("Ports")
  expect(ui.text("#modal")).toContain("demo → vm:22 (192.168.64.5:22, outside Asidee) · open")
  expect(ui.text("#modal")).toContain("demo can open connections to 192.168.64.5:22 as this machine")
  await ui.submit(ui.button("Connect address").closest("form"), { to: "mac", address: "192.168.64.6", port: "22" })
  expect(ui.text("#modal")).toContain("Connected: programs in demo reach mac:22, relayed to 192.168.64.6:22. trusted")
  await ui.pick("Ports")
  await ui.click("Remove")
  expect(ui.calls.filter((call) => ["linkAdd", "linkRemove"].includes(call.method)).map((call) => [call.method, call.body])).toEqual([
    ["linkAdd", { from: "demo", to: "mac", address: "192.168.64.6", port: "22" }], ["linkRemove", { from: "demo", to: "vm", port: 22 }]])
  await ui.open("vm")
  expect(ui.text("#sandbox-page")).not.toContain("connection with other sandboxes")
})

test("a sandbox's tools resize, run a command, open a port, connect, and save a template", async () => {
  const ui = await page({ ...base, list: () => [sandbox(), sandbox({ name: "other", status: "stopped" })], forwardList: () => [{ id: "f0", name: "demo", localPort: 3000, port: 3000, connections: 3 }], linkList: () => [],
    resize: () => ({ changes: [{ limit: "cpus", from: 2, to: 3, applies: "now" }], checks: [] }), exec: () => ({ exitCode: 0, stdout: "hi\n", stderr: "" }),
    forwardAdd: (body) => ({ id: "f1", name: "demo", localPort: 8080, port: Number(body.port), connections: 0 }), linkAdd: (body) => ({ ...body, address: "other:5432", trust: "trusted" }),
    snapshot: (body) => ({ template: { name: body.as }, contents: "files" }) })
  await ui.open("demo")
  // An open port is listed without a count of its sessions.
  expect(ui.text("#sandbox-page")).toContain("1 port open on this Mac · :3000")
  expect(ui.text("#sandbox-page")).not.toMatch(/\d+ connections?\b(?! with)/)
  const use = async (item: string, label: string, values: Record<string, string>) => { await ui.pick(item); await ui.submit(ui.button(label).closest("form"), values) }
  await use("Resize", "Resize", { cpus: "3" }); expect(ui.text("#modal pre")).toContain("cpus: 2 → 3, now")
  await use("Run a command", "Run", { command: "echo hi" }); expect(ui.text("#modal pre")).toBe("hi")
  await use("Ports", "Open port", { port: "8080" })
  expect(ui.text("#modal")).not.toContain("connection ·")
  // The sandbox to connect to is picked from the others, never typed.
  await ui.pick("Ports")
  expect([...ui.doc.querySelectorAll("#modal select[name=to] option")].map((node: any) => [node.value, node.textContent])).toEqual([["other", "other (stopped)"]])
  await ui.submit(ui.button("Connect").closest("form"), { port: "5432" })
  await use("Save as template", "Save", { as: "base" }); expect(ui.text("#modal pre")).toContain("Saved template base.")
  const sent = ui.calls.filter((call) => ["resize", "exec", "forwardAdd", "linkAdd", "snapshot"].includes(call.method)).map((call) => [call.method, call.body])
  expect(sent).toEqual([["resize", { name: "demo", cpus: "3" }], ["exec", { name: "demo", argv: ["sh", "-c", "echo hi"] }], ["forwardAdd", { name: "demo", port: "8080" }],
    ["linkAdd", { from: "demo", to: "other", port: "5432" }], ["snapshot", { name: "demo", as: "base" }]])
  await ui.pick("SSH and editors")
  expect(ui.text("#modal")).toContain("asd ssh setup demo --write-config")
  expect(ui.button("Set up and add the Include line to ~/.ssh/config").classList.contains("mac")).toBe(true)
  expect(ui.text("#modal")).toContain("Set up and add the Include line to ~/.ssh/configButtons marked ⌘ ask on your Mac")
  // Esc closes the form.
  ui.doc.dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape" })); await ui.settle()
  expect(ui.doc.getElementById("modal")!.hidden).toBe(true)
})

test("Settings shows every setting; each saves on its own, and the defaults save together", async () => {
  let config: any = { defaults: { cpus: 1 }, requireProbes: true, experimental: false, workspaceFreeSpaceGb: 5, diskWatchSeconds: 5, terminal: "default" }
  const ui = await page({ ...base, list: () => [], about: () => ({ build: "0.4.0+1", builtInDefaults: { image: "img", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20, docker: false }, platform: "darwin", arch: "arm64", pid: 1, startedAt: "2026-11-18T00:00:00Z", stateDir: "/s", configDir: "/c", cli: "/x/asd" }),
    configGet: () => config, configSet: (body) => { config = { ...config, ...body }; for (const key of Object.keys(body)) if (body[key] === null) delete config[key]; if (body.defaults === null) config.defaults = {}; return config } })
  await ui.click("Settings")
  const get = (id: string) => ui.doc.getElementById(id) as any
  expect(get("disk-watch").value).toBe("5"); expect(get("terminal").value).toBe("default"); expect(get("d-cpus").value).toBe("1"); expect(get("d-memory").placeholder).toBe("4")
  expect(get("terminal").querySelector("option[value=custom]").disabled).toBe(true)
  expect(ui.text("#about")).toContain("/x/asd")
  get("disk-watch").value = "2"; get("disk-watch").dispatchEvent(new ui.window.Event("change")); await ui.settle()
  get("terminal").value = "ghostty"; get("terminal").dispatchEvent(new ui.window.Event("change")); await ui.settle()
  get("d-cpus").value = ""; get("d-docker").value = "true"; get("default-engine").value = "fake:1"
  await ui.submit(get("defaults"))
  expect(ui.calls.filter((call) => call.method === "configSet").map((call) => call.body)).toEqual([{ diskWatchSeconds: 2 }, { terminal: "ghostty" }, { defaults: { docker: true }, engine: "fake:1" }])
  expect(config).toMatchObject({ diskWatchSeconds: 2, terminal: "ghostty", defaults: { docker: true }, engine: "fake:1" })
  expect(ui.text("#settings-section")).toContain("asd config set terminal-command")
  // Setup runs only in a terminal; the page shows its commands.
  expect([...ui.doc.querySelectorAll("#engines .cmd code")].map((node) => node.textContent)).toEqual(["asd setup", "asd setup --docker", "asd setup --remove"])
  expect(ui.text("#glossary")).toContain("Network testisolation probes")
})

test("extensions are optional; they list their actions, a global action runs with no sandbox, a sandbox action asks which", async () => {
  const global = { ...extension, id: "acct", name: "Accounts", dir: "/x/extensions/acct", bundled: true, actions: [{ id: "sync", label: "Sync", scope: "global", run: ["./sync"], fields: [] }, extension.actions[0]] }
  const ui = await page({ ...base, extensions: () => ({ extensions: [global], errors: ["broken: extension.json is not valid JSON"] }), list: () => [sandbox()], action: () => ({ exitCode: 0, stdout: "synced", stderr: "" }), extensionRemove: () => ({}) })
  await ui.click("Extensions")
  expect(ui.text("#extension-section")).toContain("None come installed.")
  expect(ui.text("#extensions")).toContain("broken: extension.json is not valid JSON")
  // A list like the sandboxes': a row per extension, with what it does and how many actions, and no disclosures.
  expect(ui.doc.querySelectorAll("#extension-section details").length).toBe(0)
  expect(ui.text("#extensions button.lrow[data-extension=acct]")).toBe("Accounts2 actions›")
  ;(ui.doc.querySelector("#extensions button.lrow[data-extension=acct]") as any).click(); await ui.settle()
  // Its own page: the folder only on hover, a card per action with where it acts, its form and its command beneath.
  expect(ui.doc.getElementById("extension-list")!.hidden).toBe(true)
  const view = ui.doc.querySelector("#extension-page [data-extension=acct]")!
  expect(view.querySelector("h1")!.textContent).toBe("Accounts")
  expect(view.querySelector("h1 [data-tip]")!.getAttribute("data-tip")).toBe("In /x/extensions/acct")
  expect([...view.querySelectorAll(".act-card .item-head")].map((head) => head.textContent)).toEqual(["SyncOn this Mac", "Install thingOn a sandbox"])
  const card = (id: string) => view.querySelector(`.act-card[data-action=${id}]`)!
  expect(card("sync").querySelector(".cmd code")!.textContent).toBe("asd ext run acct sync")
  await ui.submit(card("sync").querySelector("form"))
  const page2 = () => ui.doc.querySelector("#extension-page [data-extension=acct]")!
  const fresh = (id: string) => page2().querySelector(`.act-card[data-action=${id}]`)!
  expect(fresh("sync").querySelector("pre")!.textContent).toBe("synced")
  const form = fresh("install").querySelector("form") as any
  expect(form.elements.namedItem("asidee-sandbox").value).toBe("demo")
  expect(fresh("install").querySelector(".cmd code")!.textContent).toBe("asd ext run acct install demo --set version=latest")
  form.elements.namedItem("version").value = "1 beta"; form.elements.namedItem("force").checked = true; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(fresh("install").querySelector(".cmd code")!.textContent).toBe("asd ext run acct install demo --set 'version=1 beta' --set force=true")
  form.elements.namedItem("version").value = "latest"; form.elements.namedItem("force").checked = false
  await ui.submit(form)
  expect(ui.calls.filter((call) => call.method === "action").map((call) => call.body)).toEqual([{ extension: "acct", action: "sync", values: {} }, { extension: "acct", action: "install", sandbox: "demo", values: { version: "latest", force: "false" } }])
  // The terminal commands are a card at the bottom; Remove is in the ⋯ menu; the crumb goes back to the list.
  expect([...ui.doc.querySelectorAll("#extension-commands .cmd code")].map((node) => node.textContent)).toEqual(["asd ext run acct sync", "asd ext run acct install SANDBOX --set version=latest --set force=false", "asd ext list", "asd ext remove acct"])
  await ui.click("Extensions /")
  expect(ui.doc.getElementById("extension-list")!.hidden).toBe(false)
  expect(ui.doc.getElementById("extension-page")!.hidden).toBe(true)
  // Removing it from its page goes back to the list, in place of the page's path.
  ;(ui.doc.querySelector("#extensions button.lrow[data-extension=acct]") as any).click(); await ui.settle()
  const depth = ui.window.history.length
  await ui.click("Remove")
  expect(ui.calls.find((call) => call.method === "extensionRemove")!.body).toEqual({ id: "acct" })
  expect(ui.doc.getElementById("extension-list")!.hidden).toBe(false)
  expect(ui.window.location.pathname).toBe("/extensions")
  expect(ui.window.history.length).toBe(depth)
  const none = await page({ ...base, extensions: () => ({ extensions: [], errors: [], available: [{ id: "logins", name: "Agent logins", installed: false }] }), list: () => [], extensionInstall: () => ({}) })
  await none.click("Extensions")
  expect(none.text("#extensions")).toContain("None installed. Asidee works without any.")
  await none.click("Install")
  expect(none.calls.find((call) => call.method === "extensionInstall")!.body).toEqual({ id: "logins" })
})

test("templates are listed, can seed a new sandbox, and can be removed", async () => {
  const template = { name: "base", engine: "fake:1", imageId: "sha256:x", source: "demo", sourceImage: "img", createdAt: "2026-11-18T00:00:00Z", sizeBytes: 2 * 1024 ** 3, loginsRemoved: [".claude"], dependants: [] }
  const ui = await page({ ...base, list: () => [], templateList: () => [template], templateRemove: () => ({ removed: "base", imageId: "x", dependants: [], note: "Removed." }) })
  await ui.click("Templates")
  expect(ui.text("#templates")).toContain("base2.0 GB · from demo (img)")
  await ui.click("New sandbox from it")
  expect((ui.doc.getElementById("f-template") as any).value).toBe("base")
  expect((ui.doc.querySelector("#template-pills input[value=base]") as any).checked).toBe(true)
  expect(ui.text("#create-command")).toContain("--template base")
  await ui.click("Cancel")
  ;(ui.doc.querySelector("#templates button.dang") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "templateRemove")!.body).toEqual({ name: "base", engine: "fake:1" })
})

test("machines are off until experimental is on; then remote sandboxes are routed by host, with their use and GPU containers under them", async () => {
  const off = await page({ ...base, list: () => [] })
  off.doc.getElementById("machines-tab")!.click(); await off.settle()
  expect(off.text("#machines")).toContain("experimental and off")
  expect(off.calls.some((call) => call.method === "fleet")).toBe(false)
  const remote = sandbox({ name: "soak" }), gpu = sandbox({ name: "cuda", spec: { name: "cuda", image: "x", cpus: 4, memoryGb: 8, pids: 4096, diskGb: 40, gpu: true } })
  const ui = await page({ ...base, list: () => [], configGet: () => ({ defaults: {}, requireProbes: true, experimental: true }), stop: () => ({}), usage: (body) => body.host ? [usageOf({ name: "soak" })] : [],
    fleet: () => ({ machines: [{ machine: { host: { name: "local", machineId: "a" }, state: "online" }, stale: false }, { machine: { host: { name: "home-linux", ssh: "home-linux" }, state: "online", hello: { version: "0.4.0", service: "systemd" } }, cached: { sandboxes: [remote, gpu] }, stale: false }] }) })
  await ui.click("Machines")
  expect(ui.text("#machines")).toContain("home-linuxLinux machineonline")
  expect(ui.text("#machines")).toContain("memory 512 MB of 4.0 GB · disk 3.0 GB of 20.0 GB")
  expect(ui.text("#machines .nested")).toContain("GPU containers on home-linux")
  expect(ui.text("#machines .nested")).toContain("cuda")
  expect(ui.text("#machines .nested")).not.toContain("soak")
  ;(ui.doc.querySelector("#machines .item button.sm") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "stop")!.body).toEqual({ name: "soak", host: "home-linux" })
  expect(ui.text("#machines")).toContain("ForgetButtons marked ⌘ ask on your Mac")
})

// Another machine's public sandboxes, as the fleet reports them: home-linux answers, lab does not (its last-known rows).
const fleetOf = (sandboxes: object[], offline: object[] = []) => () => ({ machines: [{ machine: { host: { name: "local", machineId: "a" }, state: "online" }, stale: false },
  { machine: { host: { name: "home-linux", ssh: "home-linux" }, state: "online", hello: { version: "0.4.0", service: "systemd" } }, cached: { sandboxes }, stale: false },
  ...offline.length ? [{ machine: { host: { name: "lab", ssh: "lab" }, state: "offline", error: "ssh: connect timed out" }, cached: { sandboxes: offline }, stale: true }] : []] })
const fleetReplies = { configGet: () => ({ defaults: {}, requireProbes: true, experimental: true }), usage: (body: any) => body.host ? [usageOf({ name: "soak" })] : [], forwardList: () => [] }

test("public sandboxes of other machines join the list with their machine as a tag; an offline machine's are greyed, never running", async () => {
  const ui = await page({ ...base, ...fleetReplies, list: () => [sandbox({ visibility: "private" })],
    fleet: fleetOf([sandbox({ name: "soak", spec: { name: "soak", image: "x", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 } })], [sandbox({ name: "old", status: "unknown" })]) })
  expect(ui.doc.getElementById("sandboxes-tab")!.getAttribute("data-count")).toBe("3")
  const row = ui.doc.querySelector('#sandboxes .lrow[data-name="home-linux/soak"]') as any
  expect(row.tagName).toBe("BUTTON")
  expect(row.querySelector(".mtag").textContent).toBe("home-linux")
  expect(ui.text('#sandboxes .lrow[data-name="home-linux/soak"] .disk-col')).toContain("3.0 GB of 20.0 GB")
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).not.toContain("home-linux")
  const away = ui.doc.querySelector('#sandboxes .lrow[data-name="lab/old"]') as any
  expect(away.tagName).toBe("DIV")
  expect(away.className).toContain("away")
  expect(ui.text('#sandboxes .lrow[data-name="lab/old"]')).toContain("lab is offline")
  expect(ui.text('#sandboxes .lrow[data-name="lab/old"]')).not.toContain("Running")
  // With other machines off, only this machine's sandboxes are listed and the fleet is not read.
  const off = await page({ ...base, list: () => [sandbox()], fleet: fleetOf([sandbox({ name: "soak" })]) })
  expect(off.doc.querySelectorAll("#sandboxes button.lrow")).toHaveLength(1)
  expect(off.calls.some((call) => call.method === "fleet")).toBe(false)
})

test("a remote sandbox has its own page at /sandboxes/MACHINE/NAME with full control, routed to its machine", async () => {
  const soak = sandbox({ name: "soak", spec: { name: "soak", image: "x", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 } })
  const ui = await page({ ...base, ...fleetReplies, list: () => [], fleet: fleetOf([soak]), stop: () => ({}), verify: () => ({}), visibilitySet: () => ({}),
    sshAccess: (body) => ({ alias: `${body.name}.${body.host}.asidee`, user: "root", home: "/root", batchReady: true, loopbackForwarding: true }),
    action: () => ({ exitCode: 0, stdout: "done", stderr: "" }) })
  await ui.open("home-linux/soak")
  expect(ui.window.location.pathname).toBe("/sandboxes/home-linux/soak")
  expect(ui.doc.title).toBe("soak on home-linux · Asidee")
  expect(ui.text("#sandbox-page h1")).toBe("soak")
  expect(ui.text("#sandbox-page .head .tag")).toBe("home-linux")
  // Private and public are set on the sandbox's own machine; from here it can only be made private.
  expect(ui.doc.getElementById("visibility")).toBe(null)
  expect(ui.text("#sandbox-page")).toContain("SSH ready · soak.home-linux.asidee")
  await ui.click("Stop")
  expect(ui.calls.find((call) => call.method === "stop")!.body).toEqual({ name: "soak", host: "home-linux" })
  await ui.click("Check now")
  expect(ui.calls.find((call) => call.method === "verify")!.body).toEqual({ name: "soak", host: "home-linux" })
  // This Mac's extension runs here and reaches the sandbox through its machine.
  ;(ui.doc.querySelector('#sandbox-page [data-extension=tools] button') as any).click(); await ui.settle()
  expect(ui.text("#modal .cmd code")).toBe("asd --host home-linux ext run tools install soak --set version=latest")
  await ui.submit(ui.doc.querySelector("#modal form.action"))
  expect(ui.calls.find((call) => call.method === "action")!.body).toEqual({ extension: "tools", action: "install", sandbox: "soak", machine: "home-linux", values: { version: "latest", force: "false" } })
  await ui.pick("Commands for a terminal")
  expect([...ui.doc.querySelectorAll("#modal .cmd code")].map((node: any) => node.textContent)[0]).toBe("asd --host home-linux shell soak")
  await ui.pick("Make private…")
  expect(ui.prompts.at(-1)).toContain("Make soak private on home-linux? This Mac then no longer sees it")
  expect(ui.calls.find((call) => call.method === "visibilitySet")!.body).toEqual({ name: "soak", host: "home-linux", visibility: "private" })
})

test("a deep link to a remote sandbox opens once the machines are read, and one that is not shared says it is not there", async () => {
  const fleet = fleetOf([sandbox({ name: "soak", spec: { name: "soak", image: "x", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 } })], [sandbox({ name: "old", status: "unknown" })])
  const ui = await page({ ...base, ...fleetReplies, list: () => [], fleet }, "http://127.0.0.1:7717/sandboxes/home-linux/soak#token=secret")
  expect(ui.window.location.pathname).toBe("/sandboxes/home-linux/soak")
  expect(ui.text("#sandbox-page h1")).toBe("soak")
  const gone = await page({ ...base, ...fleetReplies, list: () => [], fleet }, "http://127.0.0.1:7717/sandboxes/home-linux/hidden#token=secret")
  expect(gone.text("#sandbox-page")).toContain("hidden on home-linux is not here any more")
  const offline = await page({ ...base, ...fleetReplies, list: () => [], fleet }, "http://127.0.0.1:7717/sandboxes/lab/old#token=secret")
  expect(offline.text("#sandbox-page")).toContain("lab is offline, so old cannot be reached")
  expect(offline.doc.querySelector("#sandbox-page .end")).toBe(null)
})

test("a sandbox of this machine is private or public by a toggle that says what private does not hide; Settings has the switch for other machines' creates", async () => {
  let config: any = { defaults: {}, requireProbes: true, experimental: false, remoteCreate: false }
  const ui = await page({ ...base, list: () => [sandbox({ visibility: "private" })], visibilitySet: (body) => sandbox({ visibility: body.visibility }),
    configGet: () => config, configSet: (body) => { config = { ...config, ...body }; return config } })
  await ui.open("demo")
  const radio = (value: string) => ui.doc.querySelector(`#visibility input[value=${value}]`) as any
  expect(radio("private").checked).toBe(true)
  expect(ui.doc.querySelector("#visibility .help")!.getAttribute("data-tip")).toBe("Private keeps a sandbox from other machines. Anyone signed in to this machine's own account can still see it.")
  expect(ui.text("#visibility")).toContain("Other machines do not see it.")
  radio("public").checked = true; radio("public").dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.calls.find((call) => call.method === "visibilitySet")!.body).toEqual({ name: "demo", visibility: "public" })
  expect(ui.text("#sandbox-page")).toContain("demo is public: other machines that route here see it and can use it.")
  await ui.click("Settings")
  const toggle = ui.doc.getElementById("remote-create") as any
  expect(toggle.checked).toBe(false)
  expect(ui.text("#settings-section")).toContain("Let other machines create sandboxes here")
  toggle.checked = true; toggle.dispatchEvent(new ui.window.Event("change")); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "configSet").map((call) => call.body)).toEqual([{ remoteCreate: true }])
  expect(toggle.checked).toBe(true)
})

test("the page calls only methods open to the dashboard", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({}), sshAccess: () => ({ alias: "demo.asidee" }) })
  for (const tab of ["workspaces", "templates", "machines", "extensions", "settings", "sandboxes"]) { ui.doc.getElementById(`${tab}-tab`)!.click(); await ui.settle() }
  await ui.open("demo")
  const used = [...new Set(ui.calls.map((call) => call.method))]
  expect(used.filter((method) => (CATALOG as Record<string, readonly string[]>)[method]?.[0] !== "dashboard")).toEqual([])
})

test("create sends Docker inside only when chosen, and shows the same create as a CLI command", async () => {
  const ui = await page({ ...base, list: () => [], create: (body) => ({ sandbox: { name: body.name } }) })
  const form = ui.doc.getElementById("create") as any
  const submit = async (name: string, docker: string) => { form.elements.namedItem("name").value = name; form.elements.namedItem("dockerInside").value = docker; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
    const shown = ui.text("#create-command"); await ui.submit(form); return shown }
  expect(await submit("one", "true")).toContain("asd create one --docker")
  expect(await submit("two", "")).toContain("asd create two")
  const bodies = ui.calls.filter((call) => call.method === "create").map((call) => call.body)
  expect(bodies[0]).toMatchObject({ name: "one", docker: true }); expect(bodies[0]).not.toHaveProperty("dockerInside")
  expect(bodies[1]).not.toHaveProperty("docker")
})

test("every copyable command quotes a value for the shell only when it needs it", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  const doc = ui.doc as any, form = doc.getElementById("create")
  const typed = async (values: Record<string, string>) => { for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value; form.dispatchEvent(new ui.window.Event("input")); await ui.settle(); return ui.text("#create-command code") }
  expect(await typed({ name: "plain-1", image: "ghcr.io/acme/app:1.2", cpus: "2.5" })).toBe("asd create plain-1 --image ghcr.io/acme/app:1.2 --cpus 2.5")
  expect(await typed({ name: "my app", image: "img:$TAG", cpus: "" })).toBe("asd create 'my app' --image 'img:$TAG'")
  expect(await typed({ name: "it's", image: "a;rm -rf ~" })).toBe("asd create 'it'\\''s' --image 'a;rm -rf ~'")
  expect(await typed({ name: "x", image: "\"q\" `w` *" })).toBe("asd create x --image '\"q\" `w` *'")
  // A leading ~name or =word would be expanded by the shell (zsh expands =command), so it is quoted.
  expect(await typed({ name: "x", image: "~root" })).toBe("asd create x --image '~root'")
  expect(await typed({ name: "x", image: "=ls" })).toBe("asd create x --image '=ls'")
  expect(await typed({ name: "x", image: "a=~" })).toBe("asd create x --image 'a=~'")
  // The template form's command quotes its values too.
  const prepare = doc.getElementById("prepare")
  prepare.elements.namedItem("name").value = "agent"; prepare.elements.namedItem("claude").value = "2.1 beta"; prepare.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#prepare-command code")).toContain("asd template prepare agent --claude '2.1 beta' --codex")
})

test("create runs the chosen setup steps after the create, in the CLI's order, and stops at the first failure", async () => {
  const bundled = ["logins", "folders", "repo", "t3"].map((id) => ({ id, name: id, actions: [] }))
  const ui = await page({ ...base, list: () => [sandbox({ name: "fresh" })], extensions: () => ({ extensions: bundled, errors: [] }), create: (body) => ({ sandbox: { name: body.name } }),
    folderBrowse: () => ({ path: "~", folders: [], picks: [{ path: "~/.agents", label: "Shared skills (.agents)" }] }),
    folderPreview: (body) => ({ source: body.source, mirror: body.source, files: 2, links: 0, folders: 1, bytes: 10, partial: false, excluded: [], excludedCount: 0, skipped: [], skippedCount: 0, largest: [], warnings: [] }),
    createStep: (body) => sandbox({ name: "fresh", ...(body.ok ? {} : { unfinished: { stage: "setup", reason: "x", removeAt: "2026-11-21T10:00:00Z", done: [] } }) }),
    action: (body) => body.action === "profiles" ? { exitCode: 0, stdout: `noise <b>\n${JSON.stringify({ agent: body.values.agent, profiles: ["work", "home", "../x", "<b>"], token: "s3cret" })}\n`, stderr: "" }
      : body.action === "clone" ? { exitCode: 2, stdout: "<i>no access</i>", stderr: "" } : { exitCode: 0, stdout: `${body.action} ok`, stderr: "" } })
  const doc = ui.doc as any
  expect([...doc.querySelectorAll('#create-setup input[data-agent="claude"]')].map((box: any) => box.dataset.profile)).toEqual(["work", "home"])
  expect(ui.text("#create-setup")).toContain("anything running there can read it")
  expect(ui.text("#create-setup")).not.toContain("s3cret")
  const form = doc.getElementById("create")
  form.elements.namedItem("name").value = "fresh"; doc.getElementById("setup-gh").checked = true; doc.getElementById("setup-claude-work").checked = true; doc.getElementById("setup-claude-home").checked = true; doc.getElementById("setup-t3").checked = true
  doc.getElementById("setup-repo").value = "acme/app.git"; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("asd create fresh --gh --claude work --claude home --repo acme/app.git --t3")
  // Folders are copied after the clone, which needs an empty ~/workspace, each in the order added. A quick pick fills
  // the folder; the one being picked is in the command before it is added.
  expect(ui.text("#create-setup")).toContain("Copy folders in")
  const quick = doc.querySelector('#create-setup input[name="setup-copy-pick-pick"]')
  expect(quick.closest("label").textContent).toBe("Shared skills (.agents)"); expect(quick.closest("label").title).toBe("~/.agents")
  quick.checked = true; quick.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await ui.settle()
  expect(ui.text("#create-command")).toContain("--repo acme/app.git --copy ~/.agents --t3")
  // No sandbox yet to ask, so the place is given as under its user's home, which the image decides.
  await Bun.sleep(400); await ui.settle()
  expect(ui.text("#create-setup .folder-preview")).toContain("goes to ~/.agents in the sandbox, under its user's home, unless you give another place")
  await ui.click("Add another folder")
  expect(ui.text("#setup-copies")).toBe("~/.agents → the same placeRemove")
  // A value that needs it is quoted for the shell; ~/ stays outside the quotes. DEST follows a colon.
  const pick = doc.getElementById("setup-copy-pick")
  pick.value = "~/my hq"; pick.dispatchEvent(new ui.window.Event("input", { bubbles: true })); doc.getElementById("setup-copy-dest").value = "~/hq"; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("--copy ~/.agents --copy ~/'my hq:~/hq' --t3")
  await ui.click("Add another folder")
  doc.querySelector('[aria-label="Remove ~/.agents"]').click(); await ui.settle()
  // The browser sets T3 up first, so its one flag stands for both.
  doc.getElementById("setup-t3-browser").checked = true; form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#create-command")).toContain("--repo acme/app.git --copy ~/'my hq:~/hq' --t3-browserCopy")
  await ui.submit(form)
  expect(ui.text("#create-error")).toBe("Repository takes a GitHub OWNER/REPO.")
  expect(ui.calls.some((call) => call.method === "create")).toBe(false)
  doc.getElementById("setup-repo").value = "acme/app"
  await ui.submit(form)
  // The setup goes with the create, as the CLI's flags, so the daemon can keep it for a retry.
  const create = ui.calls.find((call) => call.method === "create")!.body
  expect(create.setup).toEqual({ gh: true, claude: ["work", "home"], codex: [], repo: "acme/app", copy: ["~/my hq:~/hq"], t3: true, "t3-browser": true })
  expect(Object.keys(create).filter((key) => key.startsWith("setup-"))).toEqual([])
  expect(ui.calls.filter((call) => call.method === "createStep").map((call) => call.body)).toEqual([{ name: "fresh", step: "GitHub login", ok: true },
    { name: "fresh", step: "Claude login work", ok: true }, { name: "fresh", step: "Claude login home", ok: true }, { name: "fresh", step: "Clone acme/app", ok: false }])
  const steps = ui.calls.filter((call) => call.method === "action" && !["profiles", "list"].includes(call.body.action)).map((call) => call.body)
  expect(steps).toEqual([{ extension: "logins", action: "github", sandbox: "fresh", values: {} }, { extension: "logins", action: "import", sandbox: "fresh", values: { agent: "claude", profile: "work", setup: true } },
    { extension: "logins", action: "import", sandbox: "fresh", values: { agent: "claude", profile: "home", setup: true } }, { extension: "repo", action: "clone", sandbox: "fresh", values: { repository: "acme/app" } }])
  const shown = ui.text("#sandbox-page pre")
  expect(shown).toContain("GitHub login: done"); expect(shown).toContain("Claude login work: done")
  expect(shown).toContain("Clone acme/app: failed with exit 2 <i>no access</i>")
  expect(shown).toContain("Clone acme/app failed, so the steps after it did not run. fresh is kept. It is removed at ")
  expect(shown).toContain("unless Retry finishes it or you choose Don't remove.")
  expect(doc.querySelector("#sandbox-page pre i")).toBe(null)
})

test("a sandbox whose setup did not finish says when it goes; Retry runs the steps left, and Don't remove keeps it", async () => {
  const unfinished = { stage: "setup", reason: "Its setup step Clone acme/app failed.", removeAt: later(26), setup: { gh: true, repo: "acme/app", t3: true }, done: ["GitHub login"], failed: "Clone acme/app" }
  const bundled = ["logins", "repo", "t3"].map((id) => ({ id, name: id, actions: [] }))
  const ui = await page({ ...base, list: () => [sandbox({ unfinished })], extensions: () => ({ extensions: bundled, errors: [] }), sshAccess: () => ({}),
    action: (body) => body.action === "profiles" || body.action === "list" ? { exitCode: 0, stdout: "", stderr: "" } : { exitCode: 0, stdout: `${body.action} ok`, stderr: "" },
    createRetry: () => ({ sandbox: sandbox(), setup: unfinished.setup, remaining: ["Clone acme/app", "T3 Code"] }), createStep: () => sandbox(), createKeep: () => sandbox() })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Setup did not finish")
  await ui.open("demo")
  const card = ui.text("#unfinished-demo")
  expect(card).toContain("Setup stopped at step 2 of 3")
  expect(card).toContain("Its setup step Clone acme/app failed.")
  expect(card).toContain("Clone acme/appFailed")
  expect(card).toContain("T3 Codedid not run")
  expect(card).toMatch(/Removed at .+ \(in 2[56] mins\)/)
  expect(card).not.toContain("Keep as it is")
  await ui.click("Retry")
  expect(ui.calls.filter((call) => call.method === "action" && !["profiles", "list"].includes(call.body.action)).map((call) => call.body.action)).toEqual(["clone", "setup"])
  expect(ui.calls.filter((call) => call.method === "createStep").map((call) => call.body.step)).toEqual(["Clone acme/app", "T3 Code"])
  await ui.click("Don't remove")
  expect(ui.calls.find((call) => call.method === "createKeep")!.body).toEqual({ name: "demo" })
  expect(ui.text("#sandbox-page pre")).toBe("demo stays as it is until you remove it. The steps left do not run.")
})

test("a sandbox that failed its checks at create says what happened, in plain words", async () => {
  const lastVerify = historical({ at: "2026-11-21T10:00:00Z", results: [check("net-peers", "fail", "A connection reached 10.0.0.5.")] as CheckResult[] })
  const ui = await page({ ...base, list: () => [sandbox({ status: "stopped", lastVerify, unfinished: { stage: "checks", reason: "A required check failed.", removeAt: later(30), done: [] } })], sshAccess: () => ({}) })
  expect(ui.text("#sandboxes .lrow[data-name=demo]")).toContain("Did not pass its checks")
  await ui.open("demo")
  expect(ui.text("#unfinished-demo h3")).toBe("demo reached another sandbox. It was stopped.")
  expect(ui.button("Don't remove").getAttribute("data-tip")).toContain("stopped if its checks failed")
})

test("setup inputs appear only for installed extensions", async () => {
  const ui = await page({ ...base, list: () => [], extensions: () => ({ extensions: [{ id: "repo", name: "repo", actions: [] }], errors: [] }) })
  const doc = ui.doc
  expect(doc.getElementById("setup-repo")).not.toBe(null)
  for (const id of ["gh", "claude", "codex", "t3"]) expect(doc.getElementById(`setup-${id}`)).toBe(null)
  expect(ui.text("#create-setup")).not.toContain("token")
  expect(ui.calls.some((call) => call.method === "action")).toBe(false)
})

test("the Prepare form starts from this machine's versions and sends one templatePrepare, the CLI's own method", async () => {
  const done = { template: { name: "uitest", engine: "fake:1", sizeBytes: 2 * 1024 ** 3 }, versions: { claude: "2.1.310", codex: "0.164.0" }, tools: ["2.1.310 (Claude Code)"], default: false, lines: ["Creating the sandbox x…"] }
  const ui = await page({ ...base, list: () => [], templateList: () => [], templatePreparing: () => [], templatePrepare: () => done,
    templatePrepareInfo: () => ({ versions: { claude: "2.1.310", codex: "0.164.0" }, script: { path: "/Users/me/.config/asidee/agent-template.sh", exists: true } }) })
  await ui.click("Templates")
  expect(ui.text("#template-section h4")).toBe("Make a coding-tools template")
  const form = ui.doc.getElementById("prepare") as any
  expect(form.elements.namedItem("claude").value).toBe("2.1.310")
  expect(ui.text("#p-script")).toContain("/Users/me/.config/asidee/agent-template.sh")
  form.elements.namedItem("name").value = "uitest"; form.elements.namedItem("script").value = "file"; form.elements.namedItem("replace").checked = true
  form.dispatchEvent(new ui.window.Event("input")); await ui.settle()
  expect(ui.text("#prepare-command")).toContain("asd template prepare uitest --claude 2.1.310 --codex 0.164.0 --script /Users/me/.config/asidee/agent-template.sh --replace")
  await ui.submit(form)
  expect(ui.calls.filter((call) => call.method === "templatePrepare").map((call) => call.body)).toEqual([{ name: "uitest", claude: "2.1.310", codex: "0.164.0", engine: "fake:1", replace: true, default: false, scriptFile: true }])
  expect(ui.text("#prepare-progress")).toContain("Saved template uitest (2.0 GB) on fake:1")
  await ui.submit(form, { script: "paste", scriptText: "echo hi" })
  expect(ui.calls.filter((call) => call.method === "templatePrepare").at(-1)!.body).toMatchObject({ script: "echo hi" })
  expect(ui.calls.filter((call) => call.method === "templatePrepare").at(-1)!.body).not.toHaveProperty("scriptFile")
})

test("actions asked on the Mac say so beside the button, show the wait in the island, and offer the CLI command when refused", async () => {
  let answer!: (value: unknown) => void
  const refusal = Object.assign(new Error("No dialog can be shown on this Mac, so only the CLI can do this. From the CLI: asd config set terminal-command 'kitty sh -c {command}'"),
    { code: "forbidden", details: { approval: "unavailable", command: "asd config set terminal-command 'kitty sh -c {command}'" } })
  const workspace = { name: "render", status: "idle", processes: 0, folder: "/fixture/render", disclosure: "Not a sandbox.", spec: { hostTemp: false, diskGb: 20 } }
  const ui = await page({ ...base, list: () => [sandbox()], summary: () => ({ workspaces: [workspace] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({ platform: "darwin" }),
    terminalCommandSet: () => new Promise((resolve, reject) => { answer = (value) => value instanceof Error ? reject(value) : resolve(value) }),
    workspaceStop: () => ({}), workspaceRemove: (body) => ({ removed: body.name, notRemoved: [] }), workspaceExec: () => ({ exitCode: 0, stdout: "hi", stderr: "" }) })
  expect(ui.text("#island")).toBe("Ready")
  await ui.click("Settings")
  expect(ui.text("#terminal-custom")).toContain("A dialog on this Mac asks you to allow it first. No answer within 60 s means no.")
  await ui.submit(ui.doc.querySelector("#terminal-custom form"), { command: "kitty sh -c {command}" })
  expect(ui.text("#terminal-custom")).toContain("Waiting for you on your Mac…")
  expect(ui.text("#terminal-custom")).toContain("No answer within 60 s means no.")
  // One sentence: the request, the action in plain words, and the time left.
  expect(ui.text("#island")).toMatch(/^Allow on your Mac · (60|59) s · Set the terminal command$/)
  expect(ui.doc.querySelectorAll("#island .ring22.mac").length).toBe(1)
  // There is no way to take the request back, so no Cancel is offered.
  expect([...ui.doc.querySelectorAll("#terminal-custom button")].some((node) => node.textContent === "Cancel")).toBe(false)
  expect(ui.calls.find((call) => call.method === "terminalCommandSet")!.body).toEqual({ terminalCommand: "kitty sh -c {command}" })
  answer(refusal); await ui.settle()
  expect(ui.text("#terminal-custom pre")).toContain("only the CLI can do this")
  expect([...ui.doc.querySelectorAll("#terminal-custom code")].map((node) => node.textContent)).toContain("asd config set terminal-command 'kitty sh -c {command}'")
  expect(ui.text("#island")).toBe("✗Set the terminal commanddid not finish")
  expect(ui.button("Set").classList.contains("mac")).toBe(true)
  expect(ui.text("#terminal-custom")).toContain("Buttons marked ⌘ ask on your Mac")
  // Workspaces: each changing action is marked, the island names it, and remove sends the typed name.
  await ui.click("Workspaces")
  expect(ui.text("#workspaces")).toContain("Buttons marked ⌘ ask on your Mac")
  await ui.click("Stop")
  await ui.click("Remove…")
  expect(ui.calls.filter((call) => call.method.startsWith("workspace")).map((call) => [call.method, call.body])).toEqual([["workspaceStop", { name: "render" }], ["workspaceRemove", { name: "render", confirm: "demo" }]])
  expect(ui.prompts.at(-1)).toContain("/fixture/render")
  // New workspace opens on the right, with stacked fields, its mark and the same in a terminal, shell-quoted.
  await ui.click("New workspace")
  expect(ui.text("#modal")).toContain("It is not a sandbox.")
  expect(ui.button("Create workspace").classList.contains("mac")).toBe(true)
  expect(ui.text("#modal")).toContain("Buttons marked ⌘ ask on your Mac")
  const form = ui.doc.getElementById("workspace-form") as any
  for (const [name, value] of [["name", "art"], ["copy", "~/My Projects/art"], ["claude", "work"]]) { form.elements.namedItem(name).value = value; form.elements.namedItem(name).dispatchEvent(new ui.window.Event("input", { bubbles: true })) }
  expect(ui.text("#modal .cmd code")).toBe("asd workspace create art --copy ~/'My Projects/art' --claude-profile work --codex-profile PROFILE")
  form.elements.namedItem("codex").value = "home"; form.elements.namedItem("codex").dispatchEvent(new ui.window.Event("input", { bubbles: true }))
  await ui.submit(form)
  expect(ui.calls.find((call) => call.method === "workspaceCreate")!.body).toEqual({ name: "art", copy: "~/My Projects/art", logins: { kind: "profiles", claude: "work", codex: "home" } })
  expect(ui.text("#island")).toMatch(/^(Allow on your Mac · (60|59) s · Create the workspace art|✗Create the workspace artdid not finish)$/)
})

test("New workspace offers this Mac's logins for each agent, and asks for both or neither before Create", async () => {
  const logins = { id: "logins", name: "Agent logins", actions: [{ id: "profiles", label: "Profiles", scope: "global", run: ["./x"], fields: [] }] }
  const listing: { claude: () => object; codex: () => object } = { claude: () => ({ exitCode: 0, stdout: `${JSON.stringify({ agent: "claude", profiles: ["default", "work"] })}\n`, stderr: "" }), codex: () => ({ exitCode: 0, stdout: `${JSON.stringify({ agent: "codex", profiles: ["default"] })}\n`, stderr: "" }) }
  const replies = (codex: () => object) => ({ ...base, extensions: () => ({ extensions: [logins], errors: [] }), list: () => [], summary: () => ({ workspaces: [] }), workspaceCreate: () => new Promise(() => {}),
    action: (body: any) => body.action === "profiles" ? (body.values.agent === "codex" ? codex : listing.claude)() : { exitCode: 0, stdout: "[]", stderr: "" } })
  const ui = await page(replies(listing.codex))
  await ui.click("Workspaces"); await ui.click("New workspace")
  const choices = (agent: string) => [...ui.doc.querySelectorAll(`#ws-logins [data-agent=${agent}] label`)].map((node: any) => node.textContent)
  expect(choices("claude")).toEqual(["None", "default", "work"])
  expect(choices("codex")).toEqual(["None", "default"])
  expect(ui.doc.querySelectorAll("#modal input[name=claude]:not([type=radio]), #modal input[name=codex]:not([type=radio])").length).toBe(0)
  const form = () => ui.doc.getElementById("workspace-form") as any
  const choose = async (agent: string, profile: string) => { const radio = ui.doc.querySelector(`#ws-logins input[name=${agent}][value="${profile}"]`) as any; radio.checked = true; radio.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await ui.settle() }
  const name = form().elements.namedItem("name"); name.value = "art"; name.dispatchEvent(new ui.window.Event("input", { bubbles: true }))
  expect(ui.text("#modal .cmd code")).toBe("asd workspace create art --no-logins")
  expect((ui.doc.getElementById("ws-logins-error") as any).hidden).toBe(true)
  // One agent alone is refused by the service, so it is said here and Create waits.
  await choose("claude", "work")
  expect((ui.doc.getElementById("ws-logins-error") as any).hidden).toBe(false)
  expect(ui.text("#ws-logins-error")).toBe("Pick a Claude and a Codex login, or None for both.")
  expect(ui.button("Create workspace").disabled).toBe(true)
  expect(ui.text("#modal .cmd code")).toBe("asd workspace create art --claude-profile work --codex-profile PROFILE")
  await ui.submit(form())
  expect(ui.calls.some((call) => call.method === "workspaceCreate")).toBe(false)
  await choose("codex", "default")
  expect((ui.doc.getElementById("ws-logins-error") as any).hidden).toBe(true)
  expect(ui.button("Create workspace").disabled).toBe(false)
  expect(ui.text("#modal .cmd code")).toBe("asd workspace create art --claude-profile work --codex-profile default")
  await ui.submit(form())
  expect(ui.calls.find((call) => call.method === "workspaceCreate")!.body).toEqual({ name: "art", logins: { kind: "profiles", claude: "work", codex: "default" } })
  // A listing that failed is typed, with a note; a Mac with no login says so.
  const failed = await page(replies(() => ({ exitCode: 1, stdout: "", stderr: "boom" })))
  await failed.click("Workspaces"); await failed.click("New workspace")
  expect(failed.doc.querySelector("#modal input[name=codex]:not([type=radio])")).not.toBe(null)
  expect(failed.text("#ws-logins")).toContain("Could not list this Mac's Codex logins. Type a profile name, or leave it blank for none.")
  const none = await page(replies(() => ({ exitCode: 0, stdout: `${JSON.stringify({ agent: "codex", profiles: [] })}\n`, stderr: "" })))
  await none.click("Workspaces"); await none.click("New workspace")
  expect(none.text("#ws-logins")).toContain("No Codex login on this Mac.")
  expect([...none.doc.querySelectorAll("#ws-logins [data-agent=codex] label")].map((node: any) => node.textContent)).toEqual(["None"])
})

test("the default template is picked from the templates, and one that is gone stays as itself", async () => {
  const ui = await page({ ...base, list: () => [], configGet: () => ({ defaults: { template: "old" }, requireProbes: true }), templateList: () => [{ name: "agent", engine: "fake:1", sizeBytes: 1, source: "x", sourceImage: "y", createdAt: "", dependants: [], loginsRemoved: [] }] })
  await ui.click("Settings")
  const select = ui.doc.getElementById("d-template") as any
  expect(select.tagName).toBe("SELECT")
  expect([...select.querySelectorAll("option")].map((node: any) => [node.value, node.textContent])).toEqual([["", "None"], ["agent", "agent"], ["old", "old (not found)"]])
  expect(select.value).toBe("old")
})

test("on a machine without the dialog, the buttons say they are refused here and the command is offered", async () => {
  const ui = await page({ ...base, list: () => [], summary: () => ({ workspaces: [] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({ platform: "linux" }) })
  await ui.click("Settings")
  expect(ui.text("#about")).toContain("This machine has no dialog to allow it, so it is refused and its CLI command offered.")
  expect(ui.button("Stop the service").classList.contains("mac")).toBe(true)
  expect(ui.text("#about")).toContain("Buttons marked ⌘ work only in a terminal here")
})

test("the T3 part sets T3 up, then gives the SSH host to paste, and shows each result in its form", async () => {
  const t3 = { id: "t3", name: "T3 Code", actions: ["setup", "sync", "ssh"].map((id) => ({ id, label: id, scope: "sandbox", fields: [], run: ["./t3.ts", id] })) }
  const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [t3], errors: [] }), sshAccess: () => ({ alias: "demo.asidee", user: "root", home: "/root", batchReady: false, loopbackForwarding: true }),
    action: (body) => body.action === "setup" ? { exitCode: 0, stdout: JSON.stringify({ version: "1.2.3", runtime: "installed", claude: 2, codex: 1, ssh: {} }), stderr: "" } : { exitCode: 1, stdout: "", stderr: "" } })
  await ui.open("demo")
  expect(ui.text("#sandbox-page .part[data-extension=t3]")).toContain("T3 CodeSet up SSH first")
  await ui.click("Connect T3 Code")
  expect(ui.text("#modal")).toContain("Set up SSHButtons marked ⌘ ask on your Mac")
  expect(ui.doc.querySelector("#modal .cmd code")!.textContent).toBe("demo.asidee")
  await ui.click("Set up T3 Code")
  expect(ui.text("#modal pre")).toBe("T3 1.2.3 installed. Logins it found: Claude 2, Codex 1.")
  expect(ui.text("#sandbox-page pre")).toBe("")
})

test("the Logins form lists the sandbox's logins as cards, re-imports or adds one, and tells T3", async () => {
  const logins = { id: "logins", name: "Agent logins", actions: ["import", "github", "list", "logout"].map((id) => ({ id, label: id, scope: "sandbox", fields: [], run: ["./login.ts", id] })) }
  const t3 = { id: "t3", name: "T3 Code", actions: [{ id: "sync", label: "sync", scope: "sandbox", fields: [], run: ["./t3.ts", "sync"] }] }
  let inside = "claude/~ (a@example.com)\nclaude/work (w@example.com)\ngithub/~ (me)\n"
  const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [logins, t3], errors: [] }), sshAccess: () => ({ alias: "demo.asidee", batchReady: true }), openTerminal: () => ({ terminal: "default", command: "x" }),
    action: (body) => body.action === "profiles" ? { exitCode: 0, stdout: JSON.stringify({ agent: body.values.agent, profiles: body.values.agent === "claude" ? ["work", "home"] : [] }), stderr: "" }
      : body.action === "list" ? { exitCode: 0, stdout: inside, stderr: "" }
      : body.action === "import" ? (inside += inside.includes(`claude/${body.values.profile} `) ? "" : `claude/${body.values.profile} (h@example.com)\n`, { exitCode: 0, stdout: "Imported.\nCopied 0 setup files.", stderr: "" })
      : { exitCode: 0, stdout: '{"claude":3,"codex":0}', stderr: "" } })
  await ui.open("demo")
  expect(ui.text("#sandbox-page")).toContain("Logins inside: Claude: main login, work · GitHub")
  // Logins belong to the Agents card, not to an extension part.
  expect(ui.doc.querySelector("#sandbox-page .part[data-extension=logins]")).toBe(null)
  await ui.click("Manage logins")
  const card = (title: string, section = 0) => [...ui.doc.querySelectorAll("#modal .cards")[section]!.querySelectorAll(".card")].find((node) => node.querySelector(".t")!.textContent === title) as any
  expect(card("Claude · work").textContent).toContain("w@example.com")
  // This Mac's work login is in the sandbox already, so only home is offered to add.
  expect([...ui.doc.querySelectorAll("#modal .cards")[1]!.querySelectorAll(".t")].map((node) => node.textContent)).toEqual(["Claude · home"])
  ;[...card("Claude · work").querySelectorAll("button")].find((node: any) => node.textContent === "Re-import")!.click(); await ui.settle()
  expect(ui.text("#modal pre")).toBe("Re-imported Claude · work. T3 Code sees it now.")
  ;[...card("Claude · home", 1).querySelectorAll("button")].find((node: any) => node.textContent === "Add")!.click(); await ui.settle()
  const sent = ui.calls.filter((call) => call.method === "action" && ["import", "sync"].includes(call.body.action)).map((call) => [call.body.action, call.body.values])
  expect(sent).toEqual([["import", { agent: "claude", profile: "work", target: "", setup: "false" }], ["sync", {}], ["import", { agent: "claude", profile: "home", target: "", setup: "false" }], ["sync", {}]])
  expect(card("Claude · home").textContent).toContain("h@example.com")
  // With named logins, asd claude cannot pick the canonical one, so Pick a login offers only the named ones.
  await ui.pick("Pick a login…")
  expect([...ui.doc.querySelectorAll("#modal .card .t")].map((node) => node.textContent)).toEqual(["Claude · work", "Claude · home"])
  ;(ui.doc.querySelector("#modal .card") as any).click(); await ui.settle()
  expect(ui.calls.find((call) => call.method === "openTerminal")!.body).toEqual({ name: "demo", kind: "claude", profile: "work" })
})

test("the default template is offered once, as itself, and creating with it sends no template", async () => {
  const template = (name: string) => ({ name, engine: "fake:1", sizeBytes: 1, source: "x", sourceImage: "y", createdAt: "2026-11-18T00:00:00Z", dependants: [], loginsRemoved: [] })
  const ui = await page({ ...base, list: () => [], configGet: () => ({ defaults: { template: "agent" }, requireProbes: true }), templateList: () => [template("agent"), template("other")], create: (body) => ({ sandbox: { name: body.name } }) })
  expect([...ui.doc.querySelectorAll("#template-pills label")].map((node) => node.textContent)).toEqual(["agent (default)", "other"])
  await ui.submit(ui.doc.getElementById("create"), { name: "fresh" })
  expect(ui.calls.find((call) => call.method === "create")!.body).not.toHaveProperty("template")
  const none = await page({ ...base, list: () => [], templateList: () => [template("other")] })
  expect([...none.doc.querySelectorAll("#template-pills label")].map((node) => node.textContent)).toEqual(["Built-in image", "other"])
})

// First run.
const passing = CHECKLIST.filter((entry) => entry.blocking).map((entry) => check(entry.id, "pass", "ok"))
const setupRun = (over: Record<string, (body: any) => unknown> = {}) => {
  let config: any = { defaults: {}, requireProbes: true }, made: string[] = []
  return { ...base, list: () => made.map((name) => sandbox({ name })), summary: () => ({ workspaces: [] }), usage: () => [], forwardList: () => [], linkList: () => [], templateList: () => [], about: () => ({ platform: "darwin" }),
    templatePreparing: () => [], templatePrepareInfo: () => ({ versions: { claude: "2.1.4", codex: "0.9.0" }, script: { path: "/x", exists: false } }),
    configGet: () => config, templatePrepare: (body: any) => { config = { ...config, defaults: { template: body.name } }; return { template: { name: body.name, engine: "fake:1", sizeBytes: 1 }, tools: [], lines: [], default: true } },
    create: (body: any) => { if (!body.name.startsWith("setup-check-")) made.push(body.name); return { sandbox: { name: body.name }, checks: passing } }, remove: () => ({}),
    openTerminal: () => ({ terminal: "default", command: "x" }), sshAccess: () => ({}), ...over }
}

test("the first run opens by itself, tests a throwaway sandbox, makes the template and the first sandbox, and opens an agent", async () => {
  const ui = await page(setupRun(), undefined, { setupDone: false })
  const step = async (label: string) => { ([...ui.doc.querySelectorAll("#setup button")].find((node) => node.textContent === label) as any).click(); await ui.settle() }
  expect(ui.doc.getElementById("setup-section")!.hidden).toBe(false)
  expect(ui.doc.body.classList.contains("onboarding")).toBe(true)
  expect([...ui.doc.querySelectorAll("#setup .rail button")].map((node) => node.textContent!.replace(/^\d/, ""))).toEqual(["Engine", "Set up", "Test it", "Coding tools", "First sandbox", "Open it", "Leave first run"])
  // The engine is ready, so it starts at the test, with the step before it marked done (not passed).
  expect(ui.text("#setup h1")).toBe("Test it")
  expect(ui.doc.querySelectorAll("#setup .rail button.done").length).toBe(2)
  expect(ui.text("#setup")).toContain("Settings · 8"); expect(ui.text("#setup")).toContain("Network test · 4")
  await step("Run the test")
  const test = ui.calls.find((call) => call.method === "create")!.body
  expect(test.name).toMatch(/^setup-check-[0-9a-f]{6}$/)
  expect(ui.calls.find((call) => call.method === "remove")!.body).toEqual({ name: test.name, confirm: test.name })
  expect(ui.text("#setup")).toContain("All required checks passed. The test sandbox was removed.")
  // Fresh results are the one place the green filled mark is used.
  expect(ui.doc.querySelectorAll("#setup .mk.ok").length).toBe(12)
  await step("Continue")
  expect(ui.text("#setup h1")).toBe("Add coding tools")
  expect(ui.text("#setup")).toContain("Claude Code 2.1.4")
  await step("Make template")
  expect(ui.calls.find((call) => call.method === "templatePrepare")!.body).toEqual({ name: "agent", claude: "2.1.4", codex: "0.9.0", replace: false, default: true })
  await step("Continue")
  expect(ui.text("#setup h1")).toBe("Make your first sandbox")
  expect(ui.text("#setup")).toContain("Starts from the agent template, with coding tools")
  expect(ui.text("#setup .cmd code")).toBe("asd create my-app")
  await ui.submit(ui.doc.getElementById("first-form"))
  expect(ui.calls.filter((call) => call.method === "create").at(-1)!.body).toEqual({ name: "my-app" })
  expect(ui.text("#setup h1")).toBe("my-app is ready")
  await step("Open")
  expect(ui.calls.find((call) => call.method === "openTerminal")!.body).toEqual({ name: "my-app", kind: "claude" })
  await step("Go to the list")
  expect(ui.doc.getElementById("setup-section")!.hidden).toBe(true)
  expect(ui.window.localStorage.getItem("asidee-setup-done")).toBe("1")
  const used = [...new Set(ui.calls.map((call) => call.method))]
  expect(used.filter((method) => (CATALOG as Record<string, readonly string[]>)[method]?.[0] !== "dashboard")).toEqual([])
})

test("the first run names only OrbStack, and shows setup as a command it waits for, never running it", async () => {
  const none = await page(setupRun({ engines: () => [] }), undefined, { setupDone: false })
  expect(none.text("#setup h1")).toBe("Get the engine ready")
  expect(none.text("#setup")).toContain("No engine on this Mac")
  expect((none.doc.querySelector("#setup a.btn") as any).href).toBe("https://orbstack.dev/download")
  expect(none.text("body")).not.toMatch(/Docker Desktop|Colima|Podman|Rancher/)
  // Ready only when a sandbox can be made; without an engine the island says so.
  expect(none.text("#island")).toBe("No engine")
  expect(none.doc.querySelector("#island .dot.off")).not.toBe(null)
  const orb = { id: "docker:orbstack", label: "OrbStack", ready: false, data: { context: "orbstack" }, problems: ["OrbStack does not answer."] }
  const stopped = await page(setupRun({ engines: () => [orb] }), undefined, { setupDone: false })
  expect(stopped.text("#setup")).toContain("OrbStack is installed but not running")
  expect(stopped.text("#setup .cmd code")).toBe("open -a OrbStack")
  expect(stopped.text("#island")).toBe("Engine not running")
  const unset = await page(setupRun({ engines: () => [{ ...orb, problems: ["Not set up for Asidee."] }] }), undefined, { setupDone: false })
  expect(unset.text("#setup")).toContain("Running · not set up for Asidee yet")
  expect(unset.text("#island")).toBe("Engine not set up")
  await unset.click("Continue to setup")
  expect(unset.text("#setup h1")).toBe("Set up the engine")
  expect([...unset.doc.querySelectorAll("#setup .cmd code")].map((node) => node.textContent)).toEqual(["asd setup", "asd setup --docker", "asd setup --remove"])
  expect(unset.text("#island")).toBe("Waiting for asd setupin your terminal")
  // The test needs a ready engine.
  await unset.click("3Test it")
  expect(unset.button("Run the test").disabled).toBe(true)
})

test("a failed first-run test says what happened in plain words and still removes the test sandbox", async () => {
  const lastVerify = historical({ at: "2026-11-21T10:00:00Z", results: [...passing.filter((entry) => entry.id !== "net-peers"), check("net-peers", "fail", "A connection reached 10.0.0.5.")] as CheckResult[] })
  const ui = await page(setupRun({ create: () => { throw new Error("A required check failed: net-peers.") }, get: (body) => sandbox({ name: body.name, lastVerify }) }), undefined, { setupDone: false })
  await ui.click("Run the test")
  expect(ui.text("#setup .banner.bad")).toBe(`Setup is not done. The test sandbox reached another sandbox. The test sandbox was removed.`)
  expect(ui.calls.some((call) => call.method === "remove")).toBe(true)
  expect(ui.button("Retry")).toBeDefined()
  const off = await page(setupRun({ configGet: () => ({ defaults: {}, requireProbes: false }), create: (body) => ({ sandbox: { name: body.name }, checks: passing.map((entry) => CHECKLIST.find((item) => item.id === entry.id)!.stage === "probe" ? check(entry.id, "unknown", "The network test did not run.") : entry) }) }), undefined, { setupDone: false })
  await off.click("Run the test")
  expect(off.text("#setup .banner.unk")).toContain("“Require the network test” is off in Settings")
})

test("the page is light only", async () => {
  const html = await readFile(join(import.meta.dir, "..", "..", "ui", "index.html"), "utf8")
  expect(html).not.toContain("prefers-color-scheme")
  expect(html).toContain('<meta name="color-scheme" content="light">')
  expect(html).toContain("prefers-reduced-motion")
})

test("the Folders page picks a folder from quick picks or the browser, previews what is left out, and runs the copy", async () => {
  const declared = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "extensions", "folders", "extension.json"), "utf8"))
  const folders = { ...declared, id: "folders", bundled: true, dir: "/x", actions: declared.actions.map((action: object) => ({ ...action, run: ["asd", "extension-run", "folders"] })) }
  const tree: Record<string, { parent?: string; folders: string[] }> = { "~": { folders: ["projects", ".agents", ".claude"] }, "~/projects": { parent: "~", folders: ["hq"] }, "~/projects/hq": { parent: "~/projects", folders: [] }, "~/.claude": { parent: "~", folders: ["skills"] } }
  const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [folders], errors: ["Extension skills: Skills and plugins is no longer bundled: Folders copies any folder in, such as ~/.agents. Remove it with `asd ext remove skills`, and install Folders with `asd ext install folders`."] }),
    folderBrowse: (body) => ({ path: body.path ?? "~", ...tree[body.path ?? "~"], picks: [{ path: "~/.agents", label: "Shared skills (.agents)" }, { path: "~/.claude", label: "Claude Code" }] }),
    folderPreview: (body) => ({ source: body.source, mirror: body.source, files: 1200, links: 3, folders: 40, bytes: 620_000_000, partial: false, largest: [],
      excluded: body.logins ? [{ path: "history.jsonl", reason: "history or cache" }] : [{ path: ".credentials.json", reason: "login file" }, { path: "history.jsonl", reason: "history or cache" }], excludedCount: body.logins ? 1 : 2,
      skipped: [{ path: "skills/shared", reason: "points outside the folder" }], skippedCount: 1, warnings: ["This is a large copy; it can take a while and uses the sandbox's disk. Most of it is in node_modules."] }),
    action: () => ({ exitCode: 0, stdout: "Copied ~/.claude to ~/.claude in demo: 1200 files, 3 links, 591.3 MiB.", stderr: "" }),
    exec: () => ({ exitCode: 0, stdout: "agent\t/home/agent/", stderr: "" }) }, "http://127.0.0.1:7717/extensions/folders#token=secret")
  const doc = ui.doc as any
  await ui.settle()
  expect(ui.text("#extensions")).toContain("Skills and plugins is no longer bundled")
  const card = doc.querySelector(".act-card[data-action=copy]")
  expect(card.textContent).toContain("It also copies into public sandboxes on other machines; the folder always comes from this Mac.")
  // Quick picks: the existing agent folders, by plain name, the path on hover.
  const picks = [...card.querySelectorAll(".folder-picker label.pill")]
  expect(picks.map((pill: any) => [pill.textContent, pill.title])).toEqual([["Shared skills (.agents)", "~/.agents"], ["Claude Code", "~/.claude"]])
  const input = card.querySelector('input[name="source"]')
  const choose = async (pill: any) => { const radio = pill.querySelector("input"); radio.checked = true; radio.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await Bun.sleep(400); await ui.settle() }
  await choose(picks[1])
  expect(input.value).toBe("~/.claude")
  expect(ui.calls.filter((call) => call.method === "folderPreview").at(-1)!.body).toEqual({ source: "~/.claude", logins: false })
  const view = () => (doc.querySelector(".act-card[data-action=copy] .folder-preview").textContent ?? "").replace(/\s+/g, " ")
  // Where it goes is shown in the picked sandbox's own home, as its user: asked of the sandbox, since the image decides them.
  expect(ui.calls.find((call) => call.method === "exec")!.body).toEqual({ name: "demo", argv: ["sh", "-c", 'printf "%s\\t%s" "$(id -un 2>/dev/null || id -u)" "$HOME"'] })
  expect(view()).toContain("1,200 files, 3 links · 591 MB · goes to /home/agent/.claude in the sandbox, as its user agent, unless you give another place")
  expect(view()).toContain("This is a large copy")
  expect(view()).toContain("Left out: 2.credentials.json · login filehistory.jsonl · history or cache")
  expect(view()).toContain("Skipped: 1skills/shared · points outside the folder")
  expect(ui.text(".act-card[data-action=copy] .same")).toContain("asd ext run folders copy demo --set 'source=~/.claude'")
  // Login files: off by default; ticked, it warns plainly and reads the folder again with them.
  const logins = card.querySelector('input[name="logins"]')
  expect(logins.checked).toBe(false)
  expect(view()).not.toContain("Login files will be copied")
  logins.checked = true; logins.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await ui.settle()
  expect(view()).toContain("Login files will be copied. Anything in the sandbox can read them and send them out. The Agent logins extension is the safer way to sign agents in.")
  expect(ui.calls.filter((call) => call.method === "folderPreview").at(-1)!.body).toEqual({ source: "~/.claude", logins: true })
  expect(view()).toContain("Left out: 1")
  logins.checked = false; logins.dispatchEvent(new ui.window.Event("change", { bubbles: true })); await ui.settle()
  // The browser lists folder names under the home; Up goes back, and the home itself cannot be used.
  const button = (label: string) => [...doc.querySelectorAll(".act-card[data-action=copy] button")].find((node: any) => node.textContent === label) as any
  button("Browse…").click(); await ui.settle()
  expect(ui.calls.filter((call) => call.method === "folderBrowse").at(-1)!.body).toEqual({ path: "~/.claude" })
  button("Close the browser").click(); await ui.settle()
  input.value = ""; input.dispatchEvent(new ui.window.Event("input", { bubbles: true })); await ui.settle()
  button("Browse…").click(); await ui.settle()
  expect(button("Use this folder").disabled).toBe(true)
  expect([...doc.querySelectorAll(".act-card[data-action=copy] .folders button")].map((node: any) => node.textContent)).toEqual(["projects/", ".agents/", ".claude/"])
  button("projects/").click(); await ui.settle()
  button("hq/").click(); await ui.settle()
  expect(ui.text(".act-card[data-action=copy] .folder-browser")).toContain("~/projects/hqUpUse this folderNo folders in it.")
  button("Up").click(); await ui.settle()
  button("hq/").click(); await ui.settle()
  button("Use this folder").click(); await Bun.sleep(400); await ui.settle()
  expect(input.value).toBe("~/projects/hq")
  expect(doc.querySelector(".act-card[data-action=copy] .folder-browser").textContent).toBe("")
  card.querySelector('input[name="dest"]').value = "~/hq"; card.querySelector('input[name="dest"]').dispatchEvent(new ui.window.Event("input", { bubbles: true })); await ui.settle()
  expect(view()).toContain("goes to /home/agent/hq in the sandbox, as its user agent")
  expect(view()).not.toContain("unless you give another place")
  expect(ui.text(".act-card[data-action=copy] .same")).toContain("asd ext run folders copy demo --set 'source=~/projects/hq' --set 'dest=~/hq'")
  await ui.submit(card.querySelector("form"))
  expect(ui.calls.find((call) => call.method === "action")!.body).toEqual({ extension: "folders", action: "copy", sandbox: "demo", values: { source: "~/projects/hq", dest: "~/hq", logins: "false", replace: "false" } })
})

test("on a Mac, the folder can be picked in Finder's own window; cancelling keeps it, and only a Mac shows the button", async () => {
  const declared = JSON.parse(await readFile(join(import.meta.dir, "..", "..", "extensions", "folders", "extension.json"), "utf8"))
  const folders = { ...declared, id: "folders", bundled: true, dir: "/x", actions: declared.actions.map((action: object) => ({ ...action, run: ["asd", "extension-run", "folders"] })) }
  const replies: Array<() => unknown> = [() => ({}), () => ({ path: "~/projects/hq" }), () => { throw Object.assign(new Error("~/x is outside your home folder."), { code: "usage" }) }]
  const preview = (body: any) => ({ source: body.source, mirror: body.source, files: 1, links: 0, folders: 1, bytes: 10, partial: false, largest: [], excluded: [], excludedCount: 0, skipped: [], skippedCount: 0, warnings: [] })
  const open = async (finder: boolean) => {
    const ui = await page({ ...base, list: () => [sandbox()], extensions: () => ({ extensions: [folders], errors: [] }), exec: () => ({ exitCode: 0, stdout: "agent\t/home/agent", stderr: "" }),
      folderBrowse: () => ({ path: "~", folders: [], picks: [], ...(finder ? { finder: true } : {}) }), folderPreview: preview, folderChoose: () => replies.shift()!() }, "http://127.0.0.1:7717/extensions/folders#token=secret")
    await ui.settle()
    return ui
  }
  const ui = await open(true), doc = ui.doc as any
  const button = (label: string) => [...doc.querySelectorAll(".act-card[data-action=copy] button")].find((node: any) => node.textContent === label) as any
  const input = doc.querySelector('.act-card[data-action=copy] input[name="source"]')
  button("Choose in Finder…").click(); await ui.settle()
  expect(input.value).toBe("")
  button("Choose in Finder…").click(); await Bun.sleep(400); await ui.settle()
  expect(input.value).toBe("~/projects/hq")
  expect(ui.calls.filter((call) => call.method === "folderPreview").at(-1)!.body).toEqual({ source: "~/projects/hq", logins: false })
  button("Choose in Finder…").click(); await ui.settle()
  expect(input.value).toBe("~/projects/hq")
  expect(ui.text(".act-card[data-action=copy] .folder-picker")).toContain("~/x is outside your home folder.")
  expect(ui.calls.filter((call) => call.method === "folderChoose").length).toBe(3)
  const elsewhere = await open(false)
  expect([...(elsewhere.doc as any).querySelectorAll(".act-card[data-action=copy] button")].map((node: any) => node.textContent)).not.toContain("Choose in Finder…")
})

test("a link to a public sandbox on another machine is added from the Ports form's sandbox choice, and listed with its machine on both ends", async () => {
  const link = { from: "demo", to: "soak", toHost: "home-linux", port: 5432, address: "127.77.0.2", state: "open", connections: 0, trust: "soak on home-linux sees these connections as local" }
  const ui = await page({ ...base, ...fleetReplies, list: () => [sandbox()], fleet: fleetOf([sandbox({ name: "soak" })]), linkList: () => [link],
    linkAdd: (body) => ({ ...link, ...body, trust: "trusted" }) })
  await ui.open("demo")
  expect(ui.text("#sandbox-page")).toContain("1 connection with other sandboxes (some on other machines)")
  await ui.pick("Ports")
  expect(ui.text("#modal")).toContain("demo → soak:5432 on home-linux · open")
  expect(ui.text("#modal")).toContain("soak on home-linux")
  await ui.submit(ui.button("Connect").closest("form"), { to: "soak@home-linux", port: "5432" })
  expect(ui.text("#modal")).toContain("Connected: programs in demo reach soak:5432 on home-linux at 127.77.0.2. trusted")
  expect(ui.calls.filter((call) => call.method === "linkAdd").map((call) => call.body)).toEqual([{ from: "demo", to: "soak", port: "5432", toHost: "home-linux" }])
  await ui.open("home-linux/soak")
  expect(ui.text("#sandbox-page")).toContain("1 connection with other sandboxes")
  await ui.pick("Ports")
  expect(ui.text("#modal")).toContain("demo → soak:5432 on home-linux · open")
  expect(ui.text("#modal")).toContain("Connections start from a sandbox on this Mac")
})
