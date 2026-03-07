const ModbusRTU = require("modbus-serial");
const client = new ModbusRTU();

async function test() {
    try {
        console.log("Connecting to 172.17.0.10:502...");
        await client.connectTCP("172.17.0.10", { port: 502 });
        client.setID(1);
        client.setTimeout(2000);
        
        console.log("Reading registers 30051 (Device Class)...");
        const result = await client.readHoldingRegisters(30051, 2);
        console.log("Result 30051:", result.data);
    } catch (e) {
        console.error("Error:", e);
    } finally {
        client.close();
    }
}
test();
