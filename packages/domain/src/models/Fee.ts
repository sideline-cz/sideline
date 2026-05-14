import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';

export const FeeId = Schema.String.pipe(Schema.brand('FeeId'));
export type FeeId = typeof FeeId.Type;

export const AmountMinor = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand('AmountMinor'),
);
export type AmountMinor = typeof AmountMinor.Type;

export const CurrencyCode = Schema.String.pipe(
  Schema.check(Schema.isLengthBetween(3, 3)),
  Schema.brand('CurrencyCode'),
);
export type CurrencyCode = typeof CurrencyCode.Type;

export const FeeRecurrence = Schema.Literals(['none']);
export type FeeRecurrence = typeof FeeRecurrence.Type;

export const FeeTargetScope = Schema.Literals(['all_members', 'custom']);
export type FeeTargetScope = typeof FeeTargetScope.Type;

export class Fee extends Model.Class<Fee>('Fee')({
  id: Model.Generated(FeeId),
  team_id: TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  amount_minor: AmountMinor,
  currency: CurrencyCode,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  recurrence: FeeRecurrence,
  target_scope: FeeTargetScope,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
  archived_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}
