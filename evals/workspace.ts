import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { connect, createServer } from "node:net"
import { userInfo } from "node:os"
import { dirname, join } from "node:path"
import { controlledDecision, workspacePids } from "../core/workspace-processes"
import { workspaceEnvironment, workspaceProfile } from "../core/workspace-profile"
import type { WorkspaceManifest } from "../core/types"
import controlProfile from "../core/workspace-control.sb" with { type: "text" }

type Run = { code: number; out: string; err: string }
type Eval = { id: string; claim: string; run: () => Promise<string | void> }
async function sh(argv: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string; timeout?: number } = {}): Promise<Run> {
  const child = Bun.spawn(argv, { env: options.env ?? process.env, cwd: options.cwd, stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]), stdout: "pipe", stderr: "pipe", timeout: options.timeout ?? 30_000 })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code: child.signalCode ? 124 : code, out, err }
}
function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
const wait = async (test: () => Promise<boolean>, ms = 5000) => { for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(25)) if (await test()) return true; return false }
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

export function workspaceSuite(binary: string, skip: (reason: string) => never) {
  const evals: Eval[] = []; const ev = (id: string, claim: string, run: Eval["run"]) => evals.push({ id, claim, run })
  let root = ""; let state = ""; let env: NodeJS.ProcessEnv; let counter = 0
  const started: Bun.Subprocess[] = []; const cleanup: Array<() => Promise<unknown>> = []
  const init = async () => {
    if (process.platform !== "darwin") skip("Workspaces require macOS.")
    if (root) return
    root = await mkdtemp(join(import.meta.dir, "../dist/paddock-workspace-evals-"))
    // nix develop's TMPDIR disappears when its command exits; a daemon must remain inspectable on failure.
    state = await mkdtemp("/private/tmp/pdk-k-")
    env = { ...process.env, PADDOCK_STATE_DIR: join(state, "s"), PADDOCK_CONFIG_DIR: join(state, "c"), PADDOCK_PORT: "0", PADDOCK_WORKSPACES_ROOT: join(root, "workspaces"),
      PADDOCK_WORKSPACE_ONLY: "1", CLAUDE_CONFIG_DIR: join(root, "no-claude"), CODEX_HOME: join(root, "no-codex") }
  }
  const pdk = async (args: string[], stdin?: string) => { await init(); return sh([binary, ...args], { env, stdin, timeout: 90_000 }) }
  const json = async (args: string[]) => { const result = await pdk(["--json", "workspace", ...args]); const reply = JSON.parse(result.out); expect(result.code === 0 && reply.ok, `workspace ${args[0]} refused: ${reply.error?.message ?? reply.data?.checks?.filter((check: { status: string }) => check.status === "fail").map((check: { detail: string }) => check.detail).join("; ") ?? result.err}`); return reply.data }
  const manifest = async (name: string) => JSON.parse(await readFile(join(env.PADDOCK_STATE_DIR!, "workspaces", `${name}.json`), "utf8")) as WorkspaceManifest
  const make = async (args: string[] = []) => { await init(); const name = `k-${++counter}`; const report = await json(["create", name, "--no-logins", ...args]); return { name, folder: report.workspace.folder as string, manifest: await manifest(name) } }
  const inside = async (ws: { name: string }, argv: string[]) => {
    const m = await manifest(ws.name); const profile = workspaceProfile(m)
    return sh(["/usr/bin/sandbox-exec", "-f", join(env.PADDOCK_STATE_DIR!, "workspaces", `${ws.name}.sb`), ...profile.params.flatMap((value) => ["-D", value]), "--", ...argv], { env: workspaceEnvironment(m), cwd: join(m.folder, "work"), timeout: 30_000 })
  }
  const spawnInside = async (ws: { name: string }, argv: string[]) => {
    const m = await manifest(ws.name); const profile = workspaceProfile(m)
    const child = Bun.spawn(["/usr/bin/sandbox-exec", "-f", join(env.PADDOCK_STATE_DIR!, "workspaces", `${ws.name}.sb`), ...profile.params.flatMap((value) => ["-D", value]), "--", ...argv],
      { env: workspaceEnvironment(m), cwd: join(m.folder, "work"), stdout: "pipe", stderr: "pipe" })
    started.push(child); void new Response(child.stdout).arrayBuffer(); void new Response(child.stderr).arrayBuffer(); return child
  }
  const drop = async (ws: { name: string }) => json(["remove", ws.name, "--confirm", ws.name])
  const bundle = async (folder: string, label: string) => {
    const app = join(folder, `${label}.app`); const marker = join(folder, `${label}.ran`)
    await mkdir(join(app, "Contents/MacOS"), { recursive: true })
    await writeFile(join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.paddock.eval.${label}</string><key>CFBundleName</key><string>${label}</string><key>CFBundleExecutable</key><string>run</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
    await writeFile(join(app, "Contents/MacOS/run"), `#!/bin/sh\nprintf ran > '${marker}'\n`); await chmod(join(app, "Contents/MacOS/run"), 0o700)
    cleanup.push(() => sh([LSREGISTER, "-u", app])); return { app, marker }
  }

  ev("K15", "The finder lists zero for an empty workspace and exactly known pids, excluding decoys", async () => {
    await init()
    const folder = join(root, "finder-control"); await mkdir(folder); const tag = join(folder, ".paddock-tag"); await writeFile(tag, "control")
    const temp = (await sh(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"])).out.trim()
    const profile = workspaceProfile({ folder, tag, home: await realpath(userInfo().homedir), userVar: await realpath(dirname(temp)), reads: [] })
    const file = join(root, "finder.sb"); await writeFile(file, profile.text)
    expect(workspacePids(folder).length === 0, "empty workspace matched unrelated pids; do not signal any finder result")
    const known = [0, 1].map(() => Bun.spawn(["/usr/bin/sandbox-exec", "-f", file, ...profile.params.flatMap((value) => ["-D", value]), "/bin/sleep", "60"], { stdout: "pipe", stderr: "pipe" }))
    const decoy = Bun.spawn(["/bin/sleep", "60"], { env: { ...process.env, PADDOCK_WORKSPACE: "finder-control" }, stdout: "pipe", stderr: "pipe" })
    started.push(...known, decoy)
    await Bun.sleep(150)
    expect(JSON.stringify(workspacePids(folder).sort()) === JSON.stringify(known.map((child) => child.pid).sort()), "finder did not match exactly the two known pids")
    for (const child of [...known, decoy]) { child.kill("SIGKILL"); await child.exited }
    expect(workspacePids(folder).length === 0, "finder was nonempty after its known processes exited")
    return "List-only controls ran before lifecycle signals. Both tag conditions and per-pid rechecks use bun:ffi with an in-memory C varargs wrapper."
  })

  ev("K01", "Workspace writes are refused at controlled home, tmp, user-temp, Shared and Cellar targets", async () => {
    const ws = await make(); const paths = [join(root, "outside-write"), join(state, "tmp-write")]
    const created: string[] = []
    const userTemp = (await sh(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"])).out.trim()
    const extra = [`${userTemp}paddock-k-${process.pid}`, `/Users/Shared/.paddock-k-${process.pid}`, `/opt/homebrew/Cellar/.paddock-k-${process.pid}`]
    try {
      paths.push(...extra)
      for (const path of paths) {
        await writeFile(path, "control", { flag: "wx" })
        created.push(path)
        const run = await inside(ws, ["/bin/sh", "-c", 'printf escaped > "$1"', "probe", path])
        expect(run.code !== 0 && await readFile(path, "utf8") === "control", `outside write succeeded at ${path}`)
      }
      const ok = await inside(ws, ["/bin/sh", "-c", 'printf inside > "$HOME/inside" && cat "$HOME/inside"'])
      expect(ok.code === 0 && ok.out === "inside", "inside write control failed")
      return "All five unconfined writes succeeded; every confined write was refused. All control files removed."
    } finally { for (const path of created) await rm(path, { force: true }); await drop(ws) }
  })

  ev("K02", "npm global, pip user and uv tool installs land in the workspace", async () => {
    const ws = await make(); const work = join(ws.folder, "work"); const pkg = join(work, "npm-pkg")
    try {
      await mkdir(pkg); await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "paddock-k-fixture", version: "1.0.0", bin: { "paddock-k-fixture": "cli.js" } })); await writeFile(join(pkg, "cli.js"), "#!/usr/bin/env node\nconsole.log('local package')\n")
      const npm = await inside(ws, ["npm", "install", "--global", "--ignore-scripts", "--no-audit", "--no-fund", pkg])
      expect(npm.code === 0, `npm local install failed: ${npm.err.slice(0, 500)}`)
      expect((await lstat(join(ws.folder, "home/.local/bin/paddock-k-fixture"))).isSymbolicLink(), "npm global bin is not under workspace home")
      const wheel = join(work, "paddock_k_fixture-1.0.0-py3-none-any.whl")
      const wheelCode = 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("paddock_k_fixture.py","def main(): print(42)\\n")\np="paddock_k_fixture-1.0.0.dist-info/"\nz.writestr(p+"METADATA","Metadata-Version: 2.1\\nName: paddock-k-fixture\\nVersion: 1.0.0\\n")\nz.writestr(p+"WHEEL","Wheel-Version: 1.0\\nGenerator: paddock\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")\nz.writestr(p+"entry_points.txt","[console_scripts]\\npaddock-k-python = paddock_k_fixture:main\\n")\nz.writestr(p+"RECORD","")\nz.close()'
      expect((await sh(["/usr/bin/python3", "-c", wheelCode, wheel])).code === 0, "could not make the local wheel control")
      const pip = await inside(ws, ["/usr/bin/python3", "-m", "pip", "install", "--user", "--no-index", "--no-deps", wheel])
      expect(pip.code === 0, `pip user install failed: ${pip.err.slice(0, 500)}`)
      const location = await inside(ws, ["/usr/bin/python3", "-c", "import paddock_k_fixture; print(paddock_k_fixture.__file__)"])
      expect(location.code === 0 && location.out.startsWith(ws.folder), "pip module is not inside the workspace")
      const uv = await inside(ws, ["uv", "tool", "install", "--no-index", "--no-managed-python", "--python", "/usr/bin/python3", wheel])
      expect(uv.code === 0, `uv local tool install failed: ${uv.err.slice(0, 500)}`)
      expect((await realpath(join(ws.folder, "home/.local/bin/paddock-k-python"))).startsWith(ws.folder), "uv tool executable is outside the workspace")
      return "Only local fixture packages installed; no package registry contacted."
    } finally { await drop(ws) }
  })

  ev("K03", "Home reads stay closed under symlink, parent, case and firmlink spellings; declared reads work", async () => {
    await init(); const shared = join(root, "read allowed"); await mkdir(shared); await writeFile(join(shared, "file"), "allowed")
    const ws = await make(["--read", shared]); const closed = join(root, "closed"); await writeFile(closed, "closed")
    try {
      const linkPath = join(ws.folder, "work/link"); await symlink(closed, linkPath)
      const paths = [closed, linkPath, join(ws.folder, "work", "../../../closed"), closed.toUpperCase(), `/System/Volumes/Data${closed}`]
      for (const path of paths) {
        expect((await sh(["/bin/cat", path])).out === "closed", `the unconfined read control failed for ${path}`)
        expect((await inside(ws, ["/bin/cat", path])).code !== 0, `closed read succeeded through ${path}`)
      }
      expect((await inside(ws, ["/bin/cat", join(shared, "file")])).out === "allowed", "declared read failed")
      for (const path of [userInfo().homedir, join(userInfo().homedir, ".ssh"), env.PADDOCK_WORKSPACES_ROOT!, env.PADDOCK_STATE_DIR!, dirname(env.PADDOCK_WORKSPACES_ROOT!)]) {
        const refused = await pdk(["workspace", "create", "forbidden", "--read", path]); expect(refused.code !== 0, "a sensitive --read was accepted")
      }
    } finally { await drop(ws) }
  })

  ev("K04", "Shared temporary folders are unreadable beside unconfined controls", async () => {
    const ws = await make()
    try {
      for (const path of ["/private/tmp", "/private/var/tmp", ws.manifest.userVar]) {
        expect((await sh(["/bin/ls", path])).code === 0, `unconfined shared-temp control failed at ${path}`)
        expect((await inside(ws, ["/bin/ls", path])).code !== 0, `shared temp is readable at ${path}`)
      }
    } finally { await drop(ws) }
  })

  ev("K05", "A read path is data, with a working profile-syntax injection control", async () => {
    await init(); const attack = join(root, 'x"))(allow file-write* (subpath "/"))(allow file-read* (subpath "/x')
    await mkdir(attack, { recursive: true }); await writeFile(join(attack, "file"), "data")
    const ws = await make(["--read", attack]); const outside = join(root, "injection-control")
    try {
      expect((await inside(ws, ["/bin/cat", join(attack, "file")])).out === "data", "injection-named declared path is not readable")
      const argv = ["/bin/sh", "-c", 'printf changed > "$1"', "probe", outside]
      expect((await inside(ws, argv)).code !== 0, "parameter changed the profile")
      const m = ws.manifest; const profile = workspaceProfile(m); const bad = join(root, "unsafe-control.sb")
      await writeFile(bad, `${profile.text}\n(allow file-read* (subpath "${attack}"))\n`)
      const control = await sh(["/usr/bin/sandbox-exec", "-f", bad, ...profile.params.flatMap((value) => ["-D", value]), ...argv], { env: workspaceEnvironment(m), cwd: join(m.folder, "work") })
      expect(control.code === 0 && await readFile(outside, "utf8") === "changed", "the deliberately spliced control did not demonstrate injection")
    } finally { await drop(ws) }
  })

  ev("K06", "Metal compute and hardware-only VideoToolbox encoding work inside a workspace", async () => {
    const ws = await make(); const probe = join(ws.folder, "work/metal")
    try {
      const build = await sh(["/Library/Developer/CommandLineTools/usr/bin/clang", "-isysroot", "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "-framework", "Foundation", "-framework", "Metal", join(import.meta.dir, "workspace-metal.m"), "-o", probe])
      expect(build.code === 0, `could not build Metal probe: ${build.err.slice(0, 500)}`)
      const metal = await inside(ws, [probe]); expect(metal.code === 0 && metal.out.includes("Metal compute verified"), `Metal compute failed: ${metal.err.slice(0, 500)}`)
      const movie = join(ws.folder, "work/hardware.mov")
      const video = await inside(ws, ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=5:d=0.4", "-c:v", "hevc_videotoolbox", "-allow_sw", "0", "-y", movie])
      expect(video.code === 0 && (await stat(movie)).size > 0, `hardware-only encoding failed: ${video.err.slice(0, 500)}`)
      const report = await json(["verify", ws.name]); const gpu = report.checks.find((entry: { id: string }) => entry.id === "gpu")
      expect(gpu.status === "pass" && gpu.evidence === "probed", "verify did not actually measure hardware encoding")
      return `${metal.out.trim()}; HEVC VideoToolbox with -allow_sw 0 produced a nonempty movie. Product verify also reports a probed hardware encode pass. Torch, Chrome, CoreML and GPU performance are not measured by this eval.`
    } finally { await drop(ws) }
  })

  ev("K07", "LaunchServices cannot open an app whose harmless effect works unconfined", async () => {
    const ws = await make(); const app = await bundle(join(ws.folder, "work"), `k${process.pid}open`)
    try {
      const control = await sh(["/usr/bin/open", "-W", "-n", app.app])
      expect(control.code === 0 && await wait(async () => Bun.file(app.marker).exists()), "unconfined app did not produce its marker")
      await rm(app.marker)
      const confined = await inside(ws, ["/usr/bin/open", "-W", "-n", app.app])
      expect(confined.code !== 0 && !await Bun.file(app.marker).exists(), "confined open launched the app")
    } finally { await drop(ws) }
  })

  ev("K08", "LaunchServices refuses registration that succeeds unconfined", async () => {
    const ws = await make(); const app = await bundle(join(ws.folder, "work"), `k${process.pid}register`)
    try {
      expect((await sh([LSREGISTER, "-f", app.app])).code === 0, "unconfined registration failed")
      expect((await sh([LSREGISTER, "-dump"])).out.includes(app.app), "unconfined registration absent from database")
      expect((await sh([LSREGISTER, "-u", app.app])).code === 0, "could not unregister the control")
      const attempt = await inside(ws, [LSREGISTER, "-f", app.app])
      expect(attempt.code !== 0 && !(await sh([LSREGISTER, "-dump"])).out.includes(app.app), "confined app registration succeeded")
    } finally { await drop(ws) }
  })

  ev("K09", "A launchd job is refused beside a working harmless unconfined job", async () => {
    const ws = await make(); const label = `org.paddock.eval.k${process.pid}`; const marker = join(root, "launchd-marker")
    const argv = ["/bin/launchctl", "submit", "-l", label, "--", "/bin/sh", "-c", 'printf ran > "$1"', "probe", marker]
    try {
      expect((await sh(argv)).code === 0 && await wait(async () => Bun.file(marker).exists()), "unconfined launchd control did not run")
      await sh(["/bin/launchctl", "remove", label]); await rm(marker)
      expect((await inside(ws, argv)).code !== 0 && !await Bun.file(marker).exists(), "confined launchd job ran")
      return "launchctl submit measured. at/crontab installation is not measured because the eval does not modify the user's queues."
    } finally { await sh(["/bin/launchctl", "remove", label]); await drop(ws) }
  })

  ev("K10", "Daemon Unix sockets are refused with live controls, while DNS works", async () => {
    const ws = await make(); const socket = join(state, "control.sock")
    const server = createServer((socket) => socket.end("control\n")); await new Promise<void>((resolve) => server.listen(socket, resolve))
    const connected = (path: string) => new Promise<boolean>((resolve) => { const c = connect(path); c.setTimeout(1000); c.once("connect", () => { c.destroy(); resolve(true) }); c.once("error", () => resolve(false)); c.once("timeout", () => { c.destroy(); resolve(false) }) })
    try {
      for (const path of [socket, "/var/run/docker.sock", "/nix/var/nix/daemon-socket/socket"]) {
        expect(await connected(path), `unconfined socket control did not connect at ${path}`)
        const code = `import {connect} from "node:net"; const c=connect(${JSON.stringify(path)}); c.on("connect",()=>{c.destroy();process.exit(0)});c.on("error",()=>process.exit(2));setTimeout(()=>process.exit(3),1000);`
        const attempt = await inside(ws, [process.execPath, "-e", code]); expect(attempt.code === 2, `socket denial not established at ${path}, exit ${attempt.code}`)
      }
      const dns = await inside(ws, [process.execPath, "-e", 'import {lookup} from "node:dns/promises"; const r=await lookup("example.com"); if(!r.address) process.exit(1);'])
      expect(dns.code === 0, `DNS failed: ${dns.err.slice(0, 300)}`)
      return "Only socket connections were attempted, with no Docker or nix API commands."
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await drop(ws) }
  })

  ev("K11", "Preferences and clipboard reads are refused beside nonempty read-only controls", async () => {
    const ws = await make()
    try {
      for (const argv of [["/usr/bin/defaults", "read", "com.apple.finder"], ["/usr/bin/pbpaste"]]) {
        const control = await sh(argv)
        if (control.code !== 0 || !control.out.length) skip("An unconfined preferences or clipboard control was empty; nothing was modified to populate it. Contents withheld.")
        const confined = await inside(ws, argv); expect(!confined.out.length, "confined command returned user data; contents withheld")
      }
      return "Controls were nonempty, confined output empty. Neither values nor clipboard contents were logged."
    } finally { await drop(ws) }
  })

  ev("K12", "Outside-process signals and open-file inspection are refused beside working controls", async () => {
    const ws = await make(); const file = join(root, "open-file"); await writeFile(file, "x")
    const child = Bun.spawn([process.execPath, "-e", 'import {openSync} from "node:fs";openSync(process.argv[1],"r");setInterval(()=>{},1000)', file], { stdout: "pipe", stderr: "pipe" }); started.push(child)
    const inspectCode = `import{dlopen,ptr}from"bun:ffi";const l=dlopen("/usr/lib/libSystem.B.dylib",{proc_pidinfo:{args:["i32","i32","u64","ptr","i32"],returns:"i32"}});const b=new Uint8Array(8192);console.log(l.symbols.proc_pidinfo(${child.pid},1,0,ptr(b),b.byteLength));`
    try {
      await Bun.sleep(150)
      expect((await sh(["/bin/kill", "-0", String(child.pid)])).code === 0, "unconfined signal control failed")
      expect((await inside(ws, ["/bin/kill", "-0", String(child.pid)])).code !== 0, "confined process could signal the outside process")
      expect(Number((await sh([process.execPath, "-e", inspectCode])).out) > 0, "unconfined proc_pidinfo control returned no descriptors")
      expect(Number((await inside(ws, [process.execPath, "-e", inspectCode])).out) === 0, "confined proc_pidinfo returned outside descriptors")
    } finally { child.kill("SIGKILL"); await child.exited; await drop(ws) }
  })

  ev("K13", "Keychain credential access is covered by a working unconfined control", async () => {
    skip("Not measured. K23 exercises the authorized host Keychain import; that does not prove confined Keychain reads are refused. No inside-password boundary probe was run.")
  })

  ev("K14", "Stop clears detached, env-cleared, new-session, process-group and fork-loop children only", async () => {
    const ws = await make(); const other = await make(); const record = join(ws.folder, "work/pids")
    const script = join(ws.folder, "work/detach.py")
    await writeFile(script, `import os,time,subprocess\nrecord=${JSON.stringify(record)}\ndef note(pid):\n with open(record,'a') as f:f.write(str(pid)+'\\n')\nif os.fork():os._exit(0)\nos.setsid()\nif os.fork():os._exit(0)\nos.environ.clear()\nnote(os.getpid())\nfor mode in range(3):\n p=os.fork()\n if p==0:\n  if mode==1:os.setsid()\n  if mode==2:os.setpgid(0,0)\n  note(os.getpid());os.execl('/bin/sleep','sleep','60')\nfor i in range(80):\n p=subprocess.Popen(['/bin/sleep','60']);note(p.pid);time.sleep(.05)\ntime.sleep(60)\n`)
    const decoy = Bun.spawn(["/bin/sleep", "60"], { env: { ...process.env, PADDOCK_WORKSPACE: ws.name }, stdout: "pipe", stderr: "pipe" }); started.push(decoy)
    try {
      const outside = await spawnInside(other, ["/bin/sleep", "60"])
      await spawnInside(ws, ["/usr/bin/python3", script])
      await spawnInside(ws, ["/usr/bin/script", "-q", "/dev/null", "/bin/sleep", "60"])
      expect(await wait(async () => (await readFile(record, "utf8").catch(() => "")).trim().split("\n").length >= 8), "detached/fork-loop controls did not start")
      expect(workspacePids(ws.folder).length >= 8, "finder missed controlled processes before stop")
      await json(["stop", ws.name])
      expect(workspacePids(ws.folder).length === 0, "workspace profile processes survived stop")
      for (const pid of (await readFile(record, "utf8")).trim().split("\n").map(Number)) {
        const exists = (await sh(["/bin/ps", "-o", "stat=", "-p", String(pid)])).out.trim()
        expect(!exists || exists.startsWith("Z"), `recorded pid ${pid} is still live after stop`)
      }
      expect(outside.exitCode === null && decoy.exitCode === null && workspacePids(other.folder).includes(outside.pid), "stop touched a decoy or another workspace")
      return "Double-fork/setsid parent exited; env-cleared and process-group children, script session and a live fork loop cleared. Other-workspace process and marker decoy survived."
    } finally { decoy.kill("SIGKILL"); await decoy.exited; await drop(ws); await drop(other) }
  })

  ev("K16", "Confirmed remove deletes its folder, unregisters its app and reports shared hard links", async () => {
    const ws = await make(); const outside = join(root, "hard-link-original"); await writeFile(outside, "original")
    const app = await bundle(join(ws.folder, "work"), `k${process.pid}remove`)
    try {
      await link(outside, join(ws.folder, "work/shared"))
      expect((await inside(ws, ["/bin/sh", "-c", "printf changed > shared"])).code === 0, "hard-link write control did not work")
      expect((await sh([LSREGISTER, "-f", app.app])).code === 0 && (await sh([LSREGISTER, "-dump"])).out.includes(app.app), "app registration control failed")
      expect((await pdk(["workspace", "remove", ws.name])).code === 2, "remove did not require --confirm")
      const result = await drop(ws)
      expect(result.hardLinks.includes(join(ws.folder, "work/shared")), "hard-linked file was not reported")
      expect(!await Bun.file(join(ws.folder, ".paddock-tag")).exists() && await readFile(outside, "utf8") === "changed", "remove retained workspace or touched outside hard link")
      const remaining = (await sh([LSREGISTER, "-dump"])).out.split("\n").filter((line) => line.includes(app.app))
      expect(!remaining.length && result.launchServices.length === 0, `removed app remains registered or unregistration failed: ${JSON.stringify({ reported: result.launchServices, remaining })}`)
      expect(result.notRemoved.length > 0 && result.disclosure.includes("not a sandbox"), "removal residuals were not disclosed")
    } finally { if (await Bun.file(join(ws.folder, ".paddock-tag")).exists()) await drop(ws) }
  })

  ev("K17", "Open loopback reaches a controlled outside listener and is disclosed with current listeners", async () => {
    const ws = await make(); const server = createServer((socket) => socket.end("outside-loopback\n")); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address(); expect(address && typeof address === "object", "listener has no address")
      const got = await inside(ws, ["/usr/bin/nc", "-w", "2", "127.0.0.1", String(address.port)])
      expect(got.code === 0 && got.out.includes("outside-loopback"), "open loopback did not reach outside listener")
      const report = await json(["verify", ws.name]); const loopback = report.checks.find((check: { id: string }) => check.id === "loopback")
      expect(loopback.status === "weak" && loopback.detail.includes(String(address.port)), "verify did not disclose the controlled current listener")
      expect((await pdk(["workspace", "create", "ports", "--loopback", "80"])).code !== 0, "declared-ports mode was accepted")
      return "Random-port listener reached. Declared-ports mode is deliberately absent."
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await drop(ws) }
  })

  ev("K18", "HTTPS works and open network effects are disclosed", async () => {
    const ws = await make()
    try {
      const output = await inside(ws, ["/usr/bin/curl", "-fsS", "--max-time", "15", "https://example.com"])
      expect(output.code === 0 && output.out.includes("Example Domain"), "HTTPS positive control failed")
      const report = await json(["verify", ws.name]); expect(report.workspace.disclosure.includes("LAN") && report.workspace.disclosure.includes("tailnet"), "network disclosure missing")
      return "HTTPS positive control only. No LAN, tailnet or other machine was contacted."
    } finally { await drop(ws) }
  })

  ev("K19", "A known outside process command line is visible inside, as disclosed", async () => {
    const ws = await make(); const marker = `paddock-k-command-${process.pid}`
    const child = Bun.spawn([process.execPath, "-e", "setInterval(()=>{},1000)", marker], { stdout: "pipe", stderr: "pipe" }); started.push(child)
    const code = `import{dlopen,ptr}from"bun:ffi";const l=dlopen("/usr/lib/libSystem.B.dylib",{sysctl:{args:["ptr","u32","ptr","ptr","ptr","u64"],returns:"i32"}});const mib=new Int32Array([1,49,${child.pid}]),data=new Uint8Array(262144),size=new BigUint64Array([262144n]);const rc=l.symbols.sysctl(ptr(mib),3,ptr(data),ptr(size),null,0);process.exit(rc===0&&Buffer.from(data).includes(${JSON.stringify(marker)})?0:1);`
    try { await Bun.sleep(150); expect((await inside(ws, [process.execPath, "-e", code])).code === 0, "known outside command line was not visible") }
    finally { child.kill("SIGKILL"); await child.exited; await drop(ws) }
  })

  ev("K20", "Codex's inner sandbox fails beside a working unconfined control", async () => {
    const ws = await make()
    try {
      await mkdir(join(ws.folder, "home/.codex"), { recursive: true })
      const argv = ["/opt/homebrew/bin/codex", "sandbox", "--", "/usr/bin/true"]
      const control = await sh(argv, { env: { ...workspaceEnvironment(ws.manifest), CODEX_HOME: join(ws.folder, "home/.codex") }, cwd: join(ws.folder, "work") })
      if (control.code !== 0) skip(`The unconfined Codex sandbox control failed with exit ${control.code}: ${control.err.trim().slice(0, 600)}. Failure inside proves nothing.`)
      const result = await inside(ws, argv)
      expect(result.code !== 0 && /sandbox_apply|Operation not permitted/.test(result.err), "Codex inner sandbox failure was not established")
      return "Only the eval explicitly invoked Codex's sandbox. Paddock supplies no agent sandbox flags."
    } finally { await drop(ws) }
  })

  ev("K21", "Copying a project never creates hard links or changes its original on execution/removal", async () => {
    await init(); const source = join(root, "copy-source"); await mkdir(source); await writeFile(join(source, "data"), Buffer.alloc(4 * 1024 * 1024, 65))
    const cloned = join(root, "clone-control"); const plain = join(root, "plain-control")
    for (const [flag, target] of [["-cR", cloned], ["-R", plain]]) {
      expect((await sh(["/bin/cp", flag!, source, target!])).code === 0, `${flag} copy control failed`)
      const a = await stat(join(source, "data")); const b = await stat(join(target!, "data"))
      expect(a.ino !== b.ino && a.nlink === 1 && b.nlink === 1, `${flag} created shared inodes`)
      await writeFile(join(target!, "data"), "changed"); expect((await stat(join(source, "data"))).size === 4 * 1024 * 1024, `${flag} changed original`)
    }
    const ws = await make(["--copy", source])
    try {
      const a = await stat(join(source, "data")); const b = await stat(join(ws.folder, "work/data"))
      expect(a.ino !== b.ino && a.nlink === 1 && b.nlink === 1, "workspace project shares an inode with source")
      expect((await inside(ws, ["/bin/sh", "-c", "printf changed > data"])).code === 0, "copy cannot be modified inside")
      await drop(ws)
      expect((await stat(join(source, "data"))).size === 4 * 1024 * 1024, "workspace execution or removal changed original")
      return "Both cp -cR and cp -R produced independent inodes and preserved source bytes. Paddock uses cp -R -P -X for a plain, non-dereferencing copy; no speed claim."
    } finally { if (await Bun.file(join(ws.folder, ".paddock-tag")).exists()) await drop(ws) }
  })

  ev("K22", "Workspace CLI pipes carry stdin, separate stderr and preserve exit codes through the socket", async () => {
    const ws = await make()
    try {
      const result = await pdk(["workspace", "exec", ws.name, "--stdin", "--", "/bin/sh", "-c", "cat; printf separate >&2; exit 7"], "input\u0000bytes")
      expect(result.code === 7 && result.out === "input\u0000bytes" && result.err.includes("separate"), "buffered stdin/stdout/stderr or exit code changed")
      const streamed = await pdk(["workspace", "exec", ws.name, "--stream", "--", "/bin/cat"], "streamed bytes")
      expect(streamed.code === 0 && streamed.out === "streamed bytes", "stream socket did not relay workspace bytes")
      const text = await pdk(["workspace", "list"]); expect(text.out.includes("not a sandbox"), "list lacks disclosure")
      const daemon = JSON.parse(await readFile(join(env.PADDOCK_STATE_DIR!, "daemon.json"), "utf8"))
      for (const method of ["workspaceList", "workspaceGet", "workspaceCreate", "workspaceExec", "workspaceShell", "workspaceStop", "workspaceRemove", "workspaceVerify"]) {
        const response = await fetch(`http://127.0.0.1:${daemon.port}/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${daemon.token}` }, body: JSON.stringify({ name: ws.name }) })
        expect(response.status === 403, `${method} was available over TCP`)
      }
    } finally { await drop(ws) }
  })

  ev("K23", "The selected default Claude login is imported through the product and reports logged in", async () => {
    await init()
    const name = "login-copy"
    try {
      const report = await json(["create", name])
      const m = await manifest(name)
      expect(m.spec.logins.kind === "profiles" && m.spec.logins.claude === "default" && m.spec.logins.codex === "default", "default profile selection was not explicit")
      const login = m.logins.find((entry) => entry.agent === "claude")
      if (!login?.copied) skip(login?.detail ?? "Claude was not imported; no password or credential contents were logged.")
      const credential = join(m.folder, "home/.claude/.credentials.json")
      expect((await stat(credential)).nlink === 1 && ((await stat(credential)).mode & 0o777) === 0o600, "Claude login file is not private")
      expect(((await stat(join(m.folder, "home/.claude/.claude.json"))).mode & 0o777) === 0o600, "Claude state is not private")
      const status = await pdk(["workspace", "exec", name, "--", "claude", "auth", "status"])
      let loggedIn = false
      try { loggedIn = JSON.parse(status.out).loggedIn === true } catch {}
      expect(status.code === 0 && loggedIn, "Claude credential and state were written, but auth status inside did not report loggedIn true (exit " + status.code + "); output withheld")
      expect(report.checks.find((check: { id: string }) => check.id === "credentials").detail.includes("CLI reports logged in"), "create did not report the measured login status")
      return "Default profile selected independently of daemon environment; timed Keychain reader reused from sandbox login import. Private credential and onboarding/account state copied. Product-path claude auth status reported loggedIn true. "
        + report.checks.find((check: { id: string }) => check.id === "credentials").detail + " No login, logout, authenticated API call or refresh was performed."
    } finally { if (await Bun.file(join(env.PADDOCK_STATE_DIR!, "workspaces", name + ".json")).exists()) await json(["remove", name, "--confirm", name]) }
  })

  ev("K24", "Time Machine reports the workspace folder excluded after creation", async () => {
    const ws = await make()
    try {
      const result = await sh(["/usr/bin/tmutil", "isexcluded", ws.folder])
      if (result.code !== 0 || !result.out.includes("[Excluded]")) skip("Time Machine exclusion could not be confirmed. Existing backups and other backup tools remain outside removal coverage.")
      expect(ws.manifest.backup.includes("excluded now"), "manifest failed to report the current exclusion")
      return "isexcluded reports [Excluded]. No backup was created, inspected or removed."
    } finally { await drop(ws) }
  })

  ev("K25", "Dashboard summary neither repairs workspace identity nor walks it for size", async () => {
    const ws = await make()
    try {
      await rm(ws.manifest.tag); await chmod(ws.folder, 0o555)
      const before = await stat(ws.folder)
      const response = await fetch("http://paddock/api/summary", { unix: join(env.PADDOCK_STATE_DIR!, "daemon.sock"), method: "POST", body: "{}" } as RequestInit)
      const reply = await response.json() as { ok: boolean; data: { workspaces: Array<{ name: string; status: string; sizeBytes?: number }> } }
      const row = reply.data.workspaces.find((entry) => entry.name === ws.name)
      expect(reply.ok && row?.status === "unknown" && row.sizeBytes === undefined, "summary repaired missing identity or returned a size walk")
      expect(!await Bun.file(ws.manifest.tag).exists() && ((await stat(ws.folder)).mode & 0o777) === 0o555 && (await stat(ws.folder)).ctimeMs === before.ctimeMs, "summary mutated workspace identity or permissions")
      const sized = await json(["get", ws.name]); expect(typeof sized.sizeBytes === "number", "an explicit CLI get did not measure size")
      expect(!await Bun.file(ws.manifest.tag).exists() && ((await stat(ws.folder)).mode & 0o777) === 0o555, "explicit get repaired workspace identity or permissions")
      return "Missing tag and read-only root stayed unchanged; unknown process state, no size. Unit Runner instrumentation additionally requires zero host commands from summary."
    } finally { await drop(ws) }
  })

  ev("K26", "Product exec skips informational probes and verify does not repair unreadable subdirectories", async () => {
    const ws = await make(); const home = join(ws.folder, "home"); const bin = join(home, ".local/bin"); const closed = join(ws.folder, "work/closed")
    try {
      await mkdir(bin, { recursive: true }); await writeFile(join(bin, "ffmpeg"), '#!/bin/sh\nprintf called > "$HOME/information-called"\nexit 1\n'); await chmod(join(bin, "ffmpeg"), 0o700)
      await mkdir(closed); await chmod(closed, 0)
      const previous = (await manifest(ws.name)).lastVerify?.at
      const output = await pdk(["workspace", "exec", ws.name, "--", "/usr/bin/true"])
      expect(output.code === 0 && !await Bun.file(join(home, "information-called")).exists() && ((await stat(closed)).mode & 0o777) === 0, "exec ran information probes or changed directory permissions")
      const shell = await pdk(["workspace", "shell", ws.name, "--", "/usr/bin/true"])
      expect(shell.code === 0 && !await Bun.file(join(home, "information-called")).exists(), "shell ran informational probes")
      expect((await manifest(ws.name)).lastVerify?.at === previous, "exec replaced the last full verify")
      const report = await json(["verify", ws.name])
      expect(await Bun.file(join(home, "information-called")).exists(), "explicit verify omitted the available GPU probe")
      expect(report.checks.find((entry: { id: string }) => entry.id === "gpu").status === "fail", "a failed hardware encode was not reported as failed")
      expect(report.checks.find((entry: { id: string }) => entry.id === "hard-links").status === "unknown" && ((await stat(closed)).mode & 0o777) === 0, "verify silently repaired unreadable directories")
      return "Exec preserved the last full verification; failing ffmpeg ran only for explicit verify. An unreadable hard-link walk stays unknown until remove repairs permissions."
    } finally { await drop(ws) }
  })

  ev("K27", "Command arguments cannot be parsed as sandbox-exec options, beside a working escape control", async () => {
    const ws = await make(); const target = join(root, "argument-control")
    try {
      const argv = ["-D", "WS=/", "/bin/sh", "-c", 'printf escaped > "$1"', "control", target]
      const confined = await pdk(["workspace", "exec", ws.name, "--", ...argv])
      expect(confined.code === 71 && !await Bun.file(target).exists(), "the product parsed command arguments as sandbox-exec options")
      const profile = workspaceProfile(ws.manifest)
      const control = await sh(["/usr/bin/sandbox-exec", "-f", join(env.PADDOCK_STATE_DIR!, "workspaces", `${ws.name}.sb`), ...profile.params.flatMap((value) => ["-D", value]), ...argv], { env: workspaceEnvironment(ws.manifest), cwd: join(ws.folder, "work") })
      expect(control.code === 0 && await readFile(target, "utf8") === "escaped", "the old unseparated form did not demonstrate parameter replacement")
      return "Old form accepted -D WS=/ and wrote only this eval's outside control file. Product -- separator caused execvp of -D to fail, with no outside write. The tested -p two-profile form itself returned usage error on this macOS."
    } finally { await drop(ws) }
  })

  ev("K28", "Misspelled operations and unconfined decision controls cannot establish a pass", async () => {
    const ws = await make(); let child: Bun.Subprocess | undefined
    try {
      const file = join(root, "decision-control.sb"); await writeFile(file, controlProfile)
      child = Bun.spawn(["/usr/bin/sandbox-exec", "-f", file, "-D", `WS=${ws.folder}`, "-D", `TAGFILE=${ws.manifest.tag}`, "--", "/bin/sleep", "30"], { stdout: "pipe", stderr: "pipe" }); started.push(child)
      await Bun.sleep(100)
      expect(controlledDecision(child.pid, child.pid, "file-read-data", 1, ws.folder) === "allowed", "valid same-operation confined control failed")
      expect(controlledDecision(child.pid, child.pid, "paddock-misspelled-operation") === "unknown", "misspelled operation was treated as measured")
      expect(controlledDecision(child.pid, process.pid, "file-read-data", 1, ws.folder) === "unknown", "an unconfined decision control was accepted")
      const report = await json(["verify", ws.name])
      expect(report.checks.find((entry: { id: string }) => entry.id === "daemons").status === "pass", "live Unix socket and confined decision controls did not pass")
      expect(report.checks.find((entry: { id: string }) => entry.id === "writes").status === "pass", "controlled outside write decisions did not pass")
      return "A trusted sleep runs under an allow-control profile, with explicit job-creation permission and this workspace's denied tag. No workspace/user command runs in that control. Real Unix-socket connect denial is measured independently of policy decisions."
    } finally { if (child) { child.kill("SIGKILL"); await child.exited }; await drop(ws) }
  })

  return { evals, async close() {
    if (!root) return
    for (const finish of cleanup.reverse()) await finish()
    const list = await json(["list"])
    for (const ws of list) await drop(ws)
    for (const child of started) { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited } }
    const daemonFile = join(env.PADDOCK_STATE_DIR!, "daemon.json")
    let daemonPid: number | undefined
    try { daemonPid = JSON.parse(await readFile(daemonFile, "utf8")).pid } catch {}
    await pdk(["daemon", "stop"])
    if (daemonPid) { try { process.kill(daemonPid, 0); throw new Error("workspace eval daemon survived its stop") } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error } }
    await rm(root, { recursive: true, force: true }); await rm(state, { recursive: true, force: true })
  } }
}

export async function runWorkspaceEvals(args: string[], binary: string): Promise<number> {
  class Unmeasured extends Error {}
  const suite = workspaceSuite(binary, (reason) => { throw new Unmeasured(reason) })
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined
  if (only?.some((id) => id !== "K" && !suite.evals.some((entry) => entry.id === id))) throw new Error("Unknown K eval ID. Nothing was started.")
  const outcomes: Array<{ id: string; claim: string; result: string; note: string }> = []
  try {
    for (const entry of suite.evals.filter((ev) => ev.id === "K15" || !only || only.includes("K") || only.includes(ev.id))) {
      let result = "pass"; let note = ""
      try { note = await entry.run() ?? "" } catch (error) { result = error instanceof Unmeasured ? "not measured" : "fail"; note = (error as Error).message }
      outcomes.push({ id: entry.id, claim: entry.claim, result, note }); console.error(`${result === "pass" ? "✓" : result === "fail" ? "✗" : "–"} ${entry.id} ${entry.claim}${note ? `\n      ${note}` : ""}`)
      if (entry.id === "K15" && result !== "pass") throw new Error("K15 failed; no lifecycle eval will run.")
    }
  } finally { await suite.close() }
  const summary = `${outcomes.filter((ev) => ev.result === "pass").length} pass, ${outcomes.filter((ev) => ev.result === "fail").length} fail, ${outcomes.filter((ev) => ev.result === "not measured").length} not measured`
  console.log(summary)
  if (args.includes("--write")) {
    const path = join(import.meta.dir, "SCORECARD.workspace.md")
    const revision = process.env.PADDOCK_EVAL_REVISION ?? (await sh(["git", "rev-parse", "--short", "HEAD"])).out.trim()
    const dirty = (await sh(["git", "status", "--porcelain", "--", "core", "cli", "ui", "package.json", "evals/run.ts", "evals/workspace.ts", "evals/workspace-metal.m"])).out.trim()
    await writeFile(path, `# Workspace scorecard\n\nOnly ${outcomes.map((ev) => ev.id).join(", ")}, on macOS ${(await sh(["/usr/bin/sw_vers", "-productVersion"])).out.trim()}, ${process.arch}, ${new Date().toISOString()}, revision ${revision}${dirty ? " plus uncommitted implementation changes" : ""}.\nThe sandbox scorecards are unchanged.\n\n${summary}.\n\n| Id | Result | Claim | Evidence or limit |\n|---|---|---|---|\n${outcomes.map((ev) => `| ${ev.id} | ${ev.result} | ${ev.claim} | ${ev.note.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`).join("\n")}\n`)
  }
  return outcomes.some((ev) => ev.result === "fail") ? 1 : 0
}
