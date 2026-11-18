# T3 Code setup

Install it with `asd ext install t3` (or the dashboard's Install button), then run `asd ext run t3 setup NAME`;
`asd ext remove t3` takes it out again. The sandbox must already be running and have Node and tar. This machine needs
either `t3` on PATH or the desktop launcher at `~/.t3/bin/t3`. No host settings or credentials are read. The launcher
is run only with `--version`. It is independent of the other bundled extensions and adds no runtime dependency. From
the Asidee source, for development, `bun extensions/t3/t3.ts setup NAME` with Bun and `asd` on PATH does the same.

Setup installs the exact reported version, including a nightly suffix, from the matching GitHub release. The guest
downloads `SHA256SUMS` and `t3-VERSION-linux-arm64.tar.gz` or `linux-x64.tar.gz` over HTTPS. It requires exactly one
matching checksum and verifies SHA-256 before extraction or execution. It checks the executable's version before
publishing `~/.t3/runtime/versions/VERSION/t3` and `.install-complete` containing `VERSION` plus a newline. A matching
existing marker and executable are reused. The app's `.VERSION.install.lock` is respected. An interrupted installer
may leave that lock; check for an active install before removing it. Downloads have inactivity timeouts, redirect
limits, a 1 MiB checksum-file bound and a 256 MiB archive bound. Checksums authenticate integrity relative to the
HTTPS release, not an independent signature. The archive's upstream contents remain trusted.

Setup also refreshes `~/.t3/userdata/settings.json`. Run `asd ext run t3 sync NAME` after a later login import
or logout. The logins extension does not call this client automatically. Canonical and named Claude/Codex credential
files are discovered inside the guest without reading their contents. Symlinked credential files/directories are skipped.
The current managed primary is retained, otherwise `-default`, the canonical directory, then the first named profile
is selected. The built-in IDs are `claudeAgent` and `codex`; other IDs are `claude-PROFILE` and `codex-PROFILE`.
There is no last-imported ordering available from the login extension.

Only instances recorded with their driver and home in the private `~/.t3/userdata/asidee-providers.json` sidecar are
updated or removed. Other instances and top-level settings are
preserved, including user-configured built-ins. An unowned ID collision uses `asidee-AGENT-PROFILE`; a second collision
fails without replacing the settings file. Claude providers override `ANTHROPIC_API_KEY` with an empty value to select
the imported subscription login, and set `IS_SANDBOX=1`: T3 runs Claude with full access, which Claude Code refuses as
root otherwise ("--dangerously-skip-permissions cannot be used with root/sudo privileges"). Settings are written atomically with mode 0600 under the logins extension's
`~/.asidee-logins.lock`. Invalid settings are refused. Changes made concurrently by T3 itself are not serialized by
that lock. Before renaming, sync compares the current settings bytes with the original and aborts if they changed.
There is still a race between that check and rename; eliminating it requires coordination with T3's own settings writer.
No credentials or subprocess diagnostics are printed. The sidecar records both generations before settings
publication so retries recover ownership after an interrupted update. No extension metadata is added to T3 settings.

## T3's browser

T3's browser pane runs Chrome. `asd ext run t3 browser NAME` (the dashboard's "Install T3's browser", or
`asd create … --t3-browser`, which sets T3 up first) installs the exact build this T3 pins: the Chrome for Testing
headless shell whose version, size and SHA-256 are read from the T3 executable itself, downloaded over HTTPS, checked
against both, listed for unexpected paths and unpacked to `~/.t3/tools/chrome-headless-shell/PLATFORM/VERSION`, where
T3 looks for it. A copy already there is kept. It then runs T3's own `t3 browser setup`, which installs the browser's
libraries and fonts with apt, as root or with `sudo -n`; with neither it fails and says so. If a T3 version moves or
renames its pin, the action fails rather than guess, and T3 still installs the browser on first use. About 130 MB.

Chrome refuses its own sandbox as root. When the guest runs T3 as root, setup puts a marked block at the top of
`~/.bashrc` that exports `T3CODE_SERVER_BROWSER_SANDBOX=0`, which T3 reads when its server starts. The desktop app
starts the server with `ssh HOST sh -s`, Asidee's SSH server passes only `PATH`, and bash reads `~/.bashrc` for an SSH
command only up to its interactive-only guard, hence the top. It needs bash as root's login shell, and a server already
running keeps its old environment until it restarts. As a normal user Chrome keeps its sandbox, which works under
gVisor, and nothing is written. Without Chrome's sandbox, the pane should only open pages you trust.

## SSH access

The core owns it: `asd ssh setup NAME` prepares it, `--write-config` adds its `Include` line to `~/.ssh/config`,
and the checklist discloses it. Setup's result carries the core's `sshAccess`, and `asd ext run t3 ssh NAME`
(or the dashboard's "Show SSH access for T3") prints it alone: `{alias, user, home, batchReady, loopbackForwarding}`,
each field checked. Connect the desktop app to `alias` once `batchReady` is true. The alias logs in without a prompt
and without agent forwarding, as the same user and HOME as `exec`, and allows `ssh -L` to the sandbox's loopback for
`t3 serve`; its `GatewayPorts no` keeps the client side on loopback. This extension neither creates an alias nor
publishes a port.

## Needs from the core

A future login event such as `loginChanged({name, agent, profile, operation: "import"|"logout"})` would let clients refresh
providers and select the last imported profile automatically. Today use `sync` explicitly. This is client coordination,
not a sandbox guarantee.

Unit tests use fake transport, temporary homes and a loopback fake release server.

Checked live on 2026-11-11 in one arm64 sandbox on the default image, directly and through `asd ext run`: setup
installed this machine's version (`0.1.9-nightly.20261110.4478`) from its release in about 15 s, published
`~/.t3/runtime/versions/VERSION/t3`, which reports that version, and `.install-complete` containing the version and a
newline; a second setup reused it in under 2 s. `settings.json` and the sidecar were mode 0600. With placeholder
credential files in the guest, sync selected a named Claude profile and the canonical Codex directory, skipped a
symlinked credential file, set Claude's empty `ANTHROPIC_API_KEY`, removed the Codex instance after its file was
deleted, kept a user-added instance and top-level key, and refused invalid settings without changing them.
Not checked live: a checksum mismatch (unit tests only), provider authentication, the desktop app reusing the runtime,
and connecting the app over the alias. The alias itself was checked with ssh, scp, SFTP and `ssh -L` (the core's A
evals), and `t3.ts ssh` printed its access for a sandbox on the default image.

Checked live on 2026-11-18 on the `agent` template (Ubuntu 26.04, arm64): `asd create … --t3-browser` set T3 up and
installed Chrome 157.0.8103.38 plus its libraries and fonts in 69 s; Chrome rendered a page as the normal user with its
own sandbox. In a root sandbox, Chrome refused to start without `--no-sandbox`, and after the `~/.bashrc` block an
`ssh HOST sh -s` session saw `T3CODE_SERVER_BROWSER_SANDBOX=0`; `/etc/environment` did not reach it. Not checked live:
the desktop app opening the browser pane after a fresh server start.
