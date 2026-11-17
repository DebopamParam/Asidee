# T3 account rotator

Run against an already running sandbox. The guest needs Node, `ps`, Python 3, an installed
T3 CLI and T3's `~/.t3/userdata/settings.json` and database. Start T3 in the guest once before starting the rotator.
Each selected provider needs at least two enabled, authenticated accounts for a switch to be possible.

Install it with `asd ext install rotator` (or the dashboard's Install button); `asd ext remove rotator` takes it out
again. The default mode, `status`, only reads.

```sh
asd ext run rotator mode NAME                          # state and last 20 sanitized log lines
asd ext run rotator mode NAME --set mode=claude
asd ext run rotator mode NAME --set mode=codex
asd ext run rotator mode NAME --set mode=claude,codex
asd ext run rotator mode NAME --set mode=off

# From the Asidee source, for development, with Bun and asd on PATH.
bun extensions/rotator/rotator.ts NAME claude,codex
```

Each start transfers the bundled `t3-account-rotator.py` on `asd exec` stdin to
`~/.t3/account-rotator/rotate.py`. It replaces the old watcher and starts Python detached with closed stdin and private
log output. It uses the guest's `.t3` base directory. The controller checks PID command identity before signalling and
holds `~/.t3/account-rotator/.lock` during changes. An interrupted controller can leave the lock. Check for another
controller before removing the empty directory. Status without an existing install writes nothing. A stale PID reports
off and is never signalled. The controller's startup check confirms a process, not a successful database scan.
If `ps` cannot run, status and stop fail without deleting the PID file; an unreadable identity is not reported as off.

The Python script is based on the read-only sandbox-manager reference. This copy omits private log fields and thread
titles in subprocess arguments, and refuses to resume a disabled provider instance. It reads T3's SQLite schema,
detects failed usage-limit runs, and asks T3 helpers to switch accounts within the same provider while retaining the
model and options. Its own documentation in the script explains timing and reset handling. It stops with the sandbox;
there is no automatic restart after the sandbox starts again.

The bundled script writes only timestamps and fixed event categories, including for errors. Helper titles are always
`Account rotation`; source thread titles never enter argv. Starting the watcher replaces the old log, removing private
fields left by older versions. Status also sanitizes older or guest-modified logs before returning their last 20 lines.
Subprocess errors are withheld. Logs are private files, but code in the guest can modify them.

## Needs from the core

None for start/status/off beyond existing text `exec({name, argv, stdin?})`. Core-owned SSH access and T3 setup are
prerequisites to using this with the desktop app; see the T3 extension. Core need not own the Python process.

Unit coverage uses temporary homes, a fake Python watcher through fake exec, and the real Python scanner against a
fixture SQLite database and fake external agent/T3 CLIs. It checks idle top-level selection, model options, disabled
accounts and withholding private text.

The original reference copy was checked live on 2026-11-11 in one sandbox on the default image, after the T3 extension's setup and one `t3 serve` to
create the database: status before any start reported off and wrote nothing. Starting `claude` ran one
`rotate.py --watch --providers claude` process from a byte-identical copy and logged `watching`; switching to
`claude,codex` through `asd ext run` replaced it with one process; `off` left no process and removed its PID file.
After a start, stopping and starting the sandbox left no process and status reported off for the stale PID.
Not checked live: authentication checks, account switching and model preservation, which need two real authenticated
accounts and a usage-limit failure. The later logging, helper-title and disabled-account changes have unit coverage
only. The script can drift from future T3 releases.
