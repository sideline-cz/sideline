import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PollId = Schema.String.pipe(Schema.brand('PollId'));
export type PollId = typeof PollId.Type;

export const PollOptionId = Schema.String.pipe(Schema.brand('PollOptionId'));
export type PollOptionId = typeof PollOptionId.Type;

export const PollVoteId = Schema.String.pipe(Schema.brand('PollVoteId'));
export type PollVoteId = typeof PollVoteId.Type;

export const PollStatus = Schema.Literals(['open', 'closed']);
export type PollStatus = typeof PollStatus.Type;

export class Poll extends Model.Class<Poll>('Poll')({
  id: Model.Generated(PollId),
  team_id: TeamId,
  guild_id: Snowflake,
  discord_channel_id: Snowflake,
  discord_message_id: Schema.OptionFromNullOr(Snowflake),
  question: Schema.String,
  status: PollStatus,
  multiple: Schema.Boolean,
  allowed_role_id: Schema.OptionFromNullOr(Snowflake),
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class PollOption extends Model.Class<PollOption>('PollOption')({
  id: Model.Generated(PollOptionId),
  poll_id: PollId,
  label: Schema.String,
  position: Schema.Number,
  added_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
}) {}

export class PollVote extends Model.Class<PollVote>('PollVote')({
  id: Model.Generated(PollVoteId),
  poll_id: PollId,
  option_id: PollOptionId,
  team_member_id: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
}) {}
