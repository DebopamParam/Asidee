import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { blockers } from "../../core/checks"
import { Core } from "../../core/core"
import { GvisorProvider } from "../../core/providers/gvisor"
import { systemRunner } from "../../core/run"

// The acceptance test for the product's promise, against a real engine: `bun run test:live`. Needs Docker with a gVisor
// runtime. It creates one small sandbox, expects every blocking check to hold, and removes it.
test.skipIf(!process.env.PADDOCK_LIVE)("a new sandbox on a real engine passes every blocking check", async () => {
  const root = await mkdtemp(join(tmpdir(), "paddock-live-"))
  const core = new Core([new GvisorProvider(systemRunner)], { state: join(root, "state"), config: join(root, "config") }, systemRunner, "/nowhere")
  const name = `live-${Date.now().toString(36)}`
  try {
    const made = await core.create({ name, image: "alpine:latest", cpus: 1, memoryGb: 1, diskGb: 1 })
    expect(blockers(made.checks)).toEqual([])
    for (const id of ["kernel", "net-host", "net-peers"] as const) expect(made.checks.find((check) => check.id === id)).toMatchObject({ status: "pass", evidence: "probed" })
    expect((await core.exec(name, ["cat", "/proc/version"])).stdout).toContain("gvisor")
  } finally {
    await core.remove(name, name).catch(() => {})
  }
}, 180_000)
