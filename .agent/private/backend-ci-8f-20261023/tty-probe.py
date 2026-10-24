import os, pty
read_fd, write_fd = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(write_fd)
    
    try:
        fg = os.tcgetpgrp(1)
    except OSError as error: fg = f'ERR{error.errno}'
    os.write(2, f'BEFORE pgrp={os.getpgrp()} sid={os.getsid(0)} tty={os.ttyname(1)} fg={fg}\n'.encode())
    os.dup2(read_fd, 0)
    if read_fd != 0: os.close(read_fd)
    try:
        fd = os.open('/dev/tty', os.O_RDWR)
        os.write(2, b'OPEN_OK\n')
        os.close(fd)
    except OSError as error:
        os.write(2, f'OPEN_FAIL:{error.errno}\n'.encode())
    try:
        fd = os.open('/dev/tty', os.O_RDONLY)
        os.write(2, b'OPEN_READ_OK\n')
        os.close(fd)
    except OSError as error:
        os.write(2, f'OPEN_READ_FAIL:{error.errno}\n'.encode())
    os._exit(0)
os.close(read_fd)
os.write(write_fd, b'x')
os.close(write_fd)
while True:
    try:
        data = os.read(master, 1024)
        if not data: break
        os.write(1, data)
    except OSError: break
os.waitpid(pid, 0)
os.close(master)
