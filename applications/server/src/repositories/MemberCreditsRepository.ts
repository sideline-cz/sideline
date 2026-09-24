/**
 * Plan `.work-plans/finances/settle-all-and-credit-architecture.md` §5, §5.3, §5.3b — "settle-all
 * + pay in advance (credit)". Mirrors `BankTransactionMatcher.ts`'s `export const make = (options)
 * => ...` / `static readonly Default = Layer.effect(MemberCreditsRepository, make())` split, so a
 * test can bind a second, option-carrying instance to a second connection for a genuine
 * two-connection race.
 *
 * Lock order (root `AGENTS.md` invariant 2, restated in §3): `settle` takes exactly ONE
 * `member_credit_accounts` row, team-scoped, `FOR UPDATE OF a` — before any `fee_assignments`
 * lock. `voidDeposit` takes the account lock before the deposit read. Neither ever takes a bare
 * `FOR UPDATE` that would pull `team_members` into the lock order.
 */
import {
  type Auth,
  Fee,
  FeeAssignment,
  FinanceApi,
  MemberCredit,
  Payment,
  SettlementPlan,
  type Team,
  TeamMember,
} from '@sideline/domain';
import * as Schemas from '@sideline/effect-lib/Schemas';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

interface AssignmentLockRow {
  readonly id: string;
  readonly fee_id: string;
  readonly fee_name: string;
  readonly amount_minor: string;
  readonly paid_minor: string;
  readonly effective_due_at: Date | null;
}

export class MemberCreditDepositRow extends Schema.Class<MemberCreditDepositRow>(
  'MemberCreditDepositRow',
)({
  id: MemberCredit.MemberCreditDepositId,
  team_member_id: TeamMember.TeamMemberId,
  currency: Fee.CurrencyCode,
  amount_minor: Fee.AmountMinor,
  method: Payment.ManualPaymentMethod,
  paid_at: Schemas.DateTimeFromDate,
  note: Schema.OptionFromNullOr(Schema.String),
  recorder_name: Schema.OptionFromNullOr(Schema.String),
  voided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  void_reason: Schema.OptionFromNullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface MemberCreditsRepositoryOptions {
  /** Test-only seam: runs INSIDE settle's transaction, immediately AFTER the
   *  member_credit_accounts lock and BEFORE the fee_assignments lock. Defaults to Effect.void. */
  readonly afterAccountLock?: Effect.Effect<void>;
  /** Test-only seam: runs INSIDE settle's transaction, AFTER the fee_assignments lock
   *  and BEFORE any write. Failing here is how the atomicity tests prove nothing is
   *  written. Defaults to Effect.void. */
  readonly afterAssignmentLock?: Effect.Effect<void>;
}

export interface SettleInput {
  readonly teamId: Team.TeamId;
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly currency: Fee.CurrencyCode;
  readonly amountMinor: number;
  readonly method: Payment.ManualPaymentMethod;
  readonly paidAt: DateTime.Utc;
  readonly note: Option.Option<string>;
  readonly expectedOutstandingMinor: number;
  readonly recordedByUserId: Auth.UserId;
}

export interface SettleAllocation {
  readonly assignmentId: FeeAssignment.FeeAssignmentId;
  readonly feeId: Fee.FeeId;
  readonly feeName: string;
  readonly amountMinor: number;
  readonly source: 'payment' | 'credit';
  readonly statusAfter: FeeAssignment.FeeAssignmentStatus;
  readonly paymentId: Payment.PaymentId;
}

export interface SettleResult {
  readonly currency: Fee.CurrencyCode;
  readonly creditAppliedMinor: number;
  readonly paidMinor: number;
  readonly creditAddedMinor: number;
  readonly creditBalanceAfterMinor: number;
  readonly allocations: ReadonlyArray<SettleAllocation>;
}

export interface VoidDepositInput {
  readonly teamId: Team.TeamId;
  readonly memberId: TeamMember.TeamMemberId;
  readonly depositId: MemberCredit.MemberCreditDepositId;
  readonly voidedByUserId: Auth.UserId;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

export const make = (options: MemberCreditsRepositoryOptions = {}) =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.map(({ sql }) => {
      const afterAccountLockSeam = options.afterAccountLock ?? Effect.void;
      const afterAssignmentLockSeam = options.afterAssignmentLock ?? Effect.void;

      // -----------------------------------------------------------------
      // settle
      // -----------------------------------------------------------------

      const settle = (
        input: SettleInput,
      ): Effect.Effect<
        SettleResult,
        | FinanceApi.FinanceMemberNotFound
        | FinanceApi.SettlementStale
        | FinanceApi.InsufficientCredit
      > => {
        // Step 0 — membership check + account row. The INSERT's SELECT is the team-ownership
        // check; ON CONFLICT makes it idempotent.
        const upsertAccount = () => sql`
          INSERT INTO member_credit_accounts (team_member_id, currency)
          SELECT tm.id, ${input.currency}
            FROM team_members tm
           WHERE tm.id = ${input.teamMemberId} AND tm.team_id = ${input.teamId}
          ON CONFLICT (team_member_id, currency) DO NOTHING
        `;

        // Step 1 — LOCK member_credit_accounts, TEAM-SCOPED. The JOIN is the authorization
        // boundary (§5.1 step 1): without it, an account row that already exists from a prior
        // LEGITIMATE settlement inside the member's real team would let a foreign team's
        // treasurer deposit credit onto them. FOR UPDATE OF a, never a bare FOR UPDATE — that
        // would pull team_members into the lock order (§3).
        const lockAccount = () =>
          sql<{ balance_minor: string }>`
            SELECT a.balance_minor::text AS balance_minor
              FROM member_credit_accounts a
              JOIN team_members tm ON tm.id = a.team_member_id
             WHERE a.team_member_id = ${input.teamMemberId}
               AND tm.team_id       = ${input.teamId}
               AND a.currency       = ${input.currency}
             FOR UPDATE OF a
          `.pipe(
            Effect.flatMap((rows) => {
              const row = rows[0];
              return row === undefined
                ? Effect.fail(new FinanceApi.FinanceMemberNotFound())
                : Effect.succeed(Number(row.balance_minor));
            }),
          );

        // Step 2 — LOCK candidate fee_assignments, id ASC (NOT due date — that ordering is what
        // keeps this deadlock-free against the bank matcher, §3.1). Base tables, not the view: a
        // view row cannot be locked. Excludes waived (stored_status), paid (amount > paid), and
        // archived-fee (f.archived_at) rows, and never sums currencies (f.currency).
        const lockAssignments = () =>
          sql<AssignmentLockRow>`
            SELECT fa.id::text                       AS id,
                   fa.fee_id::text                   AS fee_id,
                   f.name                            AS fee_name,
                   fa.amount_minor::text              AS amount_minor,
                   fa.paid_minor::text                AS paid_minor,
                   COALESCE(fa.due_at, f.due_at)      AS effective_due_at
              FROM fee_assignments fa
              JOIN fees f ON f.id = fa.fee_id
             WHERE fa.team_member_id = ${input.teamMemberId}
               AND f.team_id         = ${input.teamId}
               AND f.currency        = ${input.currency}
               AND f.archived_at IS NULL
               AND fa.stored_status  = 'active'
               AND fa.amount_minor   > fa.paid_minor
             ORDER BY fa.id ASC
             FOR UPDATE OF fa
          `;

        // Locks are taken fa.id ASC (matching every other money path); allocation walks
        // effectiveDueAt ASC / None last / id tie-break. Safe because step 2 already holds
        // EVERY lock this transaction will take on fee_assignments — the allocation order is a
        // pure in-memory decision after that point.
        const buildPlan = (
          candidates: ReadonlyArray<AssignmentLockRow>,
          balanceMinor: number,
        ): Effect.Effect<SettlementPlan.SettlementPlan, FinanceApi.SettlementStale> => {
          const settlementCandidates: ReadonlyArray<SettlementPlan.SettlementCandidate> =
            candidates.map((row) => ({
              assignmentId: row.id,
              feeId: row.fee_id,
              feeName: row.fee_name,
              dueMinor: Number(row.amount_minor),
              paidMinor: Number(row.paid_minor),
              effectiveDueAt: Option.fromNullishOr(row.effective_due_at).pipe(
                Option.map((d) => d.getTime()),
              ),
            }));
          const outstandingMinor = settlementCandidates.reduce(
            (sum, c) => sum + Math.max(0, c.dueMinor - c.paidMinor),
            0,
          );
          return outstandingMinor !== input.expectedOutstandingMinor
            ? Effect.fail(new FinanceApi.SettlementStale({ outstandingMinor }))
            : Effect.succeed(
                SettlementPlan.planSettlement(
                  settlementCandidates,
                  balanceMinor,
                  input.amountMinor,
                ),
              );
        };

        // Step 3 — debit, only when plan.creditAppliedMinor > 0. Conditional UPDATE, never
        // SELECT-then-UPDATE (§2.4). Unreachable while step 1's lock is held; kept because it is
        // what makes voidDeposit correct and what would still be correct if the explicit lock
        // were ever removed.
        const maybeDebit = (plan: SettlementPlan.SettlementPlan) =>
          plan.creditAppliedMinor <= 0
            ? Effect.void
            : sql<{ team_member_id: string }>`
                UPDATE member_credit_accounts
                   SET balance_minor = balance_minor - ${plan.creditAppliedMinor}, updated_at = now()
                 WHERE team_member_id = ${input.teamMemberId} AND currency = ${input.currency}
                   AND balance_minor >= ${plan.creditAppliedMinor}
                 RETURNING team_member_id
              `.pipe(
                Effect.flatMap((rows) =>
                  rows.length === 0
                    ? Effect.fail(new FinanceApi.InsufficientCredit())
                    : Effect.void,
                ),
              );

        // Step 4 — payments, ONE multi-row VALUES insert (AGENTS.md "Multi-row VALUES
        // inserts" — sql.join(',', false), never the addParens default). EVERY plan line becomes
        // a payments row: a 'credit'-source line is the credit-application payment (§1, design
        // (B)); a 'payment'-source line uses the caller's chosen ManualPaymentMethod. The trigger
        // recomputes paid_minor for assignments we already hold locks on (re-entrant). Never a
        // zero-amount row — planSettlement never emits one.
        const maybeInsertPayments = (lines: ReadonlyArray<SettlementPlan.SettlementLine>) => {
          if (lines.length === 0) return Effect.succeed(new Map<string, string>());
          const rows = lines.map(
            (line) => sql`(
              ${line.assignmentId}, ${input.teamMemberId}, ${line.amountMinor},
              ${line.source === 'credit' ? 'credit' : input.method},
              ${input.paidAt}, ${Option.getOrNull(input.note)}, ${input.recordedByUserId}
            )`,
          );
          return sql<{ id: string; fee_assignment_id: string; method: string }>`
            INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, note, recorded_by_user_id)
            VALUES ${sql.join(',', false)(rows)}
            RETURNING id::text AS id, fee_assignment_id::text AS fee_assignment_id, method
          `.pipe(
            // (assignmentId, method) is a unique key within one settle call: planSettlement
            // emits at most one 'credit' line and one 'payment' line per assignment, and every
            // 'payment' line shares the same caller-chosen method.
            Effect.map((returned) => {
              const map = new Map<string, string>();
              for (const row of returned)
                map.set(`${row.fee_assignment_id}::${row.method}`, row.id);
              return map;
            }),
          );
        };

        // Step 5 — credit ADD, only when plan.creditAddedMinor > 0 (leftover cash after every
        // outstanding fee is covered — "pay in advance" is this step alone, with empty
        // candidates).
        const maybeAddCredit = (plan: SettlementPlan.SettlementPlan) =>
          plan.creditAddedMinor <= 0
            ? Effect.void
            : sql`
                UPDATE member_credit_accounts
                   SET balance_minor = balance_minor + ${plan.creditAddedMinor}, updated_at = now()
                 WHERE team_member_id = ${input.teamMemberId} AND currency = ${input.currency}
              `.pipe(
                Effect.flatMap(
                  () => sql`
                    INSERT INTO member_credit_deposits
                      (team_member_id, currency, amount_minor, method, paid_at, note, recorded_by_user_id)
                    VALUES (
                      ${input.teamMemberId}, ${input.currency}, ${plan.creditAddedMinor},
                      ${input.method}, ${input.paidAt}, ${Option.getOrNull(input.note)},
                      ${input.recordedByUserId}
                    )
                  `,
                ),
                Effect.asVoid,
              );

        // Step 6 — statusAfter for the response.
        const maybeFetchStatuses = (lines: ReadonlyArray<SettlementPlan.SettlementLine>) => {
          const ids = [...new Set(lines.map((line) => line.assignmentId))];
          if (ids.length === 0) return Effect.succeed(new Map<string, string>());
          return sql<{ assignment_id: string; status: string }>`
            SELECT v.assignment_id::text AS assignment_id, v.status
              FROM fee_assignment_status_v v
             WHERE v.assignment_id = ANY(${ids}::uuid[])
          `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.assignment_id, row.status]))));
        };

        // Step 7 — balance for the response.
        const fetchBalance = () =>
          sql<{ balance_minor: string }>`
            SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
             WHERE team_member_id = ${input.teamMemberId} AND currency = ${input.currency}
          `.pipe(Effect.map((rows) => Number(rows[0]?.balance_minor ?? 0)));

        const toSettleResult = (
          plan: SettlementPlan.SettlementPlan,
          paymentIdByKey: ReadonlyMap<string, string>,
          statusByAssignment: ReadonlyMap<string, string>,
          creditBalanceAfterMinor: number,
        ): SettleResult => {
          const paidMinor = plan.lines
            .filter((line) => line.source === 'payment')
            .reduce((sum, line) => sum + line.amountMinor, 0);
          const allocations = plan.lines.map((line): SettleAllocation => {
            const key = `${line.assignmentId}::${line.source === 'credit' ? 'credit' : input.method}`;
            const paymentId = paymentIdByKey.get(key);
            if (paymentId === undefined) {
              throw new Error(`settle: no payment row found for allocation key ${key}`);
            }
            const status = statusByAssignment.get(line.assignmentId) ?? 'pending';
            return {
              assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(line.assignmentId),
              feeId: Schema.decodeSync(Fee.FeeId)(line.feeId),
              feeName: line.feeName,
              amountMinor: line.amountMinor,
              source: line.source,
              statusAfter: Schema.decodeUnknownSync(FeeAssignment.FeeAssignmentStatus)(status),
              paymentId: Schema.decodeSync(Payment.PaymentId)(paymentId),
            };
          });
          return {
            currency: input.currency,
            creditAppliedMinor: plan.creditAppliedMinor,
            paidMinor,
            creditAddedMinor: plan.creditAddedMinor,
            creditBalanceAfterMinor,
            allocations,
          };
        };

        return sql
          .withTransaction(
            Effect.Do.pipe(
              Effect.tap(() => upsertAccount()),
              Effect.bind('balanceMinor', () => lockAccount()),
              Effect.tap(() => afterAccountLockSeam),
              Effect.bind('candidates', () => lockAssignments()),
              Effect.tap(() => afterAssignmentLockSeam),
              Effect.bind('plan', ({ balanceMinor, candidates }) =>
                buildPlan(candidates, balanceMinor),
              ),
              Effect.tap(({ plan }) => maybeDebit(plan)),
              Effect.bind('paymentIdByKey', ({ plan }) => maybeInsertPayments(plan.lines)),
              Effect.tap(({ plan }) => maybeAddCredit(plan)),
              Effect.bind('statusByAssignment', ({ plan }) => maybeFetchStatuses(plan.lines)),
              Effect.bind('creditBalanceAfterMinor', () => fetchBalance()),
              Effect.map(({ plan, paymentIdByKey, statusByAssignment, creditBalanceAfterMinor }) =>
                toSettleResult(plan, paymentIdByKey, statusByAssignment, creditBalanceAfterMinor),
              ),
            ),
          )
          .pipe(catchSqlErrors);
      };

      // -----------------------------------------------------------------
      // voidDeposit
      // -----------------------------------------------------------------

      const voidDeposit = (
        input: VoidDepositInput,
      ): Effect.Effect<void, FinanceApi.CreditDepositNotFound | FinanceApi.CreditDepositSpent> =>
        sql
          .withTransaction(
            Effect.Do.pipe(
              // 1. LOCK — the account behind the deposit, team-scoped, before anything else.
              Effect.tap(
                () => sql`
                  SELECT 1 FROM member_credit_accounts a
                   WHERE (a.team_member_id, a.currency) IN (
                     SELECT d.team_member_id, d.currency
                       FROM member_credit_deposits d
                       JOIN team_members tm ON tm.id = d.team_member_id
                      WHERE d.id = ${input.depositId} AND tm.team_id = ${input.teamId})
                   ORDER BY a.team_member_id, a.currency
                   FOR UPDATE OF a
                `,
              ),
              // 2. the deposit itself, team-scoped through team_members (the authz check).
              Effect.bind('deposit', () =>
                sql<{ team_member_id: string; currency: string; amount_minor: string }>`
                  SELECT d.team_member_id::text AS team_member_id, d.currency,
                         d.amount_minor::text AS amount_minor
                    FROM member_credit_deposits d
                    JOIN team_members tm ON tm.id = d.team_member_id
                   WHERE d.id = ${input.depositId} AND tm.team_id = ${input.teamId}
                     AND d.voided_at IS NULL
                `.pipe(
                  Effect.flatMap((rows) => {
                    const row = rows[0];
                    return row === undefined
                      ? Effect.fail(new FinanceApi.CreditDepositNotFound())
                      : Effect.succeed(row);
                  }),
                ),
              ),
              // 3. take the money back out — refused if it has already been spent. Deposits are
              // FUNGIBLE: nothing records which deposit funded which application, so the only
              // honest answer to "void a deposit whose money is already on a fee" is "void those
              // payments first".
              Effect.tap(({ deposit }) =>
                sql<{ team_member_id: string }>`
                  UPDATE member_credit_accounts
                     SET balance_minor = balance_minor - ${deposit.amount_minor}::bigint, updated_at = now()
                   WHERE team_member_id = ${deposit.team_member_id} AND currency = ${deposit.currency}
                     AND balance_minor >= ${deposit.amount_minor}::bigint
                   RETURNING team_member_id
                `.pipe(
                  Effect.flatMap((rows) =>
                    rows.length === 0
                      ? Effect.fail(new FinanceApi.CreditDepositSpent())
                      : Effect.void,
                  ),
                ),
              ),
              // 4. stamp the void — 0 rows means it lost the race with a concurrent void.
              Effect.tap(() =>
                sql<{ id: string }>`
                  UPDATE member_credit_deposits
                     SET voided_at = now(), voided_by_user_id = ${input.voidedByUserId},
                         void_reason = ${input.reason}
                   WHERE id = ${input.depositId} AND voided_at IS NULL
                   RETURNING id
                `.pipe(
                  Effect.flatMap((rows) =>
                    rows.length === 0
                      ? Effect.fail(new FinanceApi.CreditDepositNotFound())
                      : Effect.void,
                  ),
                ),
              ),
              Effect.asVoid,
            ),
          )
          .pipe(catchSqlErrors);

      // -----------------------------------------------------------------
      // Reads — §5.3b. Neither takes a lock; neither belongs in the lock-order table.
      // -----------------------------------------------------------------

      /** Every currency in which this member holds a balance. Feeds myStatus.creditMinor. */
      const listAccountsByMember = (teamMemberId: TeamMember.TeamMemberId) =>
        sql<{ currency: string; balance_minor: string }>`
          SELECT currency, balance_minor::text AS balance_minor
            FROM member_credit_accounts
           WHERE team_member_id = ${teamMemberId}
           ORDER BY currency ASC
        `.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              currency: Schema.decodeSync(Fee.CurrencyCode)(row.currency),
              balanceMinor: Number(row.balance_minor),
            })),
          ),
          catchSqlErrors,
        );

      /** Credit-add history for the popover. Team-scoped through team_members, exactly as
       * PaymentsRepository.listByTeam scopes through fees. */
      const listDepositsByMember = (input: {
        teamId: Team.TeamId;
        teamMemberId: TeamMember.TeamMemberId;
        currency: Fee.CurrencyCode;
        includeVoided: boolean;
      }) =>
        sql`
          SELECT d.id, d.team_member_id, d.currency, d.amount_minor, d.method, d.paid_at, d.note,
                 ru.name AS recorder_name, d.voided_at, d.void_reason
            FROM member_credit_deposits d
            JOIN team_members tm ON tm.id = d.team_member_id
            LEFT JOIN users ru ON ru.id = d.recorded_by_user_id
           WHERE tm.team_id = ${input.teamId}
             AND d.team_member_id = ${input.teamMemberId}
             AND d.currency = ${input.currency}
             AND (${input.includeVoided} OR d.voided_at IS NULL)
           ORDER BY d.created_at DESC
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MemberCreditDepositRow))),
          catchSqlErrors,
        );

      return { settle, voidDeposit, listAccountsByMember, listDepositsByMember };
    }),
  );

export class MemberCreditsRepository extends ServiceMap.Service<
  MemberCreditsRepository,
  Effect.Success<ReturnType<typeof make>>
>()('api/MemberCreditsRepository') {
  static readonly Default = Layer.effect(MemberCreditsRepository, make());
}
