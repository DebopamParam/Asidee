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
- **The API cannot express an unsafe sandbox.** A spec is a name, an image, four sizes and a boolean `docker`
  option (`validSpec` in `core/state.ts`); unknown fields are dropped. There is no field for a mount, a capability,
  a runtime or a port. Each engine reports whether it supports `docker`; create refuses an unsupported request.

## The checklist

`core/checks.ts` lists the checks. Providers supply the evidence for each one; a check a provider does not report comes
out as "could not be checked", never as a pass.

| Check | Blocking | When | How the gVisor provider checks it |
|---|---|---|---|
| Isolated kernel | yes | after start | The runtime is gVisor, and the kernel inside identifies as gVisor. |
| Inner Docker is available when requested | yes | after start | Its Unix socket answers, its data root is /var/lib/docker, and its driver is the copy-on-write `overlayfs`. The detail discloses the public DNS fallback. Not requested is a disclosure. |
| No privileged mode, host namespaces, undeclared capabilities or devices | yes | before start | Engine configuration. With Docker, exactly NET_ADMIN and SYS_ADMIN added inside gVisor; otherwise no additions. |
| No host folders | yes | before start | Engine configuration; with Docker, volume driver options and ownership too. |
| Own network, guard loaded | yes | before start | Engine configuration, and the loaded firewall rules compared rule for rule with the shipped ones. |
| No open ports | yes | before start | Engine configuration. |
| Memory, process, CPU limits | yes | before start | Engine configuration, including json-file host log rotation (10 MiB, two files) for every sandbox. |
| Disk limit | no | before start | The engine's capability: hard, watched or none. Watched needs a runtime with `--overlay2=none`. |
| Cannot reach the host | yes | verify | Live probe with controls. |
| Cannot reach other sandboxes | yes | verify | Live probe with controls. |
| Cannot reach LAN, tailnet, metadata, IPv6 | yes | verify | Live probe with controls of a stand-in address in each private range and the tailnet range; one attempt at the metadata address; IPv6 by the loaded rules. |
| Internet access | no | verify | Live attempt; a disclosure. |
| Logins inside | no | verify | Looks for the usual credential files; a disclosure. |

"Verify" runs after every create and on `paddock verify`. A start runs the configuration and runtime checks. On a stopped sandbox, verify
reports the configuration checks only and marks the rest as not checked.

The isolated-kernel check also refuses a gVisor runtime registered with a flag that opens a path to the host or
switches a limit off (`unsafeRuntimeArgs` in `core/providers/gvisor.ts`), and `paddock doctor` does not offer one.

### Staying true after the start

Every 30 seconds the daemon repeats the configuration and runtime checks and the disk measurement on each running sandbox, and stops
one that fails, recording the reason. A check that could not be made in one pass does not stop a running sandbox: that
is usually an engine that was busy. Four such passes in a row do, because by then nobody is checking it. The probes are not repeated on the timer: they start containers, and `paddock verify` runs them.

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
already routes somewhere is skipped and named in the result. One probe runs per engine at a time.

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

### Sessions

`paddock exec --stream` and `paddock shell` are sessions. The daemon relays them on a second Unix socket in the state
folder, `stream.sock` (mode 0600), and on nothing else: the dashboard's port cannot open one, with or without its
token (S05). The protocol, paddock-stream/1 in `core/stream.ts`, is frames of a kind byte, a four-byte length and at
most 64 KiB of payload. The client sends `open` and waits for `ready`; then it sends input, end of input and terminal
sizes, and the daemon sends stdout and stderr apart and last the exit code or an error. The provider runs the command
through the engine's API (an exec whose start is upgraded to a raw stream on the engine's Unix socket), not through the
engine's CLI, and a closed session's processes are ended by their `PADDOCK_EXEC` tag as above. Each direction waits
for the other side to take what it was given, so nothing is buffered beyond a socket buffer and a frame. A session
ends with an error when its sandbox is stopped or removed or the daemon stops, and a stopped sandbox is refused, never
started. Buffered `exec` keeps its 16 MiB limit. S01: 256 MiB of random bytes went in and came back with the same
hash on both sides, the daemon grew by at most 5 MiB. S02: stderr stayed apart, exit 5 and end of input came through.
S03: a shell saw this terminal's size and a resize, Ctrl-C ended a `sleep` inside, and the terminal was restored. S04:
a session ended within a second of `paddock stop`. S06: a reader asleep for longer than the whole transfer takes held
the command in the sandbox back.

## Where the guarantee ends

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
- **Two Paddocks on one engine share the guard.** Each sweeps only its own probe helpers, but a guard changed for one
  is changed for both.
- **Only OrbStack on an Apple Silicon Mac was run.** Docker Desktop, Linux hosts and Windows are untested.

## The daemon

One daemon per user owns all state and serializes operations per sandbox, so two clients cannot race. A CLI that finds
a daemon of another version, or of an older build of the same one, replaces it without stopping the sandboxes. At its start a daemon removes probe containers
and networks an interrupted verify left behind. A daemon that is stopping refuses new work and a client waits for it to
finish, so a second daemon never runs beside it. It listens on:

- a Unix socket in the state folder (mode 0600), used by the CLI;
- a second one, `stream.sock` (mode 0600), for sessions only;
- `127.0.0.1` on port 7717 (or a free port), used by the dashboard. Requests need the token from `paddock ui` and a
  `Host` header naming this server. `shutdown` and sessions are not available here.

State is in `~/.local/state/paddock`, configuration in `~/.config/paddock` (`PADDOCK_STATE_DIR`, `PADDOCK_CONFIG_DIR`).

## Adding a provider

Implement `Provider` in `core/types.ts` and add it to the list in `core/daemon.ts`. `detect()` reports each engine with
its `capabilities`, and `checks()` must give honest evidence for every checklist item of the stage it is asked for.
`core/providers/docker-sandboxes.ts` is the stub to fill in next.
