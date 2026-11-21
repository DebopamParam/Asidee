# Folders

Copies a folder of your home on this Mac into a running sandbox, such as `~/.agents` with its skills and plugins, or an
agent's own folder. Install it with `asd ext install folders` (or the dashboard's Install button); `asd ext remove
folders` takes it out again. It does not create, start or remove sandboxes. It copies into sandboxes on this Mac only:
with `--host` it is refused.

```sh
asd ext run folders copy NAME --set source=~/.agents                   # to ~/.agents in the sandbox
asd ext run folders copy NAME --set source=~/projects/hq/.agents --set dest=~/workspace/.agents
asd ext run folders list NAME
asd ext run folders remove NAME --set dest=~/.agents
asd create NAME --copy ~/.agents --copy ~/.claude:~/claude-settings    # the same copies right after the create
```

The folder must be in your home once its links are resolved, and not the home itself. It goes, by default, to the same
place under the sandbox user's home (`asd exec` runs as root in the built-in image, so `~/.agents` lands in
`/root/.agents`), or to `dest`: `~/…`, an absolute path, or a path under that home. In `--copy DIR:DEST`, DEST starts
at the first `:` followed by `~` or `/`.

Left out, and listed after the copy:

- **Login files**, anywhere in the folder, unless `logins` is set: `.credentials.json` (Claude) and `auth.json` (Codex,
  OpenCode), as the logins extension reads them; `hosts.yml` (GitHub), `.git-credentials`, `.netrc`, `.ssh`, `.aws`,
  `.gnupg`, `.claude.json` and `.mcp.json` (which can hold an account or server tokens), `*.pem`, `*.key`, `*.p12`,
  `*.pfx` and `.env*`. With `logins` set, anything in the sandbox can read them and send them out; the logins extension
  is the safer way to sign agents in.
- **History, sessions and caches**, always, but only directly inside an agent's own folder (`.claude`, `.claude-*`,
  `.codex`, `.codex-*` or `opencode`), where these names mean that. Chosen from the folders on a Mac on 2026-11-21:
  `history.jsonl`, `projects`, `file-history`, `paste-cache`, `shell-snapshots`, `session-env`, `sessions`, `todos`,
  `statsig`, `telemetry`, `cache`, `backups`, `debug`, `ide`, `jobs`, `daemon` and Claude's synced `policy-limits` and
  `remote-settings` files; `session_index.jsonl`, `archived_sessions`, `shell_snapshots`, `log`, `logs`, `tmp`,
  `sqlite`, `ipc`, the app-server and lock folders, `models_cache.json` and `.codex-global-state.json` (Codex); `storage`
  and `snapshot` (OpenCode); and any `*.sqlite`, `*.db` (with their `-shm`, `-wal` and `-journal` files) and `*.lock`.
  A `projects` or `sessions` folder elsewhere is copied.
- `.DS_Store`, without a mention.

A link that points inside the folder is copied as a link, so a plugin whose skills are linked from `.agents/skills`
works the same there. A link that points outside the folder, or by an absolute path, is not followed: it is skipped and
listed as "points outside the folder". Sockets and other special files are skipped too. Nothing is refused for size;
the dashboard's preview warns above 500 MB or 20000 entries (a `node_modules` folder, say).

This Mac packs exactly the listed paths with tar, and the sandbox unpacks them beside the destination first. A path
already there that Asidee did not copy stops the copy with nothing changed, unless `replace` is set. Copying the same
folder again updates it: changed files are replaced, and files an earlier copy put there that the folder no longer has
are removed. What each copy put there is recorded in `~/.asidee/copies/` in the sandbox; `list` shows the copies, and
`remove` deletes exactly those files and links and then the folders they leave empty, so anything else in the folder
stays. Anything running in the sandbox can read the copies.

Agents find these files only where they look for them. Checked live on 2026-11-18 with Claude Code 2.1.327, for the
skills extension this replaces: started in `~/workspace` it listed the skills imported into `~/workspace/.claude`;
started in a Git checkout below it, it did not. Claude Code's documentation puts personal skills in `~/.claude/skills`,
which would apply everywhere; that was not checked live. Skills marked `disable-model-invocation: true` are never listed to the model; type them as
`/NAME`. Codex was not checked.

The dashboard's Folders page picks the folder from quick picks (the agent folders that exist), a browser of your home's
folders, or by typing it, and shows a preview of what goes, what is left out and what is skipped before it runs. Unit
tests run the sandbox's half on this machine against a temporary home.
