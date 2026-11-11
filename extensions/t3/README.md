# T3 Code setup

Run `bun extensions/t3/t3.ts setup NAME` with `paddock` on PATH. The sandbox must already be running and have Node and
tar. This machine needs Bun and either `t3` on PATH or the desktop launcher at `~/.t3/bin/t3`. No host settings or
credentials are read. The launcher is run only with `--version`.

Copy this entire folder to `$PADDOCK_CONFIG_DIR/extensions/t3` (normally `~/.config/paddock/extensions/t3`), preserving
the executable bit on `t3.ts`, to expose the setup and sync actions in the dashboard and `paddock ext run t3 setup NAME`.
It is independent of the other bundled extensions and adds no runtime dependency.

Setup installs the exact reported version, including a nightly suffix, from the matching GitHub release. The guest
downloads `SHA256SUMS` and `t3-VERSION-linux-arm64.tar.gz` or `linux-x64.tar.gz` over HTTPS. It requires exactly one
matching checksum and verifies SHA-256 before extraction or execution. It checks the executable's version before
publishing `~/.t3/runtime/versions/VERSION/t3` and `.install-complete` containing `VERSION` plus a newline. A matching
existing marker and executable are reused. The app's `.VERSION.install.lock` is respected. An interrupted installer
may leave that lock; check for an active install before removing it. Downloads have inactivity timeouts, redirect
limits, a 1 MiB checksum-file bound and a 256 MiB archive bound. Checksums authenticate integrity relative to the
HTTPS release, not an independent signature. The archive's upstream contents remain trusted.

Setup also refreshes `~/.t3/userdata/settings.json`. Run `bun extensions/t3/t3.ts sync NAME` after a later login import
or logout. The logins extension does not call this client automatically. Canonical and named Claude/Codex credential
files are discovered inside the guest without reading their contents. Symlinked credential files/directories are skipped.
The current managed primary is retained, otherwise `-default`, the canonical directory, then the first named profile
is selected. The built-in IDs are `claudeAgent` and `codex`; other IDs are `claude-PROFILE` and `codex-PROFILE`.
There is no last-imported ordering available from the login extension.

Only instances recorded with their driver and home in the private `~/.t3/userdata/paddock-providers.json` sidecar are
updated or removed. Other instances and top-level settings are
preserved, including user-configured built-ins. An unowned ID collision uses `paddock-AGENT-PROFILE`; a second collision
fails without replacing the settings file. Claude providers override `ANTHROPIC_API_KEY` with an empty value to select
the imported subscription login. Settings are written atomically with mode 0600 under the logins extension's
`~/.paddock-logins.lock`. Invalid settings are refused. Changes made concurrently by T3 itself are not serialized by
that lock. No credentials or subprocess diagnostics are printed. The sidecar records both generations before settings
publication so retries recover ownership after an interrupted update. No extension metadata is added to T3 settings.

## Needs from the core

Setup can prepare files today. Connecting the desktop app still needs a core-owned SSH API, for example
`sshAccess({name}) -> {alias: string, user: string, home: string, batchReady: boolean, loopbackForwarding: boolean}`.
The alias must connect noninteractively without agent forwarding, use the same guest user/HOME as `exec`, and allow
SSH local forwarding to guest loopback for `t3 serve`. Forwarding must bind the client side to loopback. The core
must own the access lifecycle and its checklist evidence. This extension neither creates an alias nor publishes a port.

A future login event such as `loginChanged({name, agent, profile, operation: "import"|"logout"})` would let clients refresh
providers and select the last imported profile automatically. Today use `sync` explicitly. This is client coordination,
not a sandbox guarantee.

Unit tests use fake transport, temporary homes and a loopback fake release server.

Checked live on 2026-11-11 in one arm64 sandbox on the default image, directly and through `paddock ext run`: setup
installed this machine's version (`0.1.9-nightly.20261110.4478`) from its release in about 15 s, published
`~/.t3/runtime/versions/VERSION/t3`, which reports that version, and `.install-complete` containing the version and a
newline; a second setup reused it in under 2 s. `settings.json` and the sidecar were mode 0600. With placeholder
credential files in the guest, sync selected a named Claude profile and the canonical Codex directory, skipped a
symlinked credential file, set Claude's empty `ANTHROPIC_API_KEY`, removed the Codex instance after its file was
deleted, kept a user-added instance and top-level key, and refused invalid settings without changing them.
Not checked live: a checksum mismatch (unit tests only), provider authentication, the desktop app reusing the runtime,
and connecting the app: the core has no SSH access yet.
