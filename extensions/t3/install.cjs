const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process")
const [version, base] = process.argv.slice(1)
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
function fail() { throw new Error() }
function directory(p) {
  const parent = path.dirname(p)
  if (parent !== p) directory(parent)
  if (!fs.existsSync(p)) fs.mkdirSync(p, { mode: 0o700 })
  if (!fs.lstatSync(p).isDirectory()) fail()
}
function download(url, file, limit, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    // HTTP is only for loopback fixture servers. The shipped client always supplies the HTTPS release URL.
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) return reject(new Error())
    const request = require(parsed.protocol === "https:" ? "https" : "http").get(parsed, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        if (!response.headers.location || redirects >= 5) return reject(new Error())
        const next = new URL(response.headers.location, parsed)
        if (parsed.protocol === "https:" && next.protocol !== "https:") return reject(new Error())
        return resolve(download(next.href, file, limit, redirects + 1))
      }
      if (response.statusCode !== 200) { response.resume(); return reject(new Error()) }
      const output = fs.createWriteStream(file, { flags: "wx", mode: 0o600 })
      let bytes = 0
      response.on("data", chunk => { bytes += chunk.length; if (bytes > limit) response.destroy(new Error()) })
      response.on("error", error => { output.destroy(); reject(error) })
      output.on("error", error => { response.destroy(); reject(error) })
      output.on("finish", resolve)
      response.pipe(output)
    })
    request.setTimeout(60000, () => request.destroy(new Error()))
    request.on("error", reject)
  })
}
async function main() {
  if (!semver.test(version || "") || version.length > 120) fail()
  const arch = { arm64: "arm64", aarch64: "arm64", x86_64: "x64", x64: "x64" }[os.arch()]
  if (!arch) fail()
  const root = path.join(os.homedir(), ".t3/runtime/versions"), dest = path.join(root, version)
  directory(root)
  if (fs.existsSync(dest) && !fs.lstatSync(dest).isDirectory()) fail()
  const marker = path.join(dest, ".install-complete"), binary = path.join(dest, "t3")
  if (fs.existsSync(marker) && fs.lstatSync(marker).isFile() && fs.readFileSync(marker, "utf8").trim() === version && fs.existsSync(binary) && fs.lstatSync(binary).isFile()) {
    fs.accessSync(binary, fs.constants.X_OK); process.stdout.write("present\n"); return
  }
  const lock = path.join(root, "." + version + ".install.lock")
  const fd = fs.openSync(lock, "wx", 0o600); fs.writeSync(fd, String(process.pid)); fs.closeSync(fd)
  let staging
  try {
    staging = fs.mkdtempSync(path.join(root, ".staging-"))
    const archive = "t3-" + version + "-linux-" + arch + ".tar.gz", sums = path.join(staging, "SHA256SUMS"), tar = path.join(staging, archive)
    await download(base + "/v" + version + "/SHA256SUMS", sums, 1024 * 1024)
    await download(base + "/v" + version + "/" + archive, tar, 256 * 1024 * 1024)
    const matches = fs.readFileSync(sums, "utf8").split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)).filter(match => match && match[2] === archive)
    // tar reads the hashed bytes on stdin, so a file swapped after hashing is never what gets extracted.
    const bytes = fs.readFileSync(tar), actual = crypto.createHash("sha256").update(bytes).digest("hex")
    if (matches.length !== 1 || matches[0][1].toLowerCase() !== actual) fail()
    fs.unlinkSync(tar)
    const listing = cp.spawnSync("tar", ["-tzf", "-"], { input: bytes, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
    if (listing.status !== 0 || listing.stdout.split("\n").filter(Boolean).some(name => name.startsWith("/") || name.split("/").includes(".."))) fail()
    if (cp.spawnSync("tar", ["-xzf", "-", "-C", staging, "--strip-components=1"], { input: bytes, stdio: ["pipe", "ignore", "ignore"] }).status !== 0) fail()
    const executable = path.join(staging, "t3")
    if (!fs.lstatSync(executable).isFile()) fail()
    const probe = cp.spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15000 })
    if (probe.status !== 0 || !new RegExp("^(?:t3\\s+)?v?" + version.replaceAll(".", "\\.") + "\\s*$").test(probe.stdout.trim())) fail()
    fs.unlinkSync(sums)
    fs.writeFileSync(path.join(staging, ".install-complete"), version + "\n", { mode: 0o600 })
    fs.rmSync(dest, { recursive: true, force: true }); fs.renameSync(staging, dest)
    process.stdout.write("installed\n")
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true })
    fs.unlinkSync(lock)
  }
}
main().catch(() => { process.stderr.write("T3 install failed; output withheld. Check tools, release checksums and install lock.\n"); process.exitCode = 1 })
