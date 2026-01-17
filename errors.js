/**
 * Custom Error Classes for SunSpec Operations
 * Provides specific error types for better error handling and debugging
 */

/**
 * Error thrown when connection to a Modbus device fails
 */
class SunSpecConnectionError extends Error {
    /**
     * @param {string} ip - Target IP address
     * @param {number} port - Target port
     * @param {string} message - Detailed error message
     */
    constructor(ip, port, message) {
        super(`Connection failed to ${ip}:${port}: ${message}`);
        this.name = 'SunSpecConnectionError';
        this.ip = ip;
        this.port = port;
    }
}

/**
 * Error thrown when a requested model is not found in device
 */
class SunSpecModelNotFoundError extends Error {
    /**
     * @param {number} modelId - Requested SunSpec model ID
     * @param {string} deviceId - Device identifier (IP:UnitID)
     */
    constructor(modelId, deviceId) {
        super(`Model ${modelId} not found on device ${deviceId}`);
        this.name = 'SunSpecModelNotFoundError';
        this.modelId = modelId;
        this.deviceId = deviceId;
    }
}

/**
 * Error thrown when a requested point is not found in model
 */
class SunSpecPointNotFoundError extends Error {
    /**
     * @param {string} pointName - Requested point name
     * @param {number} modelId - Model ID being queried
     */
    constructor(pointName, modelId) {
        super(`Point "${pointName}" not found in Model ${modelId}`);
        this.name = 'SunSpecPointNotFoundError';
        this.pointName = pointName;
        this.modelId = modelId;
    }
}

/**
 * Error thrown when connection timeout occurs
 */
class SunSpecTimeoutError extends Error {
    /**
     * @param {string} operation - Operation that timed out
     * @param {number} timeout - Timeout value in milliseconds
     */
    constructor(operation, timeout) {
        super(`Operation "${operation}" timed out after ${timeout}ms`);
        this.name = 'SunSpecTimeoutError';
        this.operation = operation;
        this.timeout = timeout;
    }
}

module.exports = {
    SunSpecConnectionError,
    SunSpecModelNotFoundError,
    SunSpecPointNotFoundError,
    SunSpecTimeoutError
};
