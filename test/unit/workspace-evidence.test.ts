import { expect, test } from "bun:test"
import { AsideeError, type CheckResult } from "../../core/types"
import { explained, ready } from "./workspace-evidence"

const checks: CheckResult[] = [
  { id: "seatbelt", status: "fail", evidence: "none", detail: "The live probe did not acquire its expected profile after 1190 ms." },
  { id: "writes", status: "weak", evidence: "probed", detail: "Host temp is open." },
  { id: "processes", status: "pass", evidence: "probed", detail: "Finder found the probe." },
]

test("a refused test workspace names every check that did not pass, with its id, status and detail", async () => {
  expect(() => ready({ ok: false, checks })).toThrow("Workspace refused by its own checks:\nseatbelt fail: The live probe did not acquire its expected profile after 1190 ms.\nwrites weak: Host temp is open.")
  expect(() => ready({ ok: false, checks })).not.toThrow("processes")
  expect(ready({ ok: true, checks })).toEqual({ ok: true, checks })
  const refused = await explained(Promise.reject(new AsideeError("check-failed", "Workspace execution refused by its checklist: …", checks.slice(0, 1)))).then(() => undefined, (error: AsideeError) => error)
  expect(refused).toBeInstanceOf(AsideeError)
  expect(refused!.code).toBe("check-failed"); expect(refused!.details).toEqual(checks.slice(0, 1))
  expect(refused!.message).toBe("Workspace execution refused by its checklist: …\nseatbelt fail: The live probe did not acquire its expected profile after 1190 ms.")
  const other = new AsideeError("not-found", "There is no workspace named x.")
  expect(await explained(Promise.reject(other)).then(() => undefined, (error) => error)).toBe(other)
})
