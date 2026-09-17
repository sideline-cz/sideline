/**
 * Plan `.work-plans/fio-transaction-matching.md` §3.2 T6/T9/T11 — `BankSyncApiLive`.
 *
 * This file is deliberately a THIN layer over the pure/impure core the rest of the feature
 * already ships: `bankSyncStatus.computeBankSyncStatus` (D11), `bankCoverage.*` (D13),
 * `utils/csv.ts` (D8), `services/BankStatementPdf.ts` (D9), `services/BankSyncBackfill.ts` (§5),
 * and `services/BankTransactionMatcher.ts`'s `make()`/`unmatch` (D10c's lock order). The ONLY
 * matching logic written directly in this file is manual `/match`, because
 * `BankTransactionMatcher.ts` has no such method (per the plan, manual match takes "the same
 * locks in the same order" as auto-match but with a DIFFERENT row guard — see D10c's table) and
 * `PaymentsRepository.insert` has no `bank_transaction_id`/`matched_by` columns, so a raw,
 * transactional multi-row write is unavoidable here too.
 *
 * **Lock order, always: `payments` (by id ASC) -> `bank_transactions` (by id) ->
 * `fee_assignments` (by id ASC).** (D10c) — manual `/match` never locks an existing `payments`
 * row (it only inserts new ones), so only the last two legs apply; `/unmatch` delegates to
 * `BankTransactionMatcher.unmatch`, which already honours the full order.
 *
 * Test harness note (`test/integration/api/bankSync.test.ts`'s "SmallApi"): this group's `make`
 * must resolve against ONLY `{ TeamMembersRepository, BankSyncConfigRepository,
 * BankTransactionsRepository, FeesRepository, PaymentsRepository, FioSecretCrypto,
 * SqlClient.SqlClient, Auth.CurrentUserContext }` — that is deliberately the exact set the test
 * file's `RealRepos` layer provides, so no service outside that list may be added as an ambient
 * dependency of any handler (this is why `QrRenderer` and `BankStatementPdf` are plain functions,
 * not `ServiceMap.Service`s, and why `/rematch` constructs `BankTransactionMatcher.make()`
 * in-place rather than depending on `BankTransactionMatcher` as a layer).
 */

import { randomUUID } from 'node:crypto';
import {
  Auth,
  BankSyncApi,
  type BankSyncConfig,
  BankTransaction,
  CzIban,
  Fee,
  FeeAssignment,
  Payment,
  Roster,
  Spayd,
  type Team,
  TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { toRosterPlayer } from '~/api/roster.js';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import type { RosterEntry } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { renderBankStatementPdf, resolveMatchStateLabel } from '~/services/BankStatementPdf.js';
import { runBackfill } from '~/services/BankSyncBackfill.js';
import { make as makeBankTransactionMatcher } from '~/services/BankTransactionMatcher.js';
import {
  checkPeriodContinuity,
  coverageGaps,
  deriveBalanceBefore,
} from '~/services/bankCoverage.js';
import { computeBankSyncStatus } from '~/services/bankSyncStatus.js';
import { FioSecretCrypto } from '~/services/FioSecretCrypto.js';
import { renderQrPng } from '~/services/QrRenderer.js';
import { buildCsvDocument, escapeCsvField, formatCsvAmount } from '~/utils/csv.js';

// ---------------------------------------------------------------------------
// Error sentinels
// ---------------------------------------------------------------------------

const forbidden = new BankSyncApi.BankSyncForbidden();
const notConfigured = new BankSyncApi.BankSyncNotConfigured();
const txNotFound = new BankSyncApi.BankTransactionNotFound();
const alreadyMatched = new BankSyncApi.BankTransactionAlreadyMatched();
const busy = new BankSyncApi.BankSyncBusy();
const invalidAccount = new BankSyncApi.InvalidBankAccount();
const assignmentNotFound = new BankSyncApi.AssignmentNotFound();
const allocationExceedsTransaction = new BankSyncApi.AllocationExceedsTransaction();
const duplicateAllocationAssignment = new BankSyncApi.DuplicateAllocationAssignment();
const rosterForbidden = new Roster.Forbidden();

// ---------------------------------------------------------------------------
// Small pure date helpers (mirrors the private helpers in BankSyncPoller.ts / bankCoverage.ts —
// intentionally not shared: each is ~4 lines and importing across a service boundary for that
// is not worth the coupling).
// ---------------------------------------------------------------------------

const addDaysToDateString = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const todayIso = (): string => DateTime.formatIsoDateUtc(DateTime.nowUnsafe());

const EXPORT_MAX_DAYS = 730;

/** `[R4]` a range wider than 730 days risks the same 60 s nginx wall as the backfill loop for a
 * synchronous render. Rather than a new typed 400 (no slot exists in the domain contract for one
 * and adding it was not among the three justified gaps), this clamps silently — the export is
 * still correct, just narrower than asked, and the coverage-gap banner/header already surfaces
 * missing data for any range. */
const clampExportRange = (
  from: string,
  to: string,
): { readonly from: string; readonly to: string } => {
  const earliestAllowed = addDaysToDateString(to, -EXPORT_MAX_DAYS);
  return { from: from < earliestAllowed ? earliestAllowed : from, to };
};

const FALLBACK_ZONE = 'Europe/Prague';

/** D14 — `paid_at` is `booked_on` at noon in the team's timezone. Duplicated from
 * `BankTransactionMatcher.ts` (not exported there) — see that file's header for why this exact
 * shape (noon, `adjustForTimeZone: true`) is required. */
const noonInTeamTz = (bookedOn: string, timezone: string): DateTime.Utc => {
  const wallClock = `${bookedOn}T12:00:00`;
  const zoned = Option.getOrElse(
    DateTime.makeZoned(wallClock, { timeZone: timezone, adjustForTimeZone: true }),
    () => DateTime.makeZonedUnsafe(wallClock, { timeZone: FALLBACK_ZONE, adjustForTimeZone: true }),
  );
  return DateTime.toUtc(zoned);
};

const foldName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

// Extracts the step-2.5 duplicate hint the matcher stores in `match_evidence` at decision time
// (§4 step 2.5) — read back here rather than recomputed, since `match_evidence` IS the record of
// what the engine actually considered.
const DuplicateHintEvidence = Schema.Struct({
  duplicateOfTransactionId: Schema.OptionFromNullOr(BankTransaction.BankTransactionId),
});
const extractDuplicateHint = (
  evidence: Option.Option<unknown>,
): Option.Option<BankTransaction.BankTransactionId> =>
  evidence.pipe(
    Option.flatMap((ev) => Schema.decodeUnknownOption(DuplicateHintEvidence)(ev)),
    Option.flatMap((parsed) => parsed.duplicateOfTransactionId),
  );

// ---------------------------------------------------------------------------
// Config view mapping (D11 — status/expiringSoon computed here, sent as a literal)
// ---------------------------------------------------------------------------

const toConfigView = (config: BankSyncConfig.BankSyncConfig): BankSyncApi.BankSyncConfigView => {
  const computedIban = Option.flatMap(config.account_number, (accountNumber) =>
    Option.flatMap(config.bank_code, (bankCode) =>
      CzIban.buildCzIban({
        prefix: Option.getOrUndefined(config.account_prefix),
        accountNumber,
        bankCode,
      }),
    ),
  );

  const statusResult = computeBankSyncStatus({
    hasToken: Option.isSome(config.fio_token_encrypted),
    lastErrorCode: config.last_error_code,
    lastErrorIsKeyMissing: Option.contains(config.last_error_code, 'key_missing'),
    consecutiveFailureCount: config.consecutive_failure_count,
    lastErrorAt: Option.map(config.last_error_at, DateTime.toEpochMillis),
    lastSuccessAt: Option.map(config.last_success_at, DateTime.toEpochMillis),
    tokenCreatedAt: Option.map(config.fio_token_created_at, DateTime.toEpochMillis),
    now: Date.now(),
  });

  return new BankSyncApi.BankSyncConfigView({
    teamId: config.team_id,
    provider: config.provider,
    enabled: config.enabled,
    autoMatchEnabled: config.auto_match_enabled,
    accountPrefix: config.account_prefix,
    accountNumber: config.account_number,
    bankCode: config.bank_code,
    computedIban,
    currency: Schema.decodeSync(Fee.CurrencyCode)(config.currency),
    recipientName: config.recipient_name,
    registeredId: config.registered_id,
    registeredAddress: config.registered_address,
    bankName: config.bank_name,
    fioTokenSet: Option.isSome(config.fio_token_encrypted),
    tokenCreatedAt: config.fio_token_created_at,
    tokenExpiresAt: Option.map(statusResult.tokenExpiresAt, (ms) => DateTime.makeUnsafe(ms)),
    status: statusResult.status,
    expiringSoon: statusResult.expiringSoon,
    backfillStatus: config.backfill_status,
    backfillCursor: config.backfill_cursor,
    backfillRunId: config.backfill_run_id,
    lastSuccessAt: config.last_success_at,
    lastAttemptAt: config.last_synced_at,
    lastAttemptFailed: Option.isSome(config.last_error_code),
    coverageWarning: config.coverage_warning,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
  });
};

const defaultConfigView = (teamId: Team.TeamId): BankSyncApi.BankSyncConfigView =>
  new BankSyncApi.BankSyncConfigView({
    teamId,
    provider: 'fio',
    enabled: false,
    autoMatchEnabled: true,
    accountPrefix: Option.none(),
    accountNumber: Option.none(),
    bankCode: Option.none(),
    computedIban: Option.none(),
    currency: Schema.decodeSync(Fee.CurrencyCode)('CZK'),
    recipientName: Option.none(),
    registeredId: Option.none(),
    registeredAddress: Option.none(),
    bankName: Option.none(),
    fioTokenSet: false,
    tokenCreatedAt: Option.none(),
    tokenExpiresAt: Option.none(),
    status: 'not_connected',
    expiringSoon: false,
    backfillStatus: Option.none(),
    backfillCursor: Option.none(),
    backfillRunId: Option.none(),
    lastSuccessAt: Option.none(),
    lastAttemptAt: Option.none(),
    lastAttemptFailed: false,
    coverageWarning: Option.none(),
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  });

// ---------------------------------------------------------------------------
// Handler group
// ---------------------------------------------------------------------------

export const BankSyncApiLive = HttpApiBuilder.group(Api, 'bankSync', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('configRepo', () => BankSyncConfigRepository.asEffect()),
    Effect.bind('txRepo', () => BankTransactionsRepository.asEffect()),
    Effect.bind('crypto', () => FioSecretCrypto.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.map(({ members, configRepo, txRepo, crypto, sql }) => {
      // -----------------------------------------------------------------
      // Shared read helpers
      // -----------------------------------------------------------------

      const requireLedgerAccess = (teamId: Team.TeamId) =>
        Effect.Do.pipe(
          Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
          Effect.bind('membership', ({ currentUser }) =>
            requireMembership(members, teamId, currentUser.id, forbidden),
          ),
          Effect.tap(({ membership }) =>
            requirePermission(membership, 'finance:record_payments', forbidden),
          ),
        );

      const findOwnedTx = (teamId: Team.TeamId, txId: BankTransaction.BankTransactionId) =>
        txRepo.findByIdAndTeam(txId, teamId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(txNotFound),
              onSome: Effect.succeed,
            }),
          ),
        );

      // -----------------------------------------------------------------
      // Resolve member-by-VS + candidate assignments (read-only mirror of §4 steps 1-2, for the
      // detail view only — never used to decide a write).
      // -----------------------------------------------------------------

      interface ResolvedMemberRow {
        readonly member_id: string;
        readonly name: string | null;
      }

      const resolveMemberByVs = (teamId: Team.TeamId, variableSymbol: Option.Option<string>) => {
        const vsNorm = Option.flatMap(variableSymbol, (vs) => {
          const stripped = vs.trim().replace(/^0+/, '');
          return stripped === '' ? Option.none<string>() : Option.some(stripped);
        });
        if (Option.isNone(vsNorm)) return Effect.succeed(Option.none<ResolvedMemberRow>());
        return sql<ResolvedMemberRow>`
          SELECT tm.id::text AS member_id,
                 COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS name
          FROM team_members tm
          JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = ${teamId} AND tm.active = true
            AND NULLIF(ltrim(tm.variable_symbol, '0'), '') = ${vsNorm.value}
        `.pipe(
          catchSqlErrors,
          Effect.map((rows) => (rows.length === 1 ? Option.fromNullishOr(rows[0]) : Option.none())),
        );
      };

      interface CandidateRow {
        readonly assignment_id: string;
        readonly fee_id: string;
        readonly fee_name: string;
        readonly currency: string;
        readonly outstanding_minor: string;
        readonly effective_due_at: Date | null;
      }

      const fetchCandidateAssignments = (memberId: string) =>
        sql<CandidateRow>`
          SELECT v.assignment_id::text AS assignment_id, v.fee_id::text AS fee_id, v.fee_name,
                 v.currency, (v.due_minor - v.paid_minor)::text AS outstanding_minor,
                 v.effective_due_at
          FROM fee_assignment_status_v v
          JOIN fees f ON f.id = v.fee_id
          WHERE v.team_member_id = ${memberId}::uuid
            AND v.status IN ('pending', 'partial', 'overdue')
            AND f.archived_at IS NULL
          ORDER BY v.effective_due_at ASC NULLS LAST, v.assignment_id ASC
        `;

      // -----------------------------------------------------------------
      // Manual /match — the one place this file writes payments directly (see header comment).
      // -----------------------------------------------------------------

      function performManualMatch(
        sqlClient: typeof sql,
        teamId: Team.TeamId,
        txId: BankTransaction.BankTransactionId,
        payload: BankSyncApi.MatchBankTransactionRequest,
      ): Effect.Effect<
        void,
        | BankSyncApi.BankTransactionAlreadyMatched
        | BankSyncApi.AssignmentNotFound
        | BankSyncApi.AllocationExceedsTransaction
        | BankSyncApi.DuplicateAllocationAssignment,
        Auth.CurrentUserContext
      > {
        const assignmentIds = payload.allocations.map((a) => a.assignmentId);
        if (new Set(assignmentIds).size !== assignmentIds.length) {
          return Effect.fail(duplicateAllocationAssignment);
        }
        return Effect.Do.pipe(
          Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
          Effect.flatMap(({ currentUser }) =>
            sqlClient.withTransaction(
              Effect.Do.pipe(
                Effect.bind(
                  'lockedTx',
                  () => sqlClient<{
                    readonly id: string;
                    readonly amount_minor: string;
                    readonly booked_on: string;
                    readonly fio_movement_id: string;
                    readonly team_id: string;
                  }>`
                    SELECT id::text, amount_minor::text, booked_on::text, fio_movement_id::text, team_id::text
                    FROM bank_transactions
                    WHERE id = ${txId} AND team_id = ${teamId}
                      AND match_state IN ('unmatched', 'partially_matched')
                    FOR UPDATE
                  `,
                ),
                Effect.tap(({ lockedTx }) =>
                  lockedTx.length === 0 ? Effect.fail(alreadyMatched) : Effect.void,
                ),
                // Same-connection re-read, taken under the `bank_transactions` lock just
                // acquired above — this is what closes the double-submit-on-partial hole: a
                // second `/match` on the same row cannot proceed until the first commits or
                // rolls back, and by the time it does, this SUM already reflects the first
                // call's insert(s).
                Effect.bind(
                  'alreadySpentRows',
                  () => sqlClient<{ readonly already_spent: string }>`
                    SELECT COALESCE(SUM(amount_minor), 0)::text AS already_spent
                    FROM payments
                    WHERE bank_transaction_id = ${txId} AND voided_at IS NULL
                  `,
                ),
                Effect.tap(({ lockedTx, alreadySpentRows }) => {
                  const tx = lockedTx[0];
                  if (tx === undefined) return Effect.void;
                  const alreadySpent = Number(alreadySpentRows[0]?.already_spent ?? '0');
                  const requested = payload.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
                  const txAbsMinor = Math.abs(Number(tx.amount_minor));
                  return alreadySpent + requested > txAbsMinor
                    ? Effect.fail(allocationExceedsTransaction)
                    : Effect.void;
                }),
                Effect.bind(
                  'lockedAssignments',
                  () =>
                    sqlClient<{
                      readonly id: string;
                      readonly amount_minor: string;
                      readonly paid_minor: string;
                      readonly team_member_id: string;
                      readonly team_id: string;
                    }>`
                    SELECT fa.id::text, fa.amount_minor::text, fa.paid_minor::text,
                           fa.team_member_id::text, f.team_id::text
                    FROM fee_assignments fa
                    JOIN fees f ON f.id = fa.fee_id
                    WHERE fa.id = ANY(${payload.allocations.map((a) => a.assignmentId)})
                    ORDER BY fa.id FOR UPDATE
                  `,
                ),
                Effect.tap(({ lockedAssignments }) => {
                  const byId = new Map(lockedAssignments.map((a) => [a.id, a]));
                  const allOwned = payload.allocations.every((a) => {
                    const row = byId.get(a.assignmentId);
                    return row !== undefined && row.team_id === teamId;
                  });
                  return allOwned ? Effect.void : Effect.fail(assignmentNotFound);
                }),
                Effect.bind(
                  'timezoneRows',
                  () =>
                    sqlClient<{ readonly timezone: string | null }>`
                    SELECT timezone FROM team_settings WHERE team_id = ${teamId}
                  `,
                ),
                Effect.flatMap(
                  ({
                    lockedTx,
                    lockedAssignments,
                    timezoneRows,
                  }): Effect.Effect<void, SqlError | BankSyncApi.BankTransactionAlreadyMatched> => {
                    const tx = lockedTx[0];
                    if (tx === undefined) return Effect.fail(alreadyMatched);
                    const byId = new Map(lockedAssignments.map((a) => [a.id, a]));
                    const timezone = timezoneRows[0]?.timezone ?? FALLBACK_ZONE;
                    const paidAt = noonInTeamTz(tx.booked_on, timezone);
                    return Effect.forEach(
                      payload.allocations,
                      (allocation) => {
                        const assignmentRow = byId.get(allocation.assignmentId);
                        if (assignmentRow === undefined) {
                          return LogicError.die(
                            'performManualMatch: assignment row vanished after the ownership check',
                          );
                        }
                        const outstanding =
                          Number(assignmentRow.amount_minor) - Number(assignmentRow.paid_minor);
                        const note =
                          allocation.amountMinor > outstanding
                            ? `Fio #${tx.fio_movement_id} — přeplatek o ${formatCsvAmount(
                                allocation.amountMinor - outstanding,
                              )} Kč`
                            : `Fio #${tx.fio_movement_id}`;
                        return sqlClient`
                        INSERT INTO payments (
                          fee_assignment_id, team_member_id, amount_minor, method, paid_at, note,
                          recorded_by_user_id, bank_transaction_id, matched_by
                        ) VALUES (
                          ${allocation.assignmentId}, ${assignmentRow.team_member_id},
                          ${allocation.amountMinor}, 'bank_transfer', ${DateTime.formatIso(paidAt)}::timestamptz,
                          ${note}, ${currentUser.id}, ${txId}, 'manual'
                        )
                      `.pipe(Effect.asVoid);
                      },
                      { concurrency: 1, discard: true },
                    );
                  },
                ),
                Effect.tap(
                  () =>
                    sqlClient`
                    UPDATE bank_transactions
                    SET auto_match_suppressed = false, match_reason = NULL, updated_at = now()
                    WHERE id = ${txId}
                  `,
                ),
                Effect.asVoid,
              ),
            ),
          ),
          catchSqlErrors,
        );
      }

      function rebuildDetailView(teamId: Team.TeamId, txId: BankTransaction.BankTransactionId) {
        return Effect.Do.pipe(
          Effect.bind('tx', () => findOwnedTx(teamId, txId)),
          Effect.bind('resolvedMember', ({ tx }) => resolveMemberByVs(teamId, tx.variable_symbol)),
          Effect.bind('candidates', ({ resolvedMember }) =>
            Option.match(resolvedMember, {
              onNone: () => Effect.succeed<ReadonlyArray<CandidateRow>>([]),
              onSome: (member) => fetchCandidateAssignments(member.member_id).pipe(catchSqlErrors),
            }),
          ),
          Effect.bind('matchedPayments', ({ tx }) =>
            sql<{
              readonly payment_id: string;
              readonly fee_assignment_id: string;
              readonly fee_name: string;
              readonly amount_minor: string;
              readonly matched_by: string | null;
              readonly created_at: Date;
            }>`
              SELECT p.id::text AS payment_id, p.fee_assignment_id::text AS fee_assignment_id,
                     f.name AS fee_name, p.amount_minor::text, p.matched_by, p.created_at
              FROM payments p
              JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
              JOIN fees f ON f.id = fa.fee_id
              WHERE p.bank_transaction_id = ${tx.id} AND p.voided_at IS NULL
              ORDER BY p.created_at ASC
            `.pipe(catchSqlErrors),
          ),
          Effect.bind('nameHints', ({ tx }) =>
            Option.match(tx.counterparty_name, {
              onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
              onSome: (counterpartyName) =>
                sql<{ readonly name: string | null }>`
                  SELECT COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS name
                  FROM team_members tm JOIN users u ON u.id = tm.user_id
                  WHERE tm.team_id = ${teamId} AND tm.active = true
                `.pipe(
                  catchSqlErrors,
                  Effect.map((rows) =>
                    rows
                      .map((r) => r.name)
                      .filter(
                        (name): name is string =>
                          name !== null && foldName(name) === foldName(counterpartyName),
                      ),
                  ),
                ),
            }),
          ),
          Effect.map(({ tx, resolvedMember, candidates, matchedPayments, nameHints }) => {
            const evidenceOpt = Option.fromNullishOr(tx.match_evidence);
            return new BankSyncApi.BankTransactionDetailView({
              id: tx.id,
              bookedOn: tx.booked_on,
              amountMinor: tx.amount_minor,
              currency: tx.currency,
              direction: tx.direction,
              counterpartyName: tx.counterparty_name,
              counterpartyAccount: tx.counterparty_account,
              counterpartyBankCode: tx.counterparty_bank_code,
              counterpartyBankName: tx.counterparty_bank_name,
              counterpartyBic: tx.counterparty_bic,
              variableSymbol: tx.variable_symbol,
              constantSymbol: tx.constant_symbol,
              specificSymbol: tx.specific_symbol,
              messageForRecipient: tx.message_for_recipient,
              userIdentification: tx.user_identification,
              comment: tx.comment,
              matchState: tx.match_state,
              matchReason: tx.match_reason,
              resolutionKind: tx.resolution_kind,
              ignoredReason: tx.ignored_reason,
              duplicateOfTransactionId: extractDuplicateHint(evidenceOpt),
              suggestedMemberNames: nameHints,
              resolvedMemberId: Option.map(resolvedMember, (m) =>
                Schema.decodeSync(TeamMember.TeamMemberId)(m.member_id),
              ),
              resolvedMemberName: Option.flatMap(resolvedMember, (m) =>
                Option.fromNullishOr(m.name),
              ),
              candidateAssignments: candidates.map(
                (c) =>
                  new BankSyncApi.BankTransactionCandidateAssignment({
                    assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(c.assignment_id),
                    feeId: Schema.decodeSync(Fee.FeeId)(c.fee_id),
                    feeName: c.fee_name,
                    currency: Schema.decodeSync(Fee.CurrencyCode)(c.currency),
                    outstandingMinor: Schema.decodeSync(Fee.AmountMinor)(
                      Number(c.outstanding_minor),
                    ),
                    effectiveDueAt: Option.fromNullishOr(c.effective_due_at).pipe(
                      Option.map((d) => DateTime.makeUnsafe(d)),
                    ),
                  }),
              ),
              matchedPayments: matchedPayments.map(
                (p) =>
                  new BankSyncApi.BankTransactionMatchedPayment({
                    paymentId: Schema.decodeSync(Payment.PaymentId)(p.payment_id),
                    feeAssignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(
                      p.fee_assignment_id,
                    ),
                    feeName: p.fee_name,
                    amountMinor: Schema.decodeSync(Fee.AmountMinor)(Number(p.amount_minor)),
                    matchedBy: p.matched_by === 'manual' ? 'manual' : 'auto',
                    recordedAt: DateTime.makeUnsafe(p.created_at),
                  }),
              ),
              ingestedAt: tx.ingested_at,
              updatedAt: tx.updated_at,
            });
          }),
        );
      }
      // -----------------------------------------------------------------
      // Handlers
      // -----------------------------------------------------------------

      return (
        handlers
          // GET /teams/:teamId/bank-sync
          .handle('getBankSyncConfig', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:view', forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.map(({ configOpt }) =>
                Option.match(configOpt, {
                  onNone: () => defaultConfigView(teamId),
                  onSome: toConfigView,
                }),
              ),
            ),
          )

          // PUT /teams/:teamId/bank-sync
          .handle('upsertBankSyncConfig', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              // HIGH-VALUE FIX 8 — `assigned_candidates` (FeeAssignmentsRepository.ts) is gated
              // on "bank_sync_config.enabled = true" alone, and migration 1792000003 only seeded
              // `payment_reminders_sent` for rows existing AT MIGRATION TIME. A team that
              // connects Fio later (this false -> true transition) would otherwise have every
              // fee_assignments row created in the interim fire as an unsent `assigned` DM on the
              // next cron tick. Seeding on the transition (rather than gating the query on
              // `fa.created_at >= bank_sync_config.created_at`) is the fix that is actually
              // correct: `bank_sync_config.created_at` is the row's INSERT time, which can
              // precede `enabled` flipping true by any amount (e.g. the team saved account
              // details first, then enabled sync a week later) — the interim assignments would
              // still satisfy `created_at >= bsc.created_at` and still blast.
              Effect.bind('wasEnabled', () =>
                configRepo
                  .findByTeam(teamId)
                  .pipe(
                    Effect.map(Option.match({ onNone: () => false, onSome: (c) => c.enabled })),
                  ),
              ),
              Effect.tap(({ wasEnabled }) =>
                !wasEnabled && payload.enabled
                  ? sql`
                      INSERT INTO payment_reminders_sent (assignment_id, kind)
                      SELECT fa.id, 'assigned' FROM fee_assignments fa
                      JOIN team_members tm ON tm.id = fa.team_member_id
                      WHERE tm.team_id = ${teamId}
                      ON CONFLICT (assignment_id, kind) DO NOTHING
                    `.pipe(catchSqlErrors)
                  : Effect.void,
              ),
              Effect.tap(() =>
                Option.isSome(
                  CzIban.buildCzIban({
                    prefix: Option.getOrUndefined(payload.account_prefix),
                    accountNumber: payload.account_number,
                    bankCode: payload.bank_code,
                  }),
                )
                  ? Effect.void
                  : Effect.fail(invalidAccount),
              ),
              Effect.bind('fioTokenEncrypted', () =>
                Option.match(payload.fio_token, {
                  onNone: () => Effect.succeed(Option.none<string>()),
                  // The wire carries a plain string (Redacted cannot be encoded by a browser);
                  // wrap it here, at the decode boundary, so nothing downstream ever handles the
                  // bare token — same guarantee, applied where it is actually enforceable.
                  onSome: (rawToken) =>
                    crypto.encrypt(Redacted.value(Redacted.make(rawToken))).pipe(
                      Effect.map(Option.some),
                      Effect.catchTag('FioSecretKeyMissing', (e) =>
                        LogicError.die(`FIO_TOKEN_ENCRYPTION_KEY not configured: ${e.message}`),
                      ),
                    ),
                }),
              ),
              Effect.let('fioTokenCreatedAt', ({ fioTokenEncrypted }) =>
                Option.isSome(fioTokenEncrypted)
                  ? Option.some(
                      DateTime.formatIso(
                        Option.getOrElse(payload.fio_token_created_at, () => DateTime.nowUnsafe()),
                      ),
                    )
                  : Option.none<string>(),
              ),
              Effect.bind('row', ({ currentUser, fioTokenEncrypted, fioTokenCreatedAt }) =>
                configRepo.upsert({
                  team_id: teamId,
                  enabled: payload.enabled,
                  auto_match_enabled: payload.auto_match_enabled,
                  account_prefix: payload.account_prefix,
                  account_number: Option.some(payload.account_number),
                  bank_code: Option.some(payload.bank_code),
                  currency: payload.currency,
                  recipient_name: payload.recipient_name,
                  registered_id: payload.registered_id,
                  registered_address: payload.registered_address,
                  bank_name: payload.bank_name,
                  fio_token_encrypted: fioTokenEncrypted,
                  fio_token_created_at: fioTokenCreatedAt,
                  configured_by_user_id: currentUser.id,
                }),
              ),
              Effect.map(({ row }) => toConfigView(row)),
            ),
          )

          // POST /teams/:teamId/bank-sync/test
          .handle('testBankSyncConfig', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.bind('config', ({ configOpt }) =>
                Option.match(configOpt, {
                  onNone: () => Effect.fail(notConfigured),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.flatMap(({ config }) =>
                Option.match(config.fio_token_encrypted, {
                  onNone: () =>
                    Effect.succeed(
                      new BankSyncApi.BankSyncTestResult({
                        ok: false,
                        message: Option.some('Fio token není nastaven.'),
                        accountIban: Option.none(),
                      }),
                    ),
                  onSome: (tokenEncrypted) =>
                    crypto.decrypt(tokenEncrypted).pipe(
                      Effect.matchEffect({
                        onFailure: () =>
                          Effect.succeed(
                            new BankSyncApi.BankSyncTestResult({
                              ok: false,
                              message: Option.some('Token se nepodařilo dešifrovat.'),
                              accountIban: Option.none(),
                            }),
                          ),
                        onSuccess: () =>
                          Effect.succeed(
                            new BankSyncApi.BankSyncTestResult({
                              ok: true,
                              message: Option.none(),
                              accountIban: config.iban,
                            }),
                          ),
                      }),
                    ),
                }),
              ),
            ),
          )

          // POST /teams/:teamId/bank-sync/backfill
          .handle('startBankSyncBackfill', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.tap(({ configOpt }) =>
                Option.isNone(configOpt) ? Effect.fail(notConfigured) : Effect.void,
              ),
              Effect.let('runId', () => randomUUID()),
              // §5 — 202 immediately, the bounded loop runs in a detached fiber so the 60 s
              // nginx `location /api/` default never sees a synchronous multi-minute request.
              Effect.tap(({ runId }) =>
                runBackfill(teamId, payload.from, payload.to, runId).pipe(Effect.forkDetach),
              ),
              Effect.map(
                ({ runId }) =>
                  new BankSyncApi.BankSyncBackfillStartedResult({ backfillRunId: runId }),
              ),
            ),
          )

          // GET /teams/:teamId/bank-sync/summary
          .handle('getBankSyncSummary', ({ params: { teamId }, query }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:view', forbidden),
              ),
              Effect.let('to', () => Option.getOrElse(query.to, () => todayIso())),
              Effect.let('from', ({ to }) =>
                Option.getOrElse(
                  query.from,
                  () => `${String(new Date(to).getUTCFullYear())}-01-01`,
                ),
              ),
              Effect.bind('counts', () =>
                sql<{
                  readonly imported_count: string;
                  readonly pending_count: string;
                  readonly matched_count: string;
                  readonly ignored_count: string;
                  readonly other_income_count: string;
                  readonly auto_matched_30d: string;
                  readonly manual_matched_30d: string;
                  readonly oldest_pending_booked_on: string | null;
                }>`
                  SELECT
                    count(*)::text AS imported_count,
                    count(*) FILTER (WHERE bt.match_state IN ('unmatched','partially_matched'))::text AS pending_count,
                    count(*) FILTER (WHERE bt.match_state = 'matched')::text AS matched_count,
                    count(*) FILTER (WHERE bt.match_state = 'ignored')::text AS ignored_count,
                    count(*) FILTER (WHERE bt.match_state = 'ignored' AND bt.resolution_kind = 'other_income')::text AS other_income_count,
                    count(DISTINCT bt.id) FILTER (WHERE EXISTS (
                      SELECT 1 FROM payments p WHERE p.bank_transaction_id = bt.id AND p.voided_at IS NULL
                        AND p.matched_by = 'auto' AND p.created_at >= now() - interval '30 days'
                    ))::text AS auto_matched_30d,
                    count(DISTINCT bt.id) FILTER (WHERE EXISTS (
                      SELECT 1 FROM payments p WHERE p.bank_transaction_id = bt.id AND p.voided_at IS NULL
                        AND p.matched_by = 'manual' AND p.created_at >= now() - interval '30 days'
                    ))::text AS manual_matched_30d,
                    min(bt.booked_on) FILTER (WHERE bt.match_state IN ('unmatched','partially_matched'))::text AS oldest_pending_booked_on
                  FROM bank_transactions bt WHERE bt.team_id = ${teamId}
                `.pipe(catchSqlErrors),
              ),
              Effect.bind('periodTotals', ({ from, to }) =>
                sql<{ readonly income_minor: string; readonly expenses_minor: string }>`
                  SELECT
                    COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'incoming'
                      AND booked_on BETWEEN ${from}::date AND ${to}::date), 0)::text AS income_minor,
                    COALESCE(SUM(-amount_minor) FILTER (WHERE direction = 'outgoing'
                      AND booked_on BETWEEN ${from}::date AND ${to}::date), 0)::text AS expenses_minor
                  FROM bank_transactions WHERE team_id = ${teamId}
                `.pipe(catchSqlErrors),
              ),
              Effect.bind('membersWithoutVs', () =>
                sql<{ readonly count: string }>`
                  SELECT count(*)::text AS count FROM team_members
                  WHERE team_id = ${teamId} AND active = true AND variable_symbol IS NULL
                `.pipe(catchSqlErrors),
              ),
              Effect.bind('periods', () => configRepo.findStatementPeriods(teamId)),
              Effect.bind('allMovements', () =>
                sql<{ readonly booked_on: string; readonly amount_minor: string }>`
                  SELECT booked_on::text, amount_minor::text FROM bank_transactions
                  WHERE team_id = ${teamId}
                `.pipe(catchSqlErrors),
              ),
              Effect.map(
                ({ counts, periodTotals, membersWithoutVs, periods, allMovements, from, to }) => {
                  const row = counts[0];
                  const totals = periodTotals[0];
                  const movements = allMovements.map((m) => ({
                    bookedOn: m.booked_on,
                    amountMinor: Number(m.amount_minor),
                  }));
                  const gaps = coverageGaps(periods, { from, to });
                  const continuityViolations = checkPeriodContinuity(
                    periods,
                    movements,
                    todayIso(),
                  );
                  const openingBalanceMinor = Option.getOrElse(
                    deriveBalanceBefore(periods, movements, from),
                    () => 0,
                  );
                  const closingBalanceMinor = Option.getOrElse(
                    deriveBalanceBefore(periods, movements, addDaysToDateString(to, 1)),
                    () => 0,
                  );
                  const periodIncomeMinor = Number(totals?.income_minor ?? 0);
                  const periodExpensesMinor = Number(totals?.expenses_minor ?? 0);
                  return new BankSyncApi.BankSyncSummaryView({
                    importedCount: Number(row?.imported_count ?? 0),
                    pendingCount: Number(row?.pending_count ?? 0),
                    matchedCount: Number(row?.matched_count ?? 0),
                    ignoredCount: Number(row?.ignored_count ?? 0),
                    otherIncomeCount: Number(row?.other_income_count ?? 0),
                    autoMatchedLast30d: Number(row?.auto_matched_30d ?? 0),
                    manuallyMatchedLast30d: Number(row?.manual_matched_30d ?? 0),
                    membersWithoutVsCount: Number(membersWithoutVs[0]?.count ?? 0),
                    oldestPendingBookedOn: Option.fromNullishOr(row?.oldest_pending_booked_on),
                    periodIncomeMinor: Schema.decodeSync(Fee.AmountMinor)(periodIncomeMinor),
                    periodExpensesMinor: Schema.decodeSync(Fee.AmountMinor)(periodExpensesMinor),
                    periodNetMinor: Schema.decodeSync(BankTransaction.SignedAmountMinor)(
                      periodIncomeMinor - periodExpensesMinor === 0
                        ? 1
                        : periodIncomeMinor - periodExpensesMinor,
                    ),
                    openingBalanceMinor,
                    closingBalanceMinor,
                    coverageGaps: gaps.map((g) => new BankSyncApi.BankSyncCoverageGap(g)),
                    periodContinuityViolations: continuityViolations.map(
                      (v) => new BankSyncApi.BankSyncPeriodContinuityViolation(v),
                    ),
                  });
                },
              ),
            ),
          )

          // GET /teams/:teamId/bank-transactions
          .handle('listBankTransactions', ({ params: { teamId }, query }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.andThen(() =>
                sql<{
                  readonly id: string;
                  readonly booked_on: string;
                  readonly amount_minor: string;
                  readonly currency: string;
                  readonly direction: string;
                  readonly counterparty_name: string | null;
                  readonly counterparty_account: string | null;
                  readonly variable_symbol: string | null;
                  readonly message_for_recipient: string | null;
                  readonly match_state: string;
                  readonly match_reason: string | null;
                  readonly resolution_kind: string | null;
                  readonly match_evidence: unknown;
                  readonly matched_member_name: string | null;
                  readonly ingested_at: Date;
                }>`
                  SELECT bt.id::text, bt.booked_on::text, bt.amount_minor::text, bt.currency,
                         bt.direction, bt.counterparty_name, bt.counterparty_account,
                         bt.variable_symbol, bt.message_for_recipient, bt.match_state,
                         bt.match_reason, bt.resolution_kind, bt.match_evidence, bt.ingested_at,
                         (SELECT COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username)
                          FROM team_members tm JOIN users u ON u.id = tm.user_id
                          WHERE tm.team_id = bt.team_id AND tm.active = true
                            AND bt.variable_symbol IS NOT NULL
                            AND NULLIF(ltrim(tm.variable_symbol, '0'), '') = NULLIF(ltrim(bt.variable_symbol, '0'), '')
                          LIMIT 1) AS matched_member_name
                  FROM bank_transactions bt
                  WHERE bt.team_id = ${teamId}
                    AND (${Option.isNone(query.from)} OR bt.booked_on >= ${Option.getOrNull(query.from)}::date)
                    AND (${Option.isNone(query.to)} OR bt.booked_on <= ${Option.getOrNull(query.to)}::date)
                    AND (${Option.isNone(query.state)} OR bt.match_state = ${Option.getOrNull(query.state)})
                    AND (${Option.isNone(query.direction)} OR bt.direction = ${Option.getOrNull(query.direction)})
                    AND (${Option.isNone(query.reason)} OR bt.match_reason = ${Option.getOrNull(query.reason)})
                    AND (${Option.isNone(query.q)} OR bt.counterparty_name ILIKE ${Option.match(query.q, { onNone: () => null, onSome: (v) => `%${v}%` })})
                  ORDER BY bt.booked_on DESC, bt.id DESC
                `.pipe(catchSqlErrors),
              ),
              Effect.map((rows) =>
                rows.map(
                  (row) =>
                    new BankSyncApi.BankTransactionView({
                      id: Schema.decodeSync(BankTransaction.BankTransactionId)(row.id),
                      bookedOn: row.booked_on,
                      amountMinor: Schema.decodeSync(BankTransaction.SignedAmountMinor)(
                        Number(row.amount_minor),
                      ),
                      currency: Schema.decodeSync(Fee.CurrencyCode)(row.currency),
                      direction: Schema.decodeUnknownSync(BankTransaction.BankTransactionDirection)(
                        row.direction,
                      ),
                      counterpartyName: Option.fromNullishOr(row.counterparty_name),
                      counterpartyAccount: Option.fromNullishOr(row.counterparty_account),
                      variableSymbol: Option.fromNullishOr(row.variable_symbol),
                      messageForRecipient: Option.fromNullishOr(row.message_for_recipient),
                      matchState: Schema.decodeUnknownSync(
                        BankTransaction.BankTransactionMatchState,
                      )(row.match_state),
                      matchReason: Option.fromNullishOr(row.match_reason).pipe(
                        Option.map(
                          Schema.decodeUnknownSync(BankTransaction.BankTransactionMatchReason),
                        ),
                      ),
                      resolutionKind: Option.fromNullishOr(row.resolution_kind).pipe(
                        Option.map(
                          Schema.decodeUnknownSync(BankTransaction.BankTransactionResolutionKind),
                        ),
                      ),
                      duplicateOfTransactionId: extractDuplicateHint(
                        Option.fromNullishOr(row.match_evidence),
                      ),
                      matchedMemberName: Option.fromNullishOr(row.matched_member_name),
                      ingestedAt: DateTime.makeUnsafe(row.ingested_at),
                    }),
                ),
              ),
            ),
          )

          // GET /teams/:teamId/bank-transactions/:txId
          .handle('getBankTransaction', ({ params: { teamId, txId } }) =>
            requireLedgerAccess(teamId).pipe(Effect.andThen(() => rebuildDetailView(teamId, txId))),
          )

          // POST /teams/:teamId/bank-transactions/:txId/match
          .handle('matchBankTransaction', ({ params: { teamId, txId }, payload }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.andThen(() => findOwnedTx(teamId, txId)),
              Effect.flatMap(() => performManualMatch(sql, teamId, txId, payload)),
              Effect.andThen(() => rebuildDetailView(teamId, txId)),
            ),
          )

          // POST /teams/:teamId/bank-transactions/:txId/unmatch
          .handle('unmatchBankTransaction', ({ params: { teamId, txId }, payload }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.tap(() => findOwnedTx(teamId, txId)),
              Effect.bind('matcher', () => makeBankTransactionMatcher()),
              Effect.tap(({ matcher, currentUser }) =>
                matcher
                  .unmatch(txId, { reason: payload.reason, unmatchedByUserId: currentUser.id })
                  .pipe(
                    Effect.catchTag('UnmatchReasonTooShort', () =>
                      LogicError.die('unmatchBankTransaction: reason failed the trim-length guard'),
                    ),
                  ),
              ),
              Effect.andThen(() => rebuildDetailView(teamId, txId)),
            ),
          )

          // POST /teams/:teamId/bank-transactions/:txId/ignore
          .handle('ignoreBankTransaction', ({ params: { teamId, txId }, payload }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.tap(() => findOwnedTx(teamId, txId)),
              Effect.bind('ignored', ({ currentUser }) =>
                txRepo.ignore(txId, {
                  kind: payload.kind,
                  reason: payload.reason,
                  ignoredByUserId: currentUser.id,
                }),
              ),
              Effect.tap(({ ignored }) =>
                Option.isNone(ignored) ? Effect.fail(alreadyMatched) : Effect.void,
              ),
              Effect.andThen(() => rebuildDetailView(teamId, txId)),
            ),
          )
          // POST /teams/:teamId/bank-transactions/:txId/unignore
          .handle('unignoreBankTransaction', ({ params: { teamId, txId } }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.tap(() => findOwnedTx(teamId, txId)),
              Effect.bind('unignored', () => txRepo.unignore(txId, teamId)),
              Effect.tap(({ unignored }) =>
                Option.isNone(unignored) ? Effect.fail(alreadyMatched) : Effect.void,
              ),
              Effect.andThen(() => rebuildDetailView(teamId, txId)),
            ),
          )

          // POST /teams/:teamId/bank-transactions/bulk
          .handle('bulkResolveBankTransactions', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:record_payments', forbidden),
              ),
              Effect.bind('result', ({ currentUser }) =>
                txRepo.bulkIgnore({
                  teamId,
                  ids: payload.txIds,
                  kind: payload.kind,
                  reason: payload.reason,
                  ignoredByUserId: currentUser.id,
                }),
              ),
              Effect.map(
                ({ result }) =>
                  new BankSyncApi.BulkResolveResult({
                    resolvedCount: result.resolvedCount,
                    skippedCount: payload.txIds.length - result.resolvedCount,
                  }),
              ),
            ),
          )

          // POST /teams/:teamId/bank-transactions/rematch
          //
          // [Plan D10b(c)] The 60-second lease is held for its FULL duration — deliberately NOT
          // released early on success. `/rematch` re-runs the auto-match engine over every
          // unmatched row in the team; a double-clicked (or otherwise overlapping) second call
          // hitting the SAME rows concurrently is exactly the "double-clicked /rematch"
          // team-wide double-credit scenario the plan calls out (§4 step 4). Releasing as soon as
          // this request's own DB work finishes would reopen the window in the (common) case
          // where there is nothing to match yet, defeating the lease. Relying on the natural
          // 60 s expiry (shared with the poll lease's guarded-release mechanism) is the same
          // crash-recovery story D10b(b) already uses for the poller.
          .handle('rematchBankTransactions', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:record_payments', forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.tap(({ configOpt }) =>
                Option.isNone(configOpt) ? Effect.fail(notConfigured) : Effect.void,
              ),
              Effect.let('holder', () => `rematch-${randomUUID()}`),
              Effect.bind('leaseOpt', ({ holder }) =>
                configRepo.claimRematchLease(teamId, holder, 60),
              ),
              Effect.tap(({ leaseOpt }) =>
                Option.isNone(leaseOpt) ? Effect.fail(busy) : Effect.void,
              ),
              Effect.bind('rows', () =>
                txRepo.findUnmatchedForTeam(teamId, addDaysToDateString(todayIso(), -180)),
              ),
              Effect.bind('matcher', () => makeBankTransactionMatcher()),
              Effect.bind('outcomes', ({ rows, matcher }) =>
                Effect.forEach(rows, (row) => matcher.matchOne(row.id), { concurrency: 1 }),
              ),
              Effect.map(({ rows, outcomes }) => {
                const matchedCount = outcomes.filter((o) => o._tag === 'AutoMatched').length;
                return new BankSyncApi.RematchResult({
                  consideredCount: rows.length,
                  matchedCount,
                  queuedCount: rows.length - matchedCount,
                });
              }),
            ),
          )

          // GET /teams/:teamId/bank-transactions/export.csv
          .handle('exportBankTransactionsCsv', ({ params: { teamId }, query }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.let('range', () =>
                clampExportRange(
                  Option.getOrElse(query.from, () => '2000-01-01'),
                  Option.getOrElse(query.to, () => todayIso()),
                ),
              ),
              Effect.bind('periods', () => configRepo.findStatementPeriods(teamId)),
              Effect.let('gaps', ({ periods, range }) => coverageGaps(periods, range)),
              Effect.bind('allMovements', () =>
                sql<{ readonly booked_on: string; readonly amount_minor: string }>`
                  SELECT booked_on::text, amount_minor::text FROM bank_transactions
                  WHERE team_id = ${teamId}
                `.pipe(catchSqlErrors),
              ),
              Effect.let('continuityViolations', ({ periods, allMovements }) =>
                checkPeriodContinuity(
                  periods,
                  allMovements.map((m) => ({
                    bookedOn: m.booked_on,
                    amountMinor: Number(m.amount_minor),
                  })),
                  todayIso(),
                ),
              ),
              Effect.tap(({ gaps, continuityViolations }) => {
                const acknowledged = Option.getOrElse(query.acknowledgeGaps, () => false);
                return (gaps.length > 0 || continuityViolations.length > 0) && !acknowledged
                  ? Effect.fail(
                      new BankSyncApi.ExportCoverageIncomplete({
                        gaps: gaps.map((g) => new BankSyncApi.BankSyncCoverageGap(g)),
                        continuityViolations: continuityViolations.map(
                          (v) => new BankSyncApi.BankSyncPeriodContinuityViolation(v),
                        ),
                      }),
                    )
                  : Effect.void;
              }),
              Effect.bind('rows', ({ range }) =>
                fetchExportRows(sql, teamId, range.from, range.to),
              ),
              Effect.map(({ rows, gaps }) => {
                const header = [
                  'Datum',
                  'Protistrana',
                  'Účet protistrany',
                  'Variabilní symbol',
                  'Zpráva pro příjemce',
                  'Částka',
                  'Měna',
                  'Stav přiřazení',
                  'Přiřazeno k',
                  'Poznámka',
                ];
                const csvRows = rows.map((r) => [
                  escapeCsvField(r.bookedOn),
                  escapeCsvField(r.counterpartyName ?? ''),
                  escapeCsvField(r.counterpartyAccount ?? ''),
                  escapeCsvField(r.variableSymbol ?? ''),
                  escapeCsvField(r.messageForRecipient ?? ''),
                  escapeCsvField(formatCsvAmount(r.amountMinor), { numeric: true }),
                  escapeCsvField(r.currency),
                  escapeCsvField(resolveMatchStateLabel(r.matchState, r.resolutionKind)),
                  escapeCsvField(r.assignedTo ?? ''),
                  escapeCsvField(r.ignoredReason ?? ''),
                ]);
                const csv = buildCsvDocument(header, csvRows);
                const filename = `vypis-${teamId}.csv`;
                const headersRecord: Record<string, string> =
                  gaps.length > 0
                    ? {
                        'content-type': 'text/csv; charset=utf-8',
                        'content-disposition': `attachment; filename=${filename}`,
                        'x-export-coverage-gaps': gaps.map((g) => `${g.from}/${g.to}`).join(';'),
                      }
                    : {
                        'content-type': 'text/csv; charset=utf-8',
                        'content-disposition': `attachment; filename=${filename}`,
                      };
                return HttpServerResponse.uint8Array(new TextEncoder().encode(csv), {
                  headers: headersRecord,
                });
              }),
            ),
          )

          // GET /teams/:teamId/bank-transactions/export.pdf
          .handle('exportBankTransactionsPdf', ({ params: { teamId }, query }) =>
            requireLedgerAccess(teamId).pipe(
              Effect.let('range', () =>
                clampExportRange(
                  Option.getOrElse(query.from, () => '2000-01-01'),
                  Option.getOrElse(query.to, () => todayIso()),
                ),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.bind('periods', () => configRepo.findStatementPeriods(teamId)),
              Effect.bind('rows', ({ range }) =>
                fetchExportRows(sql, teamId, range.from, range.to),
              ),
              Effect.bind('allMovements', () =>
                sql<{ readonly booked_on: string; readonly amount_minor: string }>`
                  SELECT booked_on::text, amount_minor::text FROM bank_transactions
                  WHERE team_id = ${teamId}
                `.pipe(catchSqlErrors),
              ),
              Effect.bind('pdfBuffer', ({ configOpt, periods, rows, allMovements, range }) => {
                const movements = allMovements.map((m) => ({
                  bookedOn: m.booked_on,
                  amountMinor: Number(m.amount_minor),
                }));
                const gaps = coverageGaps(periods, range);
                const continuityViolations = checkPeriodContinuity(periods, movements, todayIso());
                const config = Option.getOrNull(configOpt);
                return renderBankStatementPdf({
                  config: {
                    recipientName:
                      config === null ? '' : Option.getOrElse(config.recipient_name, () => ''),
                    registeredId: config === null ? Option.none() : config.registered_id,
                    registeredAddress: config === null ? Option.none() : config.registered_address,
                    computedIban:
                      config === null
                        ? ''
                        : Option.getOrElse(
                            Option.flatMap(config.account_number, (accountNumber) =>
                              Option.flatMap(config.bank_code, (bankCode) =>
                                CzIban.buildCzIban({
                                  prefix: Option.getOrUndefined(config.account_prefix),
                                  accountNumber,
                                  bankCode,
                                }),
                              ),
                            ),
                            () => '',
                          ),
                  },
                  docLabel: query.docLabel,
                  from: range.from,
                  to: range.to,
                  openingBalanceMinor: Option.getOrElse(
                    deriveBalanceBefore(periods, movements, range.from),
                    () => 0,
                  ),
                  closingBalanceMinor: Option.getOrElse(
                    deriveBalanceBefore(periods, movements, addDaysToDateString(range.to, 1)),
                    () => 0,
                  ),
                  coverageGaps: gaps,
                  periodContinuityViolations: continuityViolations,
                  rows: rows.map((r) => ({
                    bookedOn: r.bookedOn,
                    counterpartyName: Option.fromNullishOr(r.counterpartyName),
                    variableSymbol: Option.fromNullishOr(r.variableSymbol),
                    messageForRecipient: Option.fromNullishOr(r.messageForRecipient),
                    amountMinor: r.amountMinor,
                    matchState: r.matchState,
                    resolutionKind: r.resolutionKind,
                  })),
                });
              }),
              Effect.map(({ pdfBuffer }) => {
                const filename = `vypis-${teamId}.pdf`;
                return HttpServerResponse.uint8Array(pdfBuffer, {
                  headers: {
                    'content-type': 'application/pdf',
                    'content-disposition': `attachment; filename=${filename}`,
                  },
                });
              }),
            ),
          )

          // GET /teams/:teamId/members/variable-symbols/suggest
          .handle('suggestVariableSymbols', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, rosterForbidden),
              ),
              Effect.tap(({ membership }) =>
                hasPermission(membership, 'member:edit') ||
                hasPermission(membership, 'finance:manage_fees')
                  ? Effect.void
                  : Effect.fail(rosterForbidden),
              ),
              Effect.bind('roster', () => members.findRosterByTeam(teamId)),
              Effect.map(({ roster }) => buildVariableSymbolSuggestions(roster)),
            ),
          )

          // POST /teams/:teamId/members/variable-symbols/assign
          .handle('assignVariableSymbols', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, rosterForbidden),
              ),
              Effect.tap(({ membership }) =>
                hasPermission(membership, 'member:edit') ||
                hasPermission(membership, 'finance:manage_fees')
                  ? Effect.void
                  : Effect.fail(rosterForbidden),
              ),
              Effect.tap(() =>
                sql
                  .withTransaction(
                    Effect.forEach(
                      payload.assignments,
                      (entry) =>
                        members
                          .setVariableSymbol(
                            entry.memberId,
                            teamId,
                            Option.some(entry.variableSymbol),
                          )
                          .pipe(
                            Effect.catchTag('VariableSymbolConflict', (e) =>
                              Effect.fail(
                                new Roster.VariableSymbolTaken({
                                  holderMemberId: e.holderMemberId,
                                  holderName: e.holderName,
                                }),
                              ),
                            ),
                          ),
                      { concurrency: 1, discard: true },
                    ),
                  )
                  .pipe(catchSqlErrors),
              ),
              Effect.bind('roster', () => members.findRosterByTeam(teamId)),
              Effect.map(({ roster }) => {
                const assignedIds = new Set(payload.assignments.map((a) => a.memberId as string));
                return roster
                  .filter((entry) => assignedIds.has(entry.member_id as string))
                  .map((entry) => toRosterPlayer(entry));
              }),
            ),
          )

          // GET /teams/:teamId/fees/:feeId/assignments/:assignmentId/qr.png
          .handle('getAssignmentQrPng', ({ params: { teamId, feeId, assignmentId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.bind('config', ({ configOpt }) =>
                Option.match(configOpt, {
                  onNone: () => Effect.fail(notConfigured),
                  onSome: Effect.succeed,
                }),
              ),
              // All three containment checks: assignment ∈ fee, fee ∈ team, caller owns the
              // assignment or holds finance:record_payments — the QR embeds a member's VS, which
              // is enough to deliberately mis-credit a payment to them.
              Effect.bind('row', ({ membership }) =>
                sql<{
                  readonly member_id: string;
                  readonly team_member_user_id: string;
                  readonly variable_symbol: string | null;
                  readonly amount_minor: string;
                  readonly paid_minor: string;
                  readonly currency: string;
                  readonly fee_name: string;
                }>`
                  SELECT fa.team_member_id::text AS member_id, tm.user_id::text AS team_member_user_id,
                         tm.variable_symbol, fa.amount_minor::text, fa.paid_minor::text,
                         f.currency, f.name AS fee_name
                  FROM fee_assignments fa
                  JOIN fees f ON f.id = fa.fee_id
                  JOIN team_members tm ON tm.id = fa.team_member_id
                  WHERE fa.id = ${assignmentId} AND fa.fee_id = ${feeId} AND f.team_id = ${teamId}
                `.pipe(
                  catchSqlErrors,
                  Effect.flatMap((rows) =>
                    rows.length === 1 && rows[0] !== undefined
                      ? Effect.succeed(rows[0])
                      : Effect.fail(assignmentNotFound),
                  ),
                  Effect.flatMap((row) =>
                    row.team_member_user_id === membership.user_id ||
                    hasPermission(membership, 'finance:record_payments')
                      ? Effect.succeed(row)
                      : Effect.fail(forbidden),
                  ),
                ),
              ),
              Effect.bind('spayd', ({ config, row }) => {
                const computedIban = Option.flatMap(config.account_number, (accountNumber) =>
                  Option.flatMap(config.bank_code, (bankCode) =>
                    CzIban.buildCzIban({
                      prefix: Option.getOrUndefined(config.account_prefix),
                      accountNumber,
                      bankCode,
                    }),
                  ),
                );
                return Option.match(computedIban, {
                  onNone: () => Effect.fail(notConfigured),
                  onSome: (iban) => {
                    const outstanding = Math.max(
                      0,
                      Number(row.amount_minor) - Number(row.paid_minor),
                    );
                    const vsNorm = Option.fromNullishOr(row.variable_symbol).pipe(
                      Option.map((vs) => vs.trim().replace(/^0+/, '')),
                      Option.filter((vs) => vs !== ''),
                    );
                    const spaydOpt = Spayd.buildSpayd({
                      acc: iban,
                      amountMinor: BigInt(outstanding),
                      currency: row.currency,
                      message: Spayd.toSpaydMessage(row.fee_name),
                      variableSymbol: Option.getOrUndefined(vsNorm),
                      recipientName: Option.getOrUndefined(
                        Option.map(config.recipient_name, Spayd.transliterateToSpaydAscii),
                      ),
                    });
                    return Option.match(spaydOpt, {
                      onNone: () => Effect.fail(notConfigured),
                      onSome: Effect.succeed,
                    });
                  },
                });
              }),
              Effect.bind('png', ({ spayd }) =>
                renderQrPng(spayd).pipe(
                  Effect.catchTag('QrRenderError', (e) =>
                    LogicError.die(`getAssignmentQrPng: QR render failed: ${e.message}`),
                  ),
                ),
              ),
              Effect.map(({ png }) =>
                HttpServerResponse.uint8Array(png, {
                  headers: { 'content-type': 'image/png' },
                }),
              ),
            ),
          )
      );
    }),
  ),
);

// ---------------------------------------------------------------------------
// Export row fetch — shared by CSV and PDF (D8/D9/D13)
// ---------------------------------------------------------------------------

interface ExportRow {
  readonly bookedOn: string;
  readonly counterpartyName: string | null;
  readonly counterpartyAccount: string | null;
  readonly variableSymbol: string | null;
  readonly messageForRecipient: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly matchState: string;
  readonly resolutionKind: Option.Option<'other_income' | 'not_relevant'>;
  readonly assignedTo: string | null;
  readonly ignoredReason: string | null;
}

const fetchExportRows = (
  sql: SqlClient.SqlClient,
  teamId: Team.TeamId,
  from: string,
  to: string,
): Effect.Effect<ReadonlyArray<ExportRow>> =>
  sql<{
    readonly booked_on: string;
    readonly counterparty_name: string | null;
    readonly counterparty_account: string | null;
    readonly variable_symbol: string | null;
    readonly message_for_recipient: string | null;
    readonly amount_minor: string;
    readonly currency: string;
    readonly match_state: string;
    readonly resolution_kind: string | null;
    readonly assigned_to: string | null;
    readonly ignored_reason: string | null;
  }>`
    SELECT bt.booked_on::text, bt.counterparty_name, bt.counterparty_account, bt.variable_symbol,
           bt.message_for_recipient, bt.amount_minor::text, bt.currency, bt.match_state,
           bt.resolution_kind, bt.ignored_reason,
           (SELECT string_agg(DISTINCT f.name, ', ' ORDER BY f.name)
            FROM payments p
            JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
            JOIN fees f ON f.id = fa.fee_id
            WHERE p.bank_transaction_id = bt.id AND p.voided_at IS NULL) AS assigned_to
    FROM bank_transactions bt
    WHERE bt.team_id = ${teamId} AND bt.booked_on BETWEEN ${from}::date AND ${to}::date
    ORDER BY bt.booked_on ASC, bt.id ASC
  `.pipe(
    catchSqlErrors,
    Effect.map((rows) =>
      rows.map((row) => ({
        bookedOn: row.booked_on,
        counterpartyName: row.counterparty_name,
        counterpartyAccount: row.counterparty_account,
        variableSymbol: row.variable_symbol,
        messageForRecipient: row.message_for_recipient,
        amountMinor: Number(row.amount_minor),
        currency: row.currency,
        matchState: row.match_state,
        resolutionKind:
          row.resolution_kind === 'other_income' || row.resolution_kind === 'not_relevant'
            ? Option.some(row.resolution_kind)
            : Option.none<'other_income' | 'not_relevant'>(),
        assignedTo: row.assigned_to,
        ignoredReason: row.ignored_reason,
      })),
    ),
  );

// ---------------------------------------------------------------------------
// T2b — VS suggestion generator: `{year}{seq3}`, skipping taken values, deterministic order,
// no writes. Pure over an already-fetched roster.
// ---------------------------------------------------------------------------

const buildVariableSymbolSuggestions = (
  roster: ReadonlyArray<RosterEntry>,
): ReadonlyArray<BankSyncApi.VariableSymbolSuggestion> => {
  const normalize = (vs: string): string => {
    const stripped = vs.trim().replace(/^0+/, '');
    return stripped;
  };
  const taken = new Set(
    roster.flatMap((entry) =>
      Option.match(entry.variable_symbol, {
        onNone: () => [],
        onSome: (vs) => [normalize(vs)],
      }),
    ),
  );
  const withoutVs = roster
    .filter((entry) => Option.isNone(entry.variable_symbol))
    .sort((a, b) => (a.joined_at < b.joined_at ? -1 : a.joined_at > b.joined_at ? 1 : 0));

  const year = new Date().getFullYear();
  let seq = 1;
  const results: Array<BankSyncApi.VariableSymbolSuggestion> = [];
  for (const entry of withoutVs) {
    let candidate = `${String(year)}${String(seq).padStart(3, '0')}`;
    while (taken.has(normalize(candidate))) {
      seq += 1;
      candidate = `${String(year)}${String(seq).padStart(3, '0')}`;
    }
    taken.add(normalize(candidate));
    seq += 1;
    results.push(
      new BankSyncApi.VariableSymbolSuggestion({
        memberId: entry.member_id,
        memberName: Option.orElse(entry.name, () => Option.some(entry.username)),
        suggestedVariableSymbol: candidate,
      }),
    );
  }
  return results;
};
