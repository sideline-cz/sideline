import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team } from '@sideline/domain';
import { EventRpcEvents } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { constructEvent } from '~/rpc/event/events.js';

// Test IDs
const SYNC_EVENT_ID = 'sync-event-uuid-001';
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const START_AT = DateTime.makeUnsafe('2026-04-09T10:00:00Z');

describe('constructEvent with event_started type', () => {
  it.effect('constructs EventStartedEvent from event_started row', () =>
    Effect.Do.pipe(
      Effect.bind('result', () =>
        constructEvent({
          id: SYNC_EVENT_ID,
          team_id: TEAM_ID,
          guild_id: GUILD_ID,
          event_type: 'event_started',
          event_id: EVENT_ID,
          event_title: 'Saturday Match',
          event_description: Option.none(),
          event_image_url: Option.none(),
          event_start_at: START_AT,
          event_end_at: Option.none(),
          event_location: Option.none(),
          event_location_url: Option.none(),
          event_event_type: 'match',
          discord_target_channel_id: Option.none(),
          member_group_id: Option.none(),
          discord_role_id: Option.none(),
          claimed_by_member_id: Option.none(),
          claimed_by_discord_id: Option.none(),
          claimed_by_name: Option.none(),
          claimed_by_nickname: Option.none(),
          claimed_by_user_display_name: Option.none(),
          claimed_by_username: Option.none(),
          event_all_day: false,
        }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('event_started');
          expect(result instanceof EventRpcEvents.EventStartedEvent).toBe(true);
          const started = result as EventRpcEvents.EventStartedEvent;
          expect(started.id).toBe(SYNC_EVENT_ID);
          expect(started.team_id).toBe(TEAM_ID);
          expect(started.guild_id).toBe(GUILD_ID);
          expect(started.event_id).toBe(EVENT_ID);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('constructs EventCreatedEvent from event_created row (baseline check)', () =>
    Effect.Do.pipe(
      Effect.bind('result', () =>
        constructEvent({
          id: SYNC_EVENT_ID,
          team_id: TEAM_ID,
          guild_id: GUILD_ID,
          event_type: 'event_created',
          event_id: EVENT_ID,
          event_title: 'Saturday Match',
          event_description: Option.none(),
          event_image_url: Option.none(),
          event_start_at: START_AT,
          event_end_at: Option.none(),
          event_location: Option.none(),
          event_location_url: Option.none(),
          event_event_type: 'match',
          discord_target_channel_id: Option.none(),
          member_group_id: Option.none(),
          discord_role_id: Option.none(),
          claimed_by_member_id: Option.none(),
          claimed_by_discord_id: Option.none(),
          claimed_by_name: Option.none(),
          claimed_by_nickname: Option.none(),
          claimed_by_user_display_name: Option.none(),
          claimed_by_username: Option.none(),
          event_all_day: false,
        }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('event_created');
          expect(result instanceof EventRpcEvents.EventCreatedEvent).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('constructs EventCancelledEvent from event_cancelled row', () =>
    Effect.Do.pipe(
      Effect.bind('result', () =>
        constructEvent({
          id: SYNC_EVENT_ID,
          team_id: TEAM_ID,
          guild_id: GUILD_ID,
          event_type: 'event_cancelled',
          event_id: EVENT_ID,
          event_title: 'Cancelled Event',
          event_description: Option.none(),
          event_image_url: Option.none(),
          event_start_at: START_AT,
          event_end_at: Option.none(),
          event_location: Option.none(),
          event_location_url: Option.none(),
          event_event_type: 'match',
          discord_target_channel_id: Option.none(),
          member_group_id: Option.none(),
          discord_role_id: Option.none(),
          claimed_by_member_id: Option.none(),
          claimed_by_discord_id: Option.none(),
          claimed_by_name: Option.none(),
          claimed_by_nickname: Option.none(),
          claimed_by_user_display_name: Option.none(),
          claimed_by_username: Option.none(),
          event_all_day: false,
        }),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('event_cancelled');
          expect(result instanceof EventRpcEvents.EventCancelledEvent).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );
});
