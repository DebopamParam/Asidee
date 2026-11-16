import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import { connect, type Socket } from "node:net"
import { must } from "../run"
import { PaddockError, type CheckResult, type Engine, type Limits, type LinkSupport, type Manifest, type Provider, type RunOptions, type RunResult, type Runner, type Session, type Stage, type Template } from "../types"
import { probeCleanupScript, WAIT_FOR_PROBE_ROUTES } from "./probe"
import GUARD_RULES from "./guard.nft" with { type: "text" }
import HELPER_DOCKERFILE from "./helper.Dockerfile" with { type: "text" }

// Sandboxes as containers under gVisor, on any local Docker engine that has a gVisor runtime (OrbStack, a Linux host,
// Colima, …). The agent talks to gVisor's user-space kernel, never the host's. Each sandbox has a bridge network of its
// own, and an nftables table on the engine's host (guard.nft) drops its traffic to the host, to other sandboxes and
// containers, to private ranges (the LAN), the tailnet, link-local (cloud metadata) and all IPv6. The design and the
// measurements behind it come from sandbox-manager, where it was checked on OrbStack and on Linux Mint.

export const LABEL_NAME = "dev.paddock.name"
export const LABEL_ID = "dev.paddock.id"
// Where the loopback relay is copied in each sandbox.
export const RELAY = "/.paddock/busybox"
export const container = (name: string) => `paddock-${name}`
export const network = (name: string) => `paddock-net-${name}`
export const dockerVolume = (manifest: Manifest) => `paddock-docker-${manifest.id}`
// Inclusion-minimal additions to Docker's default capabilities, measured by I01 (each removal breaks the workload).
export const DOCKER_CAPABILITIES = ["NET_ADMIN", "SYS_ADMIN"] as const
// gVisor cannot use the engine's resolver on a user-defined network (127.0.0.11 is refused), and the engine's upstream is in
// a range the guard drops, so public resolvers are written (measured by I18). Inner Docker containers inherit them.
const SANDBOX_DNS = "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"
// The copy-on-write driver is named, so dockerd fails to start rather than fall back to one that copies layers. Dockerd's
// resolver for its own networks (compose's) needs iptables even with --iptables=false, and gVisor lacks nft (I17, I18).
export const DOCKER_DRIVER = "overlayfs"
export const DOCKER_START = `set -e
rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid
printf '${SANDBOX_DNS}' > /etc/resolv.conf
printf '{"features":{"containerd-snapshotter":true}}' > /run/paddock-docker.json
mkdir -p /run/paddock-bin
ln -sf "$(command -v iptables-legacy)" /run/paddock-bin/iptables
ln -sf "$(command -v ip6tables-legacy)" /run/paddock-bin/ip6tables
PATH=/run/paddock-bin:$PATH exec dockerd --config-file=/run/paddock-docker.json --host=unix:///var/run/docker.sock --data-root=/var/lib/docker --storage-driver=${DOCKER_DRIVER} --iptables=false --ip6tables=false`
// Busybox's wait also reaps adopted orphans. Forward a stop to dockerd and leave with its exit status; never restart it.
export const DOCKER_REAPER = `docker_main() {
${DOCKER_START}
}
docker_main &
daemon=$!
trap 'kill -TERM "$daemon" 2>/dev/null || true' TERM INT
while :; do
  wait "$daemon"
  code=$?
  kill -0 "$daemon" 2>/dev/null || exit "$code"
done`
// The main process of a sandbox without Docker: Paddock's busybox shell, waiting on a sleep. The kernel hands every
// orphan to PID 1, and the shell's wait reaps any child that ends, so a finished process leaves no zombie holding a
// task slot (U13; with `sleep infinity` as PID 1 every one stayed). The relay is copied in before every start.
export const REAPER = `while :; do ${RELAY} sleep 2147483647 & wait; done`
// What a sandbox's main process prints (dockerd's log, or anything written to /proc/1/fd/1, which a sandbox without
// Docker can do too) is stored by the engine on its host, outside the watched disk limit (I22, I23).
export const LOG_LIMIT = { "max-size": "10m", "max-file": "2" } as const
const INNER_NAT = "iptables-legacy -t nat -C POSTROUTING -o eth0 -j MASQUERADE 2>/dev/null || iptables-legacy -t nat -A POSTROUTING -o eth0 -j MASQUERADE"
// Linux limits interface names to 15 characters. The guard matches on this prefix.
export const BRIDGE_PREFIX = "pdk"
export const bridge = (name: string) => `${BRIDGE_PREFIX}${createHash("sha256").update(name).digest("hex").slice(0, 10)}`
// The privileged steps (loading the guard) and the probes run from this image, never from a sandbox's image, which an
// agent or a tampered template could have changed. Its tag is a hash of its Dockerfile, so it is built once per engine.
export const HELPER_IMAGE = `paddock-helper:${createHash("sha256").update(HELPER_DOCKERFILE).digest("hex").slice(0, 12)}`
// Loads the guard into a scratch network namespace and compares how nft prints it there with how it prints the tables
// on the engine's host: any added, removed or reordered rule shows. Printing both with the same nft avoids depending on
// one version's wording. Prints intact, changed or missing.
const GUARD_COMPARE = `set -e
cat > /tmp/rules
show() { nft list table inet paddock_guard && nft list table bridge paddock_guard; }
ip netns add reference
ip netns exec reference nft -f /tmp/rules
ip netns exec reference sh -c 'nft list table inet paddock_guard && nft list table bridge paddock_guard' > /tmp/want
show > /tmp/have 2>/dev/null || { echo missing; exit 0; }
cmp -s /tmp/want /tmp/have && echo intact || echo changed`
// gVisor flags that open a path to the host or switch a limit off. A runtime registered with one is not used. GPU and
// TPU passthrough (nvproxy, tpuproxy) hand the sandbox a host driver's interface.
const UNSAFE_RUNTIME_ARGS = [/^--network(=|$)(?!sandbox$)/, /^--host-uds(=(?!none$)|$)/, /^--host-fifo(=(?!none$)|$)/, /^--fsgofer-host-uds(=(?!false$)|$)/, /^--TESTONLY/, /^--ignore-cgroups(=(?!false$)|$)/, /^--allow-flag-override(=(?!false$)|$)/,
  /^--nvproxy(-docker)?(=(?!false$)|$)/, /^--tpuproxy(=(?!false$)|$)/]
type RuntimeEntry = { path?: string; runtimeArgs?: string[] }
export function unsafeRuntimeArgs(args: readonly string[] = []): string[] {
  // "--network host" (two words) is the same flag as "--network=host".
  // gVisor takes -flag and --flag alike.
  const flags = args.map((arg) => arg.replace(/^-+/, "--"))
  return args.filter((_, index) => UNSAFE_RUNTIME_ARGS.some((pattern) => pattern.test(flags[index]!)) && !(flags[index] === "--network" && args[index + 1] === "sandbox"))
}
// The disk watch reads the size of the container's writable layer. gVisor's default keeps written files in its own
// overlay, which Docker does not measure; only with --overlay2=none do they reach the layer (measured on OrbStack).
const seesWrites = (args: readonly string[] = []) => args.includes("--overlay2=none")
const hasRawNetwork = (args: readonly string[] = []) => args.filter((arg) => /^--?net-raw(?:=(?:true|false))?$/.test(arg)).at(-1)?.endsWith("false") === false
// The runtime `paddock host add` registers: a pinned, checksum-verified gVisor that enrollment's smoke sandbox ran on.
export const MANAGED_RUNTIME = "paddock-runsc"
const PROBE_REPLY = "paddock-probe"
const PROBE_PORT = "7777"
// One unused address in each private range and in the tailnet range. For a probe, the helper gives each to a listener in
// a scratch network namespace that the engine's host routes to, where a device on the LAN or the tailnet would sit.
const FAR_RANGES = [["10.255.255.25", "10.0.0.0/8"], ["172.31.255.25", "172.16.0.0/12"], ["192.168.255.25", "192.168.0.0/16"], ["100.127.255.25", "100.64.0.0/10, the tailnet range"]] as const
// Runs on the engine's host: a listener on the sandbox's gateway address, then the far listeners. A range whose address
// the host already routes somewhere specific is left alone and reported as not probed. Everything here lives in the
// helper's container and goes with it.
const hostProbeScript = (tag: string, gateway: string, port: string) => `${WAIT_FOR_PROBE_ROUTES}
nc -lk -p ${port} -s ${gateway} -e echo ${PROBE_REPLY} &
( set -e
  ip netns add far; ip link add pv${tag}a type veth peer name pv${tag}b; ip link set pv${tag}b netns far; ip link set pv${tag}a up
  ip netns exec far ip link set lo up; ip netns exec far ip link set pv${tag}b up
  for a in ${FAR_RANGES.map(([address]) => address).join(" ")}; do
    wait_probe_routes \${a}4 || { echo "teardown-timeout \${a}4"; exit 1; }
    [ -n "$(ip route show match \${a}4 | grep -v '^default')" ] && continue
    ip addr add \${a}3/30 dev pv${tag}a; ip netns exec far ip addr add \${a}4/30 dev pv${tag}b
    ip netns exec far ip route add default via \${a}3 2>/dev/null || true
    echo "far \${a}4"
  done
  ip netns exec far nc -lk -p ${PROBE_PORT} -e echo ${PROBE_REPLY} & ) || true
echo ready; wait`
// Ends every process carrying PADDOCK_EXEC=$1, a few passes in case one forks meanwhile; fails if any is left.
const END_EXEC = `marked() { for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx "PADDOCK_EXEC=$1" && echo "\${p#/proc/}"; done; true; }
for pass in 1 2 3; do pids=$(marked "$1"); [ -z "$pids" ] && exit 0; kill -9 $pids 2>/dev/null; sleep 0.2; done
[ -z "$(marked "$1")" ]`
// A link's listener inside `from` (core/links.ts), run as root with Paddock's busybox: $1 address, $2 port, $3 its folder.
// busybox nc accepts each connection and runs the part in quotes in a session of its own, which makes two named pipes
// in the folder (root only), says "o PID" on the listener's output and waits for the daemon to attach to them; "x PID"
// ends that session, its background copy of the client's input included. The input is passed as fd 3 because a
// background command's own input is /dev/null in a shell without job control. A
// listener an earlier daemon left is ended first, by the tag it wrote; this one ends its own processes when its input
// ends or is silent for 15 seconds (the daemon sends a line every 5).
export const LINK_LISTEN = `B=$0 d=$3
marked() { for p in /proc/[0-9]*; do $B tr '\\0' '\\n' < "$p/environ" 2>/dev/null | $B grep -qx "PADDOCK_EXEC=$1" && echo "\${p#/proc/}"; done; true; }
stop() { for p in $(marked "$1"); do [ "$p" = "$$" ] || kill -9 "$p" 2>/dev/null; done; }
$B mkdir -p -m 700 /.paddock/links || { echo "e mkdir"; exit 3; }
old=$($B head -c 32 "$d/tag" 2>/dev/null)
case $old in ''|*[!0-9a-f]*) ;; *) stop "$old";; esac
$B rm -rf "$d"; $B mkdir -m 700 "$d" || { echo "e mkdir"; exit 3; }
echo "$PADDOCK_EXEC" > "$d/tag"
exec 4>&1
$B nc -lk -s "$1" -p "$2" -e $B setsid $B sh -c 'exec 2>/dev/null 3<&0; B=${RELAY} c=$$
$B mkfifo -m 600 "$1/$c.i" "$1/$c.o" || exit 1
echo "o $c" >&4; exec 4>&-
$B cat <&3 > "$1/$c.o" & w=$!
$B cat "$1/$c.i"
kill -9 $w; $B rm -f "$1/$c.i" "$1/$c.o"' conn "$d" </dev/null >/dev/null 2>&1 &
n=$!
exec 4>&-
i=0
until $B netstat -ltn 2>/dev/null | $B grep -q " $1:$2 "; do
  kill -0 $n 2>/dev/null && [ $i -lt 50 ] || { kill -9 $n 2>/dev/null; echo "e bind"; exit 4; }
  i=$((i + 1)); $B sleep 0.1
done
echo r
while read -t 15 -r k p; do
  [ "$k" = x ] || continue
  case $p in ''|*[!0-9]*) continue;; esac
  $B tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | $B grep -qx "PADDOCK_EXEC=$PADDOCK_EXEC" && $B pkill -9 -s "$p"
  $B rm -f "$d/$p.i" "$d/$p.o"
done
kill -9 $n 2>/dev/null; stop "$PADDOCK_EXEC"; $B rm -rf "$d"`
// Replaces the lines ending in the link mark in /etc/hosts with $1, writing only when that changes the file, in place
// (the engine mounts it), and prints the file as it is afterwards.
const LINK_HOSTS = `B=$0 f=/etc/hosts
old=$($B cat "$f") || exit 3
want=$(printf '%s\\n' "$old" | $B grep -v '# paddock-link$'; [ -z "$1" ] || printf '%s\\n' "$1")
[ "$want" = "$old" ] || printf '%s\\n' "$want" > "$f" || exit 4
$B cat "$f"`
const LINK_DIR = /^\/\.paddock\/links\/[0-9a-f]{8}\.\d{1,5}$/
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/
// Shell globs under each home. Profile directories (~/.claude-NAME, ~/.codex-NAME) are where the bundled logins
// extension puts imported logins.
export const CREDENTIAL_FILES = [".claude*/.credentials.json", ".codex*/auth.json", ".config/gh/hosts.yml", ".git-credentials", ".ssh/id_ed25519", ".ssh/id_rsa", ".aws/credentials", ".netrc"]
// Templates are images under a repository of this daemon's own (owner), labelled with what they were made from. Only an
// image with both is one of its templates. A snapshot's intermediate image and its clean-up container use the snapshot
// names, which the sweep removes.
export const LABEL_TEMPLATE = "dev.paddock.template"
export const LABEL_TEMPLATE_OWNER = "dev.paddock.template.owner"
const LABEL_TEMPLATE_SOURCE = "dev.paddock.template.source"
const LABEL_TEMPLATE_SOURCE_IMAGE = "dev.paddock.template.source-image"
const LABEL_TEMPLATE_LOGINS = "dev.paddock.template.logins-removed"
export const templateRepository = (owner: string) => `paddock-template-${owner}`
export const snapshotRepository = (owner: string) => `paddock-snapshot-${owner}`
// Runs under gVisor, as root, in a container of the committed image with no network, with Paddock's own busybox ($1)
// and shell builtins only: nothing from the sandbox's image runs. Removes the login files, Paddock's own files (the
// relay and the SSH host key in /.paddock) and the busybox's directory, and prints each login file it removed.
const SNAPSHOT_CLEAN = `B=$1
for home in /root /home/*; do for file in ${CREDENTIAL_FILES.map((file) => `"$home"/${file}`).join(" ")}; do
  if [ -e "$file" ] || [ -L "$file" ]; then $B rm -f "$file" || exit 1; echo "removed $file"; fi
done; done
$B rm -rf /.paddock "\${B%/*}" || exit 1
echo done`
// Reads the limits a running container has on the engine's host from its cgroup (v2): memory.max, pids.max, cpu.max.
const LIVE_LIMITS = `d=$(find /sys/fs/cgroup -maxdepth 4 -type d -name "*$1*" | head -n 1); [ -n "$d" ] || exit 3
cat "$d/memory.max" "$d/pids.max" "$d/cpu.max"`

type Inspect = {
  Id?: string
  // The ID of the image the container runs.
  Image?: string
  State: { Running: boolean; OOMKilled?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string }
  Config: { Labels: Record<string, string> | null }
  HostConfig: {
    Runtime: string; Privileged: boolean; CapAdd: string[] | null; CapDrop?: string[] | null; Devices: unknown[] | null; PidMode: string; IpcMode: string
    Binds?: string[] | null; VolumesFrom?: string[] | null; DeviceRequests?: unknown[] | null; Annotations?: Record<string, string> | null
    UTSMode: string; UsernsMode: string; SecurityOpt: string[] | null; NetworkMode: string; PublishAllPorts: boolean
    PortBindings: Record<string, unknown> | null; Memory: number; MemorySwap: number; PidsLimit: number | null; NanoCpus: number
    LogConfig?: { Type: string; Config: Record<string, string> | null }
  }
  Mounts: Array<{ Type: string; Source: string; Destination: string; Name?: string; RW?: boolean }> | null
  // Files on the engine's host that it mounts into the container; empty before its first start.
  HostsPath?: string; HostnamePath?: string; ResolvConfPath?: string
  NetworkSettings: { Networks: Record<string, { IPAddress: string }> | null }
}

const result = (id: CheckResult["id"], status: CheckResult["status"], evidence: CheckResult["evidence"], detail: string): CheckResult => ({ id, status, evidence, detail })
const isGvisor = (path: string | undefined) => (path ?? "").split("/").pop() === "runsc"
export type GuardState = "intact" | "changed" | "missing" | "unknown"
type VolumeInspect = { Name: string; Driver: string; Options: Record<string, string> | null; Labels: Record<string, string> | null }
export type ImageInspect = { Id: string; RepoTags?: string[] | null; Created?: string; Size?: number; Config?: { Labels?: Record<string, string> | null } & Record<string, unknown> | null }

// The checks that only need `docker inspect`. Exported for tests.
export function configChecks(inspect: Inspect, manifest: Manifest, guard: GuardState, networkBridge: string | undefined, volumes?: readonly VolumeInspect[], image?: ImageInspect, owner = "1"): CheckResult[] {
  const host = inspect.HostConfig; const name = manifest.name; const out: CheckResult[] = []
  const expected = manifest.spec.docker ? [...DOCKER_CAPABILITIES] : []
  const actual = [...new Set((host.CapAdd ?? []).map((cap) => cap.toUpperCase().replace(/^CAP_/, "")))].sort()
  const capsMatch = actual.length === expected.length && actual.every((cap, index) => cap === expected[index])
  const loose = [
    host.Privileged && "privileged mode",
    !capsMatch && `added capabilities (${actual.join(", ") || "none"}) instead of exactly ${expected.join(", ") || "none"}`,
    manifest.spec.docker && (host.CapDrop ?? []).length > 0 && "dropped capabilities, changing Docker's declared capability set",
    (host.Devices ?? []).length > 0 && "host devices",
    (host.DeviceRequests ?? []).length > 0 && "device requests (a GPU, for example)",
    (host.VolumesFrom ?? []).length > 0 && "another container's volumes",
    Object.keys(host.Annotations ?? {}).length > 0 && "runtime annotations",
    host.Runtime !== manifest.engine.data.runtime && `the runtime ${host.Runtime} instead of ${manifest.engine.data.runtime}`,
    ...(["PidMode", "IpcMode", "UTSMode", "UsernsMode"] as const).map((key) => host[key] === "host" && `the host's ${key.replace("Mode", "").toLowerCase()} namespace`),
    (host.SecurityOpt ?? []).some((option) => option.includes("unconfined")) && "an unconfined security profile",
  ].filter(Boolean)
  out.push(loose.length ? result("hardening", "fail", "inspected", `The container has ${loose.join(", ")}.`) : result("hardening", "pass", "inspected", manifest.spec.docker
    ? `Docker requested: exactly ${expected.join(", ")} are added to Docker's default capabilities inside gVisor. No privileged mode, host namespaces or devices.` : "None of them are set."))

  // Volumes the image declares live in the engine, not in a host folder.
  const binds = [...(inspect.Mounts ?? []).filter((mount) => mount.Type !== "volume" && mount.Type !== "tmpfs"), ...(host.Binds ?? []).map((bind) => ({ Source: bind.split(":")[0]!, Destination: bind.split(":")[1] ?? "" }))]
  const privateDocker = (inspect.Mounts ?? []).some((mount) => mount.Type === "volume" && mount.Name === dockerVolume(manifest) && mount.Destination === "/var/lib/docker" && mount.RW)
  const volumeMounts = (inspect.Mounts ?? []).filter((mount) => mount.Type === "volume")
  const unsafeVolumes = manifest.spec.docker && volumes?.filter((volume) => volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length > 0
    || (volume.Name === dockerVolume(manifest) && (volume.Labels?.[LABEL_ID] !== manifest.id || volume.Labels?.[LABEL_NAME] !== name)))
  const volumesRead = volumes !== undefined && volumeMounts.every((mount) => volumes.some((volume) => volume.Name === mount.Name))
  out.push(binds.length ? result("mounts", "fail", "inspected", `Mounted from the host: ${binds.map((mount) => `${mount.Source} at ${mount.Destination}`).join(", ")}.`)
    : manifest.spec.docker && !privateDocker ? result("mounts", "fail", "inspected", "Docker's data is not on this sandbox's private writable engine volume at /var/lib/docker.")
    : unsafeVolumes && unsafeVolumes.length ? result("mounts", "fail", "inspected", `Unsafe engine volumes: ${unsafeVolumes.map((volume) => volume.Name).join(", ")}. Docker sandboxes require local volumes without mount options (including host-folder binds), and matching ownership labels on the Docker data volume.`)
    : manifest.spec.docker && !volumesRead ? result("mounts", "unknown", "none", "The sandbox's engine volumes could not all be inspected; host-folder-backed volumes cannot be ruled out.")
    : result("mounts", "pass", "inspected", manifest.spec.docker ? "No host folders. /var/lib/docker is a private engine volume, counted by the disk watch and removed with the sandbox." : "No host folders."))

  const networks = Object.keys(inspect.NetworkSettings.Networks ?? {})
  const own = network(name)
  const networkProblems = [
    !(networks.length === 1 && networks[0] === own) && `it is attached to ${networks.join(", ") || "no network"} instead of only ${own}`,
    host.NetworkMode !== own && `its network mode is ${host.NetworkMode}`,
    !(networkBridge ?? "").startsWith(BRIDGE_PREFIX) && "its network's bridge is not one the guard covers",
    guard === "missing" && "the guard rules are not loaded on the engine's host",
    guard === "changed" && "the guard rules on the engine's host differ from the ones Paddock loads",
  ].filter(Boolean)
  out.push(networkProblems.length ? result("network-guard", "fail", "inspected", `Not guarded: ${networkProblems.join("; ")}.`)
    : guard === "unknown" ? result("network-guard", "unknown", "none", "The guard rules on the engine's host could not be read.")
    : result("network-guard", "pass", "inspected", `Only on ${own}; the loaded guard rules match Paddock's, rule for rule.`))

  const published = Object.keys(host.PortBindings ?? {})
  out.push(published.length || host.PublishAllPorts ? result("inbound", "fail", "inspected", `Published ports: ${published.join(", ") || "all"}.`) : result("inbound", "pass", "inspected", "No published ports."))

  const unlimited = [
    !(host.Memory > 0) && "memory", host.Memory > 0 && host.MemorySwap !== host.Memory && "swap",
    !((host.PidsLimit ?? 0) > 0) && "processes", !(host.NanoCpus > 0) && "CPU",
    !(host.LogConfig?.Type === "json-file" && Object.entries(LOG_LIMIT).every(([key, value]) => host.LogConfig?.Config?.[key] === value)) && "host logs (json-file with max-size=10m and max-file=2)",
  ].filter(Boolean)
  // The limits must be the ones Paddock set (at creation or by resize), so one changed behind its back shows.
  const wanted = engineLimits(manifest.spec)
  const differ = [
    host.Memory > 0 && host.Memory !== wanted.memory && `memory is ${host.Memory / 1024 ** 3} GB instead of ${manifest.spec.memoryGb} GB`,
    (host.PidsLimit ?? 0) > 0 && host.PidsLimit !== wanted.pids && `the task limit is ${host.PidsLimit} instead of ${manifest.spec.pids}`,
    host.NanoCpus > 0 && host.NanoCpus !== wanted.nanoCpus && `CPUs are ${host.NanoCpus / 1e9} instead of ${manifest.spec.cpus}`,
  ].filter(Boolean)
  out.push(unlimited.length ? result("limits", "fail", "inspected", `No limit on ${unlimited.join(", ")}.`)
    : differ.length ? result("limits", "fail", "inspected", `The engine's limits are not the ones Paddock set: ${differ.join("; ")}.`)
    : result("limits", "pass", "inspected", `${host.Memory / 1024 ** 3} GB memory, ${host.PidsLimit} tasks (gVisor's own threads count, so fewer processes than that fit), ${host.NanoCpus / 1e9} ${host.NanoCpus === 1e9 ? "CPU" : "CPUs"}. A sandbox that passes its memory or task limit is killed. What its main process prints${manifest.spec.docker ? " (dockerd's log)" : ""} is kept on the engine's host, outside the watched disk limit, in two files of at most 10 MiB.`))

  const disk = manifest.engine.capabilities?.diskLimit
  out.push(disk === "hard" ? result("disk", "pass", "inspected", `${manifest.spec.diskGb} GB; writes fail at the limit.`)
    : disk === "watched" ? result("disk", "weak", "inspected", `Watched, not capped: the daemon stops the sandbox within about 30 seconds of it passing ${manifest.spec.diskGb} GB, so it can overshoot. Stopping the daemon stops the sandbox; if the daemon crashes, nothing watches until it runs again.`)
    : result("disk", "unsupported", "none", "Nothing limits this sandbox's disk use: the engine has no cap, and its gVisor runtime lacks --overlay2=none, without which Paddock cannot measure what the sandbox writes."))

  const recorded = manifest.template; const labels = image?.Config?.Labels ?? {}
  const short = (id = "") => id.replace(/^sha256:/, "").slice(0, 12)
  const tagged = Boolean(recorded && (image?.RepoTags ?? []).includes(`${templateRepository(owner)}:${recorded.name}`))
  out.push(recorded && inspect.Image !== recorded.imageId ? result("template", "fail", "inspected", `The container runs the image ${short(inspect.Image) || "(unknown)"}, not template ${recorded.name}'s image ${short(recorded.imageId)}.`)
    : recorded && !image ? result("template", "unknown", "none", `Recorded as made from template ${recorded.name} (image ${short(recorded.imageId)}), but the engine could not describe that image.`)
    : recorded ? result("template", "info", "inspected", `Template ${recorded.name}, saved from the sandbox ${recorded.source} on ${recorded.createdAt.slice(0, 10)}; the container runs its image ${short(recorded.imageId)}.${tagged ? "" : " The template has been removed since; its image stays on the engine until the last sandbox made from it is removed."} It holds the files of the sandbox it was saved from, except the usual login files. The credentials check looks only for those login files; other secrets saved in it (.env files, shell history, tokens) are not looked for.`)
    : labels[LABEL_TEMPLATE] && labels[LABEL_TEMPLATE_OWNER] === owner ? result("template", "info", "inspected", `None recorded, but its image ${short(inspect.Image)} is Paddock template ${labels[LABEL_TEMPLATE]}'s, given as a plain image.`)
    : result("template", "info", "inspected", `None: made from the image ${manifest.spec.image}.`))
  return out
}

// The engine's values for a spec's limits, as create and resize set them.
export const engineLimits = (spec: Limits) => ({ memory: Math.round(spec.memoryGb * 1024) * 1024 ** 2, pids: spec.pids, nanoCpus: Math.round(spec.cpus * 1e9) })

export class GvisorProvider implements Provider {
  readonly id = "gvisor"
  // Readings in flight, so checks of several sandboxes asked for at once share one. A finished reading is never reused:
  // a check must not be answered from before it was asked.
  private readonly guardReads = new Map<string, Promise<GuardState>>()
  // One probe per engine at a time: they share the stand-in addresses on the engine's host.
  private readonly probing = new Map<string, Promise<unknown>>()
  // owner: marks this daemon's probe helpers, so a second Paddock on the same engine does not sweep them away.
  constructor(private readonly run: Runner, private readonly owner = "1") {}

  // Links (core/links.ts). Every process they start inside a sandbox runs Paddock's busybox, with arguments that come
  // from the daemon.
  readonly links: LinkSupport = {
    listen: (manifest, dir, address, port) => {
      if (!LINK_DIR.test(dir) || !IPV4.test(address) || !Number.isInteger(port)) throw new PaddockError("usage", "A link listener needs a link folder, an address and a port.")
      return this.openExec(manifest, [RELAY, "sh", "-c", LINK_LISTEN, RELAY, address, String(port), dir], { user: "0", tty: false })
    },
    attach: async (manifest, dir, pid) => {
      if (!LINK_DIR.test(dir) || !Number.isInteger(pid) || pid < 1) throw new PaddockError("usage", "A link connection needs its folder and process.")
      const fromClient = await this.openExec(manifest, [RELAY, "cat", `${dir}/${pid}.o`], { user: "0", tty: false })
      fromClient.pause()
      try {
        const toClient = await this.openExec(manifest, [RELAY, "sh", "-c", 'exec "$0" cat > "$1"', RELAY, `${dir}/${pid}.i`], { user: "0", tty: false })
        toClient.pause()
        return { fromClient, toClient }
      } catch (error) { fromClient.close(); throw error }
    },
    hosts: async (manifest, lines) => {
      const written = await this.exec(manifest, [RELAY, "sh", "-c", LINK_HOSTS, RELAY, lines.join("\n")], { user: "0" })
      if (written.exitCode !== 0) throw new PaddockError("runtime", `Could not write the link names into /etc/hosts in ${manifest.name}: ${written.stderr.trim() || `exit ${written.exitCode}`}`)
      return written.stdout
    },
    canary: (manifest, port, reply, everywhere) => {
      if (!/^[0-9a-f]{1,32}$/.test(reply)) throw new PaddockError("usage", "A test reply is hexadecimal.")
      return this.openExec(manifest, [RELAY, "nc", "-lk", ...(everywhere ? [] : ["-s", "127.0.0.1"]), "-p", String(port), "-e", RELAY, "echo", reply], { tty: false })
    },
    dial: async (manifest, host, port) => {
      if (!/^[a-z0-9][a-z0-9.-]{0,62}$/.test(host)) throw new PaddockError("usage", "A test connection needs a host name or address.")
      const tried = await this.exec(manifest, [RELAY, "nc", "-w", "3", host, String(port)])
      return { connected: tried.exitCode === 0, received: tried.stdout }
    },
    address: async (manifest) => {
      const read = await this.docker(manifest.engine, ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container(manifest.name)])
      const ip = read.stdout.trim()
      return read.exitCode === 0 && IPV4.test(ip) ? ip : undefined
    },
    hostDial: async (manifest, ip, port) => {
      if (!IPV4.test(ip)) throw new PaddockError("usage", "A test connection from the engine's host needs an address.")
      await this.ensureHelper(manifest.engine)
      return (await this.docker(manifest.engine, ["run", "--rm", "--label", `dev.paddock.probe=${this.owner}`, "--runtime", "runc", "--network", "host", "--memory", "64m", "--pids-limit", "64", HELPER_IMAGE, "nc", "-w", "2", ip, String(port)], { timeoutMs: 30_000 })).stdout
    },
  }

  private docker(engine: Engine, args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.run(["docker", "--context", engine.data.context!, ...args], options)
  }

  async detect(): Promise<Engine[]> {
    const listed = await this.run(["docker", "context", "ls", "--format", "{{json .}}"], { timeoutMs: 10_000 })
    if (listed.exitCode !== 0) return []
    const engines: Engine[] = []; const seen = new Set<string>()
    // "default" is whatever owns /var/run/docker.sock today, so an engine also listed under its own name is recorded under that.
    const contexts = listed.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { Name: string; DockerEndpoint: string })
      .sort((a, b) => Number(a.Name === "default") - Number(b.Name === "default"))
    for (const context of contexts) {
      const base = { id: `gvisor:${context.Name}`, provider: this.id, data: { context: context.Name } }
      // Remote engines (ssh://, tcp://) are not handled yet: the probes assume the engine's host is this machine or its VM.
      if (!/^(unix|npipe):\/\//.test(context.DockerEndpoint)) continue
      const info = await this.run(["docker", "--context", context.Name, "info", "--format", "{{json .}}"], { timeoutMs: 10_000 })
      let parsed: { ID?: string; OperatingSystem?: string; ServerVersion?: string; Architecture?: string; Runtimes?: Record<string, RuntimeEntry> } = {}
      try { parsed = JSON.parse(info.stdout) } catch {}
      if (info.exitCode !== 0 || !parsed.ServerVersion) {
        engines.push({ ...base, label: `Docker context ${context.Name}`, ready: false, problems: ["The Docker engine does not answer."], fix: "Start the engine (OrbStack, Docker Desktop, or `systemctl start docker`)." })
        continue
      }
      // Two contexts can name one engine (OrbStack also owns /var/run/docker.sock).
      if (parsed.ID && seen.has(parsed.ID)) continue
      if (parsed.ID) seen.add(parsed.ID)
      const label = `${parsed.OperatingSystem ?? "Docker"} ${parsed.ServerVersion} (context ${context.Name})`
      const gvisor = Object.entries(parsed.Runtimes ?? {}).filter(([, entry]) => isGvisor(entry.path)).sort(([a], [b]) => a.localeCompare(b))
      const usable = gvisor.filter(([, entry]) => unsafeRuntimeArgs(entry.runtimeArgs).length === 0)
      // Prefer a runtime whose writes Paddock can measure, and among those the one enrollment installed and verified:
      // an unrelated entry whose name sorts first must not take an enrolled host's sandboxes to an unverified runtime.
      const measured = usable.filter(([, entry]) => seesWrites(entry.runtimeArgs))
      const chosen = measured.find(([name]) => name === MANAGED_RUNTIME) ?? measured[0] ?? usable[0]
      if (!chosen) {
        const problems = gvisor.length
          ? gvisor.map(([name, entry]) => `The gVisor runtime ${name} is registered with ${unsafeRuntimeArgs(entry.runtimeArgs).join(", ")}, which opens a path to the host or switches a limit off.`)
          : ["The engine has no gVisor runtime, and Paddock does not run sandboxes on the host's kernel."]
        engines.push({ ...base, label, ready: false, problems, fix: gvisorSetup(parsed.OperatingSystem, parsed.Architecture) })
        continue
      }
      const measurable = seesWrites(chosen[1].runtimeArgs)
      engines.push({ ...base, label, ready: true, data: { context: context.Name, runtime: chosen[0] },
        problems: measurable ? [] : [`Sandboxes here have no disk limit: the runtime ${chosen[0]} lacks --overlay2=none, without which Paddock cannot measure what a sandbox writes.`],
        capabilities: { kernelIsolation: "gvisor", diskLimit: measurable ? "watched" : "none", networkGuard: true, docker: measurable && hasRawNetwork(chosen[1].runtimeArgs), execStream: true, loopbackRelay: true,
          // docker update changes a running gVisor sandbox's cgroup at once (measured on OrbStack), and resize reads it
          // back. A commit sees a sandbox's files only when they reach the engine's layer, which needs --overlay2=none.
          resize: "live", snapshot: measurable } })
    }
    return engines
  }

  private async ensureHelper(engine: Engine): Promise<void> {
    if ((await this.docker(engine, ["image", "inspect", HELPER_IMAGE])).exitCode === 0) return
    must(await this.docker(engine, ["build", "-q", "-t", HELPER_IMAGE, "-"], { stdin: HELPER_DOCKERFILE, timeoutMs: 300_000 }), "Building the helper image")
  }

  // Runs nft as root on the engine host's network, from the helper image.
  private nft(engine: Engine, args: readonly string[], stdin?: string): Promise<RunResult> {
    return this.docker(engine, ["run", "--rm", "-i", "--runtime", "runc", "--privileged", "--network", "host", "-u", "0", "--entrypoint", "nft", HELPER_IMAGE, ...args], { stdin, timeoutMs: 60_000 })
  }

  private guardState(engine: Engine): Promise<GuardState> {
    const reading = this.guardReads.get(engine.id)
    if (reading) return reading
    const read = (async (): Promise<GuardState> => {
      await this.ensureHelper(engine)
      const output = await this.docker(engine, ["run", "--rm", "-i", "--runtime", "runc", "--privileged", "--network", "host", "-u", "0", "--entrypoint", "sh", HELPER_IMAGE, "-c", GUARD_COMPARE], { stdin: GUARD_RULES, timeoutMs: 60_000 })
      const word = output.stdout.trim()
      return output.exitCode === 0 && (word === "intact" || word === "changed" || word === "missing") ? word : "unknown"
    })().catch((): GuardState => "unknown").finally(() => this.guardReads.delete(engine.id))
    this.guardReads.set(engine.id, read)
    return read
  }

  // The guard does not survive a restart of the engine's host, so it is loaded before every start. Loading replaces the
  // tables in one transaction, which also undoes any change made to them.
  async prepare(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    await this.ensureHelper(engine)
    must(await this.nft(engine, ["-f", "-"], GUARD_RULES), "Loading the network guard")
    // A reading begun before the load may describe the tables it replaced; let it finish so the next one is new.
    await this.guardReads.get(engine.id)
    if ((await this.docker(engine, ["network", "inspect", network(name)])).exitCode !== 0)
      must(await this.docker(engine, ["network", "create", "--label", `${LABEL_ID}=${manifest.id}`, "-o", `com.docker.network.bridge.name=${bridge(name)}`, network(name)]), "Creating the sandbox's network")
  }

  async create(manifest: Manifest): Promise<void> {
    const { engine, spec, name } = manifest
    await this.prepare(manifest)
    const memory = `${Math.round(spec.memoryGb * 1024)}m`
    if (spec.docker) must(await this.docker(engine, ["volume", "create", "--label", `${LABEL_NAME}=${name}`, "--label", `${LABEL_ID}=${manifest.id}`, dockerVolume(manifest)]), "Creating Docker's private data volume")
    // The reaper exits with dockerd. No restart policy may bypass the guard and checks.
    const made = await this.docker(engine, [
      "create", "--name", container(name), "--hostname", name, "--label", `${LABEL_NAME}=${name}`, "--label", `${LABEL_ID}=${manifest.id}`,
      "--runtime", engine.data.runtime!, "--network", network(name), "--restart", "no",
      "--cpus", String(spec.cpus), "--memory", memory, "--memory-swap", memory, "--pids-limit", String(spec.pids),
      "--log-driver", "json-file", ...Object.entries(LOG_LIMIT).flatMap(([key, value]) => ["--log-opt", `${key}=${value}`]),
      ...(spec.docker ? [...DOCKER_CAPABILITIES.flatMap((cap) => ["--cap-add", cap]), "--mount", `type=volume,src=${dockerVolume(manifest)},dst=/var/lib/docker,volume-nocopy`, "--user", "0", "--entrypoint", RELAY, spec.image, "sh", "-c", DOCKER_REAPER]
        : ["--entrypoint", RELAY, spec.image, "sh", "-c", REAPER]),
    ], { timeoutMs: 1_800_000 })
    must(made, /Unable to find image|No such image|pull access denied|manifest unknown|image.*not found|failed to resolve|failed to pull|pulling.*failed/i.test(made.stderr)
      ? `The engine cannot download the image ${spec.image}` : `Creating ${name}`)
  }

  private async inspect(manifest: Manifest): Promise<Inspect | undefined> {
    const output = await this.docker(manifest.engine, ["inspect", container(manifest.name)])
    if (output.exitCode !== 0) {
      if (/No such (?:container|object):/i.test(output.stderr)) return undefined
      throw new PaddockError("runtime", `Could not inspect ${manifest.name}: ${output.stderr.trim() || "the engine returned no evidence"}`)
    }
    const inspect = (JSON.parse(output.stdout) as Inspect[])[0]!
    // A container under this name that the core did not create (or a recreated one) is never operated on.
    if (inspect.Config.Labels?.[LABEL_ID] !== manifest.id)
      throw new PaddockError("conflict", `The container ${container(manifest.name)} was not created by this Paddock sandbox (its id label differs). Nothing was done to it.`)
    return inspect
  }

  async status(manifest: Manifest) {
    const inspect = await this.inspect(manifest)
    return inspect === undefined ? "missing" as const : inspect.State.Running ? "running" as const : "stopped" as const
  }

  // Why the engine says a sandbox that Paddock did not stop is not running.
  async stoppedWhy(manifest: Manifest): Promise<string | undefined> {
    const state = (await this.inspect(manifest))?.State
    if (!state || state.Running || !state.FinishedAt || state.FinishedAt.startsWith("0001")) return undefined
    const at = `${state.FinishedAt.slice(0, 16).replace("T", " ")} UTC`
    if (state.OOMKilled) return `Killed by the engine at ${at}: it passed its memory limit of ${manifest.spec.memoryGb} GB.`
    if (manifest.spec.docker) return `Docker ended at ${at} (exit code ${state.ExitCode}). Start the sandbox to run it again; memory and task limits can also end it.`
    // docker stop ends it with 137 or 143; anything else is the sandbox's own doing.
    if (state.ExitCode === 137 || state.ExitCode === 143 || state.ExitCode === 0) return undefined
    return `Ended on its own at ${at} (exit code ${state.ExitCode}). A gVisor sandbox that runs out of its task limit of ${manifest.spec.pids} ends this way.`
  }

  async start(manifest: Manifest): Promise<void> {
    const { engine, name } = manifest
    const inspect = await this.inspect(manifest)
    if (!inspect?.State.Running) {
      if (inspect?.Id) await this.copyRelay(manifest, inspect.Id)
      must(await this.docker(engine, ["start", container(name)]), `Starting ${name}`)
    }
    const dns = await this.dnsCheck(manifest)
    if (dns.status !== "pass") throw new PaddockError("runtime", `${name} started, but its DNS could not be set and read back: ${dns.detail}`)
    if (manifest.spec.docker) {
      must(await this.docker(engine, ["exec", "-u", "0", container(name), "sh", "-c", INNER_NAT]), "Setting Docker's inner NAT (needs iptables-legacy and gVisor --net-raw)")
      // Merged packets accepted by gVisor's own sockets can be dropped when forwarded to inner containers.
      must(await this.docker(engine, ["run", "--rm", "--runtime", "runc", "--privileged", "--network", "host", HELPER_IMAGE, "sh", "-ec",
        'for port in /sys/class/net/"$1"/brif/*; do [ -e "$port" ]; ip link set "${port##*/}" gso_max_segs 1; done', "gso", bridge(name)]), "Setting the sandbox's packet segmentation")
      for (let attempt = 0; attempt < 60; attempt++) {
        if ((await this.dockerInfo(manifest)).exitCode === 0) return
        if (!(await this.inspect(manifest))?.State.Running) break
        await Bun.sleep(500)
      }
      const logs = await this.docker(engine, ["logs", "--tail", "20", container(name)])
      throw new PaddockError("runtime", `${name}: inner Docker did not become ready. The image needs dockerd, docker and iptables-legacy. ${logs.stdout}${logs.stderr}`)
    }
  }

  async stop(manifest: Manifest): Promise<void> {
    if ((await this.inspect(manifest)) === undefined) return
    must(await this.docker(manifest.engine, ["stop", "-t", "5", container(manifest.name)], { timeoutMs: 60_000 }), `Stopping ${manifest.name}`)
  }

  private async cleanupCreate(manifest: Manifest): Promise<void> {
    const left: string[] = []
    const resources: Array<["network" | "volume", string]> = [["network", network(manifest.name)]]
    if (manifest.spec.docker) resources.push(["volume", dockerVolume(manifest)])
    for (const [kind, name] of resources) {
      const read = () => this.docker(manifest.engine, [kind, "inspect", "--format", `{{index .Labels "${LABEL_ID}"}}`, name])
      const absent = (out: RunResult) => out.exitCode !== 0 && /(?:No such (?:network|volume)|(?:network|volume) .+ not found)/i.test(out.stderr)
      try {
        const before = await read()
        if (absent(before)) continue
        if (before.exitCode !== 0) { left.push(`${kind} ${name}: its presence could not be checked (${before.stderr.trim()})`); continue }
        if (before.stdout.trim() !== manifest.id) continue
        const removed = await this.docker(manifest.engine, [kind, "rm", name])
        const after = await read()
        if (!absent(after)) left.push(`${kind} ${name}${after.exitCode === 0 ? " remains" : ": removal could not be verified"} (${removed.stderr.trim() || after.stderr.trim() || "engine still reports it"})`)
      } catch (error) { left.push(`${kind} ${name}: cleanup could not be verified (${error instanceof Error ? error.message : String(error)})`) }
    }
    if (left.length) throw new PaddockError("runtime", left.join("; "))
  }

  async remove(manifest: Manifest, createdOnly = false): Promise<void> {
    if (createdOnly) return this.cleanupCreate(manifest)
    const { engine, name } = manifest
    if ((await this.inspect(manifest)) !== undefined) must(await this.docker(engine, ["rm", "-f", "-v", container(name)], { timeoutMs: 120_000 }), `Removing ${name}`)
    if (manifest.spec.docker) {
      const volume = await this.docker(engine, ["volume", "inspect", "--format", `{{index .Labels "${LABEL_ID}"}}`, dockerVolume(manifest)])
      if (volume.exitCode === 0) {
        if (volume.stdout.trim() !== manifest.id) throw new PaddockError("conflict", `The volume ${dockerVolume(manifest)} does not belong to ${name}; it was not removed.`)
        must(await this.docker(engine, ["volume", "rm", dockerVolume(manifest)]), "Removing Docker's private data volume")
      } else if (!/No such volume/i.test(volume.stderr)) throw new PaddockError("runtime", `Could not check Docker's private volume ${dockerVolume(manifest)}: ${volume.stderr.trim()}`)
    }
    const removed = await this.docker(engine, ["network", "rm", network(name)])
    const remaining = await this.docker(engine, ["network", "inspect", network(name)])
    if (remaining.exitCode === 0 || !/(?:No such network|network .+ not found)/i.test(remaining.stderr))
      throw new PaddockError("runtime", `Network ${network(name)} remains or its removal could not be verified: ${removed.stderr.trim() || remaining.stderr.trim()}`)
    await this.dropUnusedTemplates(engine)
  }

  // A removed template's image stays while sandboxes run it; it goes once none does. Removing an image in use fails, so
  // only unused ones go.
  private async dropUnusedTemplates(engine: Engine): Promise<void> {
    const untagged = (await this.docker(engine, ["image", "ls", "-q", "--no-trunc", "--filter", "dangling=true", "--filter", `label=${LABEL_TEMPLATE_OWNER}=${this.owner}`])).stdout.split("\n").filter(Boolean)
    for (const id of new Set(untagged)) await this.docker(engine, ["rmi", id])
  }

  async resize(manifest: Manifest, limits: Limits): Promise<Limits | undefined> {
    const { engine, name } = manifest
    const inspect = await this.inspect(manifest)
    if (!inspect) throw new PaddockError("not-found", `${name} has no container on ${engine.label}.`)
    const memory = `${Math.round(limits.memoryGb * 1024)}m`
    must(await this.docker(engine, ["update", "--cpus", String(limits.cpus), "--memory", memory, "--memory-swap", memory, "--pids-limit", String(limits.pids), container(name)], { timeoutMs: 60_000 }), `Resizing ${name}`)
    if (!inspect.State.Running || !inspect.Id) return undefined
    // gVisor does not show the sandbox its new limits (its /proc/meminfo keeps the old memory), but the engine's host
    // enforces the cgroup, so that is what is read back.
    await this.ensureHelper(engine)
    const read = await this.docker(engine, ["run", "--rm", "--runtime", "runc", "--privileged", "--cgroupns", "host", "--network", "none", "--entrypoint", "sh", HELPER_IMAGE, "-c", LIVE_LIMITS, "limits", inspect.Id], { timeoutMs: 60_000 })
    const [memoryMax, pidsMax, cpuMax] = read.stdout.trim().split("\n")
    const [quota, period] = (cpuMax ?? "").split(" ").map(Number)
    if (read.exitCode !== 0 || !quota || !period) return undefined
    return { memoryGb: Number(memoryMax) / 1024 ** 3, pids: Number(pidsMax), cpus: quota / period }
  }

  async usage(manifest: Manifest): Promise<{ memoryBytes: number; tasks: number } | undefined> {
    const inspect = await this.inspect(manifest)
    if (!inspect?.State.Running || !inspect.Id) return undefined
    const reply = await engineApi(await this.endpoint(manifest.engine), "GET", `/containers/${inspect.Id}/stats?stream=false&one-shot=true`)
    const memory = reply.body?.memory_stats; const tasks = reply.body?.pids_stats?.current
    if (reply.status !== 200 || typeof memory?.usage !== "number" || typeof tasks !== "number") throw new PaddockError("runtime", `The engine did not report what ${manifest.name} uses: ${reply.body?.message ?? `HTTP ${reply.status}`}`)
    // As docker stats counts it: the page cache the kernel can drop is not in use.
    return { memoryBytes: memory.usage - (memory.stats?.inactive_file ?? 0), tasks }
  }

  private async runtimeEntry(engine: Engine, runtime: string): Promise<RuntimeEntry | undefined> {
    const runtimes = await this.docker(engine, ["info", "--format", "{{json .Runtimes}}"])
    try { return (JSON.parse(runtimes.stdout) as Record<string, RuntimeEntry>)[runtime] } catch { return undefined }
  }

  // Two commits. The first saves the sandbox's files, pausing it if it runs. A container of that image then runs, under
  // gVisor with no network and only Paddock's busybox, to delete the login files and Paddock's own files, and the second
  // commit saves the result under the template's name. Volumes (Docker's /var/lib/docker, any the image declares) are
  // not in a commit; neither are gVisor's in-memory folders (/dev/shm, and /tmp when the image's /tmp is empty), nor
  // the engine's /etc/hosts, hostname and resolv.conf.
  async snapshot(manifest: Manifest, name: string): Promise<Template> {
    const { engine } = manifest
    const inspect = await this.inspect(manifest)
    if (!inspect?.Id || !inspect.Image) throw new PaddockError("not-found", `${manifest.name} has no container on ${engine.label}.`)
    if (!seesWrites((await this.runtimeEntry(engine, inspect.HostConfig.Runtime))?.runtimeArgs))
      throw new PaddockError("dependency", `The gVisor runtime ${inspect.HostConfig.Runtime} lacks --overlay2=none, so the engine cannot see the files written in ${manifest.name} and a template would miss them.`)
    const ref = `${templateRepository(this.owner)}:${name}`
    if ((await this.docker(engine, ["image", "inspect", ref])).exitCode === 0) throw new PaddockError("conflict", `A template named ${name} already exists. Remove it first, or choose another name.`)
    const base = await this.docker(engine, ["image", "inspect", inspect.Image])
    let config: NonNullable<ImageInspect["Config"]> = {}
    try { config = (JSON.parse(base.stdout) as ImageInspect[])[0]?.Config ?? {} } catch {}
    if (base.exitCode !== 0) throw new PaddockError("runtime", `The image ${manifest.name} was made from could not be read: ${base.stderr.trim()}`)
    const socket = await this.endpoint(engine)
    const tag = randomBytes(6).toString("hex"); const stage = snapshotRepository(this.owner)
    // The busybox goes in a directory the sandbox could not know of, so nothing it left can redirect the copy.
    const cleaner = `${stage}-${tag}`; const toolDir = `.paddock-snapshot-${tag}/`; const tool = `/${toolDir}busybox`
    try {
      // The image's own settings, not the container's: its entrypoint and command are Paddock's.
      const first = await engineApi(socket, "POST", `/commit?container=${inspect.Id}&repo=${stage}&tag=${tag}&pause=true`, config)
      if (first.status !== 201) throw new PaddockError("runtime", `The engine did not save ${manifest.name}'s files: ${first.body?.message ?? `HTTP ${first.status}`}`)
      // Found again by its name, not a label: a commit copies the container's labels into the image, and from there into
      // every sandbox made from it.
      must(await this.docker(engine, ["create", "--name", cleaner, "--runtime", engine.data.runtime!, "--network", "none",
        "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "64", "--no-healthcheck", "--user", "0", "--entrypoint", tool,
        `${stage}:${tag}`, "env", "-i", tool, "sh", "-c", SNAPSHOT_CLEAN, "clean", tool]), "Preparing the template's clean-up")
      await this.copyIn(engine, cleaner, [{ path: toolDir, mode: 0o755 }, { path: tool.slice(1), mode: 0o755, data: await this.busybox(engine) }], "busybox into the template's clean-up")
      const cleaned = await this.docker(engine, ["start", "-a", cleaner], { timeoutMs: 600_000 })
      const lines = cleaned.stdout.split("\n").filter(Boolean)
      if (cleaned.exitCode !== 0 || lines.at(-1) !== "done") throw new PaddockError("runtime", `The template's clean-up did not finish (exit ${cleaned.exitCode}): ${cleaned.stderr.trim().slice(0, 300)}`)
      const removed = lines.filter((line) => line.startsWith("removed ")).map((line) => line.slice("removed ".length))
      const labels = { ...(config.Labels ?? {}),
        // A commit keeps the source container's labels; these mark sandboxes, and a template is not one.
        [LABEL_NAME]: "", [LABEL_ID]: "",
        [LABEL_TEMPLATE]: name, [LABEL_TEMPLATE_OWNER]: this.owner, [LABEL_TEMPLATE_SOURCE]: manifest.name, [LABEL_TEMPLATE_SOURCE_IMAGE]: manifest.template?.name ? `template ${manifest.template.name}` : manifest.spec.image,
        [LABEL_TEMPLATE_LOGINS]: JSON.stringify(removed) }
      const second = await engineApi(socket, "POST", `/commit?container=${cleaner}&repo=${templateRepository(this.owner)}&tag=${name}&pause=false`, { ...config, Labels: labels })
      if (second.status !== 201) throw new PaddockError("runtime", `The engine did not save the template: ${second.body?.message ?? `HTTP ${second.status}`}`)
    } finally {
      await this.docker(engine, ["rm", "-f", "-v", cleaner])
      await this.docker(engine, ["rmi", `${stage}:${tag}`])
    }
    const made = (await this.templates(engine)).find((template) => template.name === name)
    if (!made) throw new PaddockError("runtime", `The template ${name} was saved but the engine does not list it.`)
    return made
  }

  async templates(engine: Engine): Promise<Template[]> {
    const repository = templateRepository(this.owner)
    const listed = await this.docker(engine, ["image", "ls", "--no-trunc", "--format", "{{.ID}}", repository])
    if (listed.exitCode !== 0) throw new PaddockError("runtime", `The engine did not list images: ${listed.stderr.trim()}`)
    const ids = [...new Set(listed.stdout.split("\n").filter(Boolean))]
    if (!ids.length) return []
    const described = await this.docker(engine, ["image", "inspect", ...ids])
    if (described.exitCode !== 0) throw new PaddockError("runtime", `The engine did not describe its templates: ${described.stderr.trim()}`)
    const containers = await engineApi(await this.endpoint(engine), "GET", "/containers/json?all=true")
    if (containers.status !== 200) throw new PaddockError("runtime", `The engine did not list containers: HTTP ${containers.status}`)
    const users = (containers.body as unknown as Array<{ ImageID: string; Names: string[]; Labels: Record<string, string> | null }>)
    return (JSON.parse(described.stdout) as ImageInspect[]).flatMap((image) => {
      const labels = image.Config?.Labels ?? {}; const name = labels[LABEL_TEMPLATE]
      // Only an image this daemon made, still under the name its label gives.
      if (!name || labels[LABEL_TEMPLATE_OWNER] !== this.owner || !(image.RepoTags ?? []).includes(`${repository}:${name}`)) return []
      let loginsRemoved: string[] = []
      try { loginsRemoved = JSON.parse(labels[LABEL_TEMPLATE_LOGINS] ?? "[]") } catch {}
      return [{ name, engine: engine.id, imageId: image.Id, source: labels[LABEL_TEMPLATE_SOURCE] ?? "", sourceImage: labels[LABEL_TEMPLATE_SOURCE_IMAGE] ?? "",
        createdAt: image.Created ?? "", sizeBytes: image.Size ?? 0, loginsRemoved,
        dependants: users.filter((user) => user.ImageID === image.Id).map((user) => user.Labels?.[LABEL_NAME] || user.Names[0]!.replace(/^\//, "")).sort() }]
    })
  }

  // Sandboxes made from the template keep running and starting: the engine only removes the name while containers use
  // the image, and the image goes with the last of them (dropUnusedTemplates).
  async removeTemplate(engine: Engine, name: string): Promise<{ imageId: string; dependants: string[] }> {
    const template = (await this.templates(engine)).find((entry) => entry.name === name)
    if (!template) throw new PaddockError("not-found", `There is no template named ${name} on ${engine.label}.`)
    must(await this.docker(engine, ["rmi", ...(template.dependants.length ? ["--force"] : []), `${templateRepository(this.owner)}:${name}`]), `Removing the template ${name}`)
    return { imageId: template.imageId, dependants: template.dependants }
  }

  async exec(manifest: Manifest, argv: readonly string[], options: { user?: string; stdin?: string | Uint8Array; signal?: AbortSignal } = {}): Promise<RunResult> {
    if ((await this.status(manifest)) !== "running") throw new PaddockError("conflict", `${manifest.name} is not running. Start it with \`paddock start ${manifest.name}\`.`)
    const tag = randomBytes(8).toString("hex")
    const ran = await this.docker(manifest.engine, ["exec", ...(options.stdin === undefined ? [] : ["-i"]), ...(options.user ? ["-u", options.user] : []), "-e", `PADDOCK_EXEC=${tag}`, container(manifest.name), ...argv], { stdin: options.stdin, signal: options.signal })
    if (!ran.overflow && !options.signal?.aborted) return ran
    // The engine leaves an exec's processes running when its client is killed (measured: one kept a CPU busy), so they
    // are found by the variable they inherited and ended, as the same user: even root cannot read another user's
    // environment inside the sandbox. A process that cleared its environment or changed its user is not found.
    const ended = await this.docker(manifest.engine, ["exec", ...(options.user ? ["-u", options.user] : []), container(manifest.name), "sh", "-c", END_EXEC, "end", tag], { timeoutMs: 30_000 })
    return { ...ran, stderr: ended.exitCode === 0 ? "Its processes inside the sandbox were ended." : `Its processes inside the sandbox could not all be ended (${ended.stderr.trim() || `exit ${ended.exitCode}`}); look for them with ps.` }
  }

  // The engine's own socket, for the exec API: the docker client has no way to hand over a session's bytes as they come,
  // separate stderr without a terminal, or resize one.
  private readonly endpoints = new Map<string, Promise<string>>()
  private endpoint(engine: Engine): Promise<string> {
    const known = this.endpoints.get(engine.id)
    if (known) return known
    const found = (async () => {
      const host = (await this.docker(engine, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", engine.data.context!])).stdout.trim()
      if (!host.startsWith("unix://")) throw new PaddockError("dependency", `Sessions need an engine on a Unix socket; ${engine.label} is at ${host || "an unknown address"}.`)
      return host.slice("unix://".length)
    })()
    found.catch(() => this.endpoints.delete(engine.id))
    this.endpoints.set(engine.id, found)
    return found
  }

  async openExec(manifest: Manifest, argv: readonly string[], options: { user?: string; tty: boolean; cols?: number; rows?: number }): Promise<Session> {
    const inspect = await this.inspect(manifest)
    if (!inspect?.State.Running || !inspect.Id) throw new PaddockError("conflict", `${manifest.name} is not running. Start it with \`paddock start ${manifest.name}\`.`)
    const socket = await this.endpoint(manifest.engine)
    const tag = randomBytes(8).toString("hex")
    // By the container's id, which inspect has just tied to this sandbox's label.
    const created = await engineApi(socket, "POST", `/containers/${inspect.Id}/exec`, {
      AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: options.tty, Cmd: argv, Env: [`PADDOCK_EXEC=${tag}`],
      ...(options.user ? { User: options.user } : {}), ...(options.tty && options.cols && options.rows ? { ConsoleSize: [options.rows, options.cols] } : {}),
    })
    if (created.status !== 201 || typeof created.body?.Id !== "string") throw new PaddockError("runtime", `The engine did not start the command: ${created.body?.message ?? `HTTP ${created.status}`}`)
    const session = new EngineSession(socket, created.body.Id as string, options.tty, () => {
      void this.docker(manifest.engine, ["exec", ...(options.user ? ["-u", options.user] : []), container(manifest.name), "sh", "-c", END_EXEC, "end", tag], { timeoutMs: 30_000 })
    })
    await session.started
    if (options.tty && options.cols && options.rows) await session.resize(options.cols, options.rows).catch(() => {})
    return session
  }

  // From the engine's API, not its CLI: a forward asks before every connection it relays.
  async generation(manifest: Manifest): Promise<string | undefined> {
    const reply = await engineApi(await this.endpoint(manifest.engine), "GET", `/containers/${container(manifest.name)}/json`)
    if (reply.status === 404) return undefined
    const body = reply.body as Inspect | undefined
    if (reply.status !== 200 || !body) throw new PaddockError("runtime", `The engine did not describe ${manifest.name}: HTTP ${reply.status}`)
    if (body.Config.Labels?.[LABEL_ID] !== manifest.id) throw new PaddockError("conflict", `The container ${container(manifest.name)} was not created by this Paddock sandbox (its id label differs). Nothing was done to it.`)
    return body.State.Running && body.Id ? `${body.Id.slice(0, 12)}@${body.State.StartedAt}` : undefined
  }

  // The relay is the static busybox from Paddock's helper image (one file, no libraries), copied into the sandbox through
  // the engine's archive API, so it needs no tool from the sandbox's image and works with any of them. It is given only a
  // number: `busybox nc 127.0.0.1 PORT`. The guest can replace the file, which changes nothing it could not already do
  // with its own loopback.
  private readonly busyboxes = new Map<string, Promise<Uint8Array>>()
  private busybox(engine: Engine): Promise<Uint8Array> {
    const known = this.busyboxes.get(engine.id)
    if (known) return known
    const read = (async () => {
      await this.ensureHelper(engine)
      const output = await this.docker(engine, ["run", "--rm", "--network", "none", "--runtime", "runc", "--entrypoint", "cat", HELPER_IMAGE, "/bin/busybox.static"], { binary: true, timeoutMs: 60_000 })
      if (output.exitCode !== 0 || !output.raw?.length) throw new PaddockError("runtime", `Could not read busybox from the helper image: ${output.stderr.trim()}`)
      return output.raw
    })()
    read.catch(() => this.busyboxes.delete(engine.id))
    this.busyboxes.set(engine.id, read)
    return read
  }

  // Copies files into a container (created or running) through the engine's archive API.
  private async copyIn(engine: Engine, id: string, entries: Parameters<typeof tar>[0], what: string): Promise<void> {
    const response = await fetch(`http://engine/containers/${id}/archive?path=/`, { unix: await this.endpoint(engine), method: "PUT", headers: { "content-type": "application/x-tar" }, body: tar(entries) } as RequestInit)
    if (response.status !== 200) throw new PaddockError("runtime", `The engine did not copy ${what}: ${(await response.text()).trim().slice(0, 300) || `HTTP ${response.status}`}`)
  }

  // gVisor does not show a file the engine adds behind a running guest once the guest has looked in its folder (W10: one
  // `ls /.paddock`, or even a listing of `/` for a new top-level folder), until the sandbox restarts. So the relay is
  // copied in before every start, and again for each forward, which replaces a file the guest can still see.
  private async copyRelay(manifest: Manifest, id: string): Promise<void> {
    await this.copyIn(manifest.engine, id, [{ path: ".paddock/", mode: 0o755 }, { path: RELAY.slice(1), mode: 0o755, data: await this.busybox(manifest.engine) }], `the relay into ${manifest.name}`)
  }

  async prepareLoopback(manifest: Manifest): Promise<void> {
    const inspect = await this.inspect(manifest)
    if (!inspect?.State.Running || !inspect.Id) throw new PaddockError("conflict", `${manifest.name} is not running. Start it with \`paddock start ${manifest.name}\`.`)
    await this.copyRelay(manifest, inspect.Id)
    // A guest that removed the relay while running cannot see the new copy; say so rather than relay the engine's error.
    const tried = await this.exec(manifest, [RELAY, "true"])
    if (tried.exitCode !== 0) throw new PaddockError("runtime", `The relay at ${RELAY} does not run inside ${manifest.name}: something inside removed or replaced it while the sandbox ran, and a new copy is not visible until it restarts. Stop and start ${manifest.name}, then add the forward again. ${tried.stderr.trim().slice(0, 300)}`)
  }

  dialLoopback(manifest: Manifest, port: number): Promise<Session> {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new PaddockError("usage", "A port is a whole number from 1 to 65535.")
    return this.openExec(manifest, [RELAY, "nc", "127.0.0.1", String(port)], { tty: false })
  }

  async diskUsedBytes(manifest: Manifest): Promise<number | undefined> {
    const output = await this.docker(manifest.engine, ["inspect", "--size", "--format", "{{.SizeRw}}", container(manifest.name)], { timeoutMs: 120_000 })
    const layer = Number(output.stdout.trim())
    if (output.exitCode !== 0 || !Number.isFinite(layer)) return undefined
    // Outside the writable layer: volumes the image declares, and the engine's own /etc/hosts, /etc/hostname and
    // /etc/resolv.conf, files on the engine's host that the sandbox's root can grow (measured: 1.3 GB in /etc/hosts went
    // uncounted). They are measured by the helper, not by the sandbox's own du, which an agent could replace.
    const inspect = await this.inspect(manifest)
    const volumes = (inspect?.Mounts ?? []).filter((mount) => mount.Type === "volume").map((mount) => mount.Destination)
    const files = [inspect?.HostsPath, inspect?.HostnamePath, inspect?.ResolvConfPath].filter((path): path is string => Boolean(path))
    if (!volumes.length && !files.length) return layer
    const du = await this.docker(manifest.engine, ["run", "--rm", "--runtime", "runc", "--network", "none", ...(volumes.length ? ["--volumes-from", `${container(manifest.name)}:ro`] : []),
      ...files.flatMap((path, index) => ["--mount", `type=bind,src=${path},dst=/paddock-engine-files/${index},readonly`]),
      "--entrypoint", "du", HELPER_IMAGE, "-sk", ...volumes, ...files.map((_, index) => `/paddock-engine-files/${index}`)], { timeoutMs: 300_000 })
    const sizes = du.stdout.split("\n").filter(Boolean).map((line) => Number(line.split("\t")[0]) * 1024)
    if (du.exitCode !== 0 || sizes.length !== volumes.length + files.length || !sizes.every(Number.isFinite)) return undefined
    return layer + sizes.reduce((sum, size) => sum + size, 0)
  }

  // Probe helpers left behind by a daemon that died mid-probe.
  async sweep(engine: Engine): Promise<void> {
    const stale = (await this.docker(engine, ["ps", "-aq", "--filter", `label=dev.paddock.probe=${this.owner}`])).stdout.split("\n").filter(Boolean)
    if (stale.length) await this.docker(engine, ["rm", "-f", ...stale])
    const networks = (await this.docker(engine, ["network", "ls", "--format", "{{.Name}}", "--filter", `label=dev.paddock.probe=${this.owner}`])).stdout.split("\n").filter(Boolean)
    if (networks.length) await this.docker(engine, ["network", "rm", ...networks])
    const cleaners = (await this.docker(engine, ["ps", "-aq", "--filter", `name=^${snapshotRepository(this.owner)}-[0-9a-f]+$`])).stdout.split("\n").filter(Boolean)
    if (cleaners.length) await this.docker(engine, ["rm", "-f", "-v", ...cleaners])
    const staged = (await this.docker(engine, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}", snapshotRepository(this.owner)])).stdout.split("\n").filter(Boolean)
    if (staged.length) await this.docker(engine, ["rmi", ...staged])
    await this.dropUnusedTemplates(engine)
  }

  async checks(manifest: Manifest, stage: Stage): Promise<CheckResult[]> {
    const inspect = await this.inspect(manifest)
    if (!inspect) throw new PaddockError("not-found", `${manifest.name} has no container on ${manifest.engine.label}.`)
    if (stage === "config") {
      const { engine, name } = manifest
      const bridgeName = await this.docker(engine, ["network", "inspect", "--format", '{{index .Options "com.docker.network.bridge.name"}}', network(name)])
      let volumes: VolumeInspect[] | undefined
      if (manifest.spec.docker) {
        const names = (inspect.Mounts ?? []).flatMap((mount) => mount.Type === "volume" && mount.Name ? [mount.Name] : [])
        if (names.length) {
          const read = await this.docker(engine, ["volume", "inspect", ...names])
          if (read.exitCode === 0) { try { volumes = JSON.parse(read.stdout) as VolumeInspect[] } catch {} }
        }
      }
      let image: ImageInspect | undefined
      const described = inspect.Image ? await this.docker(engine, ["image", "inspect", inspect.Image]) : undefined
      if (described?.exitCode === 0) { try { image = (JSON.parse(described.stdout) as ImageInspect[])[0] } catch {} }
      return configChecks(inspect, manifest, await this.guardState(engine), bridgeName.exitCode === 0 ? bridgeName.stdout.trim() : undefined, volumes, image, this.owner)
    }
    if (stage === "runtime") {
      const kernel = await this.kernelCheck(manifest, inspect)
      const dns = kernel.status === "pass" ? await this.dnsCheck(manifest) : result("dns", "unknown", "none", "DNS was not set or read because the isolated kernel check did not pass.")
      if (!manifest.spec.docker) return [kernel, dns, result("docker", "info", "inspected", "Not requested; no capabilities are added for inner Docker.")]
      const info = kernel.status === "pass" ? await this.dockerInfo(manifest) : undefined
      return [kernel, dns, info?.exitCode === 0 && info.stdout.trim() === `/var/lib/docker ${DOCKER_DRIVER}` ? result("docker", "pass", "probed", `The private Docker daemon answers on its Unix socket inside gVisor, with its data in /var/lib/docker on the copy-on-write ${DOCKER_DRIVER} driver. It is the sandbox's main process; if it exits, the sandbox stops. Inner containers inherit the sandbox's public DNS fallback of 1.1.1.1 and 8.8.8.8 at creation; the separate DNS check reports its current configuration.`)
        : result("docker", "fail", "probed", `The requested inner Docker daemon did not answer with /var/lib/docker on the ${DOCKER_DRIVER} driver: ${info ? `${info.stdout.trim()} ${info.stderr.trim()}` : "the isolated kernel check did not pass"}`)]
    }
    const next = (this.probing.get(manifest.engine.id) ?? Promise.resolve()).then(() => this.probe(manifest, inspect))
    this.probing.set(manifest.engine.id, next.catch(() => {}))
    return next
  }

  private dockerInfo(manifest: Manifest): Promise<RunResult> {
    return this.docker(manifest.engine, ["exec", "-u", "0", container(manifest.name), "docker", "--host", "unix:///var/run/docker.sock", "info", "--format", "{{.DockerRootDir}} {{.Driver}}"], { timeoutMs: 10_000 })
  }

  // Read first and write only a file that differs, so a pass every 30 seconds does not rewrite it. Docker may reset this
  // engine-owned file across a restart, even with the container still running.
  private async dnsCheck(manifest: Manifest): Promise<CheckResult> {
    const scope = "Under gVisor the engine's per-network resolver at 127.0.0.11 refuses queries. This checks configuration, not a live lookup or existing inner containers' resolver state."
    try {
      const found = await this.docker(manifest.engine, ["exec", "-u", "0", container(manifest.name), "cat", "/etc/resolv.conf"])
      if (found.exitCode === 0 && found.stdout === SANDBOX_DNS)
        return result("dns", "pass", "inspected", `Read /etc/resolv.conf: Paddock's public fallback resolvers 1.1.1.1 and 8.8.8.8, bypassing the engine's per-network resolver; nothing was written. ${scope}`)
      const before = found.exitCode === 0 ? "had been reset to other content" : `could not be read (${found.stderr.trim()})`
      const dns = await this.docker(manifest.engine, ["exec", "-i", "-u", "0", container(manifest.name), "sh", "-c", "cat > /etc/resolv.conf && cat /etc/resolv.conf"], { stdin: SANDBOX_DNS })
      if (dns.exitCode !== 0) return result("dns", "unknown", "none", `/etc/resolv.conf ${before}, and the DNS fallback could not be set and read back: ${dns.stderr.trim()}`)
      return dns.stdout === SANDBOX_DNS ? result("dns", "pass", "inspected", `/etc/resolv.conf ${before}; Paddock restored its public fallback resolvers 1.1.1.1 and 8.8.8.8 and read them back. ${scope}`)
        : result("dns", "fail", "inspected", `/etc/resolv.conf ${before}, and the file read back after restoring it differs from Paddock's public DNS fallback.`)
    } catch (error) { return result("dns", "unknown", "none", `The DNS fallback could not be read, set and read back: ${(error as Error).message}`) }
  }

  // The runtime the engine reports, confirmed from inside: gVisor's kernel log and version string name it.
  private async kernelCheck(manifest: Manifest, inspect: Inspect): Promise<CheckResult> {
    const { engine, name } = manifest
    const entry = await this.runtimeEntry(engine, inspect.HostConfig.Runtime)
    if (!isGvisor(entry?.path)) return result("kernel", "fail", "inspected", `The container's runtime is ${inspect.HostConfig.Runtime}, which is not gVisor.`)
    const unsafe = unsafeRuntimeArgs(entry?.runtimeArgs)
    if (unsafe.length) return result("kernel", "fail", "inspected", `The gVisor runtime ${inspect.HostConfig.Runtime} is registered with ${unsafe.join(", ")}, which opens a path to the host or switches a limit off.`)
    if (manifest.spec.docker && !(hasRawNetwork(entry?.runtimeArgs) && seesWrites(entry?.runtimeArgs))) return result("kernel", "fail", "inspected", "Inner Docker needs a gVisor runtime with --net-raw and --overlay2=none, for its NAT and disk measurement.")
    const inside = await this.docker(engine, ["exec", container(name), "sh", "-c", "dmesg 2>/dev/null | head -n 3; cat /proc/version"])
    if (inside.exitCode !== 0) return result("kernel", "unknown", "inspected", `The runtime is gVisor (${inspect.HostConfig.Runtime}), but that could not be confirmed from inside: ${inside.stderr.trim()}`)
    return /gvisor/i.test(inside.stdout) ? result("kernel", "pass", "probed", `gVisor (${inspect.HostConfig.Runtime}); its kernel answers inside the sandbox.`)
      : result("kernel", "fail", "probed", "The kernel inside the sandbox does not identify as gVisor.")
  }

  // Live attempts from where the sandbox sits on the network. A helper container joins the sandbox's own network, with
  // the sandbox's runtime, and tries to connect to: a listener on the engine's host, and a listener on another guarded
  // network (a stand-in for another sandbox). Each "blocked" result counts only if its controls answered: the host can
  // reach the helper (its network works) and the host can reach each listener (they are up).
  private async probe(manifest: Manifest, inspect: Inspect): Promise<CheckResult[]> {
    const { engine, name } = manifest
    if (!inspect.State.Running) return []
    const tag = randomBytes(4).toString("hex")
    const hostC = `paddock-probe-${tag}-host`; const peerC = `paddock-probe-${tag}-peer`; const probeC = `paddock-probe-${tag}-probe`
    const peerNet = `paddock-net-probe-${tag}`
    const listen = (port: string, address?: string) => ["nc", "-lk", "-p", port, ...(address ? ["-s", address] : []), "-e", "echo", PROBE_REPLY]
    const runHelper = (cname: string, runtime: string, net: string, command: string[], privileged = false) =>
      this.docker(engine, ["run", "-d", "--rm", "--name", cname, "--label", `dev.paddock.probe=${this.owner}`, "--runtime", runtime, "--network", net, "--memory", "64m", "--pids-limit", "64", ...(privileged ? ["--privileged", "-u", "0"] : []), HELPER_IMAGE, ...command], { timeoutMs: 60_000 })
    const address = async (cname: string) => (await this.docker(engine, ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", cname])).stdout.trim()
    // True when the listener's reply comes back.
    const reaches = async (from: string, ip: string, port: string) =>
      (await this.docker(engine, ["exec", from, "nc", "-w", "2", ip, port], { timeoutMs: 15_000 })).stdout.includes(PROBE_REPLY)
    // For targets without a listener of ours: true when the TCP connection opens.
    const connects = async (from: string, ip: string, port: string) =>
      (await this.docker(engine, ["exec", from, "sh", "-c", 'nc -w 3 "$1" "$2" </dev/null', "connect", ip, port], { timeoutMs: 15_000 })).exitCode === 0
    // The inner probe runs from the helper image by its ID, so no other image inside the sandbox can stand in for it.
    let probeImage = ""
    const inner = async (ip: string, port: string) => {
      const attempt = await innerDocker(["run", "--rm", "--pull", "never", probeImage, "sh", "-c", 'nc -w 2 "$1" "$2" </dev/null', "connect", ip, port])
      if (attempt.exitCode !== 0 && attempt.exitCode !== 1) throw new Error(`The inner probe could not run (exit ${attempt.exitCode}): ${attempt.stderr.trim()}`)
      return attempt
    }
    const retry = async (attempt: () => Promise<boolean>, attempts = 8) => {
      for (let i = 0; i < attempts; i++) { if (await attempt()) return true; await Bun.sleep(400) }
      return false
    }
    const out: CheckResult[] = []
    const innerDocker = (args: string[], stdin?: Uint8Array) => this.docker(engine, ["exec", ...(stdin ? ["-i"] : []), "-u", "0", container(name), "docker", "--host", "unix:///var/run/docker.sock", ...args], { timeoutMs: 120_000, stdin })
    let removeProbeImage = false
    let teardownFailure: string | undefined
    try {
      await this.ensureHelper(engine)
      if (manifest.spec.docker) {
        const used = await this.diskUsedBytes(manifest)
        if (used === undefined) throw new Error("Inner Docker probe disk headroom could not be measured.")
        if (manifest.spec.diskGb * 1024 ** 3 - used < 64 * 1024 ** 2) throw new Error("Inner Docker probe needs 64 MiB of disk headroom; the sandbox is nearly full. Free space and verify again.")
        // The probe image is the engine's own helper, copied in as bytes (docker save, then docker load on exec's
        // stdin), so verify never asks a registry for it and works offline or behind a mirror.
        const want = (await this.docker(engine, ["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE])).stdout.trim()
        if (!/^sha256:[0-9a-f]{64}$/.test(want)) throw new Error("The helper image's ID could not be read on the engine.")
        const innerId = async () => {
          const present = await innerDocker(["image", "inspect", "--format", "{{.Id}}", HELPER_IMAGE])
          if (present.exitCode !== 0 && !/No such image/i.test(present.stderr)) throw new Error(`Could not inspect the inner probe image: ${present.stderr.trim()}`)
          return present.exitCode === 0 ? present.stdout.trim() : undefined
        }
        const before = await innerId()
        if (before !== undefined && before !== want) throw new Error(`The image ${HELPER_IMAGE} inside the sandbox is not Paddock's helper (its ID differs), so it cannot be used as the probe. Remove it inside the sandbox and verify again.`)
        if (before === undefined) {
          removeProbeImage = true
          const saved = await this.docker(engine, ["save", HELPER_IMAGE], { binary: true, timeoutMs: 120_000 })
          if (saved.exitCode !== 0 || !saved.raw) throw new Error(`The helper image could not be read from the engine: ${saved.stderr.trim()}`)
          const loaded = await innerDocker(["load", "-q"], saved.raw)
          if (loaded.exitCode !== 0) throw new Error(`The helper image could not be loaded into the sandbox's Docker: ${loaded.stderr.trim()}`)
          if (await innerId() !== want) throw new Error("The image loaded into the sandbox's Docker does not have the helper's ID.")
        }
        probeImage = want
      }
      const gateway = (await this.docker(engine, ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", network(name)])).stdout.trim()
      const hostPort = String(20_000 + Math.floor(Math.random() * 40_000))
      must(await this.docker(engine, ["network", "create", "--label", `dev.paddock.probe=${this.owner}`, "-o", `com.docker.network.bridge.name=${BRIDGE_PREFIX}x${tag}`, peerNet]), "Creating the probe network")
      must(await runHelper(hostC, "runc", "host", ["sh", "-c", hostProbeScript(tag, gateway, hostPort)], true), "Starting the host listener")
      must(await runHelper(peerC, "runc", peerNet, listen(PROBE_PORT)), "Starting the peer listener")
      must(await runHelper(probeC, engine.data.runtime!, network(name), listen(PROBE_PORT)), "Starting the probe")
      const [peerIp, probeIp] = [await address(peerC), await address(probeC)]
      const hostLog = async () => (await this.docker(engine, ["logs", hostC])).stdout
      if (!await retry(async () => (await hostLog()).includes("ready"), 40)) throw new Error("The host listener did not get ready.")
      const log = await hostLog()
      if (log.includes("teardown-timeout")) {
        teardownFailure = "A previous Paddock probe has not finished tearing down its routes; no weaker evidence was substituted."
        throw new Error(teardownFailure)
      }
      const far = log.split("\n").filter((line) => line.startsWith("far ")).map((line) => line.slice(4).trim())

      const probeAlive = await retry(() => reaches(hostC, probeIp, PROBE_PORT))
      const innerOnline = !manifest.spec.docker || (await inner("1.1.1.1", "443")).exitCode === 0
      const hostListening = probeAlive && innerOnline && await retry(() => reaches(hostC, gateway, hostPort))
      const peerListening = probeAlive && innerOnline && await retry(() => reaches(hostC, peerIp, PROBE_PORT))
      const anyReaches = async (ip: string, port: string) => await reaches(probeC, ip, port) || Boolean(manifest.spec.docker && (await inner(ip, port)).stdout.includes(PROBE_REPLY))
      const where = manifest.spec.docker ? "the sandbox's network and an inner Docker container" : "the sandbox's network"
      const noControl = (what: string) => `Not checked: ${!innerOnline ? "the inner container did not reach the internet control" : `${what} did not answer a control connection`}, so a blocked attempt would prove nothing.`

      out.push(!hostListening ? result("net-host", "unknown", "none", noControl(probeAlive ? "the listener on the host" : "the probe"))
        : await anyReaches(gateway, hostPort) ? result("net-host", "fail", "probed", `A connection from ${where} reached a listener on the engine's host (${gateway}).`)
        : result("net-host", "pass", "probed", `A listener on the engine's host (${gateway}) answered the host and was unreachable from ${where}.`))
      out.push(!peerListening ? result("net-peers", "unknown", "none", noControl(probeAlive ? "the stand-in sandbox" : "the probe"))
        : await anyReaches(peerIp, PROBE_PORT) ? result("net-peers", "fail", "probed", `A connection from ${where} reached a container on another sandbox network.`)
        : result("net-peers", "pass", "probed", `A container on another sandbox network answered the host and was unreachable from ${where}.`))

      const guard = await this.guardState(engine)
      const metadata = probeAlive && (await connects(probeC, "169.254.169.254", "80") || Boolean(manifest.spec.docker && (await inner("169.254.169.254", "80")).exitCode === 0))
      // Each far listener counts only if the host reached it first.
      const tried: string[] = []; const reached: string[] = []; const failedControls: string[] = []
      for (const ip of probeAlive && innerOnline ? far : []) {
        if (!await retry(() => reaches(hostC, ip, PROBE_PORT))) { failedControls.push(ip); continue }
        tried.push(ip)
        if (await anyReaches(ip, PROBE_PORT)) reached.push(ip)
      }
      const rangeOf = (ip: string) => FAR_RANGES.find(([address]) => ip.startsWith(address))![1]
      const untried = FAR_RANGES.filter(([address]) => !far.some((ip) => ip.startsWith(address))).map(([, range]) => range)
      const rest = `${untried.length ? ` Not probed, because the engine's host already uses the stand-in address: ${untried.join("; ")}.` : ""}${failedControls.length ? ` Not probed, because the host control did not answer (not an address collision): ${failedControls.join(", ")}.` : ""} The metadata address did not answer. IPv6 is dropped by the same rules and was not probed. No device on your own LAN or tailnet was contacted.`
      out.push(guard === "missing" || guard === "changed" ? result("net-private", "fail", "inspected", `The guard rules on the engine's host are ${guard}, so nothing is known to drop these destinations.`)
        : reached.length ? result("net-private", "fail", "probed", `A connection from the sandbox's network reached ${reached.map((ip) => `${ip} (in ${rangeOf(ip)})`).join(", ")}.`)
        : metadata ? result("net-private", "fail", "probed", "The cloud metadata address answered from the sandbox's network.")
        : guard === "unknown" ? result("net-private", "unknown", "none", "The guard rules on the engine's host could not be read.")
        : !innerOnline ? result("net-private", "unknown", "none", "The inner container did not reach the internet control, so its blocked attempts would prove nothing.")
        : !probeAlive || (far.length > 0 && !tried.length) ? result("net-private", "unknown", "none", noControl("the stand-in listeners") + rest)
        : tried.length ? result("net-private", "pass", "probed", `Stand-in listeners at ${tried.map((ip) => `${ip} (in ${rangeOf(ip)})`).join(", ")} answered the host and were unreachable from ${where}.${rest}`)
        : result("net-private", "pass", "inspected", `The loaded rules match Paddock's, which drop private, tailnet, link-local and IPv6 destinations. No stand-in listener could be set up on the engine's host, so none of them was probed.`))

      out.push(!probeAlive ? result("egress", "unknown", "none", noControl("the probe"))
        : innerOnline && await connects(probeC, "1.1.1.1", "443") ? result("egress", "info", "probed", `Open: ${manifest.spec.docker ? "the sandbox and an inner Docker container can" : "the sandbox can"} reach the internet, so anything inside it can be sent out.`)
        : result("egress", "info", "probed", "The internet did not answer (this machine may be offline)."))
    } catch (error) {
      for (const id of ["net-host", "net-peers", "net-private", "egress"] as const)
        if (!out.some((entry) => entry.id === id)) out.push(result(id, "unknown", "none", `The probe could not run: ${(error as Error).message}`))
    } finally {
      await this.docker(engine, ["rm", "-f", hostC, peerC, probeC])
      await this.docker(engine, ["network", "rm", peerNet])
      const cleaned = await this.docker(engine, ["run", "--rm", "--runtime", "runc", "--privileged", "--network", "host", HELPER_IMAGE, "sh", "-c", probeCleanupScript(tag)], { timeoutMs: 30_000 })
      if (cleaned.exitCode !== 0) {
        teardownFailure = `The probe's links and routes did not finish tearing down: ${cleaned.stderr.trim()}`
      }
      if (removeProbeImage) {
        const removed = await innerDocker(["image", "rm", HELPER_IMAGE])
        if (removed.exitCode !== 0 && !/No such image/i.test(removed.stderr)) {
          const detail = `The inner probe image could not be cleaned up: ${removed.stderr.trim()}`
          for (const check of out) {
            if (check.status === "fail") check.detail += ` ${detail}`
            else Object.assign(check, { status: "unknown", evidence: "none", detail })
          }
        }
      }
    }

    if (teardownFailure) throw new PaddockError("runtime", teardownFailure)

    const script = `for home in /root /home/*; do for file in ${CREDENTIAL_FILES.map((file) => `"$home"/${file}`).join(" ")}; do [ -e "$file" ] && echo "$file"; done; done; true`
    const found = await this.docker(engine, ["exec", "-u", "0", container(name), "sh", "-c", script])
    const files = found.stdout.split("\n").filter(Boolean)
    out.push(found.exitCode !== 0 ? result("credentials", "unknown", "none", `Could not look: ${found.stderr.trim()}`)
      : files.length ? result("credentials", "info", "probed", `Found ${files.join(", ")}. An agent in the sandbox can read these and send them out.`)
      : result("credentials", "info", "probed", "None of the usual login files (Claude, Codex, GitHub, git, SSH keys, AWS, netrc) are present."))
    return out
  }
}

// A tar archive of directories and files, for the engine's archive API. Only what Paddock writes, so only ustar basics.
export function tar(entries: ReadonlyArray<{ path: string; mode: number; data?: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512); const size = entry.data?.length ?? 0
    const field = (offset: number, length: number, value: string) => header.write(value, offset, length, "latin1")
    const octal = (offset: number, length: number, value: number) => field(offset, length, value.toString(8).padStart(length - 1, "0"))
    if (Buffer.byteLength(entry.path) > 99) throw new Error(`${entry.path} is too long for a tar header.`)
    field(0, 100, entry.path); octal(100, 8, entry.mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, size); octal(136, 12, 0)
    field(156, 1, entry.data ? "0" : "5"); field(257, 6, "ustar\0"); field(263, 2, "00")
    field(148, 8, " ".repeat(8))
    octal(148, 7, header.reduce((sum, byte) => sum + byte, 0))
    blocks.push(header)
    if (entry.data) { blocks.push(entry.data); if (size % 512) blocks.push(new Uint8Array(512 - (size % 512))) }
  }
  blocks.push(new Uint8Array(1024))
  return Buffer.concat(blocks)
}

// One request to the engine's API on its Unix socket.
async function engineApi(socket: string, method: string, path: string, body?: unknown): Promise<{ status: number; body?: Record<string, any> }> {
  const response = await fetch(`http://engine${path}`, { unix: socket, method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) } as RequestInit)
  const text = await response.text()
  try { return { status: response.status, body: text ? JSON.parse(text) : undefined } } catch { return { status: response.status, body: { message: text.slice(0, 500) } } }
}

// An exec started through the engine's API, its connection taken over for the command's bytes. Without a terminal the
// engine sends 8-byte headers (stream, 0, 0, 0, length) before each piece of output; they are removed here as the bytes
// arrive, without collecting a whole piece.
class EngineSession extends EventEmitter implements Session {
  readonly started: Promise<void>
  private readonly connection: Socket
  private ended = false
  private header = Buffer.alloc(0); private remaining = 0; private stream: "stdout" | "stderr" = "stdout"
  constructor(private readonly socket: string, private readonly id: string, readonly tty: boolean, private readonly endProcesses: () => void) {
    super()
    this.connection = connect(socket)
    const body = JSON.stringify({ Detach: false, Tty: tty })
    this.started = new Promise((resolve, reject) => {
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf("\r\n\r\n")
        if (end < 0) { if (head.length > 16_384) fail(new Error("The engine's reply has no end of headers.")); return }
        const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1]
        if (status !== "101" && status !== "200") return fail(new Error(`The engine refused the session: ${head.subarray(end + 4).toString("utf8").trim().slice(0, 300) || `HTTP ${status}`}`))
        this.connection.off("data", onData); this.connection.off("error", fail)
        this.connection.on("data", (data: Buffer) => this.take(data))
        this.connection.on("drain", () => this.emit("drain"))
        this.connection.on("end", () => void this.finish())
        this.connection.on("close", () => void this.finish())
        this.connection.on("error", () => {})
        resolve()
        const rest = head.subarray(end + 4)
        if (rest.length) this.take(rest)
      }
      const fail = (error: Error) => { this.connection.destroy(); reject(new PaddockError("runtime", error.message)) }
      this.connection.on("data", onData); this.connection.on("error", fail)
      this.connection.write(`POST /exec/${id}/start HTTP/1.1\r\nHost: engine\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    })
  }

  private take(data: Buffer): void {
    if (this.tty) { this.emit("output", "stdout", data); return }
    let at = 0
    while (at < data.length) {
      if (this.remaining === 0) {
        const need = 8 - this.header.length
        this.header = Buffer.concat([this.header, data.subarray(at, at + need)]); at += need
        if (this.header.length < 8) return
        this.stream = this.header[0] === 2 ? "stderr" : "stdout"; this.remaining = this.header.readUInt32BE(4); this.header = Buffer.alloc(0)
        continue
      }
      const piece = data.subarray(at, at + this.remaining)
      at += piece.length; this.remaining -= piece.length
      this.emit("output", this.stream, piece)
    }
  }

  // The connection ends after the command's last output; the exit code is asked for afterwards.
  private async finish(): Promise<void> {
    if (this.ended) return
    this.ended = true
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await engineApi(this.socket, "GET", `/exec/${this.id}/json`).catch(() => undefined)
      if (!state || state.status !== 200) break
      if (state.body?.Running === false && typeof state.body.ExitCode === "number") { this.emit("end", { code: state.body.ExitCode }); return }
      await Bun.sleep(50)
    }
    this.emit("end", { error: "The session ended without an exit status (the sandbox may have stopped)." })
  }

  write(bytes: Uint8Array): boolean { return this.connection.write(bytes) }
  // A terminal's input is keystrokes; closing it would end the session.
  end(): void { if (!this.tty) this.connection.end() }
  pause(): void { this.connection.pause() }
  resume(): void { this.connection.resume() }
  async resize(cols: number, rows: number): Promise<void> {
    const reply = await engineApi(this.socket, "POST", `/exec/${this.id}/resize?h=${rows}&w=${cols}`)
    if (reply.status !== 200 && reply.status !== 201) throw new PaddockError("runtime", `The engine did not resize the terminal: HTTP ${reply.status}`)
  }
  close(reason = "The session was closed."): void {
    if (this.ended) { this.connection.destroy(); return }
    this.ended = true
    this.connection.destroy()
    this.endProcesses()
    this.emit("end", { error: reason })
  }
}

// What to do on an engine without a usable gVisor runtime. The OrbStack steps are the ones this was developed on.
export function gvisorSetup(os = "", architecture = ""): string {
  const arch = /arm64|aarch64/.test(architecture) ? "aarch64" : "x86_64"
  const runtime = (path: string) => `"runtimes": { "runsc": { "path": "${path}", "runtimeArgs": ["--allow-suid", "--overlay2=none"] } }`
  const download = `https://storage.googleapis.com/gvisor/releases/release/latest/${arch}/runsc (check it against runsc.sha512 beside it)`
  if (os === "OrbStack") return `1. Download ${download} into a folder under your home, such as ~/.local/share/paddock/gvisor, and make it executable. 2. Add to ~/.orbstack/config/docker.json: ${runtime("/Users/YOU/.local/share/paddock/gvisor/runsc")}. 3. Run \`orb restart docker\` (it stops running containers).`
  return `1. Install gVisor: download ${download} to /usr/local/bin/runsc and make it executable, or follow https://gvisor.dev/docs/user_guide/install/. 2. Add to /etc/docker/daemon.json: ${runtime("/usr/local/bin/runsc")}. 3. Restart the engine, for example \`sudo systemctl restart docker\` (it stops running containers).`
}
