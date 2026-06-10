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
    const ConnectionManager = require('./connection-manager');
    const connManager = new ConnectionManager();
    global.microgridConnectionManager = connManager; // Share the unified TCP queue across disparate nodes

    const discovery = require('./discovery');
    const sunspecClient = require('./sunspec-client');
    const CONST = require('./constants');
    const utils = require('./utils');
    const errors = require('./errors');
    const DeviceManager = require('./device-manager');

    // Initialize Device Manager
    const deviceManager = new DeviceManager(RED.settings.userDir);

    // --- Admin API ---
    // Device Management
    RED.httpAdmin.get('/sunspec-scan/devices', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(deviceManager.list());
    });

    RED.httpAdmin.post('/sunspec-scan/devices', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        try {
            const dev = deviceManager.add(req.body);
            res.json(dev);
        } catch (e) { res.status(400).send(e.message); }
    });

    RED.httpAdmin.put('/sunspec-scan/devices/:id', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        try {
            const dev = deviceManager.update(req.params.id, req.body);
            res.json(dev);
        } catch (e) { res.status(400).send(e.message); }
    });

    RED.httpAdmin.delete('/sunspec-scan/devices/:id', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        const success = deviceManager.delete(req.params.id);
        if (success) res.sendStatus(200);
        else res.sendStatus(404);
    });

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

    // Server-side persistent network map: { ip: { unitId: { models... } } }
    let networkMap = {};
    const cachePath = path.join(RED.settings.userDir, 'sunspec-cache.json');

    function saveNetworkMap() {
        try {
            fs.writeJsonSync(cachePath, networkMap, { spaces: 2 });
        } catch (e) {
            console.error("[SunSpec] Failed to save scan cache:", e.message);
        }
    }

    function loadNetworkMap() {
        try {
            if (fs.existsSync(cachePath)) {
                networkMap = fs.readJsonSync(cachePath);
                console.log(`[SunSpec] Loaded scan cache from disk (${Object.keys(networkMap).length} devices).`);
            }
        } catch (e) {
            console.error("[SunSpec] Failed to load scan cache:", e.message);
            networkMap = {};
        }
    }

    // Load on startup
    loadNetworkMap();

    RED.httpAdmin.post('/sunspec-scan/stop', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        activeScan.stop = true;
        res.status(200).send("Stopping");
    });

    RED.httpAdmin.get('/sunspec-scan/status', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(activeScan);
    });

    // NEW: Get full network map
    RED.httpAdmin.get('/sunspec-scan/network', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(networkMap);
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
                    for (const idObj of ids) {
                        if (activeScan.stop) break; // Check inside ID loop too
                        const id = idObj.id;
                        const type = idObj.type;

                        activeScan.status = `Reading Model Data from ${targetIp}:${id}...`;

                        console.log(`[SunSpec] Reading Identity (${type}) for ${targetIp}:${id}...`);
                        const t1 = Date.now();
                        // Fast Scan: Only read Model 1 or Vendor ID
                        const modelsFound = await scanDeviceModelsOnly(targetIp, port, id, models, timeout, true, type);
                        console.log(`[SunSpec] Identity Read in ${Date.now() - t1}ms for ID ${id}`);

                        results[targetIp][id] = modelsFound;

                        // Update Global Map
                        // KEY BY IP:PORT to avoid collision (502 vs 503)
                        const deviceKey = `${targetIp}:${port}`;
                        if (!networkMap[deviceKey]) networkMap[deviceKey] = {};
                        networkMap[deviceKey][id] = modelsFound;
                        saveNetworkMap();

                        // Auto-save to Device Manager
                        try {
                            let name = "";
                            if (modelsFound && modelsFound.info) {
                                const mn = modelsFound.info.Mn || "";
                                const md = modelsFound.info.Md || "";
                                if (mn || md) name = `${mn} ${md}`.trim();
                            }
                            // If no name found immediately, let upsert logic handle default or keep existing
                            deviceManager.upsert({
                                ip: targetIp,
                                port: port,
                                unitId: id,
                                name: name || undefined
                            });
                        } catch (e) { console.error("[SunSpec] Auto-save error:", e.message); }
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

        // Check Network Map (Deep Scan Cache)
        // Check Network Map (Deep Scan Cache)
        // BUG FIX: Key is IP:PORT for disambiguation
        // Standardize Key: ALWAYS use IP:PORT to align with scan logic
        const deviceKey = `${ip}:${port}`;

        if (networkMap[deviceKey] && networkMap[deviceKey][unitId]) {
            const cached = networkMap[deviceKey][unitId];
            // Only serve cache if it looks like a deep scan (more than just Model 1 + Info)
            if (Object.keys(cached).length > 2) {
                res.json(cached);
                return;
            }
        }

        try {
            console.log(`[SunSpec] Deep Scanning Models for ${ip}:${port}:${unitId}...`);

            // Infer Type from Port
            let type = null;
            if (port === 503) type = 'conext_xw_503';

            const modelsFound = await scanDeviceModelsOnly(ip, port, unitId, models, timeout, false, type); // False = Full Scan

            // Update Global Map
            if (!networkMap[deviceKey]) networkMap[deviceKey] = {};
            networkMap[deviceKey][unitId] = modelsFound;

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
    async function scanDeviceModelsOnly(ip, port, unitId, models, timeout, fastMode, type) {

        // Vendor Specific Scan
        if (type === 'sma_edmm') {
            return {
                'sma_edmm': { start: 0, len: 0 },
                'info': { Mn: 'SMA', Md: 'Data Manager' }
            };
        }

        // Restored Conext 503 logic
        if (type === 'conext_xw_503') {
            return {
                'conext_xw_503': { start: 0, len: 0 },
                'info': { Mn: 'Schneider', Md: 'Conext XW (503)' }
            };
        }



        const foundModels = {};
        try {
            // Routed through the shared ConnectionManager (no raw socket) so editor
            // scans can't collide with runtime reads on the same gateway, and so
            // they inherit the hard connect-timeout + cooldown protections.
            const early = await connManager.request(ip, port, unitId, async (client) => {
                client.setTimeout(timeout || 2000);

                let baseAddr = 40000;
                try {
                    let data = await client.readHoldingRegisters(baseAddr, 2);
                    if (data.data[0] === 0x5375) baseAddr = 40002;
                    else {
                        // SunSpec header not found — probe 30051 for an SMA signature.
                        try {
                            const smaData = await client.readHoldingRegisters(30051, 2);
                            const smaVal = (smaData.data[0] << 16) | smaData.data[1];
                            if (smaVal === 8128 || smaVal === 9397 || smaVal === 19135) {
                                console.log(`[SunSpec] Fallback: Detected SMA Device at ${ip}:${unitId} during scan.`);
                                return { 'sma_edmm': { start: 0, len: 0 }, 'info': { Mn: 'SMA', Md: 'Data Manager' } };
                            }
                        } catch (e2) { /* ignore */ }
                        return {};
                    }
                } catch (e) {
                    try {
                        const smaData = await client.readHoldingRegisters(30051, 2);
                        const smaVal = (smaData.data[0] << 16) | smaData.data[1];
                        if (smaVal === 8128 || smaVal === 9397 || smaVal === 19135) {
                            console.log(`[SunSpec] Fallback: Detected SMA Device at ${ip}:${unitId} during scan (after SunSpec fail).`);
                            return { 'sma_edmm': { start: 0, len: 0 }, 'info': { Mn: 'SMA', Md: 'Data Manager' } };
                        }
                    } catch (e3) { /* ignore */ }
                    return {};
                }

                let addr = baseAddr;
                while (true) {
                    const head = await client.readHoldingRegisters(addr, 2);
                    const mid = head.data[0];
                    const len = head.data[1];
                    if (mid === 0xFFFF) break;

                    foundModels[mid] = { start: addr, len: len };

                    // addr is the HEADER address; model JSON points include ID+L so
                    // a block read from the header aligns with the schema.
                    if (models && models[mid]) {
                        try {
                            foundModels[mid].implementedPoints = await scanImplementedPoints(client, models, mid, addr, len);
                        } catch (e) {
                            console.log(`Error scanning points for model ${mid}:`, e.message);
                        }
                    }

                    if (mid === 1 && models) {
                        try {
                            const mn = await fetchPointValue(client, models, 1, addr, 'Mn');
                            const md = await fetchPointValue(client, models, 1, addr, 'Md');
                            const sn = await fetchPointValue(client, models, 1, addr, 'SN');
                            foundModels.info = { Mn: mn, Md: md, SN: sn };
                        } catch (e) { console.log("Meta read error", e); }
                        if (fastMode) break;
                    }

                    addr += 2 + len;
                }
                return null; // normal path -> caller uses foundModels
            }, timeout);
            if (early) return early;
        } catch (e) { console.log("Scan Model Error", e); }
        console.log(`[SunSpec] Scan Result for ${ip}:${port}: ${Object.keys(foundModels).length} models found.`);
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
                if (p.type === 'int16' || p.type === 'sint16') {
                    const val = fullBuf.readInt16BE(byteOffset);
                    if (val === -32768) isImplemented = false;
                } else if (p.type === 'uint16' || p.type === 'enum16') {
                    const val = fullBuf.readUInt16BE(byteOffset);
                    if (val === 65535) isImplemented = false;
                } else if (p.type === 'int32' || p.type === 'sint32' || p.type === 'acc32') {
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
        // Enforce minimum effective timeout — values below this are unsafe on Tailscale paths
        const rawTimeout = parseInt(config.timeout) || CONST.DEFAULT_TIMEOUT;
        if (rawTimeout < CONST.MIN_EFFECTIVE_TIMEOUT) {
            node.warn(`Configured timeout ${rawTimeout}ms is below minimum ${CONST.MIN_EFFECTIVE_TIMEOUT}ms for Tailscale paths. Clamping up.`);
            node.timeout = CONST.MIN_EFFECTIVE_TIMEOUT;
        } else {
            node.timeout = rawTimeout;
        }
        node.unitId = parseInt(config.unitId);
        node.scanIds = config.scanIds;

        node.readMode = config.readMode || "scan";

        // Single param config
        node.selectedDevice = config.selectedDevice; // IP:ID
        // Support string models (e.g. sma_edmm)
        const parsedMid = parseInt(config.selectedModel);
        node.selectedModel = isNaN(parsedMid) ? config.selectedModel : parsedMid;
        node.selectedPoint = config.selectedPoint;
        node.selectedId = config.selectedId; // Explicit param ID

        // List config
        node.outputList = config.outputList || [];

        // Output formatting
        node.roundDecimals = config.roundDecimals !== undefined ? config.roundDecimals : true;

        // Pacing config with validation
        node.triggerMode = config.triggerMode || 'auto';

        let rawPacing = parseFloat(config.pacing);
        if (node.triggerMode === 'inject') {
            rawPacing = 0;
        } else if (!isNaN(rawPacing) && rawPacing > 0 && rawPacing < CONST.MIN_PACING_INTERVAL) {
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

        // Track last written value across restarts via persistent context
        // Without this, every restart causes a forced write on first pacing tick,
        // which triggers a deep scan that blocks the ConnectionManager queue for ~30s
        // and causes 3x consecutive write failures before the value actually lands.
        const writeValueKey = `lastWriteValue_${node.id}`;
        node.lastWriteValue = node.context().get(writeValueKey); // undefined if never written

        const modelsPath = path.join(__dirname, 'models', 'index.json');
        let models = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        // Core Scan Logic Reusable Function
        async function triggerScan(msg) {
            try {
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

                    // Parse selectedDevice: supports "IP:PORT:UNITID" or "IP:UNITID"
                    if (node.selectedDevice && node.selectedDevice.includes(":")) {
                        const parts = node.selectedDevice.split(':');
                        const id = parts.pop();   // Last part is always UNITID
                        if (parts.length > 1) parts.pop(); // Discard PORT if present
                        
                        const extractedIp = parts.join(':');
                        // Prevent the dropdown from permanently overriding a manually typed IP
                        if (!targetIp || targetIp.trim() === '' || targetIp === extractedIp) {
                            targetIp = extractedIp;
                        }
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

                            // Enrich Output with Metadata
                            const mDef = models[node.selectedModel];
                            if (mDef && mDef.group) {
                                // Model Label
                                msg.modelLabel = mDef.group.label || mDef.group.name;

                                // Point Metadata
                                const pDef = mDef.group.points.find(p => p.name === node.selectedPoint);
                                if (pDef) {
                                    msg.label = pDef.label || pDef.name; // Human readable name
                                    msg.name = pDef.name;                // Raw ID
                                    msg.units = pDef.units || "";
                                }
                            }

                            node.send(msg);

                            // Human Readable Status
                            // Clean up technical units (e.g., "%WHRtg" -> "%", "degC" -> "°C")
                            let displayUnits = msg.units || '';
                            if (displayUnits.startsWith('%')) displayUnits = '%';
                            if (displayUnits === 'degC') displayUnits = '°C';
                            if (displayUnits === 'degF') displayUnits = '°F';

                            const statusText = msg.label ? `${msg.label}: ${val}${displayUnits}` : `${node.selectedPoint}: ${val}`;
                            node.status({ fill: "green", shape: "dot", text: statusText.trim() });
                        } else {
                            node.status({ fill: "red", shape: "ring", text: "read failed" });
                        }

                    } catch (e) {
                        throw e;
                    }
                    return;
                }

                // --- MODE 0: Full Scan (Fallback) ---
                node.status({ fill: "blue", shape: "dot", text: "scanning..." });
                const results = {};
                let ips = discovery.parseIpRange(node.ip);
                for (const targetIp of ips) {
                    if (!await discovery.checkPort(targetIp, node.port)) continue;
                    const ids = node.scanIds ? await discovery.scanUnitIds(targetIp, node.port, node.timeout) : [node.unitId];
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
            } catch (err) {
                // Top-level error handler to prevent node crash
                // node.error(`Scan failed: ${err.message}`); // Handled by caller
                node.status({ fill: "red", shape: "ring", text: "scan error" });
                throw err; // Re-throw for retry logic to catch
            }
        }

        // --- Write Logic ---
        const executeWrite = async (msg) => {
            const models = global.globalModelDefinitions || {};
            const valueToWrite = msg.payload;


            node.status({ fill: "yellow", shape: "dot", text: `writing ${valueToWrite}...` });

            let targetId = node.unitId;
            let targetIp = node.ip;

            // Parse selectedDevice: supports "IP:PORT:UNITID" or "IP:UNITID"
            if (node.selectedDevice && node.selectedDevice.includes(":")) {
                const parts = node.selectedDevice.split(':');
                const id = parts.pop();   // Last part is always UNITID
                if (parts.length > 1) parts.pop(); // Discard PORT if present
                
                const extractedIp = parts.join(':');
                if (!targetIp || targetIp.trim() === '' || targetIp === extractedIp) {
                    targetIp = extractedIp;
                }
            }

            if (node.selectedId) {
                targetId = parseInt(node.selectedId);
            }

            if (!targetIp || isNaN(targetId)) {
                throw new Error("Invalid Target IP/ID for write");
            }

            await writeSinglePoint(node, models, targetIp, node.port, targetId, node.selectedModel, node.selectedPoint, valueToWrite, node.timeout);

            node.status({ fill: "green", shape: "dot", text: "write success" });
            node.send(msg);
        };

        // --- Unified Input Handler ---
        const handleInput = function (msg) {
            // Determine if this is a WRITE or READ
            // Rules:
            // 1. Must be in 'parameter' mode (Parameter Read/Write)
            // 2. msg.payload must define a value (not empty trigger)
            // 3. msg.payload !== undefined && msg.payload !== '' (strict check?)
            if (node.readMode === 'parameter' && msg.payload !== undefined && msg.payload !== '') {
                // Trigger WRITE
                executeWrite(msg).catch(err => {
                    // Suppress stack for timeouts
                    if (err.message.startsWith('Timeout')) {
                        node.warn(err.message);
                    } else {
                        node.error(`Write failed: ${err.message}`, msg);
                    }
                    node.status({ fill: "red", shape: "ring", text: "write error" });
                });
            } else {
                // Trigger READ (Default)
                triggerScan(msg).catch(err => {
                    // Suppress stack for timeouts
                    if (err.message.startsWith('Timeout')) {
                        node.warn(err.message);
                    } else {
                        node.error(`Input scan failed: ${err.message}`, msg);
                    }
                    node.status({ fill: "red", shape: "ring", text: "scan error" });
                });
            }
        };

        // Register Single Listener
        node.on('input', handleInput);

        // Interval Listener with retry logic
        let intervalId = null;
        let retryTimeoutId = null;

        // CRITICAL: Only enable auto-read if node is properly configured
        const isConfigured = () => {
            if (node.readMode === 'parameter') {
                // Must have valid device, model, and point
                return node.selectedModel && node.selectedPoint &&
                    (node.selectedDevice || (node.ip && !isNaN(node.unitId)));
            }
            if (node.readMode === 'list') {
                // Must have output list
                return node.outputList && node.outputList.length > 0;
            }
            // Scan mode requires explicit IP
            return node.ip && node.ip.trim() !== '';
        };

        if (node.pacing && node.pacing > 0 && isConfigured()) {
            node.log(`Auto-read enabled: ${node.pacing}s`);

            const executeRead = () => {
                triggerScan({})
                    .then(() => {
                        if (node.connectionState.consecutiveErrors > 0) {
                            node.log(`Auto-read recovered after ${node.connectionState.consecutiveErrors} failures`);
                        }
                        node.connectionState.consecutiveErrors = 0;
                        node.connectionState.lastSuccess = new Date();

                        if (!intervalId) {
                            intervalId = setInterval(executeRead, node.pacing * 1000);
                        }
                    })
                    .catch(err => {
                        node.connectionState.consecutiveErrors++;
                        node.connectionState.lastError = new Date();
                        node.error(`[SunSpec Auto-Read Error] ${node.name}: ${err.message}`);

                        // Exponential backoff (max 60s)
                        const delay = Math.min(
                            node.connectionState.retryDelay * Math.pow(2, node.connectionState.consecutiveErrors - 1),
                            CONST.MAX_RETRY_DELAY
                        );

                        node.status({ fill: "red", shape: "ring", text: `retrying (${node.connectionState.consecutiveErrors}x)...` });

                        if (intervalId) {
                            clearInterval(intervalId);
                            intervalId = null;
                        }

                        retryTimeoutId = setTimeout(() => {
                            retryTimeoutId = null;
                            executeRead();
                        }, delay);
                    });
            };

            // Staggered startup: spread initial connections across a 0-3s window.
            // Prevents all auto-read nodes from simultaneously connecting to the
            // gateway on a fresh Node-RED deploy, which can saturate its TCP stack.
            const startupJitter = Math.random() * 3000;
            retryTimeoutId = setTimeout(() => {
                retryTimeoutId = null;
                executeRead();
                intervalId = setInterval(executeRead, node.pacing * 1000);
            }, startupJitter);
        } else if (node.pacing > 0 && !isConfigured()) {
            node.warn('Auto-read disabled: Node configuration incomplete. Please configure device, model, and point.');
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

    // --- Write Functionality ---
    async function writeSinglePoint(node, models, ip, port, unitId, modelId, pointName, value, timeout) {
        return await connManager.request(ip, port, unitId, async (client) => {
            // Declared here (outside try) so catch block can reference it for error reporting
            let targetUnitId = unitId;

            try {
                // Look up Point Definition to check for Unit ID Override
                let pointDef = null;
                if (models[modelId] && models[modelId].group && models[modelId].group.points) {
                    pointDef = models[modelId].group.points.find(p => p.name === pointName);
                }

                // Handle Override or Default Unit ID
                if (pointDef && pointDef.unitId) targetUnitId = pointDef.unitId;

                // Client ID is set by connManager, but if override exists:
                // Allow targeting downstream inverters (>2) using the SMA EDMM model profile
                // without getting forcefully redirected to the gateway aggregate (ID 2).
                if (pointDef && pointDef.unitId) {
                    if (client.getID() <= 2) {
                        await client.setID(pointDef.unitId);
                    }
                }

                // 1. Resolve Model Address
                let modelAddr = -1;
                const cacheKey = `${ip}:${unitId}`; // Standardize cache key (removed :port to match read) or keep consistent? 
                // readSinglePoint uses `${ip}:${unitId}`. writeSinglePoint used `${ip}:${unitId}:${port}`? 
                // Let's stick to the one used in readSinglePoint for hits: `${ip}:${unitId}`.

                // SMA EDMM uses Absolute Addressing (Start = 0)
                if (modelId === 'sma_edmm' || modelId === 'conext_xw_503') {
                    modelAddr = 0;
                } else if (node.modelAddressCache[cacheKey] && node.modelAddressCache[cacheKey][modelId]) {
                    modelAddr = node.modelAddressCache[cacheKey][modelId];
                } else {
                    // Cache miss — must walk the SunSpec model chain (expensive: ~5-10 Modbus reads)
                    node.log(`[SunSpec] Cache miss for model ${modelId} on ${ip}:${unitId} — performing model walk`);
                    modelAddr = await sunspecClient.findModelHeader(client, modelId);

                    if (modelAddr !== -1) {
                        // Store the header address. All model JSON definitions include ID and L
                        // as the first two points (offsets 0+1), so fetchPointValue's running
                        // offset total naturally skips them: headerAddr + pointOffset is correct.
                        if (!node.modelAddressCache[cacheKey]) node.modelAddressCache[cacheKey] = {};
                        node.modelAddressCache[cacheKey][modelId] = modelAddr;
                        // Persist
                        const persistKey = `modelAddressCache_${node.id}`;
                        node.context().set(persistKey, node.modelAddressCache);
                    }
                }

                if (modelAddr === -1) {
                    throw new Error(`Model ${modelId} not found on device`);
                }

                // 2-5. Resolve definition, apply reverse scaling, encode + write.
                //      All addressing/encoding lives in the protocol module so the
                //      write target matches what reads use (header + point offset).
                if (!models[modelId]) throw new Error(`Model definition for ${modelId} missing`);
                if (!pointDef) throw new Error(`Point ${pointName} not found in model`);

                const finalAddr = modelAddr + sunspecClient.pointOffset(models[modelId], pointName);
                await sunspecClient.writePoint(client, models[modelId], modelAddr, pointName, value);

                if (node.lastWriteValue !== value) {
                    node.warn(`[SunSpec State Change] WRITING: ${modelId}:${pointName} at ${ip}:${targetUnitId} switched from ${node.lastWriteValue} to ${value}`);
                    node.lastWriteValue = value;
                    // Persist across restarts so next startup skips the forced re-write
                    const writeValueKey = `lastWriteValue_${node.id}`;
                    node.context().set(writeValueKey, value);
                } else {
                    node.log(`[SunSpec Write] Success: Wrote ${value} to ${modelId}:${pointName} (@${finalAddr})`);
                }

                return true;

            } catch (err) {
                // Enrich error message
                const isTimeout = err.message.toLowerCase().includes('time') || err.code === 'ETIMEDOUT';
                if (isTimeout) {
                    connManager.reportError(ip, port, targetUnitId, err);
                    throw new Error(`Timeout: Device ${ip}:${unitId} did not respond to write request.`);
                }

                if (err.message && (err.message.includes('Slave device failure') || err.message.includes('Gateway target device failed'))) {
                    connManager.reportError(ip, port, targetUnitId, err);
                }

                throw new Error(`Write failed: ${err.message} (${ip}:${unitId} Model=${modelId} Point=${pointName})`);
            }
        }, timeout);
    }
    // --- Optimized Multi-Read ---
    // Routes through ConnectionManager to prevent TCP socket collisions with
    // concurrent single-read or write operations on the same device.
    // --- Optimized Multi-Read (Custom List mode) ---
    // Routes through ConnectionManager to avoid TCP socket collisions, and uses
    // the unified protocol module so addressing + rounding match the single-read
    // path exactly. (Previously this used the model DATA address (header+2) while
    // fetchPointValue's offsets already include the header -> every list value
    // was read 2 registers too high.)
    async function readMultiplePoints(node, models, ip, port, unitId, items, timeout) {
        return await connManager.request(ip, port, unitId, async (client) => {
            const modelMap = await sunspecClient.walkModels(client);

            const results = [];
            for (const item of items) {
                const mid = parseInt(item.model);
                const entry = modelMap[mid];
                if (!entry) {
                    results.push({ index: item.originalIndex, value: null });
                    continue;
                }
                // Pass the HEADER address and `node` (for roundDecimals).
                const val = await fetchPointValue(client, models, mid, entry.header, item.point, node);
                results.push({ index: item.originalIndex, value: val });
            }
            return results;
        }, timeout);
    }

    // Reads + decodes a single point via the unified protocol module.
    // `modelAddr` is the model HEADER address (see sunspec-client.js).
    async function fetchPointValue(client, models, modelId, modelAddr, pointName, node) {
        const model = models[modelId];
        if (!model) return null;
        return sunspecClient.readPoint(client, model, modelAddr, pointName, {
            round: !!(node && node.roundDecimals),
        });
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
        return await connManager.request(ip, port, unitId, async (client) => {
            try {
                // Look up Point Definition
                let pointDef = null;
                if (models[modelId] && models[modelId].group && models[modelId].group.points) {
                    pointDef = models[modelId].group.points.find(p => p.name === pointName);
                }

                // Handle Override or Default Unit ID (Note: client ID is already set by connManager)
                // However, internal logic of fetchPointValue assumes it can use the client logic
                // Double check target ID if overridden by pointDef
                // Allow targeting downstream inverters (>2) using the SMA EDMM model profile
                if (pointDef && pointDef.unitId) {
                    if (client.getID() <= 2) {
                        await client.setID(pointDef.unitId);
                    }
                }

                const cacheKey = `${ip}:${unitId}`;
                let modelAddr = -1;

                // Address Caching Logic
                // Model JSON definitions include ID and L as the first two points (offsets 0+1).
                // The offset accumulation in fetchPointValue naturally accounts for them, so
                // headerAddr + pointOffset correctly resolves to the right register without
                // needing a manual +2 adjustment.
                if (modelId === 'sma_edmm' || modelId === 'conext_xw_503') {
                    modelAddr = 0;
                } else if (node.modelAddressCache[cacheKey] && node.modelAddressCache[cacheKey][modelId]) {
                    modelAddr = node.modelAddressCache[cacheKey][modelId];
                } else {
                    // Cache miss: store the header address returned by findModelAddress.
                    modelAddr = await sunspecClient.findModelHeader(client, modelId);
                    if (modelAddr !== -1) {
                        if (!node.modelAddressCache[cacheKey]) node.modelAddressCache[cacheKey] = {};
                        node.modelAddressCache[cacheKey][modelId] = modelAddr;
                        const persistKey = `modelAddressCache_${node.id}`;
                        node.context().set(persistKey, node.modelAddressCache);
                    }
                }

                if (modelAddr === -1) {
                    throw new errors.SunSpecModelNotFoundError(modelId, `${ip}:${unitId}`);
                }

                const result = await fetchPointValue(client, models, modelId, modelAddr, pointName, node);

                if (node.connectionState) {
                    node.connectionState.lastSuccess = new Date();
                }

                return result;

            } catch (e) {
                if (e instanceof errors.SunSpecModelNotFoundError) {
                    throw e;
                }

                // Classify Error
                const isTimeout = e.message.toLowerCase().includes('time') || e.code === 'ETIMEDOUT';

                if (isTimeout) {
                    connManager.reportError(ip, port, unitId, e);
                    throw new Error(`Timeout: Device ${ip}:${unitId} did not respond to read request.`);
                }

                if (e.message && (e.message.includes('Slave device failure') || e.message.includes('Gateway target device failed') || e.message.includes('Transaction timed out'))) {
                    connManager.reportError(ip, port, unitId, e);
                }

                // Generic Error with Context
                const errorMsg = `Read failed: ${e.message} (${ip}:${port} ID=${unitId} Model=${modelId} Point=${pointName})`;
                if (node.connectionState) node.connectionState.lastError = new Date();
                throw new Error(errorMsg);
            }
        }, timeout);
    }

    // Reads the full model chain for a device, routed through the shared
    // ConnectionManager (no raw socket) so it can't collide with runtime reads.
    // NOTE: the previous version built `deviceMap` but never returned it, so
    // Mode 0 (full scan) always resolved to undefined and produced empty results.
    async function readSunSpecDevice(ip, port, unitId, models, node) {
        try {
            return await connManager.request(ip, port, unitId, async (client) => {
                const modelMap = await sunspecClient.walkModels(client);
                if (Object.keys(modelMap).length === 0) return null;

                const deviceMap = {};
                for (const midStr of Object.keys(modelMap)) {
                    const mid = parseInt(midStr);
                    const { header, len } = modelMap[midStr];
                    const content = await client.readHoldingRegisters(header + 2, len);
                    const decoded = { id: mid, length: len, raw: content.data };
                    if (models[mid] && models[mid].group) {
                        decoded.name = models[mid].group.label || models[mid].group.name;
                    }
                    deviceMap[mid] = decoded;
                }
                return deviceMap;
            }, (node && node.timeout) || 5000);
        } catch (e) {
            return null;
        }
    }

    RED.nodes.registerType("sunspec-scan", SunSpecScanNode);

    // Initialize Models
    loadModels(RED);
}

// Global Model Loader
function loadModels(RED) {
    if (global.globalModelDefinitions) return; // Already loaded

    const fs = require('fs-extra');
    const path = require('path');
    const modelsPath = path.join(__dirname, 'models', 'index.json');

    try {
        console.log("[SunSpec] Loading SunSpec models...");
        const models = fs.readJsonSync(modelsPath);
        global.globalModelDefinitions = models;
        console.log(`[SunSpec] Loaded ${Object.keys(models).length} models into global cache.`);
    } catch (e) {
        console.error("[SunSpec] Failed to load models:", e.message);
        global.globalModelDefinitions = {};
    }
}
