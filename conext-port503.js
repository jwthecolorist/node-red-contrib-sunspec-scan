const ModbusRTU = require("modbus-serial");

const IP = "172.17.0.11";
const PORT = 503; // Priority Proprietary Map
const UNIT_ID = 10; // Conext default ID on 503 is often 10, or could be 1, or something else. We will try 10 and 1.

async function queryFreqWatt() {
    const client = new ModbusRTU();
    try {
        await client.connectTCP(IP, { port: PORT });
        client.setTimeout(2000);

        // Try ID 10 then 1
        const idsToTry = [10, 1, 126, 201];
        let activeId = null;

        for (const id of idsToTry) {
            client.setID(id);
            try {
                // Device Name at Reg 0
                const name = await client.readHoldingRegisters(0, 8);
                console.log(`Found Device on Port 503, ID ${id}:`, name.data);
                activeId = id;
                break;
            } catch (err) {
                console.log(`ID ${id} failed on port 503:`, err.message);
            }
        }

        if (!activeId) {
            console.log("Could not find Conext on Port 503");
            client.close();
            return;
        }

        // We found the device on port 503. Let's try to find Grid Code Frequency parameters.
        // We know from the KB:
        // AC1Frequency is 97.
        // What about grid frequency limits? Let's check typical Conext registers:
        // High Freq Sell Reduce (Freq-Watt) might be in the 170-200 range or 240-260 range.
        // Let's dump out a chunk of registers around AC settings (100 to 200) and grid tie settings (190 to 220)
        
        console.log("\n--- Scanning Grid Tie & Advanced Settings (180 - 250) ---");
        for (let i = 180; i <= 250; i += 10) {
             try {
                 const res = await client.readHoldingRegisters(i, 10);
                 console.log(`Registers ${i} to ${i+9}:`, res.data);
             } catch (e) {
                 // Skip
             }
        }

        console.log("\n--- Scanning AC Thresholds (260 - 300) ---");
        for (let i = 260; i <= 300; i += 10) {
             try {
                 const res = await client.readHoldingRegisters(i, 10);
                 console.log(`Registers ${i} to ${i+9}:`, res.data);
             } catch (e) {
                 // Skip
             }
        }

        client.close();
    } catch (err) {
        console.error("Port 503 Error:", err.message);
    }
}

queryFreqWatt();
