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
| Inner Docker is available when requested | yes | after start | Its Unix socket answers and its data root is /var/lib/docker. Not requested is a disclosure. |
| No privileged mode, host namespaces, undeclared capabilities or devices | yes | before start | Engine configuration. With Docker, exactly NET_ADMIN and SYS_ADMIN added inside gVisor; otherwise no additions. |
| No host folders | yes | before start | Engine configuration; with Docker, volume driver options and ownership too. |
| Own network, guard loaded | yes | before start | Engine configuration, and the loaded firewall rules compared rule for rule with the shipped ones. |
| No open ports | yes | before start | Engine configuration. |
| Memory, process, CPU limits | yes | before start | Engine configuration. |
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

With `docker` enabled, verify also runs a container from the helper's pinned Alpine base inside the sandbox's Docker
daemon. The network checks include its connection attempts. An internet connection controls whether the inner
container has a working outward path; a failed control makes its isolation evidence unknown. The I evals also remove
the guard and show that the same inner probes then reach the host, another sandbox, and all four private-range stand-ins.

### Inner Docker

`docker` adds `NET_ADMIN` and `SYS_ADMIN` to Docker's default capabilities. These privileges apply inside gVisor,
whose kernel remains the boundary. I01 runs all three smaller subsets on the live engine. Without `NET_ADMIN`, dockerd
cannot create its bridge. With only `NET_ADMIN`, it starts but cannot extract an image (`unshare: operation not
permitted`). Both additions run an Alpine container and reach HTTPS. This establishes minimal additions for this
daemon and workload on this engine, not a universal minimum for every Docker implementation.

The provider starts dockerd as the sandbox's main process, as root, on each start. It uses a fixed configuration,
`--storage-driver=vfs`, `--iptables=false` and `--ip6tables=false`. It clears stale PID files, waits for Docker's
socket, and sets `iptables-legacy` masquerading out of `eth0`. The runtime must have `--net-raw` and `--overlay2=none`.
The host helper sets `gso_max_segs 1` on this sandbox's veth so forwarded traffic receives separate packets.
An exited dockerd stops the sandbox; there is no automatic restart. `paddock start` starts it again after the guard
and configuration checks. The runtime check repeats the socket probe on every enforce pass.

`/var/lib/docker` uses a volume unique to the sandbox's random id, with ownership labels. It is not a host folder.
For Docker sandboxes, the mounts check also inspects every mounted engine volume. Only the local driver without
mount options is accepted; a bind-backed volume still reports type `volume`, so checking that type alone is insufficient.
The Docker data volume must have the sandbox's ownership labels. An unreadable volume is unknown, not a pass. I14
replaces the data volume with one backed by the engine host's `/tmp` and shows that start refuses it without running it.
The disk measurement adds the writable layer and engine-side `du` of volumes mounted read-only in the trusted
helper. It never asks the sandbox to report its own usage. Remove deletes the Docker volume even if the sandbox's
container was already deleted. The `vfs` driver copies layers and can use more space than a host Docker engine.

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
- `127.0.0.1` on port 7717 (or a free port), used by the dashboard. Requests need the token from `paddock ui` and a
  `Host` header naming this server. `attach` and `shutdown` are not available here.

State is in `~/.local/state/paddock`, configuration in `~/.config/paddock` (`PADDOCK_STATE_DIR`, `PADDOCK_CONFIG_DIR`).

## Adding a provider

Implement `Provider` in `core/types.ts` and add it to the list in `core/daemon.ts`. `detect()` reports each engine with
its `capabilities`, and `checks()` must give honest evidence for every checklist item of the stage it is asked for.
`core/providers/docker-sandboxes.ts` is the stub to fill in next.
