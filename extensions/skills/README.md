# Skills and plugins

Copies a host folder's agent skills, plugins, subagents and commands into a running sandbox, so agents there have the
same ones. Install it with `asd ext install skills` (or the dashboard's Install button); `asd ext remove skills` takes
it out again. It does not create, start or remove sandboxes.

```sh
asd ext run skills import NAME --set source=~/projects/hq        # into ~/workspace
asd ext run skills import NAME --set source=~/projects/hq --set instructions=true --set workspace=workspace/app
asd ext run skills remove NAME
asd create NAME --skills ~/projects/hq                           # the same import right after the create
```

Import copies only these paths of the folder, each one that exists: `.agents/skills`, `.agents/plugins`,
`.claude/skills`, `.claude/agents` and `.claude/commands`, plus `AGENTS.md` and `CLAUDE.md` when `instructions` is
set. Memory, settings, credentials and everything else stay on the host; `.DS_Store`, `.git`, `node_modules` and
`__pycache__` are skipped. Links are copied as links, so a vendored plugin whose skills are linked from
`.agents/skills` and `.claude/skills` works the same in the sandbox. Every link must be relative and point inside what
is copied, or nothing is copied and the error names the link. The limit is 256 MiB and 20000 entries.

The copy lands in the guest folder (`~/workspace` by default, or a path under the guest home or an absolute one). The
host packs it with tar and the guest unpacks it into a staging folder there, then moves each path into place. A path
that is already there is replaced only if an earlier import put it there (listed in `.asidee-imported`), or when
`replace` is set; otherwise nothing is changed and the error names the path. Remove deletes exactly the listed paths.
Anything running in the sandbox can read the copies. Run it after a clone into the same folder: a clone needs an empty
one, which is why `asd create` orders it after `--repo`.

Agents find these files only where they look for them. Checked live on 2026-11-18 with Claude Code 2.1.327: started in
`~/workspace` it listed the imported skills; started in `~/workspace/agent-pooling`, a Git checkout below it, it did
not. For a project in a subfolder, import into that folder (`workspace=workspace/PROJECT`); the copies are then
untracked files in its checkout. Skills marked `disable-model-invocation: true`, as most of pstack's are, are never
listed to the model; type them as `/NAME`. Codex was not checked.

Unit tests run the guest script on this machine against a temporary home.
