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
          teams_payload: Option.none(),
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
          teams_payload: Option.none(),
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

  // ---------------------------------------------------------------------------
  // PR 2 — `all_day` must be carried from `event_all_day` on the five
  // remaining event-sync constructors (currently missing `all_day` at all —
  // events.ts:89,126,145,170,206 does not compile until it is added).
  // ---------------------------------------------------------------------------

  const baseRow = (
    eventType:
      | 'rsvp_reminder'
      | 'training_claim_request'
      | 'training_claim_update'
      | 'unclaimed_training_reminder'
      | 'event_roster_approval_request',
    eventAllDay: boolean,
  ) => ({
    id: SYNC_EVENT_ID,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    event_type: eventType,
    event_id: EVENT_ID,
    event_title: 'Saturday Training',
    event_description: Option.none(),
    event_image_url: Option.none(),
    event_start_at: START_AT,
    event_end_at: Option.none(),
    event_location: Option.none(),
    event_location_url: Option.none(),
    event_event_type: 'active',
    discord_target_channel_id: Option.none(),
    member_group_id: Option.none(),
    discord_role_id: Option.none(),
    claimed_by_member_id: Option.none(),
    claimed_by_discord_id: Option.none(),
    claimed_by_name: Option.none(),
    claimed_by_nickname: Option.none(),
    claimed_by_user_display_name: Option.none(),
    claimed_by_username: Option.none(),
    event_all_day: eventAllDay,
    teams_payload: Option.none(),
  });

  for (const allDay of [true, false]) {
    it.effect(
      `constructs RsvpReminderEvent carrying all_day: ${String(allDay)} from event_all_day`,
      () =>
        Effect.Do.pipe(
          Effect.bind('result', () => constructEvent(baseRow('rsvp_reminder', allDay))),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              expect(result instanceof EventRpcEvents.RsvpReminderEvent).toBe(true);
              expect((result as EventRpcEvents.RsvpReminderEvent).all_day).toBe(allDay);
            }),
          ),
          Effect.asVoid,
        ),
    );

    it.effect(
      `constructs TrainingClaimRequestEvent carrying all_day: ${String(allDay)} from event_all_day`,
      () =>
        Effect.Do.pipe(
          Effect.bind('result', () => constructEvent(baseRow('training_claim_request', allDay))),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              expect(result instanceof EventRpcEvents.TrainingClaimRequestEvent).toBe(true);
              expect((result as EventRpcEvents.TrainingClaimRequestEvent).all_day).toBe(allDay);
            }),
          ),
          Effect.asVoid,
        ),
    );

    it.effect(
      `constructs TrainingClaimUpdateEvent carrying all_day: ${String(allDay)} from event_all_day`,
      () =>
        Effect.Do.pipe(
          Effect.bind('result', () => constructEvent(baseRow('training_claim_update', allDay))),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              expect(result instanceof EventRpcEvents.TrainingClaimUpdateEvent).toBe(true);
              expect((result as EventRpcEvents.TrainingClaimUpdateEvent).all_day).toBe(allDay);
            }),
          ),
          Effect.asVoid,
        ),
    );

    it.effect(
      `constructs UnclaimedTrainingReminderEvent carrying all_day: ${String(allDay)} from event_all_day`,
      () =>
        Effect.Do.pipe(
          Effect.bind('result', () =>
            constructEvent(baseRow('unclaimed_training_reminder', allDay)),
          ),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              expect(result instanceof EventRpcEvents.UnclaimedTrainingReminderEvent).toBe(true);
              expect((result as EventRpcEvents.UnclaimedTrainingReminderEvent).all_day).toBe(
                allDay,
              );
            }),
          ),
          Effect.asVoid,
        ),
    );

    it.effect(
      `constructs EventRosterApprovalRequestEvent carrying all_day: ${String(allDay)} from event_all_day`,
      () =>
        Effect.Do.pipe(
          Effect.bind('result', () =>
            constructEvent({
              ...baseRow('event_roster_approval_request', allDay),
              // Roster events overload several columns (events.ts:203-240); supply
              // decodable values for the ones the roster branch reads.
              discord_target_channel_id: Option.some('roster-evt-1'),
              member_group_id: Option.some('roster-1'),
              claimed_by_member_id: Option.some('member-1'),
              claimed_by_discord_id: Option.none(),
              claimed_by_name: Option.some('Alice'),
              event_location: Option.none(),
              discord_role_id: Option.none(),
              event_description: Option.some('Tournament Squad'),
            } as any),
          ),
          Effect.tap(({ result }) =>
            Effect.sync(() => {
              expect(result instanceof EventRpcEvents.EventRosterApprovalRequestEvent).toBe(true);
              expect((result as EventRpcEvents.EventRosterApprovalRequestEvent).all_day).toBe(
                allDay,
              );
            }),
          ),
          Effect.asVoid,
        ),
    );
  }

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
          teams_payload: Option.none(),
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
