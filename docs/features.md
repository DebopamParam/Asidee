# What Asidee does

The full description of what is built, moved from the README. [Getting started](getting-started.md) has the commands.

## Sandboxes and their checks

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

## Built so far

Built features (engine measurements are recorded in [the Mac scorecard](../evals/SCORECARD.md) and [the Linux scorecard](../evals/SCORECARD.linux.md)):

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
  [GPU containers](architecture.md#gpu-containers-are-a-separate-weaker-kind).
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
- Links to an address outside Asidee, such as a virtual machine on this Mac: `asd link add agent vm --address
  192.168.64.5 --port 22` lets programs in `agent` connect to `vm:22`, and the daemon relays each connection to
  192.168.64.5:22 from this machine. The guard is unchanged. The address must be an IPv4 address (no host names, not
  127.x). Whatever there trusts this machine trusts `agent`, and what that address can reach is outside Asidee's
  checks. The measurement checks that the daemon reaches the address, that `agent` does not reach it directly, and
  that a connection from `agent` by its name is relayed; it ends when `agent` is removed.
- Links to a public sandbox on a connected Linux machine (other machines must be on): `asd link add agent box
  --to-host home-linux --port 22` lets programs in `agent` connect to `box:22` and reach port 22 on the loopback of
  `box` on `home-linux`. The daemon relays each connection over SSH the way a forward to that machine does: a lease on
  `box`'s run and port, and a remote session per connection. A private `box` is refused; it must be made public on
  its own machine (`asd share box` there). `box` sees these connections as local, so a service there that trusts local
  connections trusts `agent`. The link waits while `home-linux` cannot be reached or `box` is stopped or private, and
  opens again on its own; it goes when `agent`, the host record or `box` is removed, or `box` is made again. The
  measurement checks that a connection from `agent` by the name `box` is relayed through `home-linux`'s daemon and that
  `agent` cannot reach `home-linux` directly; no test listener runs in `box`, so its other ports and its service are
  not checked.
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
  a template leaves the sandboxes made from it working. See [Templates](architecture.md#templates).
- An agent template: `asd template prepare` makes a sandbox from the built-in image, installs tmux, fd, zip, htop, vim
  and nano from its packages and Claude Code and Codex from npm (at this machine's versions when they are installed
  here, else latest; `--claude` and `--codex` choose), runs an optional `--script FILE` as the sandbox's user, checks
  each tool, saves the template `agent` and removes the sandbox. `--default`, or `asd config set default-template
  agent`, makes new sandboxes start from it when a create names neither an image nor a template. The dashboard's
  Templates page has the same form, with the versions filled in from this machine; its script is
  `~/.config/asidee/agent-template.sh` or pasted text. Both call one daemon method, and the script runs only inside
  the sandbox being prepared.
- One-step create: `asd create demo --gh --claude PROFILE --codex PROFILE --repo OWNER/REPO --t3` runs the bundled
  extensions after the create: this machine's GitHub login, each login with its setup (repeat `--claude` or `--codex`
  for several), a clone into `~/workspace`, `--copy DIR[:DEST]` (a folder of your home copied in, to the same place
  under the sandbox's home unless DEST is given; repeat it for several; each folder is checked before the create) and T3 Code. `--t3-browser` also installs the
  Chrome T3's browser pane uses. On this machine only.
- A create that does not finish leaves nothing behind for long. If the sandbox itself cannot be made, nothing is kept.
  If its checks fail, or a setup step fails (the first failure stops the rest), the sandbox is kept for 30 minutes after
  its last progress and then removed by the daemon (not while a shell or forward is open in it). `asd create --retry
  NAME` finishes it: the checks again if they failed, then the steps left, from the one that failed. `asd create --keep
  NAME` keeps it as it is. `asd list`, `asd get` and the dashboard (Retry, Don't remove) show when it goes.
- `asd claude demo [PROFILE]` and `asd codex demo [PROFILE]` open the agent in `~/workspace` with an imported login.
  The dashboard opens the same in a terminal window on the Mac.
- The daemon, the CLI with `--json`, a web dashboard, and extensions. The dashboard is a list of sandboxes with a page
  for each, a list of extensions with a page for each (its actions as forms, with the same `asd ext run` command
  beneath), and a first run that tests the engine with a throwaway sandbox; terminal-only steps such as `asd setup` show
  as a command it waits for. What it does to the Mac itself (workspaces, the custom terminal command, `~/.ssh/config`,
  machines, daemon stop) has a ⌘ on its button and runs only after Allow in a dialog there, which denies by itself
  after 60 seconds; where no dialog can be shown, the page offers the CLI command. Every copyable command quotes its
  values for the shell.
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
  See [Machines](architecture.md#machines) for the current limits and opt-in measurements.
- Each sandbox is **private or public**. One created on its own machine is private; one another machine created
  through `--host` is public; sandboxes from before this existed are public. Other machines never see a private
  sandbox: lists leave it out and every routed call on it is refused, saying it is private. `asd share NAME` and
  `asd unshare NAME` change it, on its own machine only; another machine can make a public one private, never the
  reverse. Other machines may create sandboxes on a machine only after `asd config set remote-create on` there (off
  by default). Private keeps a sandbox from other machines. Anyone signed in to this machine's own account can still
  see it. The dashboard lists other machines' public sandboxes beside this machine's, tagged with their machine, each
  with its own page, and runs this Mac's extensions on them (`asd --host NAME ext run …`, with `ASIDEE_HOST` set).
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
  [Enroll a Linux host](host-enrollment.md) for prerequisites, explicit build commands, sudo behavior and retained
  remote objects. Reboot persistence remains unmeasured.


Not built yet:

- A hard disk cap, a desktop app, and a signed release installer. The remote dashboard is later.
- A license.
