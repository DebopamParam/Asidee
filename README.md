# Paddock

Sandboxes for coding agents, on the engine you already have, that are checked instead of assumed.

"Paddock" is a working name. This is an early alpha (0.1.0): the structure is in place and one engine works end to end.

## What it does

`paddock create demo` makes a sandbox, starts it, and runs a fixed checklist against it: it runs on an isolated kernel,
it has no host folders, it cannot reach the host, other sandboxes or the LAN, and so on. A sandbox that fails a blocking
check does not run. `paddock verify demo` runs the checklist again at any time.

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
- The checklist, with live network probes that have controls, and a stop when a blocking check fails.
- A disk limit that the daemon watches (it stops a sandbox that passed its limit; it is not a hard cap).
- The daemon, the CLI with `--json`, a web dashboard, and extensions.

Not built yet:

- Docker Sandboxes (microVM) support. It is detected and reported as not supported.
- Port forwarding, SSH access for editors, Docker inside a sandbox, importing agent logins, templates.
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

`bun run build` makes a standalone `dist/paddock`. `bun test` runs the unit tests; `bun run test:live` creates a real
sandbox and expects every blocking check to hold.

## How it is put together

```
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
- **Defaults** (image, sizes, engine) go in `~/.config/paddock/config.json`.

[skill/SKILL.md](skill/SKILL.md) tells an AI agent how to do each of these.
