import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { UserId } from '~/api/Auth.js';
import { AmountMinor } from '~/models/Fee.js';
import { FeeAssignmentId } from '~/models/FeeAssignment.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PaymentId = Schema.String.pipe(Schema.brand('PaymentId'));
export type PaymentId = typeof PaymentId.Type;

export const PaymentMethod = Schema.Literals(['cash', 'bank_transfer']);
export type PaymentMethod = typeof PaymentMethod.Type;

export class Payment extends Model.Class<Payment>('Payment')({
  id: Model.Generated(PaymentId),
  fee_assignment_id: FeeAssignmentId,
  team_member_id: TeamMemberId,
  amount_minor: AmountMinor,
  method: PaymentMethod,
  paid_at: Schemas.DateTimeFromDate,
  note: Schema.OptionFromNullOr(Schema.String),
  recorded_by_user_id: UserId,
  voided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  voided_by_user_id: Schema.OptionFromNullOr(UserId),
  void_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
}) {}
