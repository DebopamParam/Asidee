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
