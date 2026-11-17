# Repository clone and save

This independent bundled client runs inside `asd` on this machine. It needs Node and Git in an already running
sandbox, and host Git for saves. It does not create, start or remove sandboxes, publish ports, mount folders, or call
an engine.

Install it with `asd ext install repo` (or the dashboard's Install button) to expose clone and save in the dashboard
and the extension CLI; `asd ext remove repo` takes it out again.

```sh
asd ext run repo clone NAME --set repository=OWNER/REPO --set workspace=workspace
asd ext run repo save NAME --set workspace=workspace
asd ext run repo save NAME --set workspace=/workspace/repo --set branch=feature --set target=/absolute/host/repo.git

# From the Asidee source, for development, with Bun and asd on PATH.
bun extensions/repo/repo.ts clone NAME OWNER/REPO --workspace workspace
bun extensions/repo/repo.ts save NAME --workspace /workspace/repo --branch feature --target /absolute/host/repo.git
```

Clone accepts only `OWNER/REPO`, constructs an HTTPS GitHub URL without credentials, and requires a new guest checkout
path or an empty directory (the default image ships an empty `~/workspace`, the default path). If `gh auth status` succeeds inside the guest, the command-scoped `gh auth git-credential` helper supplies its
existing login. Without it, clone is anonymous. It never reads a host token, accepts a token argument, embeds one in
Git config, or prints Git/gh subprocess output. Use the logins extension first for private repositories. The token
remains readable by code in the guest and can leave over its internet connection. Login status does not establish
repository permissions or token validity for a clone. No proxy or ability to push to a protected branch is promised.

Save snapshots the selected committed branch, defaulting to the current branch. Detached HEAD requires `--branch`.
An empty/non-Git workspace has no committed branch and cannot be saved. A temporary ref pins its commit during bundle
creation, so a moving source branch cannot silently change the export. Only that commit and its reachable history
cross the boundary; dirty files, index changes, untracked files, other branches and tags are excluded. **Secrets that
were committed in that history are included.** This is source selection, not secret scanning. Nothing is pushed.

The guest creates a Git bundle and writes one JSON header line (branch, tip, ref, size, SHA-256) followed by the raw
bundle to `asd exec --stream` stdout, which carries bytes unchanged. The client rejects a malformed header,
size/checksum mismatches and unexpected advertised refs, runs Git bundle
verification and object checks, and fetches into a unique `saved/NAME/UUID` branch. It never checks out guest files,
updates existing branches, changes a host worktree, or executes repository hooks. Committed history remains untrusted
input to host Git, so use a maintained Git installation before reviewing it. Before host Git reads anything, the client
parses the bundle itself: one advertised ref and no prerequisites, a pack whose trailer checksum matches, at most 10000
objects, each object at most 32 MiB inflated and all of them at most 128 MiB inflated (delta results counted). Git then
indexes the pack with `--strict` in a private temporary repository before the fetch. These bound what Git inflates,
not Git's CPU time.

The default destination is a bare repository at `$XDG_STATE_HOME/asidee-repo/NAME.git`, or
`~/.local/state/asidee-repo/NAME.git`. An explicit `--target` can be an existing bare or working clone; a missing target
is initialized as bare. Existing targets must be repository roots, not subdirectories of another repository.
No host-to-guest mount exists. Target directories and parents must not be symlinks; on macOS `/tmp` and `/var` are
symlinks, so use `/private/tmp` there. The same applies to `XDG_STATE_HOME` for the default destination, including the
one the daemon was started with when the action runs through `asd ext run`. Source and
export temporary files/refs are removed on normal completion or failure. Killing a process can leave temporary refs
or files. A failed import may leave an empty bare destination or Git objects; no existing host branch is overwritten.

## Needs from the core

Clone uses text exec. Save uses `asd exec NAME --stream`, the binary-safe session with separate stderr and the
guest's exit status. This implementation imposes a **128 MiB maximum binary bundle size**, which matches the bundle
parser's 128 MiB inflated limit. The guest checks the file size before sending and exits 73 for an oversized export;
it never truncates or splits one. The client reads at most the header and 128 MiB of stdout, discards stderr, and
holds the bundle in memory for the checks above. Bundle creation itself can still use guest disk, memory and CPU before
that check. A raw SHA-256 checksum detects corruption, not a dishonest guest.

Unit tests use a fake exec runner and stream, temporary homes and real local Git repositories to prove binary committed
contents round-trip (including a 24 MiB random history, beyond text exec's 16 MiB) and dirty/index/untracked/other-branch
data do not cross.

Checked live on 2026-11-11 in one sandbox on the default image with public repositories, directly and through
`asd ext run`: clone worked with the guest's GitHub login and anonymously after logout, and refused an existing
path and a URL. Save to the default destination, to a new `--target` and to an existing working clone each added one
`saved/bx/UUID` branch with the committed tip; the working clone's checked-out branch and files did not change. The
saved tree held only committed files: a modified tracked file, a staged file and an untracked file did not cross. The
guest kept no `refs/asidee-export` ref or bundle file. Detached HEAD was refused without `--branch` and saved with it.
An empty workspace, a relative target, a subfolder of a repository and a target under a symlink were refused. Through
the stream (Asidee 0.4.0, Alpine guest with apk Node and Git), a commit with 100 MiB of random data in four files saved
whole in about 11 s (same blob IDs on both sides); with 150 MiB the guest exited 73, no target was created, and no
export ref or bundle file stayed in the guest. Not checked live: private repositories and exports killed midway.
