# Getting started

Moved from the README, with every detail kept.

For sandboxes, you need [Bun](https://bun.sh) and Docker with a gVisor runtime. `nix develop` gives you Bun if you use Nix.
On a Mac, Asidee runs sandboxes on [OrbStack](https://orbstack.dev) with gVisor. `asd setup` gives OrbStack gVisor:
you approve one plan (download the pinned gVisor release into `~/.local/share/asidee/gvisor`, add an `asidee-runsc`
runtime to `~/.orbstack/config/docker.json`, restart the engine, naming the containers that stop), and setup is done
only after a test sandbox passes the checks. When no default engine is set, setup then makes OrbStack the default. Its
apply step (the config edit and the engine restart) is covered by unit
tests only, since the development Mac's engine must not be restarted. `asd setup --remove` undoes it.

```sh
bun install
bin/asd setup                  # once, on a Mac: give the engine gVisor and prove it
bin/asd doctor                 # whether the engine is ready, and what it needs if not
bin/asd create demo --image ubuntu:24.04
bin/asd exec demo -- uname -a
bin/asd shell demo
bin/asd verify demo
bin/asd ui --open              # the dashboard
bin/asd remove demo --confirm demo
```

To run Docker inside, use the default image, which includes `docker`, `dockerd` and `iptables-legacy`:

```sh
bin/asd create builder --docker
bin/asd exec builder -- docker run --rm alpine:latest echo inner-ok
bin/asd remove builder --confirm builder
```

`docker` defaults to `false`. Config defaults can set `"docker": true` as a JSON boolean. The engine needs gVisor
registered with `--net-raw` and `--overlay2=none`; Asidee reports whether it has the `docker` capability and refuses
the option when it does not. Inner images, containers and volumes count toward the same watched disk limit.
Inner containers use the sandbox's DNS. Under gVisor the engine's resolver refuses queries and its upstream is in a
range the guard drops, so Asidee gives the sandbox a public fallback, **1.1.1.1 and 8.8.8.8**, disclosed by the Docker
check. Verify's inner probe runs from Asidee's helper image, copied in from the engine (no registry is asked, so it
works offline), by its image ID; it removes the copy afterwards unless it was already there. With less than 64 MiB of
disk headroom it reports unknown network evidence with the disk reason.

What a sandbox's main process prints (dockerd's log, or anything written to `/proc/1/fd/1`, which a sandbox without
Docker can do too) is stored on the engine's host, outside the watched limit, so every sandbox's log rotates at 10 MiB
with two files, which the checklist verifies. `exec` returns at most 16 MiB on each of stdout and stderr: past that,
Asidee ends the command and reports an error that names the limit instead of a cut-off result. `exec --stream` and
`shell` have no such limit: they are sessions the daemon relays as raw bytes, with backpressure, over a second socket
in the state folder that only this user can open (see [Sessions](architecture.md#sessions)).

Stopping the daemon (`asd daemon stop`) stops the sandboxes whose disk limit it watches, because nothing would
enforce the limit afterwards. Their contents stay; `asd start` brings them back.

## Build and test

`bun run build` makes a standalone `dist/asd`. `bun test` runs the unit tests; `bun run test:live` creates a real
sandbox and expects every blocking check to hold.
