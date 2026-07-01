/**
 * Unit tests for constructEvent with the 'event_channel_moved' event type.
 *
 * These are pure-function tests (no database) — they verify that the
 * constructEvent matcher correctly maps an EventSyncEventRow to an
 * EventChannelMovedEvent with the right column overloads:
 *
 *   discord_target_channel_id → new_channel_id
 *   discord_role_id           → old_channel_id
 *   event_id                  → nil-UUID sentinel (passed through as-is)
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, Team } from '@sideline/domain';
import { EventRpcEvents } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { constructEvent } from '~/rpc/event/events.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYNC_ID = 'sync-channel-moved-unit-1';
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GUILD_ID = '990000000000000001' as Discord.Snowflake;
const NIL_EVENT_ID = '00000000-0000-0000-0000-000000000000' as Event.EventId;
const CH_OLD = '990000000000000010' as Discord.Snowflake;
const CH_NEW = '990000000000000020' as Discord.Snowflake;
const EPOCH = DateTime.makeUnsafe(0);

// Minimal row factory
const makeRow = (
  old_channel_id: Option.Option<Discord.Snowflake>,
  new_channel_id: Option.Option<Discord.Snowflake>,
) => ({
  id: SYNC_ID,
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  event_type: 'event_channel_moved' as const,
  event_id: NIL_EVENT_ID,
  event_title: '',
  event_description: Option.none<string>(),
  event_image_url: Option.none<string>(),
  event_start_at: EPOCH,
  event_end_at: Option.none<DateTime.Utc>(),
  event_location: Option.none<string>(),
  event_location_url: Option.none<string>(),
  event_event_type: '',
  // new_channel_id is stored in discord_target_channel_id
  discord_target_channel_id: new_channel_id,
  member_group_id: Option.none<any>(),
  // old_channel_id is stored in discord_role_id
  discord_role_id: old_channel_id,
  claimed_by_member_id: Option.none<any>(),
  claimed_by_discord_id: Option.none<Discord.Snowflake>(),
  claimed_by_name: Option.none<string>(),
  claimed_by_nickname: Option.none<string>(),
  claimed_by_user_display_name: Option.none<string>(),
  claimed_by_username: Option.none<string>(),
  event_all_day: false,
  teams_payload: Option.none<any>(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('constructEvent — event_channel_moved', () => {
  it.effect('produces EventChannelMovedEvent with correct _tag', () =>
    Effect.Do.pipe(
      Effect.bind('result', () =>
        constructEvent(makeRow(Option.some(CH_OLD), Option.some(CH_NEW))),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result._tag).toBe('event_channel_moved');
          expect(result).toBeInstanceOf(EventRpcEvents.EventChannelMovedEvent);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect(
    'maps discord_target_channel_id → new_channel_id and discord_role_id → old_channel_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('result', () =>
          constructEvent(makeRow(Option.some(CH_OLD), Option.some(CH_NEW))),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            if (result._tag !== 'event_channel_moved') return;
            const e = result as EventRpcEvents.EventChannelMovedEvent;
            expect(e.id).toBe(SYNC_ID);
            expect(e.team_id).toBe(TEAM_ID);
            expect(e.guild_id).toBe(GUILD_ID);
            expect(e.event_id).toBe(NIL_EVENT_ID);
            // new_channel_id from discord_target_channel_id
            expect(Option.isSome(e.new_channel_id)).toBe(true);
            if (Option.isSome(e.new_channel_id)) expect(e.new_channel_id.value).toBe(CH_NEW);
            // old_channel_id from discord_role_id
            expect(Option.isSome(e.old_channel_id)).toBe(true);
            if (Option.isSome(e.old_channel_id)) expect(e.old_channel_id.value).toBe(CH_OLD);
          }),
        ),
        Effect.asVoid,
      ),
  );

  it.effect('old_channel_id=None when discord_role_id is None', () =>
    Effect.Do.pipe(
      Effect.bind('result', () => constructEvent(makeRow(Option.none(), Option.some(CH_NEW)))),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          if (result._tag !== 'event_channel_moved') return;
          const e = result as EventRpcEvents.EventChannelMovedEvent;
          expect(Option.isNone(e.old_channel_id)).toBe(true);
          expect(Option.isSome(e.new_channel_id)).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('new_channel_id=None when discord_target_channel_id is None', () =>
    Effect.Do.pipe(
      Effect.bind('result', () => constructEvent(makeRow(Option.some(CH_OLD), Option.none()))),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          if (result._tag !== 'event_channel_moved') return;
          const e = result as EventRpcEvents.EventChannelMovedEvent;
          expect(Option.isSome(e.old_channel_id)).toBe(true);
          expect(Option.isNone(e.new_channel_id)).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('both old and new None — both options are None in result', () =>
    Effect.Do.pipe(
      Effect.bind('result', () => constructEvent(makeRow(Option.none(), Option.none()))),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          if (result._tag !== 'event_channel_moved') return;
          const e = result as EventRpcEvents.EventChannelMovedEvent;
          expect(Option.isNone(e.old_channel_id)).toBe(true);
          expect(Option.isNone(e.new_channel_id)).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );
});
