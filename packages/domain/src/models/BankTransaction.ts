import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { BankSyncProvider } from '~/models/BankSyncConfig.js';
import { CurrencyCode } from '~/models/Fee.js';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const BankTransactionId = Schema.String.pipe(Schema.brand('BankTransactionId'));
export type BankTransactionId = typeof BankTransactionId.Type;

export const BankTransactionDirection = Schema.Literals(['incoming', 'outgoing']);
export type BankTransactionDirection = typeof BankTransactionDirection.Type;

export const BankTransactionMatchState = Schema.Literals([
  'unmatched',
  'partially_matched',
  'matched',
  'ignored',
  'not_applicable',
]);
export type BankTransactionMatchState = typeof BankTransactionMatchState.Type;

/**
 * D15 — the single source of truth for the DB `CHECK`, the matching engine, and the web's
 * closed `Record`. Exactly these nine literals; `possible_duplicate` is deliberately absent — it
 * is a hint carried alongside `no_open_assignment` (step 2.5 of the matching engine), never a
 * `match_reason` on its own.
 */
export const BankTransactionMatchReason = Schema.Literals([
  'no_vs', // the movement carries no VS at all
  'no_member_for_vs', // VS present, no member in this team owns it
  'ambiguous_member', // >1 member resolved for one VS — defensive only, the unique index forbids it
  'amount_mismatch_under', // one open assignment, amount < outstanding
  'overpayment', // one open assignment, amount > outstanding
  'ambiguous_multiple_exact', // >=2 open assignments, more than one matches exactly
  'ambiguous_multiple_open', // >=2 open assignments, none matching exactly
  'no_open_assignment', // member resolved, nothing open to pay
  'currency_mismatch', // member has open assignments, none in this currency
]);
export type BankTransactionMatchReason = typeof BankTransactionMatchReason.Type;

/**
 * D16 — discriminates the two flavours of `match_state = 'ignored'` so the audit export can
 * print "Jiný příjem klubu" instead of "Ignorováno" next to real club income. Only meaningful
 * when `match_state = 'ignored'`; `'duplicate'` is deliberately NOT a member — the duplicate
 * hint's one-click action is `'not_relevant'` with a pre-filled reason, not a third mode.
 */
export const BankTransactionResolutionKind = Schema.Literals(['other_income', 'not_relevant']);
export type BankTransactionResolutionKind = typeof BankTransactionResolutionKind.Type;

const _intFilter = Schema.makeFilter((n: number) => Number.isInteger(n), {
  message: 'Expected an integer',
  meta: { _tag: 'isInt' as const },
  toArbitraryConstraint: { number: { isInteger: true } },
});

const _nonZeroFilter = Schema.makeFilter((n: number) => n !== 0, {
  message: 'Expected a non-zero amount',
});

/**
 * D4 — `bank_transactions.amount_minor` is a SIGNED `BIGINT` (negative = outgoing); node-pg
 * decodes `BIGINT` as a string, so (mirroring `Fee.AmountMinor`) this accepts both a `number`
 * and a numeric string. Unlike `Fee.AmountMinor` it has NO `>= 0` constraint — only `<> 0`,
 * matching the DB `CHECK`.
 */
export const SignedAmountMinor = Schema.Union([
  Schema.Number.pipe(Schema.check(_intFilter), Schema.check(_nonZeroFilter)),
  Schema.NumberFromString.pipe(Schema.check(_intFilter), Schema.check(_nonZeroFilter)),
]).pipe(Schema.brand('SignedAmountMinor'));
export type SignedAmountMinor = typeof SignedAmountMinor.Type;

/**
 * `fio_movement_id` is `BIGINT` (up to 11 digits) — never `int4`, never decoded with a bare
 * `Schema.Int` (fails on every row once node-pg returns it as a string). Mirrors
 * `Fee.AmountMinor`'s number-or-numeric-string union (D4).
 */
export const FioMovementId = Schema.Union([
  Schema.Number.pipe(Schema.check(_intFilter), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  Schema.NumberFromString.pipe(
    Schema.check(_intFilter),
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
]).pipe(Schema.brand('FioMovementId'));
export type FioMovementId = typeof FioMovementId.Type;

/** D3 — `team_members.variable_symbol`, `CHECK (variable_symbol ~ '^[0-9]{1,10}$')`. */
export const VariableSymbol = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[0-9]{1,10}$/)),
  Schema.brand('VariableSymbol'),
);
export type VariableSymbol = typeof VariableSymbol.Type;

export class BankTransaction extends Model.Class<BankTransaction>('BankTransaction')({
  id: Model.Generated(BankTransactionId),
  team_id: TeamId,
  provider: BankSyncProvider,

  fio_movement_id: FioMovementId,
  fio_order_id: Schema.OptionFromNullOr(Schema.String), // column17, NOT unique — never reconcile on it

  booked_on: Schema.String, // DATE, decoded as 'YYYY-MM-DD' text (see the migration's read-path note)
  amount_minor: SignedAmountMinor,
  // GENERATED ALWAYS AS (CASE WHEN amount_minor < 0 THEN 'outgoing' ELSE 'incoming' END) STORED
  direction: Model.Generated(BankTransactionDirection),
  currency: CurrencyCode,

  variable_symbol: Schema.OptionFromNullOr(Schema.String),
  constant_symbol: Schema.OptionFromNullOr(Schema.String),
  specific_symbol: Schema.OptionFromNullOr(Schema.String),

  counterparty_account: Schema.OptionFromNullOr(Schema.String),
  counterparty_bank_code: Schema.OptionFromNullOr(Schema.String),
  counterparty_name: Schema.OptionFromNullOr(Schema.String),
  counterparty_bank_name: Schema.OptionFromNullOr(Schema.String),
  counterparty_bic: Schema.OptionFromNullOr(Schema.String),
  payer_reference: Schema.OptionFromNullOr(Schema.String),

  message_for_recipient: Schema.OptionFromNullOr(Schema.String),
  user_identification: Schema.OptionFromNullOr(Schema.String),
  tx_type: Schema.OptionFromNullOr(Schema.String),
  entered_by: Schema.OptionFromNullOr(Schema.String),
  specification: Schema.OptionFromNullOr(Schema.String),
  comment: Schema.OptionFromNullOr(Schema.String),

  match_state: BankTransactionMatchState,
  match_reason: Schema.OptionFromNullOr(BankTransactionMatchReason),
  // What the engine considered and why (rejected candidates, duplicate hints, ...) — opaque JSONB.
  match_evidence: Schema.OptionFromNullOr(Schema.Unknown),
  auto_match_suppressed: Schema.Boolean,

  ignored_reason: Schema.OptionFromNullOr(Schema.String),
  ignored_by_user_id: Schema.OptionFromNullOr(UserId),
  resolution_kind: Schema.OptionFromNullOr(BankTransactionResolutionKind),

  raw: Schema.Unknown, // the untouched Fio movement JSON — never exported under any disposition
  ingested_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
