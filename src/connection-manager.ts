import ModbusRTU from "modbus-serial";

interface PoolEntry {
    client: ModbusRTU | null;
    lastActive: number;
    queue: Promise<any>;
}

/**
 * Manages a pool of Modbus TCP connections.
 * 
 * Goals:
 * 1. Reuse existing connections to reduce handshake overhead.
 * 2. Limit concurrent connections per device (effectively 1 per IP:Port).
 * 3. Handle idle timeouts to release resources.
 * 4. robust error handling/invalidation.
 */
export class ConnectionManager {
    private pool: Map<string, PoolEntry>;
    private IDLE_TIMEOUT: number;
    public cleanupInterval: NodeJS.Timeout | null; // Made public for testing

    constructor() {
        // Map<"ip:port", { client: ModbusRTU, lastActive: number, queue: Promise }>
        this.pool = new Map();

        // Timeout in ms before closing an idle connection
        this.IDLE_TIMEOUT = 20000;
        this.cleanupInterval = null;

        // Start cleanup interval
        this.startCleanupTask();
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
    async request<T>(ip: string, port: number, unitId: number, action: (client: ModbusRTU) => Promise<T>, timeout?: number): Promise<T> {
        const key = `${ip}:${port}`;
        const timeoutVal = timeout || 5000;

        // 1. Get or Create Pool Entry
        if (!this.pool.has(key)) {
            this.pool.set(key, {
                client: null,
                lastActive: Date.now(),
                queue: Promise.resolve() // Initialize ready queue
            });
        }

        const entry = this.pool.get(key)!;
        entry.lastActive = Date.now();

        // 2. Append Action to Queue
        // We chain the new action to the end of the existing queue
        // We CAST the result to Promise<any> to satisfy the queue type, but return the typed result
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
                // Tiny delay to prevent socket saturation?
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

        return resultPromise as Promise<T>;
    }

    /**
     * Internal: Establish new connection
     */
    async _connect(ip: string, port: number, timeout: number): Promise<ModbusRTU> {
        const client = new ModbusRTU();
        client.setTimeout(timeout);
        // console.log(`[ConnectionManager] Connecting to ${ip}:${port}...`);
        await client.connectTCP(ip, { port: port });

        // Handle unexpected closure
        client.on('error', (err: any) => {
            this.invalidate(ip, port);
        });
        client.on('close', () => {
            this.invalidate(ip, port);
        });

        return client;
    }

    _isFatalError(error: any): boolean {
        const fatalErrors = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'Port Not Open', 'Transaction timed out'];
        return fatalErrors.some(e => error && error.message && error.message.includes(e));
    }

    reportError(ip: string, port: number, error: any): void {
        if (this._isFatalError(error)) {
            this.invalidate(ip, port);
        }
    }

    invalidate(ip: string, port: number): void {
        const key = `${ip}:${port}`;
        if (this.pool.has(key)) {
            const entry = this.pool.get(key)!;
            if (entry.client) {
                try { entry.client.close(); } catch (e) { }
            }
            this.pool.delete(key);
        }
    }

    startCleanupTask(): void {
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

export default ConnectionManager;
