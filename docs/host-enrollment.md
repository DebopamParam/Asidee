# Enroll a Linux host

Build both artifacts explicitly from the same source tree. Choose the Linux target from the destination's architecture.
`host add` never builds an artifact. These examples use arm64; use `bun-linux-x64` for x86_64.

```sh
bun build --compile --minify --outfile dist/paddock cli/cli.ts
bun build --compile --minify --target=bun-linux-arm64 --outfile dist/paddock-linux cli/cli.ts
shasum -a 256 dist/paddock-linux
dist/paddock host add build --ssh alice@linux --artifact "$PWD/dist/paddock-linux" --sha256 HASH --json
```

The checksum is an explicit trust decision about your artifact, not a signed release manifest. Keep the binary at that
path until apply finishes. SSH must already trust the host. The read-only probe requires Python 3, glibc and systemd.
The installation recipe accepts Debian, Ubuntu and Linux Mint based on Ubuntu noble. Only the combinations in the
scorecard have installation measurements. If Docker already exists, its socket and configuration must be readable to
plan a runtime change. The probe never uses sudo. If Docker is absent, usable signed apt metadata must already exist;
refreshing apt metadata is an owner preparation step. Enrollment does not add a repository or key.

Read the plan's exact command vectors, before/after contents, diffs, hashes, staged paths, downloads, package versions,
service unit, restart victims, verification and blockers. Duration is unknown. Disk limits are watched. No hard disk
helper, disk tools or sudoers rule is installed. The named runtime has `--allow-suid` and `--overlay2=none`, without
`--net-raw`; it does not offer inner Docker. A pre-existing runtime may offer that capability separately.

For interactive enrollment, run the same command without `--json` and enter the literal word `yes`. If installation
needs sudo, its password prompt travels over the private daemon stream to the same SSH terminal used by the installer.
The password is not part of the JSON API body, plan or journal. Ctrl-C during verification cancels enrollment, waits
for smoke cleanup and returns 130 with the terminal restored. Completed installation changes stay for inspection;
no host is registered. Automation uses the reviewed hash:

```sh
dist/paddock host add build --ssh alice@linux --artifact "$PWD/dist/paddock-linux" --sha256 HASH --accept-plan PLAN_HASH
```

Automation needs noninteractive sudo for the declared operations. `--json` always prints a plan and applies nothing,
even with `--accept-plan`. A changed file, artifact, machine identity, package recipe or container inventory invalidates
consent. Apply probes again after delivery and terminal authentication, before the first installation step. Review the
revised plan and use its new hash. A plan is held by the primary daemon; restarting that daemon expires its stored plans.

`--sudo never` can reuse a compatible, enabled and active system service in the enrolled layout with the supplied
artifact. It installs no user unit, even when lingering is enabled. Unverified user-service boot behavior is not grounds
for unattended enrollment. `host attach` remains available for other prepared layouts. Reuse still creates, verifies
and removes the smoke sandbox before registration.

A successful installation has these objects:

- `/opt/paddock/releases/HASH/paddock`, root-owned, selected by `/usr/local/bin/paddock`.
- `/opt/paddock/gvisor/20251110.0/runsc`, verified against a pinned SHA-512 before installation.
- One `runtimes.paddock-runsc` entry in `/etc/docker/daemon.json`. Other settings stay. A content-addressed backup
  precedes replacement, and `dockerd --validate` precedes the write. A runtime change plans a Docker restart with
  every running container named, including containers with live restore.
- `/etc/systemd/system/paddock@UID.service`, running as the SSH user with `SupplementaryGroups=docker`, a fixed PATH,
  socket-only access, `Restart=on-failure` and journal logging. Docker access is effectively host-root authority.
  Login group membership stays unchanged.
- `/var/lib/paddock/UID`, owned by the SSH user, mode 0700, with configuration in `config/` and the installation journal
  in `enrollment.json`. The journal records the plan hash, file contents/hashes, completed steps and the step in progress.

The primary registers the host only after inspecting the enabled service and matching the daemon's source, version,
protocol, binary digest and listener. Smoke verification needs every applicable blocking check, a real disk write and
host-side disk measurement, followed by successful sandbox removal. The pinned sandbox image and core helper are
shown in the plan. Boot enablement is inspected; reboot persistence and automatic sandbox recovery are not measured.

On failure, read the reported completed steps, possible interrupted step and retained paths. An SSH loss can leave an
unknown outcome. Inspect the destination journal before retrying. Shared packages and data are never rolled back
automatically. Repeating the same successful installation reuses the service; a partially installed machine may need
owner-provided Docker access before a complete restart-impact plan can be made.

## Remove the registration and uninstall manually

`paddock host remove build --confirm build` forgets only primary resources. It leaves the remote installation, service,
sandboxes, packages, runtime, images and logs. Uninstall is an explicit owner operation, separate from host removal.

On the remote machine, first remove that daemon's sandboxes and templates through Paddock. Record its UID, state path,
installed binary digest and unit contents from the saved plan and `enrollment.json`. Then:

1. Stop and disable exactly `paddock@UID.service` with `sudo systemctl disable --now paddock@UID.service`.
2. Check that no container still uses `paddock-runsc` and no other runtime entry references its binary. Inventory every
   running container before any Docker restart. Do not change an engine hosting `sandbox-*` containers.
3. Back up the current `/etc/docker/daemon.json`. Remove only `runtimes.paddock-runsc`, preserving every other key.
   Validate the candidate with `sudo dockerd --validate --config-file CANDIDATE`, install it and restart Docker only
   after reviewing that interruption. Restore a prior whole file only if its current hash still matches the installation's
   recorded write. A newer unrelated edit must not be overwritten.
4. Compare the installed unit and binary hashes with the saved plan. Remove the matching unit and its matching
   `/usr/local/bin/paddock` symlink, then run `sudo systemctl daemon-reload`. Remove the matching release directory
   and the pinned gVisor directory only after confirming no other service or runtime uses them.
5. Delete `/var/lib/paddock/UID` only after deciding what sandbox data, configuration and journal to retain. Remove
   verified Paddock backup files and any reported staging directory/request file separately.
6. Remove unused Paddock helper images, labelled containers, networks and volumes only after checking that no other
   Paddock daemon uses them. Packages, ordinary SSH configuration, known-host trust and system journal logs are shared
   owner resources and stay unless the owner explicitly removes them.

The N enrollment evals use disposable OrbStack machines only. They test installation and sudo paths without touching
the Mac's Docker configuration or the routing fixture's system files. Delete the fixture machines after the run.
