const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process"), crypto = require("crypto")
const LIMIT = 128 * 1024 * 1024
function fail() { throw new Error() }
function git(work, args) {
  const result = cp.spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", work, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
  if (result.status !== 0) fail()
  return result.stdout.trim()
}
function safeDir(p) {
  let at = path.parse(p).root
  for (const part of p.slice(at.length).split(path.sep).filter(Boolean)) {
    at = path.join(at, part)
    try { if (!fs.lstatSync(at).isDirectory()) fail() } catch (e) { if (e.code !== "ENOENT") throw e }
  }
}
async function main() {
  let text = ""
  for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 8192) fail() }
  const input = JSON.parse(text), work = path.resolve(os.homedir(), input.workspace)
  if (typeof input.workspace !== "string" || !input.workspace || /[\0\r\n]/.test(input.workspace)) fail()
  safeDir(work)
  if (input.action === "clone") {
    if (typeof input.repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(input.repository) || input.repository.endsWith(".git")) fail()
    // A missing path or an empty directory (images often ship an empty ~/workspace); a rename onto anything else fails.
    const vacant = () => { try { const stat = fs.lstatSync(work); return stat.isDirectory() && fs.readdirSync(work).length === 0 } catch (e) { if (e.code === "ENOENT") return true; throw e } }
    if (!vacant()) fail()
    fs.mkdirSync(path.dirname(work), { recursive: true, mode: 0o700 })
    const staging = fs.mkdtempSync(path.join(path.dirname(work), ".asidee-clone-"))
    try {
      const url = "https://github.com/" + input.repository + ".git"
      const authenticated = cp.spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "ignore" }).status === 0
      const args = ["-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", ...(authenticated ? ["-c", "credential.https://github.com.helper=!gh auth git-credential"] : []), "clone", "--", url, path.join(staging, "repo")]
      const result = cp.spawnSync("git", args, { stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
      if (result.status !== 0) fail()
      // Never merge into an existing guest checkout.
      if (!vacant()) fail()
      fs.renameSync(path.join(staging, "repo"), work)
      return { cloned: true }
    } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  }
  if (input.action !== "save") fail()
  const branch = input.branch || git(work, ["symbolic-ref", "--short", "HEAD"])
  if (typeof branch !== "string" || /[\0\r\n]/.test(branch)) fail()
  git(work, ["check-ref-format", "refs/heads/" + branch])
  const tip = git(work, ["rev-parse", "--verify", "refs/heads/" + branch + "^{commit}"])
  const ref = "refs/asidee-export/" + crypto.randomUUID(), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asidee-bundle-")), file = path.join(tmp, "history.bundle")
  try {
    // Pin one commit while the source branch may move. Dirty files, index changes and other refs are excluded.
    git(work, ["update-ref", ref, tip])
    git(work, ["bundle", "create", file, ref])
    const size = fs.statSync(file).size
    if (size > LIMIT) { process.exitCode = 73; return { tooLarge: true, limit: LIMIT } }
    const hash = crypto.createHash("sha256")
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
    // One header line, then the raw bundle: `asd exec --stream` carries bytes unchanged.
    process.stdout.write(JSON.stringify({ branch, tip, ref, size, sha256: hash.digest("hex") }) + "\n")
    for await (const chunk of fs.createReadStream(file)) if (!process.stdout.write(chunk)) await new Promise(done => process.stdout.once("drain", done))
    return undefined
  } finally {
    try { git(work, ["update-ref", "-d", ref, tip]) } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }
}
main().then(result => { if (result !== undefined) process.stdout.write(JSON.stringify(result) + "\n") }).catch(() => { process.stderr.write("Repository operation failed; output withheld. Clone needs a new path; save needs a committed branch and Git.\n"); process.exitCode = 1 })
