import { expect, test } from "bun:test"
import { GvisorProvider, LABEL_ID } from "../../core/providers/gvisor"
import { validSpec } from "../../core/state"
import type { Manifest, Runner } from "../../core/types"

const manifest: Manifest = { version: 1, name: "demo", id: "attempt", createdAt: "", spec: validSpec({ name: "demo", docker: true }),
  engine: { id: "fake", provider: "gvisor", label: "fake", ready: true, problems: [], data: { context: "fake" } } }

test("failed-create cleanup verifies removal, keeps pre-existing objects and reports every uncertain leftover", async () => {
  for (const mode of ["removed", "foreign", "refused", "unreadable"] as const) {
    const objects = new Map([["network", mode === "foreign" ? "older-attempt" : manifest.id], ["volume", manifest.id]])
    const removals: string[] = []
    const run: Runner = async (argv) => {
      const [kind, operation] = argv.slice(3)
      if (operation === "inspect") {
        expect(argv).toContain(`{{index .Labels "${LABEL_ID}"}}`)
        if (mode === "unreadable") return { exitCode: 1, stdout: "", stderr: "engine unavailable" }
        const owner = objects.get(kind!)
        return owner ? { exitCode: 0, stdout: owner, stderr: "" } : { exitCode: 1, stdout: "", stderr: `No such ${kind}` }
      }
      if (operation === "rm") {
        removals.push(kind!)
        if (mode !== "refused") objects.delete(kind!)
        return { exitCode: mode === "refused" ? 1 : 0, stdout: "", stderr: mode === "refused" ? "resource busy" : "" }
      }
      throw new Error(`unexpected ${argv}`)
    }
    const cleanup = new GvisorProvider(run).remove(manifest, true)
    if (mode === "removed" || mode === "foreign") {
      await cleanup
      expect([...objects.keys()]).toEqual(mode === "foreign" ? ["network"] : [])
      expect(removals).toEqual(mode === "foreign" ? ["volume"] : ["network", "volume"])
    } else {
      let message = ""
      try { await cleanup } catch (error) { message = (error as Error).message }
      expect(message).toContain("network paddock-net-demo")
      expect(message).toContain("volume paddock-docker-attempt")
      expect(message).toContain(mode === "refused" ? "remains" : "presence could not be checked")
    }
  }
})

test("the recovery remove command reports a network that the engine leaves behind", async () => {
  const run: Runner = async (argv) => {
    const [kind, operation] = argv.slice(3)
    if (kind === "inspect") return { exitCode: 1, stdout: "", stderr: "No such container: paddock-demo" }
    if (kind === "volume") return { exitCode: 1, stdout: "", stderr: "No such volume" }
    if (kind === "network" && operation === "rm") return { exitCode: 1, stdout: "", stderr: "network has active endpoints" }
    if (kind === "network" && operation === "inspect") return { exitCode: 0, stdout: "[{}]", stderr: "" }
    if (kind === "image") return { exitCode: 0, stdout: "", stderr: "" }
    throw new Error(`unexpected ${argv}`)
  }
  await expect(new GvisorProvider(run).remove(manifest)).rejects.toThrow("paddock-net-demo")
})

test("a missing image names the image and engine reason as a dependency problem", async () => {
  const provider = new GvisorProvider(async (argv) => argv.slice(3)[0] === "create"
    ? { exitCode: 1, stdout: "", stderr: "Unable to find image 'bad/image:0' locally\nError response from daemon: pull access denied for bad/image, repository does not exist" }
    : { exitCode: 0, stdout: "", stderr: "" })
  await expect(provider.create({ ...manifest, spec: { ...manifest.spec, image: "bad/image:0", docker: false } })).rejects.toMatchObject({ code: "dependency", message: "Cannot download image bad/image:0: pull access denied for bad/image, repository does not exist." })
})
