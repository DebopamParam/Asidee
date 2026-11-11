#!/usr/bin/env python3
"""Move T3 Code threads that hit a usage limit onto another logged-in account of the same provider, and resume them.

When the newest run of a top-level thread failed with T3's "usage_limit" class, it marks that account limited, picks
the next account of the same provider (Claude to Claude, Codex to Codex) that is enabled, logged in and not limited, and
starts a small helper thread on it. The helper switches the stuck thread to that account with T3's own tools (T3 hands
the conversation over), keeping its exact model and options, sends it a resume message, and archives itself. When every account of that
provider is limited, the thread waits, and the first account whose limit resets takes it: its own account (it is just
told to resume) or another one (it is moved first). A thread never changes provider or model. It only reads T3's
database, so an idle check costs nothing.

This sandbox copy follows sandbox-manager's account rotation. Its logs and helper titles omit private thread data,
and disabled accounts are excluded when resuming their own threads.

Usage: rotate.py --watch [--providers claude,codex]   check every 2 minutes until stopped
       rotate.py [--providers ...]                     check once
       rotate.py --dry-run ...                         print what it would do
       rotate.py --force THREAD_ID                     rotate that thread now, limited or not (for testing)
"""
from __future__ import annotations
import json, os, shutil, signal, sqlite3, subprocess, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HOME = Path.home()
T3_HOME = Path(os.environ.get("T3CODE_HOME", HOME / ".t3"))
T3_DB = T3_HOME / "userdata/statev2.sqlite"
T3_SETTINGS = T3_HOME / "userdata/settings.json"
STATE = HOME / ".local/state/t3-account-rotator/state.json"
WATCH_INTERVAL = 120
# How long an account counts as limited when the provider gives no reset time (both use 5-hour windows).
UNKNOWN_RESET = timedelta(hours=5)
# A thread waiting for its own account resumes this long after the reset, so T3's own auto-resume goes first; a thread
# it resumed no longer shows a failed run.
RESUME_GRACE = timedelta(minutes=5)
# A start picks up threads limited this long before it, so ones stuck while the rotator was off are moved too.
LOOKBACK = timedelta(hours=6)

# T3's driver for each provider, and how to ask that provider's CLI whether a login folder is logged in.
DRIVERS = {"claude": "claudeAgent", "codex": "codex"}
LOGIN_CHECK = {"claudeAgent": (["claude", "auth", "status"], "CLAUDE_CONFIG_DIR"), "codex": (["codex", "login", "status"], "CODEX_HOME")}
RESUME = ("Your previous account hit its usage limit, so this thread was moved to another account. Continue your task "
          "from where you left off. Sub-agents that were running when the limit hit have stopped: check which ones did "
          "not finish and restart each of them with its original brief, plus whatever progress it had already reported, "
          "then carry on with the overall task.")
RESUME_SAME = ("Your account's usage limit has reset. Continue your task from where you left off. Sub-agents that were "
               "running when the limit hit have stopped: check which ones did not finish and restart each of them with "
               "its original brief, plus whatever progress it had already reported, then carry on with the overall task.")

FAILED_ON_LIMIT = """
with latest as (
  select r.thread_id, r.run_id, r.provider_instance_id, r.status, r.completed_at,
         row_number() over (partition by r.thread_id order by r.ordinal desc) n
  from orchestration_v2_projection_runs r)
select l.thread_id, l.run_id, l.provider_instance_id, l.completed_at, t.project_id, t.payload_json,
       (select json_extract(i.payload_json, '$.failure.resetAt') from orchestration_v2_projection_turn_items i
        where i.run_id = l.run_id and i.type = 'error'
          and json_extract(i.payload_json, '$.failure.class') = 'usage_limit' limit 1) reset_at
from latest l join orchestration_v2_projection_threads t using (thread_id)
where l.n = 1 and l.status = 'failed' and t.archived_at is null and t.deleted_at is null
  and json_extract(t.payload_json, '$.lineage.parentThreadId') is null
  and exists (select 1 from orchestration_v2_projection_turn_items i where i.run_id = l.run_id and i.type = 'error'
              and json_extract(i.payload_json, '$.failure.class') = 'usage_limit')
"""


def now() -> datetime: return datetime.now(timezone.utc)
def iso(t: datetime) -> str: return t.isoformat(timespec="seconds")
def log(message: str):
    event = ("watching" if message.startswith("rotating ") else "rotation requested" if message.startswith("rotate ")
             else "resume requested" if message.startswith("resume ") else "check failed" if message.startswith("check failed")
             else "log entry (details withheld)")
    print(f"{iso(now())} {event}", flush=True)


def parse_time(value) -> datetime | None:
    # T3 stores times as ISO strings (often with a Z) or as epoch milliseconds.
    if value is None or value == "": return None
    if isinstance(value, (int, float)): return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc)
    t = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    return t if t.tzinfo else t.replace(tzinfo=timezone.utc)


def arg(flag: str) -> str | None:
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv and sys.argv.index(flag) + 1 < len(sys.argv) else None


def t3_cli() -> str:
    # The Mac app's launcher, else the newest release T3 Code's SSH runner installed (sandboxes).
    if os.access(T3_HOME / "bin/t3", os.X_OK): return str(T3_HOME / "bin/t3")
    versions = sorted((T3_HOME / "runtime/versions").glob("*/t3"), key=lambda p: [int(x) if x.isdigit() else x for x in p.parent.name.replace("-", ".").split(".")])
    if versions: return str(versions[-1])
    sys.exit(f"no t3 CLI in {T3_HOME}")


def load_state() -> dict:
    try: return json.loads(STATE.read_text())
    except FileNotFoundError: return {"since": iso(now() - LOOKBACK), "handled": {}, "limited": {}}


def save_state(state: dict):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    cutoff = iso(now() - timedelta(days=7))
    state["handled"] = {run: at for run, at in state["handled"].items() if at > cutoff}
    state["seen"] = {run: at for run, at in state.get("seen", {}).items() if at > cutoff}
    tmp = STATE.with_suffix(".tmp"); tmp.write_text(json.dumps(state, indent=2) + "\n"); tmp.replace(STATE)


def instances() -> dict:
    return json.loads(T3_SETTINGS.read_text()).get("providerInstances", {})


def driver_of(instance_id: str, settings: dict) -> str | None:
    # Built-in instances may have no entry in settings; their id is their driver.
    return (settings.get(instance_id) or {}).get("driver") or (instance_id if instance_id in LOGIN_CHECK else None)


def logged_in(instance: dict) -> bool:
    argv, variable = LOGIN_CHECK[instance["driver"]]
    binary = shutil.which(argv[0])
    if not binary: return False
    env = dict(os.environ)
    home = (instance.get("config") or {}).get("homePath")
    if home: env[variable] = str(Path(home).expanduser())
    try: result = subprocess.run([binary, *argv[1:]], env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired: return False
    if instance["driver"] == "codex": return result.returncode == 0
    try: return json.loads(result.stdout).get("loggedIn") is True
    except json.JSONDecodeError: return False


def free(name: str, state: dict, grace: timedelta = timedelta(0)) -> bool:
    until = parse_time(state["limited"].get(name))
    return until is None or until + grace <= now()


# The thread's own account first (with stay=True), once its limit has reset; then the others of the same provider.
def pick(current: str, driver: str, state: dict, settings: dict, stay: bool = False) -> str | None:
    if stay and current in settings and settings[current].get("enabled", True) is not False and free(current, state, RESUME_GRACE) and logged_in({"driver": driver, **settings[current]}): return current
    for name, instance in settings.items():
        if name == current or not free(name, state) or instance.get("driver") != driver or instance.get("enabled", True) is False: continue
        if logged_in(instance): return name
        log(f"skip {name}: not logged in")
    return None


def resume(thread_id: str, title: str, current: str, dry_run: bool):
    log(f"resume {thread_id} ({title!r}) on {current}, whose limit has reset{' [dry run]' if dry_run else ''}")
    if dry_run: return
    subprocess.run([t3_cli(), "thread", "send", "--base-dir", str(T3_HOME), thread_id, "-"], input=RESUME_SAME,
                   check=True, capture_output=True, text=True, timeout=120)


def rotate(thread_id: str, project_id: str, title: str, current: str, selection: dict, target: str, dry_run: bool):
    # Same model and options, only the account changes. The helper runs on that model too, on the target account.
    model = {"instanceId": target, "model": selection["model"], **({"options": selection["options"]} if selection.get("options") else {})}
    prompt = f"""You are T3 Code's automatic account-rotation helper. Use the t3-code tools to do exactly these steps, then stop.

Never interrupt or steer a running turn.

0. Call t3_thread_read with threadId "{thread_id}". If it is running a turn or has queued work, change nothing, send nothing, and reply "Left {thread_id} alone: it is running".
1. Call t3_thread_configure with threadId "{thread_id}" and modelSelection {json.dumps(model)}.
2. Call t3_thread_configure with threadId "{thread_id}" and no modelSelection, and check that its provider instance is now "{target}" and its model is still "{selection['model']}". If not, stop and report why.
3. Call t3_thread_send with threadId "{thread_id}", mode "queue", and exactly this message:
{RESUME}
4. If step 0 left it alone or step 3 succeeded, call t3_thread_organize with action "archive" and no threadId, which archives this helper thread so it does not stay in the sidebar. If anything failed, do not archive it, so the failure stays visible.

Then reply with one line: "Moved {thread_id} from {current} to {target} and resumed it", or what failed. Do nothing else."""
    log(f"rotate {thread_id} ({title!r}) {current} -> {target} model={model['model']}{' [dry run]' if dry_run else ''}")
    if dry_run: return
    subprocess.run([t3_cli(), "thread", "start", "--base-dir", str(T3_HOME), "--provider", target, "--model", selection["model"],
                    "--title", "Account rotation", project_id, "-"], input=prompt,
                   check=True, capture_output=True, text=True, timeout=120)


def selected_drivers() -> set[str]:
    names = (arg("--providers") or "claude,codex").split(",")
    unknown = [n for n in names if n not in DRIVERS]
    if unknown: sys.exit(f"unknown provider {unknown[0]}: use claude, codex or claude,codex")
    return {DRIVERS[n] for n in names}


def main():
    drivers, dry_run = selected_drivers(), "--dry-run" in sys.argv
    if "--force" in sys.argv: return rotate_now(arg("--force") or sys.exit("--force needs a thread id"), dry_run)
    if "--watch" not in sys.argv: return scan(drivers, dry_run, set())
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    state = load_state(); state["since"] = max(state["since"], iso(now() - LOOKBACK))
    if not dry_run: save_state(state)
    names = ", ".join(n for n, d in DRIVERS.items() if d in drivers)
    log(f"rotating {names} threads within their own provider and model; checking every {WATCH_INTERVAL} s")
    waiting: set[str] = set()
    try:
        while True:
            try: scan(drivers, dry_run, waiting)
            except Exception as error: log(f"check failed: {error}")
            time.sleep(WATCH_INTERVAL)
    except KeyboardInterrupt: log("stopped")


def rotate_now(thread_id: str, dry_run: bool):
    state, settings = load_state(), instances()
    db = sqlite3.connect(f"file:{T3_DB}?mode=ro", uri=True, timeout=10)
    row = db.execute("select provider_instance_id, project_id, payload_json from orchestration_v2_projection_threads where thread_id = ?", (thread_id,)).fetchone()
    if not row: sys.exit(f"no thread {thread_id}")
    payload = json.loads(row[2]); selection = payload.get("modelSelection") or {}
    current = selection.get("instanceId") or row[0]; driver = driver_of(current, settings)
    if driver not in LOGIN_CHECK or not selection.get("model"): sys.exit(f"{thread_id} is not on a Claude or Codex account")
    latest = db.execute("select status from orchestration_v2_projection_runs where thread_id = ? order by ordinal desc limit 1", (thread_id,)).fetchone()
    if latest and latest[0] in ("running", "pending", "queued", "starting"): sys.exit(f"{thread_id} is running; not touching it")
    target = pick(current, driver, state, settings)
    if not target: sys.exit(f"no other {driver} account is available")
    rotate(thread_id, row[1], payload.get("title") or thread_id, current, selection, target, dry_run)


# Just before acting: the thread's newest run is still the failed one, so it is idle and nothing has resumed it (a
# running or newer run means T3 or the user already did, and it must not be touched).
def still_stuck(thread_id: str, run_id: str) -> bool:
    db = sqlite3.connect(f"file:{T3_DB}?mode=ro", uri=True, timeout=10)
    row = db.execute("select run_id, status from orchestration_v2_projection_runs where thread_id = ? order by ordinal desc limit 1", (thread_id,)).fetchone()
    return row is not None and row[0] == run_id and row[1] == "failed"


# waiting: runs already reported as having no free account, so each is logged once rather than every check.
def scan(drivers: set[str], dry_run: bool, waiting: set[str]):
    state, settings = load_state(), instances()
    db = sqlite3.connect(f"file:{T3_DB}?mode=ro", uri=True, timeout=10)
    for thread_id, run_id, current, completed, project_id, payload_json, reset_at in db.execute(FAILED_ON_LIMIT).fetchall():
        if run_id in state["handled"] or (completed or "") <= state["since"]: continue
        payload = json.loads(payload_json); selection = payload.get("modelSelection") or {}
        current = selection.get("instanceId") or current; driver = driver_of(current, settings)
        if driver not in drivers or not selection.get("model"): continue
        # The limit as of this failure: the provider's reset time, else a guess from when it failed.
        until = parse_time(reset_at) or (parse_time(completed) or now()) + UNKNOWN_RESET
        if run_id not in state.setdefault("seen", {}):
            state["seen"][run_id] = iso(now())
            known = parse_time(state["limited"].get(current))
            if known is None or known < until: state["limited"][current] = iso(until)
        title = payload.get("title") or thread_id
        target = pick(current, driver, state, settings, stay=True)
        if not target:
            if run_id not in waiting:
                resets = sorted(t for n, i in settings.items() if i.get("driver") == driver for t in [parse_time(state["limited"].get(n))] if t)
                log(f"{thread_id}: every {driver} account is limited; waiting for the first reset{f' (next {iso(resets[0])})' if resets else ''}")
            waiting.add(run_id)
            continue
        if not still_stuck(thread_id, run_id):
            log(f"{thread_id}: started again on its own; left alone"); state["handled"][run_id] = iso(now()); continue
        if target == current: resume(thread_id, title, current, dry_run)
        else: rotate(thread_id, project_id, title, current, selection, target, dry_run)
        if not dry_run: state["handled"][run_id] = iso(now()); state["seen"].pop(run_id, None)
    if not dry_run: save_state(state)


if __name__ == "__main__":
    try: main()
    except SystemExit as error:
        if error.code not in (None, 0): log("check failed"); sys.exit(1)
    except Exception:
        log("check failed"); sys.exit(1)
