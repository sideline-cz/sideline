import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PersonalEventChannelId = Schema.String.pipe(Schema.brand('PersonalEventChannelId'));
export type PersonalEventChannelId = typeof PersonalEventChannelId.Type;

export class PersonalEventChannel extends Model.Class<PersonalEventChannel>('PersonalEventChannel')(
  {
    id: Model.Generated(PersonalEventChannelId),
    team_id: TeamId,
    team_member_id: TeamMemberId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    created_at: Model.DateTimeInsertFromDate,
    updated_at: Model.DateTimeUpdateFromDate,
  },
) {}
