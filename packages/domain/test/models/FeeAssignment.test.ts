// TDD mode — tests for FeeAssignment domain schema.
// These should pass once the schema is in place.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import {
  FeeAssignment,
  FeeAssignmentStatus,
  StoredAssignmentStatus,
} from '~/models/FeeAssignment.js';

const decodeSync = Schema.decodeUnknownSync;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validAssignmentRow = {
  id: 'assignment-uuid-001',
  fee_id: 'fee-uuid-001',
  team_member_id: 'member-uuid-001',
  amount_minor: 5000,
  paid_minor: 0,
  due_at: null,
  stored_status: 'active' as const,
  waived_reason: null,
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
};

// ---------------------------------------------------------------------------
// FeeAssignmentStatus literal
// ---------------------------------------------------------------------------

describe('FeeAssignmentStatus', () => {
  it.each([
    'pending',
    'partial',
    'paid',
    'overdue',
    'waived',
  ] as const)("accepts status '%s'", (status) => {
    expect(decodeSync(FeeAssignmentStatus)(status)).toBe(status);
  });

  it('rejects an unknown status', () => {
    expect(() => decodeSync(FeeAssignmentStatus)('cancelled')).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => decodeSync(FeeAssignmentStatus)('')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// StoredAssignmentStatus literal
// ---------------------------------------------------------------------------

describe('StoredAssignmentStatus', () => {
  it("accepts 'active'", () => {
    expect(decodeSync(StoredAssignmentStatus)('active')).toBe('active');
  });

  it("accepts 'waived'", () => {
    expect(decodeSync(StoredAssignmentStatus)('waived')).toBe('waived');
  });

  it("rejects 'pending' (not a stored status)", () => {
    expect(() => decodeSync(StoredAssignmentStatus)('pending')).toThrow();
  });

  it("rejects 'paid' (not a stored status)", () => {
    expect(() => decodeSync(StoredAssignmentStatus)('paid')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FeeAssignment schema decoding
// ---------------------------------------------------------------------------

describe('FeeAssignment schema', () => {
  it('decodes from a view-shaped row with all required fields', () => {
    const assignment = decodeSync(FeeAssignment.insert)(validAssignmentRow);
    expect(assignment.fee_id).toBe('fee-uuid-001');
    expect(assignment.team_member_id).toBe('member-uuid-001');
    expect(assignment.amount_minor).toBe(5000);
    expect(assignment.paid_minor).toBe(0);
    expect(assignment.stored_status).toBe('active');
    expect(Option.isNone(assignment.due_at)).toBe(true);
    expect(Option.isNone(assignment.waived_reason)).toBe(true);
  });

  it('decodes non-null waived_reason to Option.some()', () => {
    const assignment = decodeSync(FeeAssignment.insert)({
      ...validAssignmentRow,
      stored_status: 'waived',
      waived_reason: 'Scholarship exemption',
    });
    expect(assignment.stored_status).toBe('waived');
    expect(Option.isSome(assignment.waived_reason)).toBe(true);
    expect(Option.getOrNull(assignment.waived_reason)).toBe('Scholarship exemption');
  });

  it('decodes null waived_reason to Option.none()', () => {
    const assignment = decodeSync(FeeAssignment.insert)({
      ...validAssignmentRow,
      waived_reason: null,
    });
    expect(Option.isNone(assignment.waived_reason)).toBe(true);
  });

  it('rejects negative amount_minor', () => {
    expect(() =>
      decodeSync(FeeAssignment.insert)({ ...validAssignmentRow, amount_minor: -1 }),
    ).toThrow();
  });

  it('rejects negative paid_minor', () => {
    expect(() =>
      decodeSync(FeeAssignment.insert)({ ...validAssignmentRow, paid_minor: -1 }),
    ).toThrow();
  });
});
