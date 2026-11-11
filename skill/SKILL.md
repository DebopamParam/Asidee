---
name: paddock
description: Create, use, verify and remove Paddock sandboxes with the `paddock` CLI, and customize Paddock (extensions, dashboard, defaults) for the user. Use when a task needs an isolated place to run code or an agent, or when the user asks to change how their Paddock looks or behaves.
---

# Paddock

Paddock runs sandboxes for coding agents and checks each one against a fixed list. You work with it through the
`paddock` CLI only. Never run `docker` (or another engine command) against a Paddock sandbox, and never edit files under
`core/`: that is the part the user relies on staying the same.

## Operating sandboxes

Add `--json` to any command for `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`.

```sh
paddock doctor                              # engines and what each needs
paddock create NAME [--docker] [--image IMAGE] [--cpus N] [--memory GB] [--disk GB]
paddock list
paddock exec NAME [--stdin] -- COMMAND ARG… # exit code, stdout and stderr are the command's
paddock exec NAME --stream -- COMMAND ARG…  # raw bytes in and out, no size limit
paddock start NAME | paddock stop NAME
paddock forward add NAME --port P [--local-port L]  # 127.0.0.1:L here to 127.0.0.1:P in the sandbox
paddock forward list [NAME] | paddock forward remove ID
paddock ssh setup NAME [--write-config]     # then `ssh NAME.paddock`; ask the user before --write-config
paddock ssh access NAME                     # alias, user, home, and whether ssh would log in now
paddock verify NAME                         # exit 6 if a blocking check failed
paddock remove NAME --confirm NAME          # deletes everything in it; ask the user first
```

Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed.

- A name is lowercase letters, digits and hyphens.
- `exec` needs a running sandbox; it does not start one.
- If a check fails, report the check's title and detail to the user as they are. Do not work around it.
- A sandbox can be stopped without you asking: by a failed check, by the disk watch, because the daemon stopped, or
  by the engine when it passes its memory or task limit.
  `paddock list` shows the reason. Report it; start the sandbox again only if the reason is gone.
- Long operations print progress lines starting with `…` on stderr. Stdout stays the result.
- A sandbox has no host folders. Send a file in with `paddock exec NAME --stream -- sh -c 'cat > FILE' < local-file`,
  and read one out with `paddock exec NAME --stream -- cat FILE > local-file`. `--stream` carries any bytes of any size
  and keeps stderr apart. Without it, one exec returns at most 16 MiB on each of stdout and stderr; past that it fails
  with an error naming the limit and the command is ended.
- To run containers inside, create with `--docker` and the default image. Then use
  `paddock exec NAME -- docker run --rm alpine:latest echo inner-ok`. This private daemon adds exactly `NET_ADMIN`
  and `SYS_ADMIN` inside gVisor. Its containers use the sandbox's guarded network and share its outer limits.
  It uses copy-on-write `overlayfs` storage; `docker build` and `docker compose up` work. Images, containers and inner
  volumes count toward the watched disk limit and are deleted with the sandbox. Inner containers use the sandbox's
  public DNS fallback, **1.1.1.1 and 8.8.8.8**; the engine's own resolver refuses gVisor queries. The Docker check
  discloses this choice.
  Verify copies its probe image in from the engine (no registry) and removes it only if it was not there before; an
  image named like it with another ID makes the network checks unknown. Less than 64 MiB of disk headroom yields
  unknown network checks with a disk reason. Free space and verify again. Every sandbox's host log (what its main
  process prints) is outside the watched limit and rotates at 10 MiB with two files, checked by the core.
  Dockerd is the sandbox's main process. If it dies the sandbox stops; `paddock start NAME` starts it again.
  `paddock doctor` reports whether the engine supports inner Docker. An engine lacking the capability refuses it.
- To open a service that listens inside the sandbox, add a forward and use the `localPort` it reports; leave out
  `--local-port` to get a free one. It listens on this machine's 127.0.0.1 only, carries any bytes, and ends when it
  is removed, when the sandbox stops, restarts or is removed, and when the daemon stops; add it again after a restart.
  Any process on this machine can connect to it, and on OrbStack so can the engine's host and its other containers.
  Remove a forward when you are done with it.
- `paddock ssh setup NAME` is for editors and tools that speak SSH. It installs OpenSSH's server from the image's
  package manager when it has none (the sandbox needs internet for that), and opens no port. `ssh NAME.paddock` logs in
  as exec's user and allows `ssh -L` only to the sandbox's loopback. Running setup again makes a new host key. The
  `--write-config` flag changes the user's `~/.ssh/config` (one `Include` line at the top), so ask first. A stopped
  sandbox refuses SSH and is not started by it.

## Customizing Paddock

All customization lives in `~/.config/paddock/` (`$PADDOCK_CONFIG_DIR`). None of it can change what a sandbox is or what
`paddock verify` reports.

### Add an action or a hook: an extension

Create `~/.config/paddock/extensions/ID/extension.json`:

```json
{
  "name": "My tools",
  "actions": [{
    "id": "install-thing",
    "label": "Install thing",
    "scope": "sandbox",
    "fields": [{ "id": "version", "label": "Version", "type": "text", "default": "latest" }],
    "run": ["./install.sh"]
  }],
  "hooks": { "postCreate": ["./setup.sh"] }
}
```

- `run` and `postCreate` are commands as lists. A path starting with `./` is relative to the extension's folder. Make
  scripts executable.
- Field types: `text`, `number`, `checkbox`, `select` (with `options`). Add `"required": true` when needed.
- The command runs on the user's machine, not in the sandbox, with `PADDOCK_SANDBOX` (for `scope: "sandbox"`),
  `PADDOCK_FIELD_<ID>` for each field, and `paddock` on `PATH`. To act inside the sandbox, call
  `paddock exec "$PADDOCK_SANDBOX" -- …`.
- The dashboard shows each sandbox action as a form on running sandboxes; the CLI runs it with
  `paddock ext run EXTENSION ACTION SANDBOX --set FIELD=VALUE`. Check your work with `paddock ext list`, which also
  prints what is wrong with an extension that did not load.
- Because the command runs with the user's rights, tell the user what it does before installing it.

### Change the dashboard

Copy the built-in page (`ui/index.html` in the Paddock source) to `~/.config/paddock/ui/index.html` and edit the copy.
Other files in that folder are served next to it. The page calls `POST /api/METHOD` with a JSON body and the header
`Authorization: Bearer TOKEN`; it reads the token from the `#token=` part of the link `paddock ui` prints. Methods:
`checklist`, `engines`, `list`, `get`, `create`, `start`, `stop`, `remove`, `verify`, `exec`, `forwardAdd`, `forwardList`,
`forwardRemove`, `sshAccess`, `extensions`, `action`.

Keep showing each check's status and detail as the API returns them.

### Change defaults

`~/.config/paddock/config.json`: `{ "defaults": { "image": "docker/sandbox-templates:shell-docker", "cpus": 2, "memoryGb": 4, "diskGb": 20, "docker": false }, "engine": "gvisor:orbstack" }`.
The defaults obey the same limits as the flags. A mistake in this file makes `paddock create` fail with a message that
names it, so run a create after editing it.
`docker` accepts only JSON `true` or `false`; it defaults to `false`. With `true`, the image must include `docker`,
`dockerd` and `iptables-legacy`.

### Check your changes

After changing anything, run `paddock verify NAME` on a sandbox. If you changed Paddock's own source, run
`bun evals/run.ts` from it: it measures the claims Paddock makes from outside and prints which ones no longer hold.

## Import or remove logins

Use the bundled [logins extension](../extensions/logins/README.md), which calls only `paddock exec` and needs Node in an
already running sandbox. `bun extensions/logins/login.ts import NAME claude --profile work --setup` imports a selected
profile and its allowlisted setup; omit `--setup` for login only. Existing logins require `--replace` explicitly.
`login.ts github NAME --gh [--account ACCOUNT]` imports this machine's gh login. Without `--gh`, the direct terminal
command reads a token from stdin or a hidden prompt. Never put a token in argv, `--set`, a manifest, or logs.
There is no secret proxy in a gVisor container: the token lives inside it and code there can read and send it out.
Use `login.ts list NAME` and `login.ts logout NAME all` (or an agent and `--profile PROFILE`); the machine stays logged in.
Guest imported profiles use `CLAUDE_CONFIG_DIR="$HOME/.claude-PROFILE"` or `CODEX_HOME="$HOME/.codex-PROFILE"`.
File-profile and `gh` imports were checked live once; the Claude Keychain path was not. No eval covers extensions.

## What you cannot do, by design

Mount a host folder, publish a port, pick a non-isolated runtime, choose capabilities, or skip a check. If the user needs
one of these, say that Paddock does not offer it yet instead of reaching around Paddock.
