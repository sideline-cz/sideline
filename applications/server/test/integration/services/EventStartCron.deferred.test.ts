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
// The "crash between claim and act double-penalises" atomicity case (§7.7f
// case 6 / §7.12 case 9) was long listed here as a known gap, on the reasoning
// that it needed a test-only seam inside the implementation. It does not: the
// act half of each sweep is a call into ANOTHER repository, so overriding that
// one repository with a failing layer injects the failure exactly where it is
// needed, from the outside (R1/R2 at the bottom of this file). The two-replica
// race is covered beside it (C1/C2).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from 'effect';
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
import { makeEventStartCronEffect } from '~/services/EventStartCron.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// FIXED_NOW — one pinned instant, shared by every fixture AND the cron itself
// (fix/event-start-cron-injectable-clock, Task 2). This is what closes the
// gap Task 1 (`makeEventStartCronEffect(now)`) opened up but did not fix on
// its own: fixtures and the cron used to sample the wall clock at two
// different moments (`SELECT now()` in a fixture, then `new Date()` inside
// the cron a moment later), and any date/time boundary landing between those
// two samples made a case flaky. Deriving every timestamp below from this one
// literal, and passing the SAME literal into `makeEventStartCronEffect`,
// removes the gap entirely — there is only one instant in the whole test.
//
// 2025-10-15T10:00:00Z = 2025-10-15 12:00:00 Europe/Prague (CEST). Permanently
// past, so none of this rots; far from Prague's 2025 DST fall-back (26 Oct),
// except where Group B/I4-I6 and I10 deliberately probe it.
const FIXED_NOW = new Date('2025-10-15T10:00:00.000Z');

// What still reads the REAL Postgres clock, NOT `FIXED_NOW` — unchanged by
// this refactor (plan §2, "deliberately unchanged — the flip path"):
//   - `findEventsToStart` / the underlying `findStartable` (`start_at <= NOW()`)
//   - `startEvent`'s `SET … = now()` arming stamps
//   - `claimMissedRsvpCount` / `claimStartedPost`'s claim stamps
//   - `markStalePersonalMessagesDirty`
//
// Mixing a 2025 `FIXED_NOW` with a real 2026+ database clock is sound ONLY
// because `findStartable` has no lower bound on `start_at`
// (`WHERE status = 'active' AND start_at <= NOW()`, `EventsRepository.ts`) —
// every fixture below is force-set `status = 'started'` before the cron runs,
// which routes it around `findStartable`/`findEventsToStart` entirely and
// straight into the two deferred sweeps, both of which key off `FIXED_NOW`.
// If a lower bound is ever added to `findStartable`, every case in this file
// that force-sets `status = 'started'` is unaffected (it never goes through
// `findStartable`), but do not assume that generalises to a hypothetical new
// case that relies on the flip path itself with a 2025 fixture — that would
// need a real, current `start_at`.
//
// Claim stamps (`missed_rsvp_counted_at`, `all_day_post_sent_at`) are written
// by Postgres `now()`, i.e. the REAL current instant, not `FIXED_NOW` — so
// every assertion on a stamp below checks only `.not.toBeNull()` /
// `.toBeNull()`, never a stamp's value.

// Split from `TestLayer` so the two-replica cases below can rebuild the same
// repository set over a SECOND Postgres connection (`secondTestPgClient`) —
// `Layer.provideMerge(TestPgClient)` bakes the suite's connection in, and two
// fibers sharing one `SqlClient` share one session, which can never observe a
// real row-lock wait between them (see `helpers.ts`).
const RepositoryLayers = Layer.mergeAll(
  EventsRepository.Default,
  EventSyncEventsRepository.Default,
  EventRsvpsRepository.Default,
  DiscordChannelMappingRepository.Default,
  TeamSettingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
);

const TestLayer = RepositoryLayers.pipe(Layer.provideMerge(TestPgClient));

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

// A bare `UPDATE team_settings … WHERE team_id = …` — it silently affects
// ZERO rows unless `setTeamTimezone` already created the `team_settings` row
// for this team. It does not fail or warn either way. A test that forgets to
// call `setTeamTimezone` first does not get an error here; it silently falls
// through to `COALESCE(ts.all_day_post_time, TIME '08:00')`'s 08:00 default,
// which is exactly the trap case 8/8b exist to exercise (and exactly why every
// OTHER boundary case must set this column explicitly rather than rely on the
// default — see the FIXED_NOW header block).
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

// Combines `insertEvent` with the "flip already happened" force-update used
// by every case in this file — folds two `Effect.Do.pipe` steps into one,
// which matters for I10 below: `Effect.Do.pipe`'s `.pipe` overloads top out
// at 20 arguments, and I10's fixture-per-probe shape needs every step it can
// get.
const insertStartedAllDayEvent = (
  teamId: Team.TeamId,
  createdBy: string,
  startAt: DateTime.Utc,
  endAt?: DateTime.Utc,
) =>
  insertEvent(teamId, createdBy, true, startAt, endAt).pipe(
    Effect.tap((event) =>
      SqlClient.SqlClient.asEffect().pipe(
        Effect.andThen((sql) =>
          sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
        ),
      ),
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

// `runCronAt` drives the fix directly: `makeEventStartCronEffect` takes the
// instant as a parameter (Task 1), so a test can hand it the exact same
// literal its fixtures are built from. No `Effect.provide(TestLayer)` here —
// every one of the 20+ call sites below is inside an `Effect.tap` within a
// `Effect.Do.pipe` chain that already ends in `Effect.provide(TestLayer)`;
// providing it again here only rebuilt a second `TestPgClient` pool per run.
const runCronAt = (now: Date) => makeEventStartCronEffect(now);
const runCron = () => runCronAt(FIXED_NOW);

// Team-local midnight of (FIXED_NOW's local day + dayOffset), derived from
// `FIXED_NOW` (bound as an ISO string, cast in SQL — AGENTS.md) instead of
// `SELECT now()`, so every fixture's start_at shares the same instant as the
// cron itself.
//
// The local date -> instant direction (`<date> AT TIME ZONE tz`) is
// ambiguous in general: a wall-clock value that falls inside a DST fold maps
// to two distinct instants, and one inside a DST gap maps to none. This is
// safe here only because Prague's transitions land at 02:00/03:00 local,
// never at midnight — `(date)::timestamp AT TIME ZONE tz` at local midnight
// is always unambiguous for this timezone.
const localMidnight = (tz: string, dayOffset: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{ instant: Date }>`
          SELECT ((((${FIXED_NOW.toISOString()})::timestamptz AT TIME ZONE ${tz})::date + (${dayOffset})::int)
                   AT TIME ZONE ${tz}) AS instant`,
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
      // One minute before FIXED_NOW, so `findEventsToStart`'s real-DB-clock
      // `start_at <= NOW()` still picks it up (`findStartable` has no lower
      // bound — see the FIXED_NOW header block) regardless of when the suite
      // actually runs.
      Effect.bind('event', ({ team, ownerMember }) =>
        insertEvent(
          team.id,
          (ownerMember as any).id,
          false,
          DateTime.makeUnsafe('2025-10-15T09:00:00Z'),
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
        // Pin the post time into the future relative to FIXED_NOW's local
        // time-of-day (12:00). This case asserts that the midnight flip
        // ALONE sets neither stamp; with the default 08:00 the morning post
        // would have already passed.
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '23:00:00')),
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

  it.effect(
    'case 10: the 7-day lower bound is measured from `end_at` — an all-day event LONGER than 7 days is still swept',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000013', 'cron-owner-7')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101017' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000014', 'cron-nonresponder-7'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Spans 8 local days: `start_at` is outside the 7-day window, `end_at` is inside it.
        Effect.bind('start', () => localMidnight('Europe/Prague', -10)),
        Effect.bind('end', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, ownerMember, start, end }) =>
          insertStartedAllDayEvent(team.id, (ownerMember as any).id, start, end),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('stamps', ({ event }) => getStamps(event.id)),
        Effect.bind('missed', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ stamps, missed }) =>
          Effect.sync(() => {
            expect(stamps.missed_rsvp_counted_at).not.toBeNull();
            expect(missed).toBe(1);
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
      // Future relative to FIXED_NOW's local time-of-day (12:00).
      Effect.tap(({ team }) => setAllDayPostTime(team.id, '23:00:00')),
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
        // Past relative to FIXED_NOW's local time-of-day (12:00).
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '01:00:00')),
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
        // No team_settings row — the fallback timezone AND the fallback
        // `all_day_post_time` (08:00) both apply. FIXED_NOW is 12:00 Prague,
        // unconditionally past 08:00, so the assertion below no longer needs
        // a wall-clock guard band (contrast with the pre-fix two-sided
        // conditional this replaced).
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

// ---------------------------------------------------------------------------
// fix/event-start-cron-injectable-clock — regression cases I1-I10 (plan §4)
//
// Framing: these are post-fix boundary pairs, NOT "red before the fix"
// proofs. Before the fix the cron read the real wall clock, so a permanently
// past 2025 fixture could never match — every case expecting >= 1 would have
// been red for a trivial, uninformative reason (findAllDayEventsPastLastLocalDay
// / findAllDayEventsNeedingStartedPost compared FIXED_NOW's fixture data
// against `new Date()`, i.e. today), and every case expecting 0 would have
// been green for the wrong reason. The honest pre/post differential lives in
// `test/services/EventStartCron.test.ts`'s U1 (reference identity) and U2
// (`Effect.suspend` re-samples per run) — see plan §3 Task 3.
//
// Every fixture here is force-set `status = 'started'` before the cron runs
// (so `findEventsToStart`/`findStartable` never sees it, regardless of the
// real DB clock — see the FIXED_NOW header block) and sets its relevant
// boundary column explicitly (`all_day_post_time` for Groups A/B; Group C has
// no such column, its predicate is date-only). `runCronAt(<probe>)` is always
// called with a `new Date(...)` literal, never `FIXED_NOW` itself, so each
// probe is independent of the other groups' fixtures.
// ---------------------------------------------------------------------------

// Group A — team-local-midnight boundary, "Dnes" post sweep.
describe('EventStartCron — I1-I3: team-local-midnight boundary, "Dnes" post sweep', () => {
  it.effect('I1: one second before team-local midnight → no post', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000020', 'cron-owner-i1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101024' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      // Explicit — never let this fall through to the 08:00 COALESCE default.
      Effect.tap(({ team }) => setAllDayPostTime(team.id, '00:00:00')),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      // Local date 10-26 (team-local midnight of 26 Oct).
      Effect.bind('event', ({ team, ownerMember }) =>
        insertEvent(
          team.id,
          (ownerMember as any).id,
          true,
          DateTime.makeUnsafe('2025-10-25T22:00:00Z'),
        ),
      ),
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
          ),
        ),
      ),
      Effect.tap(() => runCronAt(new Date('2025-10-25T21:59:59Z'))),
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
    'I2/I3: exactly at team-local midnight → exactly one post, and a re-run at the same instant does not duplicate',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000021', 'cron-owner-i2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101025' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '00:00:00')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('event', ({ team, ownerMember }) =>
          insertEvent(
            team.id,
            (ownerMember as any).id,
            true,
            DateTime.makeUnsafe('2025-10-25T22:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCronAt(new Date('2025-10-25T22:00:00Z'))),
        Effect.bind('emittedAfterFirst', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.bind('stampsAfterFirst', ({ event }) => getStamps(event.id)),
        Effect.tap(({ emittedAfterFirst, stampsAfterFirst }) =>
          Effect.sync(() => {
            expect(emittedAfterFirst).toBe(1);
            expect(stampsAfterFirst.all_day_post_sent_at).not.toBeNull();
          }),
        ),
        // Re-run at the SAME probe instant — the claim (`claimStartedPost`)
        // must prevent a duplicate post.
        Effect.tap(() => runCronAt(new Date('2025-10-25T22:00:00Z'))),
        Effect.bind('emittedAfterSecond', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emittedAfterSecond }) =>
          Effect.sync(() => {
            expect(emittedAfterSecond).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// Group B — DST fall-back fold, "Dnes" post sweep. Transition at 2025-10-26T01:00:00Z.
describe('EventStartCron — I4-I6: DST fall-back fold, "Dnes" post sweep', () => {
  it.effect('I4: 02:30 CEST, before the fold → posts once', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000022', 'cron-owner-i4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101026' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.tap(({ team }) => setAllDayPostTime(team.id, '02:20:00')),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('event', ({ team, ownerMember }) =>
        insertEvent(
          team.id,
          (ownerMember as any).id,
          true,
          DateTime.makeUnsafe('2025-10-25T22:00:00Z'),
        ),
      ),
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
          ),
        ),
      ),
      // 2025-10-26T00:30:00Z = 2025-10-26 02:30 CEST, still before the fold.
      Effect.tap(() => runCronAt(new Date('2025-10-26T00:30:00Z'))),
      Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
      Effect.tap(({ emitted }) =>
        Effect.sync(() => {
          expect(emitted).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'I5: 02:30 CET, the repeated hour → posts once, identically (fresh fixture; ::date is fold-insensitive)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000023', 'cron-owner-i5')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101027' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '02:20:00')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('event', ({ team, ownerMember }) =>
          insertEvent(
            team.id,
            (ownerMember as any).id,
            true,
            DateTime.makeUnsafe('2025-10-25T22:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        // 2025-10-26T01:30:00Z = 2025-10-26 02:30 CET — the local wall clock
        // ran BACKWARDS an hour relative to I4, yet the predicate still holds:
        // `(now AT TZ)::date` is fold-insensitive (the fold sits inside one
        // calendar day).
        Effect.tap(() => runCronAt(new Date('2025-10-26T01:30:00Z'))),
        Effect.bind('emitted', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ emitted }) =>
          Effect.sync(() => {
            expect(emitted).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'I6: 01:30 CEST, before the post time → no post (the negative half of AGENTS.md rule 4)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000024', 'cron-owner-i6')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101028' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '02:20:00')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('event', ({ team, ownerMember }) =>
          insertEvent(
            team.id,
            (ownerMember as any).id,
            true,
            DateTime.makeUnsafe('2025-10-25T22:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        // 2025-10-25T23:30:00Z = 2025-10-26 01:30 CEST — before 02:20.
        Effect.tap(() => runCronAt(new Date('2025-10-25T23:30:00Z'))),
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

// Group C — team-local-midnight boundary, missed-RSVP sweep.
describe('EventStartCron — I7-I10: team-local-midnight boundary, missed-RSVP sweep', () => {
  it.effect('I7: one second before team-local midnight → not yet swept', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('490000000000000025', 'cron-owner-i7')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('491010101010101029' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
      Effect.bind('nonResponderId', () => createUser('490000000000000026', 'cron-nonresponder-i7')),
      Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
        addTeamMember(team.id, nonResponderId),
      ),
      Effect.tap(({ team, nonResponderMember }) =>
        assignPlayerRole(team.id, (nonResponderMember as any).id),
      ),
      Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      // Local date 10-24 (team-local midnight of 24 Oct), no end_at.
      Effect.bind('event', ({ team, ownerMember }) =>
        insertEvent(
          team.id,
          (ownerMember as any).id,
          true,
          DateTime.makeUnsafe('2025-10-23T22:00:00Z'),
        ),
      ),
      Effect.tap(({ event }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.andThen((sql) =>
            sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
          ),
        ),
      ),
      Effect.tap(() => runCronAt(new Date('2025-10-24T21:59:59Z'))),
      Effect.bind('missed', ({ nonResponderMember }) =>
        getMissedRsvps((nonResponderMember as any).id),
      ),
      Effect.bind('stamps', ({ event }) => getStamps(event.id)),
      Effect.tap(({ missed, stamps }) =>
        Effect.sync(() => {
          expect(missed).toBe(0);
          expect(stamps.missed_rsvp_counted_at).toBeNull();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'I8/I9: exactly at team-local midnight → swept once, and a re-run at the same instant does not double-count',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000027', 'cron-owner-i8')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101030' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000028', 'cron-nonresponder-i8'),
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
            DateTime.makeUnsafe('2025-10-23T22:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen((sql) =>
              sql.unsafe(`UPDATE events SET status = 'started' WHERE id = '${event.id}'`),
            ),
          ),
        ),
        Effect.tap(() => runCronAt(new Date('2025-10-24T22:00:00Z'))),
        Effect.bind('missedAfterFirst', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.bind('stampsAfterFirst', ({ event }) => getStamps(event.id)),
        Effect.tap(({ missedAfterFirst, stampsAfterFirst }) =>
          Effect.sync(() => {
            expect(missedAfterFirst).toBe(1);
            expect(stampsAfterFirst.missed_rsvp_counted_at).not.toBeNull();
          }),
        ),
        // Re-run at the SAME probe instant — the claim (`claimMissedRsvpCount`)
        // must prevent a double-count.
        Effect.tap(() => runCronAt(new Date('2025-10-24T22:00:00Z'))),
        Effect.bind('missedAfterSecond', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missedAfterSecond }) =>
          Effect.sync(() => {
            expect(missedAfterSecond).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'I10: the DST fold does not move the date boundary — swept identically on both sides of the fold (fresh fixture per probe)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000029', 'cron-owner-i10')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101031' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () =>
          createUser('490000000000000030', 'cron-nonresponder-i10'),
        ),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        // Fixture local date 10-25 (team-local midnight of 25 Oct) — one day
        // later than I7-I9's fixture, so the local date has already advanced
        // to 10-26 by both probes below (which straddle the fold).
        Effect.bind('eventPreFold', ({ team, ownerMember }) =>
          insertStartedAllDayEvent(
            team.id,
            (ownerMember as any).id,
            DateTime.makeUnsafe('2025-10-24T22:00:00Z'),
          ),
        ),
        // 2025-10-26T00:30:00Z = 2025-10-26 02:30 CEST, before the fold.
        Effect.tap(() => runCronAt(new Date('2025-10-26T00:30:00Z'))),
        Effect.bind('missedPreFold', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ missedPreFold }) =>
          Effect.sync(() => {
            expect(missedPreFold).toBe(1);
          }),
        ),
        // Fresh fixture for the post-fold probe — the first fixture is
        // already claimed (idempotent), so a second member/event pair is
        // needed to observe the sweep firing again on its own terms.
        Effect.bind('nonResponderId2', () =>
          createUser('490000000000000031', 'cron-nonresponder-i10b'),
        ),
        Effect.bind('nonResponderMember2', ({ team, nonResponderId2 }) =>
          addTeamMember(team.id, nonResponderId2),
        ),
        Effect.tap(({ team, nonResponderMember2 }) =>
          assignPlayerRole(team.id, (nonResponderMember2 as any).id),
        ),
        Effect.bind('eventPostFold', ({ team, ownerMember }) =>
          insertStartedAllDayEvent(
            team.id,
            (ownerMember as any).id,
            DateTime.makeUnsafe('2025-10-24T22:00:00Z'),
          ),
        ),
        // 2025-10-26T01:30:00Z = 2025-10-26 02:30 CET, the repeated hour.
        Effect.tap(() => runCronAt(new Date('2025-10-26T01:30:00Z'))),
        Effect.bind('missedPostFold', ({ nonResponderMember2 }) =>
          getMissedRsvps((nonResponderMember2 as any).id),
        ),
        Effect.tap(({ missedPostFold }) =>
          Effect.sync(() => {
            expect(missedPostFold).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// Rollback-after-claim and two-replica concurrency — the two paths the file
// header above listed as a KNOWN GAP ("no test injects a failure AFTER the
// claim commits", "no two-replica concurrency test"). Both sweeps claim by
// stamping inside one `sql.withTransaction`, so:
//   - if the act half fails, the claim must roll back with it and the event
//     must be swept again on the next cycle (nothing is silently swallowed);
//   - if two replicas sweep the same event at once, the conditional
//     `WHERE … IS NULL` UPDATE must let exactly one of them act.
// Neither is observable through a mocked repository — both are transaction
// and row-lock behaviour, so they live here.
// ---------------------------------------------------------------------------

// Overrides ONLY the method each sweep's "act" half calls. The cron resolves
// nothing else from these repositories, so the rest of the surface is
// deliberately absent rather than stubbed.
const FailingEmitSyncLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventStarted: () => Effect.fail(new Error('injected emitEventStarted failure')),
} as any);

const FailingIncrementRsvpsLayer = Layer.succeed(EventRsvpsRepository, {
  incrementMissedForEventNonRespondersByEventId: () =>
    Effect.fail(new Error('injected incrementMissed failure')),
} as any);

// A second replica: the same cron, over the same database, on a genuinely
// separate Postgres session. `Effect.scoped` closes that connection when the
// cycle ends.
const runCronOnSecondConnection = (now: Date) =>
  Effect.scoped(
    secondTestPgClient.pipe(
      Effect.flatMap((sql2) =>
        makeEventStartCronEffect(now).pipe(
          Effect.provide(RepositoryLayers),
          Effect.provideService(SqlClient.SqlClient, sql2),
        ),
      ),
    ),
  );

describe('EventStartCron — a failure after the claim rolls the claim back', () => {
  it.effect(
    'R1: "Dnes" post sweep — emitEventStarted fails → all_day_post_sent_at stays NULL, and the next cycle posts exactly once',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000032', 'cron-owner-r1')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101032' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.tap(({ team }) => setAllDayPostTime(team.id, '01:00:00')),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', 0)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertStartedAllDayEvent(team.id, (ownerMember as any).id, start),
        ),
        // The cron catches the sweep's failure and keeps going, so this run
        // succeeds — what must NOT survive it is the claim.
        Effect.tap(() => runCron().pipe(Effect.provide(FailingEmitSyncLayer))),
        Effect.bind('stampsAfterFailure', ({ event }) => getStamps(event.id)),
        Effect.bind('emittedAfterFailure', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ stampsAfterFailure, emittedAfterFailure }) =>
          Effect.sync(() => {
            expect(stampsAfterFailure.all_day_post_sent_at).toBeNull();
            expect(emittedAfterFailure).toBe(0);
          }),
        ),
        // Next minute, with the emit working again: the released claim is retaken.
        Effect.tap(() => runCron()),
        Effect.bind('stampsAfterRetry', ({ event }) => getStamps(event.id)),
        Effect.bind('emittedAfterRetry', ({ event }) => countStartedSyncEvents(event.id)),
        Effect.tap(({ stampsAfterRetry, emittedAfterRetry }) =>
          Effect.sync(() => {
            expect(stampsAfterRetry.all_day_post_sent_at).not.toBeNull();
            expect(emittedAfterRetry).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'R2: missed-RSVP sweep — the increment fails → missed_rsvp_counted_at stays NULL, and the next cycle counts exactly once',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('490000000000000033', 'cron-owner-r2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('491010101010101033' as Discord.Snowflake, ownerId),
        ),
        Effect.tap(({ team }) => setTeamTimezone(team.id, 'Europe/Prague')),
        Effect.bind('nonResponderId', () => createUser('490000000000000034', 'cron-nonresp-r2')),
        Effect.bind('nonResponderMember', ({ team, nonResponderId }) =>
          addTeamMember(team.id, nonResponderId),
        ),
        Effect.tap(({ team, nonResponderMember }) =>
          assignPlayerRole(team.id, (nonResponderMember as any).id),
        ),
        Effect.bind('ownerMember', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('start', () => localMidnight('Europe/Prague', -2)),
        Effect.bind('event', ({ team, ownerMember, start }) =>
          insertStartedAllDayEvent(team.id, (ownerMember as any).id, start),
        ),
        Effect.tap(() => runCron().pipe(Effect.provide(FailingIncrementRsvpsLayer))),
        Effect.bind('stampsAfterFailure', ({ event }) => getStamps(event.id)),
        Effect.bind('missedAfterFailure', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ stampsAfterFailure, missedAfterFailure }) =>
          Effect.sync(() => {
            expect(stampsAfterFailure.missed_rsvp_counted_at).toBeNull();
            expect(missedAfterFailure).toBe(0);
          }),
        ),
        Effect.tap(() => runCron()),
        Effect.bind('stampsAfterRetry', ({ event }) => getStamps(event.id)),
        Effect.bind('missedAfterRetry', ({ nonResponderMember }) =>
          getMissedRsvps((nonResponderMember as any).id),
        ),
        Effect.tap(({ stampsAfterRetry, missedAfterRetry }) =>
          Effect.sync(() => {
            expect(stampsAfterRetry.missed_rsvp_counted_at).not.toBeNull();
            expect(missedAfterRetry).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// `Effect.gen` rather than the file's usual `Effect.Do.pipe`: both cases below
// choreograph forked fibers, which reads as a sequence, not as a pipeline.
describe('EventStartCron — two replicas sweeping the same events at once', () => {
  it.effect(
    'C1: two full cron cycles, two Postgres sessions, in parallel → one post, one missed-RSVP increment',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('490000000000000035', 'cron-owner-c1');
        const team = yield* createTeam('491010101010101034' as Discord.Snowflake, ownerId);
        yield* setTeamTimezone(team.id, 'Europe/Prague');
        yield* setAllDayPostTime(team.id, '01:00:00');
        const nonResponderId = yield* createUser('490000000000000036', 'cron-nonresp-c1');
        const nonResponderMember: any = yield* addTeamMember(team.id, nonResponderId);
        yield* assignPlayerRole(team.id, nonResponderMember.id);
        const ownerMember: any = yield* addTeamMember(team.id, ownerId);

        // One event for each sweep: two local days ago (missed-RSVP counter due)
        // and today past the post time ("Dnes" post due).
        const pastStart = yield* localMidnight('Europe/Prague', -2);
        const todayStart = yield* localMidnight('Europe/Prague', 0);
        const pastEvent = yield* insertStartedAllDayEvent(team.id, ownerMember.id, pastStart);
        const todayEvent = yield* insertStartedAllDayEvent(team.id, ownerMember.id, todayStart);

        // End-to-end, but NOT the deterministic half: whether the two cycles
        // genuinely overlap on the claim is up to the scheduler, and if both
        // replicas' finders run after the winner has committed, the finder's own
        // `… IS NULL` filter hides a weakened claim. C2 below pins that directly.
        yield* Effect.all([runCron(), runCronOnSecondConnection(FIXED_NOW)], {
          concurrency: 'unbounded',
        });

        expect(yield* countStartedSyncEvents(todayEvent.id)).toBe(1);
        expect(yield* getMissedRsvps(nonResponderMember.id)).toBe(1);
        expect((yield* getStamps(todayEvent.id)).all_day_post_sent_at).not.toBeNull();
        expect((yield* getStamps(pastEvent.id)).missed_rsvp_counted_at).not.toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'C2: a claim held open by one replica blocks the other, which then finds nothing left to claim',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ownerId = yield* createUser('490000000000000037', 'cron-owner-c2');
          const team = yield* createTeam('491010101010101035' as Discord.Snowflake, ownerId);
          yield* setTeamTimezone(team.id, 'Europe/Prague');
          const ownerMember: any = yield* addTeamMember(team.id, ownerId);
          const start = yield* localMidnight('Europe/Prague', 0);
          const event = yield* insertStartedAllDayEvent(team.id, ownerMember.id, start);

          const repoA = yield* EventsRepository.asEffect();
          const sql2 = yield* secondTestPgClient;
          const repoB = yield* EventsRepository.asEffect().pipe(
            Effect.provide(EventsRepository.Default),
            Effect.provideService(SqlClient.SqlClient, sql2),
          );

          const claimed = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();

          // Replica A claims and parks INSIDE its transaction — exactly the window
          // in which the real sweep resolves Discord and emits.
          const fiberA = yield* Effect.forkChild(
            repoA.withTransaction(
              repoA.claimStartedPost(event.id).pipe(
                Effect.tap(() => Deferred.succeed(claimed, undefined)),
                Effect.tap(() => Deferred.await(release)),
              ),
            ),
          );
          yield* Deferred.await(claimed);

          // Replica B claims the same row on its own session: it blocks on A's
          // uncommitted row until A commits, then re-checks `IS NULL` and loses.
          const fiberB = yield* Effect.forkChild(repoB.claimStartedPost(event.id));
          yield* Deferred.succeed(release, undefined);

          const resultA = yield* Fiber.join(fiberA);
          const resultB = yield* Fiber.join(fiberB);

          expect(Option.isSome(resultA)).toBe(true);
          expect(Option.isNone(resultB)).toBe(true);
        }),
      ).pipe(Effect.provide(TestLayer)),
  );
});
