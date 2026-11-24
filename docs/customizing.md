# How Asidee is put together and customized

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
[docs/architecture.md](architecture.md) explains the boundary and where the guarantee ends.

## Customizing

- **Extensions** add actions and hooks. An extension is a folder in `~/.config/asidee/extensions/` with an
  `extension.json`; see [extensions/examples/agent-tools](../extensions/examples/agent-tools). Six extensions ship
  inside `asd`: [logins](../extensions/logins), [folders](../extensions/folders), [repo](../extensions/repo),
  [env-docs](../extensions/env-docs), [t3](../extensions/t3) and [rotator](../extensions/rotator). `asd ext list` shows the ones not yet installed;
  `asd ext install NAME` (or the dashboard's Install button) installs one and `asd ext remove NAME` removes it. They
  need neither Bun nor the Asidee source.
- **The dashboard** is replaced by putting your own `index.html` in `~/.config/asidee/ui/`. It is also served at the
  dashboard's places (`/sandboxes/NAME`, `/extensions/ID`, …), so a copy of the built-in page survives a reload.
- **Defaults** (image, sizes, Docker, engine) go in `~/.config/asidee/config.json`.

[skill/SKILL.md](../skill/SKILL.md) tells an AI agent how to do each of these.

## Import agent and GitHub logins

The bundled [logins extension](../extensions/logins) imports one selected Claude or Codex profile, optionally its setup,
and a GitHub token from stdin, a hidden prompt, or this machine's `gh` login. It also lists and removes guest logins.
Install it with `asd ext install logins`, then use the dashboard or `asd ext run logins ACTION SANDBOX`. From the
Asidee source, `bun extensions/logins/login.ts --help` with Bun and `asd` on PATH shows the direct commands, including
a pasted GitHub token. It needs Node in an already running sandbox; GitHub also needs guest `gh` and `git`.
An import overwrites an existing login of the same profile. **A login token imported into a sandbox can be read by
anything running in that sandbox, which can also send it out. There is no host-side token proxy yet.** The sandbox and
this machine then hold the same refresh token; when one side refreshes it, the other can be logged out (seen once); importing again fixes it.
Logout leaves this machine logged in.
Imports of file-backed Claude and Codex profiles and of this machine's `gh` login were checked live in one sandbox. On
2026-11-18 a Keychain Claude login with its setup (1050 files, 19 MB) was imported and Claude Code inside answered a
prompt with it; Codex accepting an import was not checked. The shared Keychain reader and
Claude's login recognition are now measured separately for workspaces. Its README lists the sandbox measurements.

## How it is measured

`bun evals/run.ts` runs the eval set: the claims this README and the checklist make, each tried from outside
Asidee with plain engine commands (a connection from inside a sandbox, a fork bomb, a rule slipped into the firewall,
a container swapped for a privileged one, the dashboard in a real browser). A blocked attempt counts only beside a
control that shows the same attempt connects when nothing blocks it. [evals/SCORECARD.md](../evals/SCORECARD.md) is the
last run, including the claims nobody has measured yet. [evals/README.md](../evals/README.md) says how to run it on
your own engine, which is the way to find out what holds there.
