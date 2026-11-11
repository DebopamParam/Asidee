import { PaddockError, type Engine, type Provider, type Runner } from "../types"

// Docker Sandboxes (the `sbx` CLI): each sandbox is a microVM. Only detection exists so far, so `paddock doctor` can say
// that it is installed and not usable yet, instead of claiming support that has not been built and probed.
export class DockerSandboxesProvider implements Provider {
  readonly id = "docker-sandboxes"
  constructor(private readonly run: Runner) {}

  async detect(): Promise<Engine[]> {
    const version = await this.run(["sbx", "version"], { timeoutMs: 10_000 })
    if (version.exitCode !== 0) return []
    return [{
      id: "docker-sandboxes", provider: this.id, label: `Docker Sandboxes (${version.stdout.trim().split("\n")[0]})`, ready: false,
      problems: ["Paddock does not support Docker Sandboxes yet."], data: {},
    }]
  }

  private unsupported(): never { throw new PaddockError("dependency", "Paddock does not support Docker Sandboxes yet.") }
  create() { return this.unsupported() }
  prepare() { return this.unsupported() }
  start() { return this.unsupported() }
  stop() { return this.unsupported() }
  remove() { return this.unsupported() }
  status() { return this.unsupported() }
  exec() { return this.unsupported() }
  openExec() { return this.unsupported() }
  checks() { return this.unsupported() }
  diskUsedBytes() { return this.unsupported() }
  stoppedWhy() { return this.unsupported() }
  async sweep() {}
}
