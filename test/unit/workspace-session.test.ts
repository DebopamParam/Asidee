import { expect, test } from "bun:test"
import { WorkspaceSession } from "../../core/workspace-session"

test("a workspace killed by a signal returns 128 plus its number and keeps its stop reason", async () => {
  const session = new WorkspaceSession({ argv: ["/bin/sleep", "60"], cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, folder: "/tmp", tty: false })
  const collected = session.collect()
  try {
    session.stopping("Stopped by workspace stop demo.")
    process.kill(session.pid, "SIGKILL")
    expect(await collected).toMatchObject({ exitCode: 137, stderr: "Stopped by workspace stop demo.\n" })
  } finally { try { process.kill(session.pid, "SIGKILL") } catch {} }
})

;(process.platform === "darwin" ? test : test.skip)("a workspace terminal preserves the actual signal number and stop reason", async () => {
  const session = new WorkspaceSession({ argv: ["/bin/sleep", "60"], cwd: "/tmp", env: { PATH: "/usr/bin:/bin" }, folder: "/tmp", tty: true })
  const output: string[] = []
  const ended = new Promise<{ code?: number }>((resolve) => session.once("end", resolve))
  session.on("output", (_which, bytes) => output.push(Buffer.from(bytes).toString()))
  try {
    session.resume(); session.stopping("Stopped by the disk watch."); process.kill(session.pid, "SIGTERM")
    expect((await ended).code).toBe(143)
    expect(output.join("")).toContain("Stopped by the disk watch.\n")
  } finally { try { process.kill(session.pid, "SIGKILL") } catch {} }
})
