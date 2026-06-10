'use strict';

const client = require('../sunspec-client');

/**
 * Minimal fake modbus-serial client backed by a flat register map.
 * Mirrors the real client's return shape: { data: number[], buffer: Buffer }.
 */
function makeFakeClient(registers) {
    // registers: { [addr:number]: number (uint16) }
    const writes = [];
    return {
        writes,
        async readHoldingRegisters(addr, len) {
            const data = [];
            const buf = Buffer.alloc(len * 2);
            for (let i = 0; i < len; i++) {
                const v = registers[addr + i];
                if (v === undefined) throw new Error(`Unmapped register ${addr + i}`);
                data.push(v & 0xffff);
                buf.writeUInt16BE(v & 0xffff, i * 2);
            }
            return { data, buffer: buf };
        },
        async writeRegisters(addr, buffer) {
            writes.push({ addr, buffer });
            return { address: addr, length: buffer.length / 2 };
        },
    };
}

// A synthetic model 103-style definition (ID + L header, then real points).
const MODEL_103 = {
    group: {
        name: 'inverter',
        label: 'Inverter',
        points: [
            { name: 'ID', type: 'uint16' },
            { name: 'L', type: 'uint16' },
            { name: 'A', type: 'uint16', sf: 'A_SF' },
            { name: 'AphA', type: 'uint16', sf: 'A_SF' },
            { name: 'AphB', type: 'uint16', sf: 'A_SF' },
            { name: 'A_SF', type: 'sunssf' },
            { name: 'W', type: 'int16', sf: 'W_SF' },
            { name: 'W_SF', type: 'sunssf' },
        ],
    },
};

const MODEL_1 = {
    group: {
        name: 'common',
        points: [
            { name: 'ID', type: 'uint16' },
            { name: 'L', type: 'uint16' },
            { name: 'Mn', type: 'string', size: 16 },
            { name: 'Md', type: 'string', size: 16 },
        ],
    },
};

describe('pointOffset / registerSize', () => {
    test('ID and L occupy the first two registers', () => {
        expect(client.pointOffset(MODEL_103, 'ID')).toBe(0);
        expect(client.pointOffset(MODEL_103, 'L')).toBe(1);
    });
    test('first real point sits immediately after the 2-register header', () => {
        expect(client.pointOffset(MODEL_103, 'A')).toBe(2);
    });
    test('offsets accumulate correctly past scale factors', () => {
        expect(client.pointOffset(MODEL_103, 'A_SF')).toBe(5);
        expect(client.pointOffset(MODEL_103, 'W')).toBe(6);
    });
    test('string size is honoured', () => {
        expect(client.registerSize({ name: 'Mn', type: 'string', size: 16 })).toBe(16);
        expect(client.pointOffset(MODEL_1, 'Md')).toBe(2 + 16);
    });
    test('unknown point returns -1', () => {
        expect(client.pointOffset(MODEL_103, 'NOPE')).toBe(-1);
    });
});

describe('decode', () => {
    const b16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
    const bu16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
    test('int16 not-implemented sentinel -> null', () => {
        expect(client.decode(b16(-32768), { type: 'int16' })).toBeNull();
        expect(client.decode(b16(-5), { type: 'int16' })).toBe(-5);
    });
    test('uint16 not-implemented sentinel -> null', () => {
        expect(client.decode(bu16(0xffff), { type: 'uint16' })).toBeNull();
        expect(client.decode(bu16(42), { type: 'uint16' })).toBe(42);
    });
    test('string is whitelist-cleaned', () => {
        const b = Buffer.from('AB\x00\x7E12', 'latin1');
        expect(client.decode(b, { type: 'string' })).toBe('AB12');
    });
});

describe('readPoint — addressing + scaling (regression for off-by-2 list bug)', () => {
    // Place model 103 header at 40072. ID+L header, then A=123 at +2, etc.
    const HEADER = 40072;
    const regs = {
        [HEADER + 0]: 103,        // ID
        [HEADER + 1]: 50,         // L
        [HEADER + 2]: 123,        // A
        [HEADER + 3]: 10,         // AphA
        [HEADER + 4]: 20,         // AphB
        [HEADER + 5]: 0xffff,     // A_SF (will be read for A's scaling; 0xffff as int16 = -1)
        [HEADER + 6]: 0xfff6,     // W = -10 (int16)
        [HEADER + 7]: 0,          // W_SF = 0
    };

    test('reads the correct register using the HEADER address', async () => {
        const fake = makeFakeClient(regs);
        // A_SF raw 0xffff -> int16 -1 -> scale 10^-1; 123 * 0.1 = 12.3
        const v = await client.readPoint(fake, MODEL_103, HEADER, 'A', { round: true });
        expect(v).toBe(12.3);
    });

    test('passing the DATA address (header+2) would read the WRONG point', async () => {
        const fake = makeFakeClient(regs);
        // This is the old buggy convention. AphB lives at header+4; reading 'A'
        // from a base of header+2 lands on AphB (20) instead of A (123).
        const wrong = await client.readPoint(fake, MODEL_103, HEADER + 2, 'A', { round: true });
        const right = await client.readPoint(fake, MODEL_103, HEADER, 'A', { round: true });
        expect(wrong).not.toBe(right);
    });

    test('int16 value with W_SF=0 returns raw', async () => {
        const fake = makeFakeClient(regs);
        const v = await client.readPoint(fake, MODEL_103, HEADER, 'W', { round: true });
        expect(v).toBe(-10);
    });
});

describe('walkModels / findModelHeader', () => {
    // 40000 marker "SunS", base 40002. Model 1 (len 4) then model 103 (len 6) then end.
    const regs = {
        40000: 0x5375, 40001: 0x6e53,        // "SunS"
        40002: 1, 40003: 4,                   // model 1 header, len 4
        40004: 0, 40005: 0, 40006: 0, 40007: 0,
        40008: 103, 40009: 6,                 // model 103 header, len 6
        40010: 0, 40011: 0, 40012: 0, 40013: 0, 40014: 0, 40015: 0,
        40016: 0xffff, 40017: 0,              // end marker
    };
    test('maps model headers correctly', async () => {
        const fake = makeFakeClient(regs);
        const map = await client.walkModels(fake);
        expect(map[1].header).toBe(40002);
        expect(map[103].header).toBe(40008);
    });
    test('findModelHeader returns header address or -1', async () => {
        const fake = makeFakeClient(regs);
        expect(await client.findModelHeader(fake, 103)).toBe(40008);
        expect(await client.findModelHeader(fake, 999)).toBe(-1);
    });
});

describe('writePoint', () => {
    test('writes encoded value at header+offset with reverse static scaling', async () => {
        const fake = makeFakeClient({});
        const model = { group: { points: [
            { name: 'ID', type: 'uint16' },
            { name: 'L', type: 'uint16' },
            { name: 'WMaxLimPct', type: 'uint16', staticScale: 0.01 },
        ] } };
        await client.writePoint(fake, model, 5000, 'WMaxLimPct', 50);
        expect(fake.writes).toHaveLength(1);
        // offset of WMaxLimPct is 2 -> addr 5002; 50 / 0.01 = 5000
        expect(fake.writes[0].addr).toBe(5002);
        expect(fake.writes[0].buffer.readUInt16BE(0)).toBe(5000);
    });
    test('unsupported type throws', async () => {
        const fake = makeFakeClient({});
        const model = { group: { points: [{ name: 'X', type: 'float32' }] } };
        await expect(client.writePoint(fake, model, 0, 'X', 1)).rejects.toThrow(/not supported/i);
    });
});

// ---------------------------------------------------------------------------
// Tests against the REAL shipped model definitions (models/index.json), so the
// addressing claims are validated against production data, not a synthetic model.
// ---------------------------------------------------------------------------
const realModels = require('../models/index.json');

describe('addressing against real models/index.json', () => {
    test('standard model 103: first data point A sits at header+2 (= ID+L)', () => {
        // Per SunSpec, A is the first data point so its true register is dataStart,
        // i.e. headerAddr + 2. Accumulated offset must therefore be 2.
        expect(client.pointOffset(realModels['103'], 'A')).toBe(2);
        expect(client.pointOffset(realModels['103'], 'AphA')).toBe(3);
    });

    test('standard model 1 (common): Md sits after the 16-register Mn string', () => {
        // ID(1)+L(1)+Mn(16) = 18
        expect(client.pointOffset(realModels['1'], 'Md')).toBe(18);
    });

    test('vendor sma_edmm: explicit absolute offsets are honoured (read with modelAddr=0)', () => {
        expect(client.pointOffset(realModels['sma_edmm'], 'DeviceClass')).toBe(30051);
        expect(client.pointOffset(realModels['sma_edmm'], 'SmaModbusProfileRevision')).toBe(30001);
    });

    test('vendor conext_xw_503: explicit offsets honoured, not accumulated', () => {
        expect(client.pointOffset(realModels['conext_xw_503'], 'DeviceName')).toBe(0);
        expect(client.pointOffset(realModels['conext_xw_503'], 'FGANumber')).toBe(10);
    });

    test('end-to-end: single-read base (header) and the OLD list base (header+2) disagree', async () => {
        // Demonstrates the bug concretely on the real model 103 schema.
        const HEADER = 40072;
        // Sparse map; unmapped registers read as 0 (so every scale factor = 10^0 = 1).
        const regs = {
            [HEADER]: 103, [HEADER + 1]: 50, // header (ID, L)
            [HEADER + 2]: 111,               // A      (first data point)
            [HEADER + 4]: 333,               // AphB   (what a header+2 base hits when asked for 'A')
        };
        const fake = {
            async readHoldingRegisters(a, len) {
                const data = []; const buf = Buffer.alloc(len * 2);
                for (let i = 0; i < len; i++) { const x = regs[a + i] || 0; data.push(x); buf.writeUInt16BE(x, i * 2); }
                return { data, buffer: buf };
            },
        };
        const correct = await client.readPoint(fake, realModels['103'], HEADER, 'A', {});
        const buggy = await client.readPoint(fake, realModels['103'], HEADER + 2, 'A', {});
        expect(correct).toBe(111);   // header base -> reads A
        expect(buggy).toBe(333);     // header+2 base -> reads AphB (the off-by-2 symptom)
    });
});
