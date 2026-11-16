# Audit B implementation report

This work starts at `9cffcf6` on `main`. All commits stay on `main`; none were pushed.
The audit is `scratch/paddock-audit-B.md` in HQ. Results below are from this Mac unless explicitly marked Linux.

B27 remains partly addressed. The counted baseline did not reproduce the refusal. Explicit buffer retention and better
pid diagnostics are implemented, but the cause is unproven and no reduction in failures has been measured.
B2 was already implemented at the supplied starting commit.

## Commands and evidence

All Bun commands below ran from the Paddock folder through `nix develop -c`. The following short names refer to the
actual commands, not additional tools.

| Name | Command |
|---|---|
| F | `nix develop -c bun test test/unit` |
| C | `nix develop -c bun test ./test/unit/cli-output.test.ts` |
| W | `nix develop -c bun test ./test/unit/workspaces.test.ts --test-name-pattern 'a starter\|B27:'` |
| S | `nix develop -c bun test ./test/unit/workspace-session.test.ts ./test/unit/workspaces.test.ts --test-name-pattern 'signal returns\|deliver a reason'` |
| H | `nix develop -c bun test ./test/unit/host-scripts.test.ts ./test/unit/hosts.test.ts` |
| G | `nix develop -c bun test ./test/unit/create-cleanup.test.ts ./test/unit/core.test.ts --test-name-pattern 'missing image\|gVisor flags'` |
| L | `nix develop -c bun test ./test/unit/engine-session.test.ts --test-name-pattern 'link test replies'` |
| I | `nix develop -c bun test ./test/unit/exec-bytes.test.ts` |
| E1 | `nix develop -c bun evals/run.ts --only U,J01,J02,N02,N06,N10,N20,K31,K32` |
| E2 | `nix develop -c bun evals/run.ts --only U01,U15,U18,N01,N02,N20` |
| E3 | `nix develop -c bun evals/run.ts --only U19` |
| E4 | `nix develop -c bun evals/run.ts --only U15,U18,N20` |

The unit tests use local fixtures or a fake daemon/engine where stated. A passing assertion is identified below
instead of claiming its fixture values were observed on a Linux engine. Raw local logs remain under
`dist/audit-b/`; these are ignored working artifacts.

## Results by item

| Item | Status and commits | Command and deciding evidence | What is not checked |
|---|---|---|---|
| B1 | Fixed. `4bc08c7`, `3a8ac18`. | C passes the SIGINT test for create, workspace create, resize and snapshot, with exit 130 and one explanatory stderr line. E3 passes U19 on real Docker. It prints `The daemon is still finishing evkfgi-interrupted; it will appear in paddock list. Remove it with paddock remove evkfgi-interrupted --confirm evkfgi-interrupted.` U19 also waits for the daemon to finish, checks list/running state and removes its sandbox. | The real Docker interruption was create. Workspace create, resize and snapshot use fake-daemon CLI tests. Cancellation was not added. |
| B2 | Not real at `9cffcf6`; regression coverage added in `dd0d765`. | C passes `audit B2: workspace get and list include the saved stop reason` before any production edit. Both text paths already print `view.stopReason`. | The CLI test supplies a saved stop reason through a fake daemon. The real disk-watch stop is separately measured by K31. |
| B3 | Fixed. `27cc0a7`, `689786d`. | S passes the real Mac workspace stop/remove/watch test. Each returns 137 and includes its reason on stderr before end. F additionally checks that a terminal killed with SIGTERM gives 143 with its reason. E1 passes K31/K32. | No Linux workspace claim. The stop/remove/watch integration test uses pipes; PTY signal mapping is tested separately. |
| B4 | Fixed wording, behavior preserved. `dd0d765`, `689786d`. | C passes help checks for both exec commands. I passes `piped exec input stays ignored unless --stdin or --stream was chosen`, asserting neither stdin field is sent without opt-in. | Help and ignored-input tests use a fake daemon. Existing byte-exact stdin/stream tests remain in I. |
| B7 | Fixed in code. `1025808`, `9f80fc1`, `0655067`, `2e0e86c`. | H passes staged-input swap refusal, use of an unchanged private copy after the original changes, preservation of basenames for directory installs, and rejection of a replaced interactive request. Plan tests require every staged-input consumer to use the sudo Python copy/check command. The read-only Linux plan contains those scripts and digests in its hash. | No privileged Linux apply. The helper's byte semantics ran unprivileged on this Mac; root ownership follows the planned sudo command and was not measured on Linux. |
| B8 | Fixed. `1025808`, `2e0e86c`. | H passes fresh request-path and repeated-apply tests. E1/E2/E4 pass N20, including `a planted staging folder stayed untouched and did not block retry`. Apply reports the actual destination-created stage path. | No killed privileged Linux apply. Leftover collision behavior is measured locally. |
| B9 | Fixed for package-source file text. `1025808`. | H passes `B9: repository text removes URL userinfo and binds original bytes by hash`. It runs HOST_PROBE with fake OS/command responses and a real source fixture, checks sanitized URLs, and checks SHA-256 against the original source bytes. | home-linux already has Docker, so its plan does not exercise apt-source collection. No private repository download was attempted. |
| B10 | Fixed in code. `1025808`, `2e0e86c`. | The old script reproduces `sudo timestamp expired` in `b10-before.log`. H passes with an initial refresh before the final probe and a refresh immediately before each privileged step. The subprocess stub expires the timestamp after each step. | No real sudo expiry or interactive Linux install. N10 is unmeasured without an authorized disposable host. |
| B11 | Fixed. `dd0d765`, `3a8ac18`. | C passes `B11: doctor exits 5 with no engines or with unavailable engines`, asserting exit 5 for both an empty engine list and a list containing only an unavailable engine. | This dependency failure uses a fake daemon; the live evals use a ready engine. |
| B12 | Fixed. `dd0d765`, `cdfad3c`. | C passes stopped-config output/exit 0 and the runtime-failure counterexample. Core tests assert `configurationOnly: true` for stopped configuration and false when live verification stops the sandbox. E1/E2 pass U01 against real Docker. | No Linux verify command was run. |
| B13 | Fixed. `ea19798`, `9df82fb`. | G passes image/reason/dependency handling. Core regression coverage preserves that code through cleanup and rejects doubled punctuation. E2/E4 pass U15, which now requires exit 5 and error code `dependency`. | Bad-image behavior is measured on this Mac's Docker engine, not Linux. |
| B14 | Fixed. `bb06d2c`. | C passes `B14/B19: workspace text summarizes listeners and uses GiB; JSON keeps listener detail`. It checks `8000 (process0)`, de-duplication, an eight-pair cap, absence of kernel-address text, and byte-for-byte retention of the original detail in JSON. | The formatting fixture is synthetic; no Linux workspace claim. |
| B16 | Fixed. `dd0d765`. | C passes `B16: usage errors point to the command help`, including `See paddock create --help`, `paddock snapshot --help` and `paddock workspace get --help`. E1 passes U02 on the built CLI. | Unknown command names still point to overall help because no such command-specific help exists. |
| B18 | Fixed. `ea19798`. | G passes `gVisor flags that open the host are recognized in every spelling`, including an assertion that doctor's OrbStack recipe contains `--net-raw`. README already required raw networking for Docker inside and remains consistent. | No engine configuration was edited and no engine was restarted. |
| B19 | Fixed. `bb06d2c`, `689786d`. | C asserts `1.00 GiB` and `disk limit 2 GiB`. E1 passes K31/K32 with real bytes and the GiB stop/floor messages. Internal byte values and the `diskGb` API field are unchanged. | No Linux workspace claim. MiB remains the unit for shared exec/PTY buffer limits, not workspace disk capacity. |
| B20 | Fixed. `dd0d765`. | C's saved-verification test checks `verified N min ago`, the disk limit and exactly one `historical only` footer. A real list output is saved in `live-list.log`. | The relative-time assertion uses a saved fake-daemon timestamp. No Linux list was run. |
| B22 | Fixed. `a8cf7ee`, `9df82fb`, `3a8ac18`. | C checks local/remote wording. E2/E4 pass U18 on Docker, with a closed target that still gets a forward and a listening control that gets no warning. | Remote wording is unit-tested with `--host build`; no remote forward was created. |
| B25 | Fixed. `05dd31c`. | `nix develop -c bun test test/unit/ui.test.ts` passed 15 tests. A source check shows the comment says `3-second refresh`, matching `setInterval(refresh, 3000)`. | The comment itself is checked by reading the source, not a browser assertion. |
| B26 | Fixed. `05dd31c`. | `rg -n 'Not built\|not built' docs/design/machines.md` shows host upgrade and ssh config marked not built and points to host add, ssh access and ssh setup. | Documentation/source check; these proposed commands were not implemented. |
| Links | Fixed. `c7a8129`. | L passes `link test replies travel on stdin and never in the sandbox command line`, asserting the value is absent from argv and present on stdin. E1 passes J01/J02 on real Docker, including live link-scope checks. | The argv assertion intercepts the provider's session creation. No process-list scan or Linux link test was run. The listener's environment remains readable inside its sandbox. |
| B27 | Partly addressed. `e02f36a`, `486bf38`. | Baseline and retention-only samples are described below. W passes the refusal diagnostics and the real control-pid identity test. | The refusal and ENOTEMPTY were not reproduced in the counted samples. No cause is proven and no measured fix is claimed. |

## B27 measurement

The unchanged-source baseline finished with **0 failures in 200 runs (0% observed)**. The retention-only sample
finished with **0 failures in 200 runs (0% observed)**. Every one of the 400 logs contains `7 pass` and exits 0.
Neither the profile-acquisition refusal nor ENOTEMPTY was reproduced in either counted sample.

The measurement used an untouched `rtk proxy git archive 9cffcf6` source copy under `dist/audit-b/baseline`, on the
Desktop checkout. Each iteration ran `nix develop -c bun test dist/audit-b/baseline/test/unit/exec-bytes.test.ts`
from the Paddock root. After the baseline, only `core/workspace-processes.ts` was replaced with its buffer-retention
version from `e02f36a`. The same file path and full test file were run another 200 times. The executable/parent
refusal diagnostics were tested separately and were not in this retention-only comparison.

`snapshot-provenance.json` compares all 119 tracked files against `9cffcf6`, finds only that one changed file,
and checks it against `e02f36a`. The source copy was archived and removed before full unit discovery.
Each iteration has its own numbered output log and a TSV row with its exit code and elapsed time:

- [Baseline results](../dist/audit-b/b27-baseline-valid/results.tsv).
- [Retention-only results](../dist/audit-b/b27-after-retention/results.tsv).
- [Source provenance](../dist/audit-b/snapshot-provenance.json).
- [Source snapshot after retention](../dist/audit-b/retention-snapshot.tar.gz).

Hypothesis (a), buffer lifetime, remains unproven. Explicit references now survive the native call, but a zero-to-zero
comparison provides no evidence of a reduction. Hypothesis (b), a different pid carrying the profile, was not observed
in the real control-pid test. The diagnostics make a future refusal more informative. This is not a measured fix.

The pid test runs the actual confined control profile. `proc_pidpath` reports `/bin/sleep`; `proc_bsdshortinfo` reports
the test process as parent, and sandbox decisions show the expected allowed folder read/write and denied tag read.
The local SDK declares `pbsi_ppid` at offset 4 and `proc_pidpath` in libproc.h. This is one successful control sample,
not evidence about a refusal that never occurred.

Two earlier runs are excluded and retained separately. The working-tree run overlapped edits and has 9 nonzero
results among 135 completed iterations, caused by the temporary GiB ReferenceError. The copied-flake attempt has
200 Nix failures before Bun started because Nix refused an untracked flake. Neither measures B27.

## Final checks and Linux plan

The required final commands passed:

```text
nix develop -c bun run typecheck
$ tsc --noEmit

nix develop -c bun test test/unit
349 pass
0 fail
3843 expect() calls
Ran 349 tests across 28 files.
```

The real Docker eval runs completed as follows. Each run built and started its own Paddock with temporary state,
used only its `ev…` sandboxes, and passed Z01 cleanup.

| Run | Result |
|---|---|
| E1 | `24 of 27 hold, 0 do not, 3 could not be measured here`. N02/N06/N10 lacked an authorized disposable host. |
| E2 | `5 of 7 hold, 0 do not, 2 could not be measured here`. N01/N02 lacked their remote fixtures. |
| E3 | `2 of 2 hold, 0 do not, 0 could not be measured here`. Real Ctrl-C and cleanup. |
| E4 | `4 of 4 hold, 0 do not, 0 could not be measured here`. Image exit, forward controls, N20 and cleanup. |

E4's deciding lines are:

```text
exit 5: Cannot download image does-not-exist:1: pull access denied for does-not-exist, repository does not exist or may require 'docker login'. Nothing was kept for ev074o-badimage.
nothing listens on 54321 inside yet.; port 54322 listened; no warning
the planned archive installed; 5 altered archives and a changed destination ran no step; a planted staging folder stayed untouched and did not block retry
```

The only Linux runtime check in this task was the authorized read-only plan. Both artifacts were built from the same
production source tree into `dist/`; the owner’s current build was not replaced. With isolated local directories:

```sh
PADDOCK_STATE_DIR=/private/tmp/claude-501/w9/bimpl/s \
PADDOCK_CONFIG_DIR=/private/tmp/claude-501/w9/bimpl/c \
dist/paddock config set experimental on

PADDOCK_STATE_DIR=/private/tmp/claude-501/w9/bimpl/s \
PADDOCK_CONFIG_DIR=/private/tmp/claude-501/w9/bimpl/c \
dist/paddock host add home-linux --ssh home-linux \
  --artifact "$PWD/dist/paddock-linux-x64" \
  --sha256 c34afb2ea43c319b106bb92dedff30910aa1f221cbcf8eb4de053353e85a7a17 \
  --docker --disk-policy watched --json
```

The final plan exited 0. Its hash is `905a59faa64e5ebe650523302a59566448eb95148a154640d7c0477a4ddc893b`. It has eight steps, two of which use checked root copies,
and `blockers: []`. Docker and the runtime are already installed there; this plan does not exercise new apt or
gVisor installation. No consent was supplied and no plan was applied. The isolated local daemon was stopped.

The plan proves that planning works on this Linux machine. It provides no runtime proof of root copy ownership,
package installation, sudo refresh, service restart or installed sandbox behavior. The N installer evals were invoked
and reported unmeasured; no other SSH machine was contacted to satisfy them. Self-review was performed; no
independent agent review was run because sub-agents were prohibited.

Local evidence:

- [Final unit output](../dist/audit-b/unit-final.log) and [typecheck output](../dist/audit-b/typecheck-final.log).
- [E1 output](../dist/audit-b/evals.log), [E2 output](../dist/audit-b/evals-final.log),
  [E3 output](../dist/audit-b/eval-interrupt.log), and [E4 output](../dist/audit-b/eval-final-lines.log).
- [Final Linux plan](../dist/audit-b/home-linux-final-plan.json).
- [Host-script unit output](../dist/audit-b/host-scripts-final.log),
  [B10 baseline refusal](../dist/audit-b/b10-before.log), and [pid diagnostics](../dist/audit-b/b27-diagnostics-after.log).
- [Decision trail](../dist/audit-b/decisions.tsv).

The owner’s daemon, `scratch/paddock-bin`, `scratch/paddock-linux-build`, protected workspaces and `sandbox-*`
objects were not modified. No Docker/OrbStack restart, Mac sudo, login/logout, push, branch creation or remote apply
was performed. The only SSH destination contacted was home-linux for the authorized read-only `host add --json` plan.
No sub-agents were started. Eval K23 and the full eval suite were not run. Scorecards were not regenerated.
B5, B6, B17, B21, B23, B24, renaming and unselected audit work were left alone.
