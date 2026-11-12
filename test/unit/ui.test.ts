import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Window } from "happy-dom"
import { CHECKLIST } from "../../core/checks"

// Runs the dashboard's own script against a DOM, with the daemon's API replaced by canned replies. It checks what the
// page does, not how it looks.
const check = (id: string, status: string, detail: string) => ({ id, status, evidence: "probed", detail })
const sandbox = (over: object = {}) => ({
  name: "demo", status: "running", engine: "Fake engine", createdAt: "", spec: { name: "demo", image: "x", cpus: 2, memoryGb: 4, pids: 4096, diskGb: 20 },
  lastVerify: { at: "2026-11-10T10:00:00Z", results: [check("kernel", "pass", "gVisor answers."), check("net-host", "fail", "A connection reached the host."), check("disk", "weak", "Watched, not capped.")] },
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
    catch (error) { return { json: async () => ({ ok: false, error: { message: (error as Error).message } }) } }
  }
  const prompts: string[] = []
  const globals = { window, document: window.document, location: window.location, history: window.history, sessionStorage: window.sessionStorage, fetch,
    setInterval: () => 0, prompt: (text: string) => { prompts.push(text); return "demo" }, FormData: window.FormData, URLSearchParams, Event: window.Event }
  new Function(...Object.keys(globals), script)(...Object.values(globals))
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)) }
  await settle()
  const text = (selector: string) => (window.document.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ")
  const button = (label: string) => [...window.document.querySelectorAll("button")].find((node) => node.textContent === label)!
  return { window, calls, prompts, settle, text, button }
}

const base = { checklist: () => CHECKLIST, engines: () => [{ id: "fake:1", label: "Fake engine", ready: true, problems: [], capabilities: { kernelIsolation: "gvisor", networkGuard: true, diskLimit: "watched" } }], extensions: () => ({ extensions: [extension], errors: [] }) }

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

test("past checks disclose the time even when collapsed and never show historical passes as current", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  expect(ui.text("#sandboxes")).toContain("Last measured 2026-11-10T10:00:00Z. Historical only; current checks unknown.")
  ui.button("Past checks").click(); await ui.settle()
  const checks = ui.text("ul.checks")
  expect(checks).toContain("?Cannot reach the host — current property unknownPrevious fail (probed). A connection reached the host.")
  expect(checks).toContain("Previous weak (probed). Watched, not capped.")
  expect(checks).toContain("Previous pass (probed). gVisor answers.")
  expect(checks).not.toContain("✓")
})

test("verify, stop and remove call the API; remove sends the typed name as the confirmation", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], verify: () => ({}), stop: () => ({}), remove: () => ({}) })
  ui.button("Verify").click(); await ui.settle()
  ui.button("Stop").click(); await ui.settle()
  ui.button("Remove").click(); await ui.settle()
  expect(ui.prompts[0]).toContain("deletes demo")
  const sent = ui.calls.filter((call) => ["verify", "stop", "remove"].includes(call.method)).map((call) => [call.method, call.body])
  expect(sent).toEqual([["verify", { name: "demo" }], ["stop", { name: "demo" }], ["remove", { name: "demo", confirm: "demo" }]])
})

test("an extension's action is drawn as a form from its declaration and sends its fields", async () => {
  const ui = await page({ ...base, list: () => [sandbox()], action: () => ({ exitCode: 0, stdout: "installed 1.2\n", stderr: "" }) })
  const form = ui.button("Install thing").closest("form") as any
  expect(form.elements.namedItem("version").value).toBe("latest")
  form.elements.namedItem("version").value = "1.2"
  form.dispatchEvent(new ui.window.Event("submit", { cancelable: true })); await ui.settle()
  expect(ui.calls.find((call) => call.method === "action")!.body).toEqual({ extension: "tools", action: "install", sandbox: "demo", values: { version: "1.2", force: "false" } })
  expect(ui.text("#sandboxes pre")).toBe("installed 1.2")
})

test("a stopped sandbox shows why it stopped, offers Start, and has no extension actions", async () => {
  const ui = await page({ ...base, list: () => [sandbox({ status: "stopped", stopReason: "Stopped by the disk watch: it used 2.1 GB of its 2 GB." })] })
  expect(ui.text("#sandboxes")).toContain("Stopped by the disk watch")
  expect(ui.button("Start")).toBeDefined()
  expect(ui.button("Install thing")).toBeUndefined()
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
  const ui = await page({ ...base, list: () => { throw new Error("Open the dashboard with the link from `paddock ui`.") } }, "http://127.0.0.1:7717/")
  expect(ui.text("#notice")).toContain("paddock ui")
})

test("a refresh that changes nothing leaves a half-filled form alone", async () => {
  const ui = await page({ ...base, list: () => [sandbox()] })
  const input = (ui.button("Install thing").closest("form") as any).elements.namedItem("version")
  input.value = "typing"
  // The page's own refresh, as its timer would call it.
  await (ui.window as any).paddockRefresh(); await ui.settle()
  expect(ui.window.document.contains(input)).toBe(true)
})
