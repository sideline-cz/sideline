import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PersonalEventChannelId = Schema.String.pipe(Schema.brand('PersonalEventChannelId'));
export type PersonalEventChannelId = typeof PersonalEventChannelId.Type;

// Nastavitelná docházka (plan §3/§5.2): which slice of a member's events this channel
// carries. 'all' is the combined channel (today's only mode, byte-identical naming).
export const PersonalChannelBucket = Schema.Literals(['all', 'training', 'tournament', 'other']);
export type PersonalChannelBucket = typeof PersonalChannelBucket.Type;

export class PersonalEventChannel extends Model.Class<PersonalEventChannel>('PersonalEventChannel')(
  {
    id: Model.Generated(PersonalEventChannelId),
    team_id: TeamId,
    team_member_id: TeamMemberId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    bucket: PersonalChannelBucket,
    created_at: Model.DateTimeInsertFromDate,
    updated_at: Model.DateTimeUpdateFromDate,
  },
) {}
