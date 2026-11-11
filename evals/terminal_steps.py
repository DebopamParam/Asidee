# Runs a command on a new terminal and follows a script read as JSON from stdin, the way a person at a terminal would:
# ["size", ROWS, COLS] sets the terminal's size (the command gets SIGWINCH), ["wait", TEXT] waits until the screen shows
# TEXT after everything already waited for, ["type", TEXT] types it, ["pause", SECONDS] waits. Prints what the terminal showed and exits with the
# command's exit code; after 40 s it kills the command and exits with 124.
import fcntl, json, os, pty, select, signal, struct, sys, termios, time

steps = json.load(sys.stdin)
def size(fd, rows, cols): fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
pid, fd = pty.fork()
if pid == 0:
    # A first size step is the terminal's size from the start.
    if steps and steps[0][0] == "size": size(0, steps[0][1], steps[0][2])
    os.execvp(sys.argv[1], sys.argv[1:])
shown = b""; seen = 0; deadline = time.time() + 40
def read(timeout):
    global shown
    if select.select([fd], [], [], timeout)[0]:
        data = os.read(fd, 65536)
        if not data: raise OSError
        shown += data; sys.stdout.buffer.write(data); sys.stdout.flush()
try:
    for step in steps:
        if step[0] == "size": size(fd, step[1], step[2])
        elif step[0] == "type": os.write(fd, step[1].encode())
        elif step[0] == "pause":
            until = time.time() + step[1]
            while time.time() < until: read(0.1)
        elif step[0] == "wait":
            want = step[1].encode()
            while shown.find(want, seen) < 0:
                if time.time() > deadline: raise TimeoutError
                read(0.2)
            seen = shown.find(want, seen) + len(want)
    while time.time() < deadline: read(0.2)
except (OSError, TimeoutError):
    pass
if time.time() > deadline:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0); sys.exit(124)
sys.exit(os.waitstatus_to_exitcode(os.waitpid(pid, 0)[1]))
