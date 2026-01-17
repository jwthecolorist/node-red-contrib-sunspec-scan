const ModbusRTU = require("modbus-serial");
const fs = require('fs-extra');
const path = require('path');

const IP = "192.168.5.21";
const PORT = 502;
const UNIT_ID = 126;
const MODEL_ID = 101;

async function diagnoseDevice() {
    const client = new ModbusRTU();

    // Load model definition
    const modelsPath = path.join(__dirname, 'models', 'index.json');
    const models = fs.readJsonSync(modelsPath);
    const modelDef = models[MODEL_ID];

    if (!modelDef) {
        console.error("Model 101 not found");
        return;
    }

    try {
        await client.connectTCP(IP, { port: PORT });
        client.setID(UNIT_ID);
        client.setTimeout(2000);

        console.log(`Connected to ${IP}:${PORT} Unit ${UNIT_ID}`);
        console.log(`Reading Model ${MODEL_ID}...\n`);

        // Find model address
        let base = 40002;
        try {
            let m = await client.readHoldingRegisters(40000, 2);
            if (m.data[0] === 0x5375) base = 40002;
        } catch (e) { }

        let modelAddr = -1;
        let addr = base;
        while (true) {
            let h = await client.readHoldingRegisters(addr, 2);
            if (h.data[0] === 0xFFFF) break;
            if (h.data[0] === MODEL_ID) {
                modelAddr = addr;
                break;
            }
            addr += 2 + h.data[1];
        }

        if (modelAddr === -1) {
            console.error("Model 101 not found on device");
            return;
        }

        console.log(`Model ${MODEL_ID} found at address ${modelAddr}\n`);
        console.log("=".repeat(80));
        console.log("Point Name".padEnd(20) + "Description".padEnd(35) + "Raw Value".padEnd(15) + "Status");
        console.log("=".repeat(80));

        const points = modelDef.group.points;
        let offset = 0;

        for (const p of points) {
            // Skip metadata points
            if (p.type === 'pad') {
                let size = p.size || 1;
                offset += size;
                continue;
            }

            let size = p.size || 1;
            if (!p.size) {
                if (p.type.includes('32')) size = 2;
                if (p.type.includes('64')) size = 4;
                if (p.type === 'sunssf') size = 1;
            }

            try {
                const valBlock = await client.readHoldingRegisters(modelAddr + offset, size);
                const buf = valBlock.buffer;

                let raw = 0;
                let status = "OK";
                let isImplemented = true;

                // Check for "Not Implemented" sentinel values
                if (p.type === 'int16' || p.type === 'sunssf') {
                    raw = buf.readInt16BE(0);
                    if (raw === -32768) { status = "NOT IMPL"; isImplemented = false; }
                } else if (p.type === 'uint16' || p.type === 'enum16') {
                    raw = buf.readUInt16BE(0);
                    if (raw === 65535) { status = "NOT IMPL"; isImplemented = false; }
                } else if (p.type === 'int32' || p.type === 'acc32') {
                    raw = buf.readInt32BE(0);
                    if (raw === -2147483648) { status = "NOT IMPL"; isImplemented = false; }
                } else if (p.type === 'uint32') {
                    raw = buf.readUInt32BE(0);
                    if (raw === 4294967295) { status = "NOT IMPL"; isImplemented = false; }
                } else if (p.type === 'string') {
                    raw = buf.toString().replace(/[^a-zA-Z0-9\-\._ ]/g, '').trim();
                    if (raw === '') status = "EMPTY";
                } else {
                    raw = buf.readUInt16BE(0);
                }

                const desc = (p.desc || p.label || p.name).substring(0, 33);
                console.log(
                    p.name.padEnd(20) +
                    desc.padEnd(35) +
                    String(raw).padEnd(15) +
                    status
                );

            } catch (e) {
                console.log(
                    p.name.padEnd(20) +
                    (p.desc || p.label || "").substring(0, 33).padEnd(35) +
                    "ERROR".padEnd(15) +
                    e.message
                );
            }

            offset += size;
        }

        console.log("=".repeat(80));

    } catch (e) {
        console.error("Connection error:", e.message);
    } finally {
        client.close();
    }
}

diagnoseDevice().catch(console.error);
