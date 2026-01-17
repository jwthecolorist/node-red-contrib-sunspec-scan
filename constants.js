/**
 * SunSpec Constants
 * Centralized definitions for magic numbers and protocol values
 */

module.exports = {
    // SunSpec Protocol Identifiers
    SUNSPEC_ID: 0x53756e53,          // "SunS" marker
    SUNSPEC_ID_HIGH: 0x5375,         // First word of marker
    SUNSPEC_ID_LOW: 0x6e53,          // Second word of marker

    // Base Addresses
    BASE_ADDR_40000: 40000,          // Primary SunSpec base address
    BASE_ADDR_40002: 40002,          // Alternative base address (after marker)
    BASE_ADDR_50000: 50000,          // Alternative address space (rare)

    // Model Chain Markers
    MODEL_END_MARKER: 0xFFFF,        // End of model chain

    // Not Implemented Sentinels
    INT16_NOT_IMPL: -32768,          // int16 "not implemented" value
    UINT16_NOT_IMPL: 65535,          // uint16 "not implemented" value
    INT32_NOT_IMPL: -2147483648,     // int32 "not implemented" value
    UINT32_NOT_IMPL: 4294967295,     // uint32 "not implemented" value
    FLOAT32_NOT_IMPL: NaN,           // float32 "not implemented" value

    // Default Timeouts (ms)
    DEFAULT_TIMEOUT: 2000,           // Standard Modbus timeout
    DEFAULT_SCAN_TIMEOUT: 5000,      // Full device scan timeout
    DEFAULT_PORT_CHECK_TIMEOUT: 300, // Quick port availability check
    CONNECTION_TIMEOUT: 5000,        // TCP connection timeout

    // Default Ports
    DEFAULT_MODBUS_PORT: 502,        // Standard Modbus TCP port

    // Retry Configuration
    MIN_PACING_INTERVAL: 1,          // Minimum auto-read interval (seconds)
    MAX_RETRY_DELAY: 30000,          // Maximum retry backoff (ms)
    BASE_RETRY_DELAY: 1000,          // Initial retry delay (ms)

    // Common Model IDs
    MODEL_COMMON: 1,                 // Common model (always present)
    MODEL_INVERTER_SINGLE: 101,      // Single phase inverter
    MODEL_INVERTER_SPLIT: 102,       // Split phase inverter
    MODEL_INVERTER_THREE: 103,       // Three phase inverter
    MODEL_METER_SINGLE: 201,         // Single phase meter
    MODEL_METER_SPLIT: 202,          // Split phase meter
    MODEL_METER_THREE: 203,          // Three phase meter

    // Register Size Multipliers
    REG_SIZE_16: 1,                  // 16-bit register = 1 register
    REG_SIZE_32: 2,                  // 32-bit register = 2 registers
    REG_SIZE_64: 4,                  // 64-bit register = 4 registers
    REG_SIZE_STRING: 1,              // String character = 1 register (2 bytes)

    // Unit ID Ranges
    MIN_UNIT_ID: 1,                  // Minimum valid Modbus unit ID
    MAX_UNIT_ID: 247,                // Maximum valid Modbus unit ID
    BROADCAST_UNIT_ID: 0,            // Broadcast address (not used)

    // Performance Limits
    MAX_CONCURRENT_SCANS: 5,         // Limit parallel network scans
    MAX_CACHE_SIZE: 1000,            // Maximum cached device entries
};
