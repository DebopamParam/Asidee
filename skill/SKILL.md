---
name: asidee
description: Create, use, verify and remove Asidee sandboxes or macOS workspaces with the CLI, and customize Asidee for the user. Workspaces are not sandboxes. Use when a task needs an isolated sandbox, a disposable Mac workspace with GPU access, or a change to Asidee's clients.
---

# Asidee

Asidee runs sandboxes for coding agents and checks each one against a fixed list. You work with it through the
`asd` CLI only. Never run `docker` (or another engine command) against an Asidee sandbox, and never edit files under
`core/`: that is the part the user relies on staying the same.

## Operating sandboxes

Add `--json` to any command for `{"ok":true,"data":…}` or `{"ok":false,"error":{"code","message"}}`.

```sh
asd setup [--docker]                    # macOS, once: give OrbStack gVisor after a plan the user approves; sets it as the default engine if none is
asd doctor                              # whether an engine is ready, and what it needs
asd create NAME [--docker] [--image IMAGE | --template TEMPLATE] [--cpus N] [--memory GB] [--pids N] [--disk GB]
asd create NAME --gh --claude PROFILE --codex PROFILE --repo OWNER/REPO --t3  # then logins, clone, T3; this Mac only
asd create --retry NAME                 # finish a create whose checks or a setup step failed; unfinished ones go after 30 minutes
asd create --keep NAME                  # keep an unfinished create as it is instead
asd claude NAME [PROFILE] [-- ARG…]   # Claude Code in ~/workspace with an imported login; also asd codex
asd list
asd config get                         # effective settings on the selected machine
asd config set require-probes on|off    # require blocking isolation probes at create, default on
asd config set experimental on|off      # other machines (host, --host, list --all), default off
asd config set workspace-free-space GiB  # below this, workspace launches are refused and running ones stopped, default 5
asd config set disk-watch SECONDS       # pause between two measurements of a watched disk limit, default 5, 1 to 30
asd config set engine ID|auto           # engine for new sandboxes (auto: the first ready one)
asd config set default-cpus N|auto      # also default-image, default-memory, default-pids, default-disk, default-docker on|off
asd config set default-template T|auto  # new sandboxes start from template T unless a create names an image or template
asd config set terminal NAME            # the dashboard's Terminal button: default, terminal, ghostty, iterm or custom
asd config set terminal-command CMD|none  # custom terminal, e.g. 'kitty sh -c {command}'; the dashboard asks on the Mac
asd exec NAME [--stdin] -- COMMAND ARG… # exit code, stdout and stderr are the command's; output as text
asd exec NAME --stream -- COMMAND ARG…  # raw bytes in and out, no size limit
asd start NAME | asd stop NAME
asd forward add NAME --port P [--local-port L]  # 127.0.0.1:L here to 127.0.0.1:P in the sandbox
asd forward list [NAME] | asd forward remove ID
asd link add FROM TO --port P            # programs in FROM connect to TO:P, reaching P on TO's loopback only
asd link list [NAME] | asd link remove FROM TO --port P
asd ssh setup NAME [--write-config]     # then `ssh NAME.asidee`; ask the user before --write-config
asd ssh access NAME                     # alias, user, home, and whether ssh would log in now
asd verify NAME                         # exit 6 if a blocking check failed; stopped sandboxes check configuration only
asd resize NAME [--cpus N] [--memory GB] [--pids N] [--disk GB]  # says what applies now, what at the next start
asd snapshot NAME --as TEMPLATE         # saves its files as a template; read what it says is inside
asd template list | asd template remove TEMPLATE
asd template prepare [TEMPLATE] [--script FILE] [--replace] [--default]  # agent template (default name agent); also the dashboard's Templates tab
asd remove NAME --confirm NAME          # deletes everything in it; ask the user first
```

Text output of `create` and `resize` counts the checks that held and prints every other check in full; read
`--json` or run `verify` for each check. Every command takes `--help`.
Piped input is sent only with `--stdin` or `--stream`, for both sandbox and workspace exec.
`doctor` exits 5 if no engine is ready. A stopped sandbox can pass configuration checks with exit 0;
start it with `asd start NAME`, then run `asd verify NAME` to check the rest.
`list` shows the disk limit and how long ago verification ran. Its results are history.
Verify JSON includes `configurationOnly`; a runtime failure that stops a running sandbox is still a runtime check.
Ctrl-C during buffered create, workspace create, resize or snapshot exits 130. The daemon keeps finishing the work.
The CLI says where the result will appear and, for a create, the exact remove command. An image the engine cannot pull is a missing dependency (exit 5);
the error names the image and the engine's reason. Doctor's manual gVisor recipe includes `--net-raw` for Docker inside.

Exit codes: 0 ok, 1 runtime, 2 usage, 3 not found, 4 conflict, 5 missing dependency, 6 a check failed or required probes could not run, 7 unreachable, 8 incompatible, 9 identity changed, 10 outcome unknown.

Other machines are experimental and off by default; while off, `host` commands, `--host NAME` and `list --all` exit 5
with a sentence naming `asd config set experimental on`. Ask the user before turning it on. With it on, prepared
remote daemons can be attached with `asd host attach NAME --ssh DEST --binary PATH --state-dir PATH`.
This installs nothing. `asd host list` refreshes their availability. Add `--host NAME` to buffered sandbox commands
to select that daemon; names without it always mean local. `asd list --all` shows each machine, keeping stale
sandboxes and checks unknown. An unreachable host is not an empty successful list. A version, protocol, source or
identity mismatch is a failure (exit 8 or 9): the message says how to build and replace the other machine's binary;
ask the user before doing it, and never retry a mutation automatically. A `hosts.json` record shown as
`unknown-record` was written by another Asidee or is damaged; only it is refused. Exit 10 means reconcile with a read and
the user before another mutation. `--host NAME` also selects streamed exec, shell, loopback forwards and SSH setup.
Remote aliases are `SANDBOX.HOST.asidee`; their private editor key stays on the primary. A hosted forward listens
on the primary's 127.0.0.1 and closes when its sandbox run, either daemon or the SSH control stream ends. Each side
ends it after fifteen seconds without the other's heartbeat; it never reconnects or recreates itself. Its evidence is
`asd --host NAME forward list` on the primary, not a check. Add a new forward explicitly after link loss.
Sandboxes are private or public. One created on its own machine is private; one created with `--host` is public;
older ones are public. `--host` never shows or acts on a private sandbox: lists leave it out, and a call on it fails
(exit 3) saying it is private on its machine. `asd share NAME` / `asd unshare NAME` change it on that machine only;
from another machine you can only make a public one private. A `--host NAME create` fails (exit 2) until that machine
ran `asd config set remote-create on`, which only it can do; ask the user. Private keeps a sandbox from other machines.
Anyone signed in to that machine's own account can still see it.
`asd host add NAME --ssh DEST --artifact PATH --sha256 HASH --json` produces a read-only install or update plan. For an enrolled machine, use the same command with the new artifact;
keep `--docker` to retain inner Docker. Do not remove its registration first. An update refuses changed daemon identity,
SSH public key or state directory, covers the existing record in consent, and preserves that record on failure. Build the
Linux artifact explicitly from the same source as the primary. Review every sudo vector and what it leaves, file diff,
artifact and package checksum, service, watched disk choice, Docker restart victim and sandbox an Asidee service restart
stops. `--json` never applies. Interactive enrollment needs
the word `yes`; automation needs `--accept-plan HASH`. A revised plan requires new consent. Interactive sudo uses the
primary's private terminal stream; never put a password in an API body, plan or log. Automation needs noninteractive
sudo. Interactive installs refresh `sudo -v` before every privileged step. Staging uses destination `mkdtemp` directories
and `mkstemp` request files, so leftovers cannot block retry. Apply reports the stage path; the plan uses
`@ASIDEE_STAGE@` and `@ASIDEE_REQUEST@` placeholders. Each root step copies its inputs into a root-owned private
directory, checks SHA-256 there and uses only that copy. The script and digests are in the plan hash.
An interactive request file is checked against a digest sent separately through the SSH command.
Source URLs omit usernames and passwords; the plan binds original source bytes by their hashes. Registration follows verified artifacts, enabled system service inspection, isolation/disk smoke checks and cleanup. The smoke sandbox has no links, so its `link-scope` must be `info`, not a claimed measurement.
Ctrl-C during verification requests cancellation; wait for cleanup and exit 130. Completed installation changes remain,
and no new registration is written (N13). An update keeps its existing registration. The installed runtime has watched disks. Its sandboxes can run Docker inside only when
the host is enrolled with `host add --docker`, which registers gVisor's raw sockets and shows that in the plan. Hard
disk helpers and disk tools are not installed.
`--sudo never` can reuse a verified enabled system service in the enrolled layout, and otherwise refuses unattended
installation. Do not install a user unit or infer reboot behavior from lingering. See [Enroll a Linux host](../docs/host-enrollment.md)
for build commands, preparation, failure journals and manual uninstall. A failed first enrollment stays unregistered; a failed update retains its existing record and names the command for
reviewing a retry. A healthy daemon built from the primary's source remains reachable through the retained record.
A source mismatch in `host list` names `host add` to update it. Verification failures name the failed call. Report completed changes. Do not roll back shared packages or overwrite newer unrelated config.
`asd host remove NAME --confirm NAME` forgets primary resources and leaves remote files and services intact. Group M
needs `ASIDEE_EVAL_HOST`; installation evals additionally require explicit disposable `asd-enroll-*@orb` fixtures. Never
run installer, restart or privileged evals on an owner's engine. Read the scorecards for measured results. Reboot
persistence and automatic sandbox recovery are not measured.

- A name is lowercase letters, digits and hyphens.
- `exec` needs a running sandbox; it does not start one.
- Create requires blocking isolation probes by default. If one is unknown, create returns `probes-required` (exit 6),
  names the probe and why it could not run, and keeps the sandbox stopped for diagnosis. The dashboard's **Open settings**
  button focuses **Require isolation probes** without changing it. `asd config set require-probes off` allows future
  creates with unknown probes; those sandboxes show as **Not verified**, with historical checks disclosed as unknown.
  Failed or unsupported blocking probes still block. Settings persist without a daemon restart and apply per machine.
  With `--host NAME`, that daemon uses its own config. Explicit verify never stops a running sandbox for an unknown
  probe, start runs no probes, and the enforcement budget remains four passes.
- If a check fails, report the check's title and detail to the user as they are. Do not work around it.
- A sandbox can be stopped without you asking: by a failed check, by the disk watch, because the daemon stopped, or
  by the engine when it passes its memory or task limit.
  `asd list` shows the reason. Report it; start the sandbox again only if the reason is gone.
- Long operations print progress lines starting with `…` on stderr. Stdout stays the result.
- A sandbox has no host folders. Send a file in with `asd exec NAME --stream -- sh -c 'cat > FILE' < local-file`,
  and read one out with `asd exec NAME --stream -- cat FILE > local-file`. `--stream` carries any bytes of any size
  and keeps stderr apart. Without it, one exec returns at most 16 MiB on each of stdout and stderr; past that it fails
  with an error naming the limit and the command is ended. A buffered exec waits for its command however long it runs
  (one routed to another machine gives up after 45 minutes, with its outcome unknown).
- To run containers inside, create with `--docker` and the default image. Then use
  `asd exec NAME -- docker run --rm alpine:latest echo inner-ok`. This private daemon adds exactly `NET_ADMIN`
  and `SYS_ADMIN` inside gVisor. Its containers use the sandbox's guarded network and share its outer limits.
  It uses copy-on-write `overlayfs` storage; `docker build` and `docker compose up` work. Images, containers and inner
  volumes count toward the watched disk limit and are deleted with the sandbox. Inner containers use the sandbox's
  public DNS fallback, **1.1.1.1 and 8.8.8.8**; the engine's own resolver refuses gVisor queries. The Docker check
  discloses this choice.
  Verify copies its probe image in from the engine (no registry) and removes it only if it was not there before; an
  image named like it with another ID makes the network checks unknown. Less than 64 MiB of disk headroom yields
  unknown network checks with a disk reason. Free space and verify again. Every sandbox's host log (what its main
  process prints) is outside the watched limit and rotates at 10 MiB with two files, checked by the core.
  Asidee's BusyBox shell is PID 1 and reaps orphaned processes, with dockerd as its child. It forwards stop signals
  to dockerd and exits when dockerd dies, so the sandbox stops; `asd start NAME` starts it again.
  Docker sandboxes created before this change keep dockerd as PID 1 and leave finished orphans as zombies holding
  task slots until restart. Recreate them to gain the reaper. Older sandboxes without Docker that still use `sleep`
  as PID 1 also need recreation. A stop and start clears zombies but does not replace PID 1's command.
  `asd doctor` reports whether the engine supports inner Docker. An engine lacking the capability refuses it.
- `asd start NAME` allows an over-limit sandbox to run so you can free space. With a watched disk limit, it
  measures use and warns in text and JSON (`diskWarning`) when still over: it will be stopped again within about
  30 seconds unless space is freed with `asd exec NAME -- …` or resized with `asd resize NAME --disk N`.
  The old stopped-state reason is cleared; the warning is a current measurement returned by start.
  Between the 30 second passes the disk watch measures every `disk-watch` seconds (default 5) and stops a sandbox
  that is over; after an over-limit start nothing stops it for disk use for 30 seconds, or until it measures under
  its limit.
- `asd resize` reports, for each limit, `now` (read back from the engine's host), `next start` or `unchanged`.
  Inside, gVisor does not show the new limits (`/proc/meminfo` keeps the old memory, `nproc` ignores the CPU limit);
  trust resize's report, not those. Lowering
  memory or tasks to within 10% of what the sandbox uses, or the disk limit below what it uses, is refused with exit 4.
- A template holds every file of the sandbox it was saved from, home folders included: shell history, `.env` files and
  tokens other than the usual login files. Only the usual login files and Asidee's own files are removed. Before you
  snapshot a sandbox the user did not ask you to, or hand a template to anyone, tell the user this. Volumes are not
  saved, so a `--docker` sandbox's inner images are not in its template. Neither are processes, memory, tmpfs folders
  or the engine's `/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf`. Asidee restores edits to `/etc/resolv.conf`
  on start and enforcement; template sandboxes start with its public DNS fallback. Removing a template does not
  affect the sandboxes made from it.
- To open a service that listens inside the sandbox, add a forward and use the `localPort` it reports; leave out
  `--local-port` to get a free one. It listens on this machine's 127.0.0.1 only, carries any bytes, and ends when it
  is removed, when the sandbox stops, restarts or is removed, and when the daemon stops; add it again after a restart.
  Any process on this machine can connect to it. On OrbStack, `host.docker.internal` relays to this machine's
  loopback, so the engine host and ordinary containers can reach the forward too. Guarded sandboxes cannot.
  A closed target port still gets a forward, with a warning that nothing listens inside yet. The check reads the sandbox's listening ports once and never connects to the port;
  services started later can use it. Remote daemon and SSH lifetime caveats appear only with a remote host.
  Remove a forward when you are done with it.
  A closed connection ends its relay process. A client that only finishes sending (FIN) keeps the relay while the
  port answers; after a minute of silence the relay is ended.
- To let one sandbox use a service in another (an app and its database), add a link: `asd link add FROM TO --port
  P`. Programs in FROM then connect to `TO:P` (the name TO resolves inside FROM through a line Asidee keeps in its
  `/etc/hosts`); they reach port P on TO's loopback and nothing else of TO. It is one-way and TCP only, on this machine
  only (`--host` is refused), up to 64 connections at once, 16 links per sandbox. Tell the user the trust consequence
  the command prints: TO sees these connections as coming from its own 127.0.0.1, so a service there that trusts local
  connections (a database without a password, say) trusts FROM. The service in TO must listen on its loopback (or on
  all addresses). Links come back after a stop and start and after a daemon restart, are down while the daemon is not
  running, and end when either sandbox is removed. If `link list` shows a link `cut`, its test failed (its reason says
  whether it reached something it does not name or did not carry a test value); tell the user, and `link add` it again only once they agree, since that runs the test again.
  Link tests send replies through stdin. The target listener keeps the reply in its environment, outside its process arguments.
- `asd ssh setup NAME` is for editors and tools that speak SSH. It installs OpenSSH's server from the image's
  package manager when it has none (the sandbox needs internet for that), and opens no port. `ssh NAME.asidee` logs in
  as exec's user and allows `ssh -L` only to the sandbox's loopback. Running setup again makes a new host key. The
  `--write-config` flag changes the user's `~/.ssh/config` (one `Include` line at the top), so ask first. A stopped
  sandbox refuses SSH and is not started by it.

## Operating macOS workspaces

A workspace is **not a sandbox**. Use it when the user chooses direct Mac execution and GPU access. Never substitute
one for an isolated sandbox without the user's choice. Read [macOS workspaces](../docs/workspaces.md) for measured
coverage and limits.

```sh
asd workspace create NAME --copy /absolute/project [--read PATH] [--path DIR] [--no-logins]
asd workspace create NAME --claude-profile work --codex-profile work
asd workspace create NAME --host-temp --no-logins
asd workspace create NAME --disk GiB --no-logins   # watched disk limit, default 20
asd workspace set NAME host-temp on|off   # stop first; later processes use the changed profile
asd workspace set NAME disk GiB            # applies now, also while running
asd workspace shell NAME
asd workspace exec NAME [--stdin | --stream] -- COMMAND ARG…
asd workspace list
asd workspace verify NAME
asd workspace stop NAME
asd workspace remove NAME --confirm NAME
```

The folder is `~/Asidee/NAME`. `--copy` brings a separate copy into `work`; removing it never removes the original.
Only processes started through workspace shell/exec acquire the profile. Entering the folder through another shell
does not confine anything. Copy out wanted files before confirmed removal. A stop does not delete files and a later
exec can run again. Use the CLI to stop and remove; never signal PIDs from an environment marker or delete the folder
before its processes have been identified and ended.

Always describe it as a workspace, not a sandbox. It has the same kernel and user, no CPU, memory or process limits, open internet,
LAN, tailnet and loopback, and open reads outside home. Current listeners appear in create/verify; later listeners
are reachable too. There is no declared-ports option. `--read ~/.ssh`, workspace/state/home ancestors and shared temp
allowances are refused. By default, writes and installs outside the folder remain refused, including Docker and nix sockets.

`--host-temp` at creation or `workspace set NAME host-temp on|off` opens only this user's shared per-user temp `T`
folder for file reads and writes. Connecting to Unix sockets there stays refused. It defaults off, including old
manifests. Changes refuse while processes run; use `workspace stop` first. `$TMPDIR` stays inside the workspace. Home,
`/private/tmp`, `/private/var/tmp`, and sibling `C` and `0` folders remain denied. With it on, always disclose that
other programs' temp files there are readable and writable, that the workspace can delete their socket files and
create listening sockets there that outside programs can connect to, that other enabled workspaces share it, and that
files left there survive remove and are excluded from workspace size. Successful boundary checks show `weak` for this
exception. Verify connects to a real listener in `T` from an unconfined control and from inside, with the setting on
or off; the inside connection must be refused. Live Seatbelt tests measure temp files, refused socket connections,
socket-file deletion and listening, remaining denials and a `confstr(DARWIN_USER_TEMP_DIR)` file reproduction.
With it on, the folder containing `T` is also open to `stat` (not listing); tools that create folders under `T` need
that. A live test measures that `stat` and the refusals beside it. Unit tests cover defaults, validation, profile
bytes, CLI JSON and dashboard rows. ONNX Runtime's CoreML provider ran an ML Program on the GPU with this rule in one
hand measurement outside the test suite (M5, macOS 26.7.1), with a profile that still allowed socket connections in
`T`; it was not repeated with the current profile. PyTorch/MPS warning counts were not rerun; claim nothing beyond
that. A workspace whose saved profile predates an Asidee update refuses to launch and names the fix: stop it, then
`asd workspace set NAME host-temp on` (its current value).

Creation imports `default` profiles unless the user selects named profiles. `--claude-profile work` reads
`~/.claude-work`; `--codex-profile work` reads `~/.codex-work`. `--no-logins` reads/imports no logins. Daemon environment
variables do not select sources. Claude uses the sandbox importer's shared Keychain reader, with a 15-second timeout;
macOS may prompt. A denied or timed-out read stays not imported. Claude credential and onboarding/account state are
private files inside. Product-path `claude auth status` reported logged in; authenticated calls and refresh remain
unverified. Never log tokens or call a recognised file verified authentication. Asidee passes no flags to change an
agent's inner sandbox. Describe failures and let the user choose the agent's configuration.

Workspace size, disk and free-space values use GiB (1024³ bytes). Listener text shows at most eight distinct
`port (process)` pairs; use `--json` for full listener evidence. When stop, remove or the disk watch ends a command,
stderr says why before the session closes. Signal exits use 128 plus the signal number (137 for SIGKILL).

Disk use is watched, not capped. While the daemon runs it measures each workspace with running processes every 30
seconds (private `tmp` included) and stops them past the `--disk` limit, or when free space where workspaces live
falls below the `workspace-free-space` floor (statfs available space; purgeable space is not counted). `workspace
get` and `list` then show the reason, with the two ways out: free space in the folder, or `workspace set NAME disk N`.
A launch over the limit still runs, so space can be freed from inside, and warns on stderr (`diskWarning` in JSON).
Below the floor launches are refused. Nothing watches while no daemon runs. Tell the user when a workspace was
stopped for disk and which way out the reason gives; do not raise a limit or lower the floor without asking.

Summary is read-only and does not walk workspace trees. Of the status views, only explicit list/get requests measure size. Launch runs
blocking checks only, then `du` for the disk warning. Informational probes, including the available hardware-only VideoToolbox encode, run on create
and verify. Verify leaves unreadable directories unchanged and reports an unknown hard-link result; remove repairs
permissions. Do not treat the media encode check as a Metal-compute measurement.

Remove reports multiple hard links, LaunchServices and launchd references and things it cannot undo. Remote effects,
unified logs, existing backups and changes through outside hard links can remain. Apple events, TCC capabilities,
camera/microphone capture, Keychain additions, Spotlight retention and unnamed channels are not covered. Never promise
that removing a workspace erases every trace from this Mac or the network.

`nix develop -c bun evals/run.ts --only K --write` runs only the workspace suite with independent temporary state and
engine providers disabled. It always includes K15 before lifecycle checks and writes only `SCORECARD.workspace.md`.
The full sandbox scorecards require their own full runs. Test roots stay inside the checkout's ignored `dist/` while
still being validated as inside the account's real home. No test creates an owner's `~/Asidee` workspace.

## Customizing Asidee

All customization lives in `~/.config/asidee/` (`$ASIDEE_CONFIG_DIR`; on a Linux machine enrolled from another one,
the service's `/var/lib/asidee/UID/config`, which `asd` there uses on its own). None of it can change what a sandbox is or what
`asd verify` reports.

### Add an action or a hook: an extension

Create `~/.config/asidee/extensions/ID/extension.json`:

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
- The command runs on the user's machine, not in the sandbox, with `ASIDEE_SANDBOX` (for `scope: "sandbox"`),
  `ASIDEE_FIELD_<ID>` for each field, and `asd` on `PATH`. To act inside the sandbox, call
  `asd exec "$ASIDEE_SANDBOX" -- …`.
- The dashboard shows each sandbox action as a form on running sandboxes; the CLI runs it with
  `asd ext run EXTENSION ACTION SANDBOX --set FIELD=VALUE`. Check your work with `asd ext list`, which also
  prints what is wrong with an extension that did not load.
- `asd --host NAME ext run …` runs this machine's extension on a public sandbox of NAME: the command runs here with
  `ASIDEE_HOST=NAME` too, and `asd` takes `ASIDEE_HOST` as its `--host`, so call `asd` plainly and it reaches the
  right machine. Do not pass `--host` yourself inside an extension.
- Because the command runs with the user's rights, tell the user what it does before installing it.

### Install a bundled extension

Five extensions ship inside `asd`: `logins`, `repo`, `env-docs`, `t3` and `rotator`. `asd ext list` shows the ones not
yet installed under "Bundled, not installed". `asd ext install NAME` writes `~/.config/asidee/extensions/NAME/` with an
`extension.json` of only `{"bundled":"NAME"}`; its actions then run from the `asd` binary, so neither Bun nor the
Asidee source is needed. `asd ext remove NAME` deletes only such a folder. If the user already has a folder of that
name, install refuses and remove leaves it alone; do not move or delete it for them without asking. Each extension's
README in `extensions/NAME/` lists its actions and what they need.

### Change the dashboard

Copy the built-in page (`ui/index.html` in the Asidee source) to `~/.config/asidee/ui/index.html` and edit the copy.
Other files in that folder are served next to it. The page calls `POST /api/METHOD` with a JSON body and the header
`Authorization: Bearer TOKEN`; it reads the token from the `#token=` part of the link `asd ui` prints. Methods:
`checklist`, `engines`, `list`, `get`, `create`, `createRetry`, `createStep`, `createKeep`, `start`, `stop`, `remove`, `verify`, `resize`, `snapshot`, `templateList`,
`templateRemove`, `templatePrepare`, `templatePreparing`, `templatePrepareInfo`, `exec`, `forwardAdd`, `forwardList`, `forwardRemove`, `linkAdd`, `linkList`, `linkRemove`, `sshAccess`, `extensions`, `folderBrowse`, `folderPreview`, `extensionInstall`, `extensionRemove`, `action`, `summary`,
`hostList`, `fleet`, `configGet`, `configSet`, `usage`, `about`, `openTerminal`. `linkAdd` and `linkRemove` take `from`, `to` and `port`; `linkList` takes an optional `name`. `folderBrowse` (`path`) and `folderPreview` (`source`, `logins`) read folder names and sizes in this Mac's home for the folders extension, never contents, and refuse `host`. `configGet` returns this machine's effective configuration. `configSet`
accepts only `requireProbes` and `experimental`, each a boolean, `workspaceFreeSpaceGb` and `diskWatchSeconds`, each a number, `defaults` and `engine` (`null` removes either) and `terminal`, saves them to `config.json` and returns the new
effective configuration. `terminalCommandSet`, the `workspace*` changes, `sshSetup` with `writeConfig`, `hostAttach`, `hostRemove` and `shutdown` are also open,
but each request first shows a dialog on the Mac and runs only when the person there clicks Allow; a refusal is 403 (409 when another is waiting) with
`details.approval` (`denied`, `timed-out`, `unavailable` or `busy`) and `details.command`, the CLI command to suggest instead. Do not retry a denial. `usage` returns each sandbox's CPU, memory, tasks and last disk measurement against its limits;
`openTerminal` with `name` and `kind` (`sandbox`, `workspace`, `claude` or `codex`, the last two with an optional `profile`) opens a shell or the agent in a terminal window on this Mac.
`create` takes an optional `setup` (the CLI's setup flags: `gh`, `claude`, `codex`, `repo`, `copy` as a list of `DIR[:DEST]`, `t3`,
`t3-browser`); the page then runs each step and reports it with `createStep` (`name`, `step` as the step's label, `ok`).
A sandbox's `unfinished` says when it is removed; `createRetry` (`name`) returns the `setup` and the labels `remaining`
to run, and `createKeep` (`name`) keeps it as it is.
`templatePrepare` takes `name`, `engine`, `claude`, `codex`, `script` or `scriptFile: true`, `replace` and `default` and
answers when the template is saved (a minute or two); `templatePreparing` lists the progress lines meanwhile, and
`templatePrepareInfo` gives this machine's versions and whether `~/.config/asidee/agent-template.sh` exists. `requireProbes` affects later creates, not running sandboxes. With `experimental` off,
`hostList`, `fleet` and any request with a `host` other than `local` are refused.

Requests can include `host` to select a registered machine. A sandbox's API address is `{host, name}` and its returned
identity is `{machineId, sandboxId}`. Supply `machineId` too when acting on a previously selected machine: any routed
request whose `machineId` is not that host's is refused before a connection is opened. Remote text (check details,
stop reasons, errors) is untrusted; show it as text, never as HTML. Session,
`hostPlan`, `hostApply` and sessions remain socket-only even when routed; the dashboard token does not authorize them.

Keep showing each check's status and detail as the API returns them.

### Change defaults

`~/.config/asidee/config.json`: `{ "defaults": { "image": "docker/sandbox-templates:shell-docker", "cpus": 2, "memoryGb": 4, "diskGb": 20, "docker": false }, "engine": "gvisor:orbstack" }`.
`defaults` may hold `template` (a template name) instead of `image`, not both.
The defaults obey the same limits as the flags. A mistake in this file makes `asd create` fail with a message that
names it, so run a create after editing it.
`docker` accepts only JSON `true` or `false`; it defaults to `false`. With `true`, the image must include `docker`,
`dockerd` and `iptables-legacy`.

### Check your changes

After changing anything, run `asd verify NAME` on a sandbox. If you changed Asidee's own source, run
`bun evals/run.ts` from it: it measures the claims Asidee makes from outside and prints which ones no longer hold.

## Import or remove logins

Use the bundled [logins extension](../extensions/logins/README.md), which calls only `asd exec` and needs Node in an
already running sandbox. Install it with `asd ext install logins`.
`asd ext run logins import NAME --set agent=claude --set profile=work --set setup=true` imports a selected profile and
its allowlisted setup; leave `setup` off for login only. An existing login of that profile is overwritten.
`asd ext run logins github NAME [--set account=ACCOUNT]` imports this machine's gh login. To import a pasted token,
run `bun extensions/logins/login.ts github NAME` from the Asidee source; it reads the token from stdin or a hidden
prompt. Never put a token in argv, `--set`, a manifest, or logs.
There is no secret proxy in a gVisor container: the token lives inside it and code there can read and send it out.
Use `asd ext run logins list NAME` and `asd ext run logins logout NAME --set agent=all` (or an agent and
`--set profile=PROFILE`); the machine stays logged in.
Guest imported profiles use `CLAUDE_CONFIG_DIR="$HOME/.claude-PROFILE"` or `CODEX_HOME="$HOME/.codex-PROFILE"`.
File-profile and `gh` sandbox imports were checked live once; the Claude Keychain guest path was not. Workspaces
separately measure the shared Keychain reader and Claude recognition. Extension unit tests run actual guest programs
against temporary homes; core sandbox evals do not cover extensions. Missing setup commands are named
only for settings sent, with bounded printable names and credential values withheld.

The engine measurements are in `evals/SCORECARD.md` and `evals/SCORECARD.linux.md`. A hard disk cap and reboot
recovery remain unmeasured or unbuilt as those files state. Enrollment is measured
only on the disposable Linux combinations named by the N evals.

## What you cannot do, by design

Mount a host folder, publish a port, pick a non-isolated runtime, choose capabilities, or skip a check. If the user needs
one of these, say that Asidee does not offer it yet instead of reaching around Asidee.
