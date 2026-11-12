import type { CheckId, CheckResult, Stage } from "./types"

// The checklist. It is fixed here: providers supply evidence for each item, and nothing outside the core (an extension,
// a custom UI, a configuration file) can add, drop or reword one. An item a provider does not report comes out as
// "unknown", never as a pass.
export type ChecklistItem = { id: CheckId; title: string; stage: Stage; blocking: boolean }

export const CHECKLIST: readonly ChecklistItem[] = [
  { id: "kernel", title: "Runs on an isolated kernel, not the host's", stage: "runtime", blocking: true },
  { id: "docker", title: "Inner Docker is available when requested", stage: "runtime", blocking: true },
  { id: "dns", title: "Public DNS fallback is configured", stage: "runtime", blocking: true },
  { id: "hardening", title: "No privileged mode, host namespaces, undeclared capabilities or devices", stage: "config", blocking: true },
  { id: "mounts", title: "No host folders are mounted", stage: "config", blocking: true },
  { id: "network-guard", title: "On a network of its own, with the guard loaded", stage: "config", blocking: true },
  { id: "inbound", title: "No engine-published ports; requested forwards are loopback-only", stage: "config", blocking: true },
  { id: "forwards", title: "Forwards to this machine's loopback", stage: "config", blocking: false },
  { id: "ssh", title: "SSH access for editors", stage: "config", blocking: false },
  { id: "limits", title: "Memory, process and CPU limits are set", stage: "config", blocking: true },
  { id: "disk", title: "Disk use is limited", stage: "config", blocking: false },
  { id: "template", title: "The template it was made from", stage: "config", blocking: false },
  { id: "net-host", title: "Cannot reach the host", stage: "probe", blocking: true },
  { id: "net-peers", title: "Cannot reach other sandboxes", stage: "probe", blocking: true },
  { id: "net-private", title: "Cannot reach the LAN, the tailnet, cloud metadata or IPv6", stage: "probe", blocking: true },
  { id: "egress", title: "Internet access", stage: "probe", blocking: false },
  { id: "credentials", title: "Logins present inside the sandbox", stage: "probe", blocking: false },
]

// One result per checklist item of the given stages, in checklist order.
export function complete(results: readonly CheckResult[], stages: readonly Stage[], missing = "The provider did not report this check.", checklist = CHECKLIST): CheckResult[] {
  return checklist.filter((item) => stages.includes(item.stage)).map((item) =>
    results.find((result) => result.id === item.id) ?? { id: item.id, status: "unknown", evidence: "none", detail: missing })
}

// What stops a sandbox from running. A failed or unsupported blocking check always does. One that could not be checked does too when
// it only needs the engine's configuration or a running sandbox; a probe that could not run (no helper image, a control
// that did not answer) is shown as unknown and does not block.
// A stored verification is history, never a current result: each check comes back unknown with no current evidence,
// and what was measured, when, reads once in its detail.
export function historical(verify: { at: string; results: readonly CheckResult[] } | undefined): { at: string; results: CheckResult[] } | undefined {
  return verify && { at: verify.at, results: verify.results.map((check) => ({ ...check, status: "unknown", evidence: "none", detail: `Measured ${verify.at}: ${check.status} (${check.evidence}). ${check.detail}` })) }
}

export function blockers(results: readonly CheckResult[], checklist = CHECKLIST): CheckResult[] {
  return results.filter((result) => {
    const item = checklist.find((entry) => entry.id === result.id)
    if (!item?.blocking) return false
    return result.status === "fail" || result.status === "unsupported" || (result.status === "unknown" && item.stage !== "probe")
  })
}

// For a sandbox that is already running, where a check that could not be made this minute is no reason to stop it.
export function failures(results: readonly CheckResult[], checklist = CHECKLIST): CheckResult[] {
  return results.filter((result) => (result.status === "fail" || result.status === "unsupported") && checklist.find((entry) => entry.id === result.id)?.blocking)
}

export const WORKSPACE_CHECKLIST: readonly ChecklistItem[] = [
  { id: "seatbelt", title: "Runs under its workspace profile; paths only as parameters", stage: "config", blocking: true },
  { id: "writes", title: "Writes outside its folder are refused", stage: "probe", blocking: true },
  { id: "home-closed", title: "Home and shared temp reads are refused except declared paths", stage: "probe", blocking: true },
  { id: "daemons", title: "Named daemon sockets and launch channels are refused; Apple events not covered", stage: "probe", blocking: true },
  { id: "user-data", title: "Preferences, clipboard, outside signals and open files are closed", stage: "probe", blocking: true },
  { id: "processes", title: "Processes are identified by this workspace's kernel profile", stage: "runtime", blocking: true },
  { id: "gpu", title: "Hardware-only VideoToolbox encode; Metal compute not covered by this check", stage: "probe", blocking: false },
  { id: "network", title: "Network is open to internet, LAN and tailnet", stage: "probe", blocking: false },
  { id: "loopback", title: "Loopback is open to this Mac's services", stage: "probe", blocking: false },
  { id: "credentials", title: "Copied logins inside the workspace", stage: "probe", blocking: false },
  { id: "hard-links", title: "Files with multiple hard links", stage: "probe", blocking: false },
  { id: "not-covered", title: "Workspace, not a sandbox", stage: "config", blocking: false },
]

export const titleOf = (id: CheckId) => CHECKLIST.find((item) => item.id === id)?.title ?? id
