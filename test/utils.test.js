'use strict';
const { parseUnitIds, getRegisterSize, isNotImplemented } = require('../utils');

describe('parseUnitIds', () => {
    test('empty -> null (scan all)', () => {
        expect(parseUnitIds('')).toBeNull();
        expect(parseUnitIds('   ')).toBeNull();
    });
    test('single, list and range, deduped + sorted', () => {
        expect(parseUnitIds('5')).toEqual([5]);
        expect(parseUnitIds('1,5,10-12')).toEqual([1, 5, 10, 11, 12]);
        expect(parseUnitIds('3,1,3,2')).toEqual([1, 2, 3]);
    });
});

describe('getRegisterSize', () => {
    test('infers register count from type', () => {
        expect(getRegisterSize('int16')).toBe(1);
        expect(getRegisterSize('uint32')).toBe(2);
        expect(getRegisterSize('int64')).toBe(4);
        expect(getRegisterSize('sunssf')).toBe(1);
    });
});

describe('isNotImplemented', () => {
    test('detects SunSpec sentinels per type', () => {
        expect(isNotImplemented(-32768, 'int16')).toBe(true);
        expect(isNotImplemented(65535, 'uint16')).toBe(true);
        expect(isNotImplemented(5, 'int16')).toBe(false);
        expect(isNotImplemented(NaN, 'float32')).toBe(true);
    });
});
