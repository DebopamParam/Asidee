const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), cp = require("child_process")
const [version] = process.argv.slice(1)
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/
function fail(message) { throw new Error(message) }
// T3 pins its browser in its own code: one Chrome for Testing headless shell, with each platform's size and SHA-256.
function pin(binary, platform) {
  const bytes = fs.readFileSync(binary), at = bytes.indexOf("var init_PreviewBrowser = ")
  if (at < 0) fail("This T3 version's browser pin was not found. T3 installs its browser itself when its browser first opens.")
  const code = bytes.subarray(at, at + 8192).toString("latin1")
  const release = /\bVERSION = "(\d+\.\d+\.\d+\.\d+)";/.exec(code)
  const archive = new RegExp(`"?${platform}"?: \\{\\s*bytes: (\\d+),\\s*sha256: "([0-9a-f]{64})"`).exec(code)
  if (!release || !archive || !code.includes("chrome-for-testing-public/${VERSION}/${chrome}/chrome-headless-shell-${chrome}.zip"))
    fail("This T3 version's browser pin was not found. T3 installs its browser itself when its browser first opens.")
  return { version: release[1], bytes: Number(archive[1]), sha256: archive[2] }
}
async function main() {
  if (!semver.test(version || "") || version.length > 120) fail("Invalid T3 version.")
  const platform = { arm64: "linux-arm64", x64: "linux64" }[os.arch()]
  if (os.platform() !== "linux" || !platform) fail("T3's browser is not available for this system.")
  const t3 = path.join(os.homedir(), ".t3/runtime/versions", version, "t3")
  if (!fs.existsSync(t3)) fail("Set up T3 Code first.")
  const chrome = pin(t3, platform), root = path.join(os.homedir(), ".t3/tools/chrome-headless-shell", platform), dest = path.join(root, chrome.version)
  let browser = "present"
  if (!fs.existsSync(path.join(dest, "chrome-headless-shell"))) {
    fs.mkdirSync(root, { recursive: true, mode: 0o755 })
    const staging = fs.mkdtempSync(path.join(root, ".asidee-"))
    try {
      const zip = path.join(staging, "browser.zip")
      await download(`https://storage.googleapis.com/chrome-for-testing-public/${chrome.version}/${platform}/chrome-headless-shell-${platform}.zip`, zip, chrome.bytes)
      const bytes = fs.readFileSync(zip)
      if (bytes.length !== chrome.bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== chrome.sha256) fail("The browser download did not match T3's checksum; nothing was installed.")
      const listing = cp.spawnSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
      const top = `chrome-headless-shell-${platform}/`
      if (listing.status !== 0 || listing.stdout.split("\n").filter(Boolean).some(name => !name.startsWith(top) || name.split("/").includes(".."))) fail("Unexpected browser archive; nothing was installed.")
      if (cp.spawnSync("unzip", ["-q", zip, "-d", staging], { stdio: "ignore" }).status !== 0) fail("Could not unpack the browser; is unzip installed?")
      const unpacked = path.join(staging, top)
      fs.accessSync(path.join(unpacked, "chrome-headless-shell"), fs.constants.X_OK)
      // A browser T3 installed meanwhile is kept.
      if (!fs.existsSync(dest)) fs.renameSync(unpacked, dest)
      browser = "installed"
    } finally { fs.rmSync(staging, { recursive: true, force: true }) }
  }
  // T3's own setup installs the browser's libraries and fonts with apt, which needs root.
  const root0 = process.getuid() === 0, setup = [t3, "browser", "setup", "--base-dir", path.join(os.homedir(), ".t3")]
  const ran = cp.spawnSync(root0 ? setup[0] : "sudo", root0 ? setup.slice(1) : ["-n", "--preserve-env=DEBIAN_FRONTEND", ...setup], { stdio: "ignore", env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" }, timeout: 15 * 60 * 1000 })
  if (ran.status !== 0) fail(root0 ? "T3's browser setup could not install the browser's libraries and fonts." : "T3's browser setup needs root for the browser's libraries and fonts, and sudo asked for a password.")
  process.stdout.write(JSON.stringify({ chrome: chrome.version, browser }) + "\n")
}
// Only messages written here reach the user: the client prints a line with this prefix and withholds the rest.
main().catch(error => { process.stderr.write(`t3-browser: ${error.message || "T3's browser install failed."}\n`); process.exitCode = 1 })
