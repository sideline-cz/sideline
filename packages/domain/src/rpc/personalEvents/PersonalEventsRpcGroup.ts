import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { TeamId } from '~/models/Team.js';

export const PersonalEventsRpcGroup = RpcGroup.make(
  Rpc.make('GetPersonalEventMessage', {
    payload: {
      event_id: EventId,
      team_member_id: Schema.String,
    },
    success: Schema.OptionFromNullOr(
      Schema.Struct({
        personal_channel_id: Snowflake,
        discord_message_id: Snowflake,
        payload_hash: Schema.String,
      }),
    ),
  }),
  Rpc.make('UpsertPersonalEventMessage', {
    payload: {
      event_id: EventId,
      team_member_id: Schema.String,
      personal_channel_id: Snowflake,
      discord_message_id: Snowflake,
      payload_hash: Schema.String,
    },
  }),
  Rpc.make('DeletePersonalEventMessage', {
    payload: {
      event_id: EventId,
      team_member_id: Schema.String,
    },
  }),
  Rpc.make('GetEventsNeedingReconcile', {
    payload: { limit: Schema.Number },
    success: Schema.Array(
      Schema.Struct({
        event_id: EventId,
        team_id: TeamId,
        guild_id: Snowflake,
        dirty_at: Schemas.DateTimeFromIsoString,
      }),
    ),
  }),
  Rpc.make('ClearPersonalMessagesDirty', {
    payload: {
      event_id: EventId,
      dirty_at: Schemas.DateTimeFromIsoString,
    },
  }),
  // All personal messages in a member's channel for events that are still active
  // and upcoming, ordered by event start ascending. Drives the per-channel reorder
  // that keeps personal channels in the same order as the global events channel.
  Rpc.make('ListMessagesForMember', {
    payload: { team_member_id: Schema.String },
    success: Schema.Array(
      Schema.Struct({
        event_id: EventId,
        personal_channel_id: Snowflake,
        discord_message_id: Snowflake,
        start_at: Schemas.DateTimeFromIsoString,
      }),
    ),
  }),
).prefix('PersonalEvents/');
