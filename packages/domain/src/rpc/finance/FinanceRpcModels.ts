import { Schema } from 'effect';
import { AmountMinor, CurrencyCode } from '~/models/Fee.js';
import { FeeAssignmentId, FeeAssignmentStatus } from '~/models/FeeAssignment.js';

export class FinanceGuildNotFound extends Schema.TaggedErrorClass<FinanceGuildNotFound>()(
  'FinanceGuildNotFound',
  {},
) {}

export class FinanceMemberNotFound extends Schema.TaggedErrorClass<FinanceMemberNotFound>()(
  'FinanceMemberNotFound',
  {},
) {}

export class FinanceStatusAssignment extends Schema.Class<FinanceStatusAssignment>(
  'FinanceStatusAssignment',
)({
  assignment_id: FeeAssignmentId,
  fee_name: Schema.String,
  status: FeeAssignmentStatus,
  due_minor: AmountMinor,
  paid_minor: AmountMinor,
  effective_due_at: Schema.OptionFromNullOr(Schema.String), // ISO string for transport
}) {}

export class FinanceStatusCurrencyGroup extends Schema.Class<FinanceStatusCurrencyGroup>(
  'FinanceStatusCurrencyGroup',
)({
  currency: CurrencyCode,
  total_outstanding_minor: AmountMinor,
  // Credit the member holds in this currency, NOT already deducted from
  // `total_outstanding_minor` — the two are independent balances server-side. Whatever renders
  // the group is responsible for netting them (see `buildFinanceStatusEmbed`).
  credit_minor: AmountMinor,
  assignments: Schema.Array(FinanceStatusAssignment),
}) {}

/**
 * T10 — the payment QR delivered by the bot alongside a reminder DM. `spayd` is the raw SPAYD
 * payload (for debugging / a text fallback); `png_base64` is the rendered QR image the bot
 * attaches via `attachment://<filename>`.
 */
export class PaymentQrResult extends Schema.Class<PaymentQrResult>('PaymentQrResult')({
  spayd: Schema.String,
  png_base64: Schema.String,
  filename: Schema.String,
}) {}

export class GetMyStatusResult extends Schema.Class<GetMyStatusResult>('GetMyStatusResult')({
  groups: Schema.Array(FinanceStatusCurrencyGroup),
  // The one standing code `/finance` always shows: the net outstanding sum in the club's
  // bank-account currency, or — when that nets to zero — the same code with no `AM`, so the
  // member can still top up any amount. `null` only when the club has no usable bank config or
  // the member has no variable symbol; the command then renders exactly as it did before.
  //
  // `NullOr`, not `OptionFromNullOr`: an `Option`-wrapped `Schema.Class` here is one step more
  // type-inference than `SyncRpcs`' already-large union survives — it collapses `AppLive`'s `R`
  // to `unknown` and surfaces as an unrelated error in `run.ts`.
  qr: Schema.NullOr(PaymentQrResult),
}) {}

/**
 * The team has no usable bank-sync configuration to build a QR from (not connected, or the
 * account identity cannot produce a valid IBAN) — the reminder is still sent, just without a QR.
 */
export class FinanceQrUnavailable extends Schema.TaggedErrorClass<FinanceQrUnavailable>()(
  'FinanceQrUnavailable',
  {},
) {}
