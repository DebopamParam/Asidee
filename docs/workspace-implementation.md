# Workspace implementation and verification

Measured on macOS 26.7.1, Apple M5, arm64, Bun 1.4.2. Only local unit tests and group K were used. Neither full
sandbox scorecard was regenerated. The [workspace scorecard](../evals/SCORECARD.workspace.md) identifies the exact
revision and each result.

## Review corrections

1. **Shared, predictable login import.** Credential reading, service names, profile validation and Claude's state
   allowlist now live in `core/credentials.ts`, reused by workspaces and the sandbox login extension. Creation selects
   the `default` profiles. `--claude-profile work` selects `~/.claude-work`; `--codex-profile work` selects
   `~/.codex-work`. `--no-logins` skips credential and account-state reads. Daemon environment variables never select
   sources. Claude Keychain password reads have a 15-second timeout and report failures as not imported, without
   credential values or stale-file substitution. Credentials and allowlisted onboarding/account state are private
   mode-0600 files inside the workspace.
2. **Read-only summary.** Summary reads manifests and tagged-process counts. It does not restore the folder/tag,
   chmod directories, or run `du`. Missing identity stays unknown. Size is measured only on explicit list/get
   requests; shell preparation also uses the cheap view. The 30-second enforcement pass no longer inventories
   workspaces and discards the results. K25 and unit Runner instrumentation cover these behaviors.
3. **Blocking launch checks only.** Exec and shell run the blocking checks, including controlled filesystem and
   Unix-socket probes. Informational login, GPU, listener, hard-link and Time Machine work is restricted to create
   and explicit verify. Launch preserves the timestamp of the last full verify. Hard-link verification reads only;
   permission repair is enabled only by remove. K26 and unit tests use instrumented tools and unreadable directories.
4. **Fallible confined controls.** Read/write policy checks have same-operation allowed controls on the workspace
   folder. Global operation denials use another confined profile with the required allows, running only Paddock's
   trusted `sleep`. `job-creation` needed an explicit allow in that control; allow-default alone returned denied.
   Misspelled operations return unknown and cannot establish a pass. The socket check opens a real private listener;
   the same command must receive its marker outside the profile, and the confined connect must fail. No pass relies
   on an unconfined `sandbox_check` result. K28 and the unit negative controls cover this.
5. **Command-option boundary.** Every product launch places `--` after sandbox-exec's profile parameters. The tested
   `-p` two-profile form returned usage error on this macOS, but `-D WS=/` in the old unseparated form worked and
   wrote this test's outside control file. The product form treats `-D` as an executable name, exits 71 and makes no
   outside write. Both the unit test and K27 keep the working escape control.
6. **Exact dependency pin.** `@types/bun` is exactly `1.4.4` in both the manifest and lockfile. No runtime dependency
   was added.
7. **Real media probe.** Create and verify locate ffmpeg on the workspace PATH and attempt hardware-only HEVC
   VideoToolbox encoding with software fallback disabled. Exit zero and a nonempty temporary movie pass; an encode
   failure fails. An unavailable tool or a probe that cannot run is unknown with a reason. The movie is removed in
   `finally`. This check does not claim Metal compute coverage and never runs before exec or shell. K06 separately
   verifies Metal compute, hardware encoding and the product's probed media result. K26 exercises a failing encoder.

All workspace APIs remain socket-only and local. The dashboard remains read-only. Process selection still requires
both allowed folder access and denied tag-file access, and rechecks the full criterion before every signal. K15
continues to run first. No process-selection guard was relaxed.

## Commands and measurements

| Command | Result |
|---|---|
| `nix develop -c bun test` | 208 passed, 0 failed, 1 gated live-engine test skipped; 209 tests in 19 files. |
| `nix develop -c bun run typecheck` | Clean, using the repository's `tsc --noEmit` script. |
| `nix develop -c bun evals/run.ts --only K --write` | See the generated workspace scorecard. |

K23 creates the workspace through the compiled CLI using default profiles, despite unrelated profile paths in the
daemon environment. The shared reader retrieved the owner's default Claude Keychain credential. The private state
and credential were written, and `paddock workspace exec ... -- claude auth status` reported `loggedIn: true`.
Credential values, account fields and subprocess status output are withheld; the report records only the boolean
result and fixed diagnostic text. No login, logout, authenticated API call or refresh was performed.

The K suite also reruns its prior controls for copied-project independence, outside writes and home/shared-temp
reads, profile injection, Metal/VideoToolbox, app opening/registration, launchd, daemon sockets, DNS, preferences and
clipboard, outside signals and descriptors, detached processes, confirmed removal, loopback, HTTPS, command-line
visibility, Codex's inner sandbox, streams, socket authority and Time Machine exclusion. It executes no Docker engine
command or SSH transport. K10 connects to Docker/nix sockets as a control without sending API requests.

## Still unverified

- Claude login recognition is measured; authenticated requests, token refresh, expiry and the effect of refreshing a
  copied token on other clients remain unverified. Named profiles and private file copies are covered with fixtures;
  real Claude-work and real Codex-work authentication were not exercised in this revision.
- A real Keychain denial or hanging prompt was not needed for the successful default import. Those paths return
  not imported; no credential or state file is retained on import failure.
- K13 still does not establish a confined Keychain-read boundary. Successful host import is not that control.
  Keychain additions and Apple-event effects remain not covered.
- No TCC, screen-capture, accessibility, camera, microphone, Bluetooth or other-device permission probe was run.
  Torch/MPS, Chrome, CoreML and GPU/cache performance were not rerun. The media check is not a Metal-compute claim.
- `at` and crontab installation remain untested against the user's queues. Linux execution of this feature was not
  run; non-macOS refusal remains unit-covered.
- Remote effects, unified logs, existing backups and changes through outside hard links cannot be undone by remove.
  Spotlight retention and unnamed daemon channels remain outside coverage. Time Machine's current exclusion is
  measured; old backups and other backup tools were not inspected.

## Test scope and retained artifacts

Workspace fixtures live under this checkout's ignored `dist/`, still validated as inside the account's real home.
Private daemon state uses `/private/tmp/pdk-k-*`; runtime socket probes use `/private/tmp/paddock-check-*`. FFI wrapper
sources use `/private/tmp/paddock-ffi-*` and are deleted immediately after loading. No fixture was created under
`~/Paddock`, no loose file was created in the home root, and the cartoon project was neither opened nor copied.

The runner removes its workspaces, fixture app registrations/job, daemon and temporary directories. K01's exclusive
write controls in the user's temp folder, `/Users/Shared` and `/opt/homebrew/Cellar` are removed. Final cleanup is
audited separately before handback. No sudo, remote host, owner-container operation, Docker configuration edit,
shell-configuration edit, Keychain write or preference edit is performed.

The existing ignored `dist/paddock` is rebuilt and retained, alongside installed development packages. Temporary run
logs are removed after the results are recorded. Ordinary tool caches and macOS unified-log retention are not erased
or audited. The source, operator documentation and separate workspace scorecard are the intended artifacts.
