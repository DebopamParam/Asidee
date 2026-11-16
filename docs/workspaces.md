# macOS workspaces

A workspace is **not a sandbox**. It runs programs as your user on this Mac's kernel, under an inherited Seatbelt
profile. There is no VM, container, or CPU, memory, GPU or process limit; disk use is watched, not capped (see
[Disk use and free space](#disk-use-and-free-space)). Network and loopback are open. Use a sandbox when you need an
isolated kernel, guarded networking or resource limits.

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
contents there, including hidden files, with `cp -R -P -X`, then sets each copy's modification and access times and
permission bits from the source (not setuid, setgid or sticky bits). Symlinks are copied as links, never followed.
Ownership, ACLs, file flags and the source's extended attributes are not carried; a file hard-linked in the source
becomes separate copies. macOS itself marks the copy: measured on macOS 26.7.1, every file this process tree writes
gets `com.apple.provenance`, which cannot be removed, and a copy of a quarantined file gets a fresh
`com.apple.quarantine` of its own. Paddock leaves that quarantine in place, so Gatekeeper still checks it.
`test/unit/workspaces.test.ts` covers a 0755 file and a 0555 folder with old times, a 0664 file, a symlink, an ACL
and two extended attributes. Paddock opens the source for reading only and makes no hard links to it. Writes through symlinks to outside paths are still refused by the profile.
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
status and limits each output stream to 16 MiB. It waits for the command however long it runs (K29: 400 seconds). Its output is returned as text: invalid UTF-8 is replaced. `--stream`
uses the existing private stream socket and is the byte-exact path for output. `shell` uses a PTY when the caller has a
terminal and carries terminal input and resize. PTY output waiting for a slow client is capped at 1 MiB; exceeding
that ends the session with an error. A closed session ends its identified starter. Detached descendants remain
tracked until `workspace stop` or `remove`. A daemon restart does not remove a workspace or its detached processes. A disconnected buffered exec client also
closes its session and ends its command's starter. Detached descendants still require `workspace stop` or `remove`.
Exec and shell run only blocking checks before launch, then `du` for the disk warning. They do not run GPU/login
probes, `lsof`, `tmutil`, or the hard-link walk. Full informational checks run at creation and explicit verify. Verify only reads directories
while looking for hard links; an unreadable subtree is unknown. Permission repair belongs to remove.

## Disk use and free space

`workspace create NAME --disk GB` sets a workspace's disk limit: from 1 to 2000, default 20, as for a sandbox.
`workspace set NAME disk GB` changes it at any time, also while its processes run. GB here is 1024³ bytes.

The limit is **watched, not capped**. While the daemon runs, every 30 seconds it measures each workspace that has
running processes with `/usr/bin/du -sk` on its folder, so `home`, private `tmp` and `work` all count; shared host
temp `T` does not. Over its limit, the daemon stops the workspace's processes as `workspace stop` does and records a
reason that `workspace get` and `workspace list` show. The reason gives the space used and the limit, and two ways
out: free space in the folder, or `paddock workspace set NAME disk N`. A workspace can overshoot by whatever it
writes in those 30 seconds. Nothing watches it while no daemon runs, and stopping the daemon does not stop
workspaces. A workspace with no processes is not measured.

A launch over the limit still runs, so space can be freed from inside, with a warning: buffered `exec` returns
`diskWarning` (`usedBytes`, `limitBytes`, `message`) in JSON and prints the message on stderr in text; `shell` and
`exec --stream` print it on stderr when the session starts. The daemon stops the processes again on its next pass
unless space was freed. A launch clears the recorded reason. A `du` that fails part way gives a lower bound: over
the limit is enough to stop; otherwise the pass could not check. That shows as a warning in get and list, and after
four such passes in a row the processes are stopped with that reason, as for a sandbox. One measurement of a
workspace runs at a time; list, get, a launch, verify and the pass share it.

Cost: on this Mac (Apple M5, macOS 26.7.1), `/usr/bin/du -sk` took 0.06 to 0.12 seconds on a folder of 100,000 small
files with a warm cache. A cold cache was not measured.

Below a machine-wide free-space floor, workspace launches are refused (exit 6) with a sentence giving the free space,
the floor and the command to change it, and the pass stops running workspaces with the same sentence as their
reason. `paddock config set workspace-free-space GB` sets the floor: default 5, from 0 (off) to 100000. Free space is
`statfs`'s available space on the volume that holds the workspace folder. macOS purgeable space is not counted, so
Finder can show more free space than Paddock does.

The checklist has both: `free-space` blocks a launch, create and verify when it fails or cannot be read; `disk`
does not block and reads `weak` while under the limit, `fail` over it, or `unknown`, and states the 30-second
interval. K31 writes 1100 MiB past a 1 GB limit and sees the stop, its reason, the warning on relaunch, cleanup from
inside, and no warning afterwards. K32 sets the floor above this Mac's free space, sees the refusal and the stop,
and restores the setting.

## Allow the shared per-user temp folder

`hostTemp` defaults to `false`, including manifests written before this setting existed. To allow Apple frameworks
that use `DARWIN_USER_TEMP_DIR` instead of `$TMPDIR`, create with `--host-temp` or change an idle workspace:

```sh
paddock workspace create render --host-temp --no-logins
paddock workspace stop render
paddock workspace set render host-temp on
paddock workspace set render host-temp off
```

Changing the setting refuses while any workspace processes run. Stop them first. The new profile applies to later
shells and execs, and saved verification is cleared. If a partial update leaves the profile and manifest mismatched,
execution refuses the integrity check. A Paddock update that changes the generated profile has the same effect on
existing workspaces. The refusal names the command that recovers: setting the current value again (`paddock workspace
set NAME host-temp on` on a workspace that has it on) rewrites the profile from the saved settings.

With the setting on, the profile adds two rules: file reads and writes only in this user's canonical per-user `T`
folder, and file metadata (`stat`) of the per-user folder that contains `T` itself, not its listing or any child. Tools
that create folders under `T` check each ancestor first; with that `stat` refused, ONNX Runtime tried to create the
folder and failed with EEXIST (error 17). The second rule exposes that folder's own attributes (mode, owner, link count,
times) and its extended attribute names. It adds no network rule, so connecting to a Unix socket there stays refused by the profile's general Unix
socket denial. The sibling `C` and `0` folders, `/private/tmp`, `/private/var/tmp`, and home remain denied. `$TMPDIR`
still points at the workspace's own `tmp`. The `--read` refusal for shared temporary folders still applies. With the
setting off, generated profile bytes and parameters are unchanged from the original profile.

This weakens confinement. Other programs' temp files there are readable and writable by this workspace. Socket files
are directory entries: the workspace can delete another program's socket file in `T`, and can create its own
listening socket there, which an outside program can connect to. Other workspaces with the setting on share that
folder. Files left there are not removed by `workspace remove` and are not counted in workspace size. List, get,
shell, exec, verification, removal and dashboard rows disclose the exception. Create and verify report `writes`,
`home-closed` and `daemons` as `weak` when their checks succeed with this exception. Verify actually reads a host
fixture and creates and reads back a file in `T`, with matching denial probes when off. It also checks the
still-denied locations. With the setting on or off, the `daemons` check starts a real listener in `T`: an unconfined
control must receive its reply and a confined connect must be refused. A mismatch fails the check; a failed control
makes it unknown.

`test/unit/workspaces.test.ts` includes live Seatbelt tests on macOS for both settings: refused confined connections
to a listener in `T` beside a working unconfined control, deletion of another listener's socket file and a confined
listener in `T` reached from outside with the setting on (both refused with it off), actual denied writes in `C`, `0`,
home and the two global temp folders, running-process refusal and retained host-temp files after removal. A small C
program built with the installed Apple clang calls `confstr(_CS_DARWIN_USER_TEMP_DIR)` and creates, writes and reads a
temporary file there, then deletes it. It fails with the setting off and succeeds with it on while `$TMPDIR` stays
private. Another live test runs `stat` inside: with the setting on, the folder containing `T` answers while listing it
and `stat` of its `C` and `0` are refused; with it off, that `stat` is refused; and a saved profile from before the
rule is refused at launch with the recovery command, after which `set … host-temp on` makes it work. These tests
measure the OS temp-path symptom and the metadata rule; they do not run PyTorch/MPS or CoreML, and no packages were
installed. Unit tests cover boolean validation, legacy defaults, original profile hash, CLI parsing and JSON,
and dashboard DOM output. Dashboard appearance was not evaluated.

CoreML was measured once outside the test suite, by hand on 2026-11-16 (Apple M5, macOS 26.7.1, ONNX Runtime 1.31.1,
Python 3.12), using profiles generated by Paddock's code with the setting on and run with the same environment and
parameters as `exec`. ONNX Runtime's CoreML provider with an ML Program model failed with error 17 and fell back to
the CPU without the metadata rule (three of three runs), and ran with it: 136 node executions on the CoreML provider,
and a hand-built convolution model on `CPUAndGPU` took 0.05 s against 0.25 s on `CPUOnly`, with fp16-rounded
output, so the GPU executed it. The Neural Engine did not execute, unconfined either. That profile still allowed
connecting to Unix sockets in `T`, which the current one refuses; the run was not repeated with the current profile.
PyTorch/MPS warning counts were not rerun.

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
  sockets in shared `T` stay denied when host-temp is on. K10 tried Docker, nix and a controlled listener without
  sending daemon API requests. LaunchServices opening and
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

Workspaces have a separate spec, manifest directory and fixed checklist; they are not providers. All nine
`workspace*` API methods are socket-only and local. The dashboard displays a separate **Workspaces: not sandboxes**
section through the read-only summary. Its actions stay in the CLI. Non-macOS commands refuse before starting a daemon.
Summary reads manifests and counts tagged processes, without repairing identity, changing modes or walking the tree.
An unavailable folder/tag stays unknown. Of the status lines, only list and get measure size with `du`; the lines
create, verify, set and stop print leave size out, and `size unknown` means a measurement was tried and failed. The
30-second sandbox enforcement pass does no workspace work; workspaces have a pass of their own (see
[Disk use and free space](#disk-use-and-free-space)). Full check results retain their verification timestamp.

Policy decision controls run inside confined processes. Read and write decisions have same-operation allowed
controls on the workspace folder. Global denials use a second confined profile with the needed allows, running
only a trusted `sleep`; unsupported operation names cannot establish a pass. Every blocking check also tries real
Unix listeners in a private fixture folder and in shared `T`: each unconfined control must answer and each confined
connect must fail.
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
