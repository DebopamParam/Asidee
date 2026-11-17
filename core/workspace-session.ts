import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { constants } from "node:os"
import { EventEmitter } from "node:events"
import { OUTPUT_LIMIT } from "./run"
import { AsideeError, type DiskWarning, type RunResult, type Session } from "./types"
import { signalWorkspacePid } from "./workspace-processes"

export class WorkspaceSession extends EventEmitter implements Session {
  readonly tty: boolean
  diskWarning?: DiskWarning
  readonly pid: number
  readonly finished: Promise<void>
  private child?: ChildProcessWithoutNullStreams
  private terminal?: Bun.Terminal
  private pending: Uint8Array[] = []
  private pendingBytes = 0
  private paused = true
  ended = false
  constructor(private readonly options: { argv: string[]; cwd: string; env: Record<string, string>; folder: string; tty: boolean; cols?: number; rows?: number }) {
    super(); this.tty = options.tty
    this.finished = new Promise((resolve) => this.once("end", () => resolve()))
    const finish = (exit: { code?: number; error?: string }) => {
      if (this.ended) return
      this.ended = true; this.terminal?.close(); this.emit("end", exit)
    }
    if (this.tty) {
      this.terminal = new Bun.Terminal({ cols: options.cols ?? 80, rows: options.rows ?? 24, name: options.env.TERM ?? "xterm-256color",
        data: (_terminal, data) => {
          if (this.ended) return
          if (!this.paused) { this.emit("output", "stdout", data); return }
          this.pendingBytes += data.byteLength
          if (this.pendingBytes > 1024 * 1024) { this.close("The terminal reader fell behind by more than 1 MiB; output was discarded."); return }
          this.pending.push(data.slice())
        }, drain: () => this.emit("drain") })
      const child = Bun.spawn(options.argv, { cwd: options.cwd, env: options.env, terminal: this.terminal })
      this.pid = child.pid
      void child.exited.then((code) => { this.resume(); finish({ code: child.signalCode ? 128 + (typeof child.signalCode === "number" ? child.signalCode : constants.signals[child.signalCode]) : code }) })
    } else {
      const child = spawn(options.argv[0]!, options.argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] })
      this.child = child; this.pid = child.pid ?? -1
      child.stdout.pause(); child.stderr.pause()
      child.stdout.on("data", (bytes: Buffer) => this.emit("output", "stdout", bytes))
      child.stderr.on("data", (bytes: Buffer) => this.emit("output", "stderr", bytes))
      child.stdin.on("drain", () => this.emit("drain")); child.stdin.on("error", () => {})
      child.once("error", () => finish({ error: "Could not start the workspace command." }))
      child.once("close", (code, signal) => finish({ code: signal ? 128 + constants.signals[signal] : code ?? 1 }))
    }
  }
  stopping(reason: string): void {
    if (!this.ended) this.emit("output", "stderr", Buffer.from(`${reason}\n`))
  }
  write(bytes: Uint8Array): boolean {
    if (this.ended) return false
    if (this.terminal) { this.terminal.write(Buffer.from(bytes)); return true }
    return this.child!.stdin.write(bytes)
  }
  end(): void { if (!this.tty) this.child?.stdin.end() }
  async resize(cols: number, rows: number): Promise<void> { this.terminal?.resize(cols, rows) }
  pause(): void { this.paused = true; this.child?.stdout.pause(); this.child?.stderr.pause() }
  resume(): void {
    this.paused = false
    while (this.pending.length && !this.paused) { const bytes = this.pending.shift()!; this.pendingBytes -= bytes.byteLength; this.emit("output", "stdout", bytes) }
    this.child?.stdout.resume(); this.child?.stderr.resume()
  }
  close(reason = "The workspace session was closed."): void {
    if (this.ended) return
    // Only this session's starter is ended here. Detached descendants remain tracked until workspace stop/remove.
    try { signalWorkspacePid(this.pid, this.options.folder, "SIGKILL") } catch { reason = `${reason} Its pid could not be tied to the workspace; no signal was sent.` }
    this.ended = true; this.terminal?.close(); this.child?.stdin.destroy(); this.child?.stdout.destroy(); this.child?.stderr.destroy()
    this.emit("end", { error: reason })
  }
  collect(stdin?: string | Uint8Array, timeoutMs = 0): Promise<RunResult> {
    if (this.tty) throw new AsideeError("usage", "Buffered workspace output needs pipes.")
    return new Promise((resolve) => {
      const chunks = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] }; const sizes = { stdout: 0, stderr: 0 }
      let overflow: "stdout" | "stderr" | undefined; let timedOut = false
      const timer = timeoutMs ? setTimeout(() => { timedOut = true; this.close("The workspace command timed out.") }, timeoutMs) : undefined
      this.on("output", (which: "stdout" | "stderr", bytes: Uint8Array) => {
        sizes[which] += bytes.byteLength
        if (sizes[which] > OUTPUT_LIMIT) { overflow = which; this.close("The workspace output limit was exceeded."); return }
        chunks[which].push(bytes)
      })
      this.once("end", (exit: { code?: number; error?: string }) => {
        clearTimeout(timer)
        resolve(overflow ? { exitCode: 124, stdout: "", stderr: `Workspace ${overflow} exceeded ${OUTPUT_LIMIT / 1024 ** 2} MiB; output was discarded.`, overflow }
          : timedOut || exit.error ? { exitCode: 124, stdout: "", stderr: exit.error ?? "Workspace command timed out." }
          : { exitCode: exit.code ?? 1, stdout: Buffer.concat(chunks.stdout).toString("utf8"), stderr: Buffer.concat(chunks.stderr).toString("utf8") })
      })
      this.resume(); if (stdin) this.child!.stdin.end(stdin); else this.end()
    })
  }
}
