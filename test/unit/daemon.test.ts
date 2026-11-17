import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
