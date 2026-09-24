/**
 * Plan `.work-plans/fio-transaction-matching.md` §4 ("The matching engine") / D10c. The impure
 * shell around the pure `matchDecision.decide`: resolves the member from the VS, fetches
 * candidate assignments from `fee_assignment_status_v`, runs the step-2.5 duplicate pre-check,
 * folds counterparty/member names, then writes under the canonical lock order.
 *
 * **Lock order, always: `payments` (by id ASC) -> `bank_transactions` (by id) ->
 * `fee_assignments` (by id ASC).** (D10c)
 *
 * This service deliberately does NOT depend on the ambient `BankTransactionsRepository` /
 * `PaymentsRepository.insert` for its OWN reads/writes inside `matchOne` — every query must run
 * on the SAME connection that holds this call's row locks (proven by test 139: two matchers
 * constructed on two independent connections must never cross-contaminate). `sql` is captured
 * once at construction and every query in `matchOne` closes over that exact value. `unmatch`
 * (never exercised across two connections in the test suite) uses `PaymentsRepository.void_` —
 * resolved lazily, inside `unmatch`'s own body — matching the plan's explicit instruction that
 * `/unmatch` voids payments via that repository method, never a hard delete.
 */
import { type Auth, type BankTransaction, Payment } from '@sideline/domain';
import { Data, DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import {
  decide,
  type MatchCandidate,
  type MatchDecisionInput,
  type MemberResolution,
} from '~/services/matchDecision.js';

export interface MatchOutcome {
  readonly _tag: 'AutoMatched' | 'Queued';
  readonly matchReason?: BankTransaction.BankTransactionMatchReason;
}

export interface BankTransactionMatcherOptions {
  /** Test-only seam (§7.2 test 139/140): runs right after candidate assignments are read and
   * BEFORE the locking transaction begins. Defaults to `Effect.void`. */
  readonly afterCandidateRead?: Effect.Effect<void>;
}

export interface UnmatchInput {
  readonly reason: string;
  readonly unmatchedByUserId: Auth.UserId;
  /** Test-only seam (test 140b), mirroring `afterCandidateRead`: runs INSIDE the same
   * transaction, right after every linked payment has been voided and BEFORE
   * `bank_transactions` is updated. Defaults to `Effect.void`. */
  readonly afterVoids?: Effect.Effect<void>;
  /** Test-only seam (test 140b): runs INSIDE the same transaction, at the very top, BEFORE the
   * `paymentIds` SELECT — i.e. before this call has taken a single lock. `afterVoids` fires too
   * late for a genuine lock-order race: by then this call already holds every lock it will ever
   * take (payments, and — transitively, via each void's `payments_finance_recompute` trigger —
   * bank_transactions and fee_assignments too), so a concurrent `voidPayment` on the same row can
   * only block on an already-fully-locked resource, never race it. Parking here, with zero locks
   * held, is what makes the two connections' relative SQL execution order a genuine race rather
   * than a scripted sequence — able to reproduce the 40P01 a `bank_transactions`-before-`payments`
   * regression would cause. Defaults to `Effect.void`. */
  readonly beforeVoids?: Effect.Effect<void>;
}

export class UnmatchReasonTooShort extends Data.TaggedError('UnmatchReasonTooShort')<{}> {}

const FALLBACK_ZONE = 'Europe/Prague';

/** D14 — `paid_at` is `booked_on` at noon in the team's timezone. Noon dodges every DST edge (no
 * zone has a 12-hour shift). Mirrors `utils/seriesOccurrence.ts`'s `makeZoned(...,
 * {adjustForTimeZone:true})` pattern — never anchor at midnight UTC and `setParts`. */
const noonInTeamTz = (bookedOn: string, timezone: string): DateTime.Utc => {
  const wallClock = `${bookedOn}T12:00:00`;
  const zoned = Option.getOrElse(
    DateTime.makeZoned(wallClock, { timeZone: timezone, adjustForTimeZone: true }),
    () => DateTime.makeZonedUnsafe(wallClock, { timeZone: FALLBACK_ZONE, adjustForTimeZone: true }),
  );
  return DateTime.toUtc(zoned);
};

/** [R2 — B-cut-3] Accent-folded exact-equality only, ~5 lines: NFD-decompose, strip combining
 * marks, lowercase, trim. Hints are NEVER sufficient to auto-match. */
const foldName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

const normalizeVs = (vs: string | null): string | null => {
  if (vs === null) return null;
  const stripped = vs.trim().replace(/^0+/, '');
  return stripped === '' ? null : stripped;
};

interface TxRow {
  readonly id: string;
  readonly team_id: string;
  readonly direction: string;
  readonly match_state: string;
  readonly auto_match_suppressed: boolean;
  readonly variable_symbol: string | null;
  readonly amount_minor: string;
  readonly currency: string;
  readonly booked_on: string;
  readonly fio_movement_id: string;
  readonly counterparty_name: string | null;
}

interface ConfigRow {
  readonly auto_match_enabled: boolean;
  readonly configured_by_user_id: string;
}

interface CandidateRow {
  readonly assignment_id: string;
  readonly currency: string;
  readonly outstanding_minor: string;
  readonly effective_due_at: Date | null;
}

interface ResolvedMember {
  readonly resolution: MemberResolution;
  readonly candidates: ReadonlyArray<MatchCandidate>;
}

const QUEUED: MatchOutcome = { _tag: 'Queued' };

export const make = (options: BankTransactionMatcherOptions = {}) =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.map(({ sql }) => {
      const afterCandidateRead = options.afterCandidateRead ?? Effect.void;

      // ---------------------------------------------------------------------
      // Reads
      // ---------------------------------------------------------------------

      const fetchCandidates = (memberId: string) =>
        sql<CandidateRow>`
          SELECT v.assignment_id::text AS assignment_id, v.currency,
                 (v.due_minor - v.paid_minor)::text AS outstanding_minor, v.effective_due_at
          FROM fee_assignment_status_v v
          JOIN fee_assignments fa ON fa.id = v.assignment_id
          JOIN fees f ON f.id = fa.fee_id
          WHERE v.team_member_id = ${memberId}::uuid
            AND v.status IN ('pending', 'partial', 'overdue')
            AND f.archived_at IS NULL
          ORDER BY v.effective_due_at ASC NULLS LAST, v.assignment_id ASC
        `.pipe(
          Effect.map((rows) =>
            rows.map(
              (r): MatchCandidate => ({
                assignmentId: r.assignment_id,
                currency: r.currency,
                outstandingMinor: Number(r.outstanding_minor),
                effectiveDueAt: Option.fromNullishOr(r.effective_due_at).pipe(
                  Option.map((d) => d.getTime()),
                ),
              }),
            ),
          ),
        );

      // Step 1 — resolve member by VS, with the VS-recycling guard ([R2 should-fix]) — step 2 —
      // candidate assignments, folded together since candidates require a resolved member.
      const resolveMemberAndCandidates = (tx: TxRow): Effect.Effect<ResolvedMember, SqlError> => {
        const vsNorm = normalizeVs(tx.variable_symbol);
        if (vsNorm === null) {
          return Effect.succeed({ resolution: { _tag: 'NoVs' }, candidates: [] });
        }
        return sql<{ readonly member_id: string; readonly name_fold: string | null }>`
          SELECT tm.id::text AS member_id,
                 COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS name_fold
          FROM team_members tm
          JOIN users u ON u.id = tm.user_id
          LEFT JOIN team_settings ts ON ts.team_id = tm.team_id
          WHERE tm.team_id = ${tx.team_id}::uuid
            AND NULLIF(ltrim(tm.variable_symbol, '0'), '') = ${vsNorm}
            AND ${tx.booked_on}::date >= (tm.joined_at AT TIME ZONE COALESCE(ts.timezone, 'Europe/Prague'))::date - 30
        `.pipe(
          Effect.flatMap((memberRows): Effect.Effect<ResolvedMember, SqlError> => {
            if (memberRows.length === 0) {
              return Effect.succeed({ resolution: { _tag: 'NoMember' }, candidates: [] });
            }
            if (memberRows.length > 1) {
              return Effect.succeed({ resolution: { _tag: 'Ambiguous' }, candidates: [] });
            }
            const member = memberRows[0];
            if (member === undefined) {
              return Effect.succeed({ resolution: { _tag: 'NoMember' }, candidates: [] });
            }
            return fetchCandidates(member.member_id).pipe(
              Effect.map((candidates) => ({
                resolution: {
                  _tag: 'Resolved' as const,
                  memberId: member.member_id,
                  memberNameFold: Option.fromNullishOr(member.name_fold).pipe(Option.map(foldName)),
                },
                candidates,
              })),
            );
          }),
        );
      };

      // Step 2.5 — duplicate pre-check. Another INCOMING, already-MATCHED row in the same team,
      // same normalised VS, same amount, booked within +-7 days.
      const findDuplicate = (tx: TxRow) => {
        const vsNorm = normalizeVs(tx.variable_symbol);
        if (vsNorm === null) return Effect.succeed(Option.none());
        return sql<{ readonly id: string }>`
          SELECT id::text AS id FROM bank_transactions
          WHERE team_id = ${tx.team_id}::uuid AND id <> ${tx.id}::uuid
            AND direction = 'incoming' AND match_state = 'matched'
            AND amount_minor = ${tx.amount_minor}::bigint
            AND NULLIF(ltrim(variable_symbol, '0'), '') = ${vsNorm}
            AND booked_on BETWEEN ${tx.booked_on}::date - 7 AND ${tx.booked_on}::date + 7
          LIMIT 1
        `.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)));
      };

      // ---------------------------------------------------------------------
      // Writes
      // ---------------------------------------------------------------------

      const writeQueueEvidence = (
        txId: string,
        reason: BankTransaction.BankTransactionMatchReason,
        evidence: unknown,
      ) =>
        sql`
          UPDATE bank_transactions
          SET match_reason = ${reason}, match_evidence = ${JSON.stringify(evidence)}::jsonb, updated_at = now()
          WHERE id = ${txId}::uuid AND match_state = 'unmatched' AND auto_match_suppressed = false
        `.pipe(Effect.as<MatchOutcome>({ _tag: 'Queued', matchReason: reason }));

      // Step 4 — write, under the right locks. D10c: `bank_transactions` row FIRST, then every
      // candidate `fee_assignments` row `ORDER BY id FOR UPDATE`; re-read `paid_minor` from the
      // LOCKED rows and re-run the decision. If the world changed since the candidate read, queue
      // instead of writing.
      const writeAutoMatch = (
        tx: TxRow,
        config: ConfigRow,
        chosenAssignmentId: string,
        rejectedCandidates: ReadonlyArray<{
          readonly assignmentId: string;
          readonly outstandingMinor: number;
        }>,
      ) =>
        sql.withTransaction(
          Effect.Do.pipe(
            Effect.bind(
              'lockedTx',
              () => sql<{ readonly id: string }>`
              SELECT id::text AS id FROM bank_transactions
              WHERE id = ${tx.id}::uuid AND match_state = 'unmatched' AND auto_match_suppressed = false
              FOR UPDATE
            `,
            ),
            Effect.bind('lockedAssignments', ({ lockedTx }) => {
              if (lockedTx.length === 0) return Effect.succeed(null);
              const allIds = [chosenAssignmentId, ...rejectedCandidates.map((c) => c.assignmentId)];
              return sql<{
                readonly id: string;
                readonly amount_minor: string;
                readonly paid_minor: string;
              }>`
                SELECT id::text AS id, amount_minor::text, paid_minor::text FROM fee_assignments
                WHERE id = ANY(${allIds}::uuid[])
                ORDER BY id FOR UPDATE
              `;
            }),
            Effect.let('redecision', ({ lockedAssignments }) => {
              if (lockedAssignments === null) return null;
              const relockedCandidates: ReadonlyArray<MatchCandidate> = lockedAssignments.map(
                (row) => ({
                  assignmentId: row.id,
                  currency: tx.currency,
                  outstandingMinor: Number(row.amount_minor) - Number(row.paid_minor),
                  effectiveDueAt: Option.none(),
                }),
              );
              return decide({
                member: { _tag: 'Resolved', memberId: '', memberNameFold: Option.none() },
                txAmountMinor: Number(tx.amount_minor),
                txCurrency: tx.currency,
                candidates: relockedCandidates,
                duplicateOfTransactionId: Option.none(),
                counterpartyNameFold: Option.none(),
              });
            }),
            Effect.bind(
              'timezoneRows',
              () => sql<{ readonly timezone: string | null }>`
              SELECT timezone FROM team_settings WHERE team_id = ${tx.team_id}::uuid
            `,
            ),
            Effect.bind('assignmentMemberRows', ({ redecision }) => {
              if (redecision === null || redecision._tag !== 'AutoMatch') return Effect.succeed([]);
              return sql<{ readonly team_member_id: string }>`
                SELECT team_member_id::text AS team_member_id FROM fee_assignments
                WHERE id = ${redecision.assignmentId}::uuid
              `;
            }),
            Effect.flatMap(({ lockedTx, redecision, timezoneRows, assignmentMemberRows }) => {
              // The row was already handled by a concurrent caller since we read it.
              if (lockedTx.length === 0 || redecision === null) return Effect.succeed(QUEUED);

              if (redecision._tag !== 'AutoMatch') {
                return writeQueueEvidence(tx.id, redecision.reason, { revalidatedUnderLock: true });
              }

              const teamMemberId = assignmentMemberRows[0]?.team_member_id;
              // The assignment vanished between the candidate read and the lock (should not
              // happen — assignments are never deleted — but never write against a row we could
              // not re-verify).
              if (teamMemberId === undefined) {
                return writeQueueEvidence(tx.id, 'no_open_assignment', {
                  revalidatedUnderLock: true,
                });
              }

              const timezone = timezoneRows[0]?.timezone ?? FALLBACK_ZONE;
              const paidAt = noonInTeamTz(tx.booked_on, timezone);

              return sql`
                INSERT INTO payments (
                  fee_assignment_id, team_member_id, amount_minor, method, paid_at, note,
                  recorded_by_user_id, bank_transaction_id, matched_by
                ) VALUES (
                  ${redecision.assignmentId}::uuid, ${teamMemberId}::uuid, ${redecision.amountMinor},
                  'bank_transfer', ${DateTime.formatIso(paidAt)}::timestamptz,
                  ${`Fio #${tx.fio_movement_id}`}, ${config.configured_by_user_id}::uuid,
                  ${tx.id}::uuid, 'auto'
                )
              `.pipe(
                Effect.flatMap(
                  () => sql`
                  UPDATE bank_transactions
                  SET match_reason = NULL,
                      match_evidence = ${JSON.stringify({ rejectedCandidates })}::jsonb,
                      updated_at = now()
                  WHERE id = ${tx.id}::uuid
                `,
                ),
                Effect.as<MatchOutcome>({ _tag: 'AutoMatched' }),
              );
            }),
          ),
        );

      // ---------------------------------------------------------------------
      // matchOne
      // ---------------------------------------------------------------------

      const decideAndWrite = (tx: TxRow, config: ConfigRow) =>
        Effect.Do.pipe(
          Effect.bind('resolved', () => resolveMemberAndCandidates(tx)),
          Effect.bind('duplicateOfTransactionId', () => findDuplicate(tx)),
          Effect.tap(() => afterCandidateRead),
          Effect.flatMap(({ resolved, duplicateOfTransactionId }) => {
            const decisionInput: MatchDecisionInput = {
              member: resolved.resolution,
              txAmountMinor: Number(tx.amount_minor),
              txCurrency: tx.currency,
              candidates: resolved.candidates,
              duplicateOfTransactionId,
              counterpartyNameFold: Option.fromNullishOr(tx.counterparty_name).pipe(
                Option.map(foldName),
              ),
            };
            const decision = decide(decisionInput);
            if (decision._tag === 'Queue') {
              return writeQueueEvidence(tx.id, decision.reason, {
                suggestions: decision.suggestions,
                duplicateOfTransactionId: Option.getOrNull(decision.duplicateOfTransactionId),
              });
            }
            return writeAutoMatch(tx, config, decision.assignmentId, decision.rejectedCandidates);
          }),
        );

      // Step 0 — eligibility.
      const matchEligibleTx = (tx: TxRow) => {
        if (
          tx.direction !== 'incoming' ||
          tx.match_state !== 'unmatched' ||
          tx.auto_match_suppressed
        ) {
          return Effect.succeed(QUEUED);
        }
        return sql<ConfigRow>`
          SELECT auto_match_enabled, configured_by_user_id::text AS configured_by_user_id
          FROM bank_sync_config WHERE team_id = ${tx.team_id}::uuid
        `.pipe(
          Effect.flatMap((configRows) => {
            const config = configRows[0];
            // No config row, or auto-match disabled for the team: the row stays queued,
            // untouched — nothing is written; there is no reason to record.
            return config === undefined || !config.auto_match_enabled
              ? Effect.succeed(QUEUED)
              : decideAndWrite(tx, config);
          }),
        );
      };

      const matchOne = (txId: BankTransaction.BankTransactionId): Effect.Effect<MatchOutcome> =>
        sql<TxRow>`
          SELECT id::text, team_id::text, direction, match_state, auto_match_suppressed,
                 variable_symbol, amount_minor::text, currency, booked_on::text, fio_movement_id::text,
                 counterparty_name
          FROM bank_transactions WHERE id = ${txId}::uuid
        `.pipe(
          Effect.flatMap((rows) => {
            const tx = rows[0];
            return tx === undefined ? Effect.succeed(QUEUED) : matchEligibleTx(tx);
          }),
          catchSqlErrors,
        );

      // ---------------------------------------------------------------------
      // unmatch
      // ---------------------------------------------------------------------

      const unmatch = (
        txId: BankTransaction.BankTransactionId,
        input: UnmatchInput,
      ): Effect.Effect<void, UnmatchReasonTooShort, PaymentsRepository> =>
        Effect.Do.pipe(
          Effect.tap(() =>
            input.reason.trim().length >= 3
              ? Effect.void
              : Effect.fail(new UnmatchReasonTooShort()),
          ),
          Effect.bind('paymentsRepo', () => PaymentsRepository.asEffect()),
          Effect.flatMap(({ paymentsRepo }) =>
            sql.withTransaction(
              Effect.Do.pipe(
                Effect.tap(() => input.beforeVoids ?? Effect.void),
                Effect.bind(
                  'paymentIds',
                  // Ordered by fee_assignment_id ASC (then id ASC as a tiebreaker), NOT payment
                  // id — payment ids are random UUIDs, so voiding in payment-id order takes the
                  // resulting fee_assignments locks (via each void_'s recompute_paid_minor
                  // trigger) in an arbitrary order, violating D10c's "assignments by id ASC"
                  // invariant that writeAutoMatch and performManualMatch both honour. Two
                  // concurrent /unmatch calls on split transactions touching the same two
                  // assignments could otherwise deadlock (40P01) on a money operation.
                  //
                  // Plain SELECT, no FOR UPDATE, no locks taken — safe to run before the account
                  // hoist below (§3.2).
                  () => sql<{ readonly id: string }>`
                  SELECT id::text AS id FROM payments
                  WHERE bank_transaction_id = ${txId}::uuid AND voided_at IS NULL
                  ORDER BY fee_assignment_id ASC, id ASC
                `,
                ),
                // §3.2 — every member_credit_accounts lock this transaction will need, in ONE
                // ordered statement, keyed off the EXACT payment set just read. One bank
                // transaction can be matched across several members (api/bank-sync.ts's manual
                // match only checks team ownership per allocation), so the per-payment void loop
                // below would otherwise take account locks interleaved with fee_assignments
                // locks — two concurrent unmatches of two multi-member transactions then
                // deadlock (40P01) and surface as an untyped SqlError. void_'s own pre-lock
                // becomes re-entrant once these are held. Order matters: this hoist runs AFTER
                // the paymentIds SELECT (keyed off its exact result) — under READ COMMITTED a
                // hoist-then-select ordering would let a concurrent performManualMatch commit a
                // new payment, for a member never hoisted, between the two statements.
                //
                // ponytail: hoist locks existing rows only; upsert zero-balance rows if a
                // first-settlement-mid-unmatch 40P01 is ever observed (§3.1's named residual).
                Effect.tap(({ paymentIds }) =>
                  paymentIds.length === 0
                    ? Effect.void
                    : sql`
                        SELECT 1 FROM member_credit_accounts a
                         WHERE (a.team_member_id, a.currency) IN (
                           SELECT p.team_member_id, f.currency
                             FROM payments p
                             JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
                             JOIN fees f ON f.id = fa.fee_id
                            WHERE p.id = ANY(${paymentIds.map((row) => row.id)}::uuid[]))
                         ORDER BY a.team_member_id, a.currency
                         FOR UPDATE
                      `,
                ),
                // 1. void every active payment first (D10c invariant — payments before
                //    bank_transactions).
                Effect.tap(({ paymentIds }) =>
                  Effect.forEach(
                    paymentIds,
                    (row) =>
                      paymentsRepo.void_(Schema.decodeSync(Payment.PaymentId)(row.id), {
                        voidedByUserId: input.unmatchedByUserId,
                        voidReason: input.reason,
                        voidedAt: DateTime.nowUnsafe(),
                      }),
                    { concurrency: 1, discard: true },
                  ),
                ),
                Effect.tap(() => input.afterVoids ?? Effect.void),
                // 2. THEN update bank_transactions.
                Effect.tap(
                  () => sql`
                  UPDATE bank_transactions
                  SET auto_match_suppressed = true, match_reason = NULL, updated_at = now()
                  WHERE id = ${txId}::uuid
                `,
                ),
                Effect.asVoid,
              ),
            ),
          ),
          catchSqlErrors,
        );

      return { matchOne, unmatch };
    }),
  );

export class BankTransactionMatcher extends ServiceMap.Service<
  BankTransactionMatcher,
  Effect.Success<ReturnType<typeof make>>
>()('api/BankTransactionMatcher') {
  static readonly Default = Layer.effect(BankTransactionMatcher, make());
}
