'use strict';
const { parseIpRange } = require('../discovery');

describe('parseIpRange', () => {
    test('single IP', () => {
        expect(parseIpRange('192.168.1.10')).toEqual(['192.168.1.10']);
    });
    test('comma list', () => {
        expect(parseIpRange('192.168.1.10, 192.168.1.12')).toEqual(['192.168.1.10', '192.168.1.12']);
    });
    test('last-octet range', () => {
        expect(parseIpRange('192.168.1.10-12')).toEqual(['192.168.1.10', '192.168.1.11', '192.168.1.12']);
    });
    test('reversed range is normalised', () => {
        expect(parseIpRange('192.168.1.12-10')).toEqual(['192.168.1.10', '192.168.1.11', '192.168.1.12']);
    });
    test('CIDR /30 excludes network + broadcast', () => {
        expect(parseIpRange('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
    });
    test('empty -> []', () => {
        expect(parseIpRange('')).toEqual([]);
    });
    test('large CIDR is capped at 1000 hosts', () => {
        expect(parseIpRange('10.0.0.0/8').length).toBeLessThanOrEqual(1000);
    });
});

const { looksLikeDeviceName, decodeDeviceName } = require('../discovery');

describe('Conext 503 device-name validation', () => {
    test('decodes a real device name, stripping NUL/non-printable padding', () => {
        const buf = Buffer.from('XW Pro 6848 NA\x00\x00', 'latin1');
        expect(decodeDeviceName(buf)).toBe('XW Pro 6848 NA');
    });
    test('accepts a plausible device name', () => {
        expect(looksLikeDeviceName(Buffer.from('XW Pro 6848 NA', 'latin1'))).toBe(true);
        expect(looksLikeDeviceName(Buffer.from('cb-BC2221000287', 'latin1'))).toBe(true);
    });
    test('rejects a zeroed block (no false positive on a silent device)', () => {
        expect(looksLikeDeviceName(Buffer.alloc(16))).toBe(false);
    });
    test('rejects a non-printable/binary block', () => {
        expect(looksLikeDeviceName(Buffer.from([0,1,0,2,0,3,0,4]))).toBe(false);
    });
});
