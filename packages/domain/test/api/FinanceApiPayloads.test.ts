// Payload / response round-trips for the settle-all + credit endpoints.
//
// T3.1/T3.2 guard against the UpdateMemberEventPreferences regression (see
// TeamApiPayloads.test.ts): a request payload declared as Schema.Class rather than
// Schema.Struct fails to ENCODE the plain object literal every call site sends, so the
// client never issues the request at all — a generic "couldn't save" toast with an empty
// Network tab.
//
// T2.4-equivalent for the tolerant reader lives in models/Payment.test.ts (PaymentView).
// This file pins the companion guarantee: the WRITE side stays closed — no client can ask
// for a 'credit' settlement/payment method, and amountMinor keeps its 0-is-legal /
// negative-is-rejected shape.
//
// Spec: .work-plans/finances/settle-all-and-credit-architecture.md §T3.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
  CreateSettlementRequest,
  RecordPaymentRequest,
  VoidCreditDepositRequest,
} from '~/api/FinanceApi.js';

const PAID_AT_ISO = '2025-03-15T12:00:00.000Z';

describe('CreateSettlementRequest', () => {
  // decode-direction payload: paidAt as the wire ISO string
  const validPayload = {
    currency: 'CZK',
    amountMinor: 1000,
    method: 'cash' as const,
    paidAt: PAID_AT_ISO,
    note: null,
    expectedOutstandingMinor: 1000,
  };

  it('3.1 — Schema.encodeSync on a decoded plain object literal succeeds (it is a Struct, not a Class)', () => {
    // Decode the wire-shaped literal first (branded fields like AmountMinor/CurrencyCode
    // cannot be produced as a raw object literal at the type level), then encode it back —
    // exercising Schema.encodeSync exactly as the HTTP API client does before every request.
    // A Schema.Class payload fails this round trip: encoding rejects the plain object shape.
    const decoded = Schema.decodeUnknownSync(CreateSettlementRequest)(validPayload);
    const encoded = Schema.encodeSync(CreateSettlementRequest)(decoded);
    expect(encoded).toEqual(validPayload);
  });

  it('accepts amountMinor: 0 — pure credit application, or a no-op', () => {
    const decoded = Schema.decodeUnknownSync(CreateSettlementRequest)({
      ...validPayload,
      amountMinor: 0,
    });
    expect(decoded.amountMinor).toBe(0);
  });

  it('rejects a negative amountMinor', () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateSettlementRequest)({ ...validPayload, amountMinor: -1 }),
    ).toThrow();
  });

  it('rejects a negative expectedOutstandingMinor', () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateSettlementRequest)({
        ...validPayload,
        expectedOutstandingMinor: -1,
      }),
    ).toThrow();
  });

  it("REJECTS method: 'credit' — the wire never accepts a client-minted credit payment", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateSettlementRequest)({ ...validPayload, method: 'credit' }),
    ).toThrow();
  });

  it("still accepts the manual methods 'cash' and 'bank_transfer'", () => {
    for (const method of ['cash', 'bank_transfer']) {
      const decoded = Schema.decodeUnknownSync(CreateSettlementRequest)({
        ...validPayload,
        method,
      });
      expect(decoded.method).toBe(method);
    }
  });
});

describe('RecordPaymentRequest', () => {
  const validPayload = {
    amountMinor: 1000,
    method: 'cash' as const,
    paidAt: PAID_AT_ISO,
    note: null,
  };

  it("REJECTS method: 'credit' — RecordPaymentRequest.method is ManualPaymentMethod, not PaymentMethod", () => {
    expect(() =>
      Schema.decodeUnknownSync(RecordPaymentRequest)({ ...validPayload, method: 'credit' }),
    ).toThrow();
  });

  it('decode-then-encode round-trips (it is a Struct)', () => {
    const decoded = Schema.decodeUnknownSync(RecordPaymentRequest)(validPayload);
    const encoded = Schema.encodeSync(RecordPaymentRequest)(decoded);
    expect(encoded).toEqual(validPayload);
  });
});

describe('VoidCreditDepositRequest', () => {
  it('3.2 — Schema.encodeSync on a plain object literal succeeds', () => {
    const payload = { reason: 'Recorded in error' };
    const encoded = Schema.encodeSync(VoidCreditDepositRequest)(payload);
    expect(encoded).toEqual(payload);
  });

  it('rejects an empty reason', () => {
    expect(() => Schema.decodeUnknownSync(VoidCreditDepositRequest)({ reason: '' })).toThrow();
  });
});
