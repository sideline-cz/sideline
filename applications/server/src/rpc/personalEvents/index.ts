import {
  type Discord,
  type Event,
  PersonalEventsRpcGroup,
  type TeamMember,
} from '@sideline/domain';
import { type DateTime, Effect } from 'effect';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PersonalEventMessagesRepository } from '~/repositories/PersonalEventMessagesRepository.js';

export const PersonalEventsRpcLive = Effect.Do.pipe(
  Effect.bind('messages', () => PersonalEventMessagesRepository.asEffect()),
  Effect.bind('events', () => EventsRepository.asEffect()),
  Effect.map((deps) => ({
    'PersonalEvents/GetPersonalEventMessage': ({
      event_id,
      team_member_id,
    }: {
      readonly event_id: Event.EventId;
      readonly team_member_id: string;
    }) =>
      deps.messages.getPersonalEventMessage(event_id, team_member_id as TeamMember.TeamMemberId),

    'PersonalEvents/UpsertPersonalEventMessage': ({
      event_id,
      team_member_id,
      personal_channel_id,
      discord_message_id,
      payload_hash,
    }: {
      readonly event_id: Event.EventId;
      readonly team_member_id: string;
      readonly personal_channel_id: Discord.Snowflake;
      readonly discord_message_id: Discord.Snowflake;
      readonly payload_hash: string;
    }) =>
      deps.messages.upsertPersonalEventMessage(
        event_id,
        team_member_id as TeamMember.TeamMemberId,
        personal_channel_id,
        discord_message_id,
        payload_hash,
      ),

    'PersonalEvents/DeletePersonalEventMessage': ({
      event_id,
      team_member_id,
    }: {
      readonly event_id: Event.EventId;
      readonly team_member_id: string;
    }) =>
      deps.messages.deletePersonalEventMessage(event_id, team_member_id as TeamMember.TeamMemberId),

    'PersonalEvents/GetEventsNeedingReconcile': ({ limit }: { readonly limit: number }) =>
      deps.messages.getEventsNeedingReconcile(limit),

    'PersonalEvents/ClearPersonalMessagesDirty': ({
      event_id,
      dirty_at,
    }: {
      readonly event_id: Event.EventId;
      readonly dirty_at: DateTime.Utc;
    }) => deps.events.clearEventPersonalMessagesDirty(event_id, dirty_at),

    'PersonalEvents/ListMessagesForMember': ({
      team_member_id,
    }: {
      readonly team_member_id: string;
    }) => deps.messages.listMessagesForMember(team_member_id as TeamMember.TeamMemberId),
  })),
  (handlers) => PersonalEventsRpcGroup.PersonalEventsRpcGroup.toLayer(handlers),
);
