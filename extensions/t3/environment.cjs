// Chrome refuses its own sandbox as root, so a T3 server running as root opens its browser only with this setting.
// T3 reads it when the server starts. The desktop app starts the server with `ssh HOST sh -s`, and bash reads
// ~/.bashrc for an SSH command only until its interactive-only guard, so the block goes at the top.
const fs = require("fs"), path = require("path"), os = require("os")
const file = process.argv[1] || path.join(os.homedir(), ".bashrc")
const block = ["# Asidee T3 extension: T3 runs as root here, and Chrome refuses its own sandbox as root, so T3's browser runs without it.",
  "export T3CODE_SERVER_BROWSER_SANDBOX=0", "# End of the Asidee T3 extension block."]
if (process.getuid() !== 0) process.stdout.write("not-root\n")
else {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
  const lines = before.split("\n"), start = lines.indexOf(block[0]), end = lines.indexOf(block[2])
  const rest = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines
  const after = [...block, ...rest].join("\n").replace(/\n?$/, "\n")
  if (after !== before) {
    const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o644
    fs.writeFileSync(file + ".asidee", after, { mode }); fs.renameSync(file + ".asidee", file)
  }
  process.stdout.write("set\n")
}
