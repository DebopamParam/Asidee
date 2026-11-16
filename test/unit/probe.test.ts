import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { probeCleanupScript, WAIT_FOR_PROBE_ROUTES } from "../../core/providers/probe"
import { GvisorProvider, LABEL_ID, netPrivate, PROBE_TEARDOWN_WAIT } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Runner } from "../../core/types"

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
  'link del dev pv1234abcda') echo pv1234abcda > deleted ;;
  '-o link show') echo '4: owner0: <UP>'; [ "$n" -gt 3 ] || echo '5: pv1234abcda@if6: <UP>' ;;
  '-o -4 route show') [ "$n" -gt 6 ] || echo '10.255.255.252/30 dev pv1234abcda' ;;
esac
exit 0`, probeCleanupScript("1234abcd"))
  expect(result.code).toBe(0); expect(Number((await readFile(join(result.root, "count"), "utf8")).trim())).toBeGreaterThan(6)
  expect((await readFile(join(result.root, "deleted"), "utf8")).trim()).toBe("pv1234abcda")
})

for (const leftover of ["previous", "current"] as const) test(`a ${leftover} probe that misses teardown's deadline fails instead of returning weaker evidence`, async () => {
  const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo" }),
    engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }
  let reads = 0; let hostScript = ""
  const runner: Runner = async (argv) => {
    let stdout = "", exitCode = 0, stderr = ""
    if (argv.includes("--network") && argv[argv.indexOf("--network") + 1] === "host" && argv.at(-2) === "-c" && argv.at(-1)!.includes("echo ready")) hostScript = argv.at(-1)!
    if (argv[3] === "inspect" && argv[4] === "paddock-demo") stdout = JSON.stringify([{ State: { Running: true }, Config: { Labels: { [LABEL_ID]: "owned" } } }])
    // Another daemon's probe is tearing down: the host listener waits, and gives up after more reads than the 16 s
    // the daemon used to allow.
    else if (argv[3] === "logs") stdout = leftover === "current" ? "ready\n" : ++reads > 50 ? "teardown-timeout 10.255.255.254\n" : ""
    else if (argv[3] === "inspect" || argv[3] === "network") stdout = "172.20.0.1"
    else if (argv.some((part) => part.includes("Paddock probe teardown timed out:"))) {
      if (leftover === "current") { exitCode = 1; stderr = "Paddock probe teardown timed out" }
    } else if (argv[3] === "exec" && argv.includes("nc")) {
      if (argv[4]?.endsWith("-host")) stdout = "paddock-probe"; else exitCode = 1
    } else if (argv.includes("--entrypoint")) stdout = "intact"
    return { stdout, stderr, exitCode }
  }
  const checked = new GvisorProvider(runner).checks(manifest, "probe")
  if (leftover === "current") return void await expect(checked).rejects.toThrow(/teardown|tearing down/)
  await expect(checked).rejects.toThrow(`Another Paddock probe was still tearing down its routes after ${PROBE_TEARDOWN_WAIT} seconds, so nothing was probed and no weaker evidence was substituted. Run verify again in a few seconds.`)
  expect(reads).toBeGreaterThan(50)
  expect(hostScript).toContain(`wait_probe_routes \${a}4 ${PROBE_TEARDOWN_WAIT * 10} ||`)
}, 60_000)

test("net-private passes only when every stand-in range was probed, and is weak, naming the rest, when one was not", () => {
  const all = ["10.255.255.25", "172.31.255.25", "192.168.255.25", "100.127.255.25"]
  const seen = { guard: "intact" as const, reached: [], metadata: false, innerOnline: true, probeAlive: true, far: all, tried: all, failedControls: [], where: "the sandbox's network", noControl: (what: string) => `Not checked: ${what}.` }
  expect(netPrivate(seen)).toMatchObject({ status: "pass", evidence: "probed" })
  // The host already routes 192.168/16 somewhere, so no stand-in was set up there.
  const occupied = netPrivate({ ...seen, far: all.filter((ip) => !ip.startsWith("192.")), tried: all.filter((ip) => !ip.startsWith("192.")) })
  expect(occupied).toMatchObject({ status: "weak", evidence: "probed", detail: expect.stringMatching(/10\.255\.255\.25 \(in 10\.0\.0\.0\/8\).*rest on the loaded rules alone.*already uses the stand-in address: 192\.168\.0\.0\/16\./) })
  // A stand-in whose host control did not answer was not probed either.
  const silent = netPrivate({ ...seen, tried: all.slice(1), failedControls: all.slice(0, 1) })
  expect(silent).toMatchObject({ status: "weak", detail: expect.stringMatching(/host control did not answer .*10\.255\.255\.25 \(in 10\.0\.0\.0\/8\)/) })
  expect(netPrivate({ ...seen, far: [], tried: [] })).toMatchObject({ status: "weak", evidence: "inspected", detail: expect.stringContaining("No range was probed") })
  // What was already a failure or unknown stays so.
  expect(netPrivate({ ...seen, reached: ["10.255.255.25"] })).toMatchObject({ status: "fail" })
  expect(netPrivate({ ...seen, tried: [], failedControls: all })).toMatchObject({ status: "unknown" })
  expect(netPrivate({ ...seen, guard: "changed", far: [], tried: [] })).toMatchObject({ status: "fail" })
})
