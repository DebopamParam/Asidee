import { expect, test } from "bun:test"
import { enrollmentOptions, installationPlan, mergeRuntime, planHash, verifyArtifact, type HostProbe } from "../../core/hosts"

test("enrollment accepts only a watched plan and an explicit artifact digest", () => {
  expect(enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/paddock", sha256: "a".repeat(64) } }).sudo).toBe("ask")
  for (const change of [{ diskPolicy: "hard" }, { sudo: "always" }, { ssh: "-oProxyCommand=id" }, { artifact: { path: "/tmp/paddock", sha256: "bad" } }])
    expect(() => enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/paddock", sha256: "a".repeat(64) }, ...change })).toThrow()
})

test("runtime merge preserves other settings and rejects non-object configuration", () => {
  const before = '{"log-driver":"local","runtimes":{"other":{"path":"/bin/other"}}}'
  const after = JSON.parse(mergeRuntime(before, "/opt/paddock/gvisor/test/runsc"))
  expect(after["log-driver"]).toBe("local")
  expect(after.runtimes.other).toEqual({ path: "/bin/other" })
  expect(after.runtimes["paddock-runsc"]).toEqual({ path: "/opt/paddock/gvisor/test/runsc", runtimeArgs: ["--allow-suid", "--overlay2=none"] })
  for (const input of ["[]", "null", '{"runtimes":[]}']) expect(() => mergeRuntime(input, "/runsc")).toThrow()
})

test("plan digest binds identity, file bytes, runtime inventory and exact argv independent of object key order", () => {
  const input = { ssh: "a", files: [{ before: "old", after: "new" }], containers: ["one"], steps: [["sudo", "-n", "install", "a", "b"]] }
  expect(planHash(input)).toBe(planHash({ steps: input.steps, containers: input.containers, files: input.files, ssh: input.ssh }))
  for (const changed of [{ ...input, ssh: "b" }, { ...input, containers: [] }, { ...input, files: [{ before: "changed", after: "new" }] }, { ...input, steps: [["sudo", "-n", "rm", "b"]] }]) expect(planHash(changed)).not.toBe(planHash(input))
})

test("artifact mismatch is refused before it is treated as executable", async () => {
  await expect(verifyArtifact({ path: import.meta.path, sha256: "0".repeat(64) }, "aarch64")).rejects.toThrow("checksum")
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(import.meta.path).arrayBuffer()).digest("hex")
  await expect(verifyArtifact({ path: import.meta.path, sha256: hash }, "aarch64")).rejects.toThrow("ELF")
})

test("an enrolled system service remains a readable registry record", async () => {
  const { parseHosts } = await import("../../core/machines")
  const host = { name: "enrolled", ssh: "builder@machine", binary: "/opt/paddock/releases/abc/paddock", stateDir: "/var/lib/paddock/1000", machineId: "a".repeat(32), addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "systemd" } as const
  expect(parseHosts({ version: 1, hosts: [host] }).hosts).toEqual([host])
})

const client = { version: "0.4.0", sourceDigest: "b".repeat(64) }
const options = enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/paddock", sha256: "a".repeat(64) } })
function evidence(): HostProbe {
  return { system: "Linux", arch: "aarch64", libc: ["glibc", "2.39"], uid: 1000, gid: 1000, user: "alice", home: "/home/alice", machine: "m", boot: "b", hostKey: "SHA256:"+"A".repeat(43), systemd: true, os: { ID: "ubuntu", VERSION_ID: "24.04" },
    docker: { code: 0, out: "{}", err: "" }, containers: { code: 0, out: '{"Names":"owner-web","ID":"123"}', err: "" }, packages: { code: 0, out: "", err: "" }, downloads: [], apt: {}, repositories: {}, ancestors: {},
    files: Object.fromEntries(["/etc/docker/daemon.json", "/usr/local/bin/paddock", "/etc/systemd/system/paddock@1000.service", "/opt/paddock/releases/"+"a".repeat(64)+"/paddock", "/opt/paddock/gvisor/20251110.0/runsc"].map((p) => [p, { kind: "absent" }])),
    unit: { code: 0, out: "", err: "" }, dockerGroup: { code: 0, out: "docker:x:999:", err: "" }, lingering: { code: 0, out: "Linger=no", err: "" } }
}

test("an installation plan declares every changed file, artifact, privilege and restart victim", () => {
  const plan = installationPlan(options, evidence(), client)
  expect(plan.blockers).toEqual([])
  expect(plan.restart).toEqual({ required: true, containers: ["owner-web (123)"] })
  expect(plan.uploads).toHaveLength(2)
  expect(plan.steps.every((s) => s.argv[0] === "sudo" && s.argv[1] === "-n")).toBe(true)
  expect(plan.steps.some((s) => s.argv.includes("--validate"))).toBe(true)
  expect(plan.steps.filter((s) => s.argv.includes("restart")).map((s) => s.argv)).toEqual([["sudo", "-n", "systemctl", "restart", "docker"]])
  for (const change of plan.changes) {
    expect(change.sha256).toBe(new Bun.CryptoHasher("sha256").update(change.after!).digest("hex"))
    expect(plan.steps.some((s) => s.argv.includes(change.path) && s.argv.includes(plan.stageDir+"/"+change.staged))).toBe(true)
  }
  expect(plan.steps.some((s) => s.argv.includes("paddock-disk") || s.argv.includes("e2fsprogs"))).toBe(false)
  const { hash, ...content } = plan
  expect(hash).toBe(planHash(content))
})

test("unreadable config, unsafe ancestors and owner containers block installation, and sudo never plans no sudo", () => {
  for (const mutation of [
    (p: HostProbe) => { p.files["/etc/docker/daemon.json"] = { kind: "unreadable", error: "permission denied" } },
    (p: HostProbe) => { p.ancestors["/opt/paddock"] = { uid: 1000, mode: 0o777, link: true } },
    (p: HostProbe) => { p.containers.out = '{"Names":"sandbox-owner","ID":"123"}' },
    (p: HostProbe) => { p.files["/usr/local/bin/paddock"] = { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/other" } },
  ]) { const p=evidence(); mutation(p); expect(installationPlan(options,p,client).blockers.length).toBeGreaterThan(0) }
  const never = installationPlan({ ...options, sudo: "never" }, evidence(), client)
  expect(never.steps).toEqual([])
  expect(never.uploads).toEqual([])
  expect(never.changes).toEqual([])
  expect(never.restart.required).toBe(false)
  expect(never.blockers.join(" ")).toContain("Owner setup")
})


test("the enrollment terminal accepts consent only on the primary and never as a remote sandbox session", async () => {
  const { enrollmentHash, parseOpen } = await import("../../core/stream")
  const input = { kind: "enroll", hash: "a".repeat(64), accepted: true }
  expect(enrollmentHash(input)).toBe(input.hash)
  for (const change of [{ accepted: false }, { hash: "bad" }, { host: "build" }]) expect(() => enrollmentHash({ ...input, ...change })).toThrow()
  expect(() => parseOpen({ ...input, name: "enrollment" })).toThrow()
})


test("Ctrl-C cancels enrollment only while it has no SSH terminal child", async () => {
  const { enrollmentInterrupt } = await import("../../core/hosts")
  expect(enrollmentInterrupt(Uint8Array.of(3), false)).toBe(true)
  expect(enrollmentInterrupt(Uint8Array.of(3), true)).toBe(false)
  expect(enrollmentInterrupt(Uint8Array.of(121, 101, 115), false)).toBe(false)
  expect(enrollmentInterrupt(Uint8Array.of(65, 3, 66), false)).toBe(true)
})

test("a prepared state identity is shown and damaged or indirect identities block enrollment", () => {
  for (const identity of [
    { kind: "link", target: "/etc/machine-id", uid: 1000, mode: 0o777 },
    { kind: "file", text: "damaged\n", sha256: "a".repeat(64), sha512: "b".repeat(128), uid: 1000, mode: 0o600 },
  ] as const) {
    const probe=evidence(); probe.files["/var/lib/paddock/1000/machine-id"]=identity
    expect(installationPlan(options,probe,client).blockers.join(" ")).toContain("machine identity")
  }
})
