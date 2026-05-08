import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { UserId } from '~/models/User.js';

export const TeamId = Schema.String.pipe(Schema.brand('TeamId'));
export type TeamId = typeof TeamId.Type;

export class Team extends Model.Class<Team>('Team')({
  id: Model.Generated(TeamId),
  name: Schema.String,
  guild_id: Snowflake,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logo_url: Schema.OptionFromNullOr(Schema.String),
  created_by: UserId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
  welcome_channel_id: Schema.OptionFromNullOr(Snowflake),
  system_log_channel_id: Schema.OptionFromNullOr(Snowflake),
  welcome_message_template: Schema.OptionFromNullOr(Schema.String),
}) {}
