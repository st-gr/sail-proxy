# Minimal pty host for the cast recorder: forks the command on a pseudo-terminal of the given size, copies
# the terminal's output to stdout as raw bytes and stdin to the terminal. BSD `script` cannot take a piped
# stdin on macOS, this can. Usage: python3 -I pty-host.py COLS ROWS -- command [args...]
import fcntl
import os
import pty
import select
import struct
import sys
import termios

cols, rows = int(sys.argv[1]), int(sys.argv[2])
cmd = sys.argv[sys.argv.index('--') + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
out = sys.stdout.buffer
while True:
    ready, _, _ = select.select([fd, 0], [], [])
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out.write(data)
        out.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            os.close(fd)
            break
        os.write(fd, data)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
