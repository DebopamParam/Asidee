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

Buffered `exec` uses pipes, carries stdin with `--stdin` byte for byte (up to 16 MiB), preserves the command's exit
status and limits each output stream to 16 MiB. Its output is returned as text: invalid UTF-8 is replaced. `--stream`
uses the existing private stream socket and is the byte-exact path for output. `shell` uses a PTY when the caller has a
terminal and carries terminal input and resize. PTY output waiting for a slow client is capped at 1 MiB; exceeding
that ends the session with an error. A closed session ends its identified starter. Detached descendants remain
tracked until `workspace stop` or `remove`. A daemon restart does not remove a workspace or its detached processes.
Exec and shell run only blocking checks before launch. They do not run GPU/login probes, `lsof`, `tmutil`, `du`, or
the hard-link walk. Full informational checks run at creation and explicit verify. Verify only reads directories
while looking for hard links; an unreadable subtree is unknown. Permission repair belongs to remove.

## Logins

Creation imports the `default` Claude and Codex profiles unless explicitly selected otherwise. `--claude-profile work`
reads `~/.claude-work`; `--codex-profile work` reads `~/.codex-work`. `--no-logins` skips all credential and account-state
reads and imports. These choices are in the spec; the daemon's inherited `CLAUDE_CONFIG_DIR` and `CODEX_HOME` never
select sources. Inside, both variables point to the workspace's own agent directories.

The sandbox login extension and workspaces share `core/credentials.ts`. Claude's Keychain item takes precedence over
its file fallback. The reader uses `security find-generic-password -s SERVICE -w`, with a 15-second timeout for
workspace imports. macOS may ask for access. A denied or timed-out read is reported as not imported, with no stale
file substitution. Imported credentials are mode 0600 with no hard links. Claude's allowlisted onboarding/account
state goes in its private `.claude.json`, with the same API-key clearing used for sandbox imports. Agent hooks,
skills and other setup are not imported. Tokens never enter manifests, argv, logs or diagnostics.

K23 used the product CLI to create a workspace from the owner's default Claude profile, read the Keychain item and
run `claude auth status` inside. It reported `loggedIn: true`. **Authenticated API calls and token refresh remain
unverified.** No login or logout was attempted. Unit fixtures cover named file profiles and independent private
copies. Code inside can read and send the imported logins over the open network. Refreshing a copy could affect
other clients of that login; that behavior was not measured.

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
One K16 run still showed a registration after pre-deletion unregistration. Remove now checks after deletion and
retries its bundles for a bounded settling period. The database is filtered before collecting output because its
full dump exceeds 16 MiB on this Mac. A leftover or unreadable database is reported.
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
  Bluetooth, and unnamed daemon channels remain not covered. No TCC permission probe was attempted. The separately
  authorized Keychain import can prompt.
- K06 measured Metal computation and hardware-only HEVC VideoToolbox encoding on this Mac. Torch/MPS, Chrome's
  renderer, CoreML and GPU performance were not rerun by these evals. Create and verify also run a cheap hardware-only
  HEVC VideoToolbox encode when ffmpeg is on the workspace PATH. A nonempty movie and exit zero pass that check; an
  encode failure fails it. No available executable or a probe that cannot run is unknown with a reason. This check
  does not claim Metal compute coverage, and does not run before exec or shell.
- `sandbox-exec`, Seatbelt policy and `sandbox_check` are deprecated or private interfaces. Their continued behavior
  is a measurement on the scorecard's macOS version, not a promise about future macOS versions. Re-run K after updates.

## Implementation and verification

Workspaces have a separate spec, manifest directory and fixed checklist; they are not providers. All eight
`workspace*` API methods are socket-only and local. The dashboard displays a separate **Workspaces: not sandboxes**
section through the read-only summary. Its actions stay in the CLI. Non-macOS commands refuse before starting a daemon.
Summary reads manifests and counts tagged processes, without repairing identity, changing modes or walking the tree.
An unavailable folder/tag stays unknown. Only explicit CLI list/get measure size with `du`. The 30-second sandbox
enforcement pass does no workspace inventory work. Full check results retain their verification timestamp.

Policy decision controls run inside confined processes. Read and write decisions have same-operation allowed
controls on the workspace folder. Global denials use a second confined profile with the needed allows, running
only a trusted `sleep`; unsupported operation names cannot establish a pass. Every blocking check also tries a real
Unix listener in a private fixture folder: its unconfined control must answer and the confined connect must fail.
Every launch inserts `--` after sandbox-exec's profile parameters. K27 demonstrates that the old unseparated
`-D WS=/` form opened a controlled outside write, and that the product separator prevents it.

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
