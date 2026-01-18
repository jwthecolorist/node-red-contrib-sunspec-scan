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
        // Map<"ip:port", { client: ModbusRTU, lastActive: number, promise: Promise, unitId: number }>
        this.pool = new Map();

        // Timeout in ms before closing an idle connection
        this.IDLE_TIMEOUT = 20000;

        // Start cleanup interval
        this.startCleanupTask();
    }

    /**
     * Get a connected client for the given target.
     * Reuse existing if open, or connect new.
     */
    async getClient(ip, port, unitId, timeout) {
        const key = `${ip}:${port}`;
        const now = Date.now();
        timeout = timeout || 5000;

        // 1. Check existing pool
        if (this.pool.has(key)) {
            const entry = this.pool.get(key);

            // Update Activity
            entry.lastActive = now;

            // Update Unit ID (ModbusRTU handles this instantly)
            if (entry.client) {
                entry.client.setID(unitId);
            }

            // Return active client (or wait for pending connection)
            if (entry.promise) {
                return entry.promise; // Return the pending promise
            }

            if (entry.client && entry.client.isOpen) {
                return entry.client;
            } else {
                // Stale/Closed - remove and reconnect
                this.invalidate(ip, port);
            }
        }

        // 2. Connect New
        const client = new ModbusRTU();
        client.setTimeout(timeout);

        // Store the promise to handle race conditions (concurrent requests wait for SAME connection)
        const connectPromise = new Promise(async (resolve, reject) => {
            try {
                // console.log(`[ConnectionManager] Connecting to ${ip}:${port}...`);
                await client.connectTCP(ip, { port: port });
                client.setID(unitId);

                // Success: Update Pool Entry with actual client
                this.pool.set(key, {
                    client: client,
                    lastActive: Date.now(),
                    promise: null // Clear promise
                });

                // Handle unexpected closure
                client.on('error', (err) => {
                    // console.log(`[ConnectionManager] Error on ${key}: ${err.message}`);
                    this.invalidate(ip, port);
                });
                client.on('close', () => {
                    // console.log(`[ConnectionManager] Closed on ${key}`);
                    this.invalidate(ip, port);
                });

                resolve(client);
            } catch (e) {
                this.invalidate(ip, port); // Remove failed entry
                reject(e);
            }
        });

        // Store incomplete entry
        this.pool.set(key, {
            client: null,
            lastActive: now,
            promise: connectPromise
        });

        return connectPromise;
    }

    /**
     * Report an error to invalidate the connection if necessary.
     * Call this when a READ/WRITE fails unexpectedly.
     */
    reportError(ip, port, error) {
        const key = `${ip}:${port}`;
        // If error suggests connection loss, invalidate
        const fatalErrors = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'Port Not Open'];
        const isFatal = fatalErrors.some(e => error.message && error.message.includes(e));

        if (isFatal || !error.message) {
            // console.log(`[ConnectionManager] Invalidating ${key} due to fatal error.`);
            this.invalidate(ip, port);
        }
    }

    invalidate(ip, port) {
        const key = `${ip}:${port}`;
        if (this.pool.has(key)) {
            const entry = this.pool.get(key);
            if (entry.client) {
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
        }, 5000); // Check every 5s
    }
}

module.exports = ConnectionManager;
