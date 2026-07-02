import { describe, expect, it } from 'vitest';
import { asRecord, isRecord, numberProp } from '~/rest/recordProbe.js';

describe('isRecord', () => {
  it('true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('true for arrays (typeof "object")', () => {
    expect(isRecord([])).toBe(true);
  });

  it('false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('false for primitives', () => {
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord('x')).toBe(false);
  });
});

describe('asRecord', () => {
  it('returns the same object reference for records', () => {
    const o = { a: 1 };
    expect(asRecord(o)).toBe(o);
  });

  it('undefined for null and primitives', () => {
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(5)).toBeUndefined();
    expect(asRecord('x')).toBeUndefined();
  });
});

describe('numberProp', () => {
  it('reads a numeric property', () => {
    expect(numberProp({ status: 403 }, 'status')).toBe(403);
  });

  it('undefined when the property is absent', () => {
    expect(numberProp({}, 'status')).toBeUndefined();
  });

  it('undefined when the property is non-numeric', () => {
    expect(numberProp({ status: '403' }, 'status')).toBeUndefined();
  });

  it('undefined when the value is not a record', () => {
    expect(numberProp(null, 'status')).toBeUndefined();
    expect(numberProp(undefined, 'status')).toBeUndefined();
    expect(numberProp(42, 'status')).toBeUndefined();
  });
});
