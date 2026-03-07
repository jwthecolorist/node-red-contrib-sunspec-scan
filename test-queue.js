const ConnectionManager = require('./connection-manager');
const connManager = new ConnectionManager();

async function test() {
    console.log("Starting Blacklist Test...");
    
    // 1. Send request to a fake/dead Unit ID (66) on the real Gateway IP
    console.log("Test 1: Requesting DEAD UnitID 66");
    const p1 = connManager.request("172.17.0.10", 502, 66, async (client) => {
        return await client.readHoldingRegisters(40000, 2);
    }, 2000).catch(e => console.log("Test 1 Result:", e.message));

    // Wait a brief moment to ensure P1 is pending
    await new Promise(r => setTimeout(r, 100));

    // 2. Mocking a Timeout Report (as if the Node-RED node caught it)
    console.log("Mocking a Gateway Timeout Error report from the Node...");
    connManager.reportError("172.17.0.10", 502, 66, new Error('Slave device failure'));

    // 3. Immediately send another request to the same DEAD Unit ID
    console.log("Test 2: Instantly requesting DEAD UnitID 66 again (Should Fast-Fail)");
    const p2 = connManager.request("172.17.0.10", 502, 66, async (client) => {
        return await client.readHoldingRegisters(40000, 2);
    }, 2000).catch(e => console.log("Test 2 Result:", e.message));

    await Promise.all([p1, p2]);
    console.log("Test Finished. Waiting 5 seconds before exiting.");
    setTimeout(() => process.exit(0), 5000);
}

test();
