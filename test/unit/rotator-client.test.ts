import { expect, test } from "bun:test"
import { chmod, readFile, symlink } from "node:fs/promises"
import { join } from "node:path"
import { mode, rotator } from "../../extensions/rotator/rotator"
import { fixture, fakeExec, local, must, put } from "./client-feature-fixtures"

test("the Python rotator keeps private thread data out of logs and subprocess argv", async () => {
  const home = await fixture(), execute = local(home)
  const script = join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")
  const probe = `import runpy, sys, json\nm = runpy.run_path(sys.argv[1])\nm['log']('check failed: token-secret')\nm['log']('rotate token-secret')\nf = m['rotate']\nf.__globals__['t3_cli'] = lambda: '/fixture/t3'\nf.__globals__['subprocess'].run = lambda argv, **kw: print(json.dumps(argv))\nf('thread', 'project', 'title-token-secret', 'source', {'model':'model'}, 'target', False)\n`
  const result = await must(execute, ["python3", "-c", probe, script])
  expect(result).not.toContain("token-secret")
  const failed = await execute(["python3", script, "--providers", "token-secret"])
  expect(failed.exitCode).toBe(1)
  expect(failed.stdout).toContain("check failed")
  expect(failed.stdout + failed.stderr).not.toContain("token-secret")
})

test("an account disabled in T3 is not selected for resuming its own thread", async () => {
  const home = await fixture()
  await put(home, "bin/claude", '#!/bin/sh\nprintf \'{"loggedIn":true}\\n\'\n')
  await chmod(join(home, "bin/claude"), 0o700)
  const probe = `import runpy, sys\nm = runpy.run_path(sys.argv[1])\nprint(m['pick']('source', 'claudeAgent', {'limited':{}}, {'source':{'driver':'claudeAgent','enabled':False}}, stay=True))\n`
  expect(await must(local(home, { PATH: join(home, "bin") + ":" + process.env.PATH }), ["python3", "-c", probe, join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")])).toBe("None")
})
test("rotator status is read-only, bad modes fail and guest errors do not disclose secrets", async () => {
  const home = await fixture(), transport = fakeExec(home)
  expect(await rotator(transport.runner, "demo")).toEqual({ mode: "off", log: [] })
  expect(await Bun.file(join(home, ".t3/account-rotator/pid")).exists()).toBe(false)
  expect(transport.calls[0]?.stdin).toBeUndefined()
  expect(() => mode("all")).toThrow("Choose")
  await expect(rotator(async () => ({ exitCode: 1, stdout: "token-secret", stderr: "token-secret" }), "demo", "claude")).rejects.not.toThrow("token-secret")
  await expect(rotator(async () => ({ exitCode: 0, stdout: '{"mode":"off","log":["token-secret"]}', stderr: "" }), "demo")).rejects.not.toThrow("token-secret")
})
test("starting transfers the bundled script on stdin, detaches, replaces the watcher and stops only its PID", async () => {
  const home = await fixture(), bin = join(home, "fake-bin")
  await put(home, ".t3/userdata/settings.json", "{}")
  await put(home, ".t3/account-rotator/rotator.log", "older-token-secret\n")
  await put(home, "fake-bin/python3", `#!/usr/bin/env node\nif (process.argv.includes('--version')) process.exit(0)\nconsole.log('2026-11-11T00:00:00+00:00 rotate thread title-token-secret')\nsetInterval(() => {}, 1000)\n`)
  await chmod(join(bin, "python3"), 0o700)
  const transport = fakeExec(home, { PATH: bin + ":" + process.env.PATH })
  try {
    const first = await rotator(transport.runner, "demo", "claude,codex")
    expect(first.mode).toBe("claude,codex"); expect(first.log).toEqual(["2026-11-11T00:00:00+00:00 rotation requested"])
    expect(await readFile(join(home, ".t3/account-rotator/rotator.log"), "utf8")).not.toContain("older-token-secret")
    const originalPid = await readFile(join(home, ".t3/account-rotator/pid"), "utf8")
    expect(await readFile(join(home, ".t3/account-rotator/rotate.py"), "utf8")).toBe(await Bun.file(join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")).text())
    expect(transport.calls[0]?.stdin).toBe(await Bun.file(join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")).text())
    expect(transport.calls[0]?.argv).not.toContain(transport.calls[0]?.stdin ?? "")
    expect((await rotator(transport.runner, "demo")).mode).toBe("claude,codex")
    expect((await rotator(transport.runner, "demo", "codex")).mode).toBe("codex")
    expect(await readFile(join(home, ".t3/account-rotator/pid"), "utf8")).not.toBe(originalPid)
    expect((await rotator(transport.runner, "demo", "off")).mode).toBe("off")
    expect(transport.calls.at(-1)?.stdin).toBeUndefined()
    await put(home, ".t3/account-rotator/pid", String(process.pid))
    await put(home, ".t3/account-rotator/providers", "claude")
    expect((await rotator(transport.runner, "demo", "off")).mode).toBe("off")
    expect(process.kill(process.pid, 0)).toBe(true)
  } finally { await rotator(transport.runner, "demo", "off") }
})

test("the real SQLite scan rotates only an idle top-level usage-limit failure and preserves model options", async () => {
  const home = await fixture(), bin = join(home, "bin")
  await put(home, "bin/claude", '#!/bin/sh\nprintf \'{"loggedIn":true}\\n\'\n')
  await chmod(join(bin, "claude"), 0o700)
  await put(home, ".t3/bin/t3", `#!/usr/bin/env node\nconst fs = require('fs'); fs.appendFileSync(process.env.HOME + '/calls.jsonl', JSON.stringify({ argv: process.argv.slice(2), input: fs.readFileSync(0, 'utf8') }) + '\\n', {mode:0o600});\n`)
  await chmod(join(home, ".t3/bin/t3"), 0o700)
  await put(home, ".t3/userdata/settings.json", JSON.stringify({ providerInstances: { source: { driver: "claudeAgent" }, target: { driver: "claudeAgent", enabled: true }, other: { driver: "codex" } } }))
  const probe = `import runpy, sys, sqlite3, json\nfrom datetime import timedelta\nm = runpy.run_path(sys.argv[1])\ndb = sqlite3.connect(m['T3_DB'])\ndb.executescript('''
create table orchestration_v2_projection_runs(thread_id text, run_id text, provider_instance_id text, status text, completed_at text, ordinal integer);
create table orchestration_v2_projection_threads(thread_id text, project_id text, payload_json text, archived_at text, deleted_at text);
create table orchestration_v2_projection_turn_items(run_id text, type text, payload_json text);
''')
for thread in ['stuck', 'running', 'child', 'ordinary']:
    payload = {'title':'title-token-secret', 'modelSelection':{'instanceId':'source','model':'exact-model','options':{'reasoningEffort':'high'}}}
    if thread == 'child': payload['lineage'] = {'parentThreadId':'parent'}
    db.execute('insert into orchestration_v2_projection_threads values (?,?,?,null,null)', (thread, 'project', json.dumps(payload)))
    db.execute('insert into orchestration_v2_projection_runs values (?,?,?,?,?,1)', (thread, thread+'-run', 'source', 'failed', m['iso'](m['now']())))
    db.execute('insert into orchestration_v2_projection_turn_items values (?,?,?)', (thread+'-run', 'error', json.dumps({'failure':{'class':'other' if thread == 'ordinary' else 'usage_limit', 'resetAt':m['iso'](m['now']()+timedelta(hours=1))}})))
db.execute('insert into orchestration_v2_projection_runs values (?,?,?,?,?,2)', ('running','newer','source','running',None))
db.commit(); db.close()
m['scan']({'claudeAgent'}, False, set())
`
  const output = await must(local(home, { PATH: bin + ":" + process.env.PATH }), ["python3", "-c", probe, join(import.meta.dir, "../../extensions/rotator/t3-account-rotator.py")])
  expect(output).not.toContain("token-secret")
  const calls = (await readFile(join(home, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line))
  expect(calls).toHaveLength(1)
  expect(calls[0].argv).toEqual(["thread", "start", "--base-dir", join(home, ".t3"), "--provider", "target", "--model", "exact-model", "--title", "Account rotation", "project", "-"])
  expect(calls[0].input).toContain('"options": {"reasoningEffort": "high"}')
  expect(calls[0].input).toContain('threadId "stuck"')
  const state = JSON.parse(await readFile(join(home, ".local/state/t3-account-rotator/state.json"), "utf8"))
  expect(Object.keys(state.handled)).toEqual(["stuck-run"])
})

test("missing ps is a failure and cannot silently discard a watcher's PID as stale", async () => {
  const home = await fixture(), bin = join(home, "bin"), node = Bun.which("node")
  if (!node) throw new Error("Node is required for this fixture.")
  await put(home, "bin/placeholder", ""); await symlink(node, join(bin, "node"))
  await put(home, ".t3/account-rotator/pid", String(process.pid) + "\n")
  await put(home, ".t3/account-rotator/providers", "claude\n")
  const transport = fakeExec(home, { PATH: bin })
  await expect(rotator(transport.runner, "demo", "off")).rejects.toThrow("failed")
  expect(await readFile(join(home, ".t3/account-rotator/pid"), "utf8")).toBe(String(process.pid) + "\n")
  expect(process.kill(process.pid, 0)).toBe(true)
})

test("missing Python fails before replacing the watcher files", async () => {
  const home = await fixture(), bin = join(home, "bin"), node = Bun.which("node")
  if (!node) throw new Error("Node is required for this fixture.")
  await put(home, "bin/placeholder", ""); await symlink(node, join(bin, "node"))
  await put(home, ".t3/userdata/settings.json", "{}")
  await put(home, ".t3/account-rotator/rotate.py", "keep existing script")
  await expect(rotator(fakeExec(home, { PATH: bin }).runner, "demo", "claude")).rejects.toThrow("failed")
  expect(await readFile(join(home, ".t3/account-rotator/rotate.py"), "utf8")).toBe("keep existing script")
})
