import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parseReport, render, writeDocs, type Report } from "../../extensions/env-docs/env-docs"
import { fixture, fakeExec, local, must, ok, put } from "./client-feature-fixtures"

const report: Report = {
  sandbox: { name: "demo", engine: "engine-a", status: "running", spec: { image: "unit:image", cpus: 2, memoryGb: 4, diskGb: 8, pids: 100 } }, ok: false,
  checks: [
    { id: "net-host", status: "unknown", evidence: "none", detail: "control did not answer" },
    { id: "net-peers", status: "pass", evidence: "probed", detail: "stand-in blocked with a working control" },
    { id: "net-private", status: "weak", evidence: "probed", detail: "skipped 10/8 | route\nnext" },
    { id: "disk", status: "weak", evidence: "inspected", detail: "watched" },
    { id: "egress", status: "info", evidence: "probed", detail: "HTTPS reached" },
    { id: "future-check", status: "unsupported", evidence: "none", detail: "not available" },
  ],
}
test("environment docs retain reported uncertainty and scope without inventing guest claims", () => {
  const text = render(parseReport(report))
  expect(text).toContain("net-host: unknown (none). control did not answer")
  expect(text).toContain("inbound: not reported")
  expect(text).toContain("| disk | weak | inspected | watched |")
  expect(text).toContain("| Requested disk (GB) | 8 |")
  expect(text).toContain("skipped 10/8 \\| route next")
  for (const invention of ["passwordless", "sudo", "internet is reachable", "Docker is available", "cannot reach the host", "microVM"]) expect(text).not.toContain(invention)
  expect(() => parseReport({ ...report, checks: [{ id: "x", status: "green", evidence: "probed", detail: "x" }] })).toThrow("Invalid")
})
test("environment docs consume JSON list/verify including exit 6 and write only that report on stdin", async () => {
  const home = await fixture(), work = join(home, "workspace"), execute = local(home), transport = fakeExec(home)
  await must(execute, ["git", "init", "-q", work])
  const calls: string[][] = []
  const runner = async (argv: string[], stdin?: string) => {
    calls.push(argv)
    if (argv[1] === "--json" && argv[2] === "list") return ok(JSON.stringify({ ok: true, data: [report.sandbox] }))
    if (argv[1] === "--json" && argv[2] === "verify") return { ...ok(JSON.stringify({ ok: true, data: report })), exitCode: 6 }
    return transport.runner(argv, stdin)
  }
  await writeDocs(runner, "demo", "workspace"); await writeDocs(runner, "demo", "workspace")
  expect(calls.slice(0, 2)).toEqual([["asd", "--json", "list"], ["asd", "--json", "verify", "demo"]])
  expect(await readFile(join(work, "env_docs/SANDBOX.md"), "utf8")).toBe(render(report))
  expect(transport.calls[0]?.stdin).toBe(render(report))
  expect((await readFile(join(work, ".git/info/exclude"), "utf8")).match(/\/env_docs\//g)).toHaveLength(1)
  expect(await must(execute, ["git", "-C", work, "status", "--porcelain"])).toBe("")
})
test("a stopped or mismatched verification cannot write an environment document", async () => {
  const home = await fixture()
  for (const sandbox of [{ ...report.sandbox, status: "stopped" }, { ...report.sandbox, name: "other" }]) {
    let execs = 0
    await expect(writeDocs(async argv => {
      if (argv[1] === "exec") { execs++; return ok() }
      return ok(JSON.stringify({ ok: true, data: argv[2] === "list" ? [report.sandbox] : { ...report, sandbox } }))
    }, "demo", home)).rejects.toThrow()
    expect(execs).toBe(0)
  }
})
test("the writer refuses symlink destinations without changing their target", async () => {
  const home = await fixture(), execute = local(home)
  await put(home, "workspace/env_docs/placeholder", ""); await put(home, "private", "keep")
  await must(execute, ["ln", "-s", join(home, "private"), join(home, "workspace/env_docs/SANDBOX.md")])
  const script = await Bun.file(join(import.meta.dir, "../../extensions/env-docs/write.cjs")).text()
  expect((await execute(["node", "-e", script, "workspace"], render(report))).exitCode).not.toBe(0)
  expect(await readFile(join(home, "private"), "utf8")).toBe("keep")
})
