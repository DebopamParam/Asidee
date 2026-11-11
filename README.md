# Paddock

Sandboxes for coding agents, on the engine you already have, that are checked instead of assumed.

"Paddock" is a working name. This is an early alpha (0.3.0): the structure is in place and one engine works end to end.

## What it does

`paddock create demo` makes a sandbox, starts it, and runs a fixed checklist against it: it runs on an isolated kernel,
it has no host folders, it cannot reach the host, other sandboxes or the LAN, and so on. A sandbox that fails a blocking
check does not run. `paddock verify demo` runs the checklist again at any time, and the daemon repeats the cheap half of
it every 30 seconds and stops a sandbox that stopped holding.

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

Works, and was run on OrbStack on an Apple Silicon Mac:

- The gVisor provider: any local Docker engine with a gVisor runtime. Create, start, stop, remove, exec, shell.
- Optional inner Docker, tested on OrbStack. `paddock create demo --docker` starts a private daemon; its containers
  reach HTTPS through the sandbox's guarded network. It uses copy-on-write `overlayfs` storage (two containers from one
  image share its layers) and adds exactly `NET_ADMIN` and `SYS_ADMIN` inside gVisor, each shown necessary for pull,
  run, HTTPS and build. A one-RUN `docker build` and a one-service `docker compose up` were run.
- The checklist, with live network probes that have controls, and a stop when a blocking check fails. The probes
  cover the host, other sandboxes, and stand-in addresses in each private (LAN) range and the tailnet range.
- The firewall guard is compared rule for rule with the one Paddock ships, so an added or removed rule shows as changed.
- A disk limit that the daemon watches (it stops a sandbox that passed its limit; it is not a hard cap). It needs a
  gVisor runtime registered with `--overlay2=none`; without it the checklist says there is no disk limit.
- A stopped sandbox says why, in `paddock list` and the dashboard: a failed check, the disk watch, the daemon
  stopping, or the engine killing it at its memory or task limit.
- A mistake in `config.json` or a damaged state file is reported by name instead of being ignored.
- The daemon, the CLI with `--json`, a web dashboard, and extensions.

Not built yet:

- Docker Sandboxes (microVM) support. It is detected and reported as not supported.
- Port forwarding, SSH access for editors, importing agent logins, templates.
- A hard disk cap, Linux and Windows hosts (nothing was run there), remote engines, a desktop app, installers.
- A license. Nothing here is published.

## Try it

You need [Bun](https://bun.sh) and Docker with a gVisor runtime. `nix develop` gives you Bun if you use Nix.

```sh
bun install
bin/paddock doctor                 # which engines are ready, and what the others need
bin/paddock create demo --image ubuntu:24.04
bin/paddock exec demo -- uname -a
bin/paddock shell demo
bin/paddock verify demo
bin/paddock ui --open              # the dashboard
bin/paddock remove demo --confirm demo
```

To run Docker inside, use the default image, which includes `docker`, `dockerd` and `iptables-legacy`:

```sh
bin/paddock create builder --docker
bin/paddock exec builder -- docker run --rm alpine:latest echo inner-ok
bin/paddock remove builder --confirm builder
```

`docker` defaults to `false`. Config defaults can set `"docker": true` as a JSON boolean. The engine needs gVisor
registered with `--net-raw` and `--overlay2=none`; Paddock reports whether it has the `docker` capability and refuses
the option when it does not. Inner images, containers and volumes count toward the same watched disk limit.
Inner containers use the sandbox's DNS. Under gVisor the engine's resolver refuses queries and its upstream is in a
range the guard drops, so Paddock gives the sandbox a public fallback, **1.1.1.1 and 8.8.8.8**, disclosed by the Docker
check. Verify's inner probe runs from Paddock's helper image, copied in from the engine (no registry is asked, so it
works offline), by its image ID; it removes the copy afterwards unless it was already there. With less than 64 MiB of
disk headroom it reports unknown network evidence with the disk reason.

What a sandbox's main process prints (dockerd's log, or anything written to `/proc/1/fd/1`, which a sandbox without
Docker can do too) is stored on the engine's host, outside the watched limit, so every sandbox's log rotates at 10 MiB
with two files, which the checklist verifies. `exec` returns at most 16 MiB on each of stdout and stderr: past that,
Paddock ends the command and reports an error that names the limit instead of a cut-off result. `exec --stream` and
`shell` have no such limit: they are sessions the daemon relays as raw bytes, with backpressure, over a second socket
in the state folder that only this user can open (see [Sessions](docs/architecture.md#sessions)).

Stopping the daemon (`paddock daemon stop`) stops the sandboxes whose disk limit it watches, because nothing would
enforce the limit afterwards. Their contents stay; `paddock start` brings them back.

`bun run build` makes a standalone `dist/paddock`. `bun test` runs the unit tests; `bun run test:live` creates a real
sandbox and expects every blocking check to hold.

## How it is measured

`bun evals/run.ts` runs the eval set: the claims this README and the checklist make, each tried from outside
Paddock with plain engine commands (a connection from inside a sandbox, a fork bomb, a rule slipped into the firewall,
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
skill/        instructions for an AI agent that operates or customizes Paddock
```

The rule: only the core touches an engine, and everything else is a client of its API. You, or your AI, can rewrite the
dashboard and add extensions freely, and none of that can change what a sandbox is or what `paddock verify` reports.
[docs/architecture.md](docs/architecture.md) explains the boundary and where the guarantee ends.

## Customizing

- **Extensions** add actions and hooks. An extension is a folder in `~/.config/paddock/extensions/` with an
  `extension.json`; see [extensions/examples/agent-tools](extensions/examples/agent-tools).
- **The dashboard** is replaced by putting your own `index.html` in `~/.config/paddock/ui/`.
- **Defaults** (image, sizes, Docker, engine) go in `~/.config/paddock/config.json`.

[skill/SKILL.md](skill/SKILL.md) tells an AI agent how to do each of these.

## Import agent and GitHub logins

The bundled [logins extension](extensions/logins) imports one selected Claude or Codex profile, optionally its setup,
and a GitHub token from stdin, a hidden prompt, or this machine's `gh` login. It also lists and removes guest logins.
Run `bun extensions/logins/login.ts --help` with `paddock` on PATH, or install its folder as a Paddock extension.
It needs Bun on this machine and Node in an already running sandbox; GitHub also needs guest `gh` and `git`.
Existing credentials require an explicit replace choice. **There is no secret proxy in a gVisor container: the token
lives inside the sandbox and code there can read and send it out.** Logout leaves this machine logged in.
Imports of file-backed Claude and Codex profiles and of this machine's `gh` login were checked live in one sandbox; the
Claude Keychain path and agents accepting an imported login were not. Its README lists what was checked.
