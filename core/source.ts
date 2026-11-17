import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// Imported as a macro (core/daemon.ts), so it runs when the program is bundled or loaded, never in a compiled binary:
// the digest of every source file that goes into Asidee, the same for each platform's build of one source tree.
export function sourceDigest(): string {
  const root = join(import.meta.dir, "..")
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
  const hash = createHash("sha256")
  for (const file of [...["core", "cli", "ui"].flatMap((dir) => walk(join(root, dir))), join(root, "package.json")].map((file) => relative(root, file)).sort())
    hash.update(`${file}\0`).update(readFileSync(join(root, file))).update("\0")
  return hash.digest("hex")
}
