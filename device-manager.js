const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class DeviceManager {
    constructor(userDir) {
        // Store in userDir (e.g. ~/.node-red/sunspec-devices.json)
        // If userDir is null (unexpected), try modules dir or tmp
        const dir = userDir || __dirname;
        this.filePath = path.join(dir, 'sunspec-devices.json');
        this.devices = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                this.devices = fs.readJsonSync(this.filePath);
            }
        } catch (e) {
            console.error("[SunSpec] Failed to load devices:", e.message);
            this.devices = [];
        }
    }

    save() {
        try {
            fs.writeJsonSync(this.filePath, this.devices, { spaces: 2 });
        } catch (e) {
            console.error("[SunSpec] Failed to save devices:", e.message);
        }
    }

    list() {
        return this.devices;
    }

    /**
     * Add a new device
     * @param {Object} device { name, ip, port, unitId }
     */
    add(device) {
        if (!device.ip) throw new Error("IP Address is required");

        const newDevice = {
            id: crypto.randomUUID(),
            name: device.name || `Device ${device.ip}`,
            ip: device.ip,
            port: parseInt(device.port) || 502,
            unitId: parseInt(device.unitId) || 1,
            addedAt: new Date().toISOString()
        };

        this.devices.push(newDevice);
        this.save();
        return newDevice;
    }

    /**
     * Add or return existing device based on IP/Port/ID
     */
    upsert(device) {
        const port = parseInt(device.port) || 502;
        const unitId = parseInt(device.unitId) || 1;

        const existing = this.devices.find(d =>
            d.ip === device.ip &&
            d.unitId === unitId &&
            d.port === port
        );

        if (existing) return existing;
        return this.add(device);
    }

    update(id, data) {
        const idx = this.devices.findIndex(d => d.id === id);
        if (idx === -1) throw new Error("Device not found");

        // Merge updates
        const current = this.devices[idx];
        const updated = {
            ...current,
            name: data.name || current.name,
            ip: data.ip || current.ip,
            port: data.port ? parseInt(data.port) : current.port,
            unitId: data.unitId ? parseInt(data.unitId) : current.unitId
        };

        this.devices[idx] = updated;
        this.save();
        return updated;
    }

    delete(id) {
        const idx = this.devices.findIndex(d => d.id === id);
        if (idx === -1) return false;

        this.devices.splice(idx, 1);
        this.save();
        return true;
    }
}

module.exports = DeviceManager;
