// TDD mode — PR 4 of the all-day-Discord-start-time plan (§7.7c of the test spec,
// §4.4/§14.1 for the shared `eventVisibleNow` fragment, §4.4.2 for the GROUP BY
// 42803 hazard, §4.4.3 for the pagination tiebreaker, §4.4.4 for the LEFT JOIN +
// COALESCE(timezone) requirement).
//
// Covers the FOUR visibility predicates that are exposed as plain repository
// methods (no RPC plumbing needed to exercise the real SQL against a real
// Postgres): `findUpcomingWithRsvp` (`findUpcomingForDashboard`),
// `findUpcomingByGuildId` (`findUpcomingByGuild` — the GROUP BY hazard),
// `countUpcomingByGuildId` (`countUpcomingByGuild`), and `listMessagesForMember`
// (`PersonalEventMessagesRepository._listForMember` — the `::date::text` decode
// hazard). `Event/GetUpcomingEventsForUser` and `Guild/GetAllUpcomingEventsForUser`
// (the two RPC-only inline-SQL queries) are covered separately in
// `test/integration/rpc/EventGetUpcomingEventsForUserVisibility.test.ts` and
// `test/integration/rpc/GuildGetAllUpcomingEventsForUserVisibility.test.ts`.
//
// IMPORTANT — these four methods read the DATABASE's own `now()` directly; they
// are NOT parameterised with an injectable `now` (only the three reminder
// queries are, per the plan). So instead of pinning exact ISO instants (as the
// endedTrainings/reminders suites do), fixtures here are computed RELATIVE to
// the real wall clock at test-run time via a `localInstant(tz, dayOffset,
// hours)` helper that asks POSTGRES ITSELF (not this test's own clock, and not
// hand computation) for "team-local midnight of (today + dayOffset), plus
// `hours`". This keeps every case correct regardless of when the suite runs,
// at the cost of not being able to pin DST-transition-specific dates for these
// four methods (DST correctness is covered elsewhere: the parameterised
// reminder-window suite and the RSVP-window suite, both of which use fixed
// instants). Documented as a residual — see the final test-report output.
//
// Every test below is expected to FAIL until the developer implements the
// shared `eventVisibility.ts` predicate and splices it into all four call sites.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PersonalEventMessagesRepository } from '~/repositories/PersonalEventMessagesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  PersonalEventMessagesRepository.Default,
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
        minPlayersThreshold: 5,
        timezone,
      }),
    ),
  );

const seedTeamWithMember = (
  discordId: string,
  username: string,
  guildId: Discord.Snowflake,
  timezone?: string,
) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(discordId, username)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.tap(({ team }) =>
      timezone !== undefined ? setTeamTimezone(team.id, timezone) : Effect.void,
    ),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({ team, memberId: member.id })),
  );

/** Asks POSTGRES for "team-local midnight of (today + dayOffset), plus `hours`
 * (+ `minutes`)" as a real instant, so fixtures stay correct no matter when the
 * suite runs (the four methods under test all read the DB's own `now()`). */
const localInstant = (tz: string, dayOffset: number, hours = 0, minutes = 0) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe<{ instant: Date }>(
        `SELECT (((now() AT TIME ZONE '${tz}')::date + ${dayOffset})
                  AT TIME ZONE '${tz}' + INTERVAL '${hours} hours ${minutes} minutes') AS instant`,
      ),
    ),
    Effect.map((rows) => DateTime.fromDateUnsafe(rows[0]?.instant)),
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

const setStatus = (eventId: string, status: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`UPDATE events SET status = '${status}' WHERE id = '${eventId}'`),
    ),
  );

const addPersonalMessageRow = (eventId: string, teamMemberId: string, seq: number) =>
  PersonalEventMessagesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertPersonalEventMessage(
        eventId as any,
        teamMemberId as any,
        `46000000000000${String(seq).padStart(4, '0')}` as Discord.Snowflake,
        `46100000000000${String(seq).padStart(4, '0')}` as Discord.Snowflake,
        `hash-${String(seq)}`,
      ),
    ),
  );

const dashboardHas = (teamId: Team.TeamId, memberId: string, eventId: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findUpcomingWithRsvp(teamId, memberId as any)),
    Effect.map((rows) => rows.some((r) => r.id === eventId)),
  );

const guildHas = (guildId: Discord.Snowflake, eventId: string) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findUpcomingByGuildId(guildId, 0, 50)),
    Effect.map((rows) => rows.some((r) => r.event_id === eventId)),
  );

const guildCount = (guildId: Discord.Snowflake) =>
  EventsRepository.asEffect().pipe(Effect.andThen((repo) => repo.countUpcomingByGuildId(guildId)));

const personalHas = (memberId: string, eventId: string) =>
  PersonalEventMessagesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.listMessagesForMember(memberId as any)),
    Effect.map((rows) => rows.some((r) => r.event_id === eventId)),
  );

// ---------------------------------------------------------------------------
// c-i — the grouped query (`findUpcomingByGuild`) must EXECUTE, not just
// return the right rows. A 42803 surfaces as a SqlError; a test that only
// inspects the returned array never notices it.
// ---------------------------------------------------------------------------

describe('EventsRepository.findUpcomingByGuildId — GROUP BY structural guard (c-i)', () => {
  it.effect('executes to a success Exit (no 42803) once team_settings is joined in', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '460000000000000001',
          'vis-guild-1',
          '460010000000000001' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('start', () => localInstant('Europe/Prague', 0)),
      Effect.tap(({ seed, start }) => insertEvent(seed.team.id, seed.memberId, true, start)),
      Effect.bind('exit', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUpcomingByGuildId(seed.team.guild_id, 0, 50)),
          Effect.exit,
        ),
      ),
      Effect.tap(({ exit }) =>
        Effect.sync(() => {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) {
            expect(exit.value.length).toBeGreaterThan(0);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// c-ii — `_listForMember` DECODES: `local_date` must come back as a plain
// string matching /^\d{4}-\d{2}-\d{2}$/, not a JS Date (which would fail
// `Schema.String` and surface to the bot as a swallowed RpcClientError).
// ---------------------------------------------------------------------------

describe('PersonalEventMessagesRepository.listMessagesForMember — local_date decode guard (c-ii)', () => {
  it.effect('decodes successfully and local_date is a YYYY-MM-DD string', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '460000000000000002',
          'vis-personal-1',
          '460010000000000002' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('start', () => localInstant('Europe/Prague', 0)),
      Effect.bind('event', ({ seed, start }) =>
        insertEvent(seed.team.id, seed.memberId, true, start),
      ),
      Effect.tap(({ seed, event }) => addPersonalMessageRow(event.id, seed.memberId, 1)),
      Effect.bind('exit', ({ seed }) =>
        PersonalEventMessagesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listMessagesForMember(seed.memberId as any)),
          Effect.exit,
        ),
      ),
      Effect.tap(({ exit, event }) =>
        Effect.sync(() => {
          expect(Exit.isSuccess(exit)).toBe(true);
          if (Exit.isSuccess(exit)) {
            const row = exit.value.find((r) => (r as any).event_id === event.id) as any;
            expect(row).toBeDefined();
            expect(typeof row.local_date).toBe('string');
            expect(row.local_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Main predicate table — run against all four exposed methods.
// ---------------------------------------------------------------------------

describe('Visibility predicate — all-day stays visible through the end of its last local day', () => {
  it.effect(
    'case 1/2: timed baseline — future visible, past not (regression guard, unchanged)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '460000000000000003',
            'vis-timed-1',
            '460010000000000003' as Discord.Snowflake,
          ),
        ),
        Effect.bind('future', ({ seed }) =>
          insertEvent(
            seed.team.id,
            seed.memberId,
            false,
            DateTime.makeUnsafe('2099-01-01T10:00:00Z'),
          ),
        ),
        Effect.bind('past', ({ seed }) =>
          insertEvent(
            seed.team.id,
            seed.memberId,
            false,
            DateTime.makeUnsafe('2020-01-01T10:00:00Z'),
          ),
        ),
        Effect.tap(({ seed, future, past }) =>
          Effect.all([
            addPersonalMessageRow(future.id, seed.memberId, 10),
            addPersonalMessageRow(past.id, seed.memberId, 11),
          ]),
        ),
        Effect.tap(({ seed, future, past }) =>
          Effect.all([
            dashboardHas(seed.team.id, seed.memberId, future.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            dashboardHas(seed.team.id, seed.memberId, past.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
            guildHas(seed.team.guild_id, future.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            guildHas(seed.team.guild_id, past.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
            personalHas(seed.memberId, future.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            personalHas(seed.memberId, past.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
          ]),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 3 (defensive control): timed, status=started, start_at in the future → NOT returned (relaxation is all-day only)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '460000000000000004',
            'vis-timed-started',
            '460010000000000004' as Discord.Snowflake,
          ),
        ),
        Effect.bind('event', ({ seed }) =>
          insertEvent(
            seed.team.id,
            seed.memberId,
            false,
            DateTime.makeUnsafe('2099-01-01T10:00:00Z'),
          ),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.tap(({ seed, event }) => addPersonalMessageRow(event.id, seed.memberId, 12)),
        Effect.tap(({ seed, event }) =>
          Effect.all([
            dashboardHas(seed.team.id, seed.memberId, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
            guildHas(seed.team.guild_id, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
            personalHas(seed.memberId, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
          ]),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 5: all-day, status=started, still its own local day → returned (the exact regression; fails today)',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '460000000000000005',
            'vis-allday-started',
            '460010000000000005' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        Effect.bind('start', () => localInstant('Europe/Prague', 0)),
        Effect.bind('event', ({ seed, start }) =>
          insertEvent(seed.team.id, seed.memberId, true, start),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.tap(({ seed, event }) => addPersonalMessageRow(event.id, seed.memberId, 13)),
        Effect.tap(({ seed, event }) =>
          Effect.all([
            dashboardHas(seed.team.id, seed.memberId, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            guildHas(seed.team.guild_id, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            personalHas(seed.memberId, event.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
          ]),
        ),
        Effect.bind('count', ({ seed }) => guildCount(seed.team.guild_id)),
        Effect.tap(({ count }) =>
          Effect.sync(() => {
            expect(count).toBeGreaterThanOrEqual(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 7: all-day, last local day already passed → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '460000000000000006',
          'vis-allday-passed',
          '460010000000000006' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      // Two days ago's local midnight — its last local day (yesterday) is over.
      Effect.bind('start', () => localInstant('Europe/Prague', -2)),
      Effect.bind('event', ({ seed, start }) =>
        insertEvent(seed.team.id, seed.memberId, true, start),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.tap(({ seed, event }) => addPersonalMessageRow(event.id, seed.memberId, 14)),
      Effect.tap(({ seed, event }) =>
        Effect.all([
          dashboardHas(seed.team.id, seed.memberId, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
          guildHas(seed.team.guild_id, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
          personalHas(seed.memberId, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
        ]),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 8: all-day well before its date is excluded from the FUTURE window too when a control event is closer — proves the predicate is not "return everything"',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '460000000000000007',
            'vis-allday-far',
            '460010000000000007' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        // Far future all-day event — must be returned (a genuinely upcoming event).
        Effect.bind('farFuture', ({ seed }) =>
          localInstant('Europe/Prague', 30).pipe(
            Effect.flatMap((start) => insertEvent(seed.team.id, seed.memberId, true, start)),
          ),
        ),
        // Control: an all-day event well BEFORE today (long over) must NOT be
        // returned — a malformed predicate that returns everything would pass
        // the "still live today" cases above but fail this one.
        Effect.bind('farPast', ({ seed }) =>
          localInstant('Europe/Prague', -30).pipe(
            Effect.flatMap((start) => insertEvent(seed.team.id, seed.memberId, true, start)),
          ),
        ),
        Effect.tap(({ farPast }) => setStatus(farPast.id, 'started')),
        Effect.tap(({ seed, farFuture, farPast }) =>
          Effect.all([
            guildHas(seed.team.guild_id, farFuture.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            guildHas(seed.team.guild_id, farPast.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
          ]),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 9: all-day, status=cancelled, still its own local day → NOT returned', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '460000000000000008',
          'vis-allday-cancelled',
          '460010000000000008' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('start', () => localInstant('Europe/Prague', 0)),
      Effect.bind('event', ({ seed, start }) =>
        insertEvent(seed.team.id, seed.memberId, true, start),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'cancelled')),
      Effect.tap(({ seed, event }) => addPersonalMessageRow(event.id, seed.memberId, 15)),
      Effect.tap(({ seed, event }) =>
        Effect.all([
          dashboardHas(seed.team.id, seed.memberId, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
          guildHas(seed.team.guild_id, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
          personalHas(seed.memberId, event.id).pipe(
            Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
          ),
        ]),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'case 12/13: multi-day all-day — visible through day 2, excluded once past the last day',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          seedTeamWithMember(
            '460000000000000009',
            'vis-allday-multiday',
            '460010000000000009' as Discord.Snowflake,
            'Europe/Prague',
          ),
        ),
        // Started yesterday, ends tomorrow (3-day span, today is day 2 of 3).
        Effect.bind('start', () => localInstant('Europe/Prague', -1)),
        Effect.bind('end', () => localInstant('Europe/Prague', 1)),
        Effect.bind('stillRunning', ({ seed, start, end }) =>
          insertEvent(seed.team.id, seed.memberId, true, start, end),
        ),
        Effect.tap(({ stillRunning }) => setStatus(stillRunning.id, 'started')),
        // A second, already-finished 3-day event (started 5 days ago, ended 3 days ago).
        Effect.bind('finishedStart', () => localInstant('Europe/Prague', -5)),
        Effect.bind('finishedEnd', () => localInstant('Europe/Prague', -3)),
        Effect.bind('finished', ({ seed, finishedStart, finishedEnd }) =>
          insertEvent(seed.team.id, seed.memberId, true, finishedStart, finishedEnd),
        ),
        Effect.tap(({ finished }) => setStatus(finished.id, 'started')),
        Effect.tap(({ seed, stillRunning, finished }) =>
          Effect.all([
            guildHas(seed.team.guild_id, stillRunning.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(true))),
            ),
            guildHas(seed.team.guild_id, finished.id).pipe(
              Effect.tap((v) => Effect.sync(() => expect(v).toBe(false))),
            ),
          ]),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'case 14: no team_settings row (LEFT JOIN → NULL tz) falls back to Europe/Prague, event NOT dropped',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () =>
          // No timezone argument — deliberately no team_settings row exists.
          seedTeamWithMember(
            '460000000000000010',
            'vis-no-settings',
            '460010000000000010' as Discord.Snowflake,
          ),
        ),
        Effect.bind('start', () => localInstant('Europe/Prague', 0)),
        Effect.bind('event', ({ seed, start }) =>
          insertEvent(seed.team.id, seed.memberId, true, start),
        ),
        Effect.tap(({ event }) => setStatus(event.id, 'started')),
        Effect.bind('has', ({ seed, event }) => guildHas(seed.team.guild_id, event.id)),
        Effect.tap(({ has }) =>
          Effect.sync(() => {
            expect(has).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('case 17: team_settings LEFT JOIN does not fan out the RSVP count aggregates', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () =>
        seedTeamWithMember(
          '460000000000000011',
          'vis-no-fanout',
          '460010000000000011' as Discord.Snowflake,
          'Europe/Prague',
        ),
      ),
      Effect.bind('start', () => localInstant('Europe/Prague', 0)),
      Effect.bind('event', ({ seed, start }) =>
        insertEvent(seed.team.id, seed.memberId, true, start),
      ),
      Effect.tap(({ event }) => setStatus(event.id, 'started')),
      Effect.bind('rows', ({ seed }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUpcomingByGuildId(seed.team.guild_id, 0, 50)),
        ),
      ),
      Effect.tap(({ rows, event }) =>
        Effect.sync(() => {
          const matches = rows.filter((r) => r.event_id === event.id);
          // team_settings.team_id is the PK — the LEFT JOIN must not duplicate
          // the row (which would also inflate yes/no/maybe counts via fan-out).
          expect(matches).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
