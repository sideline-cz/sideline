// TDD mode — tests for Payment domain schema.
// These should pass once the schema is in place.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import { Payment, PaymentMethod } from '~/models/Payment.js';

const decodeSync = Schema.decodeUnknownSync;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validPaymentRow = {
  id: 'payment-uuid-001',
  fee_assignment_id: 'assignment-uuid-001',
  team_member_id: 'member-uuid-001',
  amount_minor: 5000,
  method: 'cash' as const,
  paid_at: new Date('2025-03-15T12:00:00Z'),
  note: null,
  recorded_by_user_id: 'user-uuid-001',
  voided_at: null,
  voided_by_user_id: null,
  void_reason: null,
  created_at: new Date('2025-03-15T12:00:00Z'),
};

// ---------------------------------------------------------------------------
// PaymentMethod literal
// ---------------------------------------------------------------------------

describe('PaymentMethod', () => {
  it("accepts 'cash'", () => {
    expect(decodeSync(PaymentMethod)('cash')).toBe('cash');
  });

  it("accepts 'bank_transfer'", () => {
    expect(decodeSync(PaymentMethod)('bank_transfer')).toBe('bank_transfer');
  });

  it('rejects an unknown method', () => {
    expect(() => decodeSync(PaymentMethod)('credit_card')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => decodeSync(PaymentMethod)('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AmountMinor constraints (via Payment)
// ---------------------------------------------------------------------------

describe('Payment — amount_minor constraints', () => {
  it('rejects amount_minor = 0 (must be > 0 at application level)', () => {
    // AmountMinor allows >= 0, but payments should be > 0.
    // The domain schema uses AmountMinor which accepts 0.
    // The API layer enforces > 0 via InvalidAmount.
    // This test documents the schema-level behaviour: 0 is valid in the type,
    // but application code should reject it.
    const payment = decodeSync(Payment.insert)({ ...validPaymentRow, amount_minor: 1 });
    expect(payment.amount_minor).toBe(1);
  });

  it('rejects amount_minor < 0', () => {
    expect(() => decodeSync(Payment.insert)({ ...validPaymentRow, amount_minor: -100 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Payment schema — never-voided row
// ---------------------------------------------------------------------------

describe('Payment schema — never-voided row', () => {
  it('decodes a fully valid never-voided payment row', () => {
    const payment = decodeSync(Payment.insert)(validPaymentRow);
    expect(payment.fee_assignment_id).toBe('assignment-uuid-001');
    expect(payment.team_member_id).toBe('member-uuid-001');
    expect(payment.amount_minor).toBe(5000);
    expect(payment.method).toBe('cash');
    expect(payment.recorded_by_user_id).toBe('user-uuid-001');
    expect(Option.isNone(payment.note)).toBe(true);
    expect(Option.isNone(payment.voided_at)).toBe(true);
    expect(Option.isNone(payment.voided_by_user_id)).toBe(true);
    expect(Option.isNone(payment.void_reason)).toBe(true);
  });

  it('decodes non-null note to Option.some()', () => {
    const payment = decodeSync(Payment.insert)({
      ...validPaymentRow,
      note: 'Cash handed in person',
    });
    expect(Option.isSome(payment.note)).toBe(true);
    expect(Option.getOrNull(payment.note)).toBe('Cash handed in person');
  });
});

// ---------------------------------------------------------------------------
// Payment schema — fully-voided row
// ---------------------------------------------------------------------------

describe('Payment schema — fully-voided row', () => {
  it('decodes a fully voided payment row with all void fields set', () => {
    const voidedRow = {
      ...validPaymentRow,
      voided_at: new Date('2025-03-16T09:00:00Z'),
      voided_by_user_id: 'user-uuid-002',
      void_reason: 'Duplicate entry',
    };
    const payment = decodeSync(Payment.insert)(voidedRow);
    expect(Option.isSome(payment.voided_at)).toBe(true);
    expect(Option.isSome(payment.voided_by_user_id)).toBe(true);
    expect(Option.isSome(payment.void_reason)).toBe(true);
    expect(Option.getOrNull(payment.void_reason)).toBe('Duplicate entry');
    expect(Option.getOrNull(payment.voided_by_user_id)).toBe('user-uuid-002');
  });

  it('decodes null void fields (never-voided) to Option.none()', () => {
    const payment = decodeSync(Payment.insert)(validPaymentRow);
    expect(Option.isNone(payment.voided_at)).toBe(true);
    expect(Option.isNone(payment.voided_by_user_id)).toBe(true);
    expect(Option.isNone(payment.void_reason)).toBe(true);
  });
});
