# Machines, bounded disks, forwards, and editor access

Design proposal for stage 4 and the remote parts of stages 1b, 1d, and 2.
The goal is to keep checks beside the engine when the laptop sleeps, with access through existing SSH credentials.
Sections still marked proposed describe later work. The enrollment implementation record below and
[architecture](../architecture.md#reviewed-host-enrollment) describe the current code and its measured limits.

## Rulings on this proposal (binding where they differ from the text below)

- **Accepted:** a daemon per machine reached over SSH to its socket; `--host` routing; daemon-owned streams replacing
  `attach` argv; forwards bound by the primary daemon on loopback; the editor alias through the same stream; the
  reviewed `host add` plan; the build order in section 8.
- **Simplified, first version:** no signed release channel (`--artifact PATH --sha256 HASH` built locally is enough);
  one Linux recipe (Debian/Ubuntu with systemd); the forward lease may start as "ends when the stream or the sandbox
  ends" without a heartbeat if the evals show that bound holds.
- **Not accepted as written:** the read-only root with every writable directory seeded onto one disk (section 3). It
  is the riskiest part and is not needed to be honest. First version of hard mode: the reference's two capped disks
  (home, inner Docker data) with the rest of the root still measured by the watcher, reported as exactly that
  ("hard for home and Docker data, watched for the system"). The bounded layout stays a later option behind its spike.
- **Decided in stage 4 review:** two machines talk only when version, protocol 1 and source digest are equal; there
  is no protocol negotiation and no upgrade, and the refusal says how to rebuild the other machine. The artifact digest
  is reported, not compared, because it differs per platform. A forward lease is renewed in both directions (five
  seconds, fifteen-second expiry). Hosted forwards have no check on the primary; `paddock --host HOST forward list` is
  their evidence there (section 6's "primary listener inspection" is not built). `hosts.json` is read per record, so a
  record a later `host add` writes is refused alone, not the file.

## Evidence and scope

Paddock source was read at commit `c8bc74d764c8446f83957e415fdd81b436a43774` using `git show HEAD:path`.
This avoids depending on another agent's concurrent Docker-inside edits.
The reference files were read from the working tree. Their historical measurements are reference reports, not Paddock results.
No engine commands, evals, remote connections, builds, or installation steps were run during that original review.
The enrollment implementation record below adds later measurements.
All external behavior not established by those sources is marked **unverified**, with assumptions collected below.

| Source | Observed constraint |
|---|---|
| [Migration plan](../migration-plan.md) | Core alone touches engines. Remote access uses SSH to machine-local daemon sockets. No engine port publishing. |
| [Daemon](../../core/daemon.ts), `methods`, `createHandler` | JSON POST API. `attach` and `shutdown` are socket-only. Dashboard uses loopback TCP, token, and Host validation. |
| [Core](../../core/core.ts), `exclusive`, `enforce` | Per-name serialization. Enforcement every 30 seconds, four unchecked blocking passes before stopping. |
| [State](../../core/state.ts), [types](../../core/types.ts) | Per-user manifests. Names have no dots or colons. Capabilities currently describe one disk-limit mode. |
| [gVisor](../../core/providers/gvisor.ts), `detect`, `configChecks` | Only local engine endpoints. All ordinary bind mounts fail `mounts`. Runtime needs `--overlay2=none` for watched writes. |
| [CLI](../../cli/cli.ts), `ensureDaemon`, `shell` | Replaces a different local build automatically. Runs engine argv returned by `attach`. Exec buffers text. |
| [Reference remote](../../../sandbox-manager/src/remote.ts) | SSH translates engine commands. Loop ext4 caps home and inner Docker, leaving system writes outside those caps. |
| [Reference forwards](../../../sandbox-manager/src/forwards.ts) | Local SSH listeners tracked by PID. Supports LAN publication, which this design excludes. |
| [Reference watchdog](../../../sandbox-manager/src/watchdog.ts), [lease](../../../sandbox-manager/src/dashboard-lease.ts) | Enforcement depends on a dashboard. Paddock must keep its daemon-owned enforcement instead. |
| [Reference guide](../../../sandbox-manager/docs/sandbox-guide/our-implementation.md) | Describes cron recovery, guard-before-start, proxy SSH, and historical Linux tests. |

Keep the Docker-inside option owned by its separate change. Add capabilities and checks without copying its unfinished implementation.
Do not import existing reference sandboxes, install a second dashboard, or introduce a remote Docker context.

## 1. A machine owns its daemon and evidence

Recommend one designated Paddock service account per engine-bearing machine.
Multiple login accounts may exist, but v1 refuses a second owner using engine ID and an atomically created, owner-labelled `paddock-owner` volume.
This detects accidental duplicate enrollment; an engine administrator can bypass it. Its race behavior is **unverified U12**.
The primary daemon also acts as a client gateway. It does not enforce another machine's sandboxes.
A primary with no engine can still run this gateway and the existing web dashboard.

### Routing and identity

| CLI usage | Meaning |
|---|---|
| `paddock list` | Local machine only, preserving current behavior. |
| `paddock list --all` | One result per registered machine, including failed or stale machines. |
| `paddock --host build create demo ...` | Run on the daemon registered as `build`. |
| `paddock --host build shell demo` | Interactive session executed by that daemon's provider. |
| `paddock --host build exec demo --stream -- COMMAND ...` | Binary-safe streamed exec through the daemon. |
| `paddock --host build daemon status` | Remote service status, without automatic installation or replacement. |
| `paddock --host build daemon stop` | Explicit socket-only shutdown through SSH. Stops watched sandboxes there. |
| `paddock ui --open` | Open the primary dashboard, which groups all registered machines. |

Use `--host`, not a prefix inside sandbox names. Unqualified names always mean local, even when absent locally.
There is no global name search, implicit fallback, or broadcast mutation.
Display remote identities as `build/demo`. API identity is `{machineId, sandboxId}`; display names are not identity.
`local` is reserved. Host aliases use the existing sandbox-name grammar and cannot be renamed in v1.
Two machines can each own `demo`. Re-adding an alias cannot silently target a different machine or sandbox generation.
Engine IDs remain scoped to their machine. A remote `gvisor:default` is never resolved on the primary.

### The SSH transport

1. CLI calls the primary Unix socket with an optional registered `host` field in its request envelope.
2. The gateway resolves that alias from its own registry, validates the method, and opens outbound SSH.
3. It executes the fixed installed command `paddock transport stdio --protocol 1` on the target, with no SSH PTY.
4. That command only relays bytes to its configured local daemon socket. It cannot start or replace the daemon.
5. The gateway sends the target's ordinary HTTP request over that stream, with no `host` routing field.
6. The target core validates the request again and operates its local provider. Results retain their machine identity.

Use absolute installed executable paths and POSIX shell quoting for the fixed remote command.
Never construct an SSH command from sandbox argv. Exec argv travels in the request body as an array.
Reject option-like SSH destinations and config fragments. `DEST` is an SSH alias or `user@hostname`, not a command.
SSH config handles custom ports and jump hosts. Keep normal host-key verification, with no agent, X11, or SSH forwarding.
Use isolated connections with `ForwardAgent=no`, `ClearAllForwardings=yes`, and no inherited shared control master.
Ordinary SSH behavior and option support on target clients remain **unverified U1**.
No TCP port, daemon token, or machine login key is added. The SSH user already has authority to open that Unix socket.
The target has no reference to the primary socket and cannot send unsolicited RPCs through the response stream.

### Dashboard availability and state

| State | Owner and behavior |
|---|---|
| Host registry | Primary `CONFIG/hosts.json`, mode 0600, written atomically by the primary daemon. |
| Machine identity | Random persistent ID in each daemon's state directory. Bound at host enrollment. |
| Sandboxes, locks, checks, stop reasons | Only the machine with the engine. No primary copy is authoritative. |
| Latest summaries | Primary memory cache with receipt time, target check time, machine ID, and boot ID. |
| Remote failure | Show `offline`, `connecting`, `incompatible`, or `identity-changed` beside the machine. |
| Cached sandbox row | Show last-known state and age. Never present its old green checks as current evidence. |
| Primary unavailable | Remote daemon continues enforcement. Only primary-side forwards and UI disappear. |

`fleet` returns the current cache immediately and schedules refreshes independently per machine.
Proposed budgets are 5 seconds to connect and 10 seconds for a summary, with capped exponential retry up to 60 seconds.
These are design targets, not measured latency claims. Manual refresh retries one machine without blocking another.
Do not reuse those short budgets for create, verify, or streams. Those report progress and have explicit cancellation semantics.
An offline mutation fails against its selected machine. A timeout after sending a mutation reports `outcome-unknown`.
Never automatically replay such a mutation. Reconcile with `get` and a subsequent explicit user action.
Each dashboard action, form, expanded checklist, and busy key includes the machine ID and sandbox ID.
Rendering uses text nodes for remote strings. Remote extension descriptors are data, never HTML or local executable instructions.
Cap JSON replies at 8 MiB and validate their schemas. Oversized or malformed replies fail that machine's refresh without replacing its cache.
Remote extension actions execute on the remote daemon's machine. Nothing returned by it executes on the primary.

### Versions, service recovery, and socket authority

- Replace mtime-based remote build comparisons with an immutable artifact digest plus a separate wire-protocol version.
- Handshake returns supported protocol versions, methods, feature flags, machine ID, boot ID, version, and build digest.
- Select a common protocol. Missing features are unavailable. Unsupported protocol means `incompatible`, never auto-upgrade.
- Retrieve each machine's checklist catalog. Unknown check IDs remain visible with their remote title and evidence.
- A dashboard TCP request stays a dashboard request after routing. The gateway checks method access before opening SSH.
- Socket transport is authority for a CLI caller, not a way for a browser to gain socket-only abilities.
- Make a shared typed method catalog define `dashboard`, `socket`, and `bootstrap` access. Reject unknown methods by default.
- `attach`, stream opening, shutdown, host changes, and installation remain socket-only. Do not expose a generic RPC proxy.
- Remote service shutdown must stop the service, not trigger an immediate supervisor restart. Use `Restart=on-failure`.
- Managed services replace the CLI's current automatic build-replacement path. Upgrades require an explicit host plan.

The daemon starts with sweep, disk reconciliation, and an enforcement pass before accepting sandbox mutations.
Keep Docker restart policies disabled. No cron job or second process restarts sandboxes outside `Core.startChecked`.
Persist `desiredState` and a separate safety-stop latch. Explicit stop and every enforcement stop clear running intent first.
After a machine reboot, recover previously requested running sandboxes through the checked start path, one at a time.
OOM, task-limit exits, failed checks, and repeated recovery failures latch stopped until an explicit start.
Use at most one recovery attempt per five minutes per sandbox. Never infer intent merely from a stopped container.
Reboot and external-exit classification are **unverified U2**. Default to stopped when the reason is ambiguous.
Service restart reduces a crash gap; it does not prove continuous enforcement during the gap.

### Attach and exec become daemon streams

Retire `{argv: string[]}` from `attach` for all clients. Migrate local and remote shell together.
The core starts the engine session. The CLI only handles the terminal and the daemon stream.
Preserve buffered `exec` for existing JSON clients, with a bounded output size and a clear overflow error.
`exec --stream` keeps stdout and stderr separate without decoding arbitrary binary data.
`shell` requests a TTY; it sends terminal size and resize events, and restores local terminal settings on every exit.
SSH itself uses `-T`; the guest TTY is owned by the target provider, never by an extra SSH terminal.

Use a Unix-socket HTTP upgrade, `POST /api/session`, followed by `paddock-stream/1` frames.
Each frame has a one-byte kind, a four-byte network-order payload length, and at most 64 KiB of payload.
Kinds are `stdin`, `stdout`, `stderr`, `eof`, `resize`, `exit`, and `error`; resize and exit have bounded JSON payloads.
TTY output uses stdout only. Half-close sends `eof` while output continues. Stream errors are distinct from exit status.
Apply backpressure in both directions and a bounded queue. A slow reader cannot make a daemon buffer unlimited output.
One SSH process per active stream avoids one stalled stream blocking fleet polls or another session.
On disconnect, close the stream and report a lost session. Do not replay commands or pretend to recover their exit status.
TTY Ctrl-C travels as terminal input. Non-TTY disconnect does not promise to kill the command; it may keep running.
Stop and remove explicitly close all sessions for that sandbox generation.
Provider implementation uses the local engine exec API for TTY creation, stream demultiplexing, and resize.
Unix upgrade support, engine exec behavior, and Bun framing/backpressure are **unverified U3** and require an early spike.

## 2. Host enrollment is a reviewed installation plan

`paddock host add build --ssh alice@linux` first probes read-only, prints the exact plan, and waits for an explicit `yes`.
An unknown outer SSH host key must be accepted through SSH's normal trust flow before enrollment proceeds.
V1 supports native Linux x86-64 and arm64, systemd, and audited Debian/Ubuntu installation recipes only.
Other distributions can attach to an already prepared daemon; automatic package installation refuses unknown recipes.
Architecture, libc, package, and systemd compatibility are **unverified U4**.

| Plan entry shown before consent | Recommended operation and privilege |
|---|---|
| Destination and identity | Show resolved SSH user, host-key fingerprint, OS, architecture, machine ID if present, engine, and current containers. |
| Paddock | Copy checksum-verified release binary to a user staging file, then `sudo install` into `/opt/paddock/releases/<digest>/paddock`. |
| Command path | Root-owned `/usr/local/bin/paddock` selects that release. Preserve an existing unrelated executable by refusing replacement. |
| Docker if missing | Show exact version, apt repositories, keys, package list, downloads, and `sudo apt-get ...` recipe before executing it. |
| Docker authority | System unit uses `SupplementaryGroups=docker`. Show that Docker access is effectively host-root authority. No hidden group edits. |
| gVisor | Install pinned checksum-verified `runsc` under `/opt/paddock/gvisor/<release>/runsc` with `sudo install`. |
| Runtime registration | Back up and merge one named `runtimes.paddock-runsc` entry in `/etc/docker/daemon.json` with sudo. Preserve unrelated settings. |
| Docker restart | If registration changes, include `sudo systemctl restart docker` and the names of every running container it can interrupt. |
| Hard disk helper (stage 1d, excluded from host add) | Later: install root-owned `/usr/local/libexec/paddock-disk` and a narrowly scoped sudoers file. Only for the hard-disk choice. |
| Disk tools (stage 1d, excluded from host add) | Later: show installation of `e2fsprogs`, `util-linux`, and mount support, with each sudo package operation listed. |
| State | `sudo install -d` creates `/var/lib/paddock/<uid>` owned by the service user, mode 0700. Config lives in its `config/`. |
| Service | Install `/etc/systemd/system/paddock@<uid>.service`, run sudo daemon-reload and enable/start. Log to the journal. |
| Verification | Show the temporary sandbox, image digest, size, network probes, disk probe, cleanup, and expected duration as unknown. |

Print the complete argv, file content diffs, hashes, and package recipe, not just the categories in this table.
The plan must include every sudo invocation, including validation, rollback, and verification helper calls.
Never restart Docker automatically because a probe failed. If no runtime change is needed, plan no restart.
Treat all running containers as potentially interrupted even when Docker advertises live restore.
Runtime-reload alternatives and actual interruption behavior are **unverified U5**; v1 conservatively plans a restart.
Select `--allow-suid` and `--overlay2=none`; add `--net-raw` only when the selected Docker-inside capability requires it.
Validate the combination against the current core's runtime policy. Do not change the default runtime or enable unsafe host features.

### Delivery and approval

Build immutable artifacts with `bun build --compile` per Linux architecture from one source revision.
Release metadata maps target triple to version, source commit, SHA-256, and protocol range.
Prefer published artifacts authenticated by a pinned release signing key; that key verifies software, not machine login.
No release channel or signing setup exists in the read package metadata. Availability is **unverified U6**.
Until releases exist, accept an explicit `--artifact PATH --sha256 HASH`; never cross-compile implicitly during host add.
Verify the artifact on the primary before copying, then recompute its checksum on the destination before installation.
A checksum from the same untrusted download is not independent provenance. Record the trusted manifest or explicit artifact source.
The final plan hash covers destination identity, exact artifacts, sudo steps, restart impact, paths, and disk choice.
`host.apply` requires that hash and `accepted: true`, then revalidates the inputs before any mutation.
Changed runtime config or container inventory invalidates consent and produces a revised plan.
Interactive CLI requires the word `yes`. `--json` prints the plan without applying it; automation uses explicit `--accept-plan HASH`.
Sudo authentication is handled by the user's terminal, never an API body, manifest, or log. Refusal leaves the host unregistered.

Prefer the system unit running as the SSH user over a user unit with lingering.
Its binary and service definition are root-owned; its state is user-owned; only the disk helper runs with sudo.
Use `Restart=on-failure`, an explicit PATH, and an accessible state path outside an encrypted home.
Order after Docker and require helper reconciliation before any sandbox start. Do not run the whole daemon as root.
User-unit lingering is an alternative for an owner-managed machine, but needs its own boot/session verification.
With `--sudo never`, reuse a prepared daemon or install a user unit only if lingering is already enabled and verified.
Otherwise refuse unattended enrollment before installing anything and show the owner-required service setup.
With no disk-helper permission, offer `--disk-policy watched`. Never silently downgrade an approved hard-cap plan.
Watched mode still needs measurable gVisor writes and existing Docker access. Lack of sudo does not imply Docker is safe.

### Completion, retry, and removal

Journal completed installation steps and previous file hashes on the destination, separate from sandbox manifests.
Installation is idempotent. A retry reconciles the same artifact and plan instead of appending units or sudoers entries.
Write the primary host registry only after daemon handshake, engine readiness, boot-service inspection, and smoke verification succeed.
Smoke verification creates and deletes one isolated temporary sandbox. Reboot persistence stays unmeasured until a reboot eval runs.
If verification fails, report completed steps and residual files. Do not uninstall shared packages or delete user data as rollback.
Restore prior config or service links only if their hashes still match this installation's writes.

| Command | Result |
|---|---|
| `paddock host list [--json]` | Aliases, destination, ID, version, service mode, disk policy, last contact, and connection state. |
| `paddock host remove build --confirm build` | Forget the primary registry entry, cached rows, generated aliases, and primary forwards for this host. Works offline. |
| `paddock host upgrade build [--artifact PATH --sha256 HASH]` | Produce a new reviewed installation plan. Apply only after consent to that plan. |

Remove leaves remote Paddock, its service, checks, sandboxes, images, disks, runtime registration, packages, and logs intact.
It also leaves ordinary SSH config and known-host trust intact. Explain these leftovers before confirmation.
It does not revoke the SSH user's access. Remote uninstall is a separate future operation, not a surprise flag on remove.

### Enrollment implementation record

`host add`, `hostPlan` and `hostApply` now implement the system-service path. N01 through N13 are the outside
measurements; see the scorecard for the source revision and actual results. The changes below override the proposal
where they differ. [Enrollment instructions](../host-enrollment.md) contain the commands and manual uninstall steps.

| Choice or deviation | Reason and evidence |
|---|---|
| Explicit native Linux ELF and SHA-256 only; no implicit build or release channel | U6 remains conservative. Both endpoints check the artifact; N04 refuses a wrong primary checksum and N11 changes one uploaded byte to prove destination refusal. N06 checks the installed artifact digest and daemon source. |
| gVisor `20251110.0`, with pinned SHA-512 per architecture | This point release is a single-file runtime. Newer gVisor distributions require sidecar delivery, which is not assumed here. The actual arm64 binary and embedded helper run in the disposable fixture. Release signing and a modern multi-file delivery channel remain unverified U6. |
| Watched disk policy only; no disk helper, disk packages or sudoers entry | Stage 1d is separate. N02 inspects the plan and N06 writes bytes, obtains an engine-side measurement and requires applicable blocking checks. |
| Runtime has `--allow-suid` and `--overlay2=none`, without `--net-raw` | Enrollment selects an ordinary sandbox capability. Inner Docker is unavailable on this runtime rather than claiming an unmeasured capability. No default-runtime change is made. |
| Existing Python 3 and usable signed apt cache are prerequisites | The probe must not install tools or refresh indexes before consent. An empty or unreadable recipe refuses before installation. Existing Docker access must be readable to enumerate restart impact. |
| Show existing repository contents and hash sources, keys and indexes; download the exact resolved .deb set and use `dpkg --install` | `apt-get --no-download` did not consume the staged local archives on the fixture. Direct installation avoids another dependency resolution or undeclared download after consent. N08 checks every installed version and unchanged login groups. No repository or key is added. |
| Debian/Ubuntu recipe also accepts Linux Mint based on Ubuntu noble | The owner's routing machine is Mint 22.3, an Ubuntu-noble derivative. Its read-only plan is measured; privileged Mint installation is not. Other distributions refuse automatic installation. |
| System unit as SSH user; `--sudo never` only reuses a verified enabled system service | User-unit lingering and logout/reboot behavior remain unmeasured. No unattended service is installed from that assumption. A prepared service in another layout can use `host attach`. N04 refuses installation; N07 proves prepared reuse without sudo or restart. |
| One primary socket terminal session carries interactive sudo and installation over the same SSH PTY | A separate `ssh sudo -v` cannot authorize another session with tty-scoped sudo timestamps. N10 first refuses a noninteractive sudo control, then supplies a disposable password through the terminal and completes enrollment with `timestamp_type=tty`. Passwords are absent from plan and journal. |
| Cancel raw terminal input between SSH phases | A Ctrl-C previously had no SSH child to receive it during verification, so it was dropped. N13 first reproduced enrollment despite that Ctrl-C, then requires exit 130, restored terminal flags, smoke cleanup and no registration. Completed install changes remain for inspection. |
| Hash stable installation inputs instead of Docker's full human/status output | Docker info has a current-time field; container listings have changing uptime text. These are excluded. Engine identity/version/runtime configuration and the exact running container IDs/names remain bound. N03 changes real inventory and configuration; N06 keeps a control running during delivery and observes its interruption by the approved restart. |
| Re-probe after delivery and authentication, before root installation | Downloads and password entry can take time. Changed inputs return a revised plan. N03 supplies stale consent beside accepted-plan controls. |
| Retry an approved install or reuse its verified service; do not roll back shared resources | The journal names completed and interrupted steps plus prior file hashes. N05 forces Docker validation failure, observes partial root changes, unchanged Docker configuration and no registry entry. A half-installed machine without readable Docker access may require owner preparation before another complete plan is possible. |
| Keep a failed create for diagnosis when no successful create reply proves ownership | A create error or lost reply cannot justify deleting a pre-existing sandbox of the same name. Successful smoke creates are always removed before registration. The error reports the diagnostic name and possibly retained shared helper/guard objects. |
| Manual remote uninstall, separate from host remove | N07 proves remove retains the service. N12 removes the disposable fixture's unit, runtime, artifacts, state, backups, guard and helper image while preserving unrelated Docker configuration and usable Docker. Shared distro packages stay. |

**U4 is partially measured.** Ubuntu 24.04 arm64 on an OrbStack Linux machine supports the systemd account setup,
boot-accessible state path, distro Docker package transaction and native compiled artifact. The host daemon's user,
enabled unit, socket-only listener, checksum, sandbox checks and disk measurement are inspected. Linux Mint 22.3
x86_64 is probed read-only. Privileged x86_64, Debian, logout and reboot installation behavior remain unmeasured.

**U5 uses the conservative choice.** A runtime configuration change always plans a Docker restart, even with live
restore. Docker 29.1.3 on the disposable Ubuntu fixture validates the merged file, preserves unrelated settings and
interrupts the named running control in N06. Reload-only registration and other Docker versions remain unverified.
When the runtime entry is unchanged, no Docker restart is planned.

**U6 is partially measured.** Explicit per-architecture compilation, native ELF rejection, both checksum boundaries,
installed digest/source matching and embedded helper delivery are measured on the arm64 fixture. There is no signed
manifest, release infrastructure, implicit compiler or claim about a modern multi-file gVisor delivery pipeline.
The pinned checksums are explicit project trust anchors, not independently authenticated releases.

## 3. A hard cap must cover persistent sandbox writes

Recommend one sparse loop-mounted ext4 image per sandbox, with an explicitly bounded filesystem layout.
Do not copy the reference's two-directory scheme and call the whole sandbox capped.
Paddock's proposed `diskMode: hard` makes the engine root read-only and puts every allowed persistent writable directory on that image.
This trades unrestricted root-directory mutation for a cap that can be inspected and probed.
Filesystem and image-layout compatibility are **unverified U7**. Until those gates pass, advertise watched, not hard.

| Candidate | Decision |
|---|---|
| Sparse loop ext4 plus bounded layout | Recommend. Does not require reformatting the machine's Docker filesystem. One shared byte budget. |
| Reference home and Docker disks with writable root | Reject as a whole-sandbox cap. `/usr`, `/var`, root home, and other writes can escape it. |
| XFS project quotas | Good later provider capability for a prepared host. V1 avoids requiring a different Docker backing filesystem. |
| Docker overlay size on XFS | Reject as the only cap. Driver-specific and does not automatically cover separate volumes or logs. |
| btrfs qgroups | Defer. Subvolume placement and accounting depend on the engine; reference reports OrbStack resetting limits. |
| Volume driver | Reject for v1. Adds a privileged lifecycle dependency and still leaves the writable root outside a volume's cap. |
| Per-sandbox host Docker daemons | Reject. Can place entire data roots on disks, but multiplies engines, guards, services, and recovery machinery. |

The alternatives' availability on a new Linux host is **unverified U8**. Probe capabilities, never infer them from the OS name.
If a writable root is required and the bounded layout is unsuitable, use watched mode rather than weakening the hard-cap claim.

### Bounded filesystem layout

- The core selects a versioned layout for a validated image digest, not arbitrary client mount paths.
- Seed `/home`, `/root`, `/usr`, `/etc`, `/var`, `/opt`, `/srv`, `/tmp`, and `/run` into directories on the single ext4 disk.
- Bind those directories back at their guest paths. `/var/lib/docker` and declared image volumes must stay on the same disk.
- Preserve image symlinks such as `/bin` into `/usr/bin`. Reject unsupported root layouts and undeclared writable volumes.
- Root-level files and directory creation outside this layout are read-only. Disclose this in create and doctor output.
- Put generated DNS, hosts, and hostname files on this disk too; inspect exact engine special mounts for writable exceptions.
- Keep proc, sys, and device views restricted by the existing provider. Bound tmpfs and `/dev/shm` by memory, not disk.
- Disable engine stdout log storage for the sandbox. Do not allow unbounded engine-side logs to bypass the filesystem budget.
- Copy image content under gVisor, without network or host privilege. Never run a sandbox image in the privileged disk helper.
- Reject a base image whose seeded writable directories do not fit. Installed base content consumes the advertised budget.

`diskGb` remains binary GiB, matching current code. Metadata reduces usable space; expose both image bytes and usable bytes.
The claim covers sandbox persistent writable files, not shared base-image downloads, engine metadata, daemon logs, or backups.
It is not an aggregate reservation of host space. Sparse images can exhaust the host before any one reaches its logical limit.
Report host free space and bound Paddock's own logs. Do not promise that several approved caps can all be filled simultaneously.
Package installation, generated engine files, nested Docker storage, and snapshots with this layout are **unverified U7**.
Snapshot code must include managed disk data; plain `docker commit` cannot be assumed to preserve it.

### Privilege, truthful mounts, and evidence

The root helper owns `/var/lib/paddock-disks/<uid>/<sandboxId>/disk.img`, mountpoint, and mount units.
It accepts only `create`, `inspect`, `grow`, `mount`, and `remove` with validated IDs and bounded byte counts.
No caller supplies a path, filesystem type, shell command, mount flags, or another user's ID.
Validate parent ownership and refuse symlinks, hard-link substitutions, unexpected devices, and mismatched filesystem UUIDs.
Runtime sudo is only `sudo -n /usr/local/libexec/paddock-disk ...`; refuse if the scoped permission is missing.
The helper creates the sparse file, formats ext4, mounts it, and creates its `data/` sentinel only on the mounted filesystem.
The container uses strict bind mounts that refuse a missing source. Never auto-create a fallback directory on the host.
System mount units restore the disks at boot. `Core.startChecked` still verifies the mount and reloads the network guard.
Helper confinement, mount propagation, boot ordering, and filesystem identity checks are **unverified U9**.

Change checklist title `mounts` to `No user host folders are mounted; managed sandbox disks are identified`.
Do not report the literal current claim `No host folders` while using provider-owned bind mounts.
For every mount, compare destination, source inode, filesystem UUID, backing image, owner ID, propagation, and read-only policy.
Reject unexpected binds and volumes, including a bind from another sandbox's disk. A matching path prefix is insufficient.
Report the exact managed mounts and disk identity as inspected evidence. Mount identity failures are blocking.
Add a blocking `storage-layout` check for a sandbox requesting hard mode, including writable-root and log bypasses.
Use `disk` for capacity evidence. Missing hard-mode layout evidence cannot quietly pass because today's disk check is nonblocking.
Checks derive current mode from live evidence, not only `manifest.engine.capabilities.diskLimit` captured at creation.

The regular disk check inspects filesystem size, UUID, mount identity, writable coverage, and the requested byte ceiling.
The destructive capacity probe runs on a disposable sibling disk with the same backend, layout, runtime, and size policy.
It writes allocated, non-sparse data with flushes until a write past capacity fails, and checks failure is ENOSPC or EDQUOT.
A smaller write before filling must succeed. After deleting filler, a control write must succeed again.
Probe root-package paths and inner-Docker volumes as well as home. Inspect host allocation to detect writes outside the image.
Never fill the user's existing disk to verify it. On real sandboxes, show inspected evidence plus the dated backend probe result.
Disk exhaustion does not trigger stop or restart by itself; bounded writes fail. A broken storage boundary does trigger stop.
No helper permission means `diskMode: watched`, weak evidence, existing overshoot disclosure, and daemon-owned measurement.
Unknown disk measurements must be reported and counted toward a bounded loss-of-enforcement stop, not ignored forever.

### Grow, shrink, and cleanup

Use `paddock --host build resize demo --disk 40`. V1 requires a stopped sandbox for disk growth.
Under its lock, journal old and requested sizes, enlarge the image, refresh loop capacity, then grow ext4 and inspect the result.
Commit the new spec only after success. An interrupted grow retains recoverable phase information and both sizes.
On restart, reconcile the actual filesystem before allowing start. Never truncate back to the old size as rollback.
Reject shrink without changing anything. A later export/recreate path may copy into a new smaller disk explicitly.
Provider remove first closes sessions and stops/removes the owned container, then unmounts, detaches, and deletes its disk and units.
Busy or mismatched mounts retain the manifest and cleanup journal for retry. Never force lazy-unmount then unlink an active image.
Only delete objects matching both machine ownership and sandbox ID. Startup reconciliation reports orphans; it does not guess ownership.
Grow recovery, ext4 behavior under exhaustion, and cleanup failure handling are **unverified U9**.

## 4. Forwards exist on the person's primary machine

Use `paddock --host build forward add demo --port 3000 [--local-port 8080]`.
The primary daemon binds `127.0.0.1`, never wildcard, LAN, IPv6 wildcard, or a supplied IP.
Bind the actual listener once. An omitted local port requests port 0; return the assigned port after listening succeeds.
An explicit occupied port fails. Do not probe a port, release it, then assume it is still free.

| Target | Connection path |
|---|---|
| Local sandbox | Primary listener calls local `Provider.dialLoopback(manifest, port)` and relays the accepted socket. |
| Remote sandbox | Primary listener opens an SSH daemon stream to the selected target's `dial` session, then relays bytes. |
| Service bound inside sandbox to loopback | Target provider executes a fixed guest relay dialing only `127.0.0.1:port`. |

The relay is an internal mode of a Linux Paddock artifact for the guest architecture, copied inside by the core, including on a Mac primary.
It runs inside gVisor, never with host privilege, and receives a numeric port rather than a destination hostname.
Relay availability and gVisor socket behavior are **unverified U10**. No `nc` dependency or sandbox-installed tool is assumed.
Neither case binds a TCP listener on the engine host as an intermediate step. No outer Docker `-p` or SSH `-R` is used.
The remote request contains the expected sandbox ID and run generation, so a reused name cannot inherit the forward.

Forward records are primary-daemon resources, not durable sandbox spec. The primary daemon owns them; closing the browser does not end them.
`forward list [NAME]` reports ID, machine, sandbox ID, run generation, local address, target port, and state.
`forward remove ID` closes the listener and every active connection. Stop, remove, restart, primary exit, or SSH loss also closes it.
A remote lease heartbeat runs every 5 seconds with a proposed 15-second TTL. Missed renewals close the primary listener.
The remote daemon closes associated relay streams on stop immediately; lease expiry bounds a silent or partitioned connection.
No reconnect automatically recreates a listener. Report that a new forward is required after sleep or disconnection.
Heartbeat bounds are targets, **unverified U10**, and cannot promise immediate notification across a partition.

Reword `inbound` to `No engine-published ports; requested forwards are loopback-only`.
Keep engine `PortBindings` and `PublishAllPorts` inspections as blocking checks.
Add `forwards` as a disclosure naming active primary loopback endpoints, target ports, owner machine, and expiry time.
Target verification reports a leased requested forward, not proof that a distant primary is currently listening safely.
Primary listener inspection supplies that evidence. If the primary cannot be reached, the target says that part is unknown.
Loopback is reachable by other processes on the primary, and a browser may contact it. It is not per-process authentication.

## 5. Editor SSH follows the same target daemon

Generate `demo.paddock` for local and `demo.build.paddock` for remote sandboxes.
`paddock --host build ssh setup demo` prepares guest sshd, generates fresh guest host keys, and installs only the client's public key.
It also writes a managed primary SSH include and a dedicated known-hosts file, preserving unrelated user config.
`paddock ssh config` prints the include path and effective alias; `ssh proxy --alias ALIAS` is the internal ProxyCommand.
Use an absolute Paddock executable path so GUI apps do not depend on an interactive shell PATH.

1. Editor runs ordinary `ssh demo.build.paddock`, with the primary's dedicated editor private key.
2. ProxyCommand calls the primary socket and opens `ssh-proxy` through the same registered machine route.
3. Target core validates machine, sandbox ID, running state, and SSH capability, then opens provider exec in that sandbox.
4. Provider executes fixed `/usr/sbin/sshd -i` under the guest root user. It never opens port 22 on either host.
5. Raw SSH bytes cross the daemon stream. Proxy stdout contains only bytes; diagnostics go to stderr.

The outer SSH connection authenticates the machine. The inner connection authenticates the sandbox and guest user.
Pin the guest host key with `StrictHostKeyChecking=yes`, `IdentitiesOnly=yes`, `IdentityAgent=none`, and `ForwardAgent=no`.
Use a HostKeyAlias containing machine ID and sandbox ID. Recreating a name makes a new identity, not an ignored mismatch.
Never copy the editor private key to a remote machine or bake it into a template. Renewing a key needs explicit setup.
Guest setup uses typed core operations. Guest package scripts run only inside gVisor and never in a privileged host helper.
Only explicit setup/start may start a stopped sandbox; passive editor reconnect, proxy, shell, and poll refuse stopped targets.
Allow local TCP forwarding within the inner SSH connection to guest loopback for editor and T3 launchers; deny reverse forwarding.
Do not expose editor-driven listeners as Paddock-managed forwards. An independently invoked SSH client's bind choices remain its owner's responsibility.
sshd inetd mode, SFTP, editor bootstrap, and T3's particular SSH options are **unverified U11**.
Stage 2 must separately verify the T3 server installation/version. A working alias alone does not mean `T3 ready`.

## 6. Contracts and ownership

These are proposed types, not additions already present in `core/types.ts`.
Keep existing sandbox method bodies and place routing metadata outside `SandboxSpec`.
Every routed request body below is intersected with `HostRef`; the gateway removes that field before forwarding to a target daemon.

| Type | Exact proposed shape or change |
|---|---|
| `HostRef` | `{ host?: string }`; absent or `local` means this daemon. Only the primary resolves registered aliases. |
| `Target` | `{ machineId: string; name: string; sandboxId: string; runGeneration: string }`. Required for streams and forwards. |
| `HostRecord` | `{ name: string; machineId: string; addedAt: string; diskPolicy: "hard" \| "watched" } & ({kind: "local"} \| {kind: "ssh"; ssh: string; binary: string})`. Local name is reserved. |
| `Hello` | `{ machineId: string; bootId: string; version: string; buildDigest: string; protocols: number[]; methods: string[]; features: string[] }`. |
| `HostView` | `{ host: HostRecord; state: "connecting" \| "online" \| "offline" \| "incompatible" \| "identity-changed"; receivedAt?: string; error?: string }`. |
| `MachineSummary` | `{ hello: Hello; sandboxes: SandboxView[]; engines: Engine[]; checkedAt: string; enforcementAt?: string }`. |
| `FleetView` | `{ machines: Array<{ machine: HostView; cached?: MachineSummary; stale: boolean }> }`. Local uses the same result wrapper. |
| `SessionOpen` | `{ kind: "exec"; target: Target; argv: string[]; user?: string; tty: boolean; cols?: number; rows?: number }` or `{ kind: "dial"; target: Target; port: number; leaseId: string }` or `{ kind: "ssh-proxy"; target: Target }`. |
| `ForwardView` | `{ id: string; target: Target; localAddress: "127.0.0.1"; localPort: number; port: number; expiresAt: string }`. |
| `SandboxSpec` | Add `diskMode: "hard" \| "watched"`, defaulting from the machine's approved policy. No mount paths or runtime flags. |
| `Capabilities` | Replace `diskLimit` with `diskModes: Array<"hard" \| "watched">`; add `diskLayout?: "bounded-v1"`, `execStream: boolean`, `loopbackRelay: boolean`, `sshProxy: boolean`. Effective mode belongs to the sandbox manifest. Migrate callers together. |
| `Manifest` | Version 2 adds effective disk mode, optional `{backend: "loop-ext4"; id: string; uuid: string; bytes: number; layout: "bounded-v1"}`, run generation, desired state, safety latch, and optional guest SSH identity/public keys. |
| `ProviderSession` | `{ stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; write(bytes: Uint8Array): Promise<void>; endInput(): Promise<void>; resize(cols: number, rows: number): Promise<void>; close(): Promise<void>; exited: Promise<number> }`. Provider removes engine framing before daemon framing. |
| New errors | Add `offline`, `incompatible`, `identity-changed`, and `outcome-unknown` to `ErrorCode`, mapped to CLI exits 7, 8, 9, and 10 respectively, and HTTP 503, 409, 409, and 504. |

| API method | Body and response | Access and execution |
|---|---|---|
| `hello` | `{}` -> `Hello` | Socket; machine-local, before protocol selection. |
| `summary` | `{}` -> `MachineSummary` | Dashboard or socket; target-local snapshot, bounded collection. |
| `fleet` | `{refresh?: string}` -> `FleetView` | Dashboard or socket; primary cache, asynchronous refresh. |
| Existing methods | `{host?, ...existingBody}` -> existing result plus identity metadata | Existing access rules; route only an explicit catalog allowlist. |
| `host.list` | `{}` -> `HostView[]` | Dashboard read or socket; primary only. |
| `host.plan` | `{name, ssh?, diskPolicy?, sudo: "ask" \| "never", artifact?: {path, sha256}}` -> `{hash, steps, changes, warnings}` | Socket bootstrap; add or explicit upgrade, no mutations. |
| `host.apply` | `{hash, accepted: true}` -> `HostView` | Socket bootstrap; execute only a still-current stored plan. |
| `host.remove` | `{name, confirm}` -> `{removed, remoteRetained: true}` | Socket; forget primary resources only. |
| `session` | `SessionOpen` -> HTTP upgrade and framed stream | Socket only; same handler local or across SSH. |
| `forward.add` | `{host?, name, port, localPort?}` -> `ForwardView` | Dashboard or socket; primary binds, target core grants lease. |
| `forward.list` | `{host?, name?}` -> `ForwardView[]` | Dashboard or socket; live primary registry. |
| `forward.remove` | `{id}` -> `{closed: string}` | Dashboard or socket; only primary-owned ID. |
| `relay.lease` | `{target, port}` -> `{leaseId, expiresAt}` | Socket; target-local. |
| `relay.renew` / `relay.close` | `{leaseId}` -> `{expiresAt}` / `{closed: true}` | Socket; target-local, bound to owner session and generation. |
| `resize` | `{host?, name, diskGb}` -> `SandboxView` | Dashboard or socket; target core lock and provider grow. |
| `ssh.setup` | `{host?, name, publicKey, user}` -> `{target, hostKey, user}` | Socket; target guest setup, primary config through its client. |

V2 manifests require a transactional reader migration. Never infer hard mode from an old capability snapshot.
Replace `Provider.attachArgv` with `openExec`, `dialLoopback`, `prepareSsh`, and `openSsh` methods returning daemon-owned sessions.
Add `growDisk(manifest, bytes)` and `inspectDisk(manifest)` to the provider; capability-gate unsupported providers.
Remove the old attach method once local callers migrate. Refuse legacy remote attach instead of returning executable argv.
Expand `Runner` with a separate stream interface; do not force binary streams through `RunResult` strings.

| Rejected architecture | Reason |
|---|---|
| Central daemon driving remote Docker | Laptop availability would control checks, and probes would run on the wrong machine. |
| Remote HTTP daemon or reverse control tunnel | Adds a listening/authentication boundary or remote-initiated authority that existing outbound SSH does not need. |
| User daemon without verified lingering | Cannot promise enforcement after logout or reboot. |
| Outer Docker publishing or remote `ssh -L` to an engine port | Opens an intermediate listener and cannot express the required sandbox-loopback-only destination. |
| Editor proxy invoking Docker directly | Bypasses core identity, stop, capability, and session-lifetime checks. |
| Ignoring guest SSH host keys as the reference does | Removes sandbox-generation authentication and hides unexpected identity changes. |

| Location | Responsibility |
|---|---|
| `core/types.ts`, `state.ts`, `checks.ts` | Typed options, parsing, identities, registry/manifests, checklist vocabulary, and honest evidence. |
| `core/core.ts` | Sandbox locks, intent/latches, checked recovery, storage transitions, session lifetime. |
| `core/daemon.ts` | Method access catalog, ingress provenance, local socket/TCP boundaries, stream endpoint. |
| Proposed `core/machines.ts`, `core/transport.ts` | SSH client gateway, handshake, bounded independent refreshes, framing, remote byte relay. |
| Proposed `core/hosts.ts`, disk helper | Reviewed bootstrap, sudo boundaries, service install journal, root-owned disk operations. |
| `core/providers/gvisor.ts` | All engine calls, guest execution, disk mount policy, engine stream API, and evidence. |
| CLI | Parsing, plan display/consent, terminal I/O, managed primary SSH config. No engine argv execution. |
| Dashboard | Machine groups, stale/offline display, scoped actions, plan-independent everyday sandbox controls. |

## 7. Security consequences

| Compromise | Consequence and boundary |
|---|---|
| Remote host root or daemon account | Reads/modifies its sandboxes and imported secrets; forges checks, streams, and host keys. SSH cannot make that evidence trustworthy. |
| Malicious remote replies | Can send hostile terminal escapes or editor/server payloads, lie, and exhaust resource budgets. Primary parses bounded data and never executes returned argv. |
| Remote attempts toward primary | No forwarded agent, primary socket, callback RPC, reverse SSH tunnel, or shared dashboard token. Explicit forward responses reach only accepted primary connections. |
| Primary user or daemon | Can control every enrolled host as its SSH user. Docker authority there is effectively root. This is intentional administrative trust. |
| Primary dashboard token | Authorizes allowed sandbox mutations on registered hosts and forward creation. It does not authorize host installation, shutdown, attach, or private-key export. |
| Sandbox guest root | Can read copied credentials and serve malicious bytes over requested streams. No host disk image file, host device, or Docker socket is mounted inside it. |
| Disk helper or engine escape | Host compromise. Root-owned helpers reduce accidental path abuse, not the power already granted by Docker access. |

SSH encrypts and authenticates the hop; it does not protect data from either endpoint's administrator.
Do not send local credentials, extension code, or files to a remote automatically as part of enrollment.
Claims about resistance to malformed frames, mount races, and cross-host method escalation remain **unverified U12** until adversarial evals.

## 8. Evals and build order

Every row is a proposed outside measurement in `evals/run.ts`, not a result. Update SCORECARD only after running it.
Remote and privileged evals require explicitly provisioned disposable Linux fixtures; unavailable fixtures mean not measured.
Do not run installer/restart/reboot evals on an owner's active engine or the Mac.

| Eval family | What the new claim measures, including its control |
|---|---|
| Machine routing | Two engines each have `demo`; mutate only the selected ID. Unknown host never falls back locally. |
| Independent enforcement | Disconnect/suspend primary; tamper remote guard with plain engine commands; target stops within its enforcement policy. Untampered control keeps running. |
| Availability | Blackhole one SSH destination; healthy/local rows and actions still update. Show timestamps, stale state, and bounded retries. |
| Protocol and identity | Older supported protocol works; missing method is unavailable; incompatible protocol and changed machine ID cause no mutations or replacements. |
| Socket boundary | Dashboard token attempts session, shutdown, host apply, and arbitrary method routing against both local and remote; all refused. Legitimate CLI succeeds. |
| Streaming | Binary hash roundtrip, separate stderr, exit codes, TTY size/resize, EOF, slow reader, killed SSH, and no duplicated command after reconnect. |
| Enrollment | Declined/stale plan makes no writes. Accepted fixture installs exactly declared artifacts and sudo changes; unrelated Docker config remains unchanged. |
| Binary provenance | Alter one uploaded byte and one signed manifest field; both refused. Valid architecture artifact starts with the expected digest. |
| Reboot and service | Reboot fixture with primary offline; service returns, checks run, eligible intent recovers through guard-first start. Explicit and safety stops remain stopped. |
| Disk capacity | Allocated write fails beyond capacity even with the daemon killed; pre-fill and post-delete controls succeed. Repeat for home, package directories, image volumes, and inner Docker. |
| Disk coverage | Try writable root, generated files, log floods, rogue bind, wrong UUID, missing mount, and another sandbox's disk. No hard-pass with a bypass. |
| Disk transitions | Interrupt each grow/remove phase; retry converges without truncation or deleting unrelated files. Shrink refuses with byte-for-byte unchanged state. |
| Watched fallback | No helper privilege gives weak evidence; exceed watched budget on remote with primary offline and observe target stop. Unreadable measurements eventually stop. |
| Forwards | Guest-loopback nonce reaches only primary loopback. LAN and engine-host listeners fail while controlled LAN listener succeeds. Engine reports no published ports. |
| Forward lifetime | Stop/restart/remove, dropped SSH, lost lease, primary crash, and name reuse end access; healthy heartbeat control preserves it. |
| Editor and T3 | Real SSH, SFTP, editor bootstrap, and T3 launcher through local/remote aliases. Stopped target refuses; running control works; no host port 22. |
| Trust and cleanup | Inject malformed/oversized frames and malicious strings. Verify no returned command runs, keys stay primary, and removal leaves documented remote objects only. |

Sequence work into verifiable units. Each unit must pass its relevant outside measurements before the next depends on it.

1. Define machine identity, the access catalog, and protocol negotiation. Prove local socket and TCP restrictions before adding SSH.
2. Replace local attach argv with provider streams. Prove shell, binary exec, EOF, resize, and backpressure on the existing local engine.
3. Add read-only SSH socket relay to a manually prepared Linux fixture. Prove routing, identity, version refusal, and isolated failures.
4. Route explicit mutations and add fleet caching/dashboard grouping. Prove no fallback, no replay, and stable per-machine UI state.
5. Add local forwards, then remote relay leases. Prove loopback binding, no engine publishing, generation checks, and every ending condition.
6. Add system-service packaging and reviewed host plans. Prove decline, checksum failures, interrupted install, and service-only restart on a fixture.
7. Add intent/latches and checked boot recovery. Reboot the fixture with the primary absent and measure guard ordering and safety-stop persistence.
8. Spike the bounded disk layout before promising hard caps. Reject it if package/inner-Docker coverage cannot be demonstrated; retain watched capability.
9. Add helper lifecycle, truthful mounts, capacity probes, growth, and crash cleanup. Enable hard mode only on measured backend/layout combinations.
10. Add SSH aliases with pinned guest identities; run real editor and T3 access checks. Then expand installer support to the second Linux architecture.

## Unverified assumptions

- **U1, unverified.** Installed OpenSSH options, config precedence, key availability, jump-host behavior, and isolated connection behavior fit the transport design.
- **U2, unverified.** Target service boot behavior and engine exit metadata distinguish recoverable reboot intent from safety/OOM/task stops reliably.
- **U3, unverified.** The selected Bun version and local engine support Unix HTTP upgrade, binary duplex flow control, TTY exec, demultiplexing, and resize as required.
- **U4, partially measured.** See the enrollment implementation record. Ubuntu arm64 installation and the Mint x86_64 read-only probe are measured; other install combinations and reboot behavior remain unverified.
- **U5, conservative restart with one measured Docker version.** See the enrollment implementation record. Reload alternatives and other versions remain unverified.
- **U6, partially measured.** Explicit native artifacts, checksums and embedded helper delivery are measured on the arm64 fixture. Signed releases and modern multi-file runtime delivery remain unverified.
- **U7, unverified.** Bounded-v1 preserves supported image layouts, package installs, generated files, nested Docker data, and snapshots without a persistent-write bypass.
- **U8, unverified.** Candidate quota/storage backends and their limitations apply to any new Linux fixture; reference measurements establish no Paddock result there.
- **U9, unverified.** Scoped sudo helper, ext4 exhaustion/growth, mount identity/propagation, mount units, and interrupted cleanup satisfy the proposed safety properties.
- **U10, unverified.** Guest relay and SSH stream/lease behavior support binary loopback services and the proposed forward-ending bounds, including sleep and partitions.
- **U11, unverified.** Guest sshd inetd mode, pinned keys, SFTP, real editors, and T3 launch options work across both daemon hops without an open host port.
- **U12, unverified.** Parser bounds, provenance checks, mount-race defenses, and method allowlists resist malformed or adversarial remote inputs as designed.
