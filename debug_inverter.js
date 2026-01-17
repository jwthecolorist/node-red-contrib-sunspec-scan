
const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

const IP = "192.168.5.21";
const PORT = 502;
const ID = 126;

async function check() {
    console.log(`Connecting to ${IP}:${PORT} ID:${ID}...`);
    try {
        await client.connectTCP(IP, { port: PORT });
        client.setID(ID);
        client.setTimeout(2000);
        console.log("Connected.");

        // 40000
        try {
            console.log("Checking 40000...");
            const d = await client.readHoldingRegisters(40000, 2);
            console.log("  40000 Raw:", d.data);
            if (d.data[0] == 0x5375 && d.data[1] == 0x6e53) console.log("  FOUND SunS at 40000!");
        } catch (e) { console.log("  40000 Error:", e.message); }

        // 40002
        try {
            console.log("Checking 40002...");
            const d = await client.readHoldingRegisters(40002, 2);
            console.log("  40002 Raw:", d.data);
            if (d.data[0] == 0x5375 && d.data[1] == 0x6e53) console.log("  FOUND SunS at 40002!");
        } catch (e) { console.log("  40002 Error:", e.message); }

        // 50000
        try {
            console.log("Checking 50000...");
            const d = await client.readHoldingRegisters(50000, 2);
            console.log("  50000 Raw:", d.data);
            if (d.data[0] == 0x5375 && d.data[1] == 0x6e53) console.log("  FOUND SunS at 50000!");
        } catch (e) { console.log("  50000 Error:", e.message); }

    } catch (e) {
        console.log("Connection Failed:", e.message);
    } finally {
        client.close();
    }
}

check();
