# Architecture

## The boundary

```
  CLI ─────────┐
  Dashboard ───┼──▶  daemon API  ──▶  core  ──▶  provider  ──▶  engine (Docker + gVisor, …)
  Extensions ──┘     (core/daemon.ts)
```

- **The core is rigid.** It is the only code that runs engine commands. It holds the sandbox spec, the checklist, the
  providers and the rule that a sandbox with a failed blocking check does not run.
- **Everything else is a client.** The CLI, the dashboard and extensions can only call the methods in `core/daemon.ts`.
- **The API cannot express an unsafe sandbox.** A spec is a name, an image or one of Paddock's templates, four sizes
  and a boolean `docker` option (`validSpec` in `core/state.ts`); unknown fields are dropped. There is no field for a
  mount, a capability, a runtime or a port. Each engine reports whether it supports `docker`; create refuses an
  unsupported request.

## The checklist

`core/checks.ts` lists the checks. Providers supply the evidence for each one; a check a provider does not report comes
out as "could not be checked", never as a pass.

A blocking check reported as `unsupported` refuses create/start and stops a running sandbox on enforcement or verify,
including a probe. Its error names the missing property. By default, an `unknown` blocking probe also refuses create.
The sandbox is stopped and retained for diagnosis, exactly as for a failed blocking probe. The error names each
unmeasured probe and its reason, with code `probes-required` (HTTP 422, CLI exit 6). Its `details` remains an array of
check results. Nonblocking unknown or unsupported checks remain disclosures.

`config.json` has a boolean `requireProbes`, default `true`. `paddock config get` reads the effective configuration;
`paddock config set require-probes on|off` changes this one setting. Both support `--json` and `--host NAME`.
With `requireProbes: false`, create accepts unknown blocking probes and reports them as unknown, never as passes.
Failed and unsupported blocking probes still refuse create. The dashboard's **Settings** section has the same toggle.
A create refused for unknown probes offers **Open settings**, which navigates and focuses the toggle without changing it.
The sandbox list labels current isolation as **Not verified**; saved checks remain dated history.

The daemon API exposes `configGet` and `configSet`; the latter accepts only `{ "requireProbes": boolean }`.
A settings write atomically replaces `config.json` with mode 0600, preserving defaults, engine selection and other fields.
Writes are serialized within the daemon, and each create reads the current file without a daemon restart.
Both methods are available over the user socket and on loopback with the dashboard token and accepted Host header.
They use the same handler checks as create; a cross-site page without that token, or using another Host, cannot change them.
Each daemon uses its own machine's configuration. A routed create uses the remote setting, and routing preserves its
error text, code and details. For example, `paddock --host build config set require-probes off` changes only build.
This setting affects future create requests. It does not rerun probes or alter running sandboxes.

Explicit verify on a running sandbox still reports an unknown probe without stopping the sandbox, in either mode.
Its `ok` means no blocking failure was found, not that unknown probes passed. Start runs no probes, and enforcement's
four-pass budget is unchanged. These paths and the HTTP and CLI behavior are covered by unit fixtures; engine behavior
and browser appearance have not been measured for this change.

The gVisor provider must satisfy the whole blocking checklist. Docker Sandboxes is detection-only and not ready in this build; create is refused before any sandbox is made. No gVisor-specific check
is waived for it. A future microVM provider needs reviewed evidence or an explicit checklist decision before becoming ready.

| Check | Blocking | When | How the gVisor provider checks it |
|---|---|---|---|
| Isolated kernel | yes | after start | The runtime is gVisor, and the kernel inside identifies as gVisor. |
| Inner Docker is available when requested | yes | after start | Its Unix socket answers, its data root is /var/lib/docker, and its driver is the copy-on-write `overlayfs`. The detail discloses the public DNS fallback. Not requested is a disclosure. |
| Public DNS fallback is configured | yes | after start | Reads /etc/resolv.conf; only if it is not 1.1.1.1 and 8.8.8.8, rewrites it, reads it back and says it was restored. This measures configuration, not live resolution. |
| No privileged mode, host namespaces, undeclared capabilities or devices | yes | before start | Engine configuration. With Docker, exactly NET_ADMIN and SYS_ADMIN added inside gVisor; otherwise no additions. |
| No host folders | yes | before start | Engine configuration; with Docker, volume driver options and ownership too. |
| Own network, guard loaded | yes | before start | Engine configuration, and the loaded firewall rules compared rule for rule with the shipped ones. |
| No engine-published ports; requested forwards are loopback-only | yes | before start | Engine configuration. Forwards are the daemon's, not the engine's. |
| Forwards to this machine's loopback | no | before start | Checked by the core: each active forward's address, its port inside, and its id; a disclosure. |
| SSH access for editors | no | before start | Checked by the core: whether `paddock ssh setup` was run for this sandbox, its user, and the editor key's fingerprint; a disclosure. |
| Memory, process, CPU limits | yes | before start | Engine configuration: the values must be the spec's (as created or resized), with json-file host log rotation (10 MiB, two files) for every sandbox. |
| Disk limit | no | before start | The engine's capability: hard, watched or none. Watched needs a runtime with `--overlay2=none`. |
| The template it was made from | no | before start | The template recorded at creation and the image the container runs, which must be the template's; a disclosure. |
| Cannot reach the host | yes | verify | Live probe with controls. |
| Cannot reach other sandboxes | yes | verify | Live probe with controls. |
| Cannot reach LAN, tailnet, metadata, IPv6 | yes | verify | Live probe with controls of a stand-in address in each private range and the tailnet range; one attempt at the metadata address; IPv6 by the loaded rules. |
| Internet access | no | verify | Live attempt; a disclosure. |
| Logins inside | no | verify | Looks for the usual credential files; a disclosure. |

"Verify" runs after every create and on `paddock verify`. A start runs the configuration and runtime checks. On a stopped sandbox, verify
reports the configuration checks only and marks the rest as not checked.

Verification results are measurements at the recorded `at` time, not continuing guarantees. Create and verify return
their newly measured checks. Every stored `lastVerify` returned by list/get, for sandboxes and workspaces, including
after create/start/stop/resize, is historical (`historical` in `core/checks.ts`): its results have current status
`unknown` and no current evidence, and the detail reads `Measured <at>: <status> (<evidence>). <detail>`. The dashboard
shows that detail as it is, under the check's title and "current property unknown"; a remote sandbox whose host stopped
answering adds "Last contact lost." in front. The CLI and dashboard label this even with the checklist collapsed. The saved
manifest retains the original measurement. This deliberately conservative rule also covers an engine restart with
live restore, engine replacement/reconfiguration and a daemon restart without pretending that container start time
alone proves continuity. Use verify for a new measurement; even a recent historical pass is not a claim about now.

The isolated-kernel check also refuses a gVisor runtime registered with a flag that opens a path to the host or
switches a limit off (`unsafeRuntimeArgs` in `core/providers/gvisor.ts`), and `paddock doctor` does not offer one.

### Staying true after the start

Every 30 seconds the daemon repeats the configuration and runtime checks and the disk measurement on each running sandbox, and stops
one that fails, recording the reason. A check that could not be made in one pass does not stop a running sandbox: that
is usually an engine that was busy. Four such passes in a row do, because by then nobody is checking it. The probes are not repeated on the timer: they start containers, and `paddock verify` runs them.

Each unsuccessful enforcement pass records a timestamp and warning on that sandbox, shown by CLI list/get output
and the collapsed dashboard as "Enforcement problem at …". This includes thrown status/check/disk errors, unknown
blocking checks, unmeasured watched disk use and a failed stop attempt. These consume the same four-pass unknown
budget; a known blocking failure or a passed disk limit still requests a stop immediately. Once a stop succeeds, the
warning is cleared and the sandbox's stop reason carries the explanation; a warning remains only while enforcement is
unknown or a stop failed. One sandbox's error does not skip the others. A complete healthy enforcement pass, a pass
that finds the sandbox not running, and a successful explicit start each clear its warning and budget. Warnings survive a daemon restart when state is writable; if a write fails, the daemon
keeps a visible in-memory warning naming that failure, which cannot survive its restart. An engine inspection error
is unknown, not a missing sandbox. A failure of the whole pass is also written to the daemon's stderr as a structured
enforcement-error event. Unit fixtures cover these failures; no live engine failure was induced for this change.

### How the guard is compared

The helper loads the shipped rules into an empty network namespace of its own, lists them, and compares that listing
byte for byte with the listing of the engine's tables. "Loaded" therefore means these rules and no others; a rule added
in front of the drops shows as changed, and the sandbox is stopped.

### How the network probes work

A helper container joins the sandbox's own network with the sandbox's runtime and tries to connect to a listener on the
engine's host and to a listener on another guarded network. A blocked attempt counts only if its controls answered:
the host reached the helper, and the host reached each listener. Without that, the result is "could not be checked".

For the LAN and the tailnet there is nothing of yours to aim at safely, so the helper on the engine's host makes a
scratch network namespace, routes one unused address from each private range (10/8, 172.16/12, 192.168/16) and from the
tailnet range (100.64/10) to a listener inside it, and removes it all afterwards. From the sandbox's side these sit
where a device on your LAN would: beyond the host, at a private address. A range whose stand-in address the host
already routes somewhere is skipped and named in the result. Routes through a previous Paddock probe are awaited
with a bounded deadline instead of being counted as occupied addresses. A probe returns only after its own veth,
bridge and routes disappear. A teardown timeout fails the request instead of returning weaker evidence. A listener that was created but whose
host control failed is reported separately from an occupied address. One probe runs per engine at a time.

The helper runs from an image built from `core/providers/helper.Dockerfile` (Alpine pinned by digest), never from the
sandbox's image, so a tampered image cannot fake a result or run as root on the engine's host.

With `docker` enabled, verify also runs containers from the helper image inside the sandbox's Docker daemon. The
network checks include their connection attempts. The image is the engine's own copy, read with `docker save` and
loaded with `docker load` on exec's stdin as bytes, so no registry is asked: I24 blocks Docker Hub inside the sandbox
(a control pull fails, HTTPS still works) and verify still probes. The inner probes run by the image's ID, which must
equal the helper's on the engine; I24 records every inner container verify creates and finds only that ID. An image
inside under the helper's name with another ID makes the network checks unknown and is left alone. Verify removes its
copy afterwards only if the image was absent before, so a pre-existing copy and the user's own tags stay (I19, both
cases). A failed removal makes the network results unknown. Before loading anything, verify needs 64 MiB of headroom
below the watched disk limit; with less, or with no disk measurement, the network checks are unknown with that reason
and nothing is loaded (I20, at 24 MiB of headroom). The reserve is checked, not held. An internet connection controls
whether the inner container has a working outward path; a failed control makes its isolation evidence unknown. The I
evals also remove the guard and show that the same inner probes then reach the host, another sandbox, and all four
private-range stand-ins.

### Inner Docker

`docker` adds exactly `NET_ADMIN` and `SYS_ADMIN` to Docker's default capabilities. These privileges apply inside
gVisor, whose kernel remains the boundary. I01 runs all four subsets on the live engine against the workload: a
copy-on-write daemon, image pull, container run, HTTPS, and a build with one RUN layer. Without `NET_ADMIN`, bridge
creation is denied. With only `NET_ADMIN`, overlayfs image extraction cannot mount its unpack directory. Both additions
pass the entire workload; no further capabilities were needed. This is an inclusion-minimal set for the measured
image and engine relative to Docker's unchanged defaults, not a minimum for every Docker implementation.

The provider starts dockerd as the sandbox's main process, as root, on each start. Its fixed configuration enables the
containerd snapshotter and names `--storage-driver=overlayfs`, so dockerd fails to start rather than fall back to a
driver that copies layers; it adds `--iptables=false` and `--ip6tables=false`. The runtime check rejects any driver but
overlayfs. I01 runs this same start command for every capability subset. I15 measures allocated bytes from the engine
side: pulling BusyBox (a 6.0 MB image) added 6.1 MB, a second pull by digest and a second tag added nothing, and two
running containers from it added 94 KB. Layers are shared, not copied.

It clears stale PID files and sets the sandbox's DNS before starting dockerd, so inner containers inherit the same
resolvers rather than having a separate daemon DNS override. On this engine a user-defined network supplies
`127.0.0.11`: a runc control resolves through it, but gVisor refuses the connection. The engine's upstream,
`0.250.250.200`, is in the guard's blocked 0/8 range. Paddock therefore writes a **public DNS fallback, 1.1.1.1 and
8.8.8.8**, for the sandbox, which the inner daemon inherits. This is a product choice of where DNS queries go; the
`docker` check discloses it. Private DNS and split DNS were not measured.

Every start, including an already running sandbox and one with inner Docker, and every runtime enforcement pass reads
this file first. Only when it differs from the fallback (Docker can reset it, for example across an engine restart) or
cannot be read is it rewritten and read back, and the check's detail then says it was reset and restored; a file that
is already right is not written, so the 30-second pass does not rewrite it. A previous per-network resolver address is
never trusted. A file that cannot be restored and read back is `unknown`, never pass; start refuses it and enforcement
uses the usual four-pass unknown budget. The guard and bridge remain checked on every pass; a missing/changed guard
stops a running sandbox, and start reloads the guard and recreates a missing network before checking configuration.
Fake-runner unit tests cover reset resolver files, start paths and lost guard/network preparation. Recovery and live
name resolution after a real Docker engine restart remain unmeasured for this change. Existing inner containers may
retain their own resolver state; the DNS check makes no claim about them.

On a network the inner daemon creates (compose makes one per project), inner containers ask dockerd's own resolver at
`127.0.0.11`, which forwards to the sandbox's servers. Dockerd sets up that resolver with `iptables` even with
`--iptables=false`, and the image's `iptables` is the nft variant, which gVisor does not support ("Failed to initialize
nft"); names then failed to resolve. Dockerd therefore runs with a `PATH` in which `iptables` and `ip6tables` are the
legacy ones. I18 resolves on such a network and I17 runs `docker compose up` of a service that reaches HTTPS.

Start waits for Docker's socket and sets `iptables-legacy` masquerading out of `eth0`. The runtime needs `--net-raw`
and `--overlay2=none`. The host helper sets `gso_max_segs 1` on this sandbox's veth so forwarded traffic receives
separate packets. The NAT step checks for the rule before adding it, and the segmentation step sets the same value
without cycling the link. An exited dockerd stops the sandbox; there is no automatic restart. `paddock start` starts
it again after the guard and configuration checks. The runtime check repeats the socket and driver probe on every
enforce pass.

`/var/lib/docker` uses a volume unique to the sandbox's random id, with ownership labels. It is not a host folder.
For Docker sandboxes, the mounts check also inspects every mounted engine volume. Only the local driver without
mount options is accepted; a bind-backed volume still reports type `volume`, so checking that type alone is insufficient.
The Docker data volume must have the sandbox's ownership labels. An unreadable volume is unknown, not a pass. I14
replaces the data volume with one backed by the engine host's `/tmp` and shows that start refuses it without running it.
The disk measurement adds the writable layer and engine-side `du` of volumes mounted read-only in the trusted
helper. It never asks the sandbox to report its own usage. Remove deletes the Docker volume even if the sandbox's
container was already deleted.

Dockerd's output is the container's, which the engine stores on its host, outside the watched limit. I22's control, a
container whose cap is 1 GB, grew its host log from 38 MB to 75 MB with two 8 MiB writes while its own layer stayed the
same (the engine stores each short line as a JSON record several times its size). A sandbox without Docker can do the
same: its main process is `sleep`, but anything running as that process's user (root in Alpine) can write to
`/proc/1/fd/1` (a user other than PID 1's was refused). Before the cap, two 8 MiB writes through `paddock exec` grew
such a sandbox's host log to 75 MB and a third to 93 MB, where the engine's default rotation took over. Every sandbox therefore sets `json-file` logging with `max-size=10m` and `max-file=2`, and the limits check
fails on any other setting. After two 16 MiB writes the host log was 15 MB, then 11 MB, both for a Docker sandbox
(I22) and for one without Docker (I23); a replacement with a 1 GB cap is refused at start in both. This engine's own
default is already bounded (20 MB, five files); Paddock sets its own cap so the bound does not depend on the engine.

### Exec output

What `exec` returns is held in the daemon's memory, so each stream is limited to 16 MiB (`OUTPUT_LIMIT` in
`core/run.ts`; the same limit applies to every command the core runs, including the sandbox's own tools during
checks and extension commands). A command that passes it is not returned cut off: the core stops reading, kills the engine client, and
returns an error that names the limit and the stream. The engine leaves an exec's processes running when its client
is killed (measured: a `yes` kept a CPU busy), so each exec carries a random `PADDOCK_EXEC` variable and the core ends
every process that has it, as the same user (root inside gVisor cannot read another user's environment). A process
that cleared its environment or changed its user is not found. Ended processes stay as zombies until the sandbox
restarts, because `sleep`, its main process, does not reap them; they count against the task limit. U12: exactly
16 MiB comes back whole; more on stdout, on stderr, and 1 GiB on stdout are each refused with the limit named, no
flooding process is left running, and the same daemon answers afterwards.

Buffered input is bytes: `--stdin` reads the caller's stdin whole and sends it as `stdinBase64`, which the daemon
decodes after checking that it is canonical base64 of at most 16 MiB (`execStdin` in `core/daemon.ts`); a request
with a string `stdin` is still accepted and sent as UTF-8, and one with both is refused. A routed request carries the
field unchanged, and a remote daemon built from other source is refused before it is asked. Buffered output is text:
stdout and stderr are decoded as UTF-8 and invalid sequences are replaced, so a command whose output is not text needs
`--stream`. Measured in `test/unit/exec-bytes.test.ts`: all 256 byte values and invalid UTF-8 sequences go from the
CLI's `--stdin` into the request unchanged for `exec` and `workspace exec`; through the daemon's method table they
reach a real `shasum` with the same hash, for a sandbox exec (the engine client faked, so the hasher runs on this
machine) and inside a real workspace; and a routed exec forwards them unchanged. A hash inside a live gVisor sandbox
and a live `--host` exec were not run for this.

### Sessions

`paddock exec --stream` and `paddock shell` are sessions. The daemon relays them on a second Unix socket in the state
folder, `stream.sock` (mode 0600), and on nothing else: the dashboard's port cannot open one, with or without its
token (S05). The protocol, paddock-stream/1 in `core/stream.ts`, is frames of a kind byte, a four-byte length and at
most 64 KiB of payload. The client sends `open` and waits for `ready`; then it sends input, end of input and terminal
sizes, and the daemon sends stdout and stderr apart and last the exit code or an error. The provider runs the command
through the engine's API (an exec whose start is upgraded to a raw stream on the engine's Unix socket), not through the
engine's CLI, and a closed session's processes are ended by their `PADDOCK_EXEC` tag as above. A transport FIN cancels a stream
session, including a terminal or SSH proxy. Input EOF is a protocol frame and does not disconnect the client. Each direction waits
for the other side to take what it was given, so nothing is buffered beyond a socket buffer and a frame. A session
ends with an error when its sandbox is stopped or removed or the daemon stops, and a stopped sandbox is refused, never
started. Buffered `exec` keeps its 16 MiB limit. S01: 256 MiB of random bytes went in and came back with the same
hash on both sides, the daemon grew by at most 5 MiB. The CLI's side of a stream is byte-exact in both directions
for `exec` and `workspace exec` (`test/unit/exec-bytes.test.ts`: every byte value, invalid UTF-8 and 3 MiB of random
bytes in, the same hash out, and stderr kept apart, against a stub session server). S02: stderr stayed apart, exit 5 and end of input came through.
S03: a shell saw this terminal's size and a resize, Ctrl-C ended a `sleep` inside, and the terminal was restored. S04:
a session ended within a second of `paddock stop`. S06: a reader asleep for longer than the whole transfer takes held
the command in the sandbox back.

Buffered exec and extension output use process stream writes and wait for completion before exiting, preserving an
inherited regular file descriptor's current offset on stdout and stderr, including JSON output. Unit fixtures compare
the complete redirected files, with text written before and after the CLI, for source and compiled sandbox/workspace
exec. The reported `Bun.write` truncation did not reproduce with the project shell's Bun 1.4.2 in either mode; those
tests passed before this defensive change too. The tester's runtime-specific cause remains unverified.

### Forwards

`paddock forward add NAME --port P` makes the daemon listen on 127.0.0.1, once, at `--local-port` or a port the
system picks (no port is probed and assumed free; one in use is refused). Each connection it accepts opens a session
that runs a relay on the sandbox's own loopback: `nc 127.0.0.1 P` from a static BusyBox the core copies into the
sandbox at `/.paddock/busybox` through the engine's archive API, because the image may have no `nc`, `socat` or
interpreter of its own. It is copied before every start and again by each `forward add`. gVisor does not show a file
the engine adds behind a running guest once the guest has looked in that folder, until the sandbox restarts: measured
with one `ls /.paddock` before the first forward, and also for a new top-level folder after a listing of `/`. A copy
made before the start exists before any guest process can look, and replacing a file the guest can see works. A guest
that removes the relay while running hides any new copy, so `forward add` runs the relay once and refuses with the
restart to make, instead of listening and relaying the engine's error. The relay gets the port as a number and nothing else. The engine publishes nothing and gets no
listener on its host. Each direction waits for the other side. End of input passes on as a half-close: the relay
stays while the port answers and is ended after ten minutes of silence, since a client that has gone after its FIN
looks the same as one still waiting. W09 keeps a control connected
while dropping another connection and checks that its `nc` process ends within five seconds. A forward
belongs to one run of one sandbox (its id and the engine's start time): it ends on `forward remove`, when the sandbox
stops or is removed through Paddock, within two seconds when the engine restarts or stops it behind Paddock's back
(and any connection after that is refused), and when the daemon stops. A sandbox recreated under the same name starts
with none. The core, not the provider, reports the forwards disclosure. W01: a nonce on the sandbox's loopback came back
on 127.0.0.1 at the reported port, the daemon's only socket for it; the engine reported no port bindings and its host
had the same listeners before and after; verify listed the forward. W02: the forward did not answer at this machine's
other addresses or the engine host's, where control listeners did. W04: the listener was gone within 10 s of each
ending condition, an engine restart included. W05: a recreated name had no forward. W06: an occupied explicit port
was refused with exit 4 and nothing recorded. W07: 64 MiB of random bytes each way came back with the same hash. W08:
50 connections at once each got their own 256 KiB back, and no relay process was left. W10: after the guest listed
`/.paddock` before the first forward, the forward carried a nonce, as did a control where nothing looked (before this
change the first failed with `failed to load /.paddock/busybox`); after the guest removed the relay, `forward add` was
refused with the restart named and nothing recorded, and after a stop and start the forward worked.

### SSH for editors

`paddock ssh setup NAME` runs a script as root inside the running sandbox (`GUEST_SETUP` in `core/ssh.ts`). It
installs OpenSSH's server with apk, apt-get or dnf when the image has none, makes a new Ed25519 host key in
`/.paddock/ssh`, and writes a configuration there that accepts only this machine's editor key, for exec's user
only, with no password, keyboard-interactive, agent, X11, tunnel, remote or Unix-socket forwarding, and local
forwarding only to the sandbox's own `127.0.0.1` and `localhost`. The user's own `~/.ssh` inside is not read. sshd
refuses an account whose password is locked, so a leading `!` is replaced by `*` (still no password), and the
checklist says so. The editor key pair is made once with `ssh-keygen` in the state folder's `ssh/` (mode 0700) and
only its public half leaves it. The core then writes `ssh/config`, an alias per set-up sandbox, and `ssh/known_hosts`,
its host key under `HostKeyAlias paddock-ID`, where ID is the sandbox's own id. The alias has
`StrictHostKeyChecking yes`, `IdentitiesOnly yes`, `IdentityAgent none`, `ForwardAgent no` and `GatewayPorts no`
(an `ssh -L` listens on this machine's loopback only), and its ProxyCommand
is this executable by absolute path, `ssh proxy NAME`, with the state and config folders set. That command opens an
`ssh` session on `stream.sock`, and the daemon runs `sshd -i` as root in the sandbox for that one connection; a
stopped sandbox is refused and not started. `--write-config` puts `Include` and the file's path first in
`~/.ssh/config` (`PADDOCK_SSH_CONFIG` names another file), once; without it the line is printed. A link there is
refused rather than replaced. Removing a sandbox removes its alias and host key. `sshAccess` reports the alias, the
user and home, and `batchReady` (set up, running, and included). A01: `ssh NAME.paddock` logged in as exec's user
and home, without a prompt; while a session was open the engine's host, the daemon, ssh and its ProxyCommand had no
new listener. A02: 4 MiB went in and out by scp and by SFTP with the same hash. A03: `ssh -L` reached a service on
the sandbox's loopback; a tunnel to the sandbox's own network address, where the sandbox reached the same kind of
service itself, was refused by sshd; a client asking to forward its agent got none. A04: another key with the same
alias was refused. A05: after removing and recreating the name, the old alias was refused before setup and failed host
key verification after it; the new files logged in. A06: SSH to a stopped sandbox failed and it stayed stopped.

### Resize

`paddock resize NAME` changes the memory, task limit, CPUs and disk limit of a running or stopped sandbox, and says for
each whether it applies now or at the next start. The provider sets memory, tasks and CPUs with the engine's update
and, for a running sandbox, reads them back from the sandbox's cgroup on the engine's host; "now" is said only when
what it read is the new value, and otherwise the change is reported for the next start with the reason. A stopped
sandbox's change is "next start". The disk limit is the daemon's watch, so a new one applies at its next pass, within
30 seconds. The manifest records the new values and the limits check then fails on any other value, so a limit
changed behind Paddock's back stops the sandbox.

Inside, gVisor does not show the new limits: L01's `/proc/meminfo` kept the 512 MiB it started with after a resize to
1 GB, and L03's `nproc` said 2 under one CPU and under two. The engine's host enforces the new ones. L01: 700 MB in
one process was killed under 0.5 GB (the control) and completed after a resize to 1 GB, with `memory.max` at 1 GiB on
the engine's host. L02: lowering to 0.5 GB took effect on the running sandbox, and 1 GB and 1024 tasks set while
stopped were the host's values after the start and passed verify. L03: three busy loops used about one CPU, then about
two after `--cpus 2`; 300 sleeps failed under 256 tasks and ran after `--pids 2048`.

Lowering a running sandbox's memory or task limit is refused with a conflict (exit 4) when what it uses now is 90% or
more of the new limit, because the engine kills a sandbox that passes either; so is a disk limit below its disk use,
and a lowering whose use cannot be read is refused rather than guessed. Memory in use is counted as `docker stats`
counts it. Sizes outside the ranges of create are a usage error (exit 2), an unknown sandbox exit 3, and a refused
resize changes nothing. L04: 300 MB written to `/dev/shm`, which gVisor keeps in memory, was counted as in use and
refused a 0.25 GB limit, and 300 sleeping processes refused a task limit of 256; once the memory was freed, 0.5 GB
was allowed. L05: `docker update --memory 2g` behind Paddock's
back failed verify with exit 6 and stopped the sandbox. L06: 1.3 GB on disk refused a 1 GB disk limit; once freed, the
limit was set, and the same write was stopped by the disk watch.

### Templates

`paddock snapshot NAME --as TEMPLATE` saves a sandbox's files as a template, and `paddock create NEW --template
TEMPLATE` (or `"template"` in a spec) makes a sandbox from it. A template is an image under a repository named for
this daemon (`paddock-template-<owner>`, where the owner is a hash of this machine's name and the state folder), with
labels for its name, its owner, the sandbox it came from and the login files left out. `paddock template list` shows
only images with all three: this owner's repository, its owner label, and a tag equal to its name label. An image name
in Paddock's template or snapshot space is refused as `--image` (C06); a template is chosen by name, resolved to its
image ID under the template's lock, and the manifest records the template and the ID. The checklist's template check
fails if the container runs another image and otherwise discloses the template, its source and date, whether it has
been removed since, and, for a sandbox given a template's image ID as a plain image, that it is one. A template sandbox
is created and checked like any other (C04: every blocking check held, with live network probes, and the host did not
answer it).

What a template holds: every file in the sandbox's own filesystem as the engine's layer has it, home folders included:
shell history, `.env` files, package-manager tokens and any login not in Paddock's list. Removed before saving: the
login files the credentials check looks for (Claude, Codex, GitHub, git, SSH keys, AWS, netrc) under `/root` and
`/home/*`, and Paddock's own relay and SSH host key. Not in it: processes and memory, `/dev/shm` and any other folder
gVisor keeps in memory (`/proc/mounts` inside shows them as tmpfs; it was so for `/tmp` in Alpine, whose `/tmp` is
empty, and not in the default image, whose `/tmp` is not empty, so that `/tmp` is saved), volumes (inner Docker's
`/var/lib/docker`, so no inner images or containers, and any volume the image declares), and the engine's
`/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf`. The snapshot's result states this. Paddock does not claim a
template has no secrets: C02 shows `.npmrc` is carried.

How it is made: the engine commits the sandbox, pausing a running one for the commit (C03: the engine's events show a
pause and an unpause; the sandbox kept running with its processes and the same start time). A container of that
image then runs under gVisor with no network and only Paddock's busybox, copied in to a randomly named folder, to
delete the login files and Paddock's own files; a second commit saves the result under the template's name, and the
intermediate image and container are removed. It needs a runtime with `--overlay2=none`, without which the engine does
not see the sandbox's writes (C01's control reads a file from the engine right after it was written inside). Paddock
refuses a snapshot otherwise; no engine here lacks the flag, so that refusal is not measured. The pause makes the copy
consistent at the file level for that moment, as a power cut would leave a disk: a program halfway through writing a
file is saved halfway.

C01 (Alpine): files written under `/root`, `/home` and `/opt` carried; `/dev/shm`, `/tmp` and lines added to
`/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf` did not. C02: the three login files planted were absent from the
image as the engine copies it out, the template says it left them out, the new sandbox's credentials check found none,
`.npmrc` was there, and the image had neither the relay nor the snapshot's busybox. C05 (the default image): a Docker
sandbox made from a Docker sandbox's template had its files, `/tmp` included, its own data volume and none of the
source's inner images.

Removing a template removes its name. Sandboxes made from it keep running, stopping and starting, because the engine
keeps an image a container uses; the image is deleted when the last of them is removed (C07). A template no sandbox
uses is deleted at once (C05, C07). A stopped sandbox can be saved without starting it (C07).

## Where the guarantee ends

- **A forward is open to this machine.** It listens on loopback, which every process of every user here can connect
  to, as can anything the engine relays to this machine's loopback. On OrbStack, `host.docker.internal` from the
  engine's host and from ordinary containers arrives at this machine's 127.0.0.1, so they reach a forward as they
  reach any loopback service (W03). Sandboxes do not: their guard blocks that address.
- **The editor key logs in.** Anything that can read `ssh/editor_ed25519` in the state folder, which is anything
  running as you, can log in to every sandbox set up for SSH as its user, run any command there, copy files in and out,
  and reach the sandbox's loopback with `ssh -L`. It cannot reach this machine or other addresses through sshd. The
  sandbox's own limits and guard still apply to what it runs.

- **Something with your rights on this machine can change Paddock itself.** An agent running outside a sandbox, or an
  extension's command, runs as you. It could edit the core or call the engine directly. The checks catch a
  customization or an engine update that weakened a sandbox; they do not defend against code that already runs as you.
- **Extensions run commands on this machine.** Install one the way you would install any script.
- **Egress is open.** A sandbox can reach the internet, so anything inside it, including logins you copy in, can be
  sent out. The checklist discloses both.
- **The disk limit is watched, not capped,** on engines without a hard cap. A sandbox can write for up to 30 seconds
  past its limit before it is stopped. A clean daemon stop stops the watched sandboxes first; after a daemon crash
  nothing watches until a daemon runs again (its first act is a pass over every sandbox). Volumes an image declares,
  and the inner Docker data volume, are counted. Inner Docker shares this limit with the sandbox.
- **Inner privileges belong to the sandbox.** `--docker` grants `NET_ADMIN` and `SYS_ADMIN` inside gVisor, including
  control of its inner network and mounts. It does not grant host namespaces or devices. An inner privileged container
  still shares the outer sandbox's limits and guard. The evals exercised its memory limit with an inner privileged
  container. Independent limits set by the inner daemon are not a Paddock guarantee.
- **Between two passes, up to 30 seconds, a weakened sandbox keeps running.** So does one whose guard was changed by
  something with root on the engine's host.
- **The LAN and tailnet blocks are probed against stand-ins, not your devices.** IPv6 and the metadata address have no
  control: IPv6 is judged by the loaded rules, and metadata by one attempt that did not connect.
- **The limits are read, not re-measured, by the checklist.** The evals measure them. On OrbStack, passing the memory
  limit kills the sandbox, and so does running out of the task limit: gVisor's own threads count against it, so a
  limit of 256 held about a hundred processes. `paddock list` says which of the two happened.
- **A template carries secrets that are not on Paddock's list.** Only the usual login files are removed. Shell history,
  `.env` files, package-manager tokens and logins kept elsewhere are saved, and every sandbox made from the template
  has them. A file being written at the moment of the save is saved as it was then.
- **Inside a resized sandbox, gVisor does not show the new limits.** The engine's host enforces them; resize's report
  and the limits check are the place to read them, not `/proc/meminfo` or `nproc`.
- **Two Paddocks on one engine share the guard.** Each sweeps only its own probe helpers, but a guard changed for one
  is changed for both.
- **Measurements belong to an engine and OS.** See `evals/SCORECARD.md` for OrbStack on Apple Silicon and
  `evals/SCORECARD.linux.md` for native Linux Docker. Docker Desktop, Colima, and Windows execution remain unmeasured.
  Native Docker may still drop inter-bridge traffic with Paddock's guard removed. A Tailscale host may drop a synthetic
  tailnet control. Neither result establishes a controlled live probe for that target.

## The daemon

One daemon per user owns all state and serializes operations per sandbox, so two clients cannot race. A CLI that finds
a daemon of another version, or of an older build of the same one, replaces it without stopping the sandboxes. At its start a daemon removes probe containers
and networks an interrupted verify left behind. A daemon that is stopping refuses new work and a client waits for it to
finish, so a second daemon never runs beside it. It listens on:

- a Unix socket in the state folder (mode 0600), used by the CLI;
- a second one, `stream.sock` (mode 0600), for sessions only, including the ones `ssh NAME.paddock` opens;
- `127.0.0.1` at each forward's port, relayed to the sandbox and nothing else;
- `127.0.0.1` on port 7717 (or a free port), used by the dashboard. Requests need the token from `paddock ui` and a
  `Host` header naming this server. `shutdown`, `sshSetup` (it can change `~/.ssh/config`) and sessions are not
  available here.

State is in `~/.local/state/paddock`, configuration in `~/.config/paddock` (`PADDOCK_STATE_DIR`, `PADDOCK_CONFIG_DIR`).
Malformed request URLs, including invalid percent encoding in paths or query parameters, receive a generic HTTP 400
before routing or reading dashboard files. No parser diagnostic is returned.

## Machines

The first Machines unit registers an already prepared daemon with `host attach NAME --ssh DEST --binary PATH
--state-dir PATH`. It installs nothing. The primary alone writes `CONFIG/hosts.json` atomically, mode 0600. Each
daemon keeps a random persistent `STATE/machine-id`; each daemon process has a separate boot ID. Registry aliases
cannot be rebound implicitly. Attach records the account SSH uses, from `ssh -G`, and the outer host's public key with
its fingerprint (`SHA256:…`), captured as described below; `host list` shows them, with whether the remote daemon has its dashboard
listener and whether it runs under systemd. Removing a prepared host forgets its entry and cache and ends its open
sessions and forwards; its remote installation and data are retained. `host add` installs a reviewed Linux system
service as described below; remote uninstall remains an explicit manual operation.

### The host-key pin

Enrollment (attach, and the probes of host add) records the destination's public key from OpenSSH itself: Paddock passes
a `KnownHostsCommand` that writes the key the server offered during key exchange to a private file and adds no trust;
the user's own known_hosts must still accept the key (`StrictHostKeyChecking=yes`), and a key is recorded only when ssh
got past that check (it did not exit 255) and reported exactly one plain key for the destination. This replaces a
KnownHostsCommand of the user's own for that connection and needs OpenSSH 8.5 or later on the primary.

Every later request and stream of a host with a recorded key, and every SSH command of an enrollment after consent,
runs with a private known_hosts file holding only that key under a fixed `HostKeyAlias`, `GlobalKnownHostsFile=/dev/null`,
`KnownHostsCommand=none`, `VerifyHostKeyDNS=no` and `CheckHostIP=no`. OpenSSH therefore checks the destination against
that one key before authentication, so no operation byte is sent and none is read from a server holding another key,
even if the user's known_hosts, DNS or a KnownHostsCommand now trusts it; such a refusal is `identity-changed`, never
`outcome-unknown`. A ProxyJump hop is a separate ssh that these options do not reach, so the user's own trust still
checks the jump host, and a jump's refusal is reported as offline, not as a changed destination key. Check the
destination, remove the record explicitly, and use host add/attach to re-enroll deliberately.

The pin used to be the `Server host key` line of `ssh -v`. That is not sound: OpenSSH prints a server's pre-authentication
banner to the same stderr, newlines included, after key exchange. Against a throwaway sshd on loopback (OpenSSH 10.3 on
macOS, its own host key and configuration) a banner line `debug1: Server host key: ssh-ed25519 SHA256:<another key>`
came after the real one and before `Sending command`, and the old parser read the forged fingerprint as verified.
Records from that version carry only a fingerprint; they are refused with `identity-changed` and the steps to re-attach,
never used unpinned. Records without any key, from before fingerprints, still rely on OpenSSH's strict known_hosts
check alone.

`test/unit/ssh-pin.test.ts` measures this with the real client and a throwaway sshd on loopback, skipped where
`/usr/sbin/sshd` is absent: the banner forgery against `ssh -v`; the captured key is the real one despite the banner;
a pinned call succeeds; a pin to another key is refused as `identity-changed` while the fixture's known_hosts trusts the
real key, and the server's command never ran; through ProxyJump the pinned destination answers and a jump the
known_hosts does not trust is refused as offline; a destination the known_hosts does not trust is not recorded. Unit
fixtures cover the options passed and the old-record refusal. Not measured: a real remote machine with a changed key, a
user `KnownHostsCommand` or `@cert-authority` setup at enrollment, and OpenSSH versions other than 10.3.

`hosts.json` must be `{version: 1, hosts: [...]}`; each record in it is then read on its own. A record this Paddock does
not know (a future service kind or disk policy) or a damaged one is listed by `host
list` and `list --all` as `unknown-record` with the reason, and routing to it is refused; the other hosts keep working.
`host remove NAME --confirm NAME` forgets such a record, and attaching another host writes it back unchanged.

`--host NAME` before the command's `--` selects a registered machine. The API uses `{host: "NAME", name: "demo"}`;
unqualified names are always local, even when absent. Sandbox views carry `machineId` and `sandboxId`, so identical
names on two machines have distinct identities. `machineId` can also be supplied as a precondition with `host`: every
routed call, stream, forward and SSH setup/access whose `machineId` differs from the host's record is refused before
any connection is opened. An unknown host never falls back. Buffered sandbox operations, engines, templates, extensions, checklist,
verify and daemon status/stop route over SSH. Streams, primary loopback forwards and SSH setup/access also select
the remote daemon. The dashboard UI has not been changed to group remote machines.

The gateway executes the registered absolute binary's fixed `transport stdio --protocol 1` command, with the state
directory set explicitly. That command only relays bytes to an existing daemon socket; it cannot install, start or
replace a daemon. When the daemon's side closes, it ends its stdout (up to five seconds for SSH to take the last
bytes) and exits without waiting for SSH to close stdin. On the primary, a stream's frames already received, its exit
status among them, are delivered after its ssh exits, and a request over an SSH link that has already ended fails at
once as offline. `PADDOCK_SOCKET_ONLY=1` when starting the remote daemon disables its dashboard TCP listener. No
remote Docker context is introduced. Only the target daemon's core operates its engine or supplies checks.

Each operation gets its own system SSH connection, reading the user's SSH config for ports and jump hosts. BatchMode
and strict host-key verification are required; UpdateHostKeys, agent/X11 forwarding, configured port forwarding and
shared control masters are disabled. Paddock writes no outer SSH config or trust file. The user must have established
outer host trust before attaching. The transport handshakes and sends the request on one HTTP connection. The
handshake carries the version, protocols, methods, features, the artifact's own SHA-256 (`buildDigest`) and a source
digest: SHA-256 over every file under `core/`, `cli/` and `ui/` and `package.json`, computed when the program is bundled
or loaded, so the x64 and arm64 binaries of one source tree have the same one. Exactly these are refused, with nothing
sent to the sandbox and nothing replaced:

- by the primary, on every connection: a remote version other than its own, a remote that does not offer protocol 1,
  a remote source digest other than its own (two builds of one version), and a machine ID other than the record's;
- by the remote daemon, on every routed request: a request whose machine ID, protocol, version or source digest
  headers differ from its own;
- by the remote stream socket: an open whose boot ID, protocol, version or source digest differs.

`buildDigest` is shown but not compared, because it differs between platforms. There is no negotiation and no upgrade:
the refusal says to build Paddock for that machine from this source (`bun build --compile --target=bun-linux-x64` or
`bun-linux-arm64`), put it in place of the recorded binary and restart that daemon. Local CLI build replacement retains
its previous behavior. After a mutation is sent, transport failure means `outcome-unknown`; no mutation is
automatically replayed.

Every remote call has a deadline: ten seconds for the handshake and reads, 45 minutes for a mutation (a `create` with
an image pull). A client that goes away (Ctrl-C, a closed dashboard request) closes that call's SSH connection; a
mutation already sent is then `outcome-unknown`, said as a cancellation. Closing an SSH process sends SIGTERM, then
SIGKILL after 1.5 seconds, and gives up after 1.5 more, so a stopped or wedged `ssh` cannot hold the primary: `daemon
stop` waits at most 4.5 seconds for remote links before it stops the local sandboxes whose disk limit it watches.

Lost, malformed or oversized mutation replies are unknown outcomes even if SSH had already accepted their bytes, and
the error says which of the three happened. A valid daemon refusal keeps its reported error, cut to 4000 characters, as
are remote stream errors. Transport unit tests drive real Unix byte connections for these
cases. M10 also substitutes a hostile SSH transport on the Linux fixture. On streams it sends malformed exit and error
JSON, an out-of-range exit code, a 65,000-character error, a 4 GiB length header, an unknown kind byte and output before
`ready`; for buffered calls a relay answers the handshake from the real daemon and then sends a reply of the wrong
shape, invalid JSON or 9 MiB. Each is refused (reads exit 8, mutations exit 10), the same primary daemon keeps
answering, and valid stream and buffered controls still work. M02 measured an unroutable host offline after about five
seconds (SSH's connect timeout) and a silent daemon after ten (the handshake deadline). M11 stopped the primary in under
five seconds with one of its SSH processes stopped by SIGSTOP, and its local watched sandbox was stopped.

The typed method catalog in `core/machines.ts` limits routing. The gateway checks socket-only access before SSH is
opened, and the target validates the ordinary request again. Bootstrap and primary resources are not a generic RPC
proxy. Remote JSON replies are capped at 8 MiB: past that a read fails as `incompatible` and a mutation is
`outcome-unknown`, both saying the reply exceeded 8 MiB. Every routed reply is checked against its method's shape
before it is used: a malformed one is refused (`incompatible` for a read, `outcome-unknown` for a mutation). A sandbox
row the primary cannot read is shown `damaged` with the reason, and the machine stays online with its other rows; a row
that names another machine rejects the whole reply. Machine summaries are validated before replacing cached evidence.
The CLI replaces control and bidirectional-override characters in any text a daemon sends before printing it. `host list` refreshes hosts concurrently with bounded read deadlines. `fleet`/`list --all`
return the cache and schedule independent refreshes with retries capped at 60 seconds. A lost or stale machine keeps
its last-known sandboxes with `unknown` status and unknown checks, with the original check time. A machine with no
successful summary has no sandbox inventory and is shown as connecting/offline, never as a successful empty list.

The M eval group needs `PADDOCK_EVAL_HOST` naming an authorized Linux SSH fixture. It builds a native Linux artifact
here, checks its checksum after copying, starts a socket-only daemon in a private temporary home directory, attaches
it, and removes it at teardown. It never installs packages, uses sudo, restarts Docker or edits system/SSH files.
Reboot persistence and automatic recovery are unmeasured; the fixture daemon runs only until stopped, killed or reboot.
The scorecards record the actual M results. Group N separately measures reviewed root installation on explicitly
provisioned disposable OrbStack machines. The routing fixture is used only for N01's read-only plan and the M evals.

### Reviewed host enrollment

`core/hosts.ts` owns `hostPlan` and `hostApply`. Both are socket-only primary methods; neither can be routed or called
with a dashboard token. The CLI prints the complete plan before consent. `--json` returns it without applying, even
when an acceptance hash is present. Interactive consent is exactly `yes`; automation supplies `--accept-plan HASH`.
The hash covers the primary's source/version, destination SSH host key, account, OS/machine/boot identities, relevant
file bytes and ownership, container inventory, artifacts, package transaction, paths, service, sudo vectors and watched
disk choice. Docker's current-time field is excluded; installation-relevant engine fields are retained.

The Python bootstrap probe performs no sudo or destination writes. It needs existing Python 3, glibc and systemd,
readable system files, established SSH trust and readable Docker inventory when changing an existing engine. Apt
sources, keys and package indexes are hashed; source contents and the exact dependency URLs, versions and SHA-256
checksums appear when Docker is absent. Apply downloads and verifies that resolved transaction and uses `dpkg --install`
on those files. It does not add repositories, refresh apt metadata or resolve more dependencies after consent.

The primary verifies an explicitly supplied Linux ELF artifact before SSH and again before delivery. The destination
checks its SHA-256 before installation. It downloads the pinned gVisor release archive, checks its SHA-512, and takes
from it only the files the plan names, each against a pinned SHA-256; anything else in the archive refuses the
installation before its first step (N20). There is no signed release channel or implicit compilation. Root-owned immutable paths select the artifact; an unrelated command or service is
refused. Root paths through symlinks or directories writable by another account are refused. A backup with the wrong
bytes is refused. Exactly one named Docker runtime is merged, with full before/after contents and a line diff. A changed
runtime plans validation, backup, configuration installation and Docker restart. Every running container is listed,
even with live restore. An unchanged runtime that Docker has loaded plans no Docker restart. Only what is missing is
planned: a binary, runtime or unit already in place is not installed again. Another artifact plans a restart of the
Paddock service alone, and the plan names the running sandboxes that restart stops (N17). Each step records what it
leaves on the host, and the CLI prints the plan as text with the destination's control characters removed.

The daemon re-probes before delivery. The destination probes again after delivery and optional sudo authentication,
before installation. Changed inputs return a revised plan and invalidate consent. Interactive enrollment opens a
bootstrap session only on the primary's private stream socket. Password input travels to `sudo -v` on the same forced
SSH terminal used by subsequent sudo commands; neither the HTTP API, plan nor journal contains it. This also works
with tty-scoped sudo timestamps. Automation uses `sudo -n` and needs noninteractive permission. Ctrl-C between SSH phases cancels verification, waits for smoke cleanup and returns exit 130 with the terminal
restored and no registration (N13). A disconnected terminal cannot commit a host registration; an interrupted install can have an unknown outcome and names its journal.

The system unit runs as the SSH user with `SupplementaryGroups=docker`, a fixed PATH, socket-only access and
`Restart=on-failure`, after Docker. State/configuration live under `/var/lib/paddock/UID`. Login groups and sudoers are
not changed. Docker authority is effectively root. Installation progress and the interrupted step are journaled there,
separately from sandbox manifests. Failure reports the completed steps, what they left and what the interrupted step
may have left, without shared-package rollback; a failure before the first step says that none ran. An installer
session that reports success and exits nonzero is an unknown outcome and registers nothing (N17).
`--sudo never` reuses a verified enabled system service in this layout; user-unit installation is conservatively refused
because its boot behavior is unmeasured. Another prepared layout can still use `host attach`.

Registration follows the artifact/source/protocol handshake, active/enabled service inspection, a ready local engine on
the runtime `paddock-runsc`, all applicable blocking smoke checks at creation and again after a real disk write with
host-side byte measurement, and smoke cleanup. `verify` returns `diskUsedBytes` when measurable and omits it otherwise.
Disk enforcement remains watched. The daemon prefers `paddock-runsc` to any other gVisor runtime registered on its
engine (N16). That runtime is registered without `--net-raw` and does not advertise inner Docker, unless the host is
enrolled with `--docker`; the option is part of the plan and its hash, and the smoke sandbox then has to pass the inner
Docker check (N19). No hard disk helper, disk tools or sudoers entry is installed. No reboot recovery is claimed.
[Enrollment instructions](host-enrollment.md) include manual uninstall and explain which remote objects `host remove`
retains. N01 through N20 provide the outside controls; unavailable fixtures are not measured.

Hosted streams use the existing second Unix socket and frame protocol over their own SSH process. The gateway first
retrieves the current sandbox identity and run; the stream opens with that identity plus the expected daemon boot,
version and protocol. A stopped, replaced or restarted target refuses the stale request. Input and output use the same
bounded backpressure as local sessions. Losing SSH ends the session with an error; commands are never replayed.

A hosted forward binds once on the primary's `127.0.0.1`. Its remote control stream grants a lease for one sandbox ID,
engine start time and numeric loopback port. Each accepted connection gets a separate SSH dial stream validated
against that lease. The target checks the run every two seconds, and closes its lease and dials on stop/remove or
daemon exit. It reports the requested lease in verify, while explicitly saying that the primary's listener is unknown
from there; no check reports hosted forwards on the primary, where `paddock --host HOST forward list` shows them. The
lease is renewed in both directions. The target's control emits a byte every five seconds; after fifteen seconds
without one, a primary timer closes the listener and active connections. The primary writes a renewal byte every five
seconds; after fifteen seconds without one (checked every two), the target ends the lease and its dials, and the
stream's `transport stdio` process exits, so a partitioned or stopped primary leaves nothing open on the target. An observed SSH/control/dial failure
closes it immediately when delivered. There is no automatic recreation. M08 measured closure within seventeen seconds
with a control SSH process stopped by SIGSTOP, beside a healthy forward that stayed open. With the primary daemon itself
stopped by SIGSTOP (so it neither renews nor closes, and its SSH links stay up), the target ended the lease and its
`transport stdio` relay exited after 16 to 17 seconds; after a killed SSH link, the remote daemon's exit and the primary's
exit, no relay was left on the target. These are awake-daemon measurements on one fixture, not a continuous enforcement
claim during a suspended machine.

Remote editor aliases are `SANDBOX.HOST.paddock`, preserving unqualified local aliases. Only the primary makes or
reads its editor private key. The target receives its public half through socket-only `sshPrepare`, prepares guest
sshd, and returns the guest public host key. The primary validates that data and writes its own state-directory SSH
files. Both machine and sandbox IDs form the pinned HostKeyAlias; ProxyCommand also sends the expected sandbox ID.
Removing a prepared host, or a remote sandbox through this primary's `--host HOST remove`, removes its primary
alias (a failure to update it is reported beside the completed removal). A sandbox removed on its own machine leaves
the alias, which then refuses to connect because the sandbox ID differs. Ordinary SSH configuration is modified only
when `--write-config` is explicitly requested; evals redirect it to a temporary file. M09 measured login and SFTP,
absence of a remote editor private key, and refusal of stopped/recreated sandboxes. Real editor bootstrap and T3 over
the remote alias remain unmeasured.

## macOS workspaces are a separate kind

`core/workspaces.ts` owns macOS workspaces. They have `WorkspaceSpec`, `WorkspaceManifest`, a `state/workspaces/`
directory and `WORKSPACE_CHECKLIST`. They reuse result types and the existing `complete`, `blockers` and `failures`
functions with their own checklist. A workspace is not a sandbox or a `Provider`; it cannot satisfy the sandbox's
isolated-kernel, network or resource-limit checks. No sandbox check is skipped or reworded for it.

The `workspaceList`, `workspaceGet`, `workspaceCreate`, `workspaceExec`, `workspaceShell`, `workspaceStop`,
`workspaceRemove`, `workspaceSet` and `workspaceVerify` methods are all socket-only and local. Shells and streamed exec use the
existing stream socket with `kind: "workspace"`; remote routes and a requested user are refused. The dashboard's
read-only summary carries a separate workspace inventory. Dashboard workspace actions remain unavailable to honor
socket-only authority. Summary reads manifests and tagged-process counts without identity repair, chmod or tree
walks. CLI list/get alone request live size measurements. The 30-second enforcement pass does no workspace work.

Launch runs only blocking checks. Create and verify additionally inspect listeners, logins, hard links, Time Machine
and an available ffmpeg hardware-only encode. Verify does not repair directory permissions for its hard-link walk;
remove does. Policy controls use confined processes with same-operation allowed decisions, and the daemon/socket
check includes real listeners, in a private fixture and in shared `T`, each with a working outside control. A `--` separator prevents command arguments from
changing sandbox-exec's parameters.

Credential reading and Claude's state allowlist live in `core/credentials.ts`, reused by the login extension.
Workspace specs explicitly select `default` or named profiles, or no logins. Daemon environment variables cannot
choose sources. Keychain password reads are bounded to 15 seconds, with no credential values in diagnostics or
manifests. Claude's private credential/state files were measured through product-path `auth status`; authenticated
requests and refresh remain unverified.

The profile is static SBPL plus parameter-name-only read and ancestor rules. Every path is canonical and passed
using `-D`. Tag denies come last. `workspace-processes.ts` uses `bun:ffi` and a small runtime C varargs wrapper for
Darwin's calling convention, without a helper binary. Both the allowed-folder/denied-tag criterion and the recheck
immediately before every signal are required. Source and compiled execution, empty/exact finder controls, detached
process cleanup and private project copying have local K evals. See [macOS workspaces](workspaces.md) for the complete
boundary, test-root validation, copied-login limits and temporary-source handling. In particular, Apple events and
Keychain authentication are not established by a policy decision or the presence of a credential file.

`PADDOCK_WORKSPACE_ONLY=1` disables providers for a daemon used solely for workspaces. The K-only runner sets this
with private state, so it neither discovers engines nor connects to registered machines. A normal daemon retains its
existing provider sweep and sandbox enforcement.

`spec.hostTemp` is an explicit boolean, defaulting to false for legacy manifests. Only the on profile adds a
parameter for the canonical per-user `T` folder, with a file read and write allowance and no network allowance, and
a `file-read-metadata` allowance for the literal folder that contains `T` (its listing and its `C` and `0` stay
denied), which tools that create folders under `T` need. The off profile is unchanged. `workspaceSet` refuses running
processes and clears old verification before later launches use the regenerated profile; setting the current value
again rewrites a profile that a Paddock update changed, and launch's refusal names that command. Verification probes real `T` reads and writes, still-denied sibling paths, and a refused
confined connection to a real listener in `T` beside an unconfined control, reporting the disclosed exception as
`weak`. Inventory and removal include its shared-file, socket-file, cleanup and size limits. The live Seatbelt and
`confstr` tests in `test/unit/workspaces.test.ts` measure temp-path, metadata and socket access, not PyTorch/MPS or
CoreML workloads. ONNX Runtime's CoreML provider running an ML Program on the GPU with the metadata rule was measured
by hand outside the test suite, with a profile that still allowed Unix socket connections in `T`. See [shared temp configuration](workspaces.md#allow-the-shared-per-user-temp-folder).

## Adding a provider

Implement `Provider` in `core/types.ts` and add it to the list in `core/daemon.ts`. `detect()` reports each engine with
its `capabilities`, and `checks()` must give honest evidence for every checklist item of the stage it is asked for.
`core/providers/docker-sandboxes.ts` is the stub to fill in next.

## Bundled clients

The bundled login extension imports selected Claude and Codex credentials and optional setup, imports GitHub tokens,
and lists or removes guest logins through the daemon's exec API. It runs host tools as the user, and the imported
credentials live inside the sandbox. See `extensions/logins/README.md` for the setup allowlist and measured limits.
Missing setup commands are named only from settings actually sent, with bounded printable names and credential
values withheld. The CLI also provides streamed exec, port forwards, and SSH access. Inner Docker is a checked core
option, and the core resizes sandboxes and saves them as templates. Buffered operations can select a prepared remote
daemon; streams, forwards and editor aliases use the same route. Reviewed system-service enrollment is available
with explicit artifacts. A hard disk cap, user-service installation and automatic reboot recovery are not built.
