import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { UserId } from '~/api/Auth.js';
import { AmountMinor, CurrencyCode } from '~/models/Fee.js';
import { ManualPaymentMethod } from '~/models/Payment.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const MemberCreditDepositId = Schema.String.pipe(Schema.brand('MemberCreditDepositId'));
export type MemberCreditDepositId = typeof MemberCreditDepositId.Type;

export class MemberCreditAccount extends Model.Class<MemberCreditAccount>('MemberCreditAccount')({
  team_member_id: TeamMemberId,
  currency: CurrencyCode,
  balance_minor: AmountMinor,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class MemberCreditDeposit extends Model.Class<MemberCreditDeposit>('MemberCreditDeposit')({
  id: Model.Generated(MemberCreditDepositId),
  team_member_id: TeamMemberId,
  currency: CurrencyCode,
  amount_minor: AmountMinor,
  method: ManualPaymentMethod,
  paid_at: Schemas.DateTimeFromDate,
  note: Schema.OptionFromNullOr(Schema.String),
  recorded_by_user_id: UserId,
  voided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  voided_by_user_id: Schema.OptionFromNullOr(UserId),
  void_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
}) {}
