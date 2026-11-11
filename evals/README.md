# Evals

The eval set is the list of things Paddock says about itself, each measured from outside it.

```sh
bun evals/run.ts                 # every eval
bun evals/run.ts --only H,T03    # groups or single ids
bun evals/run.ts --write         # also rewrite SCORECARD.md
```

It builds `dist/paddock` and runs it with a state and config folder of its own, on the first engine `paddock doctor`
calls ready. Sandboxes it makes are named `evXXXX-…` and removed at the end. It refuses to start while other Paddock
sandboxes run on the engine, because the tamper evals change the firewall guard they share. It needs Docker, Bun, and
for a few evals `python3` and a Chromium-based browser; an eval that lacks what it needs is reported as not measured.

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
| D | Does the daemon keep its promises through crashes, races and upgrades? |
| P | Does it build and run on other platforms, as far as this machine can show? |
| E | What has nobody measured? |
| Z | Is anything left behind? |

## Adding one

Add an `ev(id, claim, run)` to `run.ts`. Write the claim as a sentence a user would rely on. Throw to fail, return a
note to pass, call `skip(why)` when the machine cannot measure it. If the eval shows something is blocked, give it a
control. When you add a claim to the README or the checklist, add the eval that would catch it being false.
