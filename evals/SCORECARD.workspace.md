# Workspace scorecard

Only K15, K01, K02, K03, K04, K05, K06, K07, K08, K09, K10, K11, K12, K13, K14, K16, K17, K18, K19, K20, K21, K22, K23, K24, K25, K26, K27, K28, on macOS 26.7.1, arm64, 2026-11-12T09:20:54.619Z, revision bfdb72b.
The sandbox scorecards are unchanged.

27 pass, 0 fail, 1 not measured.

| Id | Result | Claim | Evidence or limit |
|---|---|---|---|
| K15 | pass | The finder lists zero for an empty workspace and exactly known pids, excluding decoys | List-only controls ran before lifecycle signals. Both tag conditions and per-pid rechecks use bun:ffi with an in-memory C varargs wrapper. |
| K01 | pass | Workspace writes are refused at controlled home, tmp, user-temp, Shared and Cellar targets | All five unconfined writes succeeded; every confined write was refused. All control files removed. |
| K02 | pass | npm global, pip user and uv tool installs land in the workspace | Only local fixture packages installed; no package registry contacted. |
| K03 | pass | Home reads stay closed under symlink, parent, case and firmlink spellings; declared reads work |  |
| K04 | pass | Shared temporary folders are unreadable beside unconfined controls |  |
| K05 | pass | A read path is data, with a working profile-syntax injection control |  |
| K06 | pass | Metal compute and hardware-only VideoToolbox encoding work inside a workspace | Metal compute verified on Apple M5; HEVC VideoToolbox with -allow_sw 0 produced a nonempty movie. Product verify also reports a probed hardware encode pass. Torch, Chrome, CoreML and GPU performance are not measured by this eval. |
| K07 | pass | LaunchServices cannot open an app whose harmless effect works unconfined |  |
| K08 | pass | LaunchServices refuses registration that succeeds unconfined |  |
| K09 | pass | A launchd job is refused beside a working harmless unconfined job | launchctl submit measured. at/crontab installation is not measured because the eval does not modify the user's queues. |
| K10 | pass | Daemon Unix sockets are refused with live controls, while DNS works | Only socket connections were attempted, with no Docker or nix API commands. |
| K11 | pass | Preferences and clipboard reads are refused beside nonempty read-only controls | Controls were nonempty, confined output empty. Neither values nor clipboard contents were logged. |
| K12 | pass | Outside-process signals and open-file inspection are refused beside working controls |  |
| K13 | not measured | Keychain credential access is covered by a working unconfined control | Not measured. K23 exercises the authorized host Keychain import; that does not prove confined Keychain reads are refused. No inside-password boundary probe was run. |
| K14 | pass | Stop clears detached, env-cleared, new-session, process-group and fork-loop children only | Double-fork/setsid parent exited; env-cleared and process-group children, script session and a live fork loop cleared. Other-workspace process and marker decoy survived. |
| K16 | pass | Confirmed remove deletes its folder, unregisters its app and reports shared hard links |  |
| K17 | pass | Open loopback reaches a controlled outside listener and is disclosed with current listeners | Random-port listener reached. Declared-ports mode is deliberately absent. |
| K18 | pass | HTTPS works and open network effects are disclosed | HTTPS positive control only. No LAN, tailnet or other machine was contacted. |
| K19 | pass | A known outside process command line is visible inside, as disclosed |  |
| K20 | pass | Codex's inner sandbox fails beside a working unconfined control | Only the eval explicitly invoked Codex's sandbox. Asidee supplies no agent sandbox flags. |
| K21 | pass | Copying a project never creates hard links or changes its original on execution/removal | Both cp -cR and cp -R produced independent inodes and preserved source bytes. Asidee uses cp -R -P -X for a plain, non-dereferencing copy; no speed claim. |
| K22 | pass | Workspace CLI pipes carry stdin, separate stderr and preserve exit codes through the socket |  |
| K23 | pass | The selected default Claude login is imported through the product and reports logged in | Default profile selected independently of daemon environment; timed Keychain reader reused from sandbox login import. Private credential and onboarding/account state copied. Product-path claude auth status reported loggedIn true. claude: copied; CLI reports logged in; authenticated API calls and refresh not measured. codex: Not imported: the credential or Claude account state could not be read; contents withheld. No login, logout, authenticated API call or refresh was performed. |
| K24 | pass | Time Machine reports the workspace folder excluded after creation | isexcluded reports [Excluded]. No backup was created, inspected or removed. |
| K25 | pass | Dashboard summary neither repairs workspace identity nor walks it for size | Missing tag and read-only root stayed unchanged; unknown process state, no size. Unit Runner instrumentation additionally requires zero host commands from summary. |
| K26 | pass | Product exec skips informational probes and verify does not repair unreadable subdirectories | Exec preserved the last full verification; failing ffmpeg ran only for explicit verify. An unreadable hard-link walk stays unknown until remove repairs permissions. |
| K27 | pass | Command arguments cannot be parsed as sandbox-exec options, beside a working escape control | Old form accepted -D WS=/ and wrote only this eval's outside control file. Product -- separator caused execvp of -D to fail, with no outside write. The tested -p two-profile form itself returned usage error on this macOS. |
| K28 | pass | Misspelled operations and unconfined decision controls cannot establish a pass | A trusted sleep runs under an allow-control profile, with explicit job-creation permission and this workspace's denied tag. No workspace/user command runs in that control. Real Unix-socket connect denial is measured independently of policy decisions. |
