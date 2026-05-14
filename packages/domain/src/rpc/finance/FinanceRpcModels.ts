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
