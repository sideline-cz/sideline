// TDD — written before src/utils/planFeeImport.ts exists. Spec: .dev-loop/plan.md, Task 2.
import { describe, expect, it } from '@effect/vitest';
import { Fee, type FinanceApi, TeamMember } from '@sideline/domain';
import { DateTime, Option, Schema } from 'effect';
import { feeGroupKey, planFeeImport } from '~/utils/planFeeImport.js';

const memberId = Schema.decodeSync(TeamMember.TeamMemberId);
const amount = Schema.decodeSync(Fee.AmountMinor);
const currency = Schema.decodeSync(Fee.CurrencyCode);

const m1 = memberId('m1');
const m2 = memberId('m2');
const m3 = memberId('m3');
const m4 = memberId('m4');

const members = [
  { member_id: m1, username: 'alice' },
  { member_id: m2, username: 'bob' },
  { member_id: m3, username: 'twin' },
  { member_id: m4, username: 'twin' },
];

const due = Option.some(DateTime.makeUnsafe('2026-09-30T12:00:00Z'));

const row = (
  line: number,
  member: string,
  feeName: string,
  amountMinor: number,
  cur: string,
  dueAt: Option.Option<DateTime.Utc>,
): FinanceApi.FeeImportRow => ({
  line,
  member,
  feeName,
  amountMinor: amount(amountMinor),
  currency: currency(cur),
  dueAt,
});

describe('planFeeImport', () => {
  it('groups by (name, currency, dueAt), keeps per-row amounts and matches @/case-insensitively', () => {
    const plan = planFeeImport(
      [
        row(2, '@Alice', 'Fee A', 500, 'CZK', due),
        row(3, 'bob', 'Fee A', 700, 'CZK', due),
        row(4, 'alice', 'Fee A', 500, 'CZK', Option.none()),
        row(5, 'bob', 'Fee B', 300, 'EUR', Option.none()),
      ],
      members,
      new Set(),
    );

    expect(plan.errors).toEqual([]);
    expect(
      plan.fees.map((f) => ({
        name: f.name,
        currency: f.currency,
        dated: Option.isSome(f.dueAt),
        amountMinor: f.amountMinor,
        assignments: f.assignments,
      })),
    ).toEqual([
      {
        name: 'Fee A',
        currency: 'CZK',
        dated: true,
        amountMinor: 500,
        assignments: [
          { memberId: m1, amountMinor: 500 },
          { memberId: m2, amountMinor: 700 },
        ],
      },
      {
        name: 'Fee A',
        currency: 'CZK',
        dated: false,
        amountMinor: 500,
        assignments: [{ memberId: m1, amountMinor: 500 }],
      },
      {
        name: 'Fee B',
        currency: 'EUR',
        dated: false,
        amountMinor: 300,
        assignments: [{ memberId: m2, amountMinor: 300 }],
      },
    ]);
  });

  it('reports every server error code, one per row, and an error row reserves no member', () => {
    const plan = planFeeImport(
      [
        row(2, 'nobody', 'Fee A', 500, 'CZK', Option.none()),
        row(3, 'twin', 'Fee A', 500, 'CZK', Option.none()),
        row(4, 'alice', 'Fee A', 0, 'CZK', Option.none()),
        row(5, 'alice', 'Fee A', 500, 'CZK', Option.none()),
        row(6, 'ALICE', 'Fee A', 500, 'CZK', Option.none()),
        row(7, 'bob', 'Old', 500, 'CZK', Option.none()),
      ],
      members,
      new Set([feeGroupKey('Old', 'CZK', Option.none())]),
    );

    expect(plan.errors).toEqual([
      { line: 2, code: 'member_not_found' },
      { line: 3, code: 'member_ambiguous' },
      { line: 4, code: 'invalid_amount' },
      { line: 6, code: 'duplicate_member' },
      { line: 7, code: 'fee_exists' },
    ]);
  });
});
