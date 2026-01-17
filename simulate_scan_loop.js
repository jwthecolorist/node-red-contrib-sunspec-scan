const ModbusRTU = require("modbus-serial");

// MOCK CONSTANTS
const MOCK_TARGET_IP = "192.168.5.21";
const MOCK_TARGET_PORT = 502;
const MOCK_UNIT_ID = 126;

// Logger
function log(msg, type = 'INFO') {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${type}] ${msg}`);
}

async function runSimulation() {
    log("STARTING SIMULATION LOOP (100 Cycles) - Focus: Scan & Autohide", "START");

    // We want to simulate the exact behavior of scanning for implemented points
    // which involves reading every single register in Model 101.

    const client = new ModbusRTU();

    let cycles = 0;
    const TOTAL_CYCLES = 100;
    const MODEL_101_ADDR = 40070; // From previous log
    const MODEL_101_LEN = 50;

    // We know Model 101 has about 50 registers.
    // Reading them one by one is what scanImplementedPoints does.

    try {
        await client.connectTCP(MOCK_TARGET_IP, { port: MOCK_TARGET_PORT });
        client.setID(MOCK_UNIT_ID);
        client.setTimeout(2000);

        while (cycles < TOTAL_CYCLES) {
            process.stdout.write(`\rCycle ${cycles + 1}/${TOTAL_CYCLES}... `);

            // 1. Read Header
            await client.readHoldingRegisters(MODEL_101_ADDR, 2);

            // 2. Read random points to simulate scan
            // We'll read 10 random points in the model range
            for (let i = 0; i < 10; i++) {
                const offset = Math.floor(Math.random() * MODEL_101_LEN);
                try {
                    await client.readHoldingRegisters(MODEL_101_ADDR + 2 + offset, 1);
                } catch (e) {
                    log(`Read failed in cycle ${cycles}: ${e.message}`, "ERROR");
                }
            }

            cycles++;
        }
        console.log("\n");
        log("Simulation Complete. No crashes.", "SUCCESS");

    } catch (e) {
        log(`CRITICAL ERROR: ${e.message}`, "FATAL");
    } finally {
        client.close();
    }
}

runSimulation();
