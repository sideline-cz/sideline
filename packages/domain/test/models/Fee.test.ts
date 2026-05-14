// TDD mode — tests written BEFORE any implementation changes.
// These tests verify the Fee domain schema. Most should already pass because
// the schema is in place; they document and guard expected behaviour.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import { AmountMinor, CurrencyCode, Fee, FeeRecurrence } from '~/models/Fee.js';

const decodeSync = Schema.decodeUnknownSync;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validFeeRow = {
  id: 'fee-uuid-001',
  team_id: 'team-uuid-001',
  name: 'Annual Membership',
  description: null,
  amount_minor: 5000,
  currency: 'CZK',
  due_at: null,
  recurrence: 'none' as const,
  target_scope: 'all_members' as const,
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
  archived_at: null,
};

// ---------------------------------------------------------------------------
// Fee schema decoding
// ---------------------------------------------------------------------------

describe('Fee schema', () => {
  it('decodes from a valid DB row with all required fields', () => {
    const fee = decodeSync(Fee.insert)(validFeeRow);
    // Fee.insert omits the generated id field — the insert schema only has
    // the settable fields. We verify those fields decode correctly.
    expect(fee.name).toBe('Annual Membership');
    expect(fee.amount_minor).toBe(5000);
    expect(fee.currency).toBe('CZK');
    expect(fee.recurrence).toBe('none');
    expect(fee.target_scope).toBe('all_members');
    expect(Option.isNone(fee.description)).toBe(true);
    expect(Option.isNone(fee.due_at)).toBe(true);
    expect(Option.isNone(fee.archived_at)).toBe(true);
  });

  it('rejects negative amount_minor', () => {
    expect(() => decodeSync(AmountMinor)(-1)).toThrow();
  });

  it('accepts amount_minor = 0 (free fee)', () => {
    const result = decodeSync(AmountMinor)(0);
    expect(result).toBe(0);
  });

  it('rejects an invalid 2-char currency code', () => {
    expect(() => decodeSync(CurrencyCode)('CZ')).toThrow();
  });

  it('rejects an invalid 4-char currency code', () => {
    expect(() => decodeSync(CurrencyCode)('EURO')).toThrow();
  });

  it('accepts a valid 3-char currency code', () => {
    expect(decodeSync(CurrencyCode)('EUR')).toBe('EUR');
  });

  it('decodes null description to Option.none()', () => {
    const fee = decodeSync(Fee.insert)({ ...validFeeRow, description: null });
    expect(Option.isNone(fee.description)).toBe(true);
  });

  it('decodes non-null description to Option.some()', () => {
    const fee = decodeSync(Fee.insert)({ ...validFeeRow, description: 'Annual team fee' });
    expect(Option.isSome(fee.description)).toBe(true);
    expect(Option.getOrNull(fee.description)).toBe('Annual team fee');
  });

  it('decodes null due_at to Option.none()', () => {
    const fee = decodeSync(Fee.insert)({ ...validFeeRow, due_at: null });
    expect(Option.isNone(fee.due_at)).toBe(true);
  });

  it('decodes null archived_at to Option.none()', () => {
    const fee = decodeSync(Fee.insert)({ ...validFeeRow, archived_at: null });
    expect(Option.isNone(fee.archived_at)).toBe(true);
  });

  it('decodes a non-null archived_at to Option.some()', () => {
    const fee = decodeSync(Fee.insert)({
      ...validFeeRow,
      archived_at: new Date('2025-06-01T10:00:00Z'),
    });
    expect(Option.isSome(fee.archived_at)).toBe(true);
  });

  it("rejects recurrence='monthly' (v1 only supports 'none')", () => {
    expect(() => decodeSync(FeeRecurrence)('monthly')).toThrow();
  });

  it("accepts recurrence='none'", () => {
    expect(decodeSync(FeeRecurrence)('none')).toBe('none');
  });
});
