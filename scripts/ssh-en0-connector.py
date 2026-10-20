#!/usr/bin/env python3
"""One connection through the physical interface, without editing system routes."""
import os
import select
import socket
import sys
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.IPPROTO_IP, 25, socket.if_nametoindex('en0'))
sock.settimeout(12)
sock.connect((sys.argv[1], int(sys.argv[2])))
sock.settimeout(None)
inputs = [0, sock]
try:
    while True:
        ready, _, _ = select.select(inputs, [], [])
        if 0 in ready:
            data = os.read(0, 65536)
            if data:
                sock.sendall(data)
            else:
                sock.shutdown(socket.SHUT_WR)
                inputs.remove(0)
        if sock in ready:
            data = sock.recv(65536)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
finally:
    sock.close()
