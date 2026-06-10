'use strict';
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const DeviceManager = require('../device-manager');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-')); });
afterEach(() => { fs.removeSync(dir); });

describe('DeviceManager', () => {
    test('add + list', () => {
        const dm = new DeviceManager(dir);
        const d = dm.add({ ip: '10.0.0.5', port: 502, unitId: 3, name: 'Inv' });
        expect(d.id).toBeTruthy();
        expect(dm.list()).toHaveLength(1);
    });
    test('upsert is idempotent on ip/port/unitId', () => {
        const dm = new DeviceManager(dir);
        dm.upsert({ ip: '10.0.0.5', port: 502, unitId: 3 });
        dm.upsert({ ip: '10.0.0.5', port: 502, unitId: 3 });
        expect(dm.list()).toHaveLength(1);
    });
    test('upsert backfills a real name over the default (C4 fix)', () => {
        const dm = new DeviceManager(dir);
        const first = dm.upsert({ ip: '10.0.0.5', port: 502, unitId: 3 }); // name -> "Device 10.0.0.5"
        expect(first.name).toMatch(/^Device /);
        const second = dm.upsert({ ip: '10.0.0.5', port: 502, unitId: 3, name: 'SMA Sunny' });
        expect(second.name).toBe('SMA Sunny');
        expect(dm.list()).toHaveLength(1);
    });
    test('delete removes by id', () => {
        const dm = new DeviceManager(dir);
        const d = dm.add({ ip: '10.0.0.9' });
        expect(dm.delete(d.id)).toBe(true);
        expect(dm.delete('nope')).toBe(false);
    });
});
