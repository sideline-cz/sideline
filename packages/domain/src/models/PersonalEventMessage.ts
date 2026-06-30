import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PersonalEventMessageId = Schema.String.pipe(Schema.brand('PersonalEventMessageId'));
export type PersonalEventMessageId = typeof PersonalEventMessageId.Type;

export class PersonalEventMessage extends Model.Class<PersonalEventMessage>('PersonalEventMessage')(
  {
    id: Model.Generated(PersonalEventMessageId),
    event_id: EventId,
    team_member_id: TeamMemberId,
    personal_channel_id: Snowflake,
    discord_message_id: Snowflake,
    payload_hash: Schema.String,
    created_at: Model.DateTimeInsertFromDate,
    updated_at: Model.DateTimeUpdateFromDate,
  },
) {}
