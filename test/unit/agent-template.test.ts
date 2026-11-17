import { expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hostVersion, prepareSteps, prepareTemplate, validVersion, type Call } from "../../cli/prepare"
import { DEFAULT_SPEC, readConfig, validSpec, writeConfig } from "../../core/state"
import type { RunResult, Template } from "../../core/types"

test("a default template applies only when a create names neither an image nor a template", () => {
  expect(validSpec({ name: "a" }, { template: "agent" })).toMatchObject({ template: "agent", image: DEFAULT_SPEC.image })
  expect(validSpec({ name: "a", template: "" }, { template: "agent" }).template).toBe("agent")
  expect(validSpec({ name: "a", image: "ubuntu:24.04" }, { template: "agent" })).not.toHaveProperty("template")
  expect(validSpec({ name: "a", template: "other" }, { template: "agent" }).template).toBe("other")
  expect(validSpec({ name: "a" })).not.toHaveProperty("template")
  expect(() => validSpec({ name: "a", image: "ubuntu:24.04", template: "x" })).toThrow("not both")
  expect(() => validSpec({ name: "a" }, { template: "Bad Name" })).toThrow("template name")
})

test("the config keeps a default template, refuses one beside a default image, and refuses a bad name", async () => {
  const root = await mkdtemp(join(tmpdir(), "asidee-default-template-"))
  const dirs = { state: join(root, "state"), config: join(root, "config") }
  expect((await writeConfig(dirs, { defaults: { template: "agent", cpus: 4 } })).defaults).toEqual({ template: "agent", cpus: 4 })
  expect((await readConfig(dirs)).defaults.template).toBe("agent")
  await expect(writeConfig(dirs, { defaults: { template: "agent", image: "ubuntu:24.04" } })).rejects.toThrow("exclude each other")
  await expect(writeConfig(dirs, { defaults: { template: "../x" } })).rejects.toThrow("template name")
  await expect(writeConfig(dirs, { defaults: { other: 1 } })).rejects.toThrow("template")
  expect(JSON.parse(await readFile(join(dirs.config, "config.json"), "utf8")).defaults).toEqual({ template: "agent", cpus: 4 })
})

test("versions are checked, and this machine's version is read when the program is here", async () => {
  expect(validVersion("claude", "2.1.310")).toBe("2.1.310")
  expect(validVersion("codex", "latest")).toBe("latest")
  for (const bad of ["", "2.1", "1.0.0; rm -rf /", "--registry=x", "^2.0.0"]) expect(() => validVersion("codex", bad)).toThrow("--codex")
  const run = (stdout: string, exitCode = 0) => async () => ({ exitCode, stdout, stderr: "" }) satisfies RunResult
  expect(await hostVersion(run("2.1.310 (Claude Code)\n"), "claude")).toBe("2.1.310")
  expect(await hostVersion(run("codex-cli 0.164.0\n"), "codex")).toBe("0.164.0")
  expect(await hostVersion(run("", 127), "codex")).toBe("latest")
  expect(await hostVersion(run("no version here"), "codex")).toBe("latest")
})

test("versions and the script reach the sandbox as arguments and input, never as shell text", () => {
  const steps = prepareSteps({ name: "agent", versions: { claude: "2.1.0", codex: "latest" }, script: "echo hi", replace: false })
  const npm = steps.find((step) => step.label.startsWith("Installing Claude"))!
  expect(npm.argv.slice(-2)).toEqual(["@anthropic-ai/claude-code@2.1.0", "@openai/codex@latest"])
  expect(npm.argv[2]).not.toContain("2.1.0")
  expect(npm.user).toBeUndefined()
  expect(steps.find((step) => step.label === "Running your script")).toMatchObject({ argv: ["bash", "-s"], stdin: "echo hi" })
  expect(steps[0]!.user).toBe("root")
  expect(prepareSteps({ name: "agent", versions: { claude: "latest", codex: "latest" }, replace: false }).some((step) => step.stdin !== undefined)).toBe(false)
})

type Fake = { calls: Array<[string, Record<string, unknown>]>; call: Call }
function fake(templates: Array<Partial<Template>>, failAt?: string): Fake {
  const calls: Fake["calls"] = []
  const call = (async (method: string, body: Record<string, unknown> = {}) => {
    calls.push([method, body])
    if (method === "configGet") return { defaults: {} }
    if (method === "engines") return [{ id: "e1", ready: true }]
    if (method === "templateList") return templates
    if (method === "exec") return { exitCode: failAt && (body.argv as string[]).join(" ").includes(failAt) ? 1 : 0, stdout: "2.1.0 (Claude Code)\ncodex-cli 0.1.0\n", stderr: failAt ? "E: no network" : "" }
    if (method === "snapshot") return { template: { name: body.as, engine: "e1", sizeBytes: 1 } }
    return {}
  }) as Call
  return { calls, call }
}
const options = { name: "agent", versions: { claude: "2.1.0", codex: "0.1.0" }, replace: false }

test("prepare makes a sandbox from the built-in image, saves it, and always removes it", async () => {
  const run = fake([])
  const done = await prepareTemplate(run.call, options, () => {})
  expect(done.template.name).toBe("agent")
  expect(done.tools).toEqual(["2.1.0 (Claude Code)", "codex-cli 0.1.0"])
  const methods = run.calls.map(([method]) => method)
  expect(methods.filter((method) => method === "exec").length).toBe(3)
  const create = run.calls.find(([method]) => method === "create")![1]
  expect(create).toMatchObject({ image: DEFAULT_SPEC.image, engine: "e1" })
  expect(create).not.toHaveProperty("template")
  expect(methods.slice(-2)).toEqual(["snapshot", "remove"])
  expect(run.calls.at(-1)![1]).toEqual({ name: create.name, confirm: create.name })

  const failing = fake([], "apt-get")
  await expect(prepareTemplate(failing.call, options, () => {})).rejects.toThrow("Nothing was saved.\nE: no network")
  expect(failing.calls.map(([method]) => method)).not.toContain("snapshot")
  expect(failing.calls.at(-1)![0]).toBe("remove")
})

test("an existing template of that name on that engine is replaced only with --replace", async () => {
  const taken = [{ name: "agent", engine: "e1" }, { name: "agent", engine: "e2" }]
  const refused = fake(taken)
  await expect(prepareTemplate(refused.call, options, () => {})).rejects.toThrow("--replace")
  expect(refused.calls.map(([method]) => method)).not.toContain("create")
  const replaced = fake(taken)
  await prepareTemplate(replaced.call, { ...options, replace: true }, () => {})
  const removals = replaced.calls.filter(([method]) => method === "templateRemove").map(([, body]) => body)
  expect(removals).toEqual([{ name: "agent", engine: "e1" }])
  const order = replaced.calls.map(([method]) => method)
  expect(order.indexOf("templateRemove")).toBeLessThan(order.indexOf("snapshot"))
  expect(order.lastIndexOf("exec")).toBeLessThan(order.indexOf("templateRemove"))
})

test("a create's --gh, --claude, --codex, --repo and --t3 become extension runs in dependency order, checked first", async () => {
  const { createSteps, runCreateSteps } = await import("../../cli/create-setup")
  expect(createSteps("demo", {})).toEqual([])
  expect(createSteps("demo", { t3: true, repo: "o/r", codex: "work", claude: "deb", gh: true }).map((step) => step.argv)).toEqual([
    ["logins", "github", "demo", "--gh"],
    ["logins", "import", "demo", "claude", "--profile", "deb", "--setup"],
    ["logins", "import", "demo", "codex", "--profile", "work", "--setup"],
    ["repo", "clone", "demo", "o/r"],
    ["t3", "setup", "demo"],
  ])
  for (const repo of ["o", "o/r.git", "-o/r", "o/r/x", "https://github.com/o/r"]) expect(() => createSteps("demo", { repo })).toThrow("--repo")
  for (const claude of ["", "../x", "--setup", "a b"]) expect(() => createSteps("demo", { claude })).toThrow("--claude")
  // The first failure stops the rest.
  const ran = await runCreateSteps(["sh", "-c", 'echo "$3"; [ "$3" != import ]', "sh"], {}, createSteps("demo", { gh: true, claude: "deb", t3: true }), () => {})
  expect(ran.map((step) => [step.label, step.exitCode, step.output])).toEqual([["GitHub login", 0, "github"], ["Claude login deb", 1, "import"]])
})
