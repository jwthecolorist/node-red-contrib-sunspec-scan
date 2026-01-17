const ModbusRTU = require("modbus-serial");
const fs = require('fs-extra');

// MOCK CONSTANTS
const MOCK_TARGET_IP = "192.168.5.21";
const MOCK_TARGET_PORT = 502;
const MOCK_UNIT_ID = 126;

async function debugScan() {
    console.log("Starting Debug Scan for Model 101...");
    const client = new ModbusRTU();

    try {
        await client.connectTCP(MOCK_TARGET_IP, { port: MOCK_TARGET_PORT });
        client.setID(MOCK_UNIT_ID);
        client.setTimeout(2000);

        const MODEL_101_ADDR = 40070; // From previous logs
        const LENGTH = 50;

        // 1. Replicate the read logic exactly
        const safeLen = Math.min(LENGTH, 120);
        console.log(`Reading ${safeLen} registers from ${MODEL_101_ADDR}...`);

        const valBlock = await client.readHoldingRegisters(MODEL_101_ADDR, safeLen);
        const fullBuf = valBlock.buffer;

        console.log(`Read success. Buffer length: ${fullBuf.length} bytes`);

        // 2. Check specific known points
        // PPVphAB is usually at offset... check mapping
        // PPVphAB: "Phase Voltage AB", offset 14 (regs), Type: uint16
        // 14 regs = 28 bytes offset

        // Let's print values at specific offsets to verify
        const pointsToCheck = [
            { name: "A", offset: 2, type: "uint16" }, // AC Current
            { name: "PhVphA", offset: 14, type: "uint16" }, // Phase Voltage AN (?) - Wait, model 101 map
            { name: "PPVphAB", offset: 14, type: "uint16" }, // Maybe? Need to know exact offset from model def
        ];

        // Hardcoded offsets for verify (Model 101 standard)
        // A: offset 2
        // AphA: offset 4
        // AphB: offset 6
        // AphC: offset 8
        // PhVphA: offset 10
        // PhVphB: offset 12
        // PhVphC: offset 14
        // PPVphAB: offset 16 (maybe?)

        // Let's just dump the raw values for the first 20 regs
        console.log("\nRAW DUMP (First 20 regs):");
        for (let i = 0; i < 20; i++) {
            const val = fullBuf.readUInt16BE(i * 2);
            console.log(`Offset ${i}: ${val} (0x${val.toString(16)})`);
        }

        console.log("\nCHECKING SENTINELS:");

        // Manually check for 65535 (0xFFFF)
        let foundUnimpl = 0;
        for (let i = 0; i < safeLen; i++) {
            const val = fullBuf.readUInt16BE(i * 2);
            if (val === 65535) {
                // console.log(`Offset ${i} is UNIMPLEMENTED (0xFFFF)`);
                foundUnimpl++;
            }
        }
        console.log(`Found ${foundUnimpl} registers with value 0xFFFF`);

    } catch (e) {
        console.error("ERROR:", e);
    } finally {
        client.close();
    }
}

debugScan();
