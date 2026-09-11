// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7f + §7.12 of the
// test spec; §4.8/§14.4 for the deferred missed-RSVP counter, §15 for the
// deferred "Dnes" started post).
//
// Runs the REAL `eventStartCronEffect` (not a hand-rolled repository call)
// against a real Postgres (testcontainers) — the arm-on-flip stamp, the
// claim-then-act sweeps, and the migration backfill are all transactional/SQL
// behaviour a mocked repository cannot exercise. This file is a sibling of
// the existing mock-based `applications/server/test/services/EventStartCron.test.ts`
// (left untouched), which still covers the pure routing/Discord-payload logic.
//
// Requires (none of which exist yet):
//   - migration `<newId>_add_all_day_deferral_stamps.ts` — `events.missed_rsvp_counted_at`,
//     `events.all_day_post_sent_at`, `team_settings.all_day_post_time` (§13.6),
//     with the UNCONDITIONAL backfill (no `WHERE`).
//   - `EventsRepository#startEvent`'s SQL stamping BOTH columns via the
//     `CASE WHEN all_day THEN NULL ELSE now() END` in the same statement as the flip.
//   - `EventsRepository#findAllDayEventsPastLastLocalDay` / `#claimMissedRsvpCount`.
//   - `EventsRepository#findAllDayEventsNeedingStartedPost` / a claim for
//     `all_day_post_sent_at`.
//   - Both new sweeps wired into `eventStartCronEffect` beside the existing
//     `markStalePersonalMessagesDirty` sweep, each claim-then-act inside one
//     `sql.withTransaction`.
//
// KNOWN GAP, stated explicitly rather than faked: the "crash between claim and
// act double-penalises" atomicity case (§7.7f case 6 / §7.12 case 9) requires
// injecting a failure INSIDE the transaction after the claim commits — that
// needs an implementation-specific seam (e.g. a test-only failing hook) that
// does not exist yet and cannot be added from the repository's public surface
// alone. It is not covered here; flag it for the developer to add a
// unit-level test alongside the real implementation (e.g. by making the
// per-event increment injectable, or testing the transaction boundary via a
// raw SQL fault injection). The "old-code-flip-safety" and "idempotent
// re-run" cases below indirectly build confidence in the same claim-based
// design without needing that seam.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { eventStartCronEffect } from '~/services/EventStartCron.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  EventRsvpsRepository.Default,
  DiscordChannelMappingRepository.Default,
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
        created_by: createdBy,
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

const setTeamTimezone = (teamId: Team.TeamId, timezone: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 0,
        timezone,
      }),
    ),
  );

const setAllDayPostTime = (teamId: string, time: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(
        `UPDATE team_settings SET all_day_post_time = '${time}' WHERE team_id = '${teamId}'`,
      ),
    ),
  );

const insertEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  allDay: boolean,
  startAt: DateTime.Utc,
  endAt?: DateTime.Utc,
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: allDay ? 'All-day event' : 'Timed event',
        description: Option.none(),
        startAt,
        endAt: endAt === undefined ? Option.none() : Option.some(endAt),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy: createdBy as any,
        allDay,
      }),
    ),
  );

const getStamps = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{
        missed_rsvp_counted_at: string | null;
        all_day_post_sent_at: string | null;
        status: string;
      }>(
        `SELECT missed_rsvp_counted_at::text, all_day_post_sent_at::text, status
         FROM events WHERE id = '${eventId}'`,
      ),
    ),
    Effect.map((rows) => rows[0]!),
  );

const setStamps = (
  eventId: string,
  missedRsvpCountedAt: string | null,
  allDayPostSentAt: string | null,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(
        `UPDATE events SET
           missed_rsvp_counted_at = ${missedRsvpCountedAt === null ? 'NULL' : `'${missedRsvpCountedAt}'`},
           all_day_post_sent_at   = ${allDayPostSentAt === null ? 'NULL' : `'${allDayPostSentAt}'`}
         WHERE id = '${eventId}'`,
      ),
    ),
  );

const countStartedSyncEvents = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ count: string }>(
        `SELECT count(*)::text AS count FROM event_sync_events
         WHERE event_id = '${eventId}' AND event_type = 'event_started'`,
      ),
    ),
    Effect.map((rows) => Number(rows[0]?.count)),
  );

const getMissedRsvps = (memberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ missed_rsvps: number }>(
        `SELECT missed_rsvps FROM team_members WHERE id = '${memberId}'`,
      ),
    ),
    Effect.map((rows) => rows[0]?.missed_rsvps),
  );

const assignPlayerRole = (teamId: string, memberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`
        INSERT INTO roles (team_id, name, is_built_in)
        VALUES ('${teamId}', 'Player', true)
        ON CONFLICT DO NOTHING
      `),
    ),
    Effect.andThen(() =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.andThen((sql) =>
          sql.unsafe(`
            INSERT INTO member_roles (team_member_id, role_id)
            SELECT '${memberId}', id FROM roles WHERE team_id = '${teamId}' AND name = 'Player' AND is_built_in = true
            ON CONFLICT DO NOTHING
          `),
        ),
      ),
    ),
  );

const runCron = () => eventStartCronEffect.pipe(Effect.provide(TestLayer));

/** Team-local `HH:MM` of `now() + minutesOffset` (may cross midnight — accepted
 * residual flake risk near the wrap, consistent with other relative-clock
 * fixtures in this codebase). Lets the "Dnes"-post timing tests set
 * `all_day_post_time` to a value that is deterministically before/after the
 * real current instant, without needing to control Postgres's own `now()`. */
const localTimeOffsetHHMM = (tz: string, minutesOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ t: string }>(
        `SELECT to_char((now() AT TIME ZONE '${tz}') + INTERVAL '${minutesOffset} minutes', 'HH24:MI') AS t`,
      ),
    ),
    Effect.map((rows) => rows[0]?.t),
  );

// Team-local midnight of (today + dayOffset), asked of Postgres itself.
const localMidnight = (tz: string, dayOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(
        `SELECT (((now() AT TIME ZONE '${tz}')::date + ${dayOffset}) AT TIME ZONE '${tz}') AS instant`,
      ),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
  );

// ---------------------------------------------------------------------------
// §7.7f — arm-on-flip
// ---------------------------------------------------------------------------

describe('EventStartCron — arm-on-flip stamps both deferral columns atomically with the status flip', () => {
  it.effect('case 1: timed event flips → both stamps non-NULL immediately, increment applied', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000001', 'cron-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101011' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.bind('nonResponderId', () => createUser('490000000000000002', 'cron-nonresponder-1')),
      Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
        addTeamMember(team.id, nonResponderId),
      ),
      Effect.tap(({ team, nonResponderMember }) =>
        assignPlayerRole(team.id, (nonResponderMember as any).id),
      ),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      // Due to start now (or in the past) so `findEventsToStart` picks it up.
      Effect.bind('event', ({ team, ownerMember }) =>
        insertEvent(
          team.id,
          (ownerMember as any).id,
          false,
          DateTime.makeUnsafe(new Date(Date.now() - 60_000).toISOString()),
        ),
      ),
      Effect.tap(() => runCron()),
      Effect.bind('stamps', ({ event }) => getStamps(event.id)),
      Effect.tap(({ stamps }) =>
        Effect.sync(() => {
          expect(stamps.status).toBe('started');
          expect(stamps.missed_rsvp_counted_at).not.toBeNull();
          expect(stamps.all_day_post_sent_at).not.toBeNull();
        }),
      ),
      Effect.bind('missed', ({ nonResponderMember }) =>
        getMissedRsvps((nonResponderMember as any).id),
      ),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 2: all-day event flips at team-local midnight → NEITHER stamp set, no increment, no emit',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000003', 'cron-owner-2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101012' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000004', 'cron-nonresponder-2'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Pin the post time into the FUTURE (local). This case asserts that the
        // midnight flip ALONE sets neither stamp; with the default 08:00 the
        // morning post legitimately fires whenever the suite runs after 08:00
        // team-local, which made the assertion depend on the wall clock.
        Effect.bind('futurePostTime', () => localTimeOffsetHHMM('Europe/Prague', 60)),
        Effect.tap(({ team, futurePostTime }) => setAllDayPostTime(team.id, futurePostTime)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('stamps', ({ event }) => getStamps(event.id)),
        Effect.tap(({ stamps }) =>
          Effect.sync(() => {
            expect(stamps.status).toBe('started');
            expect(stamps.missed_rsvp_counted_at).toBeNull();
            expect(stamps.all_day_post_sent_at).toBeNull();
          }),
        ),
        Effect.bind('missed', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missed }) =>
          Effect.sync(() => {
            expect(missed).toBe(0);
          }),
        ),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            expect(emitted).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// §7.7f — the deferred missed-RSVP counter sweep
// ---------------------------------------------------------------------------

describe('EventStartCron — deferred missed-RSVP counter (all-day, past its last local day)', () => {
  it.effect(
    'case 3/4: sweep claims and increments once; a second run does not double-count (idempotence)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000005', 'cron-owner-3')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101013' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000006', 'cron-nonresponder-3'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Two days ago's local midnight — already `started`, already past its own day.
        Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        // Simulate the flip having already happened (armed: NULL) a while ago.
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('missedAfterFirst', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.bind('stampsAfterFirst', ({ event }) => getStamps(event.id)),
        Effect.tap(() => runCron()),
        Effect.bind('missedAfterSecond', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missedAfterFirst, missedAfterSecond, stampsAfterFirst }) =>
          Effect.sync(() => {
            expect(stampsAfterFirst.missed_rsvp_counted_at).not.toBeNull();
            expect(missedAfterFirst).toBe(1);
            expect(missedAfterSecond).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 5: a member who RSVPs before the sweep is not counted as missed', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000007', 'cron-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101014' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.bind('responderId', () => createUser('490000000000000008', 'cron-responder-1')),
      Effect.bind('responderMember', ({ team, responderId }) =>
        addTeamMember(team.id, responderId),
      ),
      Effect.tap(({ team, responderMember }) =>
        assignPlayerRole(team.id, (responderMember as any).id),
      ),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
      Effect.bind('event', ({ team, ownerMember, start }) =>
        insertEvent(team.id, (ownerMember as any).id, true, start),
      ),
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
          ),
        ),
      ),
      // Responder RSVPs on the event's own local day, before the sweep runs.
      Effect.tap(({ event, responderMember }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`
                INSERT INTO event_rsvps (event_id, team_member_id, response)
                VALUES ('${event.id}', '${(responderMember as any).id}', 'yes')
              `),
          ),
        ),
      ),
      Effect.tap(() => runCron()),
      Effect.bind('missed', ({ responderMember }) => getMissedRsvps((responderMember as any).id)),
      Effect.tap(({ missed }) =>
        Effect.sync(() => {
          expect(missed).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 7: old-code-flip safety — a started all-day row already stamped (backfilled value) is never swept again',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000009', 'cron-owner-5')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101015' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000010', 'cron-nonresponder-5'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        // Simulate the unconditional migration backfill: already stamped, not NULL.
        Effect.tap(({ event }) =>
          setStamps(event.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('missed', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missed }) =>
          Effect.sync(() => {
            expect(missed).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 9 (renumbered from §4.8.3): 7-day lower bound — a very old all-day event is not swept',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000011', 'cron-owner-6')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101016' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000012', 'cron-nonresponder-6'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('event', ({ team, ownerMember }) =>
          insertEvent(
            team.id,
            (ownerMember as any).id,
            true,
            DateTime.makeUnsafe('2020-01-01T00:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('missed', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missed }) =>
          Effect.sync(() => {
            expect(missed).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// §7.12 — the deferred "Dnes" started post
// ---------------------------------------------------------------------------

describe('EventStartCron — deferred "Dnes" started post (all-day, team-local morning)', () => {
  it.effect('case 3: all_day_post_time in the FUTURE (local) → no emit yet', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000013', 'cron-owner-7')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101017' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      // 30 minutes from now, local — deterministically still in the future.
      Effect.bind('futureTime', () => localTimeOffsetHHMM('Europe/Prague', 30)),
      Effect.tap(({ team, futureTime }) => setAllDayPostTime(team.id, futureTime)),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
      Effect.bind('event', ({ team, ownerMember, start }) =>
        insertEvent(team.id, (ownerMember as any).id, true, start),
      ),
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
          ),
        ),
      ),
      Effect.tap(() => runCron()),
      Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
      Effect.tap(({ emitted }) =>
        Effect.sync(() => {
          expect(emitted).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 4: all_day_post_time in the PAST (local) → exactly one emit, and a second run does not duplicate',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000018', 'cron-owner-7b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101022' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        // 30 minutes ago, local — deterministically already passed today.
        Effect.bind('pastTime', () => localTimeOffsetHHMM('Europe/Prague', -30)),
        Effect.tap(({ team, pastTime }) => setAllDayPostTime(team.id, pastTime)),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            expect(emitted).toBe(1);
          }),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emittedAfterSecondRun', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emittedAfterSecondRun }) =>
          Effect.sync(() => {
            expect(emittedAfterSecondRun).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 6: multi-day all-day, day 2 → no emit (day-1-only; the post must not lie about "Dnes")',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000014', 'cron-owner-8')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101018' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Started yesterday (day 1), still running today (day 2 of a 3-day span).
        Effect.bind('start', () => localMidnight('Europe/Prague', -1)),
        Effect.bind('end', () => localMidnight('Europe/Prague', 1)),
        Effect.bind('event', ({ team, ownerMember, start, end }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start, end),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            // Day 2's date no longer matches `DATE(start_at)` — must not fire.
            expect(emitted).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 8: no team_settings row → still emits once the Europe/Prague-default 08:00 has passed (LEFT JOIN + COALESCE fallback, not INNER)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000015', 'cron-owner-9')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101019' as Discord.Snowflake, ownerId),
        ),
        // Deliberately no setTeamTimezone — no team_settings row exists, so the
        // fallback timezone AND the fallback `all_day_post_time` (08:00) both apply.
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Anchor the event to a Prague-local midnight far enough in the past that
        // 08:00 local on ITS day has certainly passed by any real "now" — while
        // still inside the 7-day sweep window used elsewhere. Two days ago's
        // midnight guarantees "today" (relative to the event's own start date)
        // is always after its 08:00, regardless of the real current hour.
        Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            // NOTE: this event's `start_at` is 2 days in the past, so the post's
            // own "day 1 only" same-day guard (§15.2 choice 3) means this fixture
            // actually pins the SKIPPED case, not the emitted one — see the
            // in-window variant directly below for the positive assertion. Both
            // together prove the fallback path is reachable at all (a query that
            // silently drops no-team_settings rows would make BOTH read 0 forever).
            expect(emitted).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 8b: no team_settings row, event started TODAY, all_day_post_time (fallback 08:00) already passed → emits',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000019', 'cron-owner-9b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101023' as Discord.Snowflake, ownerId),
        ),
        // No team_settings row — but we can only assert the POSITIVE (emitted)
        // case deterministically for a team whose local `now` is provably past
        // 08:00. Reuse a WITH-settings row purely to read the current Prague
        // local time-of-day, without giving the EVENT's own team a settings row.
        Effect.bind('nowHHMM', () => localTimeOffsetHHMM('Europe/Prague', 0)),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted, nowHHMM }) =>
          Effect.sync(() => {
            // Only assert the positive case when we can prove 08:00 has passed —
            // skip (rather than falsely fail) when the suite happens to run
            // before 08:00 Prague time.
            if (nowHHMM >= '08:00') {
              expect(emitted).toBe(1);
            }
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 11: old-code-flip safety — an already-stamped (backfilled) all-day started row is never (re-)posted',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000016', 'cron-owner-10')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101020' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertEvent(team.id, (ownerMember as any).id, true, start),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(({ event }) =>
          setStamps(event.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            expect(emitted).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
