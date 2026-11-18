import { AsideeError, type Runner } from "./types"

// A request on the dashboard's port that would act on this Mac itself waits for the person at the Mac: the daemon shows
// a native dialog naming the exact action and runs the request only when they click Allow. Over the user socket nothing
// is asked, as before. The CLI command is what the page offers when no dialog can be shown.
export type Approval = { action: string; details?: string[]; cli: string }
export type Answer = "allow" | "deny" | "timeout" | "unavailable"
export type Approver = (approval: Approval) => Promise<Answer>

export const APPROVAL_SECONDS = 60
// Longer text would not fit the dialog, and a cut-off one could hide what matters.
const TEXT_LIMIT = 3000

// Request-supplied text exactly as sent: quoted, with line breaks, controls and invisible or direction-changing
// characters as escapes, so it cannot pass for the dialog's own words or hide part of itself.
export const literal = (text: string) => JSON.stringify(text)
  .replace(/[\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e0fff}]/gu,
    (character) => { const point = character.codePointAt(0)!; return point > 0xffff ? `\\u{${point.toString(16)}}` : `\\u${point.toString(16).padStart(4, "0")}` })
// A word of a CLI command, quoted for a POSIX shell when it needs it.
export const word = (text: string) => /^[A-Za-z0-9_@%+=:,./~-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

export function approvalText(approval: Approval): string {
  const text = ["A request to the Asidee dashboard asks to:", "", approval.action, ...(approval.details?.length ? ["", ...approval.details] : []), "",
    "Allow it only if you asked for this in the dashboard just now. Anything that holds the dashboard's token can send such a request."].join("\n")
  if (text.length > TEXT_LIMIT) throw new AsideeError("usage", `This request is too long to show in a dialog on this Mac, so it was not asked. Run it from the CLI: ${approval.cli}`)
  return text
}

// osascript with fixed source: the request's text arrives only as arguments of `on run argv`, never as AppleScript.
// Deny is the default button, so Return denies; nobody answering within the time also denies.
const DIALOG = [
  "on run argv",
  'set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Deny", "Allow"} default button "Deny" with icon caution giving up after ((item 3 of argv) as integer)',
  'if gave up of answer then return "timeout"',
  "return button returned of answer",
  "end run",
]
export function dialogApprover(run: Runner, seconds = APPROVAL_SECONDS, platform: string = process.platform): Approver {
  return async (approval) => {
    // Linux and anything else: no dialog, so the request is refused as before.
    if (platform !== "darwin") return "unavailable"
    const result = await run(["/usr/bin/osascript", ...DIALOG.flatMap((line) => ["-e", line]), "Asidee: allow this?", approvalText(approval), String(seconds)], { timeoutMs: (seconds + 15) * 1000, maxOutputBytes: 4096 })
    // A failure to show it (no desktop session, osascript missing) is unavailable; a dialog killed at the deadline, timed out.
    if (result.exitCode !== 0) return result.exitCode === 124 ? "timeout" : "unavailable"
    const said = result.stdout.trim()
    return said === "Allow" ? "allow" : said === "timeout" ? "timeout" : "deny"
  }
}
