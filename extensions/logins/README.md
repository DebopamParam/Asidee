# Import logins into a sandbox

This bundled extension runs on your machine with Bun and calls only `paddock exec`. It needs an already running sandbox
with Node on PATH. GitHub import also needs `gh`, `git`, and HTTPS access to `api.github.com` inside the sandbox.
It does not create or start a sandbox, install tools, or change the core.

To install the actions, copy this folder to `$PADDOCK_CONFIG_DIR/extensions/logins` (normally
`~/.config/paddock/extensions/logins`), preserving the executable bit on `login.ts`. Run `paddock ext list` to check it.
An installed extension reads files and, for Claude on macOS, the login Keychain with your machine's rights.

```sh
# Run directly from the Paddock source, with paddock on PATH.
bun extensions/logins/login.ts profiles claude
bun extensions/logins/login.ts import demo claude --profile work --setup
bun extensions/logins/login.ts import demo codex --profile default --target personal
bun extensions/logins/login.ts github demo --gh --account octocat
bun extensions/logins/login.ts github demo          # hidden prompt, or a token piped on stdin
bun extensions/logins/login.ts list demo
bun extensions/logins/login.ts logout demo claude --profile work
bun extensions/logins/login.ts logout demo codex --profile '~'
bun extensions/logins/login.ts logout demo all

# After installation, the dashboard and extension CLI offer the same non-secret fields.
paddock ext run logins import demo --set agent=claude --set profile=work --set setup=true
paddock ext run logins github demo --set account=octocat
paddock ext run logins list demo
paddock ext run logins logout demo --set agent=all
```

`default` selects the host's canonical `~/.claude` or `~/.codex`. Other names select `~/.claude-PROFILE` or
`~/.codex-PROFILE`. Claude's Keychain entry takes precedence over a file on macOS, including the profile directory's
hashed service names. macOS may ask you to allow access. Credential files must be regular files under regular profile
directories; symlinked credential sources are refused. The credential must be a JSON object no larger than 1 MiB.

Imported logins live in the guest's `~/.claude-PROFILE` or `~/.codex-PROFILE`, including `-default` unless you choose a
different `--target`. Inside a guest shell, select a profile with `CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude` or
`CODEX_HOME="$HOME/.codex-personal" codex`. Configure an editor's agent home the same way. Plain `claude` and `codex`
continue to use their canonical directories. This extension does not change T3 Code settings or install profile launchers.
Every Claude import sets `env.ANTHROPIC_API_KEY` to an empty string in that profile's `settings.json`, as the
sandbox-manager reference did, so an API key in the guest environment does not take precedence over the imported
subscription login. Other `env` entries are kept.

An existing credential requires `--replace` or the action's **Replace an existing login** checkbox. Credentials travel
only on stdin to `paddock exec NAME --stdin -- …`. Guest writes use private temporary files and atomic publication with
mode 0600. New credentials use an exclusive hard link so a concurrent writer cannot silently replace one. Subprocess
output is withheld on errors. No token belongs in `--set`, an argument, an environment field, or an extension manifest.

## Copy the selected profile's setup

Setup copying is opt-in with `--setup` and overwrites matching guest setup files. The allowlist is:

- Claude's settings, keybindings, top-level Markdown, agents, commands, skills, output styles, and hooks.
- Codex's `config.toml`, top-level Markdown, prompts, and skills.
- Claude's onboarding, theme, editor, and account display state. Account display state also accompanies a login-only import.
- Regular home files named by Claude hook and status-line commands, plus ccstatusline settings when referenced.

Top-level setup symlinks, including a linked profile directory, are followed. Below those directories, file symlinks are
followed and directory symlinks are skipped. Plugins, history, transcripts, caches, and MCP definition files are excluded.
MCP server and plugin configuration keys are removed from parsed settings and TOML. So is every key, at any depth, whose
name looks like a secret (ending in `API_KEY` or `TOKEN`, or containing `SECRET`, `PASSWORD`, `CREDENTIAL`,
`ACCESS_KEY`, `PRIVATE_KEY`, `BEARER` or `COOKIE`, or named `Authorization` or `*headers`), such as
`env.ANTHROPIC_API_KEY` in Claude settings or a Codex provider's bearer token; the selected login is the only credential
meant to reach the guest. This is a name filter: a secret under another name, inside a hook command, a skill, a
Markdown file or a referenced home script is copied as is, so review those before using `--setup`. The sandbox-manager
reference copied these keys. TOML is re-serialized, so its comments and formatting are not preserved. Setup is limited to 16 MiB and 2000 files. UTF-8 setup files have literal host-home paths
rewritten to the guest home. Existing guest setup files absent from the bundle stay in place.

Missing hook or status-line executables and interpreter script paths are reported without executing the commands.
This is a static check of simple shell commands. Dynamic shell expressions, dependencies inside scripts, and commands
fetched at runtime are not verified. Setup writes are atomic per file, not one transaction. An I/O failure can leave a
partially copied setup or an imported login; list logins after a failure before retrying with `--replace`.

## Give the sandbox a GitHub login

Use a repository-limited fine-grained token when possible. Importing this machine's `gh` token can give the sandbox
everything that account can access. A pasted token is read from stdin or a hidden prompt, never from an argument.
The extension action imports only the host's `gh` login because the extension API has no private prompt or stdin field.
Use the direct terminal command for pasted tokens.

**There is no secret proxy in a gVisor container. The token lives inside the sandbox and code there can read it and send
it out.** Import checks the account through GitHub's HTTPS API, then atomically writes `gh`'s `hosts.yml` with mode 0600,
normally under `~/.config/gh`. Guest `GH_CONFIG_DIR` and `XDG_CONFIG_HOME` are respected when they point inside the guest
home. Other GitHub hosts in that file are preserved. Git over HTTPS uses the `gh auth git-credential` helper; no token
is placed in Git config. Guest `GH_TOKEN` or `GITHUB_TOKEN` variables can override a file-backed login.

## List and remove guest copies

Listing shows agent, profile, and the cached account when available. Codex accounts come from the ID token's email;
API-key logins are labeled **API key**. Claude's account comes from its selected profile's cached account state.
These are local descriptions, not proof that a token is still valid. Canonical guest profiles are listed as `~`.

Logout removes the guest's credential and Claude's cached account, preserving the rest of its setup. It requests
termination of matching Claude or Codex sessions under the same guest HOME and profile via Linux `/proc`. Other processes
may retain credentials in memory. GitHub logout removes the `github.com` section, preserving other hosts. It leaves the
Git helper installed. Logout never revokes tokens or logs this machine out.

Mutations hold the guest's empty `~/.paddock-logins.lock` directory. If a process is killed and leaves it behind, check
that no import or logout is running before removing that empty directory inside the guest and retrying.

The unit tests execute the receiver with temporary homes and fake transport, HTTPS, and host tools.

Checked live on 2026-11-11 in one sandbox on the default image, with the extension installed in a temporary
configuration directory. A stand-in `security` that always fails was placed first on PATH, so no Keychain was read:
- `profiles` listed this machine's file-backed Claude and Codex profiles. Importing one of each (Claude with `--setup`)
  and this machine's `gh` login, directly and through `paddock ext run`, worked. In the guest, each credential was mode
  0600 with the same SHA-256 as the host file, `gh auth status` succeeded, Git's helper was `!gh auth git-credential`
  with no token in Git config, and Claude's `settings.json` had an empty `env.ANTHROPIC_API_KEY`. `--setup` reported a
  hook command missing in the guest.
- A second import without `--replace` was refused; with it, it worked. A pasted token GitHub refused (HTTP 401) gives
  "GitHub did not accept that token" and leaves the guest's login as it was.
- `list` showed the three logins. Logout of one agent, of GitHub, and of `all` removed them, kept Claude's other setup,
  and `list` then showed none.
- While imports ran, `ps` on this machine was sampled about 200 times: no token appeared in any argument or environment.

Not checked live: the Claude Keychain path (no prompt may be triggered), ending a running agent session at logout (the
image has no Claude or Codex CLI), and whether an imported Claude or Codex login is accepted by its agent.
