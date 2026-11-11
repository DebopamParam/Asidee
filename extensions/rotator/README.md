# T3 account rotator

Run with Bun and `paddock` on PATH against an already running sandbox. The guest needs Node, `ps`, Python 3, an installed
T3 CLI and T3's `~/.t3/userdata/settings.json` and database. Start T3 in the guest once before starting the rotator.
Each selected provider needs at least two enabled, authenticated accounts for a switch to be possible.

```sh
bun extensions/rotator/rotator.ts NAME                 # state and last 20 sanitized log lines
bun extensions/rotator/rotator.ts NAME claude
bun extensions/rotator/rotator.ts NAME codex
bun extensions/rotator/rotator.ts NAME claude,codex
bun extensions/rotator/rotator.ts NAME off
```

Copy the whole folder to `$PADDOCK_CONFIG_DIR/extensions/rotator` (normally `~/.config/paddock/extensions/rotator`),
preserving `rotator.ts`'s executable bit. Then use the dashboard or
`paddock ext run rotator mode NAME --set mode=claude,codex`. The default action only reads status.

Each start transfers the bundled `t3-account-rotator.py` unchanged on `paddock exec` stdin to
`~/.t3/account-rotator/rotate.py`. It replaces the old watcher and starts Python detached with closed stdin and private
log output. It uses the guest's `.t3` base directory. The controller checks PID command identity before signalling and
holds `~/.t3/account-rotator/.lock` during changes. An interrupted controller can leave the lock. Check for another
controller before removing the empty directory. Status without an existing install writes nothing. A stale PID reports
off and is never signalled. The controller's startup check confirms a process, not a successful database scan.

The Python script is a byte-for-byte copy of the read-only sandbox-manager reference. It reads T3's SQLite schema,
detects failed usage-limit runs, and asks T3 helpers to switch accounts within the same provider while retaining the
model and options. Its own documentation in the script explains timing and reset handling. It stops with the sandbox;
there is no automatic restart after the sandbox starts again.

The upstream script's private guest log may contain thread titles and exception details. The client exports only the
last 20 lines' timestamps and fixed event categories, withholding all free-form fields so log display cannot expose
credentials in titles or exceptions. Subprocess errors are also withheld. Inspecting the raw guest log is a separate
manual action and can disclose private thread data.

## Needs from the core

None for start/status/off beyond existing text `exec({name, argv, stdin?})`. Core-owned SSH access and T3 setup are
prerequisites to using this with the desktop app; see the T3 extension. Core need not own the Python process.

Unit coverage uses temporary homes and a fake Python watcher through fake exec.

Checked live on 2026-11-11 in one sandbox on the default image, after the T3 extension's setup and one `t3 serve` to
create the database: status before any start reported off and wrote nothing. Starting `claude` ran one
`rotate.py --watch --providers claude` process from a byte-identical copy and logged `watching`; switching to
`claude,codex` through `paddock ext run` replaced it with one process; `off` left no process and removed its PID file.
After a start, stopping and starting the sandbox left no process and status reported off for the stale PID.
Not checked live: authentication checks, account switching and model preservation, which need two real authenticated
accounts and a usage-limit failure. The unchanged upstream script can drift from future T3 releases.
