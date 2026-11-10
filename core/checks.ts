import type { CheckId, CheckResult, Stage } from "./types"

// The checklist. It is fixed here: providers supply evidence for each item, and nothing outside the core (an extension,
// a custom UI, a configuration file) can add, drop or reword one. An item a provider does not report comes out as
// "unknown", never as a pass.
export type ChecklistItem = { id: CheckId; title: string; stage: Stage; blocking: boolean }

export const CHECKLIST: readonly ChecklistItem[] = [
  { id: "kernel", title: "Runs on an isolated kernel, not the host's", stage: "runtime", blocking: true },
  { id: "docker", title: "Inner Docker is available when requested", stage: "runtime", blocking: true },
  { id: "hardening", title: "No privileged mode, host namespaces, undeclared capabilities or devices", stage: "config", blocking: true },
  { id: "mounts", title: "No host folders are mounted", stage: "config", blocking: true },
  { id: "network-guard", title: "On a network of its own, with the guard loaded", stage: "config", blocking: true },
  { id: "inbound", title: "No ports are open to the host or the network", stage: "config", blocking: true },
  { id: "limits", title: "Memory, process and CPU limits are set", stage: "config", blocking: true },
  { id: "disk", title: "Disk use is limited", stage: "config", blocking: false },
  { id: "net-host", title: "Cannot reach the host", stage: "probe", blocking: true },
  { id: "net-peers", title: "Cannot reach other sandboxes", stage: "probe", blocking: true },
  { id: "net-private", title: "Cannot reach the LAN, the tailnet, cloud metadata or IPv6", stage: "probe", blocking: true },
  { id: "egress", title: "Internet access", stage: "probe", blocking: false },
  { id: "credentials", title: "Logins present inside the sandbox", stage: "probe", blocking: false },
]

// One result per checklist item of the given stages, in checklist order.
export function complete(results: readonly CheckResult[], stages: readonly Stage[], missing = "The provider did not report this check."): CheckResult[] {
  return CHECKLIST.filter((item) => stages.includes(item.stage)).map((item) =>
    results.find((result) => result.id === item.id) ?? { id: item.id, status: "unknown", evidence: "none", detail: missing })
}

// What stops a sandbox from running. A failed blocking check always does. One that could not be checked does too when
// it only needs the engine's configuration or a running sandbox; a probe that could not run (no helper image, a control
// that did not answer) is shown as unknown and does not block.
export function blockers(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => {
    const item = CHECKLIST.find((entry) => entry.id === result.id)
    if (!item?.blocking) return false
    return result.status === "fail" || (result.status === "unknown" && item.stage !== "probe")
  })
}

// For a sandbox that is already running, where a check that could not be made this minute is no reason to stop it.
export function failures(results: readonly CheckResult[]): CheckResult[] {
  return results.filter((result) => result.status === "fail" && CHECKLIST.find((entry) => entry.id === result.id)?.blocking)
}

export const titleOf = (id: CheckId) => CHECKLIST.find((item) => item.id === id)?.title ?? id
