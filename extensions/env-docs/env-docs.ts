#!/usr/bin/env bun
import { exec, json, object, run, sandboxName, type Runner } from "./client"
// Embedded, so the extension also runs from inside the asd binary.
import WRITE from "./write.cjs" with { type: "text" }

type Check = { id: string; status: "pass" | "weak" | "fail" | "unsupported" | "unknown" | "info"; evidence: "probed" | "inspected" | "none"; detail: string }
type View = { name: string; engine: string; status: string; spec: { image: string; cpus: number; memoryGb: number; diskGb: number; pids: number } }
export type Report = { sandbox: View; checks: Check[]; ok: boolean }

function view(value: unknown): View {
  if (!object(value) || typeof value.name !== "string" || typeof value.engine !== "string" || typeof value.status !== "string" || !object(value.spec) || typeof value.spec.image !== "string") throw new Error("Invalid sandbox report; contents withheld.")
  const spec = value.spec
  if (typeof spec.image !== "string") throw new Error("Invalid reported image; contents withheld.")
  for (const field of ["cpus", "memoryGb", "diskGb", "pids"]) if (typeof spec[field] !== "number" || !Number.isFinite(spec[field]) || spec[field] <= 0) throw new Error("Invalid reported limits; contents withheld.")
  // Narrowing through the individual properties keeps the CLI boundary independent of core modules.
  if (typeof spec.cpus !== "number" || typeof spec.memoryGb !== "number" || typeof spec.diskGb !== "number" || typeof spec.pids !== "number") throw new Error("Invalid reported limits.")
  return { name: value.name, engine: value.engine, status: value.status, spec: { image: spec.image, cpus: spec.cpus, memoryGb: spec.memoryGb, diskGb: spec.diskGb, pids: spec.pids } }
}
export function parseReport(value: unknown): Report {
  if (!object(value) || typeof value.ok !== "boolean" || !Array.isArray(value.checks)) throw new Error("Invalid verification response; contents withheld.")
  const checks = value.checks.map((check: unknown): Check => {
    if (!object(check) || typeof check.id !== "string" || typeof check.detail !== "string") throw new Error("Invalid checklist response; contents withheld.")
    const { status, evidence } = check
    if (!(status === "pass" || status === "weak" || status === "fail" || status === "unsupported" || status === "unknown" || status === "info") || !(evidence === "probed" || evidence === "inspected" || evidence === "none")) throw new Error("Invalid checklist status; contents withheld.")
    return { id: check.id, status, evidence, detail: check.detail }
  })
  return { sandbox: view(value.sandbox), checks, ok: value.ok }
}
const cell = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ")
export function render(report: Report): string {
  const { sandbox, checks } = report, spec = sandbox.spec
  const rows: Array<[string, string]> = [["Name", sandbox.name], ["Engine", sandbox.engine], ["Status at verification", sandbox.status], ["Image", spec.image], ["Requested CPUs", String(spec.cpus)], ["Requested memory (GB)", String(spec.memoryGb)], ["Requested disk (GB)", String(spec.diskGb)], ["Requested task limit", String(spec.pids)], ["Verification accepted", String(report.ok)]]
  const network = ["net-host", "net-peers", "net-private", "egress", "inbound", "network-guard", "mounts"].map(id => {
    const check = checks.find(item => item.id === id)
    return check ? `- ${id}: ${check.status} (${check.evidence}). ${cell(check.detail)}` : `- ${id}: not reported.`
  })
  return `# Sandbox environment\n\nGenerated from asd --json list and asd --json verify. This is a snapshot of what Asidee reported, not a new measurement or a promise about untested destinations.\n\n| Item | Reported value |\n| --- | --- |\n${rows.map(([key, value]) => `| ${key} | ${cell(value)} |`).join("\n")}\n\nRequested sizes above are the sandbox spec. The checklist below describes the evidence for their enforcement.\n\n## Reachability and host access reported by Asidee\n\n${network.join("\n")}\n\n## Checklist\n\n| Check | Result | Evidence | Reported detail |\n| --- | --- | --- | --- |\n${checks.map(check => `| ${cell(check.id)} | ${check.status} | ${check.evidence} | ${cell(check.detail)} |`).join("\n")}\n\nA pass records the reported observation. Weak, unknown, unsupported and info retain their original meanings; they are not upgraded to a pass. Missing checks are not evidence.\n`
}

export async function writeDocs(runner: Runner, name: string, workspace: string): Promise<void> {
  sandboxName(name)
  if (!workspace || /[\0\r\n]/.test(workspace)) throw new Error("Give a guest workspace path.")
  const list = await runner(["asd", "--json", "list"])
  const listed = json(list.stdout)
  if (list.exitCode !== 0 || !object(listed) || listed.ok !== true || !Array.isArray(listed.data) || !listed.data.some((item: unknown) => object(item) && item.name === name)) throw new Error("Sandbox was not reported by asd list.")
  const result = await runner(["asd", "--json", "verify", name]), reply = json(result.stdout)
  if (![0, 6].includes(result.exitCode) || !object(reply) || reply.ok !== true) throw new Error("Verification did not return a checklist; output withheld.")
  const report = parseReport(reply.data)
  if (report.sandbox.name !== name) throw new Error("Verification named a different sandbox.")
  if (report.sandbox.status !== "running") throw new Error("Verification reports a sandbox that is not running. No document was written.")
  await exec(runner, name, ["node", "-e", WRITE, workspace], render(report))
}
export async function main(argv: string[], env = process.env): Promise<void> {
  if (argv.includes("--help")) { console.log("env-docs.ts NAME [WORKSPACE]. WORKSPACE defaults to the guest's ~/workspace. Runs asd verify before writing env_docs/SANDBOX.md."); return }
  if (argv.length > 2) throw new Error("Unexpected environment docs arguments.")
  await writeDocs(run, argv[0] ?? env.ASIDEE_SANDBOX ?? "", argv[1] ?? env.ASIDEE_FIELD_WORKSPACE ?? "workspace")
  console.log("Wrote env_docs/SANDBOX.md from the reported checklist.")
}
// The command line, run by Bun directly or from inside the asd binary for an installed extension.
export const command = (argv: string[]) => main(argv).catch(() => { console.error("Environment docs failed. Check list/verify, the running sandbox, Node and workspace. Subprocess output withheld."); process.exitCode = 1 })
if (import.meta.main) command(process.argv.slice(2))
