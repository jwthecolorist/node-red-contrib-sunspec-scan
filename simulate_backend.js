const ModbusRTU = require("modbus-serial");
const fs = require('fs-extra');
const path = require('path');

// MOCK CONSTANTS
const MOCK_TARGET_IP = "192.168.5.21";
const MOCK_TARGET_PORT = 502;
const MOCK_UNIT_ID = 126;

// Import logic to test - we'll test by interacting with the device mostly
// but simulating High Load / Repetitive usage
const discovery = require('./discovery');

// Logger
function log(msg, type = 'INFO') {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${type}] ${msg}`);
}

async function runSimulation() {
    log("STARTING UX SIMULATION (100+ Cycles)", "START");

    const client = new ModbusRTU();
    let successCount = 0;
    let failCount = 0;

    // 1. Simulate Rapid Connection/Disconnection Cycles (Scan phase)
    log("Phase 1: connection stress test (20 cycles)", "PHASE");
    for (let i = 0; i < 20; i++) {
        try {
            await client.connectTCP(MOCK_TARGET_IP, { port: MOCK_TARGET_PORT });
            client.setID(MOCK_UNIT_ID);
            await client.readHoldingRegisters(40000, 2); // Simple read
            client.close();
            successCount++;
            if (i % 5 === 0) process.stdout.write('.');
        } catch (e) {
            failCount++;
            process.stdout.write('x');
        }
    }
    console.log("");
    log(`Phase 1 Complete. Success: ${successCount}, Fail: ${failCount}`, "INFO");

    // 2. Simulate Backend Model Scan Logic (Data retrieval phase)
    log("Phase 2: Model Scan Logic Verification", "PHASE");
    // We'll mimic the 'scanDeviceModelsOnly' logic here but instrumented
    try {
        await client.connectTCP(MOCK_TARGET_IP, { port: MOCK_TARGET_PORT });
        client.setID(MOCK_UNIT_ID);

        let addr = 40002; // Assuming base checked
        let modelsFound = 0;

        // Safety Break
        let loops = 0;
        while (loops < 50) {
            loops++;
            try {
                const head = await client.readHoldingRegisters(addr, 2);
                const mid = head.data[0];
                const len = head.data[1];

                if (mid === 0xFFFF) break;

                log(`Found Model ${mid} at ${addr} (len ${len})`, "DEBUG");
                modelsFound++;

                // Simulate metadata read for Model 1
                if (mid === 1) {
                    const meta = await client.readHoldingRegisters(addr + 2, 64);
                    log(`> Model 1 Metadata read success (${meta.buffer.length} bytes)`, "DEBUG");
                }

                addr += 2 + len;
            } catch (e) {
                log(`Error reading at ${addr}: ${e.message}`, "ERROR");
                break;
            }
        }
        log(`Scanned ${modelsFound} models successfully.`, "INFO");
    } catch (e) {
        log(`Phase 2 Failed: ${e.message}`, "ERROR");
    } finally {
        client.close();
    }

    // 3. Simulate "Select Point" UX - Reading specific points repeatedly
    log("Phase 3: Point Read UX Simulation (50 reads mixed)", "PHASE");
    const pointsToTest = [
        { addr: 40072, len: 1, name: 'A' },    // AC Current
        { addr: 40080, len: 1, name: 'AphA' }, // UNIMPLEMENTED
        { addr: 40084, len: 1, name: 'W' },    // Watts
        { addr: 40004, len: 16, name: 'Mn' }   // String
    ];

    try {
        await client.connectTCP(MOCK_TARGET_IP, { port: MOCK_TARGET_PORT });
        client.setID(MOCK_UNIT_ID);

        for (let i = 0; i < 50; i++) {
            const p = pointsToTest[i % pointsToTest.length];
            try {
                // Simulate timeout randomly
                // const timeout = Math.random() > 0.9 ? 1 : 2000;
                // client.setTimeout(timeout);

                const val = await client.readHoldingRegisters(p.addr, p.len);
                // process.stdout.write(p.name[0]);
            } catch (e) {
                // Expected for timeouts or connection drops
                // process.stdout.write('!');
            }
            if (i % 10 === 0) process.stdout.write('+');
        }
        console.log("");
        log("Phase 3 Complete", "INFO");
    } catch (e) {
        log(`Phase 3 Error: ${e.message}`, "ERROR");
    } finally {
        client.close();
    }

    log("SIMULATION COMPLETE", "END");
}

runSimulation();
