
import { parseUnitIds, getRegisterSize, isNotImplemented } from '../src/utils';
import * as CONST from '../src/constants';

describe('utils.js', () => {
    describe('parseUnitIds', () => {
        test('parses single ID', () => {
            expect(parseUnitIds('1')).toEqual([1]);
        });
        test('parses comma-separated IDs', () => {
            expect(parseUnitIds('1, 5')).toEqual([1, 5]);
        });
        test('parses ranges', () => {
            expect(parseUnitIds('1-3')).toEqual([1, 2, 3]);
        });
        test('parses mixed input', () => {
            expect(parseUnitIds('1, 10-12')).toEqual([1, 10, 11, 12]);
        });
        test('returns null for empty string (scan all)', () => {
            expect(parseUnitIds('')).toBeNull();
            expect(parseUnitIds('   ')).toBeNull();
        });
        test('handles whitespace', () => {
            expect(parseUnitIds(' 1 , 5 - 7 ')).toEqual([1, 5, 6, 7]);
        });
        test('deduplicates and sorts', () => {
            expect(parseUnitIds('5, 1, 5-7')).toEqual([1, 5, 6, 7]);
        });
        test('ignores invalid numbers', () => {
            expect(parseUnitIds('1, foo, 5')).toEqual([1, 5]);
        });
    });

    describe('getRegisterSize', () => {
        test('returns 1 for int16/uint16/sunssf/unknown', () => {
            expect(getRegisterSize('int16')).toBe(CONST.REG_SIZE_16);
            expect(getRegisterSize('uint16')).toBe(CONST.REG_SIZE_16);
            expect(getRegisterSize('sunssf')).toBe(CONST.REG_SIZE_16);
            expect(getRegisterSize('unknown')).toBe(CONST.REG_SIZE_16);
            expect(getRegisterSize(undefined)).toBe(CONST.REG_SIZE_16);
        });
        test('returns 2 for 32-bit types', () => {
            expect(getRegisterSize('uint32')).toBe(CONST.REG_SIZE_32);
            expect(getRegisterSize('int32')).toBe(CONST.REG_SIZE_32);
            expect(getRegisterSize('float32')).toBe(CONST.REG_SIZE_32);
            expect(getRegisterSize('acc32')).toBe(CONST.REG_SIZE_32);
        });
        test('returns 4 for 64-bit types', () => {
            expect(getRegisterSize('uint64')).toBe(CONST.REG_SIZE_64);
            expect(getRegisterSize('int64')).toBe(CONST.REG_SIZE_64);
        });
        test('returns string size', () => {
            expect(getRegisterSize('string')).toBe(CONST.REG_SIZE_STRING);
        });
    });

    describe('isNotImplemented', () => {
        test('returns true for int16 sentinel', () => {
            expect(isNotImplemented(CONST.INT16_NOT_IMPL, 'int16')).toBe(true);
        });
        test('returns false for valid int16', () => {
            expect(isNotImplemented(123, 'int16')).toBe(false);
        });
        test('returns true for uint16 sentinel', () => {
            expect(isNotImplemented(CONST.UINT16_NOT_IMPL, 'uint16')).toBe(true);
        });
         test('returns true for int32 sentinel', () => {
            expect(isNotImplemented(CONST.INT32_NOT_IMPL, 'int32')).toBe(true);
        });
        test('returns true for uint32 sentinel', () => {
            expect(isNotImplemented(CONST.UINT32_NOT_IMPL, 'uint32')).toBe(true);
        });
        test('returns true for float32 NaN', () => {
            expect(isNotImplemented(NaN, 'float32')).toBe(true);
        });
         test('returns false for valid float32', () => {
            expect(isNotImplemented(12.34, 'float32')).toBe(false);
        });
        test('returns false for non-numeric input', () => {
             expect(isNotImplemented('foo', 'int16')).toBe(false);
        });
    });
});
