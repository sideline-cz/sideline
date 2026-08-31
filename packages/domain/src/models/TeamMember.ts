import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const TeamMemberId = Schema.String.pipe(Schema.brand('TeamMemberId'));
export type TeamMemberId = typeof TeamMemberId.Type;

export const JerseyNumber = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
);
export type JerseyNumber = typeof JerseyNumber.Type;

export class TeamMember extends Model.Class<TeamMember>('TeamMember')({
  id: Model.Generated(TeamMemberId),
  team_id: TeamId,
  user_id: UserId,
  active: Schema.Boolean,
  jersey_number: Model.FieldExcept(['insert'])(Schema.OptionFromNullOr(Schema.Number)),
  joined_at: Model.DateTimeInsertFromDate,
  // PR-8 (CC-10): tri-state ("have we ever observed this user in the guild"), NULL = unknown.
  // Written by `Guild/RegisterMember` (idempotent COALESCE) and `Guild/ReconcileMembers`, cleared
  // by `Guild/RemoveMember`. It does NOT gate role-sync emission — see reconcileMemberDiscordRoles.ts.
  discord_joined_at: Model.FieldExcept(['insert'])(
    Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  ),
}) {}
