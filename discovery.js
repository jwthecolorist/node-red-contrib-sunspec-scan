
const ModbusRTU = require("modbus-serial");
const net = require('net');
const os = require('os');

/**
 * Helper to scan a single IP for Modbus Port 502
 */
async function checkPort(ip, port = 502, timeout = 300) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(timeout);

        socket.on('connect', () => {
            socket.destroy();
            resolve(true);
        });

        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });

        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });

        socket.connect(port, ip);
    });
}

/**
 * Decode a Modbus register buffer as a printable ASCII device-name string.
 * Strips NUL padding and any non-printable bytes.
 */
function decodeDeviceName(buffer) {
    return buffer.toString('latin1').replace(/[^\x20-\x7E]/g, '').trim();
}

/**
 * Heuristic: does this register block look like a real device name (as opposed to
 * a zeroed/binary block from a non-Conext device that merely answered the read)?
 * Requires at least 3 alphanumeric characters in the decoded string.
 */
function looksLikeDeviceName(buffer) {
    const s = decodeDeviceName(buffer);
    const alnum = (s.match(/[A-Za-z0-9]/g) || []).length;
    return alnum >= 3;
}

/**
 * Scan a single IP for valid SunSpec Unit IDs
 */
async function scanUnitIds(ip, port, timeout, statusCallback, idsToCheckOverride, shouldStop) {
    const client = new ModbusRTU();
    const foundIds = [];

    // Prioritize ID list based on Port
    let idsToCheck = [];
    if (Array.isArray(idsToCheckOverride) && idsToCheckOverride.length > 0) {
        idsToCheck = idsToCheckOverride;
    } else {
        if (port == 503) {
            // Conext (Schneider) on the proprietary 503 map.
            // Gateway/aggregate sits at 1-2; XW/MPPT inverters appear across a wide
            // range depending on install. Previously only 10-35 (+1,2,201) was probed,
            // which MISSED common ids like 126 (XW Pro). Cover the realistic set.
            idsToCheck = [1, 2];
            for (let i = 10; i <= 35; i++) idsToCheck.push(i);
            idsToCheck.push(126, 201, 230);
        } else {
            // SunSpec/Standard Order
            idsToCheck = [1, 126, 2, 3, 4, 100, 200];
            for (let i = 1; i <= 247; i++) {
                if (!idsToCheck.includes(i)) idsToCheck.push(i);
            }
        }
    }

    try {
        // Race the TCP connect against a hard deadline; modbus-serial can otherwise
        // hang indefinitely on unreachable routes (e.g. Tailscale black holes).
        const connectMs = Math.max(parseInt(timeout, 10) || 2000, 4000);
        await Promise.race([
            client.connectTCP(ip, { port: port }),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(`TCP connect to ${ip}:${port} timed out`)), connectMs)),
        ]);
        client.setTimeout(timeout);

        for (const id of idsToCheck) {
            if (shouldStop && shouldStop()) break;
            client.setID(id);

            // 1. Check SunSpec (Port 502 mainly, but maybe 503 too?)
            try {
                const data = await client.readHoldingRegisters(40000, 2);
                if (data.data[0] === 0x5375 && data.data[1] === 0x6e53) {
                    foundIds.push({ id: id, type: 'sunspec' });
                    if (statusCallback) statusCallback(`Found SunSpec ID ${id} at ${ip}`);
                    continue;
                }
            } catch (e) { }

            // 2. Check SMA EDMM (Port 502 usually)
            if (port != 503) {
                try {
                    const data = await client.readHoldingRegisters(30051, 2);
                    const val = (data.data[0] << 16) | data.data[1];
                    if (val === 8128 || val === 9397 || val === 19135) {
                        foundIds.push({ id: id, type: 'sma_edmm' });
                        if (statusCallback) statusCallback(`Found SMA ID ${id} at ${ip}`);
                        continue;
                    }
                } catch (e) { }
            }

            // 3. Check Conext (proprietary Port 503 map).
            // Reg 0 holds the Device Name (string). Rather than accept ANY
            // successful read (which false-positives on non-Conext devices and on
            // empty/zeroed blocks), validate that the block decodes to a plausible
            // ASCII device name (e.g. "XW Pro 6848", "Conext Gateway").
            if (port == 503) {
                try {
                    const data = await client.readHoldingRegisters(0, 8);
                    if (looksLikeDeviceName(data.buffer)) {
                        const name = decodeDeviceName(data.buffer);
                        foundIds.push({ id: id, type: 'conext_xw_503', name: name });
                        if (statusCallback) statusCallback(`Found Conext "${name}" (ID ${id}) at ${ip}`);
                        continue;
                    }
                } catch (e) { }
            }
        }

    } catch (e) {
    } finally {
        client.close();
    }
    return foundIds;
}

/**
 * Get all local interface IPv4 addresses
 */
function getLocalInterfaces() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push({ ip: iface.address, netmask: iface.netmask });
            }
        }
    }
    return addresses;
}

/**
 * Calculate IP range from IP and Netmask (CIDR logic)
 */
function getSubnetRange(ip, netmask) {
    const ipInt = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
    const maskInt = netmask.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;

    const base = ipInt & maskInt;
    const broadcast = base | (~maskInt >>> 0);

    const ips = [];
    // Start from base+1 to broadcast-1 (capped — a /16 would otherwise expand to ~65k hosts)
    for (let i = base + 1; i < broadcast; i++) {
        if (ips.length >= 1000) break; // Safety cap
        const p1 = (i >>> 24) & 0xFF;
        const p2 = (i >>> 16) & 0xFF;
        const p3 = (i >>> 8) & 0xFF;
        const p4 = i & 0xFF;
        ips.push(`${p1}.${p2}.${p3}.${p4}`);
    }
    return ips;
}


/**
 * Parse IP Range string
 * Supports: 
 * - Single: 192.168.1.10
 * - List: 192.168.1.10, 192.168.1.12
 * - Range: 192.168.1.10-20
 * - CIDR: 192.168.1.0/24
 * - Magic: 0.0.0.0/0 (Local Subnets)
 */
function parseIpRange(ipStr) {
    if (!ipStr || ipStr.trim() === '') return [];

    // Magic: All Local Subnets
    if (ipStr.trim() === '0.0.0.0/0' || ipStr.trim() === '0.0.0.0') {
        const localIfaces = getLocalInterfaces();
        let allIps = [];
        for (const iface of localIfaces) {
            allIps = allIps.concat(getSubnetRange(iface.ip, iface.netmask));
        }
        return [...new Set(allIps)]; // Unique
    }

    const ips = [];
    const parts = ipStr.split(',').map(s => s.trim());

    for (const part of parts) {
        if (part.includes('/')) {
            // CIDR: 192.168.1.0/24
            // Simplified: Require 'ip' library or implement manual cidr
            // Manual implementation for basic /24 etc
            // ... Actually getSubnetRange logic needs netmask. 
            // Convert CIDR prefix to netmask
            const [baseIp, prefix] = part.split('/');
            const p = parseInt(prefix);
            let mask = 0;
            for (let i = 0; i < 32; i++) {
                mask <<= 1;
                if (i < p) mask |= 1;
            }
            // Netmask string not easy, let's look for a library? 
            // We don't have 'ip' lib installed.
            // Hack: Just supporting /24 for now which is common for 0.0.0.0/0 replacement
            // Actually, implementing general CIDR to array:

            // Convert IP to long
            const ipLong = baseIp.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
            const maskLong = 0xffffffff << (32 - p) >>> 0;

            const start = (ipLong & maskLong) >>> 0;
            const end = (start | (~maskLong >>> 0)) >>> 0;

            for (let i = start + 1; i < end; i++) { // Skip Network & Broadcast
                if (ips.length >= 1000) break; // Safety Cap
                const p1 = (i >>> 24) & 0xFF;
                const p2 = (i >>> 16) & 0xFF;
                const p3 = (i >>> 8) & 0xFF;
                const p4 = i & 0xFF;
                ips.push(`${p1}.${p2}.${p3}.${p4}`);
            }

        } else if (part.includes('-')) {
            // Range: 192.168.1.10-20
            const lastDot = part.lastIndexOf('.');
            const subnet = part.substring(0, lastDot + 1);
            const range = part.substring(lastDot + 1).split('-');
            let start = parseInt(range[0]);
            let end = parseInt(range[1]);

            if (start > end) {
                const temp = start;
                start = end;
                end = temp;
            }

            for (let i = start; i <= end; i++) {
                if (ips.length >= 1000) break; // Safety Cap
                ips.push(subnet + i);
            }
        } else {
            // Single IP
            ips.push(part);
        }
    }
    return ips;
}

module.exports = {
    checkPort,
    scanUnitIds,
    parseIpRange,
    decodeDeviceName,
    looksLikeDeviceName
};
