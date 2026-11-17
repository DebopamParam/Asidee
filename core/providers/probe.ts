// Routes owned by a preceding probe are teardown in progress, not somebody else's occupied address.
export const WAIT_FOR_PROBE_ROUTES = `wait_probe_routes() {
  for attempt in $(seq 1 "\${2:-100}"); do
    routes=$(ip -o -4 route show match "$1") || return 1
    if ! printf '%s\\n' "$routes" | grep -Eq ' dev pv[0-9a-f]{8}a( |$)'; then return 0; fi
    sleep 0.1
  done
  echo "Asidee probe teardown timed out for $1" >&2
  return 1
}`

export function probeCleanupScript(tag: string): string {
  return `set -e
if ip link show dev pv${tag}a >/dev/null 2>&1; then ip link del dev pv${tag}a; fi
for attempt in $(seq 1 100); do
  links=$(ip -o link show)
  routes=$(ip -o -4 route show; ip -o -6 route show)
  if ! printf '%s\\n' "$links" | grep -Eq ': (pv${tag}a|asdx${tag})(@|:)' &&
     ! printf '%s\\n' "$routes" | grep -Eq ' dev (pv${tag}a|asdx${tag})( |$)'; then exit 0; fi
  sleep 0.1
done
echo 'Asidee probe teardown timed out: pv${tag}a or asdx${tag} still owns a link or route' >&2
exit 1`
}
