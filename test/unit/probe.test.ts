import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeCleanupScript, WAIT_FOR_PROBE_ROUTES } from "../../core/providers/probe"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture(ip: string, script: string) {
  const root = await mkdtemp(join(tmpdir(), "pdk-probe-unit-")); roots.push(root)
  await mkdir(join(root, "bin")); await writeFile(join(root, "bin/ip"), `#!/bin/sh\n${ip}`); await chmod(join(root, "bin/ip"), 0o700)
  const child = Bun.spawn(["sh", "-c", script], { cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" })
  return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text(), root }
}

test("an owned stale route is awaited, but another user's route is left for address exclusion", async () => {
  const owned = await fixture(`n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > count
[ "$n" -gt 2 ] || echo '192.168.255.252/30 dev pv1234abcda proto kernel'`, `${WAIT_FOR_PROBE_ROUTES}\nwait_probe_routes 192.168.255.254`)
  expect(owned.code).toBe(0); expect((await readFile(join(owned.root, "count"), "utf8")).trim()).toBe("3")
  const foreign = await fixture("echo '192.168.255.0/24 dev tailscale0'; echo called >> calls", `${WAIT_FOR_PROBE_ROUTES}\nwait_probe_routes 192.168.255.254`)
  expect(foreign.code).toBe(0); expect((await readFile(join(foreign.root, "calls"), "utf8")).trim()).toBe("called")
})

test("an owned route that never disappears fails at its deadline instead of reducing evidence", async () => {
  const result = await fixture("echo '10.255.255.252/30 dev pv1234abcda'", `${WAIT_FOR_PROBE_ROUTES}\nwait_probe_routes 10.255.255.254 2`)
  expect(result.code).toBe(1); expect(result.err).toContain("teardown timed out")
})

test("probe cleanup waits for its own lingering link and route, leaving foreign links untouched", async () => {
  const result = await fixture(`n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > count
case "$*" in
  '-o link show') echo '4: owner0: <UP>'; [ "$n" -gt 3 ] || echo '5: pv1234abcda@if6: <UP>' ;;
  '-o -4 route show') [ "$n" -gt 6 ] || echo '10.255.255.252/30 dev pv1234abcda' ;;
esac
exit 0`, probeCleanupScript("1234abcd"))
  expect(result.code).toBe(0); expect(Number((await readFile(join(result.root, "count"), "utf8")).trim())).toBeGreaterThan(6)
})
