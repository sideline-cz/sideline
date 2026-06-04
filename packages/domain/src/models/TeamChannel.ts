import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';

export const TeamChannelId = Schema.String.pipe(Schema.brand('TeamChannelId'));
export type TeamChannelId = typeof TeamChannelId.Type;

export class TeamChannel extends Model.Class<TeamChannel>('TeamChannel')({
  id: Model.Generated(TeamChannelId),
  team_id: TeamId,
  name: Schema.String,
  category: Schema.OptionFromNullOr(Schema.String),
  position: Schema.Number,
  archived: Schema.Boolean,
  discord_channel_id: Schema.OptionFromNullOr(Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Snowflake),
  created_at: Model.DateTimeInsertFromDate,
}) {}
