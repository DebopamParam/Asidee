import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvalText, dialogApprover, literal, word, type Answer, type Approval, type Approver } from "../../core/approval"
import { createHandler } from "../../core/daemon"
import { AsideeError } from "../../core/types"

const TOKEN = "t".repeat(48)
async function handler() {
  const config = await mkdtemp(join(tmpdir(), "asidee-daemon-"))
  const table = {
    list: { run: async () => ["demo"] },
    echo: { run: async (body: Record<string, unknown>) => body },
    shutdown: { run: async () => ({ stopping: true }), socketOnly: true },
    missing: { run: async () => { throw new AsideeError("not-found", "There is no sandbox named x.") } },
  }
  return { config, handle: createHandler(table, TOKEN, config) }
}
const post = (method: string, headers: Record<string, string> = {}, body = "{}") =>
  new Request(`http://127.0.0.1:7717/api/${method}`, { method: "POST", headers: { host: "127.0.0.1:7717", ...headers }, body })
const auth = { authorization: `Bearer ${TOKEN}` }

test("malformed dashboard URLs return a generic client error", async () => {
  const { handle } = await handler()
  for (const path of ["/%", "/%E0%A4", "/%00", "/?token=%FF", "/api/list?x=%"]) {
    const response = await handle(new Request(`http://127.0.0.1:7717${path}`, { headers: { host: "127.0.0.1:7717" } }), false, 7717)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ ok: false, error: { code: "usage", message: "Malformed request URL." } })
  }
  const request = post("list")
  Object.defineProperty(request, "url", { value: "http://[invalid" })
  expect((await handle(request, true, 0)).status).toBe(400)
})

test("the loopback port needs the token and this server's Host; the socket needs neither", async () => {
  const { handle } = await handler()
  expect((await handle(post("list"), false, 7717)).status).toBe(401)
  expect((await handle(post("list", { authorization: "Bearer wrong" }), false, 7717)).status).toBe(401)
  expect((await handle(post("list", { ...auth, host: "evil.example:7717" }), false, 7717)).status).toBe(403)
  expect(await (await handle(post("list", auth), false, 7717)).json()).toEqual({ ok: true, data: ["demo"] })
  expect((await handle(post("list", { host: "anything" }), true, 0)).status).toBe(200)
})

test("methods for the CLI only are refused on the loopback port", async () => {
  const { handle } = await handler()
  expect((await handle(post("shutdown", auth), false, 7717)).status).toBe(403)
  expect((await handle(post("shutdown"), true, 0)).status).toBe(200)
})

test("unknown methods, inherited names and bad bodies are refused cleanly", async () => {
  const { handle } = await handler()
  for (const name of ["nope", "constructor", "__proto__", "toString"]) expect((await handle(post(name), true, 0)).status).toBe(404)
  expect((await handle(post("echo", {}, "[1]"), true, 0)).status).toBe(400)
  expect((await handle(post("echo", {}, "{"), true, 0)).status).toBe(400)
  expect(await (await handle(post("missing"), true, 0)).json()).toMatchObject({ ok: false, error: { code: "not-found" } })
  expect((await handle(new Request("http://127.0.0.1:7717/api/list", { headers: { host: "127.0.0.1:7717", ...auth } }), false, 7717)).status).toBe(404)
})

test("the dashboard is served without a token, a custom one replaces it, and paths stay inside its folder", async () => {
  const { handle, config } = await handler()
  const get = (path: string) => handle(new Request(`http://127.0.0.1:7717${path}`, { headers: { host: "127.0.0.1:7717" } }), false, 7717)
  expect(await (await get("/")).text()).toContain("<title>Asidee</title>")
  await writeFile(join(config, "secret.txt"), "outside the ui folder")
  expect((await get("/../secret.txt")).status).toBe(404)
  expect((await get("/..%2Fsecret.txt")).status).toBe(404)
  await mkdir(join(config, "ui")); await writeFile(join(config, "ui", "index.html"), "<p>mine</p>"); await writeFile(join(config, "ui", "app.js"), "1")
  expect(await (await get("/")).text()).toBe("<p>mine</p>")
  expect(await (await get("/app.js")).text()).toBe("1")
  expect((await get("/..%2Fsecret.txt")).status).toBe(404)
})

test("each place in the dashboard serves its page; other paths, the API and the custom folder are unchanged", async () => {
  const { handle, config } = await handler()
  const get = (path: string) => handle(new Request(`http://127.0.0.1:7717${path}`, { headers: { host: "127.0.0.1:7717" } }), false, 7717)
  const root = await (await get("/")).text()
  for (const path of ["/sandboxes", "/sandboxes/my-app", "/sandboxes/a%20b", "/workspaces", "/templates", "/extensions", "/extensions/logins", "/machines", "/settings", "/setup", "/setup/engine", "/setup/open"]) {
    const response = await get(path)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(await response.text()).toBe(root)
  }
  for (const path of ["/nope", "/sandboxes/a/b", "/settings/x", "/setup/nope", "/sandboxes/", "/index.html", "/api"]) expect((await get(path)).status).toBe(404)
  // An encoded name is one segment: it gets the page, which says the sandbox is not here, never a file.
  expect(await (await get("/sandboxes/..%2F..%2Fsecret.txt")).text()).toBe(root)
  // The API is not a page: a GET to it is still refused, and a call still answers as before.
  expect((await get("/api/list")).status).toBe(404)
  expect(await (await handle(post("list", auth), false, 7717)).json()).toEqual({ ok: true, data: ["demo"] })
  expect((await handle(new Request("http://asidee/sandboxes", { method: "GET" }), true, 0)).status).toBe(404)
  // With a custom page, a place serves that page, never a file outside its folder.
  await writeFile(join(config, "secret.txt"), "outside the ui folder")
  await mkdir(join(config, "ui")); await writeFile(join(config, "ui", "index.html"), "<p>mine</p>")
  expect(await (await get("/sandboxes/my-app")).text()).toBe("<p>mine</p>")
  for (const path of ["/sandboxes/..%2F..%2Fsecret.txt", "/extensions/..%2Fsecret.txt", "/sandboxes/%2E%2E"]) expect(await (await get(path)).text()).not.toContain("outside the ui folder")
})

// The approval gate, with a fake approver standing in for the dialog on the Mac.
async function gated(answers: Array<Answer | Promise<Answer> | Error>) {
  const config = await mkdtemp(join(tmpdir(), "asidee-approve-"))
  const asked: Approval[] = []; const ran: Array<Record<string, unknown>> = []
  const table = {
    sensitive: { run: async (body: Record<string, unknown>) => { ran.push(body); return { done: true } }, approve: (body: Record<string, unknown>) => {
      if (body.bad) throw new AsideeError("usage", "Refused before asking.")
      return body.harmless ? undefined : { action: `Do ${literal(String(body.what))} on this Mac.`, cli: `asd do ${String(body.what)}`, ...(body.long ? { details: ["x".repeat(4000)] } : {}) }
    } },
    hello: { run: async () => ({ hello: true }), socketOnly: true },
  }
  const approver: Approver = async (approval) => { asked.push(approval); const next = answers.shift() ?? "deny"; if (next instanceof Error) throw next; return next }
  return { asked, ran, handle: createHandler(table, TOKEN, config, undefined, approver) }
}
const ask = (body: object) => post("sensitive", auth, JSON.stringify(body))
const reply = async (response: Response): Promise<Record<string, any>> => ({ status: response.status, ...await response.json() as Record<string, any> })

test("an approvable request on the loopback port runs only when the person at the Mac allows it", async () => {
  const { asked, ran, handle } = await gated(["allow"])
  expect(await reply(await handle(ask({ what: "it" }), false, 7717))).toEqual({ status: 200, ok: true, data: { done: true } })
  expect(asked).toEqual([{ action: 'Do "it" on this Mac.', cli: "asd do it" }])
  expect(ran).toEqual([{ what: "it" }])
})

test("denied, timed out and unavailable are distinct refusals that run nothing and carry the CLI command", async () => {
  const { ran, handle } = await gated(["deny", "timeout", "unavailable", new Error("osascript vanished")])
  const results = []
  for (let i = 0; i < 4; i++) results.push(await reply(await handle(ask({ what: "it" }), false, 7717)))
  expect(results.map((result) => [result.status, result.error.details])).toEqual([
    [403, { approval: "denied", command: "asd do it" }], [403, { approval: "timed-out", command: "asd do it" }],
    [403, { approval: "unavailable", command: "asd do it" }], [403, { approval: "unavailable", command: "asd do it" }]])
  expect(results[0]!.error.message).toStartWith("Denied on this Mac.")
  expect(results[1]!.error.message).toContain("within 60 seconds")
  expect(results[2]!.error.message).toContain("only the CLI can do this")
  expect(ran).toEqual([])
})

test("only one approval waits at a time; others are refused at once", async () => {
  let answer!: (value: Answer) => void
  const { asked, ran, handle } = await gated([new Promise<Answer>((resolve) => { answer = resolve }), "allow"])
  const first = handle(ask({ what: "first" }), false, 7717)
  await Bun.sleep(5)
  const second = await reply(await handle(ask({ what: "second" }), false, 7717))
  expect([second.status, second.error.code, second.error.details.approval]).toEqual([409, "conflict", "busy"])
  answer("allow")
  expect((await first).status).toBe(200)
  expect((await handle(ask({ what: "third" }), false, 7717)).status).toBe(200)
  expect(asked.map((approval) => approval.cli)).toEqual(["asd do first", "asd do third"])
  expect(ran.map((body) => body.what)).toEqual(["first", "third"])
})

test("the socket never asks; requests that need no approval, or would be refused, or are too long, are not asked", async () => {
  const { asked, ran, handle } = await gated([])
  expect((await handle(post("sensitive", {}, JSON.stringify({ what: "cli" })), true, 0)).status).toBe(200)
  expect((await handle(ask({ harmless: true }), false, 7717)).status).toBe(200)
  expect(await reply(await handle(ask({ bad: true }), false, 7717))).toMatchObject({ status: 400, error: { message: "Refused before asking." } })
  expect(await reply(await handle(ask({ what: "it", long: true }), false, 7717))).toMatchObject({ status: 400, error: { message: expect.stringContaining("Run it from the CLI: asd do it") } })
  expect((await handle(ask({ what: "it" }), false, 7717)).status).toBe(403)
  expect(asked.length).toBe(1)
  expect(ran.map((body) => body.what ?? "harmless")).toEqual(["cli", "harmless"])
})

test("socket-only methods are refused on the loopback port without asking", async () => {
  const { asked, handle } = await gated(["allow"])
  expect(await reply(await handle(post("hello", auth), false, 7717))).toMatchObject({ status: 403, error: { message: "This method is only available to the CLI." } })
  expect((await handle(post("sensitive", { authorization: "Bearer wrong" }, "{}"), false, 7717)).status).toBe(401)
  expect(asked).toEqual([])
})

test("the dialog gets its text only as arguments, Deny by default, and maps every outcome", async () => {
  const runs: string[][] = []
  const approver = (stdout: string, exitCode = 0, platform = "darwin") => dialogApprover(async (argv) => { runs.push([...argv]); return { exitCode, stdout, stderr: "" } }, 60, platform)
  const approval = { action: `Set "x" to ${literal('a"b\nend tell‮')}`, cli: "asd x" }
  expect(await approver("Allow\n")(approval)).toBe("allow")
  const argv = runs[0]!
  expect(argv[0]).toBe("/usr/bin/osascript")
  const source = argv.filter((_, index) => argv[index - 1] === "-e")
  expect(source.join("\n")).toContain('default button "Deny"')
  expect(source.join("\n")).toContain("giving up after ((item 3 of argv) as integer)")
  expect(source.join("\n")).not.toContain("end tell")
  expect(argv.slice(-3)).toEqual(["Asidee: allow this?", approvalText(approval), "60"])
  expect(argv.at(-2)).toContain('"a\\"b\\nend tell\\u202e"')
  expect(await approver("Deny")(approval)).toBe("deny")
  expect(await approver("timeout")(approval)).toBe("timeout")
  expect(await approver("", 124)(approval)).toBe("timeout")
  expect(await approver("", 1)(approval)).toBe("unavailable")
  runs.length = 0
  expect(await approver("Allow", 0, "linux")(approval)).toBe("unavailable")
  expect(runs).toEqual([])
})

test("request text is shown literally, and CLI words are quoted only when needed", () => {
  expect(literal("kitty sh -c {command}")).toBe('"kitty sh -c {command}"')
  expect(literal("a\nb​c⁦d\u{e0041}")).toBe('"a\\nb\\u200bc\\u2066d\\u{e0041}"')
  expect(word("/opt/asd")).toBe("/opt/asd")
  expect(word("it's here")).toBe(`'it'\\''s here'`)
})
