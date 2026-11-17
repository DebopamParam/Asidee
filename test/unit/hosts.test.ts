import { expect, test } from "bun:test"
import { CHECKLIST } from "../../core/checks"
import {
  enrollmentFailure, enrollmentInterrupt, enrollmentOptions, GVISOR, GVISOR_FILES, GVISOR_RELEASE, identityRegistered, installationPlan, installOutcome,
  lineDiff, mergeRuntime, planHash, requireSmokeChecks, requireSmokeEngine, requireSmokeVerified, serviceMatches, verifyArtifact, type HostProbe,
} from "../../core/hosts"
import { parseHosts } from "../../core/machines"
import { GvisorProvider } from "../../core/providers/gvisor"
import { enrollmentHash, parseOpen } from "../../core/stream"
import { AsideeError } from "../../core/types"

const RUNTIME_DIR = `/opt/asidee/gvisor/${GVISOR_RELEASE}`
const client = { version: "0.4.0", sourceDigest: "b".repeat(64) }
const options = enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/asd", sha256: "a".repeat(64) } })
const file = (text: string | null, extra: object = {}) => ({ kind: "file" as const, sha256: "c".repeat(64), sha512: "d".repeat(128), text, uid: 0, mode: 0o644, ...extra })

// An Ubuntu host with Docker, one container of its owner's, and nothing of Asidee's.
function evidence(): HostProbe {
  return {
    system: "Linux", arch: "aarch64", libc: ["glibc", "2.39"], uid: 1000, gid: 1000, user: "alice", home: "/home/alice", machine: "m", boot: "b",
    hostKey: "SHA256:0X7US8OfQfzxyXkA9yUZy3JjznnQA/iqkCBdPkPPSEQ", hostPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEU61N7KJmkiTPSmrOfaemXZu/1hocrAC0WXPcRUyjQ8", systemd: true, os: { ID: "ubuntu", VERSION_ID: "24.04" },
    docker: { code: 0, out: "{}", err: "" }, containers: { code: 0, out: '{"Names":"owner-web","ID":"123"}', err: "" },
    packages: { code: 0, out: "", err: "" }, downloads: [], apt: {}, repositories: {}, ancestors: {},
    files: Object.fromEntries([
      "/etc/docker/daemon.json", "/usr/local/bin/asd", "/etc/systemd/system/asidee@1000.service", `/opt/asidee/releases/${"a".repeat(64)}/asd`,
      ...GVISOR_FILES.map((name) => `${RUNTIME_DIR}/${name}`),
    ].map((path) => [path, { kind: "absent" }])),
    unit: { code: 0, out: "", err: "" }, dockerGroup: { code: 0, out: "docker:x:999:", err: "" }, lingering: { code: 0, out: "Linger=no", err: "" },
  }
}

// A host that an earlier enrollment with the same options left complete.
function prepared(chosen = options): HostProbe {
  const probe = evidence(); const plan = installationPlan(chosen, probe, client)
  const { name: _name, release: _release, innerDocker: _inner, ...entry } = plan.runtime
  probe.files["/etc/docker/daemon.json"] = file(JSON.stringify({ runtimes: { "asidee-runsc": entry } }))
  probe.files["/etc/systemd/system/asidee@1000.service"] = file(plan.changes.find((change) => change.path.endsWith(".service"))!.after)
  probe.files[plan.binary] = file(null, { sha256: chosen.artifact.sha256, mode: 0o755 })
  probe.files["/usr/local/bin/asd"] = { kind: "link", target: plan.binary, uid: 0, mode: 0o777 }
  for (const name of GVISOR_FILES) probe.files[`${RUNTIME_DIR}/${name}`] = file(null, { sha256: GVISOR.aarch64.files[name], mode: 0o755 })
  probe.docker.out = JSON.stringify({ Runtimes: { "asidee-runsc": entry, runc: { path: "runc", runtimeArgs: null } } })
  probe.unit.out = `User=alice\nSupplementaryGroups=docker\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\nExecStart={ path=${plan.binary} ; argv[]=${plan.binary} daemon run ; ignore_errors=no ; pid=7 }`
  return probe
}
// The same host asked to take another artifact.
const other = { ...options, artifact: { path: "/tmp/asd", sha256: "e".repeat(64) } }
function updated(): HostProbe {
  const probe = prepared()
  probe.files[`/opt/asidee/releases/${"e".repeat(64)}/asd`] = { kind: "absent" }
  return probe
}

test("malformed container inventory raises an Asidee dependency error", () => {
  const probe = evidence(); probe.containers.out += "\n{broken"
  expect(() => installationPlan(options, probe, client)).toThrow(AsideeError)
  expect(() => installationPlan(options, probe, client)).toThrow("Invalid Docker container inventory")
})

test("enrollment accepts only a watched plan, an explicit artifact digest and a true-or-false Docker option", () => {
  const made = enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/asd", sha256: "a".repeat(64) } })
  expect(made.sudo).toBe("ask")
  expect(made.docker).toBe(false)
  expect(enrollmentOptions({ ...made, docker: true }).docker).toBe(true)
  for (const change of [{ diskPolicy: "hard" }, { sudo: "always" }, { ssh: "-oProxyCommand=id" }, { artifact: { path: "/tmp/asd", sha256: "bad" } }, { docker: "yes" }])
    expect(() => enrollmentOptions({ name: "build", ssh: "alice@build", artifact: { path: "/tmp/asd", sha256: "a".repeat(64) }, ...change })).toThrow()
})

test("runtime merge preserves other settings, adds raw networking only for inner Docker, and rejects non-object configuration", () => {
  const before = '{"log-driver":"local","runtimes":{"other":{"path":"/bin/other"}}}'
  const after = JSON.parse(mergeRuntime(before, "/opt/asidee/gvisor/test/runsc"))
  expect(after["log-driver"]).toBe("local")
  expect(after.runtimes.other).toEqual({ path: "/bin/other" })
  expect(after.runtimes["asidee-runsc"]).toEqual({ path: "/opt/asidee/gvisor/test/runsc", runtimeArgs: ["--allow-suid", "--overlay2=none"] })
  expect(JSON.parse(mergeRuntime(before, "/runsc", true)).runtimes["asidee-runsc"].runtimeArgs).toEqual(["--allow-suid", "--overlay2=none", "--net-raw"])
  for (const input of ["[]", "null", '{"runtimes":[]}']) expect(() => mergeRuntime(input, "/runsc")).toThrow()
})

test("plan digest binds identity, file bytes, runtime inventory and exact argv independent of object key order", () => {
  const input = { ssh: "a", files: [{ before: "old", after: "new" }], containers: ["one"], steps: [["sudo", "-n", "install", "a", "b"]] }
  expect(planHash(input)).toBe(planHash({ steps: input.steps, containers: input.containers, files: input.files, ssh: input.ssh }))
  for (const changed of [{ ...input, ssh: "b" }, { ...input, containers: [] }, { ...input, files: [{ before: "changed", after: "new" }] }, { ...input, steps: [["sudo", "-n", "rm", "b"]] }])
    expect(planHash(changed)).not.toBe(planHash(input))
})

test("artifact mismatch is refused before it is treated as executable", async () => {
  await expect(verifyArtifact({ path: import.meta.path, sha256: "0".repeat(64) }, "aarch64")).rejects.toThrow("checksum")
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(import.meta.path).arrayBuffer()).digest("hex")
  await expect(verifyArtifact({ path: import.meta.path, sha256: hash }, "aarch64")).rejects.toThrow("ELF")
})

test("an enrolled system service remains a readable registry record", () => {
  const host = { name: "enrolled", ssh: "builder@machine", binary: "/opt/asidee/releases/abc/asd", stateDir: "/var/lib/asidee/1000", machineId: "a".repeat(32), addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched", service: "systemd" } as const
  expect(parseHosts({ version: 1, hosts: [host] }).hosts).toEqual([host])
})

test("the pinned gVisor names the same files for both architectures, each with its own checksum", () => {
  expect(Object.keys(GVISOR.x86_64.files)).toEqual(Object.keys(GVISOR.aarch64.files))
  expect(GVISOR_FILES).toContain("runsc")
  for (const release of [GVISOR.aarch64, GVISOR.x86_64]) {
    expect(release.archive).toMatch(/^[a-f0-9]{128}$/)
    for (const digest of Object.values(release.files)) expect(digest).toMatch(/^[a-f0-9]{64}$/)
  }
  for (const name of GVISOR_FILES) expect(GVISOR.aarch64.files[name]).not.toBe(GVISOR.x86_64.files[name])
})

test("an installation plan declares every changed file, artifact, privilege and restart victim", () => {
  const plan = installationPlan(options, evidence(), client)
  expect(plan.blockers).toEqual([])
  expect(plan.restart).toEqual({ required: true, containers: ["owner-web (123)"], service: false, sandboxes: [] })
  expect(plan.uploads.map((upload) => upload.name)).toEqual(["asd", "gvisor.tar.bz2"])
  expect(plan.uploads[1]).toMatchObject({
    algorithm: "sha512", checksum: GVISOR.aarch64.archive, extract: { directory: "gvisor", files: GVISOR.aarch64.files },
    url: `https://storage.googleapis.com/gvisor/releases/release/${GVISOR_RELEASE}/aarch64/gvisor.tar.bz2`,
  })
  expect(plan.steps.every((step) => step.argv[0] === "sudo" && step.argv[1] === "-n")).toBe(true)
  expect(new Set(plan.steps.map((step) => step.label)).size).toBe(plan.steps.length)
  expect(plan.steps.some((step) => step.argv.includes("--validate"))).toBe(true)
  expect(plan.steps.filter((step) => step.argv.includes("restart")).map((step) => step.argv)).toEqual([["sudo", "-n", "systemctl", "restart", "docker"]])
  // Every file of the runtime is installed from staging into the release's own directory.
  for (const name of GVISOR_FILES) expect(plan.steps.some((step) => step.argv.includes(`${plan.stageDir}/gvisor/${name}`) && step.leaves.includes(`${RUNTIME_DIR}/${name}`))).toBe(true)
  for (const change of plan.changes) {
    expect(change.sha256).toBe(new Bun.CryptoHasher("sha256").update(change.after!).digest("hex"))
    expect(plan.steps.some((step) => step.argv.includes(change.path) && step.argv.includes(`${plan.stageDir}/${change.staged}`) && step.leaves.includes(change.path))).toBe(true)
  }
  expect(plan.steps.some((step) => step.argv.includes("asidee-disk") || step.argv.includes("e2fsprogs"))).toBe(false)
  expect(plan.runtime).toEqual({ name: "asidee-runsc", release: GVISOR_RELEASE, path: `${RUNTIME_DIR}/runsc`, runtimeArgs: ["--allow-suid", "--overlay2=none"], innerDocker: false })
  const { hash, ...content } = plan
  expect(hash).toBe(planHash(content))
  // On x86_64 the other architecture's archive and checksums are planned.
  expect(installationPlan(options, { ...evidence(), arch: "x86_64" }, client).uploads[1]).toMatchObject({ checksum: GVISOR.x86_64.archive, extract: { files: GVISOR.x86_64.files } })
})

test("the Docker option is in the plan and its hash: the runtime entry, the smoke sandbox and what the plan says about it", () => {
  const plain = installationPlan(options, evidence(), client); const docker = installationPlan({ ...options, docker: true }, evidence(), client)
  expect(docker.hash).not.toBe(plain.hash)
  expect(docker.runtime).toMatchObject({ runtimeArgs: ["--allow-suid", "--overlay2=none", "--net-raw"], innerDocker: true })
  const entry = (plan: typeof plain) => JSON.parse(plan.changes.find((change) => change.path === "/etc/docker/daemon.json")!.after!).runtimes["asidee-runsc"].runtimeArgs
  expect(entry(docker)).toContain("--net-raw")
  expect(entry(plain)).not.toContain("--net-raw")
  expect(docker.verification.docker).toBe(true)
  expect(docker.verification.image).toMatch(/^docker:.+@sha256:[a-f0-9]{64}$/)
  expect(plain.verification.docker).toBe(false)
  expect(plain.verification.image).toMatch(/^alpine:.+@sha256:[a-f0-9]{64}$/)
  expect(docker.warnings.join(" ")).toContain("with --net-raw")
  expect(plain.warnings.join(" ")).toContain("does not offer inner Docker")
  // What verification leaves on the host without sudo is in the plan too.
  expect(plain.warnings.join(" ")).toContain(`helper image ${plain.verification.helperImage}`)
  expect(plain.warnings.join(" ")).toContain("firewall tables (inet and bridge asidee_guard)")
  // A host enrolled without it is not complete for a plan that asks for it, and the other way round.
  const upgrade = installationPlan({ ...options, docker: true }, prepared(), client)
  expect(upgrade).toMatchObject({ mode: "install", restart: { required: true, service: true } })
  expect(upgrade.changes.map((change) => change.path)).toEqual(["/etc/docker/daemon.json"])
  expect(installationPlan({ ...options, docker: true }, prepared({ ...options, docker: true }), client)).toMatchObject({ mode: "reuse", steps: [] })
  const downgrade = installationPlan(options, prepared({ ...options, docker: true }), client)
  expect(downgrade.mode).toBe("install")
  expect(downgrade.warnings.join(" ")).toContain("removes --net-raw")
  expect(plain.warnings.join(" ")).not.toContain("removes --net-raw")
})

test("unreadable config, unsafe ancestors, unrelated files and occupied release paths block installation, and sudo never plans no sudo", () => {
  for (const mutation of [
    (p: HostProbe) => { p.files["/etc/docker/daemon.json"] = { kind: "unreadable", error: "permission denied" } },
    (p: HostProbe) => { p.ancestors["/opt/asidee"] = { uid: 1000, mode: 0o777, link: true } },
    (p: HostProbe) => { p.files["/usr/local/bin/asd"] = { kind: "link", uid: 0, mode: 0o777, target: "/usr/bin/other" } },
    (p: HostProbe) => { p.files["/etc/systemd/system/asidee@1000.service"] = file("[Unit]\nDescription=someone else's\n") },
    (p: HostProbe) => { p.files[`/opt/asidee/releases/${"a".repeat(64)}/asd`] = file(null, { sha256: "f".repeat(64) }) },
    (p: HostProbe) => { p.files[`${RUNTIME_DIR}/gvisor-bin/gvisor_sentry`] = file(null, { sha256: "f".repeat(64) }) },
    (p: HostProbe) => { p.files[`${RUNTIME_DIR}/runsc`] = file(null, { sha256: GVISOR.aarch64.files.runsc, uid: 1000 }) },
    (p: HostProbe) => { p.files[`${RUNTIME_DIR}/runsc`] = file(null, { sha256: GVISOR.aarch64.files.runsc, mode: 0o777 }) },
    (p: HostProbe) => { delete p.files[`${RUNTIME_DIR}/runsc`] },
  ]) {
    const probe = evidence(); mutation(probe)
    expect(installationPlan(options, probe, client).blockers.length).toBeGreaterThan(0)
  }
  const never = installationPlan({ ...options, sudo: "never" }, evidence(), client)
  expect(never.steps).toEqual([])
  expect(never.uploads).toEqual([])
  expect(never.changes).toEqual([])
  expect(never.restart.required).toBe(false)
  expect(never.blockers.join(" ")).toContain("Owner setup")
})

test("the owner's own containers do not block enrollment, whatever they are named: the plan lists each one a restart may interrupt", () => {
  const probe = evidence()
  probe.containers.out = '{"Names":"sandbox-owner","ID":"123"}\n{"Names":"owner-web","ID":"456"}'
  const plan = installationPlan(options, probe, client)
  expect(plan.blockers).toEqual([])
  expect(plan.restart).toMatchObject({ required: true, containers: ["owner-web (456)", "sandbox-owner (123)"] })
  expect(plan.warnings.join(" ")).toContain("sandbox-owner (123)")
  // The control: an inventory that cannot be read is what stops an installation.
  const unread = evidence(); unread.containers = { code: 1, out: "", err: "denied" }
  expect(installationPlan(options, unread, client).blockers.join(" ")).toContain("restart impact is unknown")
})

test("what stops an installation does not stop the reuse of one that is already complete", () => {
  // A complete installation on a distribution the install recipe does not cover, with a foreign backup beside it.
  const fedora = (probe: HostProbe) => {
    probe.os = { ID: "fedora" }
    probe.files[`/etc/docker/daemon.json.asidee-${"c".repeat(64)}`] = file(null, { uid: 1000 })
    probe.containers = { code: 1, out: "", err: "denied" }
    return probe
  }
  for (const sudo of ["ask", "never"] as const) expect(installationPlan({ ...options, sudo }, fedora(prepared()), client)).toMatchObject({ mode: "reuse", steps: [], blockers: [] })
  // The control: the same host with nothing installed is refused, for each of those reasons.
  const blockers = installationPlan(options, fedora(evidence()), client).blockers.join(" ")
  for (const reason of ["Only Debian/Ubuntu", "Backup /etc/docker/daemon.json.asidee-", "restart impact is unknown"]) expect(blockers).toContain(reason)
  // With --sudo never nothing would be installed, so only the missing installation is reported.
  const never = installationPlan({ ...options, sudo: "never" }, fedora(evidence()), client).blockers
  expect(never).toHaveLength(1)
  expect(never[0]).toContain("Owner setup")
})

test("a complete earlier installation is reused, and anything missing from it is installed or refused instead", () => {
  expect(installationPlan(options, prepared(), client)).toMatchObject({ mode: "reuse", steps: [], uploads: [], changes: [], authentication: [], blockers: [] })
  expect(installationPlan({ ...options, sudo: "never" }, prepared(), client)).toMatchObject({ mode: "reuse", steps: [], blockers: [] })
  for (const mutation of [
    (p: HostProbe) => { p.unit.out = p.unit.out.replace("UnitFileState=enabled", "UnitFileState=enabled-runtime") },
    (p: HostProbe) => { p.unit.out = p.unit.out.replace("User=alice", "User=alice-other") },
    (p: HostProbe) => { p.unit.out = p.unit.out.replace("ActiveState=active", "ActiveState=inactive") },
    (p: HostProbe) => { p.files["/etc/docker/daemon.json"] = file("{}") },
    (p: HostProbe) => { p.docker.out = JSON.stringify({ Runtimes: {} }) },
    (p: HostProbe) => { p.files[`${RUNTIME_DIR}/runsc`] = { kind: "absent" } },
    (p: HostProbe) => { p.files[`${RUNTIME_DIR}/gvisor-bin/gvisor_sentry`] = { kind: "absent" } },
    (p: HostProbe) => { p.files["/usr/local/bin/asd"] = { kind: "absent" } },
    (p: HostProbe) => { const unit = p.files["/etc/systemd/system/asidee@1000.service"]!; if (unit.kind === "file") unit.text = unit.text!.replace("ASIDEE_SOCKET_ONLY=1", "ASIDEE_SOCKET_ONLY=0") },
  ]) {
    const probe = prepared(); mutation(probe)
    const ask = installationPlan(options, probe, client)
    expect(ask.mode).toBe("install")
    expect(ask.blockers).toEqual([])
    expect(ask.steps.length).toBeGreaterThan(0)
    const never = installationPlan({ ...options, sudo: "never" }, probe, client)
    expect(never.steps).toEqual([])
    expect(never.blockers.join(" ")).toContain("Owner setup")
  }
})

test("only what is missing is planned: a runtime Docker has not loaded restarts Docker without rewriting its file, and another artifact touches neither", () => {
  const unloaded = prepared(); unloaded.docker.out = JSON.stringify({ Runtimes: {} })
  const plan = installationPlan(options, unloaded, client)
  expect(plan.restart.required).toBe(true)
  expect(plan.changes).toEqual([])
  expect(plan.uploads).toEqual([])
  expect(plan.steps.map((step) => step.argv.slice(2).join(" "))).toEqual([
    "install -d -m 0700 -o 1000 -g 1000 /var/lib/asidee/1000 /var/lib/asidee/1000/config", "systemctl restart docker", "systemctl restart asidee@1000.service",
  ])
  const update = installationPlan(other, updated(), client)
  expect(update.mode).toBe("install")
  expect(update.restart.required).toBe(false)
  expect(update.uploads.map((upload) => upload.name)).toEqual(["asd"])
  expect(update.steps.some((step) => step.argv.includes("docker") || step.argv.includes("/etc/docker/daemon.json") || step.argv.some((word) => word.includes("gvisor")))).toBe(false)
  // A service that only lacks permanent enablement is enabled and left running.
  const runtimeOnly = prepared(); runtimeOnly.unit.out = runtimeOnly.unit.out.replace("UnitFileState=enabled", "UnitFileState=enabled-runtime")
  expect(installationPlan(options, runtimeOnly, client).steps.map((step) => step.label)).toEqual(["Create boot-accessible state", "Enable service at boot"])
  // One gVisor file missing: the archive is fetched again and Asidee's own binary is not.
  const partial = prepared(); partial.files[`${RUNTIME_DIR}/gvisor-bin/gvisor_sentry`] = { kind: "absent" }
  expect(installationPlan(options, partial, client).uploads.map((upload) => upload.name)).toEqual(["gvisor.tar.bz2"])
})

test("a plan that restarts the Asidee service names the running sandboxes it stops, and claims a Docker interruption only when it plans one", () => {
  const probe = updated()
  probe.containers.out = JSON.stringify({ Names: "asidee-work", ID: "1", Labels: `com.asidee.name=work,com.asidee.id=${"a".repeat(32)}` }) + '\n{"Names":"owner-web","ID":"2"}'
  const update = installationPlan(other, probe, client)
  expect(update.restart).toEqual({ required: false, containers: ["asidee-work (1)", "owner-web (2)"], service: true, sandboxes: ["asidee-work (1)"] })
  expect(update.steps.at(-1)).toMatchObject({ label: "Restart the Asidee service", argv: ["sudo", "-n", "systemctl", "restart", "asidee@1000.service"] })
  expect(update.warnings.join(" ")).toContain("stops the running sandboxes it watches and does not start them again: asidee-work (1)")
  expect(update.warnings.join(" ")).toContain("No Docker restart is planned")
  const fresh = installationPlan(options, evidence(), client)
  expect(fresh.restart).toEqual({ required: true, containers: ["owner-web (123)"], service: false, sandboxes: [] })
  expect(fresh.steps.at(-1)).toMatchObject({ label: "Start service" })
  expect(fresh.warnings.join(" ")).toContain("owner-web (123)")
  expect(fresh.warnings.join(" ")).not.toContain("No Docker restart is planned")
  expect(fresh.warnings.join(" ")).not.toContain("Restarting the Asidee service")
  expect(installationPlan(options, prepared(), client).warnings.join(" ")).toContain("No Docker restart is planned")
})

test("service restart victims use ownership labels rather than a name prefix", () => {
  const probe = updated()
  probe.containers.out = [
    { Names: "asidee-unrelated", ID: "1", Labels: "app=owner" },
    { Names: "renamed-work", ID: "2", Labels: `com.asidee.name=work,com.asidee.id=${"a".repeat(32)}` },
    { Names: "asidee-probe", ID: "3", Labels: "com.asidee.probe=owner" },
  ].map((row) => JSON.stringify(row)).join("\n")
  const plan = installationPlan(other, probe, client)
  expect(plan.restart.service).toBe(true)
  expect(plan.restart.containers).toHaveLength(3)
  expect(plan.restart.sandboxes).toEqual(["renamed-work (2)"])
})

test("a file diff keeps unchanged lines as context and marks only what changes", () => {
  const before = '{\n  "labels": [\n    "keep"\n  ]\n}\n'
  const probe = evidence(); probe.files["/etc/docker/daemon.json"] = file(before)
  const diff = installationPlan(options, probe, client).changes.find((change) => change.path === "/etc/docker/daemon.json")!.diff.split("\n")
  expect(diff.slice(0, 2)).toEqual(["--- /etc/docker/daemon.json (before)", "+++ /etc/docker/daemon.json (after)"])
  expect(diff).toContain('     "keep"')
  expect(diff).toContain('+    "asidee-runsc": {')
  expect(diff.filter((line) => line.startsWith("-") && !line.startsWith("---"))).toEqual(["-  ]"])
  // A file indented its own way is merged that way, so nothing of it is shown as removed.
  const tabbed = '{\n\t"runtimes": {\n\t\t"other": {\n\t\t\t"path": "/bin/other"\n\t\t}\n\t}\n}\n'
  const merged = lineDiff("/x", tabbed, mergeRuntime(tabbed, "/runsc")).split("\n")
  expect(merged.filter((line) => line.startsWith("-"))).toEqual(["--- /x (before)"])
  expect(merged).toContain(' \t\t\t"path": "/bin/other"')
  expect(merged).toContain('+\t\t"asidee-runsc": {')
  expect(lineDiff("/x", null, "one\ntwo\n")).toBe("--- /x (absent)\n+++ /x (after)\n+one\n+two\n")
  expect(lineDiff("/x", "one\ntwo\nthree\n", "one\nTWO\nthree\n")).toBe("--- /x (before)\n+++ /x (after)\n one\n-two\n+TWO\n three\n")
  // Past the size a line diff is computed for, it says so instead of showing something else as a diff.
  const long = `${Array.from({ length: 2500 }, (_, index) => `line ${index}`).join("\n")}\n`
  expect(lineDiff("/x", long, `${long}more\n`)).toContain("Too long for a line diff")
})

test("a daemon identity this primary already knows is recognised however its file ends", () => {
  const id = "1".repeat(32)
  for (const text of [`${id}\n`, id, `${id}\r\n`]) expect(identityRegistered(file(text), ["0".repeat(32), id])).toBe(true)
  expect(identityRegistered(file(`${id}\n`), ["0".repeat(32)])).toBe(false)
  expect(identityRegistered({ kind: "absent" }, [id])).toBe(false)
  expect(identityRegistered(undefined, [id])).toBe(false)
})

test("the enrollment terminal accepts consent only on the primary and never as a remote sandbox session", () => {
  const input = { kind: "enroll", hash: "a".repeat(64), accepted: true }
  expect(enrollmentHash(input)).toBe(input.hash)
  for (const change of [{ accepted: false }, { hash: "bad" }, { host: "build" }]) expect(() => enrollmentHash({ ...input, ...change })).toThrow()
  expect(() => parseOpen({ ...input, name: "enrollment" })).toThrow()
})

test("Ctrl-C cancels enrollment only while it has no SSH terminal child", () => {
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
    const probe = evidence(); probe.files["/var/lib/asidee/1000/machine-id"] = identity
    expect(installationPlan(options, probe, client).blockers.join(" ")).toContain("machine identity")
  }
})

test("boot service inspection distinguishes permanent enablement and exact account and executable", () => {
  const binary = `/opt/asidee/releases/${"a".repeat(64)}/asd`
  const output = `ActiveState=active\nUnitFileState=enabled\nUser=alice\nSupplementaryGroups=docker\nExecStart={ path=${binary} ; argv[]=${binary} daemon run ; }\n`
  expect(serviceMatches(output, "alice", binary)).toBe(true)
  for (const changed of [
    output.replace("=enabled", "=enabled-runtime"), output.replace("User=alice", "User=alice-other"), output.replace("Groups=docker", "Groups=docker-other"),
    output.replace(`path=${binary} ;`, `path=${binary}-other ;`), output.replace("daemon run", "daemon run --dashboard"),
  ]) expect(serviceMatches(changed, "alice", binary)).toBe(false)
})

test("the managed runtime is preferred over an unrelated gVisor entry that sorts first", async () => {
  const runtimes = {
    "aaa-control": { path: "/control/runsc", runtimeArgs: ["--overlay2=none", "--net-raw"] },
    "asidee-runsc": { path: `${RUNTIME_DIR}/runsc`, runtimeArgs: ["--allow-suid", "--overlay2=none"] },
  }
  const provider = new GvisorProvider(async (argv) => ({
    exitCode: 0, stderr: "",
    stdout: JSON.stringify(argv.includes("info") ? { ID: "fixture", OperatingSystem: "Ubuntu", ServerVersion: "29.1.3", Runtimes: runtimes } : { Name: "default", DockerEndpoint: "unix:///var/run/docker.sock" }),
  }), "enrollment-unit")
  const engines = await provider.detect()
  expect(engines[0]?.data.runtime).toBe("asidee-runsc")
  expect(engines[0]?.capabilities?.docker).toBe(false)
})

test("the installer's report and exit status both have to say it finished", () => {
  const report = (value: object, exitCode = 0) => installOutcome({ exitCode, stdout: JSON.stringify(value), stderr: "" })
  expect(report({ ok: true, completed: ["a", "b"] })).toEqual({ stale: false, completed: ["a", "b"], started: null })
  expect(report({ ok: true, completed: ["a", "b"] }, 77)).toMatchObject({ completed: ["a", "b"], failure: { code: "outcome-unknown" } })
  expect(report({ ok: false, error: "dockerd: bad", completed: ["a"], started: "b" }, 1)).toMatchObject({ completed: ["a"], started: "b", failure: { code: "runtime", message: "Installation failed: dockerd: bad" } })
  expect(report({ ok: false, stale: true, completed: [] })).toEqual({ stale: true, completed: [], started: null })
  expect(installOutcome({ exitCode: 255, stdout: "", stderr: "" })).toBeUndefined()
  expect(installOutcome({ exitCode: 0, stdout: "[]", stderr: "" })).toBeUndefined()
})

test("a failure says what was changed: nothing when no step ran, otherwise what the completed and interrupted steps left", () => {
  const plan = installationPlan(options, evidence(), client)
  const nothing = enrollmentFailure(plan, { completed: [], started: null }, false, new AsideeError("runtime", "Installation failed: asd checksum mismatch; nothing installed"))
  expect(nothing.message).toContain("checksum mismatch")
  expect(nothing.message).toContain("No installation step ran")
  expect(nothing.message).toContain("unregistered")
  expect(nothing.message).not.toContain("retained")
  const partial = enrollmentFailure(plan, { completed: ["Create boot-accessible state", "Create immutable release directory"], started: "Install verified Asidee binary" }, false, new AsideeError("runtime", "Installation failed: bad"))
  expect(partial.code).toBe("runtime")
  for (const text of [
    "unregistered", "Create boot-accessible state", "retained: /var/lib/asidee/1000, /var/lib/asidee/1000/config, /opt/asidee/releases/",
    `Interrupted step: Install verified Asidee binary, which may also have left: ${plan.binary}`, "/var/lib/asidee/1000/enrollment.json", "No automatic rollback",
  ]) expect(partial.message).toContain(text)
  // Steps that never started left nothing, and no smoke sandbox was made.
  for (const text of ["/etc/docker/daemon.json", "/etc/systemd/system", plan.verification.name]) expect(partial.message).not.toContain(text)
  const verifying = enrollmentFailure(plan, { completed: plan.steps.map((step) => step.label), started: null }, true, new AsideeError("check-failed", "Enrollment smoke check kernel was fail; it must pass."))
  expect(verifying.code).toBe("check-failed")
  for (const text of ["Interrupted step: none", plan.verification.name, "asidee_guard", "/etc/docker/daemon.json", `${RUNTIME_DIR}/runsc`]) expect(verifying.message).toContain(text)
  // A long cause keeps its start and end, and what was changed still follows it.
  const long = enrollmentFailure(plan, { completed: ["Create boot-accessible state"], started: null }, false, new AsideeError("runtime", `Installation failed: start ${"x".repeat(5000)} end`))
  expect(long.message.length).toBeLessThan(2500)
  for (const text of ["Installation failed: start", "x end Host is unregistered.", "retained: /var/lib/asidee/1000"]) expect(long.message).toContain(text)
  // Reuse installs nothing, so only what verification can leave is named.
  const reused = enrollmentFailure(installationPlan(options, prepared(), client), undefined, true, new AsideeError("check-failed", "smoke"))
  expect(reused.message).toContain("This run installed nothing")
  expect(reused.message).toContain(plan.verification.name)
  expect(reused.message).not.toContain("Completed steps")
})

test("every final smoke check must pass, net-private may be weak, and inner Docker's exactly when the plan registered it", () => {
  const checks = (docker: string) => CHECKLIST.filter((item) => item.blocking).map((item) => ({ id: item.id, status: item.id === "link-scope" ? "info" : item.id === "docker" ? docker : "pass" }))
  expect(() => requireSmokeChecks(checks("info"), false)).not.toThrow()
  expect(() => requireSmokeChecks(checks("pass"), true)).not.toThrow()
  // Not asked for must not be mistaken for working, nor the reverse.
  expect(() => requireSmokeChecks(checks("info"), true)).toThrow()
  expect(() => requireSmokeChecks(checks("fail"), true)).toThrow()
  expect(() => requireSmokeChecks(checks("pass"), false)).toThrow()
  for (const status of ["fail", "unknown", "unsupported", "weak"])
    expect(() => requireSmokeChecks(checks("info").map((check) => check.id === "kernel" ? { ...check, status } : check), false)).toThrow()
  expect(() => requireSmokeChecks(checks("info").filter((check) => check.id !== "kernel"), false)).toThrow()
  expect(() => requireSmokeChecks(undefined, false)).toThrow()
  // net-private alone may be weak: a stand-in range the host already uses rests on the loaded rules.
  const netPrivate = (status: string) => checks("info").map((check) => check.id === "net-private" ? { ...check, status } : check)
  expect(() => requireSmokeChecks(netPrivate("weak"), false)).not.toThrow()
  for (const status of ["fail", "unknown", "info"]) expect(() => requireSmokeChecks(netPrivate(status), false)).toThrow(/net-private .*expected pass or weak/)
  for (const id of ["net-host", "net-peers", "kernel"]) expect(() => requireSmokeChecks(checks("info").map((check) => check.id === id ? { ...check, status: "weak" } : check), false)).toThrow()
})

test("smoke verification requires the managed runtime, a watched disk, the planned Docker capability and a final result that holds", () => {
  const engine = { id: "gvisor:default", ready: true, data: { context: "default", runtime: "asidee-runsc" }, capabilities: { diskLimit: "watched", docker: false } }
  expect(() => requireSmokeEngine([engine], false)).not.toThrow()
  expect(() => requireSmokeEngine([{ ...engine, capabilities: { diskLimit: "watched", docker: true } }], true)).not.toThrow()
  for (const changed of [
    { ...engine, ready: false }, { ...engine, data: { context: "default", runtime: "aaa-control" } }, { ...engine, capabilities: { diskLimit: "none", docker: false } },
    { ...engine, id: "gvisor:other" }, { ...engine, capabilities: { diskLimit: "watched", docker: true } },
  ]) expect(() => requireSmokeEngine([changed], false)).toThrow()
  expect(() => requireSmokeEngine([engine], true)).toThrow()
  expect(() => requireSmokeEngine({}, false)).toThrow()
  const checks = CHECKLIST.filter((item) => item.blocking).map((item) => ({ id: item.id, status: item.id === "docker" || item.id === "link-scope" ? "info" : "pass" }))
  const verified = { ok: true, diskUsedBytes: 1048576, checks: [...checks, { id: "disk", status: "weak" }] }
  expect(() => requireSmokeVerified(verified, false)).not.toThrow()
  for (const changed of [
    { ...verified, ok: false }, { ...verified, diskUsedBytes: 1048575 }, { ...verified, diskUsedBytes: undefined }, { ...verified, checks },
    { ...verified, checks: verified.checks.map((check) => check.id === "net-host" ? { ...check, status: "unknown" } : check) },
  ]) expect(() => requireSmokeVerified(changed, false)).toThrow()
})

test("startup retries discard failed connections and keep the successful hello connection for smoke calls", async () => {
  const { readyEnrollmentPeer, verificationCall } = await import("../../core/hosts")
  const calls: string[] = []; const closed: number[] = []; let connections = 0
  const hello = { machineId: "a".repeat(32), bootId: "b".repeat(32), sourceDigest: client.sourceDigest, buildDigest: options.artifact.sha256, version: client.version, protocols: [1], methods: [], features: [] }
  const ready = await readyEnrollmentPeer({ ssh: "build", binary: "/bin/asd", stateDir: "/state" }, () => false, () => {
    const id = ++connections
    return { async close() { closed.push(id) }, async call(method) {
      calls.push(`${id}:${method}`)
      if (id === 1) throw new AsideeError("offline", "connect ENOENT /state/daemon.sock")
      return method === "hello" ? hello : []
    } }
  }, async () => {})
  await verificationCall(ready.peer, "engines")
  expect(connections).toBe(2)
  expect(calls).toEqual(["1:hello", "2:hello", "2:engines"])
  expect(closed).toEqual([1])
  await ready.peer.close()
  expect(closed).toEqual([1, 2])
})

test("startup and smoke failures name their calls and preserve their error code and cause", async () => {
  const { readyEnrollmentPeer, verificationCall } = await import("../../core/hosts")
  let attempts = 0; let closed = 0
  try {
    await readyEnrollmentPeer({ ssh: "build", binary: "/bin/asd", stateDir: "/state" }, () => false,
      () => ({ async close() { closed++ }, async call() { attempts++; throw new AsideeError("offline", "connect ENOENT /state/daemon.sock") } }), async () => {})
    throw new Error("accepted")
  } catch (error) {
    expect(error).toMatchObject({ code: "offline" })
    expect((error as Error).message).toContain("startup call hello failed: connect ENOENT")
  }
  expect(attempts).toBe(30); expect(closed).toBe(30)
  for (const method of ["engines", "list", "create", "exec", "verify", "remove"]) {
    await expect(verificationCall({ async close() {}, async call() { throw new AsideeError("outcome-unknown", "lost reply") } }, method)).rejects.toMatchObject({ code: "outcome-unknown", message: `Enrollment verification call ${method} failed: lost reply`, details: { method } })
  }
})

async function updateFixture() {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { Machines, CATALOG } = await import("../../core/machines")
  const { Hosts } = await import("../../core/hosts")
  const root = await mkdtemp(join(tmpdir(), "asd-update-"))
  const dirs = { state: join(root, "s"), config: join(root, "c") }
  await mkdir(dirs.config)
  await writeFile(join(dirs.config, "config.json"), JSON.stringify({ experimental: true }))
  const artifact = join(root, "asd"); await writeFile(artifact, "fake artifact")
  const sha256 = new Bun.CryptoHasher("sha256").update("fake artifact").digest("hex")
  const chosen = { ...options, artifact: { path: artifact, sha256 } }
  const probe = updated(); probe.files[`/opt/asidee/releases/${sha256}/asd`] = { kind: "absent" }
  const machineId = "d".repeat(32)
  probe.files["/var/lib/asidee/1000/machine-id"] = file(`${machineId}\n`)
  const remote = { ...client, machineId, bootId: "e".repeat(32), buildDigest: sha256, protocols: [1], methods: Object.keys(CATALOG), features: [], service: "systemd" as const, listener: "socket-only" as const }
  const previous = { name: options.name, ssh: options.ssh, binary: `/opt/asidee/releases/${options.artifact.sha256}/asd`, stateDir: "/var/lib/asidee/1000", machineId, addedAt: "2026-11-11T00:00:00Z", diskPolicy: "watched" as const, service: "systemd" as const, hostKey: probe.hostKey, hostPublicKey: probe.hostPublicKey, sshUser: "alice" }
  const registry = join(dirs.config, "hosts.json")
  await writeFile(registry, JSON.stringify({ version: 1, hosts: [previous] }))
  let peerFailure: AsideeError | undefined
  const machines = new Machines(dirs, { ...remote, machineId: "f".repeat(32) }, async () => ({ hello: remote, sandboxes: [], checkedAt: new Date().toISOString() }), {
    sshIdentity: async () => ({ user: "alice", hostKey: probe.hostKey, hostPublicKey: probe.hostPublicKey }),
    connectPeer: () => ({ async close() {}, async call(method) { if (peerFailure) throw peerFailure; return method === "hello" ? remote : { ...remote, sandboxes: [] } } }),
  })
  let installs = 0; let verifies = 0; let installFailure = false; let verifyFailure = false
  const hosts = new Hosts(machines, {
    probe: async () => probe, artifact: async () => new Uint8Array(),
    install: async (plan) => { installs++; return { exitCode: installFailure ? 1 : 0, stderr: "", stdout: JSON.stringify(installFailure ? { ok: false, completed: [plan.steps[0]!.label], started: plan.steps[1]!.label, error: "deliberate failure" } : { ok: true, completed: plan.steps.map((step) => step.label) }) } },
    verify: async () => { verifies++; if (verifyFailure) throw new AsideeError("check-failed", "Enrollment verification call verify failed: deliberate failure") },
  })
  return { hosts, machines, chosen, probe, previous, remote, registry, dirs,
    counts: () => ({ installs, verifies }),
    failInstall: () => { installFailure = true }, failVerify: () => { verifyFailure = true },
    failAttach: () => { peerFailure = new AsideeError("offline", "registration hello unavailable") },
    read: async () => JSON.parse(await readFile(registry, "utf8")).hosts,
    cleanup: async () => { await machines.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test("host add reviews an update, requires acceptance, preserves restart victims and replaces the registration only after verification", async () => {
  const f = await updateFixture()
  try {
    f.probe.containers.out = JSON.stringify({ Names: "asidee-soak", ID: "soak-id", Labels: "com.asidee.id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,com.asidee.name=soak" })
    const plan = await f.hosts.plan(f.chosen)
    expect(plan).toMatchObject({ mode: "update", previousHost: f.previous, blockers: [], restart: { required: false, service: true } })
    expect(plan.restart.sandboxes.join(" ")).toContain("soak")
    expect(plan.changes.some((change) => change.path === "/etc/docker/daemon.json")).toBe(false)
    expect(f.counts()).toEqual({ installs: 0, verifies: 0 })
    await expect(f.hosts.apply({ hash: plan.hash })).rejects.toThrow("accepted:true")
    expect(await f.read()).toEqual([f.previous])
    const host = await f.hosts.apply({ hash: plan.hash, accepted: true })
    expect(host).toMatchObject({ binary: plan.binary, machineId: f.previous.machineId, addedAt: f.previous.addedAt })
    expect(await f.read()).toEqual([host])
    expect(f.counts()).toEqual({ installs: 1, verifies: 1 })
  } finally { await f.cleanup() }
})

test("update planning refuses another machine, another host key and another state directory before installation", async () => {
  for (const change of ["identity", "key", "state"] as const) {
    const f = await updateFixture()
    try {
      if (change === "identity") f.probe.files["/var/lib/asidee/1000/machine-id"] = file("1".repeat(32))
      if (change === "key") f.probe.hostPublicKey = "different key"
      if (change === "state") f.probe.uid = 1001
      await expect(f.hosts.plan(f.chosen)).rejects.toMatchObject({ code: "identity-changed" })
      expect(f.counts()).toEqual({ installs: 0, verifies: 0 })
      expect(await f.read()).toEqual([f.previous])
    } finally { await f.cleanup() }
  }
})

test("changed registry or inventory invalidates update consent and performs no installation", async () => {
  for (const change of ["registry", "inventory"] as const) {
    const f = await updateFixture()
    try {
      const plan = await f.hosts.plan(f.chosen)
      if (change === "inventory") f.probe.containers.out = JSON.stringify({ Names: "new", ID: "new" })
      else await Bun.write(f.registry, JSON.stringify({ version: 1, hosts: [{ ...f.previous, addedAt: "2026-11-12T00:00:00Z" }] }))
      await expect(f.hosts.apply({ hash: plan.hash, accepted: true })).rejects.toThrow("Consent is stale")
      expect(f.counts()).toEqual({ installs: 0, verifies: 0 })
    } finally { await f.cleanup() }
  }
})

test("failed installation, smoke verification and registration preserve the old record and name the update command", async () => {
  for (const fail of ["install", "verify", "attach"] as const) {
    const f = await updateFixture()
    try {
      const plan = await f.hosts.plan(f.chosen)
      if (fail === "install") f.failInstall()
      if (fail === "verify") f.failVerify()
      if (fail === "attach") f.failAttach()
      try { await f.hosts.apply({ hash: plan.hash, accepted: true }); throw new Error("accepted") }
      catch (error) {
        expect((error as Error).message).toContain("Existing registration retained")
        expect((error as Error).message).toContain(`asd host add build --ssh alice@build --artifact '${f.chosen.artifact.path}' --sha256 ${f.chosen.artifact.sha256}`)
        expect((error as Error).message).not.toContain("Host is unregistered")
      }
      expect(await f.read()).toEqual([f.previous])
    } finally { await f.cleanup() }
  }
})

test("real enrollment verification waits for hello and uses that connection through smoke cleanup", async () => {
  const { Hosts } = await import("../../core/hosts")
  const f = await updateFixture(); const calls: string[] = []; let connections = 0; const closed: number[] = []
  try {
    const hosts = new Hosts(f.machines, {
      probe: async () => f.probe, artifact: async () => new Uint8Array(), pause: async () => {},
      install: async (plan) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ ok: true, completed: plan.steps.map((step) => step.label) }) }),
      inspectService: async (plan) => ({ exitCode: 0, stderr: "", stdout: `User=alice\nSupplementaryGroups=docker\nActiveState=active\nUnitFileState=enabled\nExecStart={ path=${plan.binary} ; argv[]=${plan.binary} daemon run ; }` }),
      connect: () => {
        const id = ++connections
        const checks = CHECKLIST.filter((item) => item.blocking).map((item) => ({ id: item.id, status: item.id === "docker" || item.id === "link-scope" ? "info" : "pass" }))
        return { async close() { closed.push(id) }, async call(method) {
          calls.push(`${id}:${method}`)
          if (id === 1) throw new AsideeError("offline", "connect ENOENT daemon.sock")
          switch (method) {
            case "hello": return f.remote
            case "engines": return [{ id: "gvisor:default", ready: true, data: { runtime: "asidee-runsc" }, capabilities: { diskLimit: "watched", docker: false } }]
            case "list": return []
            case "create": return { checks }
            case "exec": return { exitCode: 0 }
            case "verify": return { ok: true, checks: [...checks, { id: "disk", status: "weak" }], diskUsedBytes: 1048576 }
            case "remove": return {}
            default: throw new Error(`unexpected ${method}`)
          }
        } }
      },
    })
    const plan = await hosts.plan(f.chosen)
    await hosts.apply({ hash: plan.hash, accepted: true })
    expect(calls).toEqual(["1:hello", "2:hello", "2:engines", "2:list", "2:create", "2:exec", "2:verify", "2:remove"])
    expect(closed).toEqual([1, 2])
    expect(connections).toBe(2)
  } finally { await f.cleanup() }
})

test("the enrollment smoke sandbox has no links, so link-scope is informational rather than a measured pass", () => {
  const checks = CHECKLIST.filter((item) => item.blocking).map((item) => ({ id: item.id, status: item.id === "link-scope" ? "info" : "pass" }))
  expect(() => requireSmokeChecks(checks, true)).not.toThrow()
  for (const status of ["fail", "unknown", "unsupported", "weak"])
    expect(() => requireSmokeChecks(checks.map((check) => check.id === "link-scope" ? { ...check, status } : check), true)).toThrow()
  expect(() => requireSmokeChecks(checks.map((check) => check.id === "kernel" ? { ...check, status: "info" } : check), true)).toThrow()
})

test("B7: every step consuming staged files checks a private copy before use", () => {
  const plan = installationPlan(options, evidence(), client)
  const consuming = plan.steps.filter((step) => step.argv.some((arg) => arg.startsWith(`${plan.stageDir}/`)))
  expect(consuming.length).toBeGreaterThan(0)
  for (const step of consuming) {
    expect(step.argv.slice(0, 4)).toEqual(["sudo", "-n", "python3", "-c"])
    expect(step.argv[4]).toContain("tempfile.mkdtemp")
    expect(step.argv[4]).toContain("checksum mismatch")
  }
})
