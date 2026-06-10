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
