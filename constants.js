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
    // NOTE: Tailscale VPN adds ~100-200ms RTT per hop. Timeouts must exceed this.
    DEFAULT_TIMEOUT: 8000,           // Standard Modbus timeout (raised from 6000 for Tailscale paths)
    DEFAULT_SCAN_TIMEOUT: 8000,      // Full device scan timeout
    DEFAULT_PORT_CHECK_TIMEOUT: 500, // Quick port availability check (raised for Tailscale)
    CONNECTION_TIMEOUT: 6000,        // TCP connection timeout (must beat Tailscale RTT + device latency)
    MIN_EFFECTIVE_TIMEOUT: 4000,     // Hard floor - any configured timeout below this is unsafe on Tailscale

    // Default Ports
    DEFAULT_MODBUS_PORT: 502,        // Standard Modbus TCP port

    // Retry Configuration
    MIN_PACING_INTERVAL: 1,          // Minimum auto-read interval (seconds)
    MIN_WRITE_PACING_INTERVAL: 30,   // Minimum write-node pacing (seconds) - prevents gateway saturation
    MAX_RETRY_DELAY: 60000,          // Maximum retry backoff (ms) - 1 minute cap (raised from 30s)
    BASE_RETRY_DELAY: 2000,          // Initial retry delay (ms) - raised from 1s to reduce burst
    CONNECT_COOLDOWN: 10000,         // Min ms between TCP connect attempts to same dead host

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
