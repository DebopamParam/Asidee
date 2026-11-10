const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto")
function safe(p, directory = false) {
  let at = path.parse(p).root
  for (const part of p.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    try { const got = fs.lstatSync(at); if (got.isSymbolicLink() || (at !== p || directory ? !got.isDirectory() : !got.isFile())) throw new Error() }
    catch (e) { if (e.code !== "ENOENT") throw e }
  }
}
async function main() {
  const workspace = path.resolve(os.homedir(), process.argv[1]), dir = path.join(workspace, "env_docs"), dest = path.join(dir, "SANDBOX.md")
  safe(workspace, true); if (!fs.statSync(workspace).isDirectory()) throw new Error()
  safe(dest)
  let text = ""
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error() }
  if (!text.startsWith("# Sandbox environment\n")) throw new Error()
  const probe = cp.spawnSync("git", ["-C", workspace, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" })
  if (probe.status === 0) {
    const exclude = probe.stdout.trim(); safe(exclude)
    fs.mkdirSync(path.dirname(exclude), { recursive: true, mode: 0o700 })
    const before = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : ""
    if (!before.split(/\r?\n/).includes("/env_docs/")) fs.appendFileSync(exclude, (before && !before.endsWith("\n") ? "\n" : "") + "/env_docs/\n", { mode: 0o600 })
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, ".docs-" + crypto.randomBytes(12).toString("hex"))
  try { fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, dest) }
  finally { fs.rmSync(tmp, { force: true }) }
}
main().catch(() => { process.stderr.write("Environment docs write failed; contents withheld.\n"); process.exitCode = 1 })
