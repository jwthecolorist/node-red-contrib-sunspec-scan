
import { Node, NodeAPI, NodeDef, NodeMessage } from "node-red";
import ModbusRTU from "modbus-serial";
import fs from 'fs-extra';
import path from 'path';
import ConnectionManager from './connection-manager';
import * as discovery from './discovery';
import * as CONST from './constants';
import * as utils from './utils';
import * as errors from './errors';
import DeviceManager from './device-manager';

interface SunSpecNodeConfig extends NodeDef {
    ip: string;
    port: string;
    timeout: string;
    unitId: string;
    scanIds?: boolean;
    readMode?: 'scan' | 'parameter' | 'list';
    selectedDevice?: string;
    selectedModel?: string;
    selectedPoint?: string;
    selectedId?: string;
    outputList?: any[];
    roundDecimals?: boolean;
    pacing?: string;
}

interface SunSpecNode extends Node {
    ip: string;
    port: number;
    timeout: number;
    unitId: number;
    scanIds: boolean;
    readMode: 'scan' | 'parameter' | 'list';
    selectedDevice?: string;
    selectedModel: string | number;
    selectedPoint?: string;
    selectedId?: string;
    outputList: any[];
    roundDecimals: boolean;
    pacing: number;
    modelAddressCache: Record<string, Record<string, number>>;
    connectionState: {
        lastSuccess: Date | null;
        lastError: Date | null;
        consecutiveErrors: number;
        retryDelay: number;
    };
}

export = function (RED: NodeAPI) {
    const connManager = new ConnectionManager();
    const deviceManager = new DeviceManager(RED.settings.userDir);

    // --- Admin API ---
    RED.httpAdmin.get('/sunspec-scan/devices', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(deviceManager.list());
    });

    RED.httpAdmin.post('/sunspec-scan/devices', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        try {
            const dev = deviceManager.add(req.body);
            res.json(dev);
        } catch (e: any) { res.status(400).send(e.message); }
    });

    RED.httpAdmin.put('/sunspec-scan/devices/:id', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        try {
            const dev = deviceManager.update(req.params.id as string, req.body);
            res.json(dev);
        } catch (e: any) { res.status(400).send(e.message); }
    });

    RED.httpAdmin.delete('/sunspec-scan/devices/:id', RED.auth.needsPermission('sunspec-scan.write'), function (req, res) {
        const success = deviceManager.delete(req.params.id as string);
        if (success) res.sendStatus(200);
        else res.sendStatus(404);
    });

    RED.httpAdmin.get('/sunspec-scan/models', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        const modelsPath = path.join(__dirname, '..', 'models', 'index.json');
        try {
            const models = fs.readJsonSync(modelsPath);
            res.json(models);
        } catch (e) {
            res.status(500).send("Models not found");
        }
    });

    // Global scan state
    let activeScan: { stop: boolean, status?: string } = {
        stop: false
    };

    let networkMap: Record<string, any> = {};
    const userDir = RED.settings.userDir || __dirname; // Fallback to avoid undefined error
    const cachePath = path.join(userDir, 'sunspec-cache.json');

    function saveNetworkMap() {
        try {
            fs.writeJsonSync(cachePath, networkMap, { spaces: 2 });
        } catch (e: any) {
            console.error("[SunSpec] Failed to save scan cache:", e.message);
        }
    }

    function loadNetworkMap() {
        try {
            if (fs.existsSync(cachePath)) {
                networkMap = fs.readJsonSync(cachePath);
                console.log(`[SunSpec] Loaded scan cache from disk (${Object.keys(networkMap).length} devices).`);
            }
        } catch (e: any) {
            console.error("[SunSpec] Failed to load scan cache:", e.message);
            networkMap = {};
        }
    }

    loadNetworkMap();

    RED.httpAdmin.post('/sunspec-scan/stop', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        activeScan.stop = true;
        res.status(200).send("Stopping");
    });

    RED.httpAdmin.get('/sunspec-scan/status', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(activeScan);
    });

    RED.httpAdmin.get('/sunspec-scan/network', RED.auth.needsPermission('sunspec-scan.read'), function (req, res) {
        res.json(networkMap);
    });

    RED.httpAdmin.post('/sunspec-scan/discover', RED.auth.needsPermission('sunspec-scan.read'), async function (req, res) {
        const config = req.body;
        const results: Record<string, any> = {};

        const modelsPath = path.join(__dirname, '..', 'models', 'index.json');
        let models: any = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        activeScan.stop = false;

        try {
            const ips = discovery.parseIpRange(config.ip || "");
            const port = parseInt(config.port) || CONST.DEFAULT_MODBUS_PORT;
            const timeout = parseInt(config.timeout) || CONST.DEFAULT_TIMEOUT;
            const unitIdStr = config.unitId ? String(config.unitId).trim() : "";

            const idsToScan = utils.parseUnitIds(unitIdStr) || undefined;

            for (const targetIp of ips) {
                if (activeScan.stop) break;

                activeScan.status = `Checking ${targetIp}:${port}...`;
                if (!await discovery.checkPort(targetIp, port, CONST.DEFAULT_PORT_CHECK_TIMEOUT)) continue;

                console.log(`[SunSpec] Scanning ${targetIp} Unit IDs... Targets: ${idsToScan ? idsToScan.join(',') : 'ALL'}`);
                const t0 = Date.now();
                const ids = await discovery.scanUnitIds(targetIp, port, timeout, undefined, idsToScan, () => activeScan.stop);
                console.log(`[SunSpec] IDS Scanned in ${Date.now() - t0}ms. Found: ${ids.map(i => i.id)}`);

                if (ids.length > 0) {
                    results[targetIp] = {};
                    for (const idObj of ids) {
                        if (activeScan.stop) break;
                        const id = idObj.id;
                        const type = idObj.type;

                        activeScan.status = `Reading Model Data from ${targetIp}:${id}...`;

                        console.log(`[SunSpec] Reading Identity (${type}) for ${targetIp}:${id}...`);
                        const t1 = Date.now();
                        const modelsFound = await scanDeviceModelsOnly(targetIp, port, id, models, timeout, true, type);
                        console.log(`[SunSpec] Identity Read in ${Date.now() - t1}ms for ID ${id}`);

                        results[targetIp][id] = modelsFound;

                        const deviceKey = `${targetIp}:${port}`;
                        if (!networkMap[deviceKey]) networkMap[deviceKey] = {};
                        networkMap[deviceKey][id] = modelsFound;
                        saveNetworkMap();

                        try {
                            let name = "";
                            if (modelsFound && modelsFound.info) {
                                const mn = modelsFound.info.Mn || "";
                                const md = modelsFound.info.Md || "";
                                if (mn || md) name = `${mn} ${md}`.trim();
                            }
                            deviceManager.upsert({
                                ip: targetIp,
                                port: port,
                                unitId: id,
                                name: name || undefined
                            });
                        } catch (e: any) { console.error("[SunSpec] Auto-save error:", e.message); }
                    }
                }
            }
            activeScan.status = "Scan Complete";
            res.json(results);
        } catch (e: any) {
            console.error(e);
            res.status(500).send(e.message);
        }
    });

    RED.httpAdmin.post('/sunspec-scan/scan-models', RED.auth.needsPermission('sunspec-scan.read'), async function (req, res) {
        const config = req.body;
        const modelsPath = path.join(__dirname, '..', 'models', 'index.json');
        let models: any = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        const ip = config.ip;
        const port = parseInt(config.port) || 502;
        const unitId = parseInt(config.unitId);
        const timeout = parseInt(config.timeout) || 2000;

        if (!ip || isNaN(unitId)) {
            res.status(400).send("Invalid IP or Unit ID");
            return;
        }

        const deviceKey = (port === 502) ? ip : `${ip}:${port}`;

        if (networkMap[deviceKey] && networkMap[deviceKey][unitId]) {
            const cached = networkMap[deviceKey][unitId];
            if (Object.keys(cached).length > 2) {
                res.json(cached);
                return;
            }
        }

        try {
            console.log(`[SunSpec] Deep Scanning Models for ${ip}:${port}:${unitId}...`);

            let type: string | null = null;
            if (port === 503) type = 'conext_xw_503';

            const modelsFound = await scanDeviceModelsOnly(ip, port, unitId, models, timeout, false, type);

            if (!networkMap[deviceKey]) networkMap[deviceKey] = {};
            networkMap[deviceKey][unitId] = modelsFound;
            
            // Only save if we found something useful
            if (Object.keys(modelsFound).length > 0) {
                 saveNetworkMap();
            }

            res.json(modelsFound);
        } catch (e: any) {
            res.status(500).send(e.message);
        }
    });

    async function scanDeviceModelsOnly(ip: string, port: number, unitId: number, models: any, timeout: number, fastMode: boolean, type: string | null | undefined): Promise<any> {
        if (type === 'sma_edmm') {
            return {
                'sma_edmm': { start: 0, len: 0 },
                'info': { Mn: 'SMA', Md: 'Data Manager' }
            };
        }

        if (type === 'conext_xw_503') {
            return {
                'conext_xw_503': { start: 0, len: 0 },
                'info': { Mn: 'Schneider', Md: 'Conext XW (503)' }
            };
        }

        const client = new ModbusRTU();
        const foundModels: any = {};
        try {
            await client.connectTCP(ip, { port: port });
            client.setID(unitId);
            client.setTimeout(timeout || 2000);

            let baseAddr = 40000;
            try {
                let data = await client.readHoldingRegisters(baseAddr, 2);
                if (data.data[0] === 0x5375) baseAddr = 40002;
                else {
                    try {
                        const smaData = await client.readHoldingRegisters(30051, 2);
                        const smaVal = (smaData.data[0] << 16) | smaData.data[1];
                        if (smaVal === 8128 || smaVal === 9397 || smaVal === 19135) {
                             console.log(`[SunSpec] Fallback: Detected SMA Device at ${ip}:${unitId} during scan.`);
                             return {
                                 'sma_edmm': { start: 0, len: 0 },
                                 'info': { Mn: 'SMA', Md: 'Data Manager' }
                             };
                        }
                    } catch (e2) {}
                    return {};
                }
            } catch (e) {
                 try {
                     const smaData = await client.readHoldingRegisters(30051, 2);
                     const smaVal = (smaData.data[0] << 16) | smaData.data[1];
                     if (smaVal === 8128 || smaVal === 9397 || smaVal === 19135) {
                         console.log(`[SunSpec] Fallback: Detected SMA Device at ${ip}:${unitId} during scan (after SunSpec fail).`);
                         return {
                             'sma_edmm': { start: 0, len: 0 },
                             'info': { Mn: 'SMA', Md: 'Data Manager' }
                         };
                     }
                 } catch (e3) { }
                 return {};
            }

            let addr = baseAddr;
            while (true) {
                const head = await client.readHoldingRegisters(addr, 2);
                const mid = head.data[0];
                const len = head.data[1];

                if (mid === 0xFFFF) break;

                foundModels[mid] = { start: addr, len: len };

                if (models && models[mid]) {
                    try {
                        const implementedPoints = await scanImplementedPoints(client, models, mid, addr, len);
                        foundModels[mid].implementedPoints = implementedPoints;
                    } catch (e: any) {
                        console.log(`Error scanning points for model ${mid}:`, e.message);
                    }
                }

                if (mid === 1 && models) {
                    try {
                        // Pass null for node here as we don't have it in context, but readSinglePoint handles it
                        const mn = await fetchPointValue(client, models, 1, addr, 'Mn', null);
                        const md = await fetchPointValue(client, models, 1, addr, 'Md', null);
                        const sn = await fetchPointValue(client, models, 1, addr, 'SN', null);
                        foundModels.info = {
                            Mn: mn,
                            Md: md,
                            SN: sn
                        };
                    } catch (e) { console.log("Meta read error", e); }

                    if (fastMode) break;
                }

                addr += 2 + len;
            }
        } catch (e) { console.log("Scan Model Error", e); } finally {
            client.close();
        }
        return foundModels;
    }

    async function scanImplementedPoints(client: ModbusRTU, models: any, modelId: number, modelAddr: number, modelLen: number) {
        const mDef = models[modelId];
        if (!mDef || !mDef.group || !mDef.group.points) return [];

        const implementedPoints: string[] = [];
        const points = mDef.group.points;
        const totalLen = modelLen || mDef.group.len || 0;

        if (!totalLen) return [];

        try {
            const safeLen = Math.min(totalLen, 120);
            const valBlock = await client.readHoldingRegisters(modelAddr, safeLen);
            const fullBuf = valBlock.buffer;

            let offset = 0;

            for (const p of points) {
                let size = p.size || 1;
                if (!p.size) {
                    if (p.type.includes('32')) size = 2;
                    if (p.type.includes('64')) size = 4;
                    if (p.type === 'sunssf') size = 1;
                }

                if (offset + size > safeLen) {
                    offset += size;
                    continue;
                }

                if (p.type === 'pad' || p.type === 'sunssf') {
                    offset += size;
                    continue;
                }

                let isImplemented = true;
                const byteOffset = offset * 2;

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
        } catch (e: any) {
            console.log(`Block scan failed for Model ${modelId}: ${e.message} `);
            return [];
        }
        return implementedPoints;
    }

    function SunSpecScanNode(this: SunSpecNode, config: SunSpecNodeConfig) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.ip = config.ip || "";
        node.port = parseInt(config.port) || CONST.DEFAULT_MODBUS_PORT;
        node.timeout = parseInt(config.timeout) || CONST.DEFAULT_TIMEOUT;
        node.unitId = parseInt(config.unitId);
        node.scanIds = config.scanIds || false;

        node.readMode = config.readMode || "scan";

        node.selectedDevice = config.selectedDevice;
        const parsedMid = parseInt(config.selectedModel || "");
        node.selectedModel = isNaN(parsedMid) ? (config.selectedModel || "") : parsedMid;
        node.selectedPoint = config.selectedPoint;
        node.selectedId = config.selectedId;

        node.outputList = config.outputList || [];
        node.roundDecimals = config.roundDecimals !== undefined ? config.roundDecimals : true;

        let rawPacing = parseFloat(config.pacing || "0");
        if (!isNaN(rawPacing) && rawPacing > 0 && rawPacing < CONST.MIN_PACING_INTERVAL) {
            node.warn(`Auto-read interval ${rawPacing}s is too fast. Enforcing minimum ${CONST.MIN_PACING_INTERVAL}s.`);
            rawPacing = CONST.MIN_PACING_INTERVAL;
        }
        node.pacing = rawPacing;

        const cacheKey = `modelAddressCache_${node.id}`;
        node.modelAddressCache = node.context().get(cacheKey) as Record<string, Record<string, number>> || {};

        node.connectionState = {
            lastSuccess: null,
            lastError: null,
            consecutiveErrors: 0,
            retryDelay: CONST.BASE_RETRY_DELAY
        };

        const modelsPath = path.join(__dirname, '..', 'models', 'index.json');
        let models: any = {};
        try { models = fs.readJsonSync(modelsPath); } catch (e) { }

        async function triggerScan(msg: NodeMessage) {
            try {
                msg = msg || {};

                if (node.readMode === 'list' && node.outputList.length > 0) {
                    node.status({ fill: "blue", shape: "dot", text: `reading ${node.outputList.length} items...` });

                    const groups: Record<string, any[]> = {};
                    node.outputList.forEach((item, index) => {
                        const key = `${item.device}:${item.id}`;
                        if (!groups[key]) groups[key] = [];
                        groups[key].push({ ...item, originalIndex: index });
                    });

                    const finalArray = new Array(node.outputList.length).fill(null);

                    for (const key in groups) {
                        const [ip, idStr] = key.split(':');
                        const id = parseInt(idStr);
                        const items = groups[key];

                        try {
                            const values = await readMultiplePoints(node, models, ip, node.port || 502, id, items, node.timeout);
                            values.forEach((v: any) => {
                                finalArray[v.index] = v.value;
                            });
                        } catch (e: any) {
                            node.error(`List Read Error ${key}: ${e.message}`);
                        }
                    }

                    msg.payload = finalArray;
                    node.send(msg);
                    node.status({ fill: "green", shape: "dot", text: "read complete" });
                    return;
                }

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

                            const mDef = models[node.selectedModel];
                            if (mDef && mDef.group) {
                                (msg as any).modelLabel = mDef.group.label || mDef.group.name;
                                const pDef = mDef.group.points.find((p: any) => p.name === node.selectedPoint);
                                if (pDef) {
                                    (msg as any).label = pDef.label || pDef.name;
                                    (msg as any).name = pDef.name;
                                    (msg as any).units = pDef.units || "";
                                }
                            }

                            node.send(msg);
                            
                            let displayUnits = (msg as any).units || '';
                            if (displayUnits.startsWith('%')) displayUnits = '%';
                            if (displayUnits === 'degC') displayUnits = '°C';
                            if (displayUnits === 'degF') displayUnits = '°F';
                            
                            const statusText = (msg as any).label ? `${(msg as any).label}: ${val}${displayUnits}` : `${node.selectedPoint}: ${val}`;
                            node.status({ fill: "green", shape: "dot", text: statusText.trim() });
                        } else {
                            node.status({ fill: "red", shape: "ring", text: "read failed" });
                        }

                    } catch (e) {
                         throw e;
                    }
                    return;
                }

                node.status({ fill: "blue", shape: "dot", text: "scanning..." });
                const results: any = {};
                let ips = discovery.parseIpRange(node.ip);
                for (const targetIp of ips) {
                    if (!await discovery.checkPort(targetIp, node.port)) continue;
                    const ids = node.scanIds ? await discovery.scanUnitIds(targetIp, node.port, node.timeout) : [{id: node.unitId, type: 'sunspec'}];
                    for (const idObj of ids as any[]) {
                         // Simplify: if scanIds is false, ids is just mock, need proper handling
                         // If discovery returns ScanResult[], idObj is {id, type}
                         const id = (typeof idObj === 'object') ? idObj.id : idObj;
                         
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
            } catch (err: any) {
                node.status({ fill: "red", shape: "ring", text: "scan error" });
                throw err;
            }
        }

        node.on('input', function (msg: any) {
            triggerScan(msg);
        });

        let intervalId: NodeJS.Timeout | null = null;
        let retryTimeoutId: NodeJS.Timeout | null = null;

        const isConfigured = () => {
            if (node.readMode === 'parameter') {
                return !!(node.selectedModel && node.selectedPoint &&
                    (node.selectedDevice || (node.ip && !isNaN(node.unitId))));
            }
            if (node.readMode === 'list') {
                return node.outputList && node.outputList.length > 0;
            }
            return !!(node.ip && node.ip.trim() !== '');
        };

        if (node.pacing && node.pacing > 0 && isConfigured()) {
            node.log(`Auto-read enabled: ${node.pacing}s`);

            // Infinite Retry with Capped Backoff Strategy
            const executeRead = () => {
                triggerScan({} as NodeMessage)
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

                        // Exponential backoff (max 60s)
                        const delay = Math.min(
                            node.connectionState.retryDelay * Math.pow(2, node.connectionState.consecutiveErrors - 1),
                            60000 // Cap at 60s
                        );

                        node.status({ fill: "red", shape: "ring", text: `retrying (${node.connectionState.consecutiveErrors}x)...` });

                        if (intervalId) {
                            clearInterval(intervalId);
                            intervalId = null;
                        }

                        // Schedule retry (Infinite)
                        retryTimeoutId = setTimeout(() => {
                            retryTimeoutId = null;
                            executeRead();
                        }, delay);
                    });
            };

            node.on('input', function (msg: any) {
                if (node.readMode === 'parameter' && msg.payload !== undefined && msg.payload !== '') {
                    executeWrite(msg).catch(err => {
                        if (err.message.startsWith('Timeout')) {
                            node.warn(err.message);
                        } else {
                            node.error(`Write failed: ${err.message}`, msg);
                        }
                        node.status({ fill: "red", shape: "ring", text: "write error" });
                    });
                } else {
                    triggerScan(msg).catch(err => {
                        if (err.message.startsWith('Timeout')) {
                            node.warn(err.message);
                        } else {
                            node.error(`Input scan failed: ${err.message}`, msg);
                        }
                        node.status({ fill: "red", shape: "ring", text: "scan error" });
                    });
                }
            });

            const executeWrite = async (msg: any) => {
                // Warning: referencing global from TS might need declaration
                const models = (global as any).globalModelDefinitions || {};
                const valueToWrite = msg.payload;

                node.status({ fill: "yellow", shape: "dot", text: `writing ${valueToWrite}...` });

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
                    throw new Error("Invalid Target IP/ID for write");
                }

                await writeSinglePoint(node, models, targetIp, node.port, targetId, node.selectedModel, node.selectedPoint, valueToWrite, node.timeout);

                node.status({ fill: "green", shape: "dot", text: "write success" });
                node.send(msg);
            };

            executeRead();

            intervalId = setInterval(executeRead, node.pacing * 1000);
        } else if (node.pacing > 0 && !isConfigured()) {
            node.warn('Auto-read disabled: Node configuration incomplete. Please configure device, model, and point.');
        }

        node.on('close', function (done: () => void) {
            if (intervalId) clearInterval(intervalId);
            if (retryTimeoutId) clearTimeout(retryTimeoutId);
            done();
        });
    }

    async function writeSinglePoint(node: SunSpecNode, models: any, ip: string, port: number, unitId: number, modelId: string | number, pointName: string | undefined, value: any, timeout: number) {
        return await connManager.request(ip, port, unitId, async (client: any) => {
            try {
                let pointDef = null;
                const mid = modelId;
                
                if (models[mid] && models[mid].group && models[mid].group.points) {
                    pointDef = models[mid].group.points.find((p: any) => p.name === pointName);
                }

                if (pointDef && pointDef.unitId) {
                    await client.setID(pointDef.unitId);
                }

                let modelAddr = -1;
                const cacheKey = `${ip}:${unitId}`;

                if (modelId === 'sma_edmm' || modelId === 'conext_xw_503') {
                    modelAddr = 0;
                } else if (node.modelAddressCache[cacheKey] && node.modelAddressCache[cacheKey][modelId.toString()]) {
                    modelAddr = node.modelAddressCache[cacheKey][modelId.toString()];
                } else {
                    modelAddr = await utils.findModelAddress(client, modelId);
                    if (modelAddr !== -1) {
                        if (!node.modelAddressCache[cacheKey]) node.modelAddressCache[cacheKey] = {};
                        node.modelAddressCache[cacheKey][modelId.toString()] = modelAddr;
                        const persistKey = `modelAddressCache_${node.id}`;
                        node.context().set(persistKey, node.modelAddressCache);
                    }
                }

                if (modelAddr === -1) {
                    throw new Error(`Model ${modelId} not found on device`);
                }

                if (!models[mid]) throw new Error(`Model definition for ${modelId} missing`);
                const modelDef = models[mid].group;
                if (!pointDef) throw new Error(`Point ${pointName} not found in model`);

                let pointOffset = 0;
                if (pointDef.offset !== undefined) {
                    pointOffset = pointDef.offset;
                } else {
                    for (const p of modelDef.points) {
                        if (p.name === pointName) break;
                        let size = p.size || 1;
                        if (!p.size) {
                            if (p.type.includes('32')) size = 2;
                            if (p.type.includes('64')) size = 4;
                            if (p.type === 'sunssf') size = 1;
                        }
                        pointOffset += size;
                    }
                }

                let val = value;
                if (pointDef.staticScale) {
                    val = val / pointDef.staticScale;
                }

                val = Math.round(val);

                let buffer;
                const type = pointDef.type;

                if (type === 'uint16' || type === 'enum16' || type === 'bitfield16') {
                    buffer = Buffer.alloc(2);
                    buffer.writeUInt16BE(val);
                } else if (type === 'int16' || type === 'sint16') {
                    buffer = Buffer.alloc(2);
                    buffer.writeInt16BE(val);
                } else if (type === 'uint32') {
                    buffer = Buffer.alloc(4);
                    buffer.writeUInt32BE(val);
                } else if (type === 'int32' || type === 'sint32') {
                    buffer = Buffer.alloc(4);
                    buffer.writeInt32BE(val);
                } else {
                    throw new Error(`Write not supported for type: ${type}`);
                }

                const finalAddr = modelAddr + pointOffset;
                await client.writeRegisters(finalAddr, buffer);
                node.warn(`[SunSpec Write] Success: Wrote ${value} to ${modelId}:${pointName} (@${finalAddr})`);
                return true;

            } catch (err: any) {
                const isTimeout = err.message.toLowerCase().includes('time') || err.code === 'ETIMEDOUT';
                if (isTimeout) {
                    throw new Error(`Timeout: Device ${ip}:${unitId} did not respond to write request.`);
                }
                throw new Error(`Write failed: ${err.message} (${ip}:${unitId} Model=${modelId} Point=${pointName})`);
            }
        }, timeout);
    }

    async function readMultiplePoints(node: SunSpecNode, models: any, ip: string, port: number, unitId: number, items: any[], timeout: number) {
        const client = new ModbusRTU();
        const results: any[] = [];

        try {
            await client.connectTCP(ip, { port: port });
            client.setID(unitId);
            client.setTimeout(timeout || 2000);

            let base = 40002;
            try {
                let m = await client.readHoldingRegisters(40000, 2);
                if (m.data[0] === 0x5375) base = 40002;
            } catch (e) { }

            const modelAddresses: Record<string, number> = {};

            let addr = base;
            while (true) {
                let h = await client.readHoldingRegisters(addr, 2);
                if (h.data[0] === 0xFFFF) break;
                if (!modelAddresses[h.data[0]]) {
                    modelAddresses[h.data[0]] = addr + 2;
                }
                addr += 2 + h.data[1];
            }

            for (const item of items) {
                const mid = item.model;
                const mAddr = modelAddresses[mid];

                if (!mAddr) {
                    results.push({ index: item.originalIndex, value: null });
                    continue;
                }

                const val = await fetchPointValue(client, models, mid, mAddr, item.point, node);
                results.push({ index: item.originalIndex, value: val });
            }

            return results;

        } catch (e) {
            throw e;
        } finally {
            client.close();
        }
    }

    async function fetchPointValue(client: any, models: any, modelId: string | number, modelAddr: number, pointName: string, node: SunSpecNode | null) {
        const mDef = models[modelId];
        if (!mDef) return null;

        const points = mDef.group.points;
        const pointDef = points.find((p: any) => p.name === pointName);
        if (!pointDef) return null;

        let offset = 0;
        if (pointDef.offset !== undefined) {
            offset = pointDef.offset;
        } else {
            for (const p of points) {
                if (p.name === pointName) break;
                let size = p.size || 1;
                if (!p.size) {
                    if (p.type.includes('32')) size = 2;
                    if (p.type.includes('64')) size = 4;
                    if (p.type === 'sunssf') size = 1;
                }
                offset += size;
            }
        }

        let size = pointDef.size || 1;
        if (!pointDef.size) {
            if (pointDef.type.includes('32')) size = 2;
            if (pointDef.type.includes('64')) size = 4;
            if (pointDef.type === 'sunssf') size = 1;
        }

        const valBlock = await client.readHoldingRegisters(modelAddr + offset, size);

        let raw: any = 0;
        const buf = valBlock.buffer;

        if (pointDef.type === 'int16') {
            raw = buf.readInt16BE(0);
            if (raw === -32768) return null;
        }
        else if (pointDef.type === 'uint16' || pointDef.type === 'enum16') {
            raw = buf.readUInt16BE(0);
            if (raw === 65535) return null;
        }
        else if (pointDef.type === 'int32') {
            raw = buf.readInt32BE(0);
            if (raw === -2147483648) return null;
        }
        else if (pointDef.type === 'uint32') {
            raw = buf.readUInt32BE(0);
            if (raw === 4294967295) return null;
        }
        else if (pointDef.type === 'sunssf') {
            raw = buf.readInt16BE(0);
            if (raw === -32768) return null;
        }
        else if (pointDef.type === 'string') {
            let s = buf.toString();
            raw = s.replace(/[^a-zA-Z0-9\-\.\_ ]/g, '').trim();
        }
        else {
            raw = buf.readUInt16BE(0);
        }

        let val = raw;
        if (typeof val === 'string' || val === null) return val;

        if (pointDef.staticScale && typeof val === 'number') {
            val = val * pointDef.staticScale;
        } else if (pointDef.sf && typeof val === 'number') {
            if (pointDef.name === 'W' || pointDef.name === 'VA') {
                // Skip
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
                    try {
                        const sfBlock = await client.readHoldingRegisters(modelAddr + sfOffset, 1);
                        const sf = sfBlock.buffer.readInt16BE(0);
                        if (sf !== -32768) {
                            const scale = Math.pow(10, sf);
                            val = val * scale;
                        }
                    } catch (e) {}
                }
            }
        }

        if (node && node.roundDecimals && typeof val === 'number') {
            val = Number(val.toFixed(2));
        }

        return val;
    }

    async function readSinglePoint(node: SunSpecNode, models: any, ip: string, port: number, unitId: number, modelId: string | number, pointName: string, timeout: number) {
        return await connManager.request(ip, port, unitId, async (client: any) => {
             try {
                let pointDef = null;
                const mid = modelId;
                if (models[mid] && models[mid].group && models[mid].group.points) {
                    pointDef = models[mid].group.points.find((p: any) => p.name === pointName);
                }

                if (pointDef && pointDef.unitId) {
                    await client.setID(pointDef.unitId);
                }

                const cacheKey = `${ip}:${unitId}`;
                let modelAddr = -1;

                if (modelId === 'sma_edmm' || modelId === 'conext_xw_503') {
                    modelAddr = 0;
                } else if (node.modelAddressCache[cacheKey] && node.modelAddressCache[modelId.toString()]) {
                    modelAddr = node.modelAddressCache[cacheKey][modelId.toString()];
                } else {
                    modelAddr = await utils.findModelAddress(client, modelId);
                    if (modelAddr !== -1) {
                         if (!node.modelAddressCache[cacheKey]) node.modelAddressCache[cacheKey] = {};
                         node.modelAddressCache[cacheKey][modelId.toString()] = modelAddr;
                         const persistKey = `modelAddressCache_${node.id}`;
                         node.context().set(persistKey, node.modelAddressCache);
                    }
                }

                if (modelAddr === -1) {
                    throw new errors.SunSpecModelNotFoundError(modelId.toString(), `${ip}:${unitId}`);
                }

                const result = await fetchPointValue(client, models, mid, modelAddr, pointName, node);
                if (node.connectionState) {
                    node.connectionState.lastSuccess = new Date();
                }
                return result;
             } catch (e: any) {
                 if (e instanceof errors.SunSpecModelNotFoundError) throw e;
                 const isTimeout = e.message.toLowerCase().includes('time') || e.code === 'ETIMEDOUT';
                 if (isTimeout) throw new Error(`Timeout: Device ${ip}:${unitId} did not respond to read request.`);
                 const errorMsg = `Read failed: ${e.message} (${ip}:${port} ID=${unitId} Model=${modelId} Point=${pointName})`;
                 if (node.connectionState) node.connectionState.lastError = new Date();
                 throw new Error(errorMsg);
             }
        }, timeout);
    }

    async function readSunSpecDevice(ip: string, port: number, unitId: number, models: any, node: SunSpecNode) {
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

            const deviceMap: Record<string, any> = {};
            let addr = baseAddr;
            while (true) {
                const header = await client.readHoldingRegisters(addr, 2);
                const modelId = header.data[0];
                const length = header.data[1];
                if (modelId === 0xFFFF) break;
                const content = await client.readHoldingRegisters(addr + 2, length);
                let decoded: any = { id: modelId, length: length, raw: content.data };
                if (models[modelId]) decoded.name = models[modelId].group.label || models[modelId].group.name;
                deviceMap[modelId] = decoded;
                addr += 2 + length;
            }
            return deviceMap;
        } catch (e) { return null; } finally { client.close(); }
    }

    RED.nodes.registerType("sunspec-scan", SunSpecScanNode);

    loadModels(RED);
}

function loadModels(RED: NodeAPI) {
    if ((global as any).globalModelDefinitions) return;

    const fs = require('fs-extra');
    const path = require('path');
    const modelsPath = path.join(__dirname, '..', 'models', 'index.json');

    try {
        console.log("[SunSpec] Loading SunSpec models...");
        const models = fs.readJsonSync(modelsPath);
        (global as any).globalModelDefinitions = models;
        console.log(`[SunSpec] Loaded ${Object.keys(models).length} models into global cache.`);
    } catch (e: any) {
        console.error("[SunSpec] Failed to load models:", e.message);
        (global as any).globalModelDefinitions = {};
    }
}
