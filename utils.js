/**
 * SunSpec Utility Functions
 * Reusable helper functions for SunSpec protocol operations
 */

const CONST = require('./constants');
const { SunSpecModelNotFoundError, SunSpecConnectionError } = require('./errors');

/**
 * Find the memory address of a specific model in the SunSpec model chain
 * 
 * @param {Object} client - Connected ModbusRTU client instance
 * @param {number} modelId - Target SunSpec model ID to locate
 * @param {number} [baseAddr] - Optional base address override (default: auto-detect)
 * @returns {Promise<number>} Model start address, or -1 if not found
 * @throws {Error} If Modbus communication fails
 * 
 * @example
 * const addr = await findModelAddress(client, 103); // Find inverter model
 * if (addr === -1) throw new Error('Model not found');
 */
async function findModelAddress(client, modelId, baseAddr = null) {
    // Auto-detect base address if not provided
    if (baseAddr === null) {
        baseAddr = CONST.BASE_ADDR_40002; // Default
        try {
            const marker = await client.readHoldingRegisters(CONST.BASE_ADDR_40000, 2);
            if (marker.data[0] === CONST.SUNSPEC_ID_HIGH && marker.data[1] === CONST.SUNSPEC_ID_LOW) {
                baseAddr = CONST.BASE_ADDR_40002;
            }
        } catch (e) {
            // If marker read fails, assume default base
        }
    }

    // Walk the model chain
    let addr = baseAddr;
    while (true) {
        const header = await client.readHoldingRegisters(addr, 2);
        const id = header.data[0];
        const length = header.data[1];

        // Check for end marker
        if (id === CONST.MODEL_END_MARKER) {
            return -1; // Model not found
        }

        // Check for match
        if (id === modelId) {
            return addr; // Found!
        }

        // Move to next model (ID + Length + payload)
        addr += 2 + length;
    }
}

/**
 * Check if a value represents "not implemented" according to SunSpec spec
 * 
 * @param {number|string} value - Value to check
 * @param {string} type - SunSpec data type (e.g., 'int16', 'uint32', 'float32')
 * @returns {boolean} True if value is a "not implemented" sentinel
 * 
 * @example
 * if (isNotImplemented(-32768, 'int16')) {
 *     console.log('Point not implemented');
 * }
 */
function isNotImplemented(value, type) {
    if (typeof value !== 'number') return false;

    switch (type) {
        case 'int16':
        case 'sunssf':
            return value === CONST.INT16_NOT_IMPL;
        case 'uint16':
        case 'enum16':
        case 'bitfield16':
            return value === CONST.UINT16_NOT_IMPL;
        case 'int32':
            return value === CONST.INT32_NOT_IMPL;
        case 'uint32':
        case 'acc32':
            return value === CONST.UINT32_NOT_IMPL;
        case 'float32':
            return isNaN(value); // NaN indicates not implemented
        default:
            return false;
    }
}

/**
 * Calculate register size for a given SunSpec data type
 * 
 * @param {string} type - SunSpec data type
 * @returns {number} Number of 16-bit registers required
 * 
 * @example
 * const size = getRegisterSize('float32'); // Returns 2
 */
function getRegisterSize(type) {
    if (!type) return CONST.REG_SIZE_16;

    if (type.includes('32')) return CONST.REG_SIZE_32;
    if (type.includes('64')) return CONST.REG_SIZE_64;
    if (type === 'string') return CONST.REG_SIZE_STRING;
    if (type === 'sunssf') return CONST.REG_SIZE_16;

    return CONST.REG_SIZE_16; // Default
}

/**
 * Parse unit ID specification into array of IDs
 * Supports single IDs, ranges, and comma-separated lists
 * 
 * @param {string} unitIdStr - Unit ID specification (e.g., "1", "1-10", "1,5,10-20")
 * @returns {number[]|null} Array of unit IDs, or null for "scan all"
 * 
 * @example
 * parseUnitIds("1,5,10-12") // Returns [1, 5, 10, 11, 12]
 * parseUnitIds("") // Returns null (scan all)
 */
function parseUnitIds(unitIdStr) {
    if (!unitIdStr || unitIdStr.trim() === "") {
        return null; // Scan all
    }

    const ids = [];
    const parts = unitIdStr.split(',').map(s => s.trim());

    for (const part of parts) {
        if (part.includes('-')) {
            // Range: "10-20"
            const [start, end] = part.split('-').map(n => parseInt(n));
            if (!isNaN(start) && !isNaN(end)) {
                for (let i = start; i <= end; i++) {
                    ids.push(i);
                }
            }
        } else {
            // Single ID: "5"
            const id = parseInt(part);
            if (!isNaN(id)) {
                ids.push(id);
            }
        }
    }

    // Deduplicate and sort
    return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Create a connection timeout promise that races against an operation
 * 
 * @param {Promise} operation - Operation to perform
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {string} operationName - Name of operation for error message
 * @returns {Promise} Result of operation or timeout error
 * 
 * @example
 * await withTimeout(
 *     client.connectTCP(ip, { port }),
 *     5000,
 *     'TCP connection'
 * );
 */
async function withTimeout(operation, timeoutMs, operationName) {
    const { SunSpecTimeoutError } = require('./errors');

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new SunSpecTimeoutError(operationName, timeoutMs)), timeoutMs)
    );

    return Promise.race([operation, timeoutPromise]);
}

module.exports = {
    findModelAddress,
    isNotImplemented,
    getRegisterSize,
    parseUnitIds,
    withTimeout
};
