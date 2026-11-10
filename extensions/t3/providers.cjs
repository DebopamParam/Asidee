const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto")
const home = os.homedir(), target = path.join(home, ".t3/userdata/settings.json"), ownershipFile = path.join(home, ".t3/userdata/paddock-providers.json")
const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
const exists = p => { try { return fs.lstatSync(p) } catch (e) { if (e.code === "ENOENT") return; throw e } }
function safe(p, directory = false) {
  let at = home
  for (const part of path.relative(home, p).split(path.sep).filter(Boolean)) {
    if (part === "..") throw new Error()
    at = path.join(at, part); const got = exists(at)
    if (got && (got.isSymbolicLink() || (at !== p || directory ? !got.isDirectory() : !got.isFile()))) throw new Error()
  }
}
function read(p) { safe(p); return exists(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {} }
function atomic(file, value) {
  safe(file)
  const tmp = file + "." + crypto.randomBytes(12).toString("hex")
  try { fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.renameSync(tmp, file) }
  finally { if (exists(tmp)) fs.unlinkSync(tmp) }
}
function main() {
  safe(target)
  const settings = read(target)
  if (!object(settings) || (settings.providerInstances !== undefined && !object(settings.providerInstances))) throw new Error()
  const instances = settings.providerInstances || {}, ownership = read(ownershipFile), records = ownership.instances || []
  if (!object(ownership) || !Array.isArray(records) || !records.every(item => object(item) && typeof item.id === "string" && ["claudeAgent", "codex"].includes(item.driver) && typeof item.homePath === "string")) throw new Error()
  const owned = records.filter(item => instances[item.id]?.driver === item.driver && instances[item.id]?.config?.homePath === item.homePath).map(item => item.id)
  const wanted = [], nextRecords = [], counts = { claude: 0, codex: 0 }
  for (const agent of ["claude", "codex"]) {
    const credential = agent === "claude" ? ".credentials.json" : "auth.json", driver = agent === "claude" ? "claudeAgent" : "codex"
    const profiles = fs.readdirSync(home).filter(name => name === "." + agent || (name.startsWith("." + agent + "-") && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(name.slice(agent.length + 2)))).sort()
      .filter(name => { const dir = path.join(home, name); return exists(dir)?.isDirectory() && exists(path.join(dir, credential))?.isFile() })
    const current = instances[driver]?.config?.homePath
    const primary = profiles.find(name => path.join(home, name) === current) || profiles.find(name => name === "." + agent + "-default") || profiles.find(name => name === "." + agent) || profiles[0]
    for (const name of profiles) {
      const profile = name === "." + agent ? "canonical" : name.slice(agent.length + 2), dir = path.join(home, name)
      let id = name === primary ? driver : agent + "-" + profile
      // An unowned collision belongs to the user, including a built-in provider they configured themselves.
      if (Object.hasOwn(instances, id) && !owned.includes(id)) {
        id = "paddock-" + agent + "-" + profile
        if (Object.hasOwn(instances, id) && !owned.includes(id)) throw new Error()
      }
      if (wanted.includes(id)) throw new Error()
      const before = instances[id] || {}
      if (!object(before)) throw new Error()
      instances[id] = { ...before, driver, displayName: (agent === "claude" ? "Claude" : "Codex") + " (" + profile + ")", enabled: true, config: { ...(object(before.config) ? before.config : {}), homePath: dir },
        ...(agent === "claude" ? { environment: [...(Array.isArray(before.environment) ? before.environment : []).filter(item => item?.name !== "ANTHROPIC_API_KEY"), { name: "ANTHROPIC_API_KEY", value: "", sensitive: false }] } : {}) }
      wanted.push(id); nextRecords.push({ id, driver, homePath: dir }); counts[agent]++
    }
  }
  for (const id of owned) if (!wanted.includes(id)) delete instances[id]
  settings.providerInstances = instances
  safe(path.dirname(target), true); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  // Keep both generations until publication, so an interrupted two-file update retains ownership on retry.
  atomic(ownershipFile, { instances: [...records, ...nextRecords].filter((item, index, all) => all.findIndex(other => other.id === item.id && other.driver === item.driver && other.homePath === item.homePath) === index) })
  atomic(target, settings)
  atomic(ownershipFile, { instances: nextRecords })
  process.stdout.write(JSON.stringify(counts) + "\n")
}
const lock = path.join(home, ".paddock-logins.lock")
let locked = false
try { safe(lock, true); fs.mkdirSync(lock, { mode: 0o700 }); locked = true; main() }
catch { process.stderr.write("Provider sync failed; settings left intact on validation failure; contents withheld.\n"); process.exitCode = 1 }
finally { if (locked) fs.rmdirSync(lock) }
