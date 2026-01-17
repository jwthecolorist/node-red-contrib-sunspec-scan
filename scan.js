
const ModbusRTU = require("modbus-serial");
const fs = require('fs-extra');
const path = require('path');

// Configuration
const IP = '172.17.0.11';
const PORT = 502;
const ID = 1; // Defaulting to 1 for new device, will retry if blocked
const TIMEOUT = 5000;

// Load models
const modelsPath = path.join(__dirname, 'models', 'index.json');
let models = {};

try {
    models = fs.readJsonSync(modelsPath);
    console.log(`Loaded ${Object.keys(models).length} models.`);
} catch (e) {
    console.error("Failed to load models. Run download-models.js first.");
    process.exit(1);
}

// Helpers
function getPointValue(buffer, type, scaleRef) {
    // Simplified parser for prototype
    // sunspec types: int16, uint16, acc16, int32, uint32, float32, string, sunssf...

    // For now, assuming standard Modbus big-endian
    // Implementation would need to be robust.
    // Making a very basic assumption for the prototype: we read everything as raw
    return "RAW";
}

async function main() {
    const client = new ModbusRTU();

    try {
        console.log(`Connecting to ${IP}:${PORT} (ID: ${ID})...`);
        await client.connectTCP(IP, { port: PORT });
        client.setID(ID);
        client.setTimeout(TIMEOUT);

        // Scan logic
        // SunSpec starts at 40000, 40001, or 50000. 
        // We look for 'SunS' (0x5375 0x6e53) at start addresses.

        let baseAddr = 40000;
        let found = false;

        // Try to read 2 registers at 40000
        let data = await client.readHoldingRegisters(baseAddr, 2);
        let marker = data.buffer.toString('utf8'); // standard buffer
        // Note: modbus-serial returns buffer. 
        // We might need to handle buffer conversion carefully.

        // Manual check for 'SunS'
        // 0x53756e53
        const val1 = data.data[0];
        const val2 = data.data[1];

        if (val1 === 0x5375 && val2 === 0x6e53) {
            console.log("Found 'SunS' marker at 40000");
            found = true;
            baseAddr = 40002; // Start of models
        } else {
            console.log(`Marker not found at 40000: ${val1.toString(16)} ${val2.toString(16)}`);
            // Try 40001 or 50000 if needed, but standard is 40000 (base 0 or 1 issue)
            // Python usually handles this.
        }

        if (found) {
            // Walk the models
            let addr = baseAddr; // 40002

            while (true) {
                // Read Model ID and Length (2 registers)
                const header = await client.readHoldingRegisters(addr, 2);
                const modelId = header.data[0];
                const length = header.data[1];

                if (modelId === 0xFFFF) {
                    console.log("End of SunSpec map.");
                    break;
                }

                console.log(`\nFound Model ${modelId} (Length ${length}) at address ${addr}`);

                if (models[modelId]) {
                    console.log(` -> Definition found for Model ${modelId}. Reading content...`);
                    // Read the content
                    // Note: modbus-serial reads in 2-byte words
                    const content = await client.readHoldingRegisters(addr + 2, length);

                    // Decode logic would go here
                    // For prototype, we just prove we can read the block
                    console.log(` -> Raw Data (first 5 words): ${content.data.slice(0, 5)}...`);

                    // Simple parser for Model 101/103 (Inverter) common fields
                    // Just to demo validation
                    if ([101, 102, 103].includes(modelId)) {
                        // Offset 0 = Amps, 1 = Amps_SF?
                        // Depending on the model definition.
                        const def = models[modelId];
                        // In 103:
                        // 0: A
                        // 1: A_SF
                        const amps = content.data[0]; // int16 or uint16
                        const amps_sf = content.data[1]; // int16 scale factor

                        console.log(` -> Inverter Data Sample: Amps Raw: ${amps}, SF Raw: ${amps_sf}`);
                    }

                } else {
                    console.log(` -> No definition found for Model ${modelId}`);
                }

                // Next model
                addr += 2 + length;
            }
        }

    } catch (e) {
        console.error("Error:", e);
    } finally {
        client.close();
    }
}

main();
