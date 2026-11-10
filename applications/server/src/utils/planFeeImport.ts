/**
 * Pure planner for the bulk fee import. No Effect, no DB — see `test/planFeeImport.test.ts`.
 * Groups CSV rows into fees by `(name, currency, dueAt)` and returns one error per bad row.
 */
import type { Fee, FinanceApi, TeamMember } from '@sideline/domain';
import { DateTime, Option } from 'effect';

export const feeGroupKey = (
  name: string,
  currency: string,
  dueAt: Option.Option<DateTime.Utc>,
): string =>
  `${name}\u0000${currency}\u0000${Option.match(dueAt, {
    onNone: () => 'none',
    onSome: (d) => String(DateTime.toEpochMillis(d)),
  })}`;

export interface ImportMember {
  readonly member_id: TeamMember.TeamMemberId;
  readonly username: string;
}

export interface PlannedAssignment {
  readonly memberId: TeamMember.TeamMemberId;
  readonly amountMinor: Fee.AmountMinor;
}

export interface PlannedFee {
  readonly name: string;
  readonly currency: Fee.CurrencyCode;
  readonly dueAt: Option.Option<DateTime.Utc>;
  // amount of the first row of the group
  readonly amountMinor: Fee.AmountMinor;
  readonly assignments: ReadonlyArray<PlannedAssignment>;
}

const normalise = (username: string): string => username.trim().replace(/^@/, '').toLowerCase();

export const planFeeImport = (
  rows: ReadonlyArray<FinanceApi.FeeImportRow>,
  members: ReadonlyArray<ImportMember>,
  existingFeeKeys: ReadonlySet<string>,
): {
  readonly fees: ReadonlyArray<PlannedFee>;
  readonly errors: ReadonlyArray<FinanceApi.FeeImportRowError>;
} => {
  // `users.username` is not unique: a second active member with the same name marks it ambiguous
  const byUsername = new Map<string, TeamMember.TeamMemberId | 'ambiguous'>();
  for (const m of members) {
    const key = normalise(m.username);
    byUsername.set(key, byUsername.has(key) ? 'ambiguous' : m.member_id);
  }

  const groups = new Map<string, PlannedFee & { readonly assignments: Array<PlannedAssignment> }>();
  const errors: Array<FinanceApi.FeeImportRowError> = [];

  for (const row of rows) {
    const key = feeGroupKey(row.feeName, row.currency, row.dueAt);
    const memberId = byUsername.get(normalise(row.member));
    const group = groups.get(key);

    if (row.amountMinor === 0) {
      errors.push({ line: row.line, code: 'invalid_amount' });
    } else if (memberId === undefined) {
      errors.push({ line: row.line, code: 'member_not_found' });
    } else if (memberId === 'ambiguous') {
      errors.push({ line: row.line, code: 'member_ambiguous' });
    } else if (existingFeeKeys.has(key)) {
      errors.push({ line: row.line, code: 'fee_exists' });
    } else if (group?.assignments.some((a) => a.memberId === memberId)) {
      errors.push({ line: row.line, code: 'duplicate_member' });
    } else {
      const assignment = { memberId, amountMinor: row.amountMinor };
      if (group) {
        group.assignments.push(assignment);
      } else {
        groups.set(key, {
          name: row.feeName,
          currency: row.currency,
          dueAt: row.dueAt,
          amountMinor: row.amountMinor,
          assignments: [assignment],
        });
      }
    }
  }

  return { fees: [...groups.values()], errors };
};
