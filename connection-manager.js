const ModbusRTU = require("modbus-serial");

/**
 * Manages a pool of Modbus TCP connections.
 * 
 * Goals:
 * 1. Reuse existing connections to reduce handshake overhead.
 * 2. Limit concurrent connections per device (effectively 1 per IP:Port).
 * 3. Handle idle timeouts to release resources.
 * 4. robust error handling/invalidation.
 */
class ConnectionManager {
    constructor() {
        // Map<"ip:port", { client: ModbusRTU, lastActive: number, queue: Promise }>
        this.pool = new Map();

        // Map<"ip:port:unitId", expirationTimeMs>
        this.blacklist = new Map();

        // Timeout in ms before closing an idle connection
        this.IDLE_TIMEOUT = 20000;

        // Start cleanup interval
        this.startCleanupTask();
    }

    /**
     * Set a temporary blacklist for a specific UnitID on a Gateway.
     * Prevents requests from entering the unified TCP queue.
     * @param {string} ip 
     * @param {number} port 
     * @param {number} unitId 
     * @param {number} durationMs 
     */
    setBlacklist(ip, port, unitId, durationMs) {
        const key = `${ip}:${port}:${unitId}`;
        this.blacklist.set(key, Date.now() + durationMs);
        // console.log(`[ConnectionManager] Blacklisted ${key} for ${durationMs}ms`);
    }

    isBlacklisted(ip, port, unitId) {
        const key = `${ip}:${port}:${unitId}`;
        if (!this.blacklist.has(key)) return false;

        const expiration = this.blacklist.get(key);
        if (Date.now() > expiration) {
            this.blacklist.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Execute a function using a serialized connection.
     * Ensures exclusive access to the client for the duration of the action.
     * @param {string} ip 
     * @param {number} port 
     * @param {number} unitId 
     * @param {function(client):Promise<T>} action 
     * @param {number} timeout Connection timeout 
     * @returns {Promise<T>}
     */
    async request(ip, port, unitId, action, timeout) {
        const key = `${ip}:${port}`;
        const timeoutVal = parseInt(timeout, 10) || 5000;

        // 0. Fast-Fail Blacklist Check (Bypass Queue entirely)
        if (this.isBlacklisted(ip, port, unitId)) {
            return Promise.reject(new Error(`Fast-Fail: UnitID ${unitId} at ${ip}:${port} is currently blacklisted due to recent timeout/error.`));
        }

        // 1. Get or Create Pool Entry
        if (!this.pool.has(key)) {
            this.pool.set(key, {
                client: null,
                lastActive: Date.now(),
                queue: Promise.resolve() // Initialize ready queue
            });
        }

        const entry = this.pool.get(key);
        entry.lastActive = Date.now();

        // 2. Append Action to Queue
        // We chain the new action to the end of the existing queue
        const resultPromise = entry.queue.then(async () => {
            // A. Acquire Client (Connect if needed)
            let client = entry.client;

            // Check if healthy
            if (!client || !client.isOpen) {
                try {
                    client = await this._connect(ip, port, timeoutVal);
                    entry.client = client;
                } catch (e) {
                    this.invalidate(ip, port);
                    throw e;
                }
            } else {
                client.setTimeout(timeoutVal);
            }

            // B. Set Unit ID
            try {
                await client.setID(unitId);
            } catch (e) {
                // Should practically never fail if open
                throw e;
            }

            // C. Execute the Action
            try {
                const res = await action(client);
                await new Promise(r => setTimeout(r, 100));
                return res;
            } catch (e) {
                // If action failed, check if it was a connection death
                if (this._isFatalError(e)) {
                    this.invalidate(ip, port);
                    entry.client = null; // Force next queued item to reconnect
                }
                throw e;
            }
        });

        // 3. Update Queue Head
        // We catch errors here so the queue doesn't stall for future requests
        entry.queue = resultPromise.catch(() => { });

        return resultPromise;
    }

    /**
     * Internal: Establish new connection
     */
    async _connect(ip, port, timeout) {
        const client = new ModbusRTU();
        client.setTimeout(timeout);
        // console.log(`[ConnectionManager] Connecting to ${ip}:${port}...`);
        await client.connectTCP(ip, { port: port });

        // Handle unexpected closure
        client.on('error', (err) => {
            this.invalidate(ip, port);
        });
        client.on('close', () => {
            this.invalidate(ip, port);
        });

        return client;
    }

    _isFatalError(error) {
        const fatalErrors = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'Port Not Open', 'Transaction timed out'];
        return fatalErrors.some(e => error.message && error.message.includes(e));
    }

    // Explicitly invoked by the Node when a Gateway-level serial timeout occurs
    reportError(ip, port, unitId, error) {
        if (this._isFatalError(error)) {
            // TCP died entirely. Invalidate whole socket.
            this.invalidate(ip, port);
        } else if (error.message && (error.message.includes('Slave device failure') || error.message.includes('Gateway target device failed'))) {
            // Physical RS485 device died behind a working TCP Gateway.
            // Blacklist the UnitID for 60s so it stops clogging the TCP queue.
            this.setBlacklist(ip, port, unitId, 60000); 
        }
    }

    invalidate(ip, port) {
        const key = `${ip}:${port}`;
        if (this.pool.has(key)) {
            const entry = this.pool.get(key);
            if (entry.client) {
                // Aggressive socket teardown
                try {
                    if (entry.client._port && entry.client._port.socket) {
                        entry.client._port.socket.destroy();
                    }
                } catch (e) { }
                try { entry.client.close(); } catch (e) { }
            }
            this.pool.delete(key);
        }
    }

    startCleanupTask() {
        if (this.cleanupInterval) clearInterval(this.cleanupInterval);
        this.cleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.pool.entries()) {
                if (now - entry.lastActive > this.IDLE_TIMEOUT) {
                    // console.log(`[ConnectionManager] closing idle connection: ${key}`);
                    if (entry.client) {
                        try { entry.client.close(); } catch (e) { }
                    }
                    this.pool.delete(key);
                }
            }
        }, 5000);
    }
}

module.exports = ConnectionManager;
