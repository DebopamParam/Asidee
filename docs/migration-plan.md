# Migration plan: everything `sandbox-manager` does, in Paddock

The owner runs a personal tool, `../sandbox-manager` (read-only reference; never edit it), and wants Paddock to replace
it entirely. This file is the shared brief for everyone working on that. Read `README.md` and `docs/architecture.md`
first.

## What must not be lost

Paddock's one promise: **it never claims a property it cannot show.** Concretely:

- Only `core/` runs engine commands. The CLI, the dashboard and extensions are clients of the API in `core/daemon.ts`.
- A spec can only express what the core can check. A new ability is a **named, typed option** with its own evidence in
  the checklist, never a free-form engine flag and never something an extension does behind the core's back.
- Every claim has an eval in `evals/run.ts` that measures it from outside (with a control where a "blocked" result
  could be a false negative). A feature without evals is not done. `evals/SCORECARD.md` must have no "does not hold".
- A check that could not be made is `unknown`, never `pass`. A weaker form is `weak`, and the detail says how.
- Docs say what was measured and what was not. Do not write a claim you did not run.

## Decisions already made with the owner

- Sandboxes are gVisor **containers** ("a mini-VM rented from a cloud provider"): they cannot reach the host, each
  other, or the LAN; they have limits; they can run Docker inside, and inner containers have internet.
- Docker Sandboxes microVMs are **deferred**. Do not build them, but every new option must be an engine *capability*
  (`Capabilities` in `core/types.ts`) so a future provider can answer "not available here".
- One dashboard: the web one. No terminal dashboard.
- Ports: a forwarded port appears only on the loopback of the machine the person sits at. No LAN publishing, and no
  engine-level port publishing (`-p`) ever.
- Several machines: one Paddock daemon per machine that has an engine; the primary machine reaches the others over
  SSH (their Unix sockets). `paddock host add` sets up a Linux machine and shows what it will do before doing it.
- Existing sandboxes are not imported; they are recreated.
- A sandbox-to-sandbox network comes later. Word the "cannot reach other sandboxes" evidence so it can later say
  "except the ones you linked".

## Stages

1. **Core options**, each with its check and evals:
   a. Docker inside a sandbox, inner containers online.
   b. Port forwards owned by the core.
   c. Resize, and snapshot (an image made from a sandbox, for templates).
   d. Hard disk cap (Linux hosts with sudo; OrbStack stays "watched").
2. **Access**: SSH alias for editors and T3 Code, T3 Code setup, the account rotator.
3. **Logins and setup**: Claude, Codex and gh login import, agent settings and skills, repository clone and save,
   environment docs.
4. **Machines**: daemon per machine, `paddock host add` for Linux, the dashboard showing all of them.
5. **Move over**: the owner's sandboxes recreated; the HQ shell and skill switched to `paddock`.
6. Afterwards: the macOS [workspace kind](workspaces.md), not a sandbox, is implemented with its own checklist and
   K evals. Claude Keychain import is measured through product-path login status; authenticated calls and token
   refresh remain unverified. The sandbox-to-sandbox network is still later.

## Rules for everyone working here

- Work in this repository only, on `main`. Never create a branch, never push. Commit when a unit of work is complete
  and green; one imperative sentence as the subject.
- Tools: run everything through this repository's flake: `nix develop -c bun test test/unit`,
  `nix develop -c bun run typecheck`, `nix develop -c bun evals/run.ts [--only GROUP,ID] [--write]`.
- The engine is OrbStack's Docker (`docker --context orbstack`, runtime `runsc-sandbox`). **Never** restart Docker or
  OrbStack, change the engine's `daemon.json`, or touch containers, networks or volumes whose names start with
  `sandbox-` (they are the owner's live sandboxes). Never use `sudo` on this Mac. Do not connect to other machines
  unless your task says so.
- Clean up every container, network, volume and image you create. The evals refuse to run while other Paddock
  sandboxes exist on the engine, so do not leave test sandboxes behind, and use a temporary `PADDOCK_STATE_DIR` and
  `PADDOCK_CONFIG_DIR` for manual tests.
- Stay inside the files your task names. If you need a change elsewhere, say so in your final report instead of
  making it.
- Match the code that is there: dense, few dependencies (no new runtime dependency), comments that state a reason.
- Your final report lists: what you built, the exact commands you ran and their results, what you could not verify,
  and anything you are unsure about. An unverified claim presented as verified is the worst possible outcome.
