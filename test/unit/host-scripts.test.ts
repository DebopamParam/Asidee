import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOST_APPLY, HOST_PROBE, HOST_REQUEST, HOST_ROOT_STEP } from "../../core/host-scripts"

async function python(script: string, input: unknown) {
  const child = Bun.spawn(["python3", "-c", script], { stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

test("B7: a swapped input is refused and the command uses the checked private copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-root-step-"))
  try {
    const source = join(root, "source"); const result = join(root, "result")
    await writeFile(source, "checked")
    const checksum = new Bun.CryptoHasher("sha256").update("checked").digest("hex")
    const invoke = (script: string) => python(`import sys, json\np=json.load(sys.stdin)\nsys.argv=['step',json.dumps(p['checks']),'python3','-c',p['command'],p['source']]\nexec(p['script'])`, { script: HOST_ROOT_STEP, source, checks: { [source]: checksum }, command: script })
    expect((await invoke(`import sys,pathlib; pathlib.Path(${JSON.stringify(source)}).write_text('swapped'); pathlib.Path(${JSON.stringify(result)}).write_bytes(pathlib.Path(sys.argv[1]).read_bytes())`)).code).toBe(0)
    expect(await Bun.file(result).text()).toBe("checked")
    await rm(result)
    const refused = await invoke(`import pathlib; pathlib.Path(${JSON.stringify(result)}).touch()`)
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain("checksum mismatch")
    expect(await Bun.file(result).exists()).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("B8/B10: leftover staging cannot block retry and each privileged step refreshes interactive sudo", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-apply-"))
  const script = `import sys,json,subprocess,tempfile,types\nx=json.load(sys.stdin)\ntempfile.tempdir=x['root']\np=x['plan']\nsys.stdin=__import__('io').StringIO(json.dumps(p))\ncalls=[]\ndef run(argv,**kw):\n if argv==['sudo','-v']:\n  calls.append(argv); return types.SimpleNamespace(returncode=0,stdout=b'',stderr=b'')\n if argv[0]=='python3': return types.SimpleNamespace(returncode=0,stdout=b'{}',stderr=b'')\n if not calls or calls[-1]!=['sudo','-v']: raise RuntimeError('sudo timestamp expired')\n calls.append(argv)\n return types.SimpleNamespace(returncode=0,stdout=b'',stderr=b'')\nsubprocess.run=run\nexec(x['script'])\nprint(json.dumps(calls))`
  try {
    const plan = { hash: "x", stageDir: root, stateDir: join(root, "state"), uploads: [], changes: [], interactive: true, probeScript: "", probeRequest: {}, destination: {}, steps: [{ label: "one", argv: ["sudo", "-n", "slow"] }, { label: "two", argv: ["sudo", "-n", "next"] }] }
    const paths: string[] = []
    for (let i = 0; i < 2; i++) {
      const result = await python(script, { root, plan, script: HOST_APPLY })
      expect(result.code).toBe(0)
      const [line, calls] = result.out.trim().split("\n")
      const report = JSON.parse(line!.replace(/^PADDOCK-RESULT /, ""))
      expect(report.ok).toBe(true)
      paths.push(report.stageDir)
      expect(JSON.parse(calls!)).toEqual([["sudo", "-v"], ["sudo", "-n", "slow"], ["sudo", "-v"], ["sudo", "-n", "next"]])
    }
    expect(paths[0]).not.toBe(paths[1])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("B8: request files use fresh destination paths and report them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-request-"))
  try {
    const script = `import sys,json,tempfile,io\nx=json.load(sys.stdin)\ntempfile.tempdir=x['root']\nsys.stdin=io.TextIOWrapper(io.BytesIO(b'private request'))\nexec(x['script'])`
    const paths: string[] = []
    for (let i = 0; i < 2; i++) {
      const result = await python(script, { root, script: HOST_REQUEST })
      expect(result.code).toBe(0)
      paths.push(result.out.trim())
      expect(await Bun.file(paths[i]!).text()).toBe("private request")
    }
    expect(paths[0]).not.toBe(paths[1])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("B9: repository text removes URL userinfo and binds original bytes by hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdk-repository-"))
  try {
    const source = join(root, "private.sources")
    const content = "deb https://fixture-user:fixture-password@repo.example/private stable main\nURIs: http://name:password@repo.example/other\n"
    await writeFile(source, content)
    const script = `import sys,json,subprocess,types,builtins,glob,io,contextlib\nx=json.load(sys.stdin)\noriginal=builtins.open\ndef opened(path,*a,**kw):\n if path=='/etc/os-release': return io.StringIO('ID=ubuntu')\n if path in ['/etc/machine-id','/proc/sys/kernel/random/boot_id']: return io.StringIO('fixture')\n return original(path,*a,**kw)\nbuiltins.open=opened\nglob.glob=lambda pattern: [x['source']] if pattern=='/etc/apt/sources.list' else []\nsubprocess.run=lambda argv,**kw: types.SimpleNamespace(returncode=1,stdout='',stderr='')\nsys.stdin=io.StringIO(json.dumps({'sha256':'a'*64,'runtimeFiles':[]}))\nout=io.StringIO()\nwith contextlib.redirect_stdout(out): exec(x['script'])\nvalue=json.loads(out.getvalue())\nprint(json.dumps({'repositories':value['repositories'],'apt':value['apt']}))`
    const result = await python(script, { source, script: HOST_PROBE })
    expect(result.code).toBe(0)
    expect(result.out).not.toContain("fixture-user")
    expect(result.out).not.toContain("password")
    const value = JSON.parse(result.out)
    expect(value.repositories[source]).toContain("https://repo.example/private")
    expect(value.apt[source]).toBe(new Bun.CryptoHasher("sha256").update(content).digest("hex"))
  } finally { await rm(root, { recursive: true, force: true }) }
})
