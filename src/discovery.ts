
import ModbusRTU from "modbus-serial";
import net from 'net';
import os from 'os';

export interface ScanResult {
    id: number;
    type: 'sunspec' | 'sma_edmm' | 'conext_xw_503';
}

/**
 * Helper to scan a single IP for Modbus Port 502
 */
export async function checkPort(ip: string, port = 502, timeout = 300): Promise<boolean> {
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
export async function scanUnitIds(
    ip: string, 
    port: number, 
    timeout: number, 
    statusCallback?: (msg: string) => void, 
    idsToCheckOverride?: number[], 
    shouldStop?: () => boolean
): Promise<ScanResult[]> {
    const client = new ModbusRTU();
    const foundIds: ScanResult[] = [];

    // Prioritize ID list based on Port
    let idsToCheck: number[] = [];
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
            
            try {
                await client.setID(id);
            } catch (e) { continue; } // Should effectively not fail if open

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
                    // For now, if read succeeds on Port 503 Reg 0, we assume Conext.
                    foundIds.push({ id: id, type: 'conext_xw_503' });
                    if (statusCallback) statusCallback(`Found Conext ID ${id} at ${ip}`);
                    continue;
                } catch (e) { }
            }
        }

    } catch (e) {
    } finally {
        // Safe close using the callback or try-catch block in wrapper? 
        // ModbusRTU type def says close(cb).
        try {
             // Type definition might need update if we want to await close, or just fire and forget
             client.close();
        } catch(e) {}
    }
    return foundIds;
}

/**
 * Get all local interface IPv4 addresses
 */
function getLocalInterfaces(): { ip: string, netmask: string }[] {
    const interfaces = os.networkInterfaces();
    const addresses: { ip: string, netmask: string }[] = [];
    for (const name of Object.keys(interfaces)) {
        const ifaceList = interfaces[name];
        if (ifaceList) {
            for (const iface of ifaceList) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    addresses.push({ ip: iface.address, netmask: iface.netmask });
                }
            }
        }
    }
    return addresses;
}

/**
 * Calculate IP range from IP and Netmask (CIDR logic)
 */
function getSubnetRange(ip: string, netmask: string): string[] {
    const ipInt = ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
    const maskInt = netmask.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;

    const base = ipInt & maskInt;
    const broadcast = base | (~maskInt >>> 0);

    const ips: string[] = [];
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
export function parseIpRange(ipStr: string): string[] {
    if (!ipStr || ipStr.trim() === '') return [];

    // Magic: All Local Subnets
    if (ipStr.trim() === '0.0.0.0/0' || ipStr.trim() === '0.0.0.0') {
        const localIfaces = getLocalInterfaces();
        let allIps: string[] = [];
        for (const iface of localIfaces) {
            allIps = allIps.concat(getSubnetRange(iface.ip, iface.netmask));
        }
        return [...new Set(allIps)]; // Unique
    }

    const ips: string[] = [];
    const parts = ipStr.split(',').map(s => s.trim());

    for (const part of parts) {
        if (part.includes('/')) {
            // CIDR: 192.168.1.0/24
            const [baseIp, prefix] = part.split('/');
            const p = parseInt(prefix);
            
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
