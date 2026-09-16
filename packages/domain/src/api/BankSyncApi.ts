import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema, SchemaGetter } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { AssignmentNotFound } from '~/api/FinanceApi.js';
import { Forbidden, RosterPlayer, VariableSymbolTaken } from '~/api/Roster.js';
import {
  BankSyncBackfillStatus,
  BankSyncProvider,
  BankSyncStatusCode,
} from '~/models/BankSyncConfig.js';
import {
  BankTransactionDirection,
  BankTransactionId,
  BankTransactionMatchReason,
  BankTransactionMatchState,
  BankTransactionResolutionKind,
  SignedAmountMinor,
} from '~/models/BankTransaction.js';
import { AmountMinor, CurrencyCode, FeeId } from '~/models/Fee.js';
import { FeeAssignmentId } from '~/models/FeeAssignment.js';
import { PaymentId } from '~/models/Payment.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export { AssignmentNotFound, Forbidden, VariableSymbolTaken };

// ---------------------------------------------------------------------------
// Query-string boolean helper (packages/domain/AGENTS.md)
// ---------------------------------------------------------------------------

const BooleanFromString = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((s: 'true' | 'false') => s === 'true'),
    encode: SchemaGetter.transform((b: boolean) => (b ? 'true' : 'false') as 'true' | 'false'),
  }),
);

// ---------------------------------------------------------------------------
// View types (response DTOs)
// ---------------------------------------------------------------------------

/**
 * Config view returned to web clients. Never carries the Fio token — `fioTokenSet` is the only
 * signal of whether one is stored. `status` / `expiringSoon` are computed server-side (D11) and
 * must be rendered as-is, never re-derived on the client.
 */
export class BankSyncConfigView extends Schema.Class<BankSyncConfigView>('BankSyncConfigView')({
  teamId: TeamId,
  provider: BankSyncProvider,
  enabled: Schema.Boolean,
  autoMatchEnabled: Schema.Boolean,

  accountPrefix: Schema.OptionFromNullOr(Schema.String),
  accountNumber: Schema.OptionFromNullOr(Schema.String),
  bankCode: Schema.OptionFromNullOr(Schema.String),
  /** Computed via `CzIban.buildCzIban` from `accountPrefix`/`accountNumber`/`bankCode`. */
  computedIban: Schema.OptionFromNullOr(Schema.String),
  currency: CurrencyCode,

  recipientName: Schema.OptionFromNullOr(Schema.String),
  registeredId: Schema.OptionFromNullOr(Schema.String),
  registeredAddress: Schema.OptionFromNullOr(Schema.String),
  bankName: Schema.OptionFromNullOr(Schema.String),

  fioTokenSet: Schema.Boolean,
  tokenCreatedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  /** `tokenCreatedAt + 180d`; the T-14 DM and the `expiringSoon` banner both key off this. */
  tokenExpiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),

  /** D11 — the six-rank status ladder, computed server-side. */
  status: BankSyncStatusCode,
  /** D11 — additive, never suppressed by `status`: a token can be both expiring AND failing. */
  expiringSoon: Schema.Boolean,

  backfillStatus: Schema.OptionFromNullOr(BankSyncBackfillStatus),
  backfillCursor: Schema.OptionFromNullOr(Schema.String),
  backfillRunId: Schema.OptionFromNullOr(Schema.String),

  lastSuccessAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  lastAttemptAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  lastAttemptFailed: Schema.Boolean,

  /** D13 — set when a period's opening/closing balance does not reconcile against ingested rows. */
  coverageWarning: Schema.OptionFromNullOr(Schema.String),

  createdAt: Schemas.DateTimeFromIsoString,
  updatedAt: Schemas.DateTimeFromIsoString,
}) {}

export class BankSyncTestResult extends Schema.Class<BankSyncTestResult>('BankSyncTestResult')({
  ok: Schema.Boolean,
  message: Schema.OptionFromNullOr(Schema.String),
  /** Fio's own `info.iban`, for a cross-check display against `computedIban`. */
  accountIban: Schema.OptionFromNullOr(Schema.String),
}) {}

export class BankSyncBackfillStartedResult extends Schema.Class<BankSyncBackfillStartedResult>(
  'BankSyncBackfillStartedResult',
)({
  backfillRunId: Schema.String,
}) {}

export class BankSyncCoverageGap extends Schema.Class<BankSyncCoverageGap>('BankSyncCoverageGap')({
  from: Schema.String, // 'YYYY-MM-DD'
  to: Schema.String, // 'YYYY-MM-DD'
}) {}

/**
 * D13 — a recorded `bank_statement_periods` row whose arithmetic does not hold:
 * `openingBalanceMinor + SUM(movements in range) !== closingBalanceMinor`. Distinct from
 * `BankSyncCoverageGap` (a missing period, "Fio never answered for this range") — this is a
 * period Fio DID answer for, but whose ingested movements don't add up, meaning some movement is
 * silently missing despite the period existing. Both render in the same red band (D9).
 */
export class BankSyncPeriodContinuityViolation extends Schema.Class<BankSyncPeriodContinuityViolation>(
  'BankSyncPeriodContinuityViolation',
)({
  dateStart: Schema.String, // 'YYYY-MM-DD'
  dateEnd: Schema.String, // 'YYYY-MM-DD'
  openingBalanceMinor: Schema.Int,
  closingBalanceMinor: Schema.Int,
  actualClosingMinor: Schema.Int,
}) {}

/** D13 — the queue's KPI header. */
export class BankSyncSummaryView extends Schema.Class<BankSyncSummaryView>('BankSyncSummaryView')({
  importedCount: Schema.Int,
  pendingCount: Schema.Int,
  matchedCount: Schema.Int,
  ignoredCount: Schema.Int,
  otherIncomeCount: Schema.Int,
  autoMatchedLast30d: Schema.Int,
  manuallyMatchedLast30d: Schema.Int,
  membersWithoutVsCount: Schema.Int,
  oldestPendingBookedOn: Schema.OptionFromNullOr(Schema.String),
  periodIncomeMinor: AmountMinor,
  periodExpensesMinor: AmountMinor,
  periodNetMinor: SignedAmountMinor,
  /** D13 — derived (never looked up: recorded periods are up to 60 days apart across a
   * backfilled era, so an arbitrary `from`/`to` rarely has a matching row) via
   * `bankCoverage.deriveBalanceBefore`, anchored on the nearest recorded statement period at or
   * before the date and walked forward through ingested movements. The export panel renders
   * these instead of "—" now that the summary carries them alongside `coverageGaps`. */
  openingBalanceMinor: Schema.Int,
  closingBalanceMinor: Schema.Int,
  coverageGaps: Schema.Array(BankSyncCoverageGap),
  /** D13 — see `BankSyncPeriodContinuityViolation`. Empty in the overwhelming common case. */
  periodContinuityViolations: Schema.Array(BankSyncPeriodContinuityViolation),
}) {}

export class BankTransactionView extends Schema.Class<BankTransactionView>('BankTransactionView')({
  id: BankTransactionId,
  bookedOn: Schema.String, // 'YYYY-MM-DD'
  amountMinor: SignedAmountMinor,
  currency: CurrencyCode,
  direction: BankTransactionDirection,
  counterpartyName: Schema.OptionFromNullOr(Schema.String),
  counterpartyAccount: Schema.OptionFromNullOr(Schema.String),
  variableSymbol: Schema.OptionFromNullOr(Schema.String),
  messageForRecipient: Schema.OptionFromNullOr(Schema.String),
  matchState: BankTransactionMatchState,
  matchReason: Schema.OptionFromNullOr(BankTransactionMatchReason),
  resolutionKind: Schema.OptionFromNullOr(BankTransactionResolutionKind),
  /** The step-2.5 duplicate hint — supporting text on the `no_open_assignment` badge, never a
   * `match_reason` of its own (`possible_duplicate` is deliberately not in that union). */
  duplicateOfTransactionId: Schema.OptionFromNullOr(BankTransactionId),
  /** The member resolved from the VS, when one could be resolved — regardless of match outcome. */
  matchedMemberName: Schema.OptionFromNullOr(Schema.String),
  ingestedAt: Schemas.DateTimeFromIsoString,
}) {}

/** An open fee assignment the resolve dialog can allocate this transaction's amount against. */
export class BankTransactionCandidateAssignment extends Schema.Class<BankTransactionCandidateAssignment>(
  'BankTransactionCandidateAssignment',
)({
  assignmentId: FeeAssignmentId,
  feeId: FeeId,
  feeName: Schema.String,
  currency: CurrencyCode,
  outstandingMinor: AmountMinor,
  effectiveDueAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
}) {}

/** A payment already linked to this transaction — populated for `partially_matched`/`matched`. */
export class BankTransactionMatchedPayment extends Schema.Class<BankTransactionMatchedPayment>(
  'BankTransactionMatchedPayment',
)({
  paymentId: PaymentId,
  feeAssignmentId: FeeAssignmentId,
  feeName: Schema.String,
  amountMinor: AmountMinor,
  matchedBy: Schema.Literals(['auto', 'manual']),
  recordedAt: Schemas.DateTimeFromIsoString,
}) {}

export class BankTransactionDetailView extends Schema.Class<BankTransactionDetailView>(
  'BankTransactionDetailView',
)({
  id: BankTransactionId,
  bookedOn: Schema.String,
  amountMinor: SignedAmountMinor,
  currency: CurrencyCode,
  direction: BankTransactionDirection,

  counterpartyName: Schema.OptionFromNullOr(Schema.String),
  counterpartyAccount: Schema.OptionFromNullOr(Schema.String),
  counterpartyBankCode: Schema.OptionFromNullOr(Schema.String),
  counterpartyBankName: Schema.OptionFromNullOr(Schema.String),
  counterpartyBic: Schema.OptionFromNullOr(Schema.String),

  variableSymbol: Schema.OptionFromNullOr(Schema.String),
  constantSymbol: Schema.OptionFromNullOr(Schema.String),
  specificSymbol: Schema.OptionFromNullOr(Schema.String),
  messageForRecipient: Schema.OptionFromNullOr(Schema.String),
  userIdentification: Schema.OptionFromNullOr(Schema.String),
  comment: Schema.OptionFromNullOr(Schema.String),

  matchState: BankTransactionMatchState,
  matchReason: Schema.OptionFromNullOr(BankTransactionMatchReason),
  resolutionKind: Schema.OptionFromNullOr(BankTransactionResolutionKind),
  ignoredReason: Schema.OptionFromNullOr(Schema.String),

  duplicateOfTransactionId: Schema.OptionFromNullOr(BankTransactionId),
  /** Accent-folded exact-name hints only (B-cut-3) — never sufficient to auto-match. */
  suggestedMemberNames: Schema.Array(Schema.String),
  resolvedMemberId: Schema.OptionFromNullOr(TeamMemberId),
  resolvedMemberName: Schema.OptionFromNullOr(Schema.String),

  candidateAssignments: Schema.Array(BankTransactionCandidateAssignment),
  matchedPayments: Schema.Array(BankTransactionMatchedPayment),

  ingestedAt: Schemas.DateTimeFromIsoString,
  updatedAt: Schemas.DateTimeFromIsoString,
}) {}

export class BulkResolveResult extends Schema.Class<BulkResolveResult>('BulkResolveResult')({
  resolvedCount: Schema.Int,
  skippedCount: Schema.Int,
}) {}

export class RematchResult extends Schema.Class<RematchResult>('RematchResult')({
  consideredCount: Schema.Int,
  matchedCount: Schema.Int,
  queuedCount: Schema.Int,
}) {}

export class VariableSymbolSuggestion extends Schema.Class<VariableSymbolSuggestion>(
  'VariableSymbolSuggestion',
)({
  memberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  suggestedVariableSymbol: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

/**
 * Write-only token (mirrors `EmailForwardingApi.UpsertEmailForwardingConfigRequest`'s
 * `imap_secret`): absent key => keep the stored token. `Schema.RedactedFromValue` so a stray
 * `JSON.stringify`/log call on the decoded payload cannot leak it (D10).
 */
export const UpsertBankSyncConfigRequest = Schema.Struct({
  enabled: Schema.Boolean,
  auto_match_enabled: Schema.Boolean,
  account_prefix: Schema.OptionFromNullOr(Schema.String),
  account_number: Schema.String,
  bank_code: Schema.String,
  currency: CurrencyCode,
  recipient_name: Schema.OptionFromNullOr(Schema.String),
  registered_id: Schema.OptionFromNullOr(Schema.String),
  registered_address: Schema.OptionFromNullOr(Schema.String),
  bank_name: Schema.OptionFromNullOr(Schema.String),
  fio_token: Schema.OptionFromOptional(Schema.RedactedFromValue(Schema.NonEmptyString)),
  fio_token_created_at: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
});
export type UpsertBankSyncConfigRequest = Schema.Schema.Type<typeof UpsertBankSyncConfigRequest>;

export const StartBackfillRequest = Schema.Struct({
  from: Schema.String, // 'YYYY-MM-DD'
  to: Schema.String, // 'YYYY-MM-DD'
});
export type StartBackfillRequest = Schema.Schema.Type<typeof StartBackfillRequest>;

/** One allocation of this transaction's amount against one open fee assignment. A single-element
 * array is "Přiřadit členovi" (incl. the intentional-overpayment sub-mode); multiple elements is
 * "Rozdělit mezi víc předpisů". Allocations are locked and applied `ORDER BY id` in SQL — never
 * sorted in JS (D10c). */
export const MatchAllocation = Schema.Struct({
  assignmentId: FeeAssignmentId,
  amountMinor: AmountMinor,
});
export type MatchAllocation = Schema.Schema.Type<typeof MatchAllocation>;

export const MatchBankTransactionRequest = Schema.Struct({
  allocations: Schema.Array(MatchAllocation).pipe(Schema.check(Schema.isMinLength(1))),
});
export type MatchBankTransactionRequest = Schema.Schema.Type<typeof MatchBankTransactionRequest>;

export const UnmatchBankTransactionRequest = Schema.Struct({
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(3))),
});
export type UnmatchBankTransactionRequest = Schema.Schema.Type<
  typeof UnmatchBankTransactionRequest
>;

export const IgnoreBankTransactionRequest = Schema.Struct({
  kind: BankTransactionResolutionKind,
  reason: Schema.NonEmptyString,
});
export type IgnoreBankTransactionRequest = Schema.Schema.Type<typeof IgnoreBankTransactionRequest>;

export const BulkResolveBankTransactionsRequest = Schema.Struct({
  txIds: Schema.Array(BankTransactionId).pipe(Schema.check(Schema.isMinLength(1))),
  kind: BankTransactionResolutionKind,
  reason: Schema.NonEmptyString,
});
export type BulkResolveBankTransactionsRequest = Schema.Schema.Type<
  typeof BulkResolveBankTransactionsRequest
>;

export const AssignVariableSymbolEntry = Schema.Struct({
  memberId: TeamMemberId,
  variableSymbol: Schema.String,
});
export type AssignVariableSymbolEntry = Schema.Schema.Type<typeof AssignVariableSymbolEntry>;

export const AssignVariableSymbolsRequest = Schema.Struct({
  assignments: Schema.Array(AssignVariableSymbolEntry).pipe(Schema.check(Schema.isMinLength(1))),
});
export type AssignVariableSymbolsRequest = Schema.Schema.Type<typeof AssignVariableSymbolsRequest>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BankSyncForbidden extends Schema.TaggedErrorClass<BankSyncForbidden>()(
  'BankSyncForbidden',
  {},
) {}

export class BankSyncNotConfigured extends Schema.TaggedErrorClass<BankSyncNotConfigured>()(
  'BankSyncNotConfigured',
  {},
) {}

export class BankTransactionNotFound extends Schema.TaggedErrorClass<BankTransactionNotFound>()(
  'BankTransactionNotFound',
  {},
) {}

export class BankTransactionAlreadyMatched extends Schema.TaggedErrorClass<BankTransactionAlreadyMatched>()(
  'BankTransactionAlreadyMatched',
  {},
) {}

/**
 * The requested allocations, added to whatever is already recorded against this bank
 * transaction (live payments, re-read under the row lock), would exceed the transaction's
 * absolute amount. Distinct from `BankTransactionAlreadyMatched` — the transaction row itself
 * may still be `unmatched`/`partially_matched`, but the money does not add up.
 */
export class AllocationExceedsTransaction extends Schema.TaggedErrorClass<AllocationExceedsTransaction>()(
  'AllocationExceedsTransaction',
  {},
) {}

/** The same `assignmentId` appears more than once in one request's `allocations`. */
export class DuplicateAllocationAssignment extends Schema.TaggedErrorClass<DuplicateAllocationAssignment>()(
  'DuplicateAllocationAssignment',
  {},
) {}

/** A distributed poll lease (D10b) or the 60 s `/rematch` lease is already held. */
export class BankSyncBusy extends Schema.TaggedErrorClass<BankSyncBusy>()('BankSyncBusy', {}) {}

export class InvalidBankAccount extends Schema.TaggedErrorClass<InvalidBankAccount>()(
  'InvalidBankAccount',
  {},
) {}

/** D13 — the requested export range is not fully covered by ingested statement periods, or a
 * recorded period's arithmetic does not hold (see `BankSyncPeriodContinuityViolation`). */
export class ExportCoverageIncomplete extends Schema.TaggedErrorClass<ExportCoverageIncomplete>()(
  'ExportCoverageIncomplete',
  {
    gaps: Schema.Array(BankSyncCoverageGap),
    continuityViolations: Schema.Array(BankSyncPeriodContinuityViolation),
  },
) {}

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class BankSyncApiGroup extends HttpApiGroup.make('bankSync')
  .add(
    HttpApiEndpoint.get('getBankSyncConfig', '/teams/:teamId/bank-sync', {
      success: BankSyncConfigView,
      error: BankSyncForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('upsertBankSyncConfig', '/teams/:teamId/bank-sync', {
      success: BankSyncConfigView,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        InvalidBankAccount.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpsertBankSyncConfigRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('testBankSyncConfig', '/teams/:teamId/bank-sync/test', {
      success: BankSyncTestResult,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankSyncNotConfigured.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('startBankSyncBackfill', '/teams/:teamId/bank-sync/backfill', {
      success: BankSyncBackfillStartedResult.pipe(HttpApiSchema.status(202)),
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankSyncNotConfigured.pipe(HttpApiSchema.status(404)),
      ],
      payload: StartBackfillRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getBankSyncSummary', '/teams/:teamId/bank-sync/summary', {
      success: BankSyncSummaryView,
      error: BankSyncForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        from: Schema.OptionFromOptional(Schema.String),
        to: Schema.OptionFromOptional(Schema.String),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listBankTransactions', '/teams/:teamId/bank-transactions', {
      success: Schema.Array(BankTransactionView),
      error: BankSyncForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        from: Schema.OptionFromOptional(Schema.String),
        to: Schema.OptionFromOptional(Schema.String),
        state: Schema.OptionFromOptional(BankTransactionMatchState),
        direction: Schema.OptionFromOptional(BankTransactionDirection),
        reason: Schema.OptionFromOptional(BankTransactionMatchReason),
        q: Schema.OptionFromOptional(Schema.String),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getBankTransaction', '/teams/:teamId/bank-transactions/:txId', {
      success: BankTransactionDetailView,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankTransactionNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, txId: BankTransactionId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('matchBankTransaction', '/teams/:teamId/bank-transactions/:txId/match', {
      success: BankTransactionDetailView,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankTransactionNotFound.pipe(HttpApiSchema.status(404)),
        BankTransactionAlreadyMatched.pipe(HttpApiSchema.status(409)),
        AssignmentNotFound.pipe(HttpApiSchema.status(404)),
        AllocationExceedsTransaction.pipe(HttpApiSchema.status(409)),
        DuplicateAllocationAssignment.pipe(HttpApiSchema.status(400)),
      ],
      payload: MatchBankTransactionRequest,
      params: { teamId: TeamId, txId: BankTransactionId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'unmatchBankTransaction',
      '/teams/:teamId/bank-transactions/:txId/unmatch',
      {
        success: BankTransactionDetailView,
        error: [
          BankSyncForbidden.pipe(HttpApiSchema.status(403)),
          BankTransactionNotFound.pipe(HttpApiSchema.status(404)),
        ],
        payload: UnmatchBankTransactionRequest,
        params: { teamId: TeamId, txId: BankTransactionId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('ignoreBankTransaction', '/teams/:teamId/bank-transactions/:txId/ignore', {
      success: BankTransactionDetailView,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankTransactionNotFound.pipe(HttpApiSchema.status(404)),
        BankTransactionAlreadyMatched.pipe(HttpApiSchema.status(409)),
      ],
      payload: IgnoreBankTransactionRequest,
      params: { teamId: TeamId, txId: BankTransactionId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'unignoreBankTransaction',
      '/teams/:teamId/bank-transactions/:txId/unignore',
      {
        success: BankTransactionDetailView,
        error: [
          BankSyncForbidden.pipe(HttpApiSchema.status(403)),
          BankTransactionNotFound.pipe(HttpApiSchema.status(404)),
          BankTransactionAlreadyMatched.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, txId: BankTransactionId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('bulkResolveBankTransactions', '/teams/:teamId/bank-transactions/bulk', {
      success: BulkResolveResult,
      error: BankSyncForbidden.pipe(HttpApiSchema.status(403)),
      payload: BulkResolveBankTransactionsRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('rematchBankTransactions', '/teams/:teamId/bank-transactions/rematch', {
      success: RematchResult,
      error: [
        BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        BankSyncNotConfigured.pipe(HttpApiSchema.status(404)),
        BankSyncBusy.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'exportBankTransactionsCsv',
      '/teams/:teamId/bank-transactions/export.csv',
      {
        success: Schema.Void,
        error: [
          BankSyncForbidden.pipe(HttpApiSchema.status(403)),
          ExportCoverageIncomplete.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId },
        query: {
          from: Schema.OptionFromOptional(Schema.String),
          to: Schema.OptionFromOptional(Schema.String),
          acknowledgeGaps: Schema.OptionFromOptional(BooleanFromString),
        },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'exportBankTransactionsPdf',
      '/teams/:teamId/bank-transactions/export.pdf',
      {
        success: Schema.Void,
        error: BankSyncForbidden.pipe(HttpApiSchema.status(403)),
        params: { teamId: TeamId },
        query: {
          from: Schema.OptionFromOptional(Schema.String),
          to: Schema.OptionFromOptional(Schema.String),
          docLabel: Schema.OptionFromOptional(Schema.String),
        },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'suggestVariableSymbols',
      '/teams/:teamId/members/variable-symbols/suggest',
      {
        success: Schema.Array(VariableSymbolSuggestion),
        error: Forbidden.pipe(HttpApiSchema.status(403)),
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'assignVariableSymbols',
      '/teams/:teamId/members/variable-symbols/assign',
      {
        success: Schema.Array(RosterPlayer),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          VariableSymbolTaken.pipe(HttpApiSchema.status(409)),
        ],
        payload: AssignVariableSymbolsRequest,
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'getAssignmentQrPng',
      '/teams/:teamId/fees/:feeId/assignments/:assignmentId/qr.png',
      {
        success: Schema.Void,
        error: [
          BankSyncForbidden.pipe(HttpApiSchema.status(403)),
          BankSyncNotConfigured.pipe(HttpApiSchema.status(404)),
          AssignmentNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, feeId: FeeId, assignmentId: FeeAssignmentId },
      },
    ).middleware(AuthMiddleware),
  ) {}
