// TDD mode — tests written BEFORE any Expense API/handler implementation exists.
// These tests WILL FAIL until the developer wires up the implementation.
//
// Required implementation:
//   - packages/domain/src/models/Expense.ts (exists: ExpenseCategory)
//   - packages/domain/src/api/ExpenseApi.ts (exists: CreateExpenseRequest, UpdateExpenseRequest, BalanceSummary)

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import { BalanceSummary, CreateExpenseRequest, UpdateExpenseRequest } from '~/api/ExpenseApi.js';
import { ExpenseCategory } from '~/models/Expense.js';

// ---------------------------------------------------------------------------
// ExpenseCategory
// ---------------------------------------------------------------------------

describe('ExpenseCategory', () => {
  it('decodes "fields"', () => {
    const result = Schema.decodeUnknownSync(ExpenseCategory)('fields');
    expect(result).toBe('fields');
  });

  it('decodes "equipment"', () => {
    const result = Schema.decodeUnknownSync(ExpenseCategory)('equipment');
    expect(result).toBe('equipment');
  });

  it('decodes "travel"', () => {
    const result = Schema.decodeUnknownSync(ExpenseCategory)('travel');
    expect(result).toBe('travel');
  });

  it('decodes "tournaments"', () => {
    const result = Schema.decodeUnknownSync(ExpenseCategory)('tournaments');
    expect(result).toBe('tournaments');
  });

  it('decodes "other"', () => {
    const result = Schema.decodeUnknownSync(ExpenseCategory)('other');
    expect(result).toBe('other');
  });

  it('rejects "food" with ParseError', () => {
    expect(() => Schema.decodeUnknownSync(ExpenseCategory)('food')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => Schema.decodeUnknownSync(ExpenseCategory)('')).toThrow();
  });

  it('rejects null', () => {
    expect(() => Schema.decodeUnknownSync(ExpenseCategory)(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// CreateExpenseRequest
// ---------------------------------------------------------------------------

const validCreatePayload = {
  amountMinor: 1000,
  currency: 'CZK',
  spentAt: '2025-05-01T12:00:00Z',
  category: 'fields',
  description: 'Pitch rental',
};

describe('CreateExpenseRequest', () => {
  it('accepts a valid payload', () => {
    const result = Schema.decodeUnknownSync(CreateExpenseRequest)(validCreatePayload);
    expect(result.amountMinor).toBe(1000);
    expect(result.currency).toBe('CZK');
    expect(result.category).toBe('fields');
    expect(result.description).toBe('Pitch rental');
  });

  it('accepts description of exactly 500 characters (boundary)', () => {
    const payload = { ...validCreatePayload, description: 'a'.repeat(500) };
    const result = Schema.decodeUnknownSync(CreateExpenseRequest)(payload);
    expect(result.description.length).toBe(500);
  });

  it('rejects description longer than 500 characters', () => {
    const payload = { ...validCreatePayload, description: 'a'.repeat(501) };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });

  it('accepts description of 0 characters (empty)', () => {
    const payload = { ...validCreatePayload, description: '' };
    const result = Schema.decodeUnknownSync(CreateExpenseRequest)(payload);
    expect(result.description).toBe('');
  });

  it('rejects negative amountMinor', () => {
    const payload = { ...validCreatePayload, amountMinor: -1 };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });

  it('accepts amountMinor = 0', () => {
    // AmountMinor uses isGreaterThanOrEqualTo(0); 0 is valid at the schema level
    const payload = { ...validCreatePayload, amountMinor: 0 };
    const result = Schema.decodeUnknownSync(CreateExpenseRequest)(payload);
    expect(result.amountMinor).toBe(0);
  });

  it('rejects currency with length != 3 (too short)', () => {
    const payload = { ...validCreatePayload, currency: 'CZ' };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });

  it('rejects currency with length != 3 (too long)', () => {
    const payload = { ...validCreatePayload, currency: 'CZKK' };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });

  it('rejects invalid category', () => {
    const payload = { ...validCreatePayload, category: 'food' };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });

  it('rejects non-ISO spentAt string', () => {
    const payload = { ...validCreatePayload, spentAt: 'not-a-date' };
    expect(() => Schema.decodeUnknownSync(CreateExpenseRequest)(payload)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// UpdateExpenseRequest
// ---------------------------------------------------------------------------

describe('UpdateExpenseRequest', () => {
  it('with all fields omitted decodes to all Option.none', () => {
    const result = Schema.decodeUnknownSync(UpdateExpenseRequest)({});
    expect(Option.isNone(result.amountMinor)).toBe(true);
    expect(Option.isNone(result.currency)).toBe(true);
    expect(Option.isNone(result.spentAt)).toBe(true);
    expect(Option.isNone(result.category)).toBe(true);
    expect(Option.isNone(result.description)).toBe(true);
  });

  it('accepts partial payload with only amountMinor', () => {
    const result = Schema.decodeUnknownSync(UpdateExpenseRequest)({ amountMinor: 2500 });
    expect(Option.isSome(result.amountMinor)).toBe(true);
    expect(Option.isNone(result.currency)).toBe(true);
  });

  it('accepts partial payload with only description', () => {
    const result = Schema.decodeUnknownSync(UpdateExpenseRequest)({
      description: 'Updated description',
    });
    expect(Option.isSome(result.description)).toBe(true);
    if (Option.isSome(result.description)) {
      expect(result.description.value).toBe('Updated description');
    }
  });

  it('rejects description longer than 500 characters in update', () => {
    const payload = { description: 'a'.repeat(501) };
    expect(() => Schema.decodeUnknownSync(UpdateExpenseRequest)(payload)).toThrow();
  });

  it('accepts description of exactly 500 characters in update', () => {
    const payload = { description: 'a'.repeat(500) };
    const result = Schema.decodeUnknownSync(UpdateExpenseRequest)(payload);
    expect(Option.isSome(result.description)).toBe(true);
    if (Option.isSome(result.description)) {
      expect(result.description.value.length).toBe(500);
    }
  });

  it('accepts full update payload', () => {
    const result = Schema.decodeUnknownSync(UpdateExpenseRequest)({
      amountMinor: 999,
      currency: 'EUR',
      spentAt: '2025-06-15T10:00:00Z',
      category: 'travel',
      description: 'Flight tickets',
    });
    expect(Option.isSome(result.amountMinor)).toBe(true);
    expect(Option.isSome(result.currency)).toBe(true);
    expect(Option.isSome(result.category)).toBe(true);
    expect(Option.isSome(result.description)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BalanceSummary
// ---------------------------------------------------------------------------

describe('BalanceSummary', () => {
  it('decodes a single-currency entry correctly', () => {
    const result = Schema.decodeUnknownSync(BalanceSummary)({
      currency: 'CZK',
      incomeMinor: 50000,
      expensesMinor: 30000,
      netMinor: 20000,
      byCategory: [
        { category: 'fields', amountMinor: 20000 },
        { category: 'equipment', amountMinor: 10000 },
      ],
    });
    expect(result.currency).toBe('CZK');
    expect(result.incomeMinor).toBe(50000);
    expect(result.expensesMinor).toBe(30000);
    expect(result.netMinor).toBe(20000);
    expect(result.byCategory).toHaveLength(2);
  });

  it('decodes EUR entry', () => {
    const result = Schema.decodeUnknownSync(BalanceSummary)({
      currency: 'EUR',
      incomeMinor: 10000,
      expensesMinor: 10000,
      netMinor: 0,
      byCategory: [],
    });
    expect(result.currency).toBe('EUR');
    expect(result.netMinor).toBe(0);
    expect(result.byCategory).toEqual([]);
  });

  it('rejects invalid currency code', () => {
    expect(() =>
      Schema.decodeUnknownSync(BalanceSummary)({
        currency: 'EURO',
        incomeMinor: 0,
        expensesMinor: 0,
        netMinor: 0,
        byCategory: [],
      }),
    ).toThrow();
  });
});
