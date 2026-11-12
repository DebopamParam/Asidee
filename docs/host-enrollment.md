# Enroll a Linux host

Build both artifacts explicitly from the same source tree. Choose the Linux target from the destination's architecture.
`host add` never builds an artifact. These examples use arm64; use `bun-linux-x64` for x86_64.

```sh
bun build --compile --minify --outfile dist/paddock cli/cli.ts
bun build --compile --minify --target=bun-linux-arm64 --outfile dist/paddock-linux cli/cli.ts
shasum -a 256 dist/paddock-linux
dist/paddock host add build --ssh alice@linux --artifact "$PWD/dist/paddock-linux" --sha256 HASH
```

Without a terminal, and with `--json`, that command prints the plan and installs nothing. The checksum is an explicit
trust decision about your artifact, not a signed release manifest. Keep the binary at that path until apply finishes.

## What the destination needs

SSH must already trust the host. The plan names the host key SSH verified, which Paddock captures with OpenSSH's
`KnownHostsCommand` (OpenSSH 8.5 or later on this machine) and never reads from ssh's output; when SSH does not report
exactly one plain key, planning is refused. Every SSH command after consent, and every later connection to the
registered host, is pinned to that key (see the architecture's host-key pin). The read-only probe requires
Python 3, glibc and systemd, and never uses sudo. The installation recipe accepts Debian, Ubuntu and Linux Mint based on
Ubuntu noble; a host whose installation is already complete is reused whatever its distribution. Only the combinations
in the scorecard have installation measurements.

If Docker already exists, its socket and configuration must be readable by the SSH account to plan a runtime change. If
Docker is absent, usable signed apt metadata must already exist; refreshing it is an owner preparation step. The plan
then lists the apt sources and the exact packages, versions and checksums, and enrollment adds no repository or key.
The destination downloads gVisor itself, from `storage.googleapis.com`, so it needs outbound HTTPS.

## The plan

The plan is everything an installation would do, in the order it would do it:

- Every privileged command as its exact argument vector, and what each leaves on the host.
- Every file written, with its old and new SHA-256 and a line diff. `/etc/docker/daemon.json` keeps its own indentation,
  so the diff shows the added runtime and nothing else.
- Everything delivered to the destination and its checksum: your artifact, the gVisor archive and each file taken from
  it, and any Docker packages.
- Whether Docker restarts, and every container running at that moment, because a restart may interrupt each one, even
  with live restore. Whether the Paddock service restarts, and the running sandboxes that stops.
- The smoke sandbox that verifies the installation before the host is registered, the Dockerfile of the helper image
  that verification builds on the host, the notes, and the blockers. Nothing is installed while a blocker remains.
- The plan hash, which covers all of the above.

Only what is missing is planned. A host that already has the binary, the runtime or the service unit is not sent them
again, and Docker restarts only when it has to load a runtime entry it does not have. Enrolling a host again with
another artifact installs that binary and restarts the Paddock service without restarting Docker. That service restart
stops the running sandboxes the plan names; start each again with `paddock start`.

Duration is unknown. Disk limits are watched. No hard disk helper, disk tools or sudoers rule is installed.

### Docker inside sandboxes

gVisor `20261026.0` is installed under `/opt/paddock/gvisor/20261026.0/` and registered with Docker as `paddock-runsc`,
with `--allow-suid` and `--overlay2=none`. Paddock uses that runtime on an enrolled host even when another gVisor
runtime is registered there, and other runtimes are left as they are.

By default the host does not offer Docker inside its sandboxes, and `paddock create --docker` is refused there. Add
`--docker` to `host add` to register the runtime with `--net-raw` as well, which gives sandboxes gVisor's raw sockets;
inner Docker's NAT needs them. The option is part of the plan and its hash, and the smoke sandbox then starts Docker
inside and has to pass that check. Enrolling such a host again without `--docker` plans the removal of `--net-raw`, and
the plan says that sandboxes created with `--docker` then fail their kernel check.

## Consent

For interactive enrollment, run the command in a terminal and enter the literal word `yes`. If installation needs
sudo, its password prompt travels over the private daemon stream to the same SSH terminal used by the installer. The
password is not part of the JSON API body, plan or journal. Ctrl-C during verification cancels enrollment, waits for
smoke cleanup and returns 130 with the terminal restored. Completed installation changes stay for inspection; no host
is registered. Automation uses the reviewed hash:

```sh
dist/paddock host add build --ssh alice@linux --artifact "$PWD/dist/paddock-linux" --sha256 HASH --accept-plan PLAN_HASH
```

Automation needs noninteractive sudo for the declared operations. `--json` always prints a plan and applies nothing,
even with `--accept-plan`. The text plan distinguishes interactive authentication from `--accept-plan`, which never
prompts. `--sudo never` plans no privileged commands or authentication.
A changed file, artifact, machine identity, package recipe or container inventory invalidates
consent. Apply probes again after delivery and terminal authentication, before the first installation step. Review the
revised plan and use its new hash. A plan is held by the primary daemon; restarting that daemon expires its stored plans.

Container inventory retains ownership labels. Service restart warnings identify Paddock sandboxes by both
`dev.paddock.id` and `dev.paddock.name`, rather than a name prefix; unrelated containers and probe helpers are excluded.
The Docker restart warning still lists every running container. Invalid inventory JSON refuses the plan with a
Paddock dependency error and asks for a new read-only probe.

`--sudo never` reuses an installation that is already complete: the system service active and enabled at boot, running
the supplied artifact from the reviewed unit, with the pinned runtime registered and loaded by Docker. It plans no
command, upload or restart, and refuses anything less. It installs no user unit, even when lingering is enabled.
`host attach` remains available for other prepared layouts. Reuse still creates, verifies and removes the smoke sandbox
before registration.

## What an installation leaves

- `/opt/paddock/releases/HASH/paddock`, root-owned, selected by `/usr/local/bin/paddock`.
- `/opt/paddock/gvisor/20261026.0/`: `runsc`, `containerd-shim-runsc-v1` and the six files of `gvisor-bin/`, root-owned,
  mode 0755. The release archive is verified against a pinned SHA-512 and each file taken from it against a pinned
  SHA-256; an archive holding anything else is refused before any command runs.
- One `runtimes.paddock-runsc` entry in `/etc/docker/daemon.json`. Other settings stay. A content-addressed backup
  precedes replacement, and `dockerd --validate` precedes the write.
- `/etc/systemd/system/paddock@UID.service`, running as the SSH user with `SupplementaryGroups=docker`, a fixed PATH,
  socket-only access, `Restart=on-failure` and journal logging. Docker access is effectively host-root authority.
  Login group membership stays unchanged.
- `/var/lib/paddock/UID`, owned by the SSH user, mode 0700, with configuration in `config/` and the installation journal
  in `enrollment.json`. The journal records the plan hash, file contents/hashes, completed steps and the step in progress.
- From verification and from sandboxes: the helper image `paddock-helper:TAG`, the pulled sandbox images, and the
  `inet` and `bridge` firewall tables named `paddock_guard`.

The primary registers the host only after inspecting the enabled service and matching the daemon's source, version,
protocol, binary digest and listener, and after finding that the daemon would run sandboxes on `paddock-runsc`. Smoke
verification needs every applicable blocking check to pass at creation and again after a real disk write measured from
the host, followed by successful sandbox removal. The pinned sandbox image and core helper are shown in the plan. Boot
enablement is inspected; reboot persistence and automatic sandbox recovery are not measured.

## When it fails

A refusal or failure leaves the host unregistered and says what this run changed:

- Before any step: stale consent says `Nothing was installed` and returns the revised plan, and a delivery that does
  not match its checksum ends with `No installation step ran.`
- During installation: the completed steps, what they left (it is retained), the interrupted step and what it may also
  have left, and the journal's path. Nothing is rolled back automatically.
- During verification of a reused service: `This run installed nothing; the service it found was left as it is.`
- An installer session that reports every step complete and then ends with a nonzero exit is an unknown outcome, not
  an enrollment. An SSH loss can leave one too. Inspect the destination journal before retrying.

If a sandbox with the smoke name is already on the host, kept by an earlier attempt whose reply was lost, enrollment
does not touch it. The refusal prints the `ssh` command that removes it; run that, then enroll again.

Shared packages and data are never rolled back automatically. Repeating a successful installation reuses the service;
a partially installed machine may need owner-provided Docker access before a complete restart-impact plan can be made.

## Remove the registration and uninstall manually

`paddock host remove build --confirm build` forgets only primary resources. It leaves the remote installation, service,
sandboxes, packages, runtime, images and logs. Uninstall is an explicit owner operation, separate from host removal.

On the remote machine, first remove that daemon's sandboxes and templates through Paddock. `UID` is the SSH account's
`id -u`, and `TAG` is the tag `docker images 'paddock-helper:*'` shows. Then, in this order:

1. Stop and disable the service: `sudo systemctl disable --now paddock@UID.service`.
2. Delete Paddock's firewall tables. They stay loaded after the service stops, until they are deleted or the machine
   reboots, and the helper image carries the `nft` that removes them:

   ```sh
   sudo docker run --rm --network host --cap-add NET_ADMIN --runtime runc paddock-helper:TAG nft delete table inet paddock_guard
   sudo docker run --rm --network host --cap-add NET_ADMIN --runtime runc paddock-helper:TAG nft delete table bridge paddock_guard
   ```

3. Check that no container still uses `paddock-runsc`, and list every running container: the Docker restart in this
   step may interrupt each one. Remove only `runtimes.paddock-runsc` from a copy of `/etc/docker/daemon.json`,
   preserving every other key. Validate the copy with `sudo dockerd --validate --config-file COPY`, install it with
   `sudo install -m 0644 COPY /etc/docker/daemon.json` and run `sudo systemctl restart docker`. Restore a whole backup
   file instead only if the current file still has the hash the installation wrote; a newer unrelated edit must not be
   overwritten.
4. Remove the unit `/etc/systemd/system/paddock@UID.service`, the `/usr/local/bin/paddock` link and the backups
   `/etc/systemd/system/paddock@UID.service.paddock-*` and `/etc/docker/daemon.json.paddock-*`, then run
   `sudo systemctl daemon-reload`.
5. Remove `/opt/paddock`, unless another account's Paddock service on this machine uses a release or the runtime in it.
   Delete `/var/lib/paddock/UID` after deciding what configuration and journal to keep, and the then empty
   `/var/lib/paddock`.
6. Remove the helper image with `sudo docker rmi paddock-helper:TAG`.

The pulled sandbox images, the distro's Docker packages, ordinary SSH configuration, known-host trust and system journal
logs are shared owner resources and stay unless the owner removes them.

The N enrollment evals use disposable OrbStack machines only. They test installation and sudo paths without touching
the Mac's Docker configuration or the routing fixture's system files. Delete the fixture machines after the run.
