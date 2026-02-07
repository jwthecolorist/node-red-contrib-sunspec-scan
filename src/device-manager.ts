import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

export interface Device {
    id: string;
    name: string;
    ip: string;
    port: number;
    unitId: number;
    addedAt: string;
}

export class DeviceManager {
    private filePath: string;
    private devices: Device[];

    constructor(userDir?: string) {
        // Store in userDir (e.g. ~/.node-red/sunspec-devices.json)
        // If userDir is null (unexpected), try modules dir or tmp
        const dir = userDir || __dirname;
        this.filePath = path.join(dir, 'sunspec-devices.json');
        this.devices = [];
        this.load();
    }

    load(): void {
        try {
            if (fs.existsSync(this.filePath)) {
                this.devices = fs.readJsonSync(this.filePath);
            }
        } catch (e: any) {
            console.error("[SunSpec] Failed to load devices:", e.message);
            this.devices = [];
        }
    }

    save(): void {
        try {
            fs.writeJsonSync(this.filePath, this.devices, { spaces: 2 });
        } catch (e: any) {
            console.error("[SunSpec] Failed to save devices:", e.message);
        }
    }

    list(): Device[] {
        return this.devices;
    }

    /**
     * Add a new device
     * @param {Object} device { name, ip, port, unitId }
     */
    add(device: Partial<Device>): Device {
        if (!device.ip) throw new Error("IP Address is required");

        const newDevice: Device = {
            id: crypto.randomUUID(),
            name: device.name || `Device ${device.ip}`,
            ip: device.ip,
            port: device.port ? parseInt(device.port.toString()) : 502,
            unitId: device.unitId ? parseInt(device.unitId.toString()) : 1,
            addedAt: new Date().toISOString()
        };

        this.devices.push(newDevice);
        this.save();
        return newDevice;
    }

    /**
     * Add or return existing device based on IP/Port/ID
     */
    upsert(device: Partial<Device>): Device {
        const port = device.port ? parseInt(device.port.toString()) : 502;
        const unitId = device.unitId ? parseInt(device.unitId.toString()) : 1;

        const existing = this.devices.find(d =>
            d.ip === device.ip &&
            d.unitId === unitId &&
            d.port === port
        );

        if (existing) return existing;
        return this.add(device);
    }

    update(id: string, data: Partial<Device>): Device {
        const idx = this.devices.findIndex(d => d.id === id);
        if (idx === -1) throw new Error("Device not found");

        // Merge updates
        const current = this.devices[idx];
        const updated: Device = {
            ...current,
            name: data.name || current.name,
            ip: data.ip || current.ip,
            port: data.port ? parseInt(data.port.toString()) : current.port,
            unitId: data.unitId ? parseInt(data.unitId.toString()) : current.unitId
        };

        this.devices[idx] = updated;
        this.save();
        return updated;
    }

    delete(id: string): boolean {
        const idx = this.devices.findIndex(d => d.id === id);
        if (idx === -1) return false;

        this.devices.splice(idx, 1);
        this.save();
        return true;
    }
}

export default DeviceManager;
