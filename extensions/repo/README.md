# Repository clone and save

This independent bundled client requires Bun and `paddock` on this machine, Node and Git in an already running sandbox,
and host Git for saves. It does not create, start or remove sandboxes, publish ports, mount folders, or call an engine.

```sh
bun extensions/repo/repo.ts clone NAME OWNER/REPO --workspace workspace
bun extensions/repo/repo.ts save NAME --workspace workspace
bun extensions/repo/repo.ts save NAME --workspace /workspace/repo --branch feature --target /absolute/host/repo.git
```

Copy the complete folder to `$PADDOCK_CONFIG_DIR/extensions/repo` (normally `~/.config/paddock/extensions/repo`), preserving
the executable bit on `repo.ts`, to expose clone/save in the dashboard. For example,
`paddock ext run repo clone NAME --set repository=OWNER/REPO`, then `paddock ext run repo save NAME`.

Clone accepts only `OWNER/REPO`, constructs an HTTPS GitHub URL without credentials, and requires a new guest checkout
path. If `gh auth status` succeeds inside the guest, the command-scoped `gh auth git-credential` helper supplies its
existing login. Without it, clone is anonymous. It never reads a host token, accepts a token argument, embeds one in
Git config, or prints Git/gh subprocess output. Use the logins extension first for private repositories. The token
remains readable by code in the guest and can leave over its internet connection. Login status does not establish
repository permissions or token validity for a clone. No proxy or ability to push to a protected branch is promised.

Save snapshots the selected committed branch, defaulting to the current branch. Detached HEAD requires `--branch`.
An empty/non-Git workspace has no committed branch and cannot be saved. A temporary ref pins its commit during bundle
creation, so a moving source branch cannot silently change the export. Only that commit and its reachable history
cross the boundary; dirty files, index changes, untracked files, other branches and tags are excluded. **Secrets that
were committed in that history are included.** This is source selection, not secret scanning. Nothing is pushed.

The guest creates a Git bundle and sends a JSON envelope containing its size, SHA-256 and base64 through `paddock exec`
stdout. Base64 is necessary because the current API decodes stdin/stdout as text; raw binary would corrupt Git objects.
The client rejects noncanonical base64, size/checksum mismatches and unexpected advertised refs, runs Git bundle
verification and object checks, and fetches into a unique `saved/NAME/UUID` branch. It never checks out guest files,
updates existing branches, changes a host worktree, or executes repository hooks. Committed history remains untrusted
input to host Git, so use a maintained Git installation before reviewing it. Before host Git reads anything, the client
parses the bundle itself: one advertised ref and no prerequisites, a pack whose trailer checksum matches, at most 10000
objects, each object at most 32 MiB inflated and all of them at most 128 MiB inflated (delta results counted). Git then
indexes the pack with `--strict` in a private temporary repository before the fetch. These bound what Git inflates,
not Git's CPU time.

The default destination is a bare repository at `$XDG_STATE_HOME/paddock-repo/NAME.git`, or
`~/.local/state/paddock-repo/NAME.git`. An explicit `--target` can be an existing bare or working clone; a missing target
is initialized as bare. Existing targets must be repository roots, not subdirectories of another repository.
No host-to-guest mount exists. Target directories and parents must not be symlinks; on macOS `/tmp` and `/var` are
symlinks, so use `/private/tmp` there. The same applies to `XDG_STATE_HOME` for the default destination, including the
one the daemon was started with when the action runs through `paddock ext run`. Source and
export temporary files/refs are removed on normal completion or failure. Killing a process can leave temporary refs
or files. A failed import may leave an empty bare destination or Git objects; no existing host branch is overwritten.

## Needs from the core

Text exec buffers input and output in the provider, daemon, CLI and client. The core returns at most 16 MiB per output
stream from one exec and refuses more with an error that names the limit, never a cut-off result. This implementation
imposes an **8 MiB maximum binary bundle size**, about **10.67 MiB base64** plus JSON, which fits under that limit. It
checks the file size in the guest before encoding; oversized exports fail, never truncate, and are not split to evade a
transport limit. Bundle creation itself can still use guest disk, memory and CPU before that check. The client
separately caps each subprocess output stream at 16 MiB. A raw SHA-256 checksum detects corruption, not a dishonest
guest.

Larger repositories require a binary-safe, bounded streaming API, for example
`execStream({name, argv: string[], user?: string}, stdin: AsyncIterable<Uint8Array>) ->
{stdout: AsyncIterable<Uint8Array>, stderr: AsyncIterable<Uint8Array>, exit: Promise<{code: number}>, cancel(): void}`,
with backpressure, cancellation, a distinct exit status, and no UTF-8 decoding or JSON buffering of data chunks.
The CLI equivalent should be `paddock exec NAME --binary-stdin --binary-stdout -- COMMAND...`, keeping stderr separate.
This client does not implement or simulate that API. A future sandbox-view workspace field could supply the checkout
path; today it is an explicit client argument. No core changes are otherwise needed for bounded exports.

Unit tests use a fake exec runner, temporary homes and real local Git repositories to prove binary committed contents
round-trip and dirty/index/untracked/other-branch data do not cross.

Checked live on 2026-11-11 in one sandbox on the default image with public repositories, directly and through
`paddock ext run`: clone worked with the guest's GitHub login and anonymously after logout, and refused an existing
path and a URL. Save to the default destination, to a new `--target` and to an existing working clone each added one
`saved/bx/UUID` branch with the committed tip; the working clone's checked-out branch and files did not change. The
saved tree held only committed files: a modified tracked file, a staged file and an untracked file did not cross. The
guest kept no `refs/paddock-export` ref or bundle file. Detached HEAD was refused without `--branch` and saved with it.
An empty workspace, a relative target, a subfolder of a repository and a target under a symlink were refused. A
commit with 7.5 MiB of random data saved whole (same blob ID on both sides); one with 9 MiB was refused. Not checked
live: private repositories and exports killed midway.
