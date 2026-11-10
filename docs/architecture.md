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
- **The API cannot express an unsafe sandbox.** A spec is a name, an image and four sizes (`validSpec` in
  `core/state.ts`); unknown fields are dropped. There is no field for a mount, a capability, a runtime or a port.

## The checklist

`core/checks.ts` lists the checks. Providers supply the evidence for each one; a check a provider does not report comes
out as "could not be checked", never as a pass.

| Check | Blocking | When | How the gVisor provider checks it |
|---|---|---|---|
| Isolated kernel | yes | after start | The runtime is gVisor, and the kernel inside identifies as gVisor. |
| No privileged mode, host namespaces, capabilities, devices | yes | before start | Engine configuration. |
| No host folders | yes | before start | Engine configuration. |
| Own network, guard loaded | yes | before start | Engine configuration and the loaded firewall rules. |
| No open ports | yes | before start | Engine configuration. |
| Memory, process, CPU limits | yes | before start | Engine configuration. |
| Disk limit | no | before start | The engine's capability: hard, watched or none. |
| Cannot reach the host | yes | verify | Live probe with controls. |
| Cannot reach other sandboxes | yes | verify | Live probe with controls. |
| Cannot reach LAN, tailnet, metadata, IPv6 | yes | verify | The loaded rules, plus one live attempt at the metadata address. |
| Internet access | no | verify | Live attempt; a disclosure. |
| Logins inside | no | verify | Looks for the usual credential files; a disclosure. |

"Verify" runs after every create and on `paddock verify`. A start runs the first seven.

### How the network probes work

A helper container joins the sandbox's own network with the sandbox's runtime and tries to connect to a listener on the
engine's host and to a listener on another guarded network. A blocked attempt counts only if its controls answered:
the host reached the helper, and the host reached each listener. Without that, the result is "could not be checked".

The helper runs from an image built from `core/providers/helper.Dockerfile` (Alpine pinned by digest), never from the
sandbox's image, so a tampered image cannot fake a result or run as root on the engine's host.

## Where the guarantee ends

- **Something with your rights on this machine can change Paddock itself.** An agent running outside a sandbox, or an
  extension's command, runs as you. It could edit the core or call the engine directly. The checks catch a
  customization or an engine update that weakened a sandbox; they do not defend against code that already runs as you.
- **Extensions run commands on this machine.** Install one the way you would install any script.
- **Egress is open.** A sandbox can reach the internet, so anything inside it, including logins you copy in, can be
  sent out. The checklist discloses both.
- **The disk limit is watched, not capped,** on engines without a hard cap. A sandbox can overshoot before it is
  stopped, and nothing watches while the daemon is not running.
- **The LAN block is inspected, not probed.** There is no listener on your LAN to test against.
- **gVisor's process limit is inspected only.** No fork-bomb test was run.

## The daemon

One daemon per user owns all state and serializes operations per sandbox, so two clients cannot race. It listens on:

- a Unix socket in the state folder (mode 0600), used by the CLI;
- `127.0.0.1` on port 7717 (or a free port), used by the dashboard. Requests need the token from `paddock ui` and a
  `Host` header naming this server. `attach` and `shutdown` are not available here.

State is in `~/.local/state/paddock`, configuration in `~/.config/paddock` (`PADDOCK_STATE_DIR`, `PADDOCK_CONFIG_DIR`).

## Adding a provider

Implement `Provider` in `core/types.ts` and add it to the list in `core/daemon.ts`. `detect()` reports each engine with
its `capabilities`, and `checks()` must give honest evidence for every checklist item of the stage it is asked for.
`core/providers/docker-sandboxes.ts` is the stub to fill in next.
