# Asidee

Sandboxes for coding agents that are checked instead of assumed.

"Asidee" (Agent Sandbox IDE) is a working name. This is an early alpha (0.4.0): the structure is in place and one engine works end to end.

## What it does

`asd create demo` makes a sandbox, starts it, and runs a fixed checklist against it: it runs on an isolated kernel,
it has no host folders, it cannot reach the host, other sandboxes or the LAN, and so on. A sandbox that fails a blocking
check does not run. `asd verify demo` runs the checklist again at any time, and the daemon repeats the cheap half of
it every 30 seconds and stops a sandbox that stopped holding.

In text, `create` and `resize` count the checks that held on one line and print every other result in full;
`verify` and `--json` list every check. Every command takes `--help`.
`doctor` exits 5 when no engine is ready. On a stopped sandbox, `verify` checks configuration only and can exit 0.
Run `asd start NAME`, then `asd verify NAME` to check the rest. `list` shows the disk limit and the time
since verification, with one footer explaining that those checks are historical.

Piped input reaches sandbox and workspace exec only with `--stdin` or `--stream`.
Ctrl-C during buffered create, workspace create, resize or snapshot exits 130. The daemon keeps finishing the work;
the CLI says where the result will appear and, for a create, the exact remove command.

Each check reports one of six results, and says whether it was probed (tried against the live sandbox) or inspected (read
from the engine's configuration):

| Mark | Meaning |
|---|---|
| ✓ | Holds. |
| ~ | Holds in a weaker form; the detail says how. |
| ✗ | Does not hold. If the check is blocking, the sandbox is stopped. |
| – | This engine cannot provide it. |
| ? | Could not be checked. |
| i | A disclosure, such as which logins are inside the sandbox. |

## Status

Built features (engine measurements are recorded in [the Mac scorecard](evals/SCORECARD.md) and [the Linux scorecard](evals/SCORECARD.linux.md)):

- The gVisor provider: any local Docker engine with a gVisor runtime. Create, start, stop, remove, exec, shell.
- Optional inner Docker. `asd create demo --docker` starts a private daemon; its containers
  reach HTTPS through the sandbox's guarded network. It uses copy-on-write `overlayfs` storage (two containers from one
  image share its layers) and adds exactly `NET_ADMIN` and `SYS_ADMIN` inside gVisor, each shown necessary for pull,
  run, HTTPS and build. A one-RUN `docker build` and a one-service `docker compose up` were run.
- The checklist, with live network probes that have controls, and a stop when a blocking check fails. The probes
  cover the host, other sandboxes, and stand-in addresses in each private (LAN) range and the tailnet range.
- The firewall guard is compared rule for rule with the one Asidee ships, so an added or removed rule shows as changed.
- GPU containers, a separate and weaker kind: `asd create NAME --gpu` runs on Docker's `runc`, on the host's own
  Linux kernel, with its NVIDIA GPU, as uid 1000 with no capabilities, `no-new-privileges`, seccomp and AppArmor.
  **It is not a sandbox: a bug in the host's kernel or NVIDIA driver is a way onto the host.** Every output labels it
  "GPU container · host kernel", and it has its own checklist (the kernel is disclosed, never passed; confinement and
  `nvidia-smi` are checked). Only an engine whose Docker lists an NVIDIA GPU offers it. See
  [GPU containers](docs/architecture.md#gpu-containers-are-a-separate-weaker-kind).
- A disk limit that the daemon watches (it stops a sandbox that passed its limit; it is not a hard cap). It measures
  every 5 seconds; `asd config set disk-watch SECONDS` changes that, from 1 to 30. It needs a
  gVisor runtime registered with `--overlay2=none`; without it the checklist says there is no disk limit.
- A stopped sandbox says why, in `asd list` and the dashboard: a failed check, the disk watch, the daemon
  stopping, or the engine killing it at its memory or task limit.
- A mistake in `config.json` or a damaged state file is reported by name instead of being ignored.
- Port forwards: `asd forward add demo --port 3000` listens on this machine's 127.0.0.1 and relays each connection
  to port 3000 on the sandbox's own loopback through a daemon session, so the engine publishes no port. A forward
  belongs to one run of one sandbox and ends when it stops, restarts or is removed, or when the daemon stops.
  If nothing listens inside yet, the forward is kept with a warning. A service started later can use it.
  Remote daemon and SSH lifetime caveats appear only when selecting a remote host.
  **On OrbStack, `host.docker.internal` exposes this machine's loopback to the engine host and ordinary containers,
  including Asidee forwards.** Guarded sandboxes cannot reach that address.
- Links between sandboxes on this machine: `asd link add web db --port 5432` lets programs in `web` connect to
  `db:5432` and reach port 5432 on `db`'s loopback, nothing else. No network is shared and the guard is unchanged:
  inside `web` the name `db` points at a loopback address of the link's own, where a listener hands each connection to
  the daemon, which relays it like a forward. `db` sees these connections as local, so a service there that trusts
  local connections trusts `web`. Each link is measured when it opens and on verify (a test value comes through; other
  ports and `db`'s network address do not answer), and one that fails is cut. A link comes back after either
  sandbox restarts and after a daemon restart, is down while the daemon is not running, carries TCP only, up to 64
  connections at once, and ends when either sandbox is removed.
- SSH for editors: `asd ssh setup demo` prepares sshd inside and an alias, `demo.asidee`, whose ProxyCommand
  runs sshd in inetd mode through a daemon session, so no port is opened anywhere. It trusts only a key made for this
  machine's editors and the host key made inside that sandbox; scp, SFTP and `ssh -L` to the sandbox's loopback work.
  `--write-config` adds one `Include` line to `~/.ssh/config`; without it the line is printed.
- Resize: `asd resize demo --memory 8 --cpus 4` changes memory, tasks, CPUs and the disk limit, and says for each
  whether it applies now or at the next start. "Now" is said only after the new value is read back from the engine's
  host; inside, gVisor does not show the new limits (`/proc/meminfo` keeps the old memory). Lowering memory or tasks
  below what the sandbox uses is refused, and the limits check holds the sandbox to the new values.
- Templates: `asd snapshot demo --as base` saves the sandbox's files, and `asd create next --template base`
  starts from them, with the same checklist. **A template holds every file in the sandbox, home folders included:
  shell history, `.env` files and tokens other than the usual login files are in it.** The usual login files are
  removed before saving; volumes (inner Docker's images and containers), memory and `/dev/shm` are not saved. Removing
  a template leaves the sandboxes made from it working. See [Templates](docs/architecture.md#templates).
- An agent template: `asd template prepare` makes a sandbox from the built-in image, installs tmux, fd, zip, htop, vim
  and nano from its packages and Claude Code and Codex from npm (at this machine's versions when they are installed
  here, else latest; `--claude` and `--codex` choose), runs an optional `--script FILE` as the sandbox's user, checks
  each tool, saves the template `agent` and removes the sandbox. `--default`, or `asd config set default-template
  agent`, makes new sandboxes start from it when a create names neither an image nor a template. The dashboard's
  Templates tab has the same form, with the versions filled in from this machine; its script is
  `~/.config/asidee/agent-template.sh` or pasted text. Both call one daemon method, and the script runs only inside
  the sandbox being prepared.
- One-step create: `asd create demo --gh --claude PROFILE --codex PROFILE --repo OWNER/REPO --t3` runs the bundled
  extensions after the create: this machine's GitHub login, each login with its setup (repeat `--claude` or `--codex`
  for several), a clone into `~/workspace`, `--skills DIR` (that folder's agent skills and plugins into
  `~/workspace`) and T3 Code. `--t3-browser` also installs the Chrome T3's browser pane uses. On this machine only.
- A create that does not finish leaves nothing behind for long. If the sandbox itself cannot be made, nothing is kept.
  If its checks fail, or a setup step fails (the first failure stops the rest), the sandbox is kept for 30 minutes after
  its last progress and then removed by the daemon (not while a shell or forward is open in it). `asd create --retry
  NAME` finishes it: the checks again if they failed, then the steps left, from the one that failed. `asd create --keep
  NAME` keeps it as it is. `asd list`, `asd get` and the dashboard (Retry, Keep as it is) show when it goes.
- `asd claude demo [PROFILE]` and `asd codex demo [PROFILE]` open the agent in `~/workspace` with an imported login.
  The dashboard opens the same in a terminal window on the Mac.
- The daemon, the CLI with `--json`, a web dashboard, and extensions. What the dashboard does to the Mac itself
  (workspaces, the custom terminal command, `~/.ssh/config`, machines, daemon stop) runs only after Allow in a dialog on
  the Mac, which denies by itself after 60 seconds; where no dialog can be shown, the page offers the CLI command.
- Other machines are **experimental and off by default**: they are not yet proven on enough machines. While off, the
  daemon refuses every `host` command, `--host NAME` and `list --all`, contacts no registered machine and leaves the
  registry as it is; `asd config set experimental on` turns them on. A daemon that another machine reaches over
  SSH answers it whatever its own setting. With the setting on:
  Prepared Linux daemons can be registered with `asd host attach NAME --ssh DEST --binary /absolute/asd
  --state-dir /absolute/state`. Buffered sandbox operations select one daemon with `--host NAME`, over system SSH to
  its Unix socket. The remote daemon runs its own provider and checks. A different version, protocol, source build or
  machine identity is refused, with how to update the other machine. `asd host list` reports unreachable machines,
  each host's SSH account and host key, and records it cannot read; `list --all` retains cached sandboxes as unknown.
  `shell`, streamed exec, primary-loopback forwards and editor SSH use the same route. Remote aliases are
  `SANDBOX.HOST.asidee`. A forward ends with its sandbox run, either daemon or its SSH control stream; fifteen
  seconds without a heartbeat from the other side ends it on either machine. Add a new forward after link loss.
  See [Machines](docs/architecture.md#machines) for the current limits and opt-in measurements.
- `asd host add NAME --ssh DEST --artifact PATH --sha256 HASH` enrolls a Linux systemd host after a read-only probe
  and review of a hash-bound plan: every privileged command and what it leaves, every file diff and checksum, and every
  running container a planned Docker restart may interrupt. `--json` applies nothing; interactive consent requires
  `yes`, and automation uses `--accept-plan HASH`. The installer verifies artifacts, preserves unrelated Docker
  configuration, installs a service as the SSH user and registers only after sandbox smoke verification.
  Each root step uses a private copy whose checksum it checks before use. Staging paths are fresh on every attempt;
  repository source URLs omit usernames and passwords, and interactive sudo is refreshed before each step. Disk limits are
  watched. The host's sandboxes can run Docker inside only when it is enrolled with `--docker`. `--sudo never` only
  reuses an installation that is already complete. The disposable-fixture N evals cover approval, stale plans, both
  checksum checks, partial failure, installation, inner Docker and manual uninstall. Read
  [Enroll a Linux host](docs/host-enrollment.md) for prerequisites, explicit build commands, sudo behavior and retained
  remote objects. Reboot persistence remains unmeasured.


Not built yet:

- A hard disk cap, a desktop app, and a signed release installer. The remote dashboard is later.
- A license. Nothing here is published.

## macOS workspaces are not sandboxes

`asd workspace create render --copy /absolute/project` makes a disposable `~/Asidee/render` folder. Commands
started through `asd workspace shell render` or `workspace exec render -- COMMAND` inherit a Seatbelt profile.
They run directly on the Mac and can use its GPU; K06 measured Metal compute and hardware-only HEVC VideoToolbox
encoding on Apple M5. Chrome's own sandbox cannot start inside a workspace, so Chrome-based tools need `--no-sandbox`
(workspaces tell HyperFrames so).
`workspace stop` ends processes identified by their kernel profile. `workspace remove render --confirm render` stops
them and deletes the folder, leaving the original project alone. Asidee never copies with hard links.

A workspace is **not a sandbox**. It shares this Mac's kernel and user, has no CPU, memory or process limits, and keeps
the network and loopback open. Its disk use is watched, not capped: while the daemon runs it stops a workspace's
processes within about 30 seconds of passing its `--disk` limit (default 20 GiB), or when free space falls below
`asd config set workspace-free-space GiB` (default 5). Reads outside home are open. Remote effects, unified logs, existing backups and changes through
externally supplied hard links can survive removal. Apple events and permission-gated capabilities are not covered.
Asidee passes no flags to change agents' own sandboxes. Entering the folder from an ordinary shell applies no profile.

Creation imports the `default` agent profiles, with explicit `--claude-profile NAME` and `--codex-profile NAME`
selection or `--no-logins`. Claude's macOS Keychain login uses the shared sandbox credential reader, with a 15-second
timeout; it may prompt. Product-path `claude auth status` reported logged in after import. Authenticated calls and
refresh remain **unverified**; no login or logout is attempted. Create and verify probe hardware-only VideoToolbox
when ffmpeg is available. Command launches run only blocking checks, and dashboard summaries do no tree walks or repairs.

Workspace size, disk limits and free-space floors use GiB (1024³ bytes). Create and verify text shows at most eight
distinct `port (process)` listeners; `--json` keeps the full detail. When stop, remove or the disk watch ends a command,
its stderr says why before the session ends. Signal exits use 128 plus the signal number (137 for SIGKILL).

Workspaces require macOS and Bun, without a Docker engine. The separate workspace checklist never weakens the
sandbox checklist. The dashboard shows workspaces in their own section. Reading and verifying one are open to it; a
create, change, command, stop or remove from it first shows a dialog on the Mac that must be allowed (see [Approval on the Mac](docs/architecture.md#approval-on-the-mac)).
A shell stays with the CLI and the Terminal button.
See [macOS workspaces](docs/workspaces.md) and [their separate K scorecard](evals/SCORECARD.workspace.md) for controls,
removal limits and login status. The full sandbox scorecards were not regenerated for this feature.

## Try it

For sandboxes, you need [Bun](https://bun.sh) and Docker with a gVisor runtime. `nix develop` gives you Bun if you use Nix.
On a Mac, Asidee runs sandboxes on [OrbStack](https://orbstack.dev) with gVisor. `asd setup` gives OrbStack gVisor:
you approve one plan (download the pinned gVisor release into `~/.local/share/asidee/gvisor`, add an `asidee-runsc`
runtime to `~/.orbstack/config/docker.json`, restart the engine, naming the containers that stop), and setup is done
only after a test sandbox passes the checks. When no default engine is set, setup then makes OrbStack the default. Its
apply step (the config edit and the engine restart) is covered by unit
tests only, since the development Mac's engine must not be restarted. `asd setup --remove` undoes it.

```sh
bun install
bin/asd setup                  # once, on a Mac: give the engine gVisor and prove it
bin/asd doctor                 # whether the engine is ready, and what it needs if not
bin/asd create demo --image ubuntu:24.04
bin/asd exec demo -- uname -a
bin/asd shell demo
bin/asd verify demo
bin/asd ui --open              # the dashboard
bin/asd remove demo --confirm demo
```

To run Docker inside, use the default image, which includes `docker`, `dockerd` and `iptables-legacy`:

```sh
bin/asd create builder --docker
bin/asd exec builder -- docker run --rm alpine:latest echo inner-ok
bin/asd remove builder --confirm builder
```

`docker` defaults to `false`. Config defaults can set `"docker": true` as a JSON boolean. The engine needs gVisor
registered with `--net-raw` and `--overlay2=none`; Asidee reports whether it has the `docker` capability and refuses
the option when it does not. Inner images, containers and volumes count toward the same watched disk limit.
Inner containers use the sandbox's DNS. Under gVisor the engine's resolver refuses queries and its upstream is in a
range the guard drops, so Asidee gives the sandbox a public fallback, **1.1.1.1 and 8.8.8.8**, disclosed by the Docker
check. Verify's inner probe runs from Asidee's helper image, copied in from the engine (no registry is asked, so it
works offline), by its image ID; it removes the copy afterwards unless it was already there. With less than 64 MiB of
disk headroom it reports unknown network evidence with the disk reason.

What a sandbox's main process prints (dockerd's log, or anything written to `/proc/1/fd/1`, which a sandbox without
Docker can do too) is stored on the engine's host, outside the watched limit, so every sandbox's log rotates at 10 MiB
with two files, which the checklist verifies. `exec` returns at most 16 MiB on each of stdout and stderr: past that,
Asidee ends the command and reports an error that names the limit instead of a cut-off result. `exec --stream` and
`shell` have no such limit: they are sessions the daemon relays as raw bytes, with backpressure, over a second socket
in the state folder that only this user can open (see [Sessions](docs/architecture.md#sessions)).

Stopping the daemon (`asd daemon stop`) stops the sandboxes whose disk limit it watches, because nothing would
enforce the limit afterwards. Their contents stay; `asd start` brings them back.

`bun run build` makes a standalone `dist/asd`. `bun test` runs the unit tests; `bun run test:live` creates a real
sandbox and expects every blocking check to hold.

## How it is measured

`bun evals/run.ts` runs the eval set: the claims this README and the checklist make, each tried from outside
Asidee with plain engine commands (a connection from inside a sandbox, a fork bomb, a rule slipped into the firewall,
a container swapped for a privileged one, the dashboard in a real browser). A blocked attempt counts only beside a
control that shows the same attempt connects when nothing blocks it. [evals/SCORECARD.md](evals/SCORECARD.md) is the
last run, including the claims nobody has measured yet. [evals/README.md](evals/README.md) says how to run it on
your own engine, which is the way to find out what holds there.

## How it is put together

```
evals/        the claims, measured from outside
core/         the rigid part: the spec, the checklist, the providers, the daemon and its API
cli/          a client of the API
ui/           a client of the API (one HTML file)
extensions/   examples of the flexible part
skill/        instructions for an AI agent that operates or customizes Asidee
```

The rule: only the core touches an engine, and everything else is a client of its API. You, or your AI, can rewrite the
dashboard and add extensions freely, and none of that can change what a sandbox is or what `asd verify` reports.
[docs/architecture.md](docs/architecture.md) explains the boundary and where the guarantee ends.

## Customizing

- **Extensions** add actions and hooks. An extension is a folder in `~/.config/asidee/extensions/` with an
  `extension.json`; see [extensions/examples/agent-tools](extensions/examples/agent-tools). Six extensions ship
  inside `asd`: [logins](extensions/logins), [repo](extensions/repo), [env-docs](extensions/env-docs),
  [t3](extensions/t3), [rotator](extensions/rotator) and [skills](extensions/skills). `asd ext list` shows the ones not yet installed;
  `asd ext install NAME` (or the dashboard's Install button) installs one and `asd ext remove NAME` removes it. They
  need neither Bun nor the Asidee source.
- **The dashboard** is replaced by putting your own `index.html` in `~/.config/asidee/ui/`.
- **Defaults** (image, sizes, Docker, engine) go in `~/.config/asidee/config.json`.

[skill/SKILL.md](skill/SKILL.md) tells an AI agent how to do each of these.

## Import agent and GitHub logins

The bundled [logins extension](extensions/logins) imports one selected Claude or Codex profile, optionally its setup,
and a GitHub token from stdin, a hidden prompt, or this machine's `gh` login. It also lists and removes guest logins.
Install it with `asd ext install logins`, then use the dashboard or `asd ext run logins ACTION SANDBOX`. From the
Asidee source, `bun extensions/logins/login.ts --help` with Bun and `asd` on PATH shows the direct commands, including
a pasted GitHub token. It needs Node in an already running sandbox; GitHub also needs guest `gh` and `git`.
Existing credentials require an explicit replace choice. **A login token imported into a sandbox can be read by
anything running in that sandbox, which can also send it out. There is no host-side token proxy yet.** The sandbox and
this machine then hold the same refresh token; when one side refreshes it, the other may be logged out (not measured).
Logout leaves this machine logged in.
Imports of file-backed Claude and Codex profiles and of this machine's `gh` login were checked live in one sandbox. On
2026-11-18 a Keychain Claude login with its setup (1050 files, 19 MB) was imported and Claude Code inside answered a
prompt with it; Codex accepting an import was not checked. The shared Keychain reader and
Claude's login recognition are now measured separately for workspaces. Its README lists the sandbox measurements.
