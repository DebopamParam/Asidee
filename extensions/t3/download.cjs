// Shared by install.cjs and browser.cjs: t3.ts puts it in front of either script.
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
