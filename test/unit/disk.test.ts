import { expect, test } from "bun:test"
import { GvisorProvider, LABEL_ID } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Runner } from "../../core/types"

const manifest: Manifest = { version: 1, name: "demo", id: "owned", createdAt: "", spec: validSpec({ name: "demo" }),
  engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake", runtime: "runsc" } } }
const files = { HostsPath: "/var/lib/docker/containers/c0ffee/hosts", HostnamePath: "/var/lib/docker/containers/c0ffee/hostname", ResolvConfPath: "/var/lib/docker/containers/c0ffee/resolv.conf" }

// An engine whose container has a writable layer of 1 MiB, the volumes and engine files given, and a helper whose du
// prints `du` (or what each path it was given holds, 1 KiB per volume and `hostsKb` for /etc/hosts).
function fixture(inspect: Record<string, unknown>, du?: (paths: string[]) => string) {
  const runs: string[][] = []
  const runner: Runner = async (argv) => {
    const args = argv.slice(3)
    if (args[0] === "inspect" && args[1] === "--size") return { exitCode: 0, stdout: String(1024 ** 2), stderr: "" }
    if (args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify([{ Id: "c0ffee", State: { Running: true }, Config: { Labels: { [LABEL_ID]: manifest.id } }, HostConfig: { Runtime: "runsc" }, ...inspect }]), stderr: "" }
    if (args[0] === "run") {
      runs.push(args)
      const paths = args.slice(args.indexOf("-sk") + 1)
      return { exitCode: 0, stdout: du ? du(paths) : paths.map((path) => `${path === "/paddock-engine-files/0" ? 1331200 : 1}\t${path}`).join("\n"), stderr: "" }
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected" }
  }
  return { runs, provider: new GvisorProvider(runner) }
}

test("the disk watch counts the engine's /etc/hosts, /etc/hostname and /etc/resolv.conf, measured from outside", async () => {
  const { runs, provider } = fixture({ ...files, Mounts: [{ Type: "volume", Name: "v", Source: "", Destination: "/data" }] })
  // 1 MiB of layer, 1 KiB of volume, 1.3 GB written into /etc/hosts, 1 KiB each for the other two.
  expect(await provider.diskUsedBytes(manifest)).toBe(1024 ** 2 + 1024 + 1331200 * 1024 + 2 * 1024)
  const run = runs[0]!
  // The helper runs under runc with no network and sees each engine file read-only; nothing inside the sandbox runs.
  expect(run.slice(0, 6)).toEqual(["run", "--rm", "--runtime", "runc", "--network", "none"])
  for (const [index, path] of [files.HostsPath, files.HostnamePath, files.ResolvConfPath].entries())
    expect(run).toContain(`type=bind,src=${path},dst=/paddock-engine-files/${index},readonly`)
  expect(run).toContain("paddock-demo:ro")
})

test("without volumes the engine files are still measured, and a container never started has none", async () => {
  const started = fixture(files)
  expect(await started.provider.diskUsedBytes(manifest)).toBe(1024 ** 2 + 1331200 * 1024 + 2 * 1024)
  expect(started.runs[0]).not.toContain("--volumes-from")
  const fresh = fixture({ HostsPath: "", HostnamePath: "", ResolvConfPath: "" })
  expect(await fresh.provider.diskUsedBytes(manifest)).toBe(1024 ** 2)
  expect(fresh.runs).toEqual([])
})

test("a measurement that misses a path or does not parse is unknown, never a smaller number", async () => {
  expect(await fixture(files, (paths) => paths.slice(1).map((path) => `1\t${path}`).join("\n")).provider.diskUsedBytes(manifest)).toBeUndefined()
  expect(await fixture(files, (paths) => paths.map((path) => `x\t${path}`).join("\n")).provider.diskUsedBytes(manifest)).toBeUndefined()
})
