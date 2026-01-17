/**
 * SunSpec Modbus Scanner Node for Node-RED
 * 
 * Provides SunSpec device discovery, model scanning, and real-time data reading
 * via Modbus TCP. Supports three operation modes:
 * - Full Scan: Discover all devices and models on network
 * - Single Parameter: Read specific point with auto-read capability
 * - Custom List: Batch read multiple parameters into array
 * 
 * Features:
 * - Automatic model address caching for performance
 * - Persistent state across Node-RED restarts
 * - Exponential backoff retry logic
 * - Filtering of unimplemented points
 * - Scale factor application
 * - Configurable decimal rounding
 * 
 * @module node-red-contrib-sunspec-scan
 * @requires modbus-serial
 * @requires fs-extra
 * @requires path
 */

module.exports = function (RED) {
    const ModbusRTU = require("modbus-serial");
    const fs = require('fs-extra');
    const path = require('path');
    const discovery = require('./discovery');
    const CONST = require('./constants');
    const utils = require('./utils');
    const errors = require('./errors');

    // --- Admin API ---
    RED.httpAdmin.get('/sunspec-scan/models', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        const modelsPath = path.join(__dirname, 'models', 'index.json');
        try {
            const models = fs.readJsonSync(modelsPath);
            res.json(models);
        } catch (e) {
            res.status(500).send("Models not found");
        }
    });

    // Global scan state (simple single-user assumption)
    let activeScan = {
        stop: false
    };

    RED.httpAdmin.post('/sunspec-scan/stop', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        activeScan.stop = true;
        res.status(200).send("Stopping");
    });

    RED.httpAdmin.get('/sunspec-scan/status', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(activeScan);
    });

    RED.httpAdmin.post('/sunspec-scan/discover', RED.auth.needsPermission('sunspec-scan.read'), async function (req, res) {
        const config = req.body;
        const results = {};

        // Load models for decoding info
        const modelsPath = path.join(__dirname, 'models', 'index.json');
        let models = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        // Reset stop flag
        activeScan.stop = false;

        try {
            const ips = discovery.parseIpRange(config.ip || "");
            const port = parseInt(config.port) || CONST.DEFAULT_MODBUS_PORT;
            const timeout = parseInt(config.timeout) || CONST.DEFAULT_TIMEOUT;
            const unitIdStr = config.unitId ? String(config.unitId).trim() : "";

            // Parse unit IDs using utility function
            const idsToScan = utils.parseUnitIds(unitIdStr);

            for (const targetIp of ips) {
                // Check Cancellation
                if (activeScan.stop) break;

                activeScan.status = `Checking ${targetIp}:${port}...`;
                if (!await discovery.checkPort(targetIp, port, CONST.DEFAULT_PORT_CHECK_TIMEOUT)) continue;

                console.log(`[SunSpec] Scanning ${targetIp} Unit IDs... Targets: ${idsToScan ? idsToScan.join(',') : 'ALL'}`);
                const t0 = Date.now();
                const ids = await discovery.scanUnitIds(targetIp, port, timeout, null, idsToScan, () => activeScan.stop);
                console.log(`[SunSpec] IDS Scanned in ${Date.now() - t0}ms. Found: ${ids}`);

                if (ids.length > 0) {
                    results[targetIp] = {};
                    for (const id of ids) {
                        if (activeScan.stop) break; // Check inside ID loop too
                        activeScan.status = `Reading Model Data from ${targetIp}:${id}...`;

                        console.log(`[SunSpec] Reading Identity for ${targetIp}:${id}...`);
                        const t1 = Date.now();
                        // Fast Scan: Only read Model 1
                        const modelsFound = await scanDeviceModelsOnly(targetIp, port, id, models, timeout, true);
                        console.log(`[SunSpec] Identity Read in ${Date.now() - t1}ms for ID ${id}`);

                        results[targetIp][id] = modelsFound;
                    }
                }
            }
            activeScan.status = "Scan Complete";
            // console.log("Scan Complete. Sending results:", JSON.stringify(results));
            res.json(results);
        } catch (e) {
            console.error(e);
            res.status(500).send(e.message);
        }
    });

    // NEW: Deep Scan Endpoint (Lazy Load)
    RED.httpAdmin.post('/sunspec-scan/scan-models', RED.auth.needsPermission('sunspec-scan.read'), async function (req, res) {
        const config = req.body;
        // Load models
        const modelsPath = path.join(__dirname, 'models', 'index.json');
        let models = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        const ip = config.ip;
        const port = parseInt(config.port) || 502;
        const unitId = parseInt(config.unitId);
        const timeout = parseInt(config.timeout) || 2000;

        if (!ip || isNaN(unitId)) {
            res.status(400).send("Invalid IP or Unit ID");
            return;
        }

        try {
            console.log(`[SunSpec] Deep Scanning Models for ${ip}:${unitId}...`);
            const modelsFound = await scanDeviceModelsOnly(ip, port, unitId, models, timeout, false); // False = Full Scan
            res.json(modelsFound);
        } catch (e) {
            res.status(500).send(e.message);
        }
    });

    /**
     * @param {string} ip 
     * @param {number} port 
     * @param {number} unitId 
     * @param {object} models 
     * @param {number} timeout 
     * @param {boolean} fastMode If true, stops after finding Model 1
     */
    async function scanDeviceModelsOnly(ip, port, unitId, models, timeout, fastMode) {
        const client = new ModbusRTU();
        const foundModels = {};
        try {
            await client.connectTCP(ip, { port: port });
            client.setID(unitId);
            client.setTimeout(timeout || 2000);

            let baseAddr = 40000;
            try {
                let data = await client.readHoldingRegisters(baseAddr, 2);
                if (data.data[0] === 0x5375) baseAddr = 40002;
                else return {};
            } catch (e) { return {}; }

            let addr = baseAddr;
            while (true) {
                const head = await client.readHoldingRegisters(addr, 2);
                const mid = head.data[0];
                const len = head.data[1];

                if (mid === 0xFFFF) break;

                foundModels[mid] = { start: addr, len: len };

                // Scan for implemented points (FAST BLOCK SCAN)
                if (models && models[mid]) {
                    try {
                        const implementedPoints = await scanImplementedPoints(client, models, mid, addr, len);
                        foundModels[mid].implementedPoints = implementedPoints;
                    } catch (e) {
                        console.log(`Error scanning points for model ${mid}:`, e.message);
                    }
                }

                // Read Common Model Info
                if (mid === 1 && models) {
                    try {
                        const mn = await fetchPointValue(client, models, 1, addr, 'Mn');
                        const md = await fetchPointValue(client, models, 1, addr, 'Md');
                        const sn = await fetchPointValue(client, models, 1, addr, 'SN');
                        foundModels.info = {
                            Mn: mn,
                            Md: md,
                            SN: sn
                        };
                    } catch (e) { console.log("Meta read error", e); }

                    // FAST MODE EXIT
                    if (fastMode) break;
                }

                addr += 2 + len;
            }
        } catch (e) { console.log("Scan Model Error", e); } finally {
        }
        return foundModels;
    }

    // Optimized helper to scan which points are implemented (Block Read)
    async function scanImplementedPoints(client, models, modelId, modelAddr, modelLen) {
        const mDef = models[modelId];
        if (!mDef || !mDef.group || !mDef.group.points) return [];

        const implementedPoints = [];
        const points = mDef.group.points;
        const totalLen = modelLen || mDef.group.len || 0; // Use reported length

        if (!totalLen) return [];

        try {
            // Read entire model block in one go
            // Max modbus read is usually 125 registers. Models can be larger.
            // Split into chunks if needed, but for now assuming most models < 120 regs.
            // If larger, we'll read only first 120 or implement chunking loop later.
            const safeLen = Math.min(totalLen, 120);
            const valBlock = await client.readHoldingRegisters(modelAddr, safeLen);
            const fullBuf = valBlock.buffer;

            let offset = 0;

            for (const p of points) {
                // Determine size
                let size = p.size || 1;
                if (!p.size) {
                    if (p.type.includes('32')) size = 2;
                    if (p.type.includes('64')) size = 4;
                    if (p.type === 'sunssf') size = 1;
                }

                // Check if point is within our read buffer
                if (offset + size > safeLen) { // safeLen is registers, offset is registers
                    // Out of bounds of our single read - skip or implement chunking
                    offset += size;
                    continue;
                }

                // Skip pads and scale factors from the list
                if (p.type === 'pad' || p.type === 'sunssf') {
                    offset += size;
                    continue;
                }

                let isImplemented = true;
                const byteOffset = offset * 2; // registers to bytes

                // Check for NOT IMPLEMENTED sentinel values
                if (p.type === 'int16') {
                    const val = fullBuf.readInt16BE(byteOffset);
                    if (val === -32768) isImplemented = false;
                } else if (p.type === 'uint16' || p.type === 'enum16') {
                    const val = fullBuf.readUInt16BE(byteOffset);
                    if (val === 65535) isImplemented = false;
                } else if (p.type === 'int32' || p.type === 'acc32') {
                    const val = fullBuf.readInt32BE(byteOffset);
                    if (val === -2147483648) isImplemented = false;
                } else if (p.type === 'uint32') {
                    const val = fullBuf.readUInt32BE(byteOffset);
                    if (val === 4294967295) isImplemented = false;
                }

                if (isImplemented) {
                    implementedPoints.push(p.name);
                }

                offset += size;
            }
        } catch (e) {
            console.log(`Block scan failed for Model ${modelId}: ${e.message} `);
            return [];
        }

        console.log(`[SunSpec] FAST SCAN Model ${modelId}: Found ${implementedPoints.length} implemented points`);
        return implementedPoints;
    }


    // --- Runtime Node ---

    function SunSpecScanNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.ip = config.ip || "";
        node.port = parseInt(config.port) || CONST.DEFAULT_MODBUS_PORT;
        node.timeout = parseInt(config.timeout) || CONST.DEFAULT_TIMEOUT;
        node.unitId = parseInt(config.unitId);
        node.scanIds = config.scanIds;

        node.readMode = config.readMode || "scan";

        // Single param config
        node.selectedDevice = config.selectedDevice; // IP:ID
        node.selectedModel = parseInt(config.selectedModel);
        node.selectedPoint = config.selectedPoint;
        node.selectedId = config.selectedId; // Explicit param ID

        // List config
        node.outputList = config.outputList || [];

        // Output formatting
        node.roundDecimals = config.roundDecimals !== undefined ? config.roundDecimals : true;

        // Pacing config with validation
        let rawPacing = parseFloat(config.pacing);
        if (!isNaN(rawPacing) && rawPacing > 0 && rawPacing < CONST.MIN_PACING_INTERVAL) {
            node.warn(`Auto-read interval ${rawPacing}s is too fast. Enforcing minimum ${CONST.MIN_PACING_INTERVAL}s.`);
            rawPacing = CONST.MIN_PACING_INTERVAL;
        }
        node.pacing = rawPacing;

        // Persistent model address cache (survives Node-RED restarts)
        const cacheKey = `modelAddressCache_${node.id}`;
        node.modelAddressCache = node.context().get(cacheKey) || {};

        // Connection state tracking
        node.connectionState = {
            lastSuccess: null,
            lastError: null,
            consecutiveErrors: 0,
            retryDelay: CONST.BASE_RETRY_DELAY
        };

        const modelsPath = path.join(__dirname, 'models', 'index.json');
        let models = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        // Core Scan Logic Reusable Function
        async function triggerScan(msg) {
            msg = msg || {};

            // --- MODE 2: Parameter List (Custom Array) ---
            if (node.readMode === 'list' && node.outputList.length > 0) {
                node.status({ fill: "blue", shape: "dot", text: `reading ${node.outputList.length} items...` });

                // Group by IP:ID for optimization
                const groups = {};
                node.outputList.forEach((item, index) => {
                    const key = `${item.device}:${item.id}`;
                    if (!groups[key]) groups[key] = [];
                    groups[key].push({ ...item, originalIndex: index });
                });

                const finalArray = new Array(node.outputList.length).fill(null);

                // Process Groups concurrently 
                for (const key in groups) {
                    const [ip, idStr] = key.split(':');
                    const id = parseInt(idStr);
                    const items = groups[key];

                    // Run single connection session for this device
                    try {
                        const values = await readMultiplePoints(node, models, ip, node.port, id, items, node.timeout);
                        // Map back to final array
                        values.forEach(v => {
                            finalArray[v.index] = v.value;
                        });
                    } catch (e) {
                        node.error(`List Read Error ${key}: ${e.message}`);
                    }
                }

                msg.payload = finalArray;
                node.send(msg);
                node.status({ fill: "green", shape: "dot", text: "read complete" });
                return;
            }

            // --- MODE 1: Single Parameter ---
            if (node.readMode === 'parameter' && node.selectedModel && node.selectedPoint) {
                node.status({ fill: "blue", shape: "dot", text: `reading ${node.selectedPoint}...` });

                let targetId = node.unitId;
                let targetIp = node.ip;

                if (node.selectedDevice && node.selectedDevice.includes(":")) {
                    const [ip, id] = node.selectedDevice.split(':');
                    targetIp = ip;
                    targetId = parseInt(id);
                }

                if (node.selectedId) {
                    targetId = parseInt(node.selectedId);
                }

                if (!targetIp || isNaN(targetId)) {
                    node.error("Invalid Target IP/ID for parameter read");
                    return;
                }

                try {
                    const val = await readSinglePoint(node, models, targetIp, node.port, targetId, node.selectedModel, node.selectedPoint, node.timeout);
                    if (val !== null) {
                        msg.payload = val;
                        node.send(msg);
                        node.status({ fill: "green", shape: "dot", text: `${val}` });
                    } else {
                        node.status({ fill: "red", shape: "ring", text: "read failed" });
                    }
                } catch (e) {
                    node.error(e);
                }
                return;
            }

            // --- MODE 0: Full Scan (Fallback) ---
            node.status({ fill: "blue", shape: "dot", text: "scanning..." });
            const results = {};
            let ips = discovery.parseIpRange(node.ip);
            for (const targetIp of ips) {
                if (!await discovery.checkPort(targetIp, node.port)) continue;
                const ids = node.scanIds ? await discovery.scanUnitIds(targetIp, node.port, 1000) : [node.unitId];
                for (const id of ids) {
                    const deviceData = await readSunSpecDevice(targetIp, node.port, id, models, node);
                    if (deviceData) {
                        if (!results[targetIp]) results[targetIp] = {};
                        results[targetIp][id] = deviceData;
                    }
                }
            }
            msg.payload = results;
            node.send(msg);
            node.status({ fill: "green", shape: "dot", text: "scan complete" });
        }

        // Input Listener
        node.on('input', function (msg) {
            triggerScan(msg);
        });

        // Interval Listener with retry logic
        let intervalId = null;
        let retryTimeoutId = null;

        if (node.pacing && node.pacing > 0) {
            node.log(`Auto-read enabled: ${node.pacing}s`);

            const executeRead = () => {
                triggerScan({}).catch(err => {
                    node.connectionState.consecutiveErrors++;
                    node.connectionState.lastError = new Date();

                    // Exponential backoff (max 30s)
                    const delay = Math.min(
                        node.connectionState.retryDelay * Math.pow(2, node.connectionState.consecutiveErrors - 1),
                        30000
                    );

                    node.error(`Auto-read failed (${node.connectionState.consecutiveErrors} consecutive). Retrying in ${delay / 1000}s...`);

                    // Clear regular interval during error recovery
                    if (intervalId) {
                        clearInterval(intervalId);
                        intervalId = null;
                    }

                    // Schedule retry
                    retryTimeoutId = setTimeout(() => {
                        retryTimeoutId = null;
                        executeRead(); // Recursive retry
                    }, delay);
                }).then(() => {
                    // Success - reset error counter
                    if (node.connectionState.consecutiveErrors > 0) {
                        node.log(`Auto-read recovered after ${node.connectionState.consecutiveErrors} failures`);
                    }
                    node.connectionState.consecutiveErrors = 0;
                    node.connectionState.lastSuccess = new Date();

                    // Resume regular interval if we were in retry mode
                    if (!intervalId && node.pacing > 0) {
                        intervalId = setInterval(executeRead, node.pacing * 1000);
                    }
                });
            };

            // Initial read
            executeRead();

            // Regular interval
            intervalId = setInterval(executeRead, node.pacing * 1000);
        }

        node.on('close', function (done) {
            // Clear intervals
            if (intervalId) clearInterval(intervalId);
            if (retryTimeoutId) clearTimeout(retryTimeoutId);

            // Persist cache to context
            node.context().set(cacheKey, node.modelAddressCache);

            done();
        });
    }

    // --- Optimized Multi-Read ---
    async function readMultiplePoints(node, models, ip, port, unitId, items, timeout) {
        const client = new ModbusRTU();
        const results = [];

        try {
            await client.connectTCP(ip, { port: port });
            client.setID(unitId);
            client.setTimeout(timeout || 2000);

            // 1. Locate SunSpec Base
            let base = 40002;
            try {
                let m = await client.readHoldingRegisters(40000, 2);
                if (m.data[0] === 0x5375) base = 40002;
            } catch (e) { }

            // 2. Map Model Locations (Cache for this connection)
            const modelAddresses = {}; // Map<ModelID, StartAddr>

            let addr = base;
            while (true) {
                let h = await client.readHoldingRegisters(addr, 2);
                if (h.data[0] === 0xFFFF) break;
                // Store model address
                // Note: Device might have multiple of same model? Only first supported for now.
                if (!modelAddresses[h.data[0]]) {
                    modelAddresses[h.data[0]] = addr + 2;
                }
                addr += 2 + h.data[1];
            }

            // 3. Process Items
            for (const item of items) {
                const mid = parseInt(item.model);
                const mAddr = modelAddresses[mid];

                if (!mAddr) {
                    results.push({ index: item.originalIndex, value: null });
                    continue;
                }

                // Read Point Logic (Reuse from readSinglePoint but simplified params)
                // We need to fetch point definition
                const val = await fetchPointValue(client, models, mid, mAddr, item.point);
                results.push({ index: item.originalIndex, value: val });
            }

            return results;

        } catch (e) {
            throw e;
        } finally {
            client.close();
        }
    }

    // Extracted Helper for reading value with open client
    async function fetchPointValue(client, models, modelId, modelAddr, pointName, node) {
        const mDef = models[modelId];
        if (!mDef) return null;

        const points = mDef.group.points;
        const pointDef = points.find(p => p.name === pointName);
        if (!pointDef) return null;

        // Calc Offset
        let offset = 0;
        let logOffset = "";
        for (const p of points) {
            if (p.name === pointName) {
                if (node) node.warn(`Offset Info for ${pointName}: Addr = ${modelAddr} +${offset}=${modelAddr + offset} (Prev Points Summed: ${logOffset})`);
                break;
            }
            let size = p.size || 1;
            if (!p.size) {
                if (p.type.includes('32')) size = 2;
                if (p.type.includes('64')) size = 4;
                if (p.type === 'sunssf') size = 1;
            }
            offset += size;
            // logOffset += `${ p.name } (${ size })`; // heavy logging
        }

        let size = pointDef.size || 1;
        if (!pointDef.size) {
            if (pointDef.type.includes('32')) size = 2;
            if (pointDef.type.includes('64')) size = 4;
            if (pointDef.type === 'sunssf') size = 1;
        }

        const valBlock = await client.readHoldingRegisters(modelAddr + offset, size);

        let raw = 0;
        const buf = valBlock.buffer;

        // Decoding & Not Implemented Check
        if (pointDef.type === 'int16') {
            raw = buf.readInt16BE(0);
            if (raw === -32768) return null; // 0x8000
        }
        else if (pointDef.type === 'uint16' || pointDef.type === 'enum16') {
            raw = buf.readUInt16BE(0);
            if (raw === 65535) return null; // 0xFFFF
        }
        else if (pointDef.type === 'int32') {
            raw = buf.readInt32BE(0);
            if (raw === -2147483648) return null; // 0x80000000
        }
        else if (pointDef.type === 'uint32') {
            raw = buf.readUInt32BE(0);
            if (raw === 4294967295) return null; // 0xFFFFFFFF
        }
        else if (pointDef.type === 'sunssf') {
            raw = buf.readInt16BE(0);
            if (raw === -32768) return null; // 0x8000
        }
        else if (pointDef.type === 'string') {
            // String decoding with trim
            let s = buf.toString();
            // Strict Whitelist: Allow only Alphanumeric, Space, Dot, Dash, Underscore.
            // Removes ~ (0x7E), Control codes, Unicode replacements, etc.
            raw = s.replace(/[^a-zA-Z0-9\-\.\_ ]/g, '').trim();
        }
        else {
            raw = buf.readUInt16BE(0); // fallback
        }

        let val = raw;

        // Skip scaling if value is a string or null
        if (typeof val === 'string' || val === null) return val;

        // Scaling
        if (pointDef.sf && typeof val === 'number') {
            // Skip scaling for W and VA - return raw values
            if (pointDef.name === 'W' || pointDef.name === 'VA') {
                if (node) node.warn(`Skipping scaling for ${pointDef.name}: Raw = ${val} (scale factor ignored per config)`);
            } else {
                let sfOffset = 0;
                let foundSF = false;
                for (const p of points) {
                    if (p.name === pointDef.sf) { foundSF = true; break; }
                    let s = p.size || 1;
                    if (!p.size) {
                        if (p.type.includes('32')) s = 2;
                        if (p.type.includes('64')) s = 4;
                        if (p.type === 'sunssf') s = 1;
                    }
                    sfOffset += s;
                }
                if (foundSF) {
                    const sfBlock = await client.readHoldingRegisters(modelAddr + sfOffset, 1);
                    const sf = sfBlock.buffer.readInt16BE(0);

                    // Check if SF itself is implemented
                    if (sf !== -32768) {
                        const scale = Math.pow(10, sf);
                        const original = val;
                        val = val * scale;
                    }
                    // If SF is not implemented, we probably shouldn't return a value either, 
                    // OR return raw value? SunSpec says if SF is unimpl, the value is unimpl.
                    // But we already checked value unimpl. If value is there but SF isnt, maybe just raw?
                    // Let's assume raw if SF missing.
                }
            }
        }

        // Round to 2 decimals if enabled
        if (node && node.roundDecimals && typeof val === 'number') {
            val = Number(val.toFixed(2));
        }

        return val;
    }

    /**
     * Read a single SunSpec point from a device
     * 
     * @param {Object} node - Node-RED node instance for logging/state
     * @param {Object} models - SunSpec model definitions object
     * @param {string} ip - Target device IP address
     * @param {number} port - Modbus TCP port (usually 502)
     * @param {number} unitId - Modbus unit/slave ID
     * @param {number} modelId - SunSpec model ID to read from
     * @param {string} pointName - Name of the point to read
     * @param {number} [timeout=2000] - Operation timeout in milliseconds
     * @returns {Promise<number|string|null>} Point value or null on error
     * @throws {SunSpecConnectionError} If connection fails
     * @throws {SunSpecModelNotFoundError} If model not found in device
     * @throws {SunSpecPointNotFoundError} If point not found in model
     */
    async function readSinglePoint(node, models, ip, port, unitId, modelId, pointName, timeout) {
        const client = new ModbusRTU();
        try {
            // Connection with timeout
            await utils.withTimeout(
                client.connectTCP(ip, { port: port }),
                timeout || CONST.CONNECTION_TIMEOUT,
                'TCP connection'
            );

            client.setID(unitId);
            client.setTimeout(timeout || CONST.DEFAULT_TIMEOUT);

            const cacheKey = `${ip}:${unitId}`;

            // Check cache first
            let modelAddr = -1;
            if (node.modelAddressCache[cacheKey] && node.modelAddressCache[cacheKey][modelId]) {
                modelAddr = node.modelAddressCache[cacheKey][modelId];
            } else {
                // Cache miss - use utility function to find model
                modelAddr = await utils.findModelAddress(client, modelId);

                // Store in cache if found
                if (modelAddr !== -1) {
                    if (!node.modelAddressCache[cacheKey]) {
                        node.modelAddressCache[cacheKey] = {};
                    }
                    node.modelAddressCache[cacheKey][modelId] = modelAddr;

                    // Persist immediately
                    const persistKey = `modelAddressCache_${node.id}`;
                    node.context().set(persistKey, node.modelAddressCache);
                }
            }

            if (modelAddr === -1) {
                throw new errors.SunSpecModelNotFoundError(modelId, `${ip}:${unitId}`);
            }

            const result = await fetchPointValue(node, client, models, modelId, modelAddr, pointName);

            // Update connection state on success
            if (node.connectionState) {
                node.connectionState.lastSuccess = new Date();
            }

            return result;
        } catch (e) {
            // Enhanced error logging with specific error types
            if (e instanceof errors.SunSpecModelNotFoundError ||
                e instanceof errors.SunSpecTimeoutError) {
                // Already typed errors - rethrow as-is
                throw e;
            }

            // Wrap generic errors
            const errorMsg = `Read failed: ${e.message} (${ip}:${port} ID=${unitId} Model=${modelId} Point=${pointName})`;
            console.error(errorMsg);

            // Update connection state
            if (node.connectionState) {
                node.connectionState.lastError = new Date();
            }

            throw new Error(errorMsg);
        } finally {
            try {
                client.close();
            } catch (e) {
                // Ignore close errors
            }
        }
    }

    // Copy of read logic (no change)
    async function readSunSpecDevice(ip, port, unitId, models, node) {
        const client = new ModbusRTU();
        try {
            await client.connectTCP(ip, { port: port });
            client.setID(unitId);
            client.setTimeout(5000);
            let baseAddr = 40000;
            try {
                let data = await client.readHoldingRegisters(baseAddr, 2);
                if (data.data[0] === 0x5375 && data.data[1] === 0x6e53) baseAddr = 40002;
                else return null;
            } catch (e) { return null; }

            const deviceMap = {};
            let addr = baseAddr;
            while (true) {
                const header = await client.readHoldingRegisters(addr, 2);
                const modelId = header.data[0];
                const length = header.data[1];
                if (modelId === 0xFFFF) break;
                const content = await client.readHoldingRegisters(addr + 2, length);
                let decoded = { id: modelId, length: length, raw: content.data };
                if (models[modelId]) decoded.name = models[modelId].group.label || models[modelId].group.name;
                deviceMap[modelId] = decoded;
                addr += 2 + length;
            }
            return deviceMap;
        } catch (e) { return null; } finally { client.close(); }
    }

    RED.nodes.registerType("sunspec-scan", SunSpecScanNode);
}
