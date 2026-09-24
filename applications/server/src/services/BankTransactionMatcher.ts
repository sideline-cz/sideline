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
import {
  type Auth,
  BankSyncApi,
  type BankTransaction,
  Payment,
  SettlementPlan,
} from '@sideline/domain';
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
  /** Opt-in, default false (migration 1792800001). Gates ONLY `writeAutoCredit`; with it off
   * `decide()` runs untouched and this file behaves exactly as it did before the flag existed. */
  readonly auto_credit_enabled: boolean;
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
      // Auto-credit — the `auto_credit_enabled` path
      // ---------------------------------------------------------------------

      /** Locked, currency-filtered, base-table twin of `fetchCandidates` (a view row cannot be
       * locked). Deliberately the SAME predicate as `MemberCreditsRepository.settle`'s
       * `lockAssignments`, so both money paths see exactly the same candidate set. */
      const lockCreditCandidates = (tx: TxRow, memberId: string) =>
        sql<{
          readonly id: string;
          readonly fee_id: string;
          readonly fee_name: string;
          readonly amount_minor: string;
          readonly paid_minor: string;
          readonly effective_due_at: Date | null;
        }>`
          SELECT fa.id::text AS id, fa.fee_id::text AS fee_id, f.name AS fee_name,
                 fa.amount_minor::text AS amount_minor, fa.paid_minor::text AS paid_minor,
                 COALESCE(fa.due_at, f.due_at) AS effective_due_at
            FROM fee_assignments fa
            JOIN fees f ON f.id = fa.fee_id
           WHERE fa.team_member_id = ${memberId}::uuid
             AND f.team_id         = ${tx.team_id}::uuid
             AND f.currency        = ${tx.currency}
             AND f.archived_at IS NULL
             AND fa.stored_status  = 'active'
             AND fa.amount_minor   > fa.paid_minor
           ORDER BY fa.id ASC
           FOR UPDATE OF fa
        `;

      /**
       * Case A/B's greedy sibling: allocate the transfer oldest-due-first, turn whatever is left
       * into credit. Reached ONLY when the team opted in, the VS resolved to exactly ONE member,
       * and the duplicate pre-check came back clean.
       *
       * Locks in canonical order (root `AGENTS.md` invariant 2): `member_credit_accounts` ->
       * `bank_transactions` -> `fee_assignments`. That is precisely why this cannot just call
       * `MemberCreditsRepository.settle`: settle's own order is accounts -> assignments with no
       * `bank_transactions` leg, so inserting bank-linked payments under it would take
       * `bank_transactions` (via `payments_finance_recompute`) AFTER `fee_assignments` and
       * deadlock (40P01) against this same file's `writeAutoMatch`. The shared piece is the PURE
       * allocator, `SettlementPlan.planSettlement` — identical ordering, identical arithmetic,
       * and identical to what the client's settlement preview renders.
       *
       * The credit pool is passed as 0, deliberately: the transfer allocates its OWN money only.
       * Draining a balance the member already held would be a side effect of an event no
       * treasurer triggered, and it would make `/unmatch` refund credit this transfer never
       * created. `settle` stays the one place that SPENDS credit; this path only ADDS it.
       */
      const writeAutoCredit = (tx: TxRow, config: ConfigRow, memberId: string) =>
        sql.withTransaction(
          Effect.Do.pipe(
            // Leg 1 — member_credit_accounts. The INSERT's SELECT is the team-ownership check;
            // ON CONFLICT makes it idempotent (mirrors settle's step 0).
            Effect.tap(
              () => sql`
                INSERT INTO member_credit_accounts (team_member_id, currency)
                SELECT tm.id, ${tx.currency}
                  FROM team_members tm
                 WHERE tm.id = ${memberId}::uuid AND tm.team_id = ${tx.team_id}::uuid
                ON CONFLICT (team_member_id, currency) DO NOTHING
              `,
            ),
            // FOR UPDATE OF a, never a bare FOR UPDATE — that would pull team_members into the
            // lock order. Zero rows means the member is not in this team: write nothing.
            Effect.bind(
              'accountRows',
              () => sql<{ readonly balance_minor: string }>`
                SELECT a.balance_minor::text AS balance_minor
                  FROM member_credit_accounts a
                  JOIN team_members tm ON tm.id = a.team_member_id
                 WHERE a.team_member_id = ${memberId}::uuid
                   AND tm.team_id       = ${tx.team_id}::uuid
                   AND a.currency       = ${tx.currency}
                 FOR UPDATE OF a
              `,
            ),
            // Leg 2 — bank_transactions. Re-checked under the lock: a concurrent manual match or
            // /unmatch since the candidate read means this call has nothing left to do.
            Effect.bind(
              'lockedTx',
              () => sql<{ readonly id: string }>`
                SELECT id::text AS id FROM bank_transactions
                WHERE id = ${tx.id}::uuid AND match_state = 'unmatched'
                  AND auto_match_suppressed = false
                FOR UPDATE
              `,
            ),
            // Leg 3 — fee_assignments, id ASC.
            Effect.bind('candidates', ({ accountRows, lockedTx }) =>
              accountRows.length === 0 || lockedTx.length === 0
                ? Effect.succeed([])
                : lockCreditCandidates(tx, memberId),
            ),
            Effect.bind(
              'timezoneRows',
              () => sql<{ readonly timezone: string | null }>`
                SELECT timezone FROM team_settings WHERE team_id = ${tx.team_id}::uuid
              `,
            ),
            Effect.flatMap(({ accountRows, lockedTx, candidates, timezoneRows }) => {
              if (accountRows.length === 0 || lockedTx.length === 0) {
                return Effect.succeed(QUEUED);
              }

              const plan = SettlementPlan.planSettlement(
                candidates.map((row) => ({
                  assignmentId: row.id,
                  feeId: row.fee_id,
                  feeName: row.fee_name,
                  dueMinor: Number(row.amount_minor),
                  paidMinor: Number(row.paid_minor),
                  effectiveDueAt: Option.fromNullishOr(row.effective_due_at).pipe(
                    Option.map((d) => d.getTime()),
                  ),
                })),
                0,
                Number(tx.amount_minor),
              );

              // A zero-amount movement allocates nothing and credits nothing. Leave it queued
              // rather than stamping an empty auto-credit over it.
              if (plan.lines.length === 0 && plan.creditAddedMinor <= 0) {
                return Effect.succeed(QUEUED);
              }

              const timezone = timezoneRows[0]?.timezone ?? FALLBACK_ZONE;
              const paidAt = DateTime.formatIso(noonInTeamTz(tx.booked_on, timezone));
              const note = `Fio #${tx.fio_movement_id}`;

              // Every plan line is source 'payment' (the credit pool is 0), so every row is a
              // 'bank_transfer' payment carrying this transaction's provenance — exactly what
              // writeAutoMatch writes, just possibly more than one of them.
              const insertPayments: Effect.Effect<void, SqlError> =
                plan.lines.length === 0
                  ? Effect.void
                  : sql`
                      INSERT INTO payments (
                        fee_assignment_id, team_member_id, amount_minor, method, paid_at, note,
                        recorded_by_user_id, bank_transaction_id, matched_by
                      ) VALUES ${sql.join(
                        ',',
                        false,
                      )(
                        plan.lines.map(
                          (line) => sql`(
                            ${line.assignmentId}::uuid, ${memberId}::uuid, ${line.amountMinor},
                            'bank_transfer', ${paidAt}::timestamptz, ${note},
                            ${config.configured_by_user_id}::uuid, ${tx.id}::uuid, 'auto'
                          )`,
                        ),
                      )}
                    `.pipe(Effect.asVoid);

              // The remainder. `source = 'auto'` + `bank_transaction_id` is the pair migration
              // 1792800001's CHECK enforces, and it is what lets /unmatch find this row again.
              const addCredit: Effect.Effect<void, SqlError> =
                plan.creditAddedMinor <= 0
                  ? Effect.void
                  : sql`
                      UPDATE member_credit_accounts
                         SET balance_minor = balance_minor + ${plan.creditAddedMinor},
                             updated_at = now()
                       WHERE team_member_id = ${memberId}::uuid AND currency = ${tx.currency}
                    `.pipe(
                      Effect.flatMap(
                        () => sql`
                          INSERT INTO member_credit_deposits (
                            team_member_id, currency, amount_minor, method, paid_at, note,
                            recorded_by_user_id, source, bank_transaction_id
                          ) VALUES (
                            ${memberId}::uuid, ${tx.currency}, ${plan.creditAddedMinor},
                            'bank_transfer', ${paidAt}::timestamptz, ${note},
                            ${config.configured_by_user_id}::uuid, 'auto', ${tx.id}::uuid
                          )
                        `,
                      ),
                      Effect.asVoid,
                    );

              return insertPayments.pipe(
                Effect.flatMap(() => addCredit),
                Effect.flatMap(
                  () => sql`
                    UPDATE bank_transactions
                    SET match_reason = NULL,
                        match_evidence = ${JSON.stringify({
                          autoCredited: true,
                          allocatedMinor: plan.lines.reduce((sum, l) => sum + l.amountMinor, 0),
                          creditAddedMinor: plan.creditAddedMinor,
                          lines: plan.lines.map((line) => ({
                            assignmentId: line.assignmentId,
                            amountMinor: line.amountMinor,
                            coversFully: line.coversFully,
                          })),
                        })}::jsonb,
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
            // The opt-in greedy path. Only ever reached with an unambiguously resolved member
            // and a clean duplicate pre-check: a missing, unknown, or ambiguous variable symbol
            // keeps queuing regardless of the flag, because money landing on the wrong person's
            // balance is strictly worse than a row in the treasurer's review queue.
            if (
              config.auto_credit_enabled &&
              resolved.resolution._tag === 'Resolved' &&
              Option.isNone(duplicateOfTransactionId)
            ) {
              return writeAutoCredit(tx, config, resolved.resolution.memberId);
            }

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
          SELECT auto_match_enabled, auto_credit_enabled,
                 configured_by_user_id::text AS configured_by_user_id
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

      /**
       * The deposit twin of `PaymentsRepository.void_`'s credit-restore leg. Conditional UPDATE,
       * never SELECT-then-UPDATE: `balance_minor >= d.amount_minor` is what turns "already spent"
       * into a typed refusal instead of a `balance_minor >= 0` CHECK violation that would abort
       * the whole transaction as an untyped `SqlError`.
       */
      const voidLinkedDeposit = (depositId: string, input: UnmatchInput) =>
        sql<{ readonly id: string }>`
          UPDATE member_credit_accounts a
             SET balance_minor = a.balance_minor - d.amount_minor, updated_at = now()
            FROM member_credit_deposits d
           WHERE d.id = ${depositId}::uuid AND d.voided_at IS NULL
             AND a.team_member_id = d.team_member_id AND a.currency = d.currency
             AND a.balance_minor >= d.amount_minor
           RETURNING d.id::text AS id
        `.pipe(
          Effect.flatMap(
            (rows): Effect.Effect<void, BankSyncApi.UnmatchCreditSpent | SqlError> =>
              rows.length === 0
                ? Effect.fail(new BankSyncApi.UnmatchCreditSpent())
                : sql`
                    UPDATE member_credit_deposits
                       SET voided_at = now(),
                           voided_by_user_id = ${input.unmatchedByUserId}::uuid,
                           void_reason = ${input.reason}
                     WHERE id = ${depositId}::uuid AND voided_at IS NULL
                  `.pipe(Effect.asVoid),
          ),
        );

      const unmatch = (
        txId: BankTransaction.BankTransactionId,
        input: UnmatchInput,
      ): Effect.Effect<
        void,
        UnmatchReasonTooShort | BankSyncApi.UnmatchCreditSpent,
        PaymentsRepository
      > =>
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
                // Read alongside paymentIds, and BEFORE the account hoist, for the same reason
                // paymentIds is: the hoist must be keyed off the exact row set it will later
                // touch. A pure top-up (member owed nothing) has ZERO payments and exactly one
                // deposit, so the hoist can no longer be skipped on `paymentIds.length === 0`.
                Effect.bind(
                  'depositIds',
                  () => sql<{ readonly id: string }>`
                  SELECT id::text AS id FROM member_credit_deposits
                  WHERE bank_transaction_id = ${txId}::uuid AND voided_at IS NULL
                  ORDER BY id ASC
                `,
                ),
                Effect.tap(({ paymentIds, depositIds }) =>
                  paymentIds.length === 0 && depositIds.length === 0
                    ? Effect.void
                    : sql`
                        SELECT 1 FROM member_credit_accounts a
                         WHERE (a.team_member_id, a.currency) IN (
                           SELECT p.team_member_id, f.currency
                             FROM payments p
                             JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
                             JOIN fees f ON f.id = fa.fee_id
                            WHERE p.id = ANY(${paymentIds.map((row) => row.id)}::uuid[])
                           UNION
                           SELECT d.team_member_id, d.currency
                             FROM member_credit_deposits d
                            WHERE d.id = ANY(${depositIds.map((row) => row.id)}::uuid[]))
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
                // 1b. THEN take back the credit this transaction added. Symmetry with the
                //     payment voids above: an auto-credited transfer put money on the member's
                //     balance, so unmatching it must take that money back off — otherwise the
                //     credit outlives the transaction with nothing left pointing at it.
                //     Sequential, id ASC, inside the already-hoisted account locks.
                Effect.tap(({ depositIds }) =>
                  Effect.forEach(depositIds, (row) => voidLinkedDeposit(row.id, input), {
                    concurrency: 1,
                    discard: true,
                  }),
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
