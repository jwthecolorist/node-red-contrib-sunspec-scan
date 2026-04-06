const ModbusRTU = require("modbus-serial");

const IP = "172.17.0.11";
const PORT = 502;
const UNIT_ID = 126;

async function monitor() {
    const client = new ModbusRTU();
    
    try {
        await client.connectTCP(IP, { port: PORT });
        client.setID(UNIT_ID);
        client.setTimeout(2000);
        console.log(`Connected to Conext at ${IP}:${PORT} (ID: ${UNIT_ID})`);

        // Scan for Model 102 (Inverter) and Model 124 (Storage)
        let base = 40000;
        let m = await client.readHoldingRegisters(40000, 2);
        if (m.data[0] === 0x5375) base = 40002;

        let addr = base;
        let model102Addr = null;
        let model124Addr = null;

        while (true) {
            const header = await client.readHoldingRegisters(addr, 2);
            const modelId = header.data[0];
            const length = header.data[1];

            if (modelId === 0xFFFF || length === 0) break;
            
            if (modelId === 102) model102Addr = addr;
            if (modelId === 124) model124Addr = addr;
            
            addr += length + 2;
            if (addr > 41000) break; // Fallback
        }

        console.log(`Found Model 102 at ${model102Addr}, Model 124 at ${model124Addr}`);

        if (!model102Addr) {
            console.error("Model 102 not found!");
            process.exit(1);
        }

        // Monitor loop
        let failures = 0;
        setInterval(async () => {
            try {
                // Read AC Power from Model 102
                // Model 102 offset for W is 14 (length 1), W_SF is 15
                // Wait, let's just read the whole chunk for model 102 
                // Or better, read specific registers. Since we don't know exact offsets offhand, let's just read the block and guess, or read standard SunSpec:
                // 102 Offset: Amps=2, Amps_SF=6, V=7, V_SF=11, W=14, W_SF=15, Hz=16, Hz_SF=17, VA=18, VA_SF=19
                const res = await client.readHoldingRegisters(model102Addr + 2, 20); // Read offsets 2 to 21
                
                // W is at offset 14. We started at +2, so W is array index 12
                const w_raw = res.buffer.readInt16BE(12 * 2);
                const w_sf = res.buffer.readInt16BE(13 * 2);
                const power = w_raw * Math.pow(10, w_sf);

                // Hz is at offset 16. We started at +2, so Hz is array index 14
                const hz_raw = res.buffer.readUInt16BE(14 * 2);
                const hz_sf = res.buffer.readInt16BE(15 * 2);
                const hz = hz_raw * Math.pow(10, hz_sf);

                // Read Model 124 (Storage) if available
                let soc = -1;
                let ctlMod = -1;
                if (model124Addr) {
                    const res124 = await client.readHoldingRegisters(model124Addr + 2, 20);
                    // Standard SunSpec 124:
                    // WChaMax offset 2
                    // WChaGra offset 4
                    // WDisChaGra offset 6
                    // StorCtl_Mod offset 5 
                    const resCtl = await client.readHoldingRegisters(model124Addr + 5, 1);
                    ctlMod = resCtl.data[0];
                }

                console.log(`[${new Date().toISOString()}] Hz: ${hz.toFixed(3)} | Power: ${power.toFixed(0)} W | StorCtl_Mod: ${ctlMod}`);
                failures = 0;
            } catch (err) {
                failures++;
                console.error(`[${new Date().toISOString()}] Read Error: ${err.message} (Consecutive: ${failures})`);
                
                if (err.message.includes("Port Not Open") || err.message.includes("closed")) {
                    console.log("Reconnecting...");
                    try {
                        client.close();
                        await client.connectTCP(IP, { port: PORT });
                        client.setID(UNIT_ID);
                    } catch (e) {
                         console.error("Reconnect failed:", e.message);
                    }
                }
            }
        }, 1000);

    } catch (err) {
        console.error("Initialization Failed:", err.message);
    }
}

monitor();
