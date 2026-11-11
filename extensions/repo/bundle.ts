import { createHash } from "node:crypto"
import { inflateSync } from "node:zlib"
import { object } from "./client"

export const MAX_OBJECT_BYTES = 32 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 128 * 1024 * 1024
export const MAX_OBJECTS = 10_000

// Bound expansion before passing guest bytes to Git. Git still verifies object syntax and connectivity separately.
export function inspectBundle(data: Buffer, tip: string, ref: string): { format: "sha1" | "sha256"; pack: Buffer } {
  const fail = (): never => { throw new Error("Invalid bundle or expanded history exceeds limits (32 MiB per object, 128 MiB total, 10000 objects); contents withheld.") }
  const end = data.indexOf("\n\n")
  if (end < 0 || end > 4096) fail()
  const header = data.subarray(0, end).toString("utf8").split("\n"), signature = header.shift()
  let format: "sha1" | "sha256" = "sha1"
  if (signature === "# v3 git bundle") {
    if (header[0] === "@object-format=sha256") { format = "sha256"; header.shift() }
    else if (header[0] === "@object-format=sha1") header.shift()
  } else if (signature !== "# v2 git bundle") fail()
  if (tip.length !== (format === "sha1" ? 40 : 64) || header.length !== 1 || header[0] !== tip + " " + ref) fail()
  const pack = data.subarray(end + 2), hashBytes = format === "sha1" ? 20 : 32
  if (pack.length < 12 + hashBytes || pack.toString("ascii", 0, 4) !== "PACK" || ![2, 3].includes(pack.readUInt32BE(4))) fail()
  const count = pack.readUInt32BE(8), trailer = pack.length - hashBytes
  if (!count || count > MAX_OBJECTS || !createHash(format).update(pack.subarray(0, trailer)).digest().equals(pack.subarray(trailer))) fail()
  let offset = 12, expanded = 0
  const byte = () => { if (offset >= trailer) fail(); return pack[offset++]! }
  for (let index = 0; index < count; index++) {
    let head = byte(), size = head & 15, factor = 16
    const type = (head >> 4) & 7
    if (![1, 2, 3, 4, 6, 7].includes(type)) fail()
    while (head & 128) {
      head = byte(); size += (head & 127) * factor; factor *= 128
      if (!Number.isSafeInteger(factor) || size > MAX_OBJECT_BYTES) fail()
    }
    if (type === 6) { let steps = 0; while (byte() & 128) if (++steps > 7) fail() }
    else if (type === 7) { offset += hashBytes; if (offset >= trailer) fail() }
    let inflated: unknown
    try { inflated = inflateSync(pack.subarray(offset, trailer), { info: true, maxOutputLength: Math.max(1, Math.min(size, MAX_OBJECT_BYTES)) }) }
    catch { return fail() }
    if (!object(inflated) || !Buffer.isBuffer(inflated.buffer) || !object(inflated.engine) || typeof inflated.engine.bytesWritten !== "number") return fail()
    const buffer = inflated.buffer, consumed = inflated.engine.bytesWritten
    if (buffer.length !== size || !Number.isSafeInteger(consumed) || consumed < 1) fail()
    offset += consumed
    expanded += size
    if (type === 6 || type === 7) {
      let cursor = 0
      const deltaSize = () => {
        let value = 0, scale = 1, next: number
        do {
          if (cursor >= buffer.length) fail()
          next = buffer[cursor++]!; value += (next & 127) * scale; scale *= 128
          if (!Number.isSafeInteger(scale) || value > MAX_OBJECT_BYTES) fail()
        } while (next & 128)
        return value
      }
      deltaSize(); expanded += deltaSize()
    }
    if (expanded > MAX_EXPANDED_BYTES) fail()
  }
  if (offset !== trailer) fail()
  return { format, pack }
}
