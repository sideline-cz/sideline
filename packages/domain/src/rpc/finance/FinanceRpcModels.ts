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
  assignments: Schema.Array(FinanceStatusAssignment),
}) {}

export class GetMyStatusResult extends Schema.Class<GetMyStatusResult>('GetMyStatusResult')({
  groups: Schema.Array(FinanceStatusCurrencyGroup),
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

/**
 * The team has no usable bank-sync configuration to build a QR from (not connected, or the
 * account identity cannot produce a valid IBAN) — the reminder is still sent, just without a QR.
 */
export class FinanceQrUnavailable extends Schema.TaggedErrorClass<FinanceQrUnavailable>()(
  'FinanceQrUnavailable',
  {},
) {}
