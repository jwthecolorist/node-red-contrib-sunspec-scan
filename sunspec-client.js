/**
 * SunSpec protocol module — the single source of truth for SunSpec addressing,
 * decoding, encoding and scaling.
 *
 * Every code path (single read, custom-list read, write, deep scan, identity
 * read) goes through this module so that the addressing and decode logic exists
 * in exactly ONE place. Historically these were re-implemented per call site,
 * which is what produced the off-by-2 "custom list" register bug.
 *
 * ADDRESSING CONVENTION (do not deviate):
 *   - A model's address is its HEADER address (the register holding the model
 *     ID, immediately followed by the model length L).
 *   - Every model JSON definition lists `ID` (register 0) and `L` (register 1)
 *     as its first two points. A point's offset is therefore accumulated from
 *     the first point and already includes the 2-register header.
 *   => registerOf(point) = headerAddr + pointOffset(point)
 *   - NEVER add a manual +2. (See git history: the "+2 offset fix" was reverted
 *     precisely because the model JSON already accounts for ID+L.)
 *
 * The client-facing functions accept any object exposing async
 * `readHoldingRegisters(addr, len)` and `writeRegisters(addr, buffer)` — i.e. a
 * connected modbus-serial client. This keeps the module unit-testable with a
 * lightweight fake client and no network or native dependency.
 */

const CONST = require('./constants');

const INT16_NOT_IMPL = -32768;
const UINT16_NOT_IMPL = 0xffff;
const INT32_NOT_IMPL = -2147483648;
const UINT32_NOT_IMPL = 0xffffffff;

/**
 * Register size (in 16-bit registers) for a model point.
 * Honours an explicit `size` (e.g. strings declare their length) and otherwise
 * infers from the SunSpec type name.
 * @param {object} point
 * @returns {number}
 */
function registerSize(point) {
    if (point.size) return point.size;
    const t = point.type || '';
    if (t.includes('64')) return 4;
    if (t.includes('32')) return 2;
    // int16, uint16, enum16, bitfield16, sunssf, pad, acc16 => 1 register
    return 1;
}

/**
 * Find a point definition by name within a model.
 * @returns {object|null}
 */
function findPoint(model, pointName) {
    if (!model || !model.group || !model.group.points) return null;
    return model.group.points.find((p) => p.name === pointName) || null;
}

/**
 * Register offset of a point from the model header (includes the ID+L header,
 * because those are the model's first two declared points).
 * @returns {number} offset in registers, or -1 if the point is not in the model
 */
function pointOffset(model, pointName) {
    if (!model || !model.group || !model.group.points) return -1;
    let offset = 0;
    for (const p of model.group.points) {
        if (p.name === pointName) {
            // Absolute-addressed vendor models (SMA EDMM, Conext XW) declare an
            // explicit per-point register offset and are read with modelAddr = 0,
            // so the offset IS the absolute register. Standard SunSpec models omit
            // `offset` and rely on positional accumulation (which already includes
            // the ID+L header). Honour an explicit offset when present.
            if (p.offset !== undefined && p.offset !== null) return p.offset;
            return offset;
        }
        offset += registerSize(p);
    }
    return -1;
}

/**
 * Decode a raw register buffer into a JS value, honouring SunSpec
 * "not implemented" sentinels (which decode to null).
 * @param {Buffer} buf
 * @param {object} point
 * @returns {number|string|bigint|null}
 */
function decode(buf, point) {
    switch (point.type) {
        case 'int16':
        case 'sint16': {
            const v = buf.readInt16BE(0);
            return v === INT16_NOT_IMPL ? null : v;
        }
        case 'uint16':
        case 'enum16':
        case 'bitfield16': {
            const v = buf.readUInt16BE(0);
            return v === UINT16_NOT_IMPL ? null : v;
        }
        case 'int32':
        case 'sint32':
        case 'acc32': {
            const v = buf.readInt32BE(0);
            return v === INT32_NOT_IMPL ? null : v;
        }
        case 'uint32':
        case 'bitfield32': {
            const v = buf.readUInt32BE(0);
            return v === UINT32_NOT_IMPL ? null : v;
        }
        case 'float32': {
            const v = buf.readFloatBE(0);
            return Number.isNaN(v) ? null : v;
        }
        case 'int64':
        case 'sint64':
        case 'acc64': {
            const v = buf.readBigInt64BE(0);
            return v;
        }
        case 'uint64': {
            const v = buf.readBigUInt64BE(0);
            return v;
        }
        case 'sunssf': {
            const v = buf.readInt16BE(0);
            return v === INT16_NOT_IMPL ? null : v;
        }
        case 'string': {
            // Strict whitelist: alphanumeric, space, dot, dash, underscore.
            // Strips control codes, 0x7E, unicode replacements, NUL padding, etc.
            return buf
                .toString()
                .replace(/[^a-zA-Z0-9\-._ ]/g, '')
                .trim();
        }
        default:
            return buf.readUInt16BE(0); // conservative fallback
    }
}

/**
 * Serialize a value to a register buffer for writing.
 * @param {number} val integer value
 * @param {string} type
 * @returns {Buffer}
 */
function encode(val, type) {
    switch (type) {
        case 'uint16':
        case 'enum16':
        case 'bitfield16': {
            const b = Buffer.alloc(2);
            b.writeUInt16BE(val & 0xffff);
            return b;
        }
        case 'int16':
        case 'sint16': {
            const b = Buffer.alloc(2);
            b.writeInt16BE(val);
            return b;
        }
        case 'uint32':
        case 'bitfield32': {
            const b = Buffer.alloc(4);
            b.writeUInt32BE(val >>> 0);
            return b;
        }
        case 'int32':
        case 'sint32': {
            const b = Buffer.alloc(4);
            b.writeInt32BE(val);
            return b;
        }
        default:
            throw new Error(`Write not supported for type: ${type}`);
    }
}

/**
 * Detect the SunSpec base address (40000 vs 40002) by probing the "SunS" marker.
 * Returns 40002 by default when the marker can't be confirmed.
 */
async function detectBaseAddress(client) {
    try {
        const marker = await client.readHoldingRegisters(CONST.BASE_ADDR_40000, 2);
        if (
            marker.data[0] === CONST.SUNSPEC_ID_HIGH &&
            marker.data[1] === CONST.SUNSPEC_ID_LOW
        ) {
            return CONST.BASE_ADDR_40002;
        }
    } catch (e) {
        /* fall through to default */
    }
    return CONST.BASE_ADDR_40002;
}

/**
 * Walk the SunSpec model chain once.
 * @returns {Promise<Object<string,{header:number,len:number}>>} map of
 *   modelId -> { header, len }. First occurrence of each id wins.
 * @param {object} [opts]
 * @param {number} [opts.stopAtModel] stop once this model id is found
 * @param {number} [opts.maxModels] loop guard (default 256)
 */
async function walkModels(client, opts = {}) {
    const maxModels = opts.maxModels || 256;
    const base = await detectBaseAddress(client);
    const map = {};
    let addr = base;
    for (let i = 0; i < maxModels; i++) {
        const header = await client.readHoldingRegisters(addr, 2);
        const id = header.data[0];
        const len = header.data[1];
        if (id === CONST.MODEL_END_MARKER) break;
        if (map[id] === undefined) map[id] = { header: addr, len };
        if (opts.stopAtModel !== undefined && id === Number(opts.stopAtModel)) break;
        addr += 2 + len;
    }
    return map;
}

/**
 * Resolve the HEADER address of a model on a device, or -1 if absent.
 */
async function findModelHeader(client, modelId) {
    const map = await walkModels(client, { stopAtModel: modelId });
    const entry = map[modelId];
    return entry ? entry.header : -1;
}

/**
 * Read and decode a single point.
 * @param {object} client
 * @param {object} model SunSpec model definition (models[modelId])
 * @param {number} headerAddr model HEADER address
 * @param {string} pointName
 * @param {object} [opts]
 * @param {boolean} [opts.round] round numeric results to 2 decimals
 * @returns {Promise<number|string|bigint|null>}
 */
async function readPoint(client, model, headerAddr, pointName, opts = {}) {
    const point = findPoint(model, pointName);
    if (!point) return null;

    const offset = pointOffset(model, pointName);
    if (offset === -1) return null;
    const size = registerSize(point);

    const block = await client.readHoldingRegisters(headerAddr + offset, size);
    let val = decode(block.buffer, point);

    if (val === null || typeof val === 'string' || typeof val === 'bigint') {
        return val;
    }

    // Scale factor application
    if (point.staticScale) {
        val = val * point.staticScale;
    } else if (point.sf) {
        const sfOffset = pointOffset(model, point.sf);
        if (sfOffset !== -1) {
            const sfBlock = await client.readHoldingRegisters(headerAddr + sfOffset, 1);
            const sf = sfBlock.buffer.readInt16BE(0);
            if (sf !== INT16_NOT_IMPL) {
                val = val * Math.pow(10, sf);
            }
        }
    }

    if (opts.round && typeof val === 'number') {
        val = Number(val.toFixed(2));
    }
    return val;
}

/**
 * Encode + write a single point (applies reverse static scaling, rounds to int).
 * @returns {Promise<true>}
 */
async function writePoint(client, model, headerAddr, pointName, value) {
    const point = findPoint(model, pointName);
    if (!point) throw new Error(`Point ${pointName} not found in model`);

    const offset = pointOffset(model, pointName);
    if (offset === -1) throw new Error(`Point ${pointName} has no resolvable offset`);

    let val = value;
    if (point.staticScale) val = val / point.staticScale;
    val = Math.round(val);

    const buffer = encode(val, point.type);
    await client.writeRegisters(headerAddr + offset, buffer);
    return true;
}

module.exports = {
    registerSize,
    findPoint,
    pointOffset,
    decode,
    encode,
    detectBaseAddress,
    walkModels,
    findModelHeader,
    readPoint,
    writePoint,
};
