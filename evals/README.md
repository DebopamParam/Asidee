# Evals

The eval set is the list of things Paddock says about itself, each measured from outside it.

```sh
bun evals/run.ts                 # every eval
bun evals/run.ts --only H,T03    # groups or single ids
bun evals/run.ts --write         # also rewrite SCORECARD.md
bun evals/run.ts --write --label linux  # write SCORECARD.linux.md instead
```

It builds `dist/paddock` and runs it with a state and config folder of its own, on the first engine `paddock doctor`
calls ready. Sandboxes it makes are named `evXXXX-…` and removed at the end. It refuses to start while other Paddock
sandboxes run on the engine, because the tamper evals change the firewall guard they share. It needs Docker, Bun, and
for a few evals `python3` and a Chromium-based browser; an eval that lacks what it needs is reported as not measured.

Each scorecard records its engine, runtime, OS, architecture, and source revision. When running a source archive
without Git metadata, set `PADDOCK_EVAL_REVISION` to its revision and archive checksum. Separate labels retain results
from multiple machines. A run establishes claims only on the engine and OS it names.

Set `PADDOCK_EVAL_BROWSER` to a Chromium-based browser's executable path when discovery cannot find it. No browser
is installed by the evals. Set `PADDOCK_EVAL_LAN_TARGET=IPv4:port` to opt into E04 for one real private or tailnet
device. E04 requires that this host can open that TCP target before trying it from both the sandbox and inner Docker,
beside working internet controls. Without the input or host control it reports why it could not measure the target.
No port scan is performed.

Set `PADDOCK_EVAL_HOST=home-linux` (or another authorized SSH alias) to measure group M. Without it the whole group
is unmeasured. The fixture must have native Linux x86_64/arm64, a ready local Docker/gVisor engine, working BatchMode
SSH and established host-key trust, and no running Paddock sandboxes. The evals build for its architecture here and
copy a checksum-checked binary to `~/.pdk-machines-XXXXXX`, start a private socket-only daemon, and use `host attach`.
They create disposable sandboxes, tamper only with those sandboxes/Paddock resources, stop the primary for the
independent-enforcement check, exercise hosted streams/forwards and an editor SSH alias, then remove the sandboxes,
registration, daemon and directory. The inner editor SSH client reads only the run's temporary config (`-F`); the
outer transport reads the user's existing SSH config with UpdateHostKeys disabled. No sudo, host package
installation, system-file change, Docker restart or SSH-file write is performed. Installer, service and reboot
behavior remain unmeasured. The remote fixture is not an extra network listener.

Group M also needs `python3`, `ss`, `lsof` and `pgrep` on the fixture, and `lsof` here. Each is checked by a positive
control (a listener or process of the run that the tool must show), so a missing tool fails or leaves the eval
unmeasured instead of passing it. M02 needs `192.0.2.1` (TEST-NET-1) to be unroutable from this machine, and says so
when it is not. M03 builds two more gateways here: one with another version and one from changed source with the same
version. M08 stops this run's primary daemon with SIGSTOP for up to thirty seconds to measure the remote lease expiry,
and M11 stops one of its SSH processes the same way before `daemon stop`; both resume or kill what they stopped.

Group N covers host enrollment. N01 uses `PADDOCK_EVAL_HOST` only for a read-only probe and a plan, with before/after
file hashes, ownership, modes, mtimes and links. The installer evals require `PADDOCK_EVAL_ENROLL_HOST=pdk-enroll-NAME@orb`,
a disposable Ubuntu machine with Docker, readable Docker access, `alpine:latest`, systemd, Python 3 and passwordless
sudo. Start with no current Paddock service, no sandboxes and a readable `/etc/docker/daemon.json` containing unrelated
settings. N02 through N07 measure plans, stale inventory/config consent, refusals, a partial installation failure, full
installation, a real Docker-restart interruption, smoke isolation/disk checks, removal and sudo-never reuse.

N08 additionally needs `PADDOCK_EVAL_ENROLL_PACKAGES_HOST=pdk-enroll-OTHER@orb`, another fresh Ubuntu machine without
Docker, with usable signed apt metadata already populated. It measures the complete pinned distro package transaction
and confirms no login-group edit. N09 drives an actual terminal to decline. N10 requires OrbStack root control of the
first fixture; it temporarily sets that disposable account's password and an isolated sudoers override to require a
password with tty-scoped timestamps, then removes the override. No real user's password is used. N11 corrupts one
uploaded binary byte using a private SSH wrapper, beside the valid installation controls. N12 follows the manual
uninstall path on the first fixture, retaining distro packages and unrelated Docker settings. Delete both machines
after the run. These evals reject destinations outside the explicit disposable naming pattern and never install on
`PADDOCK_EVAL_HOST` or change the Mac's Docker configuration. A missing fixture is not measured. Example:

```sh
PADDOCK_EVAL_HOST=home-linux \
PADDOCK_EVAL_ENROLL_HOST=pdk-enroll-test@orb \
PADDOCK_EVAL_ENROLL_PACKAGES_HOST=pdk-enroll-packages@orb \
bun evals/run.ts --write
```

**Docker Hub pulls.** A full run pulls from Docker Hub at most five times, all from inner Docker: I01 twice
(`alpine:latest`; the attempt without `SYS_ADMIN` fails only after fetching), I09 once (`busybox:stable`) and I15
twice (`busybox:stable`, then by digest). Verify's probe and the other evals use images loaded from the engine, and I24
blocks the registry on purpose. The engine pulls `alpine:latest`, `docker:cli` (P02) and
`docker/sandbox-templates:shell-docker` only when they are missing. Docker Hub's anonymous quota read from this
machine's address showed 100 of 100 left both before and after the full run on 2026-11-11, so the five could not be
confirmed against the quota from here.

## How an eval decides

- **It does not ask Paddock.** "Cannot reach the host" is a listener on the engine's host and a connection attempt
  from inside the sandbox, made with the sandbox's own `nc`.
- **A blocked attempt needs a control.** Each target is first reached from the engine's host. T01 removes the guard
  and repeats the attempts, which must then connect; otherwise the blocked results would prove nothing.
- **Tampering uses plain engine commands**, the way a careless script or a customization gone wrong would.
- **Not measured is a result.** The E group lists claims this machine cannot test. They stay on the scorecard.

## Groups

| Group | Question |
|---|---|
| H | Is what the checklist says true when tried from inside a sandbox? |
| I | Does inner Docker run with minimal added capabilities, guarded networking, shared limits and clean removal? |
| T | Is a sandbox that stops holding caught and stopped? |
| R | Can any client ask the core for an unsafe sandbox? |
| F | Can everything outside the core be changed without touching it? |
| U | Can a person or an agent use it without reading the source? |
| S | Do exec and shell sessions carry raw bytes both ways, bounded, only over this machine's socket? |
| W | Does a forward reach the sandbox's loopback from this machine's loopback, and nothing else, for one run of it? |
| A | Does `ssh NAME.paddock` reach only that sandbox, with only this machine's editor key, through the daemon, without a port? |
| L | Do resized limits hold on the engine's host when resize says they do, and are unsafe resizes refused? |
| C | Does a template carry the sandbox's files, leave out the login files, and stay Paddock's own? |
| M | Does one selected machine's own daemon perform operations and checks over SSH, preserving identity, availability and socket authority? |
| N | Does reviewed Linux enrollment bind consent, verify provenance, install exactly the plan, refuse safely and leave a usable host? |
| D | Does the daemon keep its promises through crashes, races and upgrades? |
| P | Does it build and run on other platforms, as far as this machine can show? |
| E | What has nobody measured? |
| Z | Is anything left behind? |

## Adding one

Add an `ev(id, claim, run)` to `run.ts`. Write the claim as a sentence a user would rely on. Throw to fail, return a
note to pass, call `skip(why)` when the machine cannot measure it. If the eval shows something is blocked, give it a
control. When you add a claim to the README or the checklist, add the eval that would catch it being false.
