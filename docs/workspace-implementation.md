# Workspace implementation and verification

Measured on macOS 26.7.1, Apple M5, arm64, Bun 1.4.2, on 2026-11-12. Implementation revision `594ccbf`.
Only local unit tests and the K eval group were run. Neither full sandbox scorecard was regenerated.

## Built

Workspaces have their own spec, manifest, checklist and socket-only API methods. The CLI supports create, shell,
exec, list, stop, confirmed remove and verify. The profile uses canonical path parameters, final tag denies, a
cleared environment, pipes or a PTY, and guarded process identification. It refuses protected read allowances and
outside writes and daemon sockets. `--copy` makes a private project copy in `work`, without hard links. The original
is never opened for writing by the copy operation or visited by remove. README, architecture, migration plan and the
operator skill describe the separate kind and its limits.

The dashboard lists workspaces separately and says they are not sandboxes. Its workspace section is read-only.
Every named workspace API method, including stop, remains socket-only. This resolves the design's conflicting
requests for socket-only methods and a dashboard Stop button in favor of socket-only authority; CLI stop is built.

## Commands and results

| Command | Result |
|---|---|
| `nix develop -c bun test` | 203 passed, 0 failed, 1 gated live-engine test skipped; 204 tests in 19 files. |
| `nix develop -c bun run typecheck` | Clean, using the repository's `tsc --noEmit` script. |
| `nix develop -c bun evals/run.ts --only K --write` | 23 passed, 0 failed, 1 not measured. |

The [workspace scorecard](../evals/SCORECARD.workspace.md) lists every claim, control and limit. The runner builds and
tests the compiled CLI as well as probing the profile directly. K15's list-only control ran before lifecycle signals:
zero matches for an empty folder, exactly two known PIDs for a populated folder, no marker-decoy match. Unit and K14
controls also keep another workspace alive while stopping detached children, env-cleared children, new sessions,
separate process groups and a live fork loop. Every production signal rechecks the full tag criterion first.

Metal compute verified 256 results on the M5. HEVC VideoToolbox produced a nonempty movie with software fallback
disabled. Local npm global, pip user and uv tool installations resolved inside the workspace. Read/write controls,
profile injection, app opening and registration, launchd, Unix sockets, DNS, preferences/clipboard, outside signals
and descriptors, open loopback, HTTPS and outside command-line visibility were exercised. K16 checked hard-link
reporting, original-file survival, confirmation and an independent LaunchServices dump after removal. K22 exercised
stdin, stdout, stderr, exit codes, streaming and refusal of all workspace methods over TCP with a valid token.

## Unavailable or unverified

- Claude's existing Keychain login was found by attributes only. No password was requested, so no password access
  prompt was triggered. **Claude Keychain import is not working.** File-backed imports are implemented and tested
  with private fixture files; no real Claude file-backed authenticated session was established.
- The selected Codex file was copied with identical bytes, a distinct inode, one link and mode 0600. Its CLI
  recognised a login inside the workspace. **Authenticated API calls and token refresh remain unverified.** No
  login/logout or token refresh was attempted. Tokens were not printed or put in manifests or logs.
- K13 is not measured because its positive password control can prompt. Keychain additions also remain not covered.
- Apple events have no harmless end-to-end side-effect probe and remain not covered. The deny rule alone is not a
  passing result. TCC services, camera/microphone capture, other IOKit devices, Bluetooth and Spotlight retention
  were not tested. No permission-gated probe was attempted.
- K09 measures launchd only. It does not install `at` jobs or crontabs in the user's queues.
- Torch/MPS, Chrome's renderer, CoreML and GPU/cache performance were not rerun. The runtime GPU checklist stays
  unknown; K06 is the independent Metal/HEVC measurement. Claude's inner command sandbox is not measured.
- Codex's inner sandbox was measured with a successful unconfined control and failed inside as expected. Paddock
  passes no flags to change agent sandboxes. Non-macOS refusal is implemented and unit-checked; Linux execution
  of this new feature was not run. No remote host or other eval group was used.
- Unified logs, existing backups, remote effects and changes through supplied outside hard links cannot be erased
  by removal. Time Machine reports current workspace folders excluded; old backups and other backup tools were not
  inspected. Unnamed daemon channels and a guarantee of erasing every trace remain outside coverage.

## Design corrections discovered while building

1. Direct fixed-arity FFI calls to variadic `sandbox_check` returned incorrect path decisions on Apple Silicon and
   missed the known control processes. Lifecycle testing remained disabled until the control passed. The finder now
   uses Bun's FFI for libproc and a six-line C wrapper for the Darwin varargs ABI. Bun's built-in TinyCC compiles it
   into memory; no external compiler or compiled helper is installed.
2. TinyCC cannot read a compiled Bun executable's embedded `/$bunfs` source path. The static wrapper is briefly
   materialised in `/private/tmp/paddock-ffi-*` and deleted in `finally`. Source and compiled execution were tested.
3. A folder changed to mode `000` makes canonicalisation fail before tag inspection. Recovery now first rejects
   symlinks with `lstat`, restores owner access and then checks the canonical path. Unreadable and manually deleted
   folder recovery both pass live unit controls.
4. The full LaunchServices dump exceeds the core runner's 16 MiB output limit on this Mac. A pre-deletion check also
   missed a registration observed by K16 after remove returned. Removal now filters the database before collecting
   output, checks after deletion and retries only its own bundles for a bounded period. K16 checks both the returned
   report and an independent final dump. An unregistration command for an already absent bundle can return -10814;
   that command result alone is not proof of a surviving registration.
5. Both `cp -cR` and `cp -R` produced distinct inodes, link counts of one and unchanged source bytes after modifying
   the copy. Paddock chooses plain `cp -R -P -X` for simplicity. No copy-speed or physical-storage claim is made.
6. Nix's temporary directory disappears when its shell command exits. The K daemon therefore uses explicit stable
   `/private/tmp/pdk-k-*` state. Two early failed compiled-wrapper runs were cleaned up by identifying only their
   own daemon PIDs and confirming empty fixture finders before deleting the fixtures.
7. Copied login presence and CLI recognition do not establish working authentication. Claude Keychain precedence
   also means a leftover credential file cannot be substituted silently. These have explicit unavailable/unverified
   results. The old blanket Apple-event claim is not used.

The owner's final decisions are implemented: open disclosed loopback with listener inventory, `~/Paddock/NAME`, a
project copy, refused SSH/protected ancestors, tag denies emitted last, no agent sandbox flags, blocked outside
installs and Docker/nix sockets, and `--confirm NAME`. Tests override the workspace root into this checkout's ignored
`dist/` while preserving the requirement that it be inside the account's real home. No test used `~/Paddock`, copied
the cartoon project or created a loose file at the home root.

## Cleanup audit

After the final K run, an independent audit found zero workspace fixture directories, zero `/private/tmp/pdk-k-*`
or `paddock-ffi-*` directories, no matching eval daemon PIDs, zero fixture LaunchServices references and zero fixture
launchd references. K01's exclusive control files were absent from `/var/folders/0m/zkpfqc915z1d_jzs16c28l_m0000gn/T/`,
`/Users/Shared` and `/opt/homebrew/Cellar`. Known detached PIDs were also checked by K14 after stop. No Docker engine
commands, sudo, remote-machine commands or commands to edit owner files, shell configuration, preferences or Keychain
items were used. K10 only connected to the engine sockets without sending API requests.

The existing ignored `dist/paddock` was rebuilt and retained. The updated development type packages are in
`node_modules`; their package/lock changes are committed. Temporary run logs were removed after recording these
results. Ordinary tool caches and macOS unified logs were not erased or audited for retention. The committed source,
documentation and workspace-only scorecard are the intended artifacts.
