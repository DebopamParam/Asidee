import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GVISOR_RELEASE } from "../../core/hosts"
import { systemRunner } from "../../core/run"
import { applySetup, gvisorRoot, orbstackInstalled, planSetup, setupChanges, setupPlanLines, withoutRuntime, type SetupContext } from "../../core/setup"
import type { Engine, RunResult } from "../../core/types"

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" })
const sha = (algorithm: string, data: string | Uint8Array) => createHash(algorithm).update(data).digest("hex")

// A fake OrbStack: docker answers from these values, orb restart is recorded, and tar is the real one.
function fakeEngine(home: string, engine: { runtimes?: Record<string, unknown>; running?: string[]; containers?: Record<string, string>; answers?: boolean } = {}) {
  const ran: string[][] = []
  const run: SetupContext["run"] = async (argv, options) => {
    ran.push([...argv])
    if (argv[0] === "/usr/bin/tar") return systemRunner(argv, options)
    if (argv[0] === "orb") return ok()
    const words = argv.slice(3)
    if (words[0] === "info") return engine.answers === false ? { exitCode: 1, stdout: "", stderr: "Cannot connect" } : ok(JSON.stringify({ Architecture: "aarch64", Runtimes: { runc: { path: "runc" }, ...engine.runtimes } }))
    if (words[0] === "ps" && words[1] === "--format") return ok((engine.running ?? []).join("\n"))
    if (words[0] === "ps") return ok(Object.keys(engine.containers ?? {}).join("\n"))
    if (words[0] === "inspect") return ok(words.slice(3).map((id) => `/${id} ${engine.containers![id]}`).join("\n"))
    throw new Error(`unexpected ${argv.join(" ")}`)
  }
  return { context: { home, run, applications: [join(home, "Applications")] } satisfies SetupContext, ran }
}

async function home(config?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "asidee-setup-"))
  if (config !== undefined) { await mkdir(join(root, ".orbstack", "config"), { recursive: true }); await writeFile(join(root, ".orbstack", "config", "docker.json"), config, { mode: 0o600 }) }
  return root
}

// A gVisor-shaped archive made here, so applying runs the real unpacking and checks without the network.
async function archive(extra = false) {
  const source = await mkdtemp(join(tmpdir(), "asidee-gvisor-"))
  await mkdir(join(source, "gvisor-bin"))
  await writeFile(join(source, "runsc"), "runsc binary"); await writeFile(join(source, "gvisor-bin", "sentry"), "sentry binary")
  const names = ["runsc", "gvisor-bin/sentry"]
  if (extra) { await writeFile(join(source, "extra"), "x"); names.push("extra") }
  const path = join(source, "gvisor.tar.bz2")
  expect((await systemRunner(["/usr/bin/tar", "-cjf", path, "-C", source, ...names])).exitCode).toBe(0)
  const bytes = new Uint8Array(await readFile(path))
  return { bytes, sha512: sha("sha512", bytes), files: { runsc: sha("sha256", "runsc binary"), "gvisor-bin/sentry": sha("sha256", "sentry binary") } }
}

test("a fresh OrbStack gets one plan: the pinned download, Asidee's runtime added with nothing else changed, and a restart that names what stops", async () => {
  const root = await home(`{\n    "features": { "buildkit": true }\n}\n`)
  const { context } = fakeEngine(root, { running: ["web", "db"] })
  const plan = await planSetup(context, { docker: false, remove: false })
  const folder = join(gvisorRoot(root), GVISOR_RELEASE)
  expect(plan.download).toMatchObject({ url: `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/aarch64/gvisor.tar.bz2`, folder })
  expect(JSON.parse(plan.config!.after)).toEqual({ features: { buildkit: true }, runtimes: { "asidee-runsc": { path: join(folder, "runsc"), runtimeArgs: ["--allow-suid", "--overlay2=none"] } } })
  expect(plan.config!.after.startsWith(`{\n    "features"`)).toBe(true)
  expect(plan.restart).toEqual({ argv: ["orb", "restart", "docker"], stops: ["web", "db"] })
  expect(plan.check).toBe(true)
  expect((await planSetup(context, { docker: false, remove: false })).hash).toBe(plan.hash)
  const docker = await planSetup(context, { docker: true, remove: false })
  expect(JSON.parse(docker.config!.after).runtimes["asidee-runsc"].runtimeArgs).toContain("--net-raw")
  expect(docker.hash).not.toBe(plan.hash)
  const text = setupPlanLines(plan, root).join("\n")
  expect(text).toContain(`~/.local/share/asidee/gvisor/${GVISOR_RELEASE}`)
  expect(text).toContain("These running containers stop: web, db.")
  expect(text).toContain(`Plan hash: ${plan.hash}`)
})

test("an engine the daemon already finds ready changes nothing and only gets the test sandbox; Docker inside still needs a runtime with it", async () => {
  const root = await home("{}\n")
  const { context } = fakeEngine(root)
  const engine = { id: "gvisor:orbstack", provider: "gvisor", label: "OrbStack 29", ready: true, problems: [], data: { context: "orbstack" }, capabilities: { docker: false } } as unknown as Engine
  const ready = await planSetup(context, { docker: false, remove: false, engine })
  expect(setupChanges(ready)).toBe(false)
  expect(ready.check).toBe(true)
  expect(setupPlanLines(ready, root).join("\n")).toContain("Create a test sandbox")
  expect(setupChanges(await planSetup(context, { docker: true, remove: false, engine }))).toBe(true)
})

test("setup refuses an engine that does not answer and a configuration it cannot edit, changing nothing", async () => {
  await expect(planSetup(fakeEngine(await home(), { answers: false }).context, { docker: false, remove: false })).rejects.toThrow("does not answer")
  const root = await home("not json")
  await expect(planSetup(fakeEngine(root).context, { docker: false, remove: false })).rejects.toThrow("not a JSON object")
  expect(await readFile(join(root, ".orbstack", "config", "docker.json"), "utf8")).toBe("not json")
})

test("applying unpacks only the checked files, writes the planned configuration, restarts, and leaves no staging behind", async () => {
  const root = await home("{}\n")
  const { context, ran } = fakeEngine(root)
  const made = await archive()
  const plan = await planSetup(context, { docker: false, remove: false })
  plan.download = { ...plan.download!, sha512: made.sha512, files: made.files }
  await applySetup({ ...context, download: async () => made.bytes }, plan)
  const folder = join(gvisorRoot(root), GVISOR_RELEASE)
  expect((await stat(join(folder, "runsc"))).mode & 0o777).toBe(0o755)
  expect(await readFile(join(folder, "gvisor-bin", "sentry"), "utf8")).toBe("sentry binary")
  expect(await readdir(gvisorRoot(root))).toEqual([GVISOR_RELEASE])
  const config = join(root, ".orbstack", "config", "docker.json")
  expect(await readFile(config, "utf8")).toBe(plan.config!.after)
  expect((await stat(config)).mode & 0o777).toBe(0o600)
  expect(ran).toContainEqual(["orb", "restart", "docker"])
})

test("applying stops before the engine changes when the archive or the configuration is not what was planned", async () => {
  const made = await archive()
  for (const [bytes, files, message] of [[made.bytes.slice(1), made.files, "sha512"], [(await archive(true)).bytes, made.files, "unexpected entries"]] as const) {
    const root = await home("{}\n")
    const { context, ran } = fakeEngine(root)
    const plan = await planSetup(context, { docker: false, remove: false })
    plan.download = { ...plan.download!, sha512: sha("sha512", bytes), files }
    if (message === "sha512") plan.download.sha512 = made.sha512
    await expect(applySetup({ ...context, download: async () => bytes }, plan)).rejects.toThrow(message)
    expect(await readdir(gvisorRoot(root)).catch(() => [])).toEqual([])
    expect(await readFile(join(root, ".orbstack", "config", "docker.json"), "utf8")).toBe("{}\n")
    expect(ran.some((argv) => argv[0] === "orb")).toBe(false)
  }
  const root = await home("{}\n")
  const { context, ran } = fakeEngine(root)
  const plan = await planSetup(context, { docker: false, remove: false })
  delete plan.download
  await writeFile(join(root, ".orbstack", "config", "docker.json"), `{"changed": true}\n`)
  await expect(applySetup(context, plan)).rejects.toThrow("changed since the plan")
  expect(await readFile(join(root, ".orbstack", "config", "docker.json"), "utf8")).toBe(`{"changed": true}\n`)
  expect(ran.some((argv) => argv[0] === "orb")).toBe(false)
})

test("undoing removes only Asidee's runtime, and refuses while a container still runs on it", async () => {
  expect(JSON.parse(withoutRuntime(`{"runtimes": {"asidee-runsc": {"path": "/x"}, "runsc": {"path": "/y"}}, "debug": true}`))).toEqual({ runtimes: { runsc: { path: "/y" } }, debug: true })
  expect(JSON.parse(withoutRuntime(`{"runtimes": {"asidee-runsc": {"path": "/x"}}, "debug": true}`))).toEqual({ debug: true })
  const config = `{\n  "debug": true,\n  "runtimes": {\n    "asidee-runsc": { "path": "/x" }\n  }\n}\n`
  const root = await home(config)
  await mkdir(join(gvisorRoot(root), GVISOR_RELEASE), { recursive: true })
  const runtimes = { "asidee-runsc": { path: "/x" } }
  const blocked = await planSetup(fakeEngine(root, { runtimes, containers: { box: "asidee-runsc", web: "runc" } }).context, { docker: false, remove: true })
  expect(blocked.blockers.join(" ")).toContain("box")
  expect(blocked.blockers.join(" ")).not.toContain("web")
  await expect(applySetup(fakeEngine(root).context, blocked)).rejects.toThrow("Nothing was changed")
  expect(await readFile(join(root, ".orbstack", "config", "docker.json"), "utf8")).toBe(config)
  const { context, ran } = fakeEngine(root, { runtimes, containers: { web: "runc" } })
  const plan = await planSetup(context, { docker: false, remove: true })
  expect(plan.blockers).toEqual([])
  expect(plan.removeFolder).toBe(gvisorRoot(root))
  await applySetup(context, plan)
  expect(JSON.parse(await readFile(join(root, ".orbstack", "config", "docker.json"), "utf8"))).toEqual({ debug: true })
  expect(ran).toContainEqual(["orb", "restart", "docker"])
  await expect(stat(gvisorRoot(root))).rejects.toThrow()
  expect(setupChanges(await planSetup(fakeEngine(root).context, { docker: false, remove: true }))).toBe(false)
})

test("a configuration laid out differently is not rewritten, and the engine not restarted, when Asidee's entry is absent or already right", async () => {
  const other = `{"runtimes":{"runsc-other":{"path":"/y/runsc","runtimeArgs":["--overlay2=none"]}}}`
  const root = await home(other)
  const { context, ran } = fakeEngine(root, { runtimes: { "runsc-other": { path: "/y/runsc" } } })
  const remove = await planSetup(context, { docker: false, remove: true })
  expect(setupChanges(remove)).toBe(false)
  expect(ran.some((argv) => argv.includes("inspect"))).toBe(false)
  const path = join(gvisorRoot(root), GVISOR_RELEASE, "runsc")
  await writeFile(join(root, ".orbstack", "config", "docker.json"), `{"runtimes":{"asidee-runsc":{"path":${JSON.stringify(path)},"runtimeArgs":["--allow-suid","--overlay2=none"]}}}`)
  const unregistered = await planSetup(context, { docker: false, remove: false })
  expect(unregistered.config).toBeUndefined()
  expect(unregistered.restart).toBeDefined()
  const registered = await planSetup(fakeEngine(root, { runtimes: { "asidee-runsc": { path, runtimeArgs: ["--allow-suid", "--overlay2=none"] } } }).context, { docker: false, remove: false })
  expect(registered.config).toBeUndefined()
  expect(registered.restart).toBeUndefined()
})

test("OrbStack is found by its application, and no other application counts", async () => {
  const root = await home()
  expect(await orbstackInstalled(fakeEngine(root).context)).toBe(false)
  await mkdir(join(root, "Applications", "Docker.app"), { recursive: true })
  expect(await orbstackInstalled(fakeEngine(root).context)).toBe(false)
  await mkdir(join(root, "Applications", "OrbStack.app"), { recursive: true })
  expect(await orbstackInstalled(fakeEngine(root).context)).toBe(true)
})
