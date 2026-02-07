/**
 * Custom Error Classes for SunSpec Operations
 * Provides specific error types for better error handling and debugging
 */

/**
 * Error thrown when connection to a Modbus device fails
 */
export class SunSpecConnectionError extends Error {
    public ip: string;
    public port: number;

    constructor(ip: string, port: number, message: string) {
        super(`Connection failed to ${ip}:${port}: ${message}`);
        this.name = 'SunSpecConnectionError';
        this.ip = ip;
        this.port = port;
    }
}

/**
 * Error thrown when a requested model is not found in device
 */
export class SunSpecModelNotFoundError extends Error {
    public modelId: number | string;
    public deviceId: string;

    constructor(modelId: number | string, deviceId: string) {
        super(`Model ${modelId} not found on device ${deviceId}`);
        this.name = 'SunSpecModelNotFoundError';
        this.modelId = modelId;
        this.deviceId = deviceId;
    }
}

/**
 * Error thrown when a requested point is not found in model
 */
export class SunSpecPointNotFoundError extends Error {
    public pointName: string;
    public modelId: number | string;

    constructor(pointName: string, modelId: number | string) {
        super(`Point "${pointName}" not found in Model ${modelId}`);
        this.name = 'SunSpecPointNotFoundError';
        this.pointName = pointName;
        this.modelId = modelId;
    }
}

/**
 * Error thrown when connection timeout occurs
 */
export class SunSpecTimeoutError extends Error {
    public operation: string;
    public timeout: number;

    constructor(operation: string, timeout: number) {
        super(`Operation "${operation}" timed out after ${timeout}ms`);
        this.name = 'SunSpecTimeoutError';
        this.operation = operation;
        this.timeout = timeout;
    }
}
