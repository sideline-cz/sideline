import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { AmountMinor, FeeId } from '~/models/Fee.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const FeeAssignmentId = Schema.String.pipe(Schema.brand('FeeAssignmentId'));
export type FeeAssignmentId = typeof FeeAssignmentId.Type;

export const StoredAssignmentStatus = Schema.Literals(['active', 'waived']);
export type StoredAssignmentStatus = typeof StoredAssignmentStatus.Type;

export const FeeAssignmentStatus = Schema.Literals([
  'pending',
  'partial',
  'paid',
  'overdue',
  'waived',
]);
export type FeeAssignmentStatus = typeof FeeAssignmentStatus.Type;

export class FeeAssignment extends Model.Class<FeeAssignment>('FeeAssignment')({
  id: Model.Generated(FeeAssignmentId),
  fee_id: FeeId,
  team_member_id: TeamMemberId,
  amount_minor: AmountMinor,
  paid_minor: AmountMinor,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  stored_status: StoredAssignmentStatus,
  waived_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
