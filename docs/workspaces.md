# macOS workspaces

A workspace is **not a sandbox**. It runs programs as your user on this Mac's kernel, under an inherited Seatbelt
profile. There is no VM, container, or CPU, memory, disk, GPU or process limit. Network and loopback are open. Use a
sandbox when you need an isolated kernel, guarded networking or resource limits.

## Copy a project in and run it

```sh
paddock workspace create render --copy /absolute/project
paddock workspace shell render
paddock workspace exec render -- ffmpeg -version
paddock workspace exec render --stream -- cat output.mov > saved.mov
paddock workspace verify render
paddock workspace stop render
paddock workspace remove render --confirm render
```

Creation makes `~/Paddock/render/{home,tmp,work}`. The working directory is `work`. `--copy` copies the source's
contents there, including hidden files, with `cp -R -P -X`. Symlinks are preserved. Paddock opens the source for reading
only and makes no hard links to it. Writes through symlinks to outside paths are still refused by the profile.
Removing the workspace never walks or deletes the source. Copy out anything you want to keep before removing it.
Only commands launched through `paddock workspace shell` or `exec` acquire the profile. Entering the folder with an
ordinary shell, or opening its files through Finder, does not apply confinement.

`--read PATH` is repeatable and grants read access, never write access. Paths are canonicalised and passed as `-D`
parameters, never inserted as profile syntax. Home, SSH keys, workspace folders and their ancestors, Paddock state,
and shared temporary folders cannot be opened with `--read`. A symlink's resolved target is allowed; the original
home symlink can remain unreadable. `--path DIR` adds a canonical executable search directory. A directory under
home also needs an allowed `--read`. Create lists readable tool-directory suggestions from the creator's PATH.

`HOME`, temporary files, XDG directories and npm's global prefix point inside the workspace. The environment starts
empty except the fixed workspace values and `USER`, `LOGNAME`, `SHELL`, `TERM` and `LANG`. It does not inherit API
keys, proxy variables, `SSH_AUTH_SOCK`, `DYLD_*`, or arbitrary shell settings. System and Homebrew executables remain
readable. npm global, pip user and uv tool installs were measured with local fixture packages in K02. Installing into
Homebrew's outside Cellar or through the nix daemon is refused. SwiftPM remains unsupported by the current profile.

Buffered `exec` uses pipes, carries stdin with `--stdin`, preserves the command's exit status and limits each output
stream to 16 MiB. `--stream` uses the existing private stream socket. `shell` uses a PTY when the caller has a
terminal and carries terminal input and resize. PTY output waiting for a slow client is capped at 1 MiB; exceeding
that ends the session with an error. A closed session ends its identified starter. Detached descendants remain
tracked until `workspace stop` or `remove`. A daemon restart does not remove a workspace or its detached processes.

## Logins

Creation copies an existing file-backed Claude or Codex login into the workspace home, mode 0600, without hard
links. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` select the source profile when the daemon starts; otherwise the canonical
`~/.claude` and `~/.codex` are used. Agent settings, hooks and skills are not imported. Tokens never enter a manifest,
argument vector, diagnostic or log. Code inside can read and send these copied logins over the open network.

On macOS, Claude gives its Keychain login precedence over a credential file. Paddock queries attributes only. When
an entry exists, import stops before requesting its password because that request can prompt. A stale file is not
used in its place. **Claude Keychain import is not working in this version.** No login or logout is attempted.

K23 found the existing Claude Keychain entry by attributes only and stopped there. It copied the selected Codex file
with independent bytes and private permissions; `codex login status` recognised it inside. **Authenticated API calls
and token refresh remain unverified.** A recognised login is not reported as verified authentication. The original
credential files were read only, and the copies were deleted with the fixture workspace. Refreshing a copied token
could affect other clients of that login; this was not measured.

Paddock passes no flags to disable an agent's own sandbox. The K20 eval explicitly starts Codex's sandbox with an
unconfined control. Chrome, Codex and other nested sandboxes may need a user-chosen configuration to work here.
Claude's own command sandbox is not measured.

## What stop and remove do

The process finder asks macOS for all PIDs of this user. It accepts a PID only when the process is sandboxed, can
read and create files in this workspace folder, and cannot read its `.paddock-tag`. Both folder and tag must exist.
Environment variables, names and process groups are not identity evidence.

Stop rechecks that full criterion immediately before **each** signal. It sends SIGSTOP, then SIGKILL, and enumerates
again until no match remains. It refuses an incomplete process inventory. A missing folder or tag is recreated at
the original canonical location before finding processes. An unreadable folder's owner permissions are repaired
without following symlinks. A replaced path or tag is refused. K15 checks an empty folder, exact known PIDs and a
decoy before lifecycle evals run. K14 checks detached children, new sessions, process groups and a live fork loop,
beside a second workspace and an unconfined marker decoy that survive.

Remove requires `--confirm NAME`. After stopping, it unregisters `.app` bundles, checks LaunchServices and launchd
for references, and reports regular files with multiple hard links. It deletes the workspace and its manifest and
profile only after another empty finder result. It does not follow symlinks or chmod hard-linked regular files.
Multiple links can all be inside the workspace; Paddock cannot locate every external link. Outside hard links
supplied by another program can share changes that survive removal.

Removal cannot undo unified system logs, remote pushes or API calls, existing backups, or changes through outside
hard links. Spotlight retention and Keychain additions are not covered. Time Machine currently reports newly
created workspace folders excluded, measured by K24; existing backups and other backup tools remain outside coverage.

## Where the profile ends

- Internet, LAN, tailnet and **all loopback services** are reachable. Create and verify list current TCP listeners,
  including wildcard binds and their owning processes. Services started later are reachable too. There is no
  declared-ports mode. Remote effects can outlive removal.
- Reads outside home are open, including `/Applications`, `/nix`, `/opt/homebrew`, `/Users/Shared` and `/Volumes`.
  Other processes' command lines remain visible, measured using a known outside process in K19.
- The profile closes named channels. Unix sockets outside the workspace are denied except mDNSResponder for DNS;
  K10 tried Docker, nix and a controlled listener without sending daemon API requests. LaunchServices opening and
  registration, launchd jobs, preferences, clipboard and outside-process signals and descriptors have controlled
  K probes. `at` and crontab installation were not tested because the eval does not change the user's queues.
- **Apple events are not covered.** A deny rule or kernel decision alone does not establish a blocked side effect.
  Screen capture, accessibility, other TCC services, camera, microphone, Keychain additions, other IOKit devices,
  Bluetooth, and unnamed daemon channels remain not covered. No permission-prompt probe was attempted.
- K06 measured Metal computation and hardware-only HEVC VideoToolbox encoding on this Mac. Torch/MPS, Chrome's
  renderer, CoreML and GPU performance were not rerun by these evals. Verify reports GPU support as unknown.
- `sandbox-exec`, Seatbelt policy and `sandbox_check` are deprecated or private interfaces. Their continued behavior
  is a measurement on the scorecard's macOS version, not a promise about future macOS versions. Re-run K after updates.

## Implementation and verification

Workspaces have a separate spec, manifest directory and fixed checklist; they are not providers. All eight
`workspace*` API methods are socket-only and local. The dashboard displays a separate **Workspaces: not sandboxes**
section through the read-only summary. Its actions stay in the CLI. Non-macOS commands refuse before starting a daemon.

The finder calls `proc_listallpids` and `proc_pidinfo` directly through `bun:ffi`. A direct fixed-arity binding to
variadic `sandbox_check` gave wrong decisions on Apple Silicon. A six-line C wrapper supplies the correct Darwin
variadic ABI, compiled by Bun's built-in TinyCC into memory. No external compiler or helper binary is needed at
runtime. TinyCC cannot read Bun's embedded virtual files, so the static wrapper source is materialised in
`/private/tmp/paddock-ffi-*` and deleted immediately in a `finally` block. This works in source and compiled builds.

Tests override `PADDOCK_WORKSPACES_ROOT` with a disposable directory under this checkout's ignored `dist/`. The
override is canonicalised and must still be strictly inside the OS account's real home, separate from state and SSH
keys. No test creates `~/Paddock` or a loose file in the home root. K's private daemon state lives in
`/private/tmp/pdk-k-*`, outside Nix's automatically removed `TMPDIR`. `PADDOCK_WORKSPACE_ONLY=1` disables engine
providers for that daemon. K-only runs do not discover engines, run sandbox teardown, invoke SSH or contact other
registered machines. K01 briefly creates uniquely named control files under this user's temp folder, `/Users/Shared`
and `/opt/homebrew/Cellar`, then deletes them. All other workspace fixtures are in `dist/` or private temporary state.

```sh
nix develop -c bun test
nix develop -c bun run typecheck
nix develop -c bun evals/run.ts --only K --write
```

K15 runs first even when selecting individual K IDs. Partial K scorecards go only to
[`evals/SCORECARD.workspace.md`](../evals/SCORECARD.workspace.md); neither full sandbox scorecard is rewritten.
The K runner removes its workspaces, app registrations, job, private daemon and temporary folders. The unit tests
also verify PTY input/resize, mode-000 and missing-folder recovery, credential redaction, and unchanged copy sources.
