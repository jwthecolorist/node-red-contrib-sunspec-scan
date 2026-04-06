#!/usr/bin/env python3
"""Test Modbus TCP connectivity to Conext XW Pro on port 503."""
import socket
import struct
import sys

IP = "192.168.1.223"
PORTS = [503, 502]
UNIT_IDS = [10, 1, 2, 3, 11, 12, 20, 30, 126, 201]

def modbus_read(sock, unit_id, register, count):
    """Send a Modbus TCP read holding registers request."""
    tid = 1
    # MBAP Header: TID(2) + PID(2) + Len(2) + UID(1) + FC(1) + Reg(2) + Count(2)
    request = struct.pack('>HHHBBHH', tid, 0, 6, unit_id, 3, register, count)
    sock.sendall(request)
    # Read response header (MBAP + FC + byte count)
    header = sock.recv(9)
    if len(header) < 9:
        raise Exception("Short response")
    _, _, length, uid, fc = struct.unpack('>HHHBB', header[:8])
    byte_count = header[8]
    data = sock.recv(byte_count)
    if fc & 0x80:
        raise Exception(f"Modbus error: exception code {data[0]}")
    return data

for port in PORTS:
    print(f"\n=== Testing port {port} ===")
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3)
        s.connect((IP, port))
        print(f"TCP connection to {IP}:{port} OK")
    except Exception as e:
        print(f"TCP connection to {IP}:{port} FAILED: {e}")
        continue

    for uid in UNIT_IDS:
        try:
            data = modbus_read(s, uid, 0, 8)
            # Try to decode as string
            name = data.decode('utf-8', errors='replace').replace('\x00', '').strip()
            print(f"  ID {uid}: DeviceName = '{name}'")
            # Also read DC voltage (offset 80) to confirm
            try:
                dc = modbus_read(s, uid, 80, 2)
                dc_raw = struct.unpack('>I', dc)[0]
                dc_v = dc_raw * 0.001
                print(f"  ID {uid}: DC Voltage = {dc_v:.1f} V")
            except:
                pass
        except Exception as e:
            print(f"  ID {uid}: {e}")

    s.close()

print("\nDone.")
