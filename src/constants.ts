/**
 * SunSpec Constants
 * Centralized definitions for magic numbers and protocol values
 */

export const SUNSPEC_ID = 0x53756e53;          // "SunS" marker
export const SUNSPEC_ID_HIGH = 0x5375;         // First word of marker
export const SUNSPEC_ID_LOW = 0x6e53;          // Second word of marker

// Base Addresses
export const BASE_ADDR_40000 = 40000;          // Primary SunSpec base address
export const BASE_ADDR_40002 = 40002;          // Alternative base address (after marker)
export const BASE_ADDR_50000 = 50000;          // Alternative address space (rare)

// Model Chain Markers
export const MODEL_END_MARKER = 0xFFFF;        // End of model chain

// Not Implemented Sentinels
export const INT16_NOT_IMPL = -32768;          // int16 "not implemented" value
export const UINT16_NOT_IMPL = 65535;          // uint16 "not implemented" value
export const INT32_NOT_IMPL = -2147483648;     // int32 "not implemented" value
export const UINT32_NOT_IMPL = 4294967295;     // uint32 "not implemented" value
export const FLOAT32_NOT_IMPL = NaN;           // float32 "not implemented" value

// Default Timeouts (ms)
export const DEFAULT_TIMEOUT = 6000;           // Standard Modbus timeout
export const DEFAULT_SCAN_TIMEOUT = 5000;      // Full device scan timeout
export const DEFAULT_PORT_CHECK_TIMEOUT = 300; // Quick port availability check
export const CONNECTION_TIMEOUT = 5000;        // TCP connection timeout

// Default Ports
export const DEFAULT_MODBUS_PORT = 502;        // Standard Modbus TCP port

// Retry Configuration
export const MIN_PACING_INTERVAL = 1;          // Minimum auto-read interval (seconds)
export const MAX_RETRY_DELAY = 30000;          // Maximum retry backoff (ms)
export const BASE_RETRY_DELAY = 1000;          // Initial retry delay (ms)

// Common Model IDs
export const MODEL_COMMON = 1;                 // Common model (always present)
export const MODEL_INVERTER_SINGLE = 101;      // Single phase inverter
export const MODEL_INVERTER_SPLIT = 102;       // Split phase inverter
export const MODEL_INVERTER_THREE = 103;       // Three phase inverter
export const MODEL_METER_SINGLE = 201;         // Single phase meter
export const MODEL_METER_SPLIT = 202;          // Split phase meter
export const MODEL_METER_THREE = 203;          // Three phase meter

// Register Size Multipliers
export const REG_SIZE_16 = 1;                  // 16-bit register = 1 register
export const REG_SIZE_32 = 2;                  // 32-bit register = 2 registers
export const REG_SIZE_64 = 4;                  // 64-bit register = 4 registers
export const REG_SIZE_STRING = 1;              // String character = 1 register (2 bytes)

// Unit ID Ranges
export const MIN_UNIT_ID = 1;                  // Minimum valid Modbus unit ID
export const MAX_UNIT_ID = 247;                // Maximum valid Modbus unit ID
export const BROADCAST_UNIT_ID = 0;            // Broadcast address (not used)

// Performance Limits
export const MAX_CONCURRENT_SCANS = 5;         // Limit parallel network scans
export const MAX_CACHE_SIZE = 1000;            // Maximum cached device entries
