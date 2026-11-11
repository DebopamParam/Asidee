import { createServer, type AddressInfo, type Server, type Socket } from "node:net"
import { PaddockError, type Session } from "./types"

// A forward: one listener on this machine's loopback, each of whose connections is relayed through a session to the
// same port on the sandbox's own loopback. It belongs to one run of one sandbox (its id and generation), never to a name.
export type ForwardView = {
  id: string; name: string; sandboxId: string; generation: string
  localAddress: "127.0.0.1"; localPort: number; port: number; connections: number; createdAt: string
}

export function validPort(value: unknown, what: string): number {
  const port = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) throw new PaddockError("usage", `${what} must be a whole number from 1 to 65535.`)
  return port as number
}

// Binds once. Without a local port the system picks a free one, so nothing is probed and then assumed still free.
export function listenLoopback(localPort?: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: true })
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
      ? new PaddockError("conflict", `127.0.0.1:${localPort} is already in use on this machine. Choose another --local-port, or leave it out to get a free one.`)
      : new PaddockError("runtime", `Could not listen on 127.0.0.1:${localPort ?? 0}: ${error.message}`)))
    server.listen({ host: "127.0.0.1", port: localPort ?? 0, exclusive: true }, () => resolve(server))
  })
}

export const boundPort = (server: Server) => (server.address() as AddressInfo).port

// Moves bytes between a connection and a session until both sides are done. Each direction waits for the other side to
// take what it was given, and end of input is passed on as a half-close. The sandbox's stderr is not part of the
// connection's bytes and is dropped.
// How long a connection whose client has sent FIN may wait for the port's next byte.
export const FIN_QUIET_MS = 10 * 60_000
export function relay(socket: Socket, session: Session, quietAfterFinMs = FIN_QUIET_MS): void {
  let socketWaits = false; let sessionWaits = false
  let quiet: ReturnType<typeof setTimeout> | undefined
  // After a client's FIN nothing more can show that it is still there: one that has gone looks the same as one waiting
  // for a slow answer, until something is written to it. So the relay stays while the port keeps answering, and goes
  // once it has been silent this long.
  const waitQuietly = () => { clearTimeout(quiet); quiet = setTimeout(() => { session.close(); socket.destroy() }, quietAfterFinMs); quiet.unref() }
  socket.on("error", () => session.close())
  socket.on("data", (chunk: Buffer) => { if (!session.write(chunk) && !socketWaits) { socketWaits = true; socket.pause() } })
  session.on("drain", () => { if (socketWaits) { socketWaits = false; socket.resume() } })
  socket.on("end", () => { waitQuietly(); session.end() })
  socket.on("close", () => { clearTimeout(quiet); session.close() })
  session.on("output", (stream, bytes) => {
    if (stream !== "stdout") return
    if (quiet) waitQuietly()
    if (!socket.write(bytes) && !sessionWaits) { sessionWaits = true; session.pause() }
  })
  socket.on("drain", () => { if (sessionWaits) { sessionWaits = false; session.resume() } })
  // A relay that could not reach the port, or was ended, resets the connection instead of ending it cleanly.
  session.on("end", (exit) => { clearTimeout(quiet); if (exit.error === undefined && exit.code === 0) socket.end(); else socket.destroy() })
  socket.resume()
}
