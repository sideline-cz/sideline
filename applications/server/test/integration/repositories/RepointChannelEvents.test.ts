/**
 * Integration tests for:
 *   B. EventsRepository.repointChannelEvents
 *   C. EventSyncEventsRepository.emitEventChannelMoved + constructEvent
 *
 * Requires a real Postgres instance (excluded from unit-test run).
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Event, EventRpcEvents, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { constructEvent } from '~/rpc/event/events.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventSyncEventsRepository.Default,
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_A = '710000000000000001' as Discord.Snowflake;
const GUILD_B = '710000000000000002' as Discord.Snowflake;
const CH_OLD = '710000000000000010' as Discord.Snowflake;
const CH_NEW = '710000000000000020' as Discord.Snowflake;
const MSG_1 = '710000000000000100' as Discord.Snowflake;
const MSG_2 = '710000000000000101' as Discord.Snowflake;

// Far-future date so "start_at >= now()" is always satisfied
const FUTURE = DateTime.makeUnsafe(Date.parse('2099-01-01T10:00:00Z'));
// Past date that already expired
const PAST = DateTime.makeUnsafe(Date.parse('2000-01-01T10:00:00Z'));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username: `user-${discordId.slice(-4)}`,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, userId: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Repoint Test Team',
        guild_id: guildId,
        created_by: userId,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

/**
 * Create a future-active event in `channelId` with a pre-set discord_message_id.
 */
const createFutureEventWithMessage = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  channelId: Discord.Snowflake,
  messageId: Discord.Snowflake,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      Effect.Do.pipe(
        Effect.bind('event', () =>
          repo.insertEvent({
            teamId,
            eventType: 'match',
            title: 'Future Event With Message',
            description: Option.none(),
            startAt: FUTURE,
            endAt: Option.none(),
            location: Option.none(),
            trainingTypeId: Option.none(),
            createdBy: memberId,
          }),
        ),
        Effect.tap(({ event }) => repo.saveDiscordMessageId(event.id, channelId, messageId)),
        Effect.map(({ event }) => event.id),
      ),
    ),
  );

/**
 * Create a future-active event in `channelId` WITHOUT a discord_message_id (unposted).
 * Uses raw SQL to set discord_channel_id while leaving discord_message_id NULL.
 */
const createFutureEventInChannelNoMessage = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  channelId: Discord.Snowflake,
  title = 'Unposted Future Event',
) =>
  Effect.Do.pipe(
    Effect.bind('repo', () => EventsRepository.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.bind('event', ({ repo }) =>
      repo.insertEvent({
        teamId,
        eventType: 'match',
        title,
        description: Option.none(),
        startAt: FUTURE,
        endAt: Option.none(),
        location: Option.none(),
        trainingTypeId: Option.none(),
        createdBy: memberId,
      }),
    ),
    Effect.tap(({ sql, event }) =>
      sql.unsafe(`UPDATE events SET discord_channel_id = '${channelId}' WHERE id = '${event.id}'`),
    ),
    Effect.map(({ event }) => event.id),
  );

/**
 * Create a past event in `channelId` — should NOT be picked up by repointChannelEvents.
 */
const createPastEvent = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  channelId: Discord.Snowflake,
  messageId: Discord.Snowflake,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      Effect.Do.pipe(
        Effect.bind('event', () =>
          repo.insertEvent({
            teamId,
            eventType: 'match',
            title: 'Past Event',
            description: Option.none(),
            startAt: PAST,
            endAt: Option.none(),
            location: Option.none(),
            trainingTypeId: Option.none(),
            createdBy: memberId,
          }),
        ),
        Effect.tap(({ event }) => repo.saveDiscordMessageId(event.id, channelId, messageId)),
        Effect.map(({ event }) => event.id),
      ),
    ),
  );

// Helper: read raw DB columns for an event
const readEventChannelCols = (eventId: Event.EventId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{
        discord_channel_id: string | null;
        discord_message_id: string | null;
      }>(`SELECT discord_channel_id, discord_message_id FROM events WHERE id = '${eventId}'`),
    ),
    Effect.map((rows) => rows[0] ?? { discord_channel_id: null, discord_message_id: null }),
  );

// Setup shared for most tests
const setupTeam = (guildId = GUILD_A) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(`71000000000000000${guildId.slice(-1)}`)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addMember(team.id, userId)),
    Effect.map(({ team, member }) => ({
      teamId: team.id,
      memberId: member.id as TeamMember.TeamMemberId,
    })),
  );

// Helper: read raw event_sync_events row columns
const getLatestSyncEventRow = (eventType: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{
        event_id: string;
        event_type: string;
        discord_target_channel_id: string | null;
        discord_role_id: string | null;
      }>(`
        SELECT event_id, event_type, discord_target_channel_id, discord_role_id
        FROM event_sync_events
        WHERE event_type = '${eventType}'
        ORDER BY created_at DESC
        LIMIT 1
      `),
    ),
    Effect.map((rows) => rows[0] ?? null),
  );

// ============================================================================
// B. repointChannelEvents
// ============================================================================

describe('EventsRepository — repointChannelEvents', () => {
  // --------------------------------------------------------------------------
  // B1: Returns pre-update old_message_id even though UPDATE nulls the column
  // --------------------------------------------------------------------------
  it.effect('B1: CTE returns pre-update old_message_id even though column is now NULL', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('eventId', ({ ctx }) =>
        createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_OLD, MSG_1),
      ),
      Effect.bind('result', ({ ctx }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.repointChannelEvents(ctx.teamId, Option.some(CH_OLD), Option.some(CH_NEW)),
          ),
        ),
      ),
      Effect.tap(({ result, eventId }) =>
        Effect.sync(() => {
          expect(result).toHaveLength(1);
          expect(result[0].event_id).toBe(eventId);
          // old_message_id must carry the ORIGINAL message id (before it was nulled)
          expect(Option.isSome(result[0].old_message_id)).toBe(true);
          if (Option.isSome(result[0].old_message_id)) {
            expect(result[0].old_message_id.value).toBe(MSG_1);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // B2: Only status='active' AND start_at>=now() rows are moved
  // --------------------------------------------------------------------------
  it.effect('B2: only active future events are repointed; past and cancelled stay', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('futureId', ({ ctx }) =>
        createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_OLD, MSG_1),
      ),
      Effect.bind('pastId', ({ ctx }) => createPastEvent(ctx.teamId, ctx.memberId, CH_OLD, MSG_2)),
      // Cancel a future event and put it in the old channel
      Effect.bind('cancelledId', ({ ctx }) =>
        createFutureEventWithMessage(
          ctx.teamId,
          ctx.memberId,
          CH_OLD,
          '710000000000000199' as Discord.Snowflake,
        ).pipe(
          Effect.tap((evId) =>
            EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.cancelEvent(evId))),
          ),
        ),
      ),
      Effect.bind('result', ({ ctx }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.repointChannelEvents(ctx.teamId, Option.some(CH_OLD), Option.some(CH_NEW)),
          ),
        ),
      ),
      Effect.tap(({ result, futureId, pastId, cancelledId }) =>
        Effect.sync(() => {
          // Only the future active event should be in the result
          expect(result).toHaveLength(1);
          expect(result[0].event_id).toBe(futureId);
          // Past and cancelled must NOT appear
          const ids = result.map((r) => r.event_id);
          expect(ids).not.toContain(pastId);
          expect(ids).not.toContain(cancelledId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // B3: After repoint, moved rows have discord_channel_id=new and message_id=NULL
  // --------------------------------------------------------------------------
  it.effect(
    'B3: moved rows have discord_channel_id=new and discord_message_id=NULL after repoint',
    () =>
      Effect.Do.pipe(
        Effect.bind('ctx', () => setupTeam()),
        Effect.bind('eventId', ({ ctx }) =>
          createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_OLD, MSG_1),
        ),
        Effect.tap(({ ctx }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.repointChannelEvents(ctx.teamId, Option.some(CH_OLD), Option.some(CH_NEW)),
            ),
          ),
        ),
        Effect.bind('cols', ({ eventId }) => readEventChannelCols(eventId)),
        Effect.tap(({ cols }) =>
          Effect.sync(() => {
            expect(cols.discord_channel_id).toBe(CH_NEW);
            expect(cols.discord_message_id).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // --------------------------------------------------------------------------
  // B4: old=None variant — matches discord_channel_id IS NULL upcoming-active events
  // --------------------------------------------------------------------------
  it.effect('B4: old_channel=None matches events with discord_channel_id IS NULL', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      // Create a future event with no channel assigned
      Effect.bind('noChannelEventId', ({ ctx }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo
              .insertEvent({
                teamId: ctx.teamId,
                eventType: 'match',
                title: 'No Channel Event',
                description: Option.none(),
                startAt: FUTURE,
                endAt: Option.none(),
                location: Option.none(),
                trainingTypeId: Option.none(),
                createdBy: ctx.memberId,
              })
              .pipe(Effect.map((e) => e.id)),
          ),
        ),
      ),
      // Also create a future event WITH a channel — should NOT be touched
      Effect.bind('withChannelEventId', ({ ctx }) =>
        createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_OLD, MSG_1),
      ),
      Effect.bind('result', ({ ctx }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            // old=None → match events where discord_channel_id IS NULL
            repo.repointChannelEvents(ctx.teamId, Option.none(), Option.some(CH_NEW)),
          ),
        ),
      ),
      Effect.tap(({ result, noChannelEventId, withChannelEventId }) =>
        Effect.sync(() => {
          expect(result).toHaveLength(1);
          expect(result[0].event_id).toBe(noChannelEventId);
          // old_message_id is None since the event had no discord_message_id
          expect(Option.isNone(result[0].old_message_id)).toBe(true);
          // withChannelEventId should NOT be in result
          const ids = result.map((r) => r.event_id);
          expect(ids).not.toContain(withChannelEventId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // B5: new_channel_id=None — rows repointed to NULL channel
  // --------------------------------------------------------------------------
  it.effect('B5: new_channel_id=None → discord_channel_id becomes NULL after repoint', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('eventId', ({ ctx }) =>
        createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_OLD, MSG_1),
      ),
      Effect.tap(({ ctx }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.repointChannelEvents(ctx.teamId, Option.some(CH_OLD), Option.none()),
          ),
        ),
      ),
      Effect.bind('cols', ({ eventId }) => readEventChannelCols(eventId)),
      Effect.tap(({ cols }) =>
        Effect.sync(() => {
          expect(cols.discord_channel_id).toBeNull();
          expect(cols.discord_message_id).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // B6: Scoped to the team — events of another team untouched
  // --------------------------------------------------------------------------
  it.effect('B6: events from another team are not affected', () =>
    Effect.Do.pipe(
      Effect.bind('ctxA', () => setupTeam(GUILD_A)),
      Effect.bind('ctxB', () => setupTeam(GUILD_B)),
      // Both teams have an event in CH_OLD
      Effect.bind('evA', ({ ctxA }) =>
        createFutureEventWithMessage(ctxA.teamId, ctxA.memberId, CH_OLD, MSG_1),
      ),
      Effect.bind('evB', ({ ctxB }) =>
        createFutureEventWithMessage(ctxB.teamId, ctxB.memberId, CH_OLD, MSG_2),
      ),
      // Repoint only team A
      Effect.bind('result', ({ ctxA }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.repointChannelEvents(ctxA.teamId, Option.some(CH_OLD), Option.some(CH_NEW)),
          ),
        ),
      ),
      Effect.bind('colsA', ({ evA }) => readEventChannelCols(evA)),
      Effect.bind('colsB', ({ evB }) => readEventChannelCols(evB)),
      Effect.tap(({ result, evA, evB, colsA, colsB }) =>
        Effect.sync(() => {
          // Only team A's event was repointed
          expect(result).toHaveLength(1);
          expect(result[0].event_id).toBe(evA);
          expect(colsA.discord_channel_id).toBe(CH_NEW);
          // Team B's event was untouched
          expect(colsB.discord_channel_id).toBe(CH_OLD);
          expect(colsB.discord_message_id).toBe(MSG_2);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ============================================================================
// C. emitEventChannelMoved + constructEvent
// ============================================================================

describe('EventSyncEventsRepository — emitEventChannelMoved', () => {
  // --------------------------------------------------------------------------
  // C1: Emit writes a pending row with correct column mappings
  // --------------------------------------------------------------------------
  it.effect(
    'C1: emit writes event_channel_moved row with correct discord_target_channel_id and discord_role_id',
    () =>
      Effect.Do.pipe(
        Effect.bind('ctx', () => setupTeam()),
        Effect.tap(({ ctx }) =>
          EventSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.emitEventChannelMoved(
                ctx.teamId,
                Option.some(CH_OLD), // old → discord_role_id
                Option.some(CH_NEW), // new → discord_target_channel_id
              ),
            ),
          ),
        ),
        Effect.bind('row', () => getLatestSyncEventRow('event_channel_moved')),
        Effect.tap(({ row }) =>
          Effect.sync(() => {
            expect(row).not.toBeNull();
            if (row === null) return;
            expect(row.event_type).toBe('event_channel_moved');
            // new_channel_id mapped to discord_target_channel_id
            expect(row.discord_target_channel_id).toBe(CH_NEW);
            // old_channel_id mapped to discord_role_id
            expect(row.discord_role_id).toBe(CH_OLD);
            // team-scoped event: no real event, so event_id is stored NULL
            // (COALESCE'd to the nil-UUID sentinel only on the findUnprocessed read path)
            expect(row.event_id).toBeNull();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  // --------------------------------------------------------------------------
  // C2: Guild not linked → no row inserted
  // --------------------------------------------------------------------------
  it.effect('C2: team with no linked guild → emitEventChannelMoved inserts nothing', () =>
    Effect.Do.pipe(
      // Insert a team WITHOUT a guild_id by using SQL directly (simulate no guild)
      // We achieve "no guild linked" by using a team ID that doesn't exist in teams.
      // Actually, lookupGuildId does SELECT guild_id FROM teams WHERE id = $teamId.
      // If the team doesn't exist (or has no guild_id), it returns None → emits nothing.
      // To test this cleanly, we create a user but no team with that guild.
      Effect.bind('userId', () => createUser('719999999999999999')),
      Effect.tap(({ userId: _ }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitEventChannelMoved(
              '00000000-0000-0000-ffff-000000000099' as Team.TeamId, // non-existent team
              Option.some(CH_OLD),
              Option.some(CH_NEW),
            ),
          ),
        ),
      ),
      Effect.bind('count', () =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe<{ count: number }>(
              `SELECT COUNT(*)::int AS count FROM event_sync_events WHERE event_type = 'event_channel_moved'`,
            ),
          ),
          Effect.map((rows) => rows[0]?.count ?? 0),
        ),
      ),
      Effect.tap(({ count }) =>
        Effect.sync(() => {
          expect(count).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // C3: constructEvent maps row back to EventChannelMovedEvent
  // --------------------------------------------------------------------------
  it.effect('C3: constructEvent maps event_channel_moved row to EventChannelMovedEvent', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.tap(({ ctx }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitEventChannelMoved(ctx.teamId, Option.some(CH_OLD), Option.some(CH_NEW)),
          ),
        ),
      ),
      Effect.bind('rows', () =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(1)),
        ),
      ),
      Effect.bind('event', ({ rows }) => {
        const row = rows[0];
        if (row === undefined) return Effect.fail(new Error('no row found'));
        return constructEvent(row);
      }),
      Effect.tap(({ event }) =>
        Effect.sync(() => {
          expect(event._tag).toBe('event_channel_moved');
          if (event._tag !== 'event_channel_moved') return;
          const moved = event as EventRpcEvents.EventChannelMovedEvent;
          // new_channel_id = CH_NEW
          expect(Option.isSome(moved.new_channel_id)).toBe(true);
          if (Option.isSome(moved.new_channel_id)) {
            expect(moved.new_channel_id.value).toBe(CH_NEW);
          }
          // old_channel_id = CH_OLD
          expect(Option.isSome(moved.old_channel_id)).toBe(true);
          if (Option.isSome(moved.old_channel_id)) {
            expect(moved.old_channel_id.value).toBe(CH_OLD);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // C4: constructEvent handles old_channel_id=None
  // --------------------------------------------------------------------------
  it.effect('C4: constructEvent correctly maps None old_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.tap(({ ctx }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitEventChannelMoved(
              ctx.teamId,
              Option.none(), // old = None
              Option.some(CH_NEW),
            ),
          ),
        ),
      ),
      Effect.bind('rows', () =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(1)),
        ),
      ),
      Effect.bind('event', ({ rows }) => {
        const row = rows[0];
        if (row === undefined) return Effect.fail(new Error('no row found'));
        return constructEvent(row);
      }),
      Effect.tap(({ event }) =>
        Effect.sync(() => {
          expect(event._tag).toBe('event_channel_moved');
          if (event._tag !== 'event_channel_moved') return;
          const moved = event as EventRpcEvents.EventChannelMovedEvent;
          expect(Option.isNone(moved.old_channel_id)).toBe(true);
          expect(Option.isSome(moved.new_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // C5: constructEvent handles new_channel_id=None
  // --------------------------------------------------------------------------
  it.effect('C5: constructEvent correctly maps None new_channel_id', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.tap(({ ctx }) =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.emitEventChannelMoved(
              ctx.teamId,
              Option.some(CH_OLD),
              Option.none(), // new = None
            ),
          ),
        ),
      ),
      Effect.bind('rows', () =>
        EventSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(1)),
        ),
      ),
      Effect.bind('event', ({ rows }) => {
        const row = rows[0];
        if (row === undefined) return Effect.fail(new Error('no row found'));
        return constructEvent(row);
      }),
      Effect.tap(({ event }) =>
        Effect.sync(() => {
          expect(event._tag).toBe('event_channel_moved');
          if (event._tag !== 'event_channel_moved') return;
          const moved = event as EventRpcEvents.EventChannelMovedEvent;
          expect(Option.isSome(moved.old_channel_id)).toBe(true);
          expect(Option.isNone(moved.new_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ============================================================================
// D. EventsRepository.findUnpostedUpcomingByChannel
// ============================================================================

describe('EventsRepository — findUnpostedUpcomingByChannel', () => {
  // --------------------------------------------------------------------------
  // D1: Returns active future events in the channel with NULL message id, ordered by start_at ASC
  // --------------------------------------------------------------------------
  it.effect('D1: returns unposted future events in channel, ordered by start_at ASC', () => {
    // Use two different future times to verify ordering
    const FUTURE_LATER = DateTime.makeUnsafe(Date.parse('2099-06-01T10:00:00Z'));

    return Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('evEarly', ({ ctx }) =>
        Effect.Do.pipe(
          Effect.bind('repo', () => EventsRepository.asEffect()),
          Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
          Effect.bind('event', ({ repo }) =>
            repo.insertEvent({
              teamId: ctx.teamId,
              eventType: 'match',
              title: 'Early Event',
              description: Option.none(),
              startAt: FUTURE,
              endAt: Option.none(),
              location: Option.none(),
              trainingTypeId: Option.none(),
              createdBy: ctx.memberId,
            }),
          ),
          Effect.tap(({ sql, event }) =>
            sql.unsafe(
              `UPDATE events SET discord_channel_id = '${CH_NEW}' WHERE id = '${event.id}'`,
            ),
          ),
          Effect.map(({ event }) => event.id),
        ),
      ),
      Effect.bind('evLate', ({ ctx }) =>
        Effect.Do.pipe(
          Effect.bind('repo', () => EventsRepository.asEffect()),
          Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
          Effect.bind('event', ({ repo }) =>
            repo.insertEvent({
              teamId: ctx.teamId,
              eventType: 'match',
              title: 'Late Event',
              description: Option.none(),
              startAt: FUTURE_LATER,
              endAt: Option.none(),
              location: Option.none(),
              trainingTypeId: Option.none(),
              createdBy: ctx.memberId,
            }),
          ),
          Effect.tap(({ sql, event }) =>
            sql.unsafe(
              `UPDATE events SET discord_channel_id = '${CH_NEW}' WHERE id = '${event.id}'`,
            ),
          ),
          Effect.map(({ event }) => event.id),
        ),
      ),
      Effect.bind('result', () =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnpostedUpcomingByChannel(CH_NEW)),
        ),
      ),
      Effect.tap(({ result, evEarly, evLate }) =>
        Effect.sync(() => {
          const ids = result.map((r) => r.event_id);
          expect(ids).toContain(evEarly);
          expect(ids).toContain(evLate);
          // Ordered soonest-first: early comes before late
          expect(ids.indexOf(evEarly)).toBeLessThan(ids.indexOf(evLate));
        }),
      ),
      Effect.provide(TestLayer),
    );
  });

  // --------------------------------------------------------------------------
  // D2: Excludes events that have a discord_message_id set
  // --------------------------------------------------------------------------
  it.effect('D2: excludes events that already have a discord_message_id', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      // One event with a message id (already posted)
      Effect.bind('postedId', ({ ctx }) =>
        createFutureEventWithMessage(ctx.teamId, ctx.memberId, CH_NEW, MSG_1),
      ),
      // One event without a message id (unposted)
      Effect.bind('unpostedId', ({ ctx }) =>
        createFutureEventInChannelNoMessage(ctx.teamId, ctx.memberId, CH_NEW),
      ),
      Effect.bind('result', () =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnpostedUpcomingByChannel(CH_NEW)),
        ),
      ),
      Effect.tap(({ result, postedId, unpostedId }) =>
        Effect.sync(() => {
          const ids = result.map((r) => r.event_id);
          expect(ids).not.toContain(postedId);
          expect(ids).toContain(unpostedId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // D3: Excludes cancelled events
  // --------------------------------------------------------------------------
  it.effect('D3: excludes cancelled events', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('cancelledId', ({ ctx }) =>
        createFutureEventInChannelNoMessage(
          ctx.teamId,
          ctx.memberId,
          CH_NEW,
          'Cancelled Event',
        ).pipe(
          Effect.tap((evId) =>
            EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.cancelEvent(evId))),
          ),
        ),
      ),
      Effect.bind('result', () =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnpostedUpcomingByChannel(CH_NEW)),
        ),
      ),
      Effect.tap(({ result, cancelledId }) =>
        Effect.sync(() => {
          const ids = result.map((r) => r.event_id);
          expect(ids).not.toContain(cancelledId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // --------------------------------------------------------------------------
  // D4: Excludes events in other channels
  // --------------------------------------------------------------------------
  it.effect('D4: excludes events assigned to a different channel', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () => setupTeam()),
      Effect.bind('otherChannelId', ({ ctx }) =>
        createFutureEventInChannelNoMessage(ctx.teamId, ctx.memberId, CH_OLD),
      ),
      Effect.bind('result', () =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnpostedUpcomingByChannel(CH_NEW)),
        ),
      ),
      Effect.tap(({ result, otherChannelId }) =>
        Effect.sync(() => {
          const ids = result.map((r) => r.event_id);
          expect(ids).not.toContain(otherChannelId);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
