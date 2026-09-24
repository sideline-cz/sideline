// Architecture `.work-plans/finances/settle-all-and-credit-architecture.md` §2.4 — the
// reconciliation identity. Never read at runtime; asserted by tests only.
//
// For every (team_member_id, currency) account row, the stored `balance_minor` must always
// equal "every non-voided deposit minus every non-voided credit-method payment". The balance is
// a stored column (not a SUM — §2.4 explains why a pure ledger cannot be made non-negative
// safely under READ COMMITTED), so this identity is the one assertion that would catch drift
// between the stored balance and the history that is supposed to explain it: a debit that forgot
// to write its payment row, a credit-add that forgot to bump the balance, a void that restored
// the wrong amount, etc. Call it at the end of EVERY credit test.

import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { expect } from 'vitest';

interface ReconciliationRow {
  readonly team_member_id: string;
  readonly currency: string;
  readonly diff: string;
}

export const assertCreditReconciles = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<ReconciliationRow>`
        SELECT a.team_member_id::text AS team_member_id,
               a.currency,
               (
                 a.balance_minor
                 - COALESCE((
                     SELECT SUM(d.amount_minor) FROM member_credit_deposits d
                      WHERE d.team_member_id = a.team_member_id AND d.currency = a.currency
                        AND d.voided_at IS NULL
                   ), 0)
                 + COALESCE((
                     SELECT SUM(p.amount_minor) FROM payments p
                       JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
                       JOIN fees f ON f.id = fa.fee_id
                      WHERE p.team_member_id = a.team_member_id AND f.currency = a.currency
                        AND p.method = 'credit' AND p.voided_at IS NULL
                   ), 0)
               )::text AS diff
          FROM member_credit_accounts a
      `,
    ),
    Effect.tap((rows) =>
      Effect.sync(() => {
        const drifted = rows.filter((row) => row.diff !== '0');
        expect(
          drifted,
          `credit reconciliation identity (§2.4) drifted for: ${JSON.stringify(drifted)}`,
        ).toEqual([]);
      }),
    ),
    Effect.asVoid,
  );
