const ModbusRTU = require("modbus-serial");
const fs = require('fs-extra');
const path = require('path');

const IP = "192.168.5.21";
const PORT = 502;
const UNIT_ID = 126;

async function readDeviceInfo() {
    const client = new ModbusRTU();

    try {
        await client.connectTCP(IP, { port: PORT });
        client.setID(UNIT_ID);
        client.setTimeout(2000);

        console.log(`Connected to ${IP}:${PORT} Unit ${UNIT_ID}\n`);

        // Find Model 1 (Common)
        let base = 40002;
        try {
            let m = await client.readHoldingRegisters(40000, 2);
            if (m.data[0] === 0x5375) base = 40002;
        } catch (e) { }

        let model1Addr = -1;
        let addr = base;
        while (true) {
            let h = await client.readHoldingRegisters(addr, 2);
            if (h.data[0] === 0xFFFF) break;
            if (h.data[0] === 1) {
                model1Addr = addr;
                break;
            }
            addr += 2 + h.data[1];
        }

        if (model1Addr === -1) {
            console.error("Model 1 not found");
            return;
        }

        console.log(`Model 1 found at address ${model1Addr}\n`);

        // Read Mn (offset 2, size 16 registers = 32 bytes)
        const mnData = await client.readHoldingRegisters(model1Addr + 2, 16);
        const mn = Buffer.from(mnData.buffer).toString().replace(/\0/g, '').trim();

        // Read Md (offset 18, size 16 registers = 32 bytes)
        const mdData = await client.readHoldingRegisters(model1Addr + 18, 16);
        const md = Buffer.from(mdData.buffer).toString().replace(/\0/g, '').trim();

        // Read SN (offset 52, size 16 registers = 32 bytes)
        const snData = await client.readHoldingRegisters(model1Addr + 52, 16);
        const sn = Buffer.from(snData.buffer).toString().replace(/\0/g, '').trim();

        console.log("=".repeat(80));
        console.log("DEVICE IDENTITY");
        console.log("=".repeat(80));
        console.log(`Manufacturer (Mn): "${mn}"`);
        console.log(`Model (Md):        "${md}"`);
        console.log(`Serial (SN):       "${sn}"`);
        console.log("=".repeat(80));
        console.log();

        // Test naming logic
        console.log("NAMING LOGIC TEST:");
        console.log("=".repeat(80));

        // Current logic: Use md directly if it's a proper model name
        let combinedModel = md;
        if (!md || md.length < 3) {
            let safeMn = mn.length > 2 ? mn.slice(2) : mn;
            combinedModel = safeMn + md;
        }

        console.log(`Current Logic Result: "${combinedModel}"`);
        console.log(`Expected Result:      "GW11K4-MS-US30"`);
        console.log(`Match: ${combinedModel === "GW11K4-MS-US30" ? "✓ YES" : "✗ NO"}`);
        console.log();

        // Alternative logic: merge Mn + Md
        let safeMn = mn.length > 2 ? mn.slice(2) : mn;
        let altCombined = safeMn + md;
        console.log(`Alternative (Mn+Md): "${altCombined}"`);
        console.log();

        // Show what the full label would be
        const snShort = sn.length > 4 ? "..." + sn.slice(-4) : sn;
        const label = `${combinedModel} (${snShort}) - ${IP}:${UNIT_ID}`;
        console.log(`Full Device Label: "${label}"`);
        console.log("=".repeat(80));

    } catch (e) {
        console.error("Error:", e.message);
    } finally {
        client.close();
    }
}

readDeviceInfo().catch(console.error);
