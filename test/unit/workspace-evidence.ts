import { Workspaces } from "../../core/workspaces"
import { AsideeError, type CheckResult } from "../../core/types"

// About one full test run in a few has a workspace refused by its own pre-launch checks, cause unknown. A test that
// only says "not ok" or "check-failed" hides what was seen, so these put every check that did not pass in the failure.
const evidence = (checks: readonly CheckResult[]) => checks.filter((check) => check.status !== "pass").map((check) => `${check.id} ${check.status}: ${check.detail}`).join("\n")

export function ready<T extends { ok: boolean; checks: CheckResult[] }>(report: T): T {
  if (!report.ok) throw new Error(`Workspace refused by its own checks:\n${evidence(report.checks)}`)
  return report
}

export async function explained<T>(launch: Promise<T>): Promise<T> {
  try { return await launch } catch (error) {
    if (error instanceof AsideeError && Array.isArray(error.details)) throw new AsideeError(error.code, `${error.message}\n${evidence(error.details)}`, error.details)
    throw error
  }
}

// Every workspace a test creates is expected to pass its checks; exec and shell go through open.
export class ExplainedWorkspaces extends Workspaces {
  override async create(input: Record<string, unknown>) { return ready(await super.create(input)) }
  override async verify(name: string) { return ready(await super.verify(name)) }
  override open(...args: Parameters<Workspaces["open"]>) { return explained(super.open(...args)) }
}
