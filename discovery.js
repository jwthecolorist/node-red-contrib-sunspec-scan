
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
            // Conext Default Range 10-29. Add a buffer.
            idsToCheck = [];
            for (let i = 10; i <= 35; i++) idsToCheck.push(i);
            // Also check standard ones just in case
            idsToCheck.push(1, 2, 201);
        } else {
            // SunSpec/Standard Order
            idsToCheck = [1, 126, 2, 3, 4, 100, 200];
            for (let i = 1; i <= 247; i++) {
                if (!idsToCheck.includes(i)) idsToCheck.push(i);
            }
        }
    }

    try {
        await client.connectTCP(ip, { port: port });
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

            // 3. Check Conext (Port 503 usually)
            if (port == 503) {
                try {
                    // Reg 0 is Device Name (str16). Read 8 registers (16 chars).
                    const data = await client.readHoldingRegisters(0, 8);
                    // Check if it looks like a string (ASCII range)
                    // First char should be alphanumeric?
                    // Conext devices start with "XW", "MPPT", "Gateway"?
                    // Or check "Device Name" existence.
                    // Let's just assume valid read of Reg 0-7 implies Conext if on Port 503?
                    // Or check specific substring?
                    // The buffer will allow us to check.
                    // For now, if read succeeds on Port 503 Reg 0, we assume Conext.
                    foundIds.push({ id: id, type: 'conext_xw_503' });
                    if (statusCallback) statusCallback(`Found Conext ID ${id} at ${ip}`);
                    continue;
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
    // Start from base+1 to broadcast-1
    for (let i = base + 1; i < broadcast; i++) {
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
            const start = parseInt(range[0]);
            const end = parseInt(range[1]);

            for (let i = start; i <= end; i++) {
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
    parseIpRange
};
