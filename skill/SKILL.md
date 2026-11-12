---
name: paddock
description: Create, use, verify and remove Paddock sandboxes or macOS workspaces with the CLI, and customize Paddock for the user. Workspaces are not sandboxes. Use when a task needs an isolated sandbox, a disposable Mac workspace with GPU access, or a change to Paddock's clients.
---

# Paddock

Paddock runs sandboxes for coding agents and checks each one against a fixed list. You work with it through the
`paddock` CLI only. Never run `docker` (or another engine command) against a Paddock sandbox, and never edit files under
`core/`: that is the part the user relies on staying the same.

## Operating sandboxes

Add `--json` to any command for `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`.

```sh
paddock doctor                              # engines and what each needs
paddock create NAME [--docker] [--image IMAGE | --template TEMPLATE] [--cpus N] [--memory GB] [--pids N] [--disk GB]
paddock list
paddock exec NAME [--stdin] -- COMMAND ARG… # exit code, stdout and stderr are the command's
paddock exec NAME --stream -- COMMAND ARG…  # raw bytes in and out, no size limit
paddock start NAME | paddock stop NAME
paddock forward add NAME --port P [--local-port L]  # 127.0.0.1:L here to 127.0.0.1:P in the sandbox
paddock forward list [NAME] | paddock forward remove ID
paddock ssh setup NAME [--write-config]     # then `ssh NAME.paddock`; ask the user before --write-config
paddock ssh access NAME                     # alias, user, home, and whether ssh would log in now
paddock verify NAME                         # exit 6 if a blocking check failed
paddock resize NAME [--cpus N] [--memory GB] [--pids N] [--disk GB]  # says what applies now, what at the next start
paddock snapshot NAME --as TEMPLATE         # saves its files as a template; read what it says is inside
paddock template list | paddock template remove TEMPLATE
paddock remove NAME --confirm NAME          # deletes everything in it; ask the user first
```

Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed, 7 unreachable, 8 incompatible, 9 identity changed, 10 outcome unknown.

Prepared remote daemons can be attached with `paddock host attach NAME --ssh DEST --binary PATH --state-dir PATH`.
This installs nothing. `paddock host list` refreshes their availability. Add `--host NAME` to buffered sandbox commands
to select that daemon; names without it always mean local. `paddock list --all` shows each machine, keeping stale
sandboxes and checks unknown. An unreachable host is not an empty successful list. A version, protocol, source or
identity mismatch is a failure (exit 8 or 9): the message says how to build and replace the other machine's binary;
ask the user before doing it, and never retry a mutation automatically. A `hosts.json` record shown as
`unknown-record` was written by another Paddock or is damaged; only it is refused. Exit 10 means reconcile with a read and
the user before another mutation. `--host NAME` also selects streamed exec, shell, loopback forwards and SSH setup.
Remote aliases are `SANDBOX.HOST.paddock`; their private editor key stays on the primary. A hosted forward listens
on the primary's 127.0.0.1 and closes when its sandbox run, either daemon or the SSH control stream ends. Each side
ends it after fifteen seconds without the other's heartbeat; it never reconnects or recreates itself. Its evidence is
`paddock --host NAME forward list` on the primary, not a check. Add a new forward explicitly after link loss.
`paddock host add NAME --ssh DEST --artifact PATH --sha256 HASH --json` produces a read-only installation plan. Build the
Linux artifact explicitly from the same source as the primary. Review every sudo vector and what it leaves, file diff,
artifact and package checksum, service, watched disk choice, Docker restart victim and sandbox a Paddock service restart
stops. `--json` never applies. Interactive enrollment needs
the word `yes`; automation needs `--accept-plan HASH`. A revised plan requires new consent. Interactive sudo uses the
primary's private terminal stream; never put a password in an API body, plan or log. Automation needs noninteractive
sudo. Registration follows verified artifacts, enabled system service inspection, isolation/disk smoke checks and cleanup.
Ctrl-C during verification requests cancellation; wait for cleanup and exit 130. Completed installation changes remain,
and no host is registered (N13). The installed runtime has watched disks. Its sandboxes can run Docker inside only when
the host is enrolled with `host add --docker`, which registers gVisor's raw sockets and shows that in the plan. Hard
disk helpers and disk tools are not installed.
`--sudo never` can reuse a verified enabled system service in the enrolled layout, and otherwise refuses unattended
installation. Do not install a user unit or infer reboot behavior from lingering. See [Enroll a Linux host](../docs/host-enrollment.md)
for build commands, preparation, failure journals and manual uninstall. A refusal or failure must leave this enrollment
unregistered and report any completed changes. Do not roll back shared packages or overwrite newer unrelated config.
`paddock host remove NAME --confirm NAME` forgets primary resources and leaves remote files and services intact. Group M
needs `PADDOCK_EVAL_HOST`; installation evals additionally require explicit disposable `pdk-enroll-*@orb` fixtures. Never
run installer, restart or privileged evals on an owner's engine. Read the scorecards for measured results. Reboot
persistence and automatic sandbox recovery are not measured.

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
- `paddock resize` reports, for each limit, `now` (read back from the engine's host), `next start` or `unchanged`.
  Inside, gVisor does not show the new limits (`/proc/meminfo` keeps the old memory, `nproc` ignores the CPU limit);
  trust resize's report, not those. Lowering
  memory or tasks to within 10% of what the sandbox uses, or the disk limit below what it uses, is refused with exit 4.
- A template holds every file of the sandbox it was saved from, home folders included: shell history, `.env` files and
  tokens other than the usual login files. Only the usual login files and Paddock's own files are removed. Before you
  snapshot a sandbox the user did not ask you to, or hand a template to anyone, tell the user this. Volumes are not
  saved, so a `--docker` sandbox's inner images are not in its template. Removing a template does not affect the
  sandboxes made from it.
- To open a service that listens inside the sandbox, add a forward and use the `localPort` it reports; leave out
  `--local-port` to get a free one. It listens on this machine's 127.0.0.1 only, carries any bytes, and ends when it
  is removed, when the sandbox stops, restarts or is removed, and when the daemon stops; add it again after a restart.
  Any process on this machine can connect to it. On OrbStack, `host.docker.internal` relays to this machine's
  loopback, so the engine host and ordinary containers can reach the forward too. Guarded sandboxes cannot.
  Remove a forward when you are done with it.
  A closed connection ends its relay process. A client that only finishes sending (FIN) keeps the relay while the
  port answers; after ten minutes of silence the relay is ended.
- `paddock ssh setup NAME` is for editors and tools that speak SSH. It installs OpenSSH's server from the image's
  package manager when it has none (the sandbox needs internet for that), and opens no port. `ssh NAME.paddock` logs in
  as exec's user and allows `ssh -L` only to the sandbox's loopback. Running setup again makes a new host key. The
  `--write-config` flag changes the user's `~/.ssh/config` (one `Include` line at the top), so ask first. A stopped
  sandbox refuses SSH and is not started by it.

## Operating macOS workspaces

A workspace is **not a sandbox**. Use it when the user chooses direct Mac execution and GPU access. Never substitute
one for an isolated sandbox without the user's choice. Read [macOS workspaces](../docs/workspaces.md) for measured
coverage and limits.

```sh
paddock workspace create NAME --copy /absolute/project [--read PATH] [--path DIR] [--no-logins]
paddock workspace create NAME --claude-profile work --codex-profile work
paddock workspace shell NAME
paddock workspace exec NAME [--stdin | --stream] -- COMMAND ARG…
paddock workspace list
paddock workspace verify NAME
paddock workspace stop NAME
paddock workspace remove NAME --confirm NAME
```

The folder is `~/Paddock/NAME`. `--copy` brings a separate copy into `work`; removing it never removes the original.
Only processes started through workspace shell/exec acquire the profile. Entering the folder through another shell
does not confine anything. Copy out wanted files before confirmed removal. A stop does not delete files and a later
exec can run again. Use the CLI to stop and remove; never signal PIDs from an environment marker or delete the folder
before its processes have been identified and ended.

Always describe it as a workspace, not a sandbox. It has the same kernel and user, no resource limits, open internet,
LAN, tailnet and loopback, and open reads outside home. Current listeners appear in create/verify; later listeners
are reachable too. There is no declared-ports option. `--read ~/.ssh`, workspace/state/home ancestors and shared temp
allowances are refused. Writes and installs outside the folder remain refused, including Docker and nix sockets.

Creation imports `default` profiles unless the user selects named profiles. `--claude-profile work` reads
`~/.claude-work`; `--codex-profile work` reads `~/.codex-work`. `--no-logins` reads/imports no logins. Daemon environment
variables do not select sources. Claude uses the sandbox importer's shared Keychain reader, with a 15-second timeout;
macOS may prompt. A denied or timed-out read stays not imported. Claude credential and onboarding/account state are
private files inside. Product-path `claude auth status` reported logged in; authenticated calls and refresh remain
unverified. Never log tokens or call a recognised file verified authentication. Paddock passes no flags to change an
agent's inner sandbox. Describe failures and let the user choose the agent's configuration.

Summary is read-only and does not walk workspace trees. Only explicit list/get requests measure size. Launch runs
blocking checks only. Informational probes, including the available hardware-only VideoToolbox encode, run on create
and verify. Verify leaves unreadable directories unchanged and reports an unknown hard-link result; remove repairs
permissions. Do not treat the media encode check as a Metal-compute measurement.

Remove reports multiple hard links, LaunchServices and launchd references and things it cannot undo. Remote effects,
unified logs, existing backups and changes through outside hard links can remain. Apple events, TCC capabilities,
camera/microphone capture, Keychain additions, Spotlight retention and unnamed channels are not covered. Never promise
that removing a workspace erases every trace from this Mac or the network.

`nix develop -c bun evals/run.ts --only K --write` runs only the workspace suite with independent temporary state and
engine providers disabled. It always includes K15 before lifecycle checks and writes only `SCORECARD.workspace.md`.
The full sandbox scorecards require their own full runs. Test roots stay inside the checkout's ignored `dist/` while
still being validated as inside the account's real home. No test creates an owner's `~/Paddock` workspace.

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
`checklist`, `engines`, `list`, `get`, `create`, `start`, `stop`, `remove`, `verify`, `resize`, `snapshot`, `templateList`,
`templateRemove`, `exec`, `forwardAdd`, `forwardList`, `forwardRemove`, `sshAccess`, `extensions`, `action`, `summary`,
`hostList`, `fleet`.

Requests can include `host` to select a registered machine. A sandbox's API address is `{host, name}` and its returned
identity is `{machineId, sandboxId}`. Supply `machineId` too when acting on a previously selected machine: any routed
request whose `machineId` is not that host's is refused before a connection is opened. Remote text (check details,
stop reasons, errors) is untrusted; show it as text, never as HTML. Session,
shutdown and host changes remain socket-only even when routed; the dashboard token does not authorize them.

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
File-profile and `gh` sandbox imports were checked live once; the Claude Keychain guest path was not. Workspaces
separately measure the shared Keychain reader and Claude recognition. Extension unit tests run actual guest programs
against temporary homes; core sandbox evals do not cover extensions. Missing setup commands are named
only for settings sent, with bounded printable names and credential values withheld.

The engine measurements are in `evals/SCORECARD.md` and `evals/SCORECARD.linux.md`. Docker Desktop, Colima, Windows
execution, a hard disk cap and reboot recovery remain unmeasured or unbuilt as those files state. Enrollment is measured
only on the disposable Linux combinations named by the N evals.

## What you cannot do, by design

Mount a host folder, publish a port, pick a non-isolated runtime, choose capabilities, or skip a check. If the user needs
one of these, say that Paddock does not offer it yet instead of reaching around Paddock.
