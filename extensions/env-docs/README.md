# Environment documentation

Install it with `asd ext install env-docs` (or the dashboard's Install button), then use the dashboard action or
`asd ext run env-docs write NAME --set workspace=/workspace/repo`. `asd ext remove env-docs` takes it out again. The
guest must be running, have Node and an existing workspace. Relative paths are resolved under the guest home; the
default is `workspace`. Guest Git is optional and is used only to exclude `/env_docs/` locally when the workspace is a
Git repository. From the Asidee source, for development, `bun extensions/env-docs/env-docs.ts NAME [WORKSPACE]` with
Bun and `asd` on PATH does the same.

The client calls `asd --json list`, then `asd --json verify NAME`, validates the result, and sends a Markdown
document on exec stdin for an atomic private write to `WORKSPACE/env_docs/SANDBOX.md`. A successful JSON envelope
from verify is accepted even with exit 6, preserving its failing checks. If verification stopped the sandbox, the
client refuses to write. It does not start it. Symlinked output paths are refused.

The document includes the reported name, status, engine, image, requested sizes, verification result and every
check's exact status, evidence kind and detail. Reachability entries repeat Asidee's reports for the host, peers,
private networks, egress, inbound access, guard and mounts. Missing entries say `not reported`. No operating-system,
root, sudo, Docker, SSH, resource-enforcement or network claim is inferred from the engine name or requested spec.
Unknown and weak results remain unknown and weak. Verification is a snapshot and may become stale.

The writer adds `/env_docs/` to Git's local `info/exclude` without touching tracked `.gitignore`. This does not untrack
files already committed; already tracked documentation remains eligible for later commits and export. No repository
is required. The writer appends no extra guest measurements. Guest text and subprocess errors are not printed.

## Needs from the core

None beyond current `list`, `verify` and text `exec`. A future typed `workspace` field in the sandbox view would remove
the need for the explicit workspace action field. It must identify a path, not introduce a host mount.

Unit tests execute the writer in a temporary home/repository and feed simulated checklist JSON.

Checked live on 2026-11-11 in one sandbox on the default image, directly and through `asd ext run`: the document was
written to `~/workspace/env_docs/SANDBOX.md` with mode 0600 in a 0700 folder; in a Git workspace `/env_docs/` was added
to `.git/info/exclude` and `git status` stayed clean; a missing workspace and a symlinked `env_docs` were refused; a
stopped sandbox was refused and left stopped. Not checked live: a verify that exits 6, a sandbox that verification
stops, and a line-by-line comparison of the document with `asd verify` output.
