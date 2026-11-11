# Scorecard

Written by `bun evals/run.ts --write`. Do not edit by hand.

- Paddock 0.3.0 at `e9983b0` plus uncommitted changes
- Engine: OrbStack 29.8.2 (context orbstack), runtime `runsc-sandbox`, disk limit watched
- Run from darwin arm64 on 2026-11-11
- **87 of 91 hold, 0 do not, 4 could not be measured here.**

| | Id | Claim | Note |
|---|---|---|---|
| ✓ | H01 | A sandbox runs on gVisor's kernel, not the host's |  |
| ✓ | H13 | Every network check in a fresh verify was probed live, not read from configuration |  |
| ✓ | H02 | From inside a sandbox, no address of the engine's host answers | 6 host addresses tried, each with a working control |
| ✓ | H03 | From inside a sandbox, this computer (beyond the engine's VM) does not answer | control: an ordinary container reached it at 0.250.250.254 |
| ✓ | H04 | From inside a sandbox, another sandbox does not answer |  |
| ✓ | H05 | From inside a sandbox, private (LAN) and tailnet addresses do not answer | stand-ins tried, each with a working control: 10.255.255.254, 172.31.255.254, 192.168.255.254, 100.127.255.254 |
| ✓ | H06 | From inside a sandbox, cloud metadata and IPv6 do not answer | no control: nothing listens at these addresses on this machine |
| ✓ | H07 | The engine object has no host folder, published port, privilege or host namespace |  |
| ✓ | H08 | The process limit holds: a fork bomb ends at the limit, in failed forks or a killed sandbox, and the engine is unharmed | the sandbox was killed at its limit, and the list says so |
| ✓ | H09 | The memory limit holds: a process that passes it is killed, not the engine | exit 128; the sandbox is stopped (Killed by the engine at 2026-11-11 01:12 UTC: it passed its memory limit of 1 GB.) |
| ✓ | H10 | A sandbox killed by its memory limit says so in the list |  |
| ✓ | H11 | The disk limit is what the checklist says: a sandbox past it is stopped within a minute | watched: stopped 2 s after the write ended |
| ✓ | H12 | The disclosures are true: internet access and the logins found inside |  |
| ✓ | H14 | Two sandboxes verified at the same moment are both probed, not one of them waved through |  |
| ✓ | I01 | NET_ADMIN and SYS_ADMIN are inclusion-minimal for copy-on-write pull, run, HTTPS and build | none: bridge creation denied; SYS_ADMIN: bridge creation denied; NET_ADMIN: overlayfs image extraction denied (ounts/containerd-mount2750775135: operation not permitted: failed to mount /var/lib/docker/containerd/daemon/tmpmounts/containerd-mount2750775135: mount source: "/var/lib/docker/containerd/daemon/io.containerd.snapshotter.v1.overlayfs/snapshots/2/fs", target: "/var/lib/docker/containerd/daemon/tmpmounts/containerd-mount2750775135", fstype: bind, flags: 20480, data: "", err: operation not permitted); NET_ADMIN+SYS_ADMIN: overlayfs, pull, run, HTTPS, one-RUN build and its output passed. Relative to Docker's unchanged defaults, this image and engine; no other additions needed. |
| ✓ | I02 | An inner container runs a small image and reaches the internet over HTTPS |  |
| ✓ | I03 | An inner container cannot reach the engine's host, with working controls | 192.168.148.1; the host reached every listener, and the same inner probes connected with the guard removed |
| ✓ | I04 | An inner container cannot reach the other sandbox, with working controls | 192.168.147.2; the host reached every listener, and the same inner probes connected with the guard removed |
| ✓ | I05 | An inner container cannot reach the stand-in LAN and tailnet addresses, with working controls | 10.255.255.254, 172.31.255.254, 192.168.255.254, 100.127.255.254; the host reached every listener, and the same inner probes connected with the guard removed |
| ✓ | I06 | The checklist includes live network attempts from an inner container |  |
| ✓ | I07 | Inner Docker survives stop/start, a daemon enforce pass, and a daemon restart; its death stops the sandbox |  |
| ✓ | I08 | An inner container cannot exceed the sandbox's memory limit, even with its own privileged mode | bounded 16 MiB control passed; hog exit 128; outer OOMKilled=true under 1 GiB despite an inner 2 GiB limit |
| ✓ | I09 | Inner image pulls and writes are measured outside the sandbox, and the disk watch stops excess use | image pull +6103040 B; inner write +1377808384 B; daemon stopped the 1 GiB sandbox for disk use |
| ✓ | I10 | A Docker sandbox with an extra capability or privileged mode is refused at start and stopped if running |  |
| ✓ | I11 | Without --docker, no capabilities are added and even root cannot start the inner daemon | no CapAdd (Docker mode adds exactly NET_ADMIN + SYS_ADMIN); Paddock's dockerd start command fails with a permission error even as root |
| ✓ | I12 | The docker default is a strict boolean and cannot smuggle engine flags |  |
| ✓ | I13 | Removing a Docker sandbox removes its container, network, inner images and private volume |  |
| ✓ | I14 | An engine volume backed by a host folder is refused before a Docker sandbox starts | the engine reports Type=volume; volume inspect exposes device=/tmp,o=bind; start refuses it without running the container |
| ✓ | I15 | Copy-on-write images share layer data across two pulled references and two running containers | overlayfs; engine-side du: before 348160 B, first pull 6443008 B, second pull/tag 6443008 B, two containers 6545408 B; image size 6017928 B; each incremental step < half the first pull's allocated data |
| ✓ | I16 | A Docker build executes one RUN layer and its image runs | BuildKit executed RUN echo build-ok > /built; the resulting image returned build-ok |
| ✓ | I17 | Docker compose up runs a one-service file with HTTPS | Docker Compose version v5.6.1; one service on compose's own bridge reached HTTPS and exited successfully |
| ✓ | I18 | Inner containers inherit sandbox DNS; the engine resolver failure and public fallback are disclosed | engine assigned 127.0.0.11: runc resolved, gVisor refused; engine upstream 0.250.250.200 timed out behind the guard; outer and inner use nameserver 1.1.1.1; nameserver 8.8.8.8 and resolve successfully; an inner user-defined network resolves through the inner daemon's 127.0.0.11, which forwards to them |
| ✓ | I19 | Verify removes a probe image it loaded and preserves a pre-existing probe image and user tags | absent before -> absent after; present before -> same image ID after; alpine:latest user tag preserved; all network probes passed in both cases |
| ✓ | I20 | Verify on a nearly full sandbox reports unknown with a disk reason and loads no probe image | 1047920640 B used of 1 GiB; all four network results unknown with the 64 MiB headroom reason; no image loaded, no crash |
| ✓ | I21 | Repeated start keeps one NAT rule, segmentation at one, and an inner HTTPS workload running | three starts: identical NAT rules (one masquerade), gso_max_segs=1, same inner StartedAt, HTTPS successes before and after without failure |
| ✓ | I22 | Host daemon logs rotate within two 10 MiB files; a replacement with a larger cap fails the config check | max-size=1g control (writable layer unchanged): host log 37703419 -> 75405107 B after two 8 MiB writes, merged options {"max-file":"5","max-size":"1g"}; Paddock's sandbox: 15508829, 10916577 B after two 16 MiB writes; a 1g cap refused at start |
| ✓ | I23 | A sandbox without Docker cannot grow its host log past two 10 MiB files by writing to its own output; a larger cap fails the config check | max-size=1g control (writable layer unchanged): host log 37703419 -> 75405107 B after two 8 MiB writes, merged options {"max-file":"5","max-size":"1g"}; a sandbox without Docker, as root through paddock exec: 15406185, 10814249 B after two 16 MiB writes; a 1g cap refused at start |
| ✓ | I24 | Verify needs no registry: with the inner Docker cut off from Docker Hub, it probes from the engine's helper image, by that image's ID | registry blocked (pull: connection refused at 0.0.0.0:443; HTTPS from the sandbox: 200); all three network checks probed; 8 inner probe containers, all from sha256:1144603f73b4…, the engine's helper; loaded image removed afterwards; an impostor under the same name made the checks unknown and was kept |
| ✓ | T01 | The evals can see an open path: with the guard removed, the same attempts connect |  |
| ✓ | T02 | A removed guard is noticed without anyone asking: the daemon stops the sandbox within a minute | stopped after 14 s |
| ✓ | T03 | Starting a sandbox puts the guard back, and the paths are closed again |  |
| ✓ | T04 | A rule slipped in front of the guard's drops fails verify, with exit code 6, and stops the sandbox |  |
| ✓ | T05 | A sandbox attached to a second network behind Paddock's back is stopped |  |
| ✓ | T06 | A container put in a sandbox's place is never operated on |  |
| ✓ | T07 | A privileged container wearing a sandbox's labels is refused at start and stopped if running |  |
| ✓ | T08 | Checks still give an answer after the helper image is deleted |  |
| ✓ | R01 | Fields the API does not have (privileged, mounts, ports, runtime, network) change nothing |  |
| ✓ | R02 | Hostile names, images and sizes are refused before the engine is touched | 34 requests refused |
| ✓ | R03 | exec cannot smuggle engine options through its user or name |  |
| ✓ | R04 | The dashboard's port refuses a missing token, a foreign Host, CLI-only methods and paths outside the UI folder |  |
| ✓ | R05 | Removing needs the name twice, whichever client asks |  |
| ✓ | R06 | State is private to the user, and the token is not printed by status |  |
| ✓ | R07 | Only the core runs engine commands: the CLI, the dashboard and the example extension contain none |  |
| ✓ | R08 | An extension's form values reach its command as data, never as shell or options |  |
| ✓ | F01 | The example extension works when copied into the config folder |  |
| ✓ | F02 | A setup hook runs after create and may use any Paddock command on the new sandbox |  |
| ✓ | F03 | A dashboard of your own replaces the built-in one, with the same API and the same token rule |  |
| ✓ | F04 | Defaults in config.json are used, and a config file with a mistake is reported, not silently ignored |  |
| ✓ | F05 | A broken extension is reported and the others still load |  |
| ✓ | F09 | An extension's action shows up in the dashboard as a form, and its output appears there |  |
| ✓ | F06 | Every command prints one line of JSON with --json, for results and for errors | 19 commands |
| ✓ | F07 | The skill's Paddock commands and flags exist, and it lists exactly the API's methods |  |
| ✓ | F08 | The README and architecture notes name only commands, files and checks that exist |  |
| ✓ | U01 | Exit codes tell the kinds of failure apart, as the help says |  |
| ✓ | U02 | Help lists every command, and errors say what to do next |  |
| ✓ | U03 | The dashboard, in a real browser, shows each sandbox with the same check results the API gives |  |
| ✓ | U04 | In a real browser, the dashboard creates a sandbox, refuses a mistyped removal, and removes it |  |
| ✓ | U05 | It is quick enough to use: list under a second, verify under 30 s, create under 60 s | list 0.03 s, verify 8.6 s, create 9.6 s |
| ✓ | U06 | `paddock shell` gives a working terminal session |  |
| ✓ | U07 | Progress goes to stderr and results to stdout, so output can be piped |  |
| ✓ | U08 | A state folder whose path is too long for a socket is refused with a message that says so |  |
| ✓ | U09 | A sandbox is usable: names resolve, HTTPS works, files survive a stop and start, and a 31-character name is fine |  |
| ✓ | U10 | exec carries large output and a non-zero exit through unchanged |  |
| ✓ | U12 | exec output past 16 MiB is refused with an error that names the limit, the command is ended, and the daemon keeps answering | exactly 16 MiB returned whole; 16 MiB+ on stdout, on stderr, and 1 GiB on stdout each refused naming the limit; no flooding process left running; same daemon (pid 5954, 163 MiB resident) answered list |
| ✓ | U11 | The default image (no --image) makes a sandbox that passes every blocking check |  |
| ✓ | D01 | After the daemon is killed, the next command starts a new one that still knows every sandbox |  |
| ✓ | D02 | Two creates of one name at the same moment: one succeeds, one is refused, and the list still answers |  |
| ✓ | D03 | A second daemon refuses to run beside the first |  |
| ✓ | D04 | Stopping the daemon stops the sandboxes only it limits, says why, and a start brings them back |  |
| ✓ | D05 | A sandbox whose container was deleted behind Paddock's back is shown as missing and can be removed |  |
| ✓ | D06 | A damaged state file does not hide the other sandboxes |  |
| ✓ | D07 | A newer Paddock replaces the running daemon without stopping its sandboxes |  |
| ✓ | D08 | A rebuilt binary of the same version replaces the daemon the old build left running |  |
| ✓ | P01 | Standalone binaries build for macOS, Linux and Windows | darwin-arm64, linux-x64, linux-arm64, linux-arm64-musl, linux-x64-musl, windows-x64 |
| ✓ | P02 | The Linux binary, run on Linux, creates a sandbox that passes every blocking check | linux-arm64-musl in a aarch64 Linux container, against this machine's engine |
| ✓ | P03 | The core has no code that only works on one operating system |  |
| – | E01 | After the engine restarts, no sandbox runs without its guard | restarting the engine would stop every other container on this machine |
| – | E02 | The same checks hold on Docker Desktop, Colima and a Linux host's own Docker | only one engine is installed here; run the evals on each |
| – | E03 | The Windows binary runs (the daemon's socket, the dashboard, `ui --open`) | there is no Windows machine here; the binary only builds |
| – | E04 | A device on your real LAN or tailnet does not answer | the evals use stand-in addresses and never contact your own devices |
| ✓ | Z01 | Nothing is left on the engine or this machine when the run ends |  |

✓ holds   ✗ does not hold   – could not be measured on this machine
