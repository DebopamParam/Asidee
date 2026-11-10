# Runs a command on a new terminal, the way a person's terminal would: waits until the command goes quiet, types the
# text given on stdin, prints everything the terminal showed, and exits with the command's exit code.
import os, pty, select, signal, sys, time

typed = sys.stdin.buffer.read()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
deadline = time.time() + 30
sent = not typed
while time.time() < deadline:
    try:
        ready = select.select([fd], [], [], 1.5)[0]
        if not ready:
            if sent: continue
            os.write(fd, typed); sent = True; continue
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data: break
    sys.stdout.buffer.write(data); sys.stdout.flush()
else:
    os.kill(pid, signal.SIGKILL)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
