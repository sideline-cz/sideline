// TDD mode — pinning §13.6's backfill ahead of PR 4.
//
// `packages/migrations/src/before/1791500000_add_all_day_deferral_stamps.ts`
// is PR 4's migration, not PR 3c's — it ships the two behavioural stamp
// columns (`events.missed_rsvp_counted_at`, `events.all_day_post_sent_at`)
// alongside their UNCONDITIONAL backfill (§13.6). It is included in THIS
// review pass (case 8 of the reviewer's demanded list) because it is part of
// the same three-migration set as PR 3c's anchor move (§13's intro table) and
// shares its highest-risk property: a data rewrite over every existing row.
//
// Like `anchorAllDayToTeamMidnight.test.ts`, this file does not exist as
// implementation yet — `1791500000` is §13's table's placeholder id and MUST
// be re-picked as `> max(existing)` at PR 4's OWN merge time
// (packages/migrations/AGENTS.md). The deep import below fails module
// resolution (and every test in this file errors at load time) until the
// developer creates that file and `packages/migrations` is rebuilt
// (`pnpm build`) — that is the expected first layer of "red", not yet a
// statement about the backfill's SQL.
//
// §13.6 is explicit that this must be ONE `UPDATE`, with NO `WHERE` clause on
// either backfilled column — a scoped backfill leaves future events armed and
// the first cron cycle after deploy mass-increments counters and mass-posts
// "Dnes:" for a week of historical events (§13.6, mirrors §4.8.1's argument).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import addAllDayDeferralStamps from '@sideline/migrations/before/1791500000_add_all_day_deferral_stamps';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers (mirrors anchorAllDayToTeamMidnight.test.ts)
// ---------------------------------------------------------------------------

const createUser = (discordId: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
        username: `user-${discordId.slice(-6)}`,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: string, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Deferral Backfill Test Team',
        guild_id: guildId as Discord.Snowflake,
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

const setupTeam = (guildId: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () => createUser(guildId)),
    Effect.bind('team', ({ userId }) => createTeam(guildId, userId)),
    Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
    Effect.map(({ team, member }) => ({
      teamId: team.id as string,
      memberId: (member as unknown as { id: string }).id,
    })),
  );

const insertRawEvent = (params: {
  teamId: string;
  createdBy: string;
  allDay: boolean;
  status: 'active' | 'cancelled' | 'started';
  startAtIso: string;
  updatedAtIso?: string | null;
}) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ id: string }>(`
        INSERT INTO events (team_id, event_type, title, start_at, created_by, all_day, all_day_anchored, status${
          params.updatedAtIso ? ', updated_at' : ''
        })
        VALUES (
          '${params.teamId}', 'tournament', 'Deferral backfill fixture',
          '${params.startAtIso}'::timestamptz,
          '${params.createdBy}', ${params.allDay}, ${params.allDay}, '${params.status}'
          ${params.updatedAtIso ? `, '${params.updatedAtIso}'::timestamptz` : ''}
        )
        RETURNING id
      `),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) throw new Error('insert did not return a row');
      return row.id;
    }),
  );

const readStamps = (id: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{
        missed_rsvp_counted_at: Date | null;
        all_day_post_sent_at: Date | null;
      }>(`SELECT missed_rsvp_counted_at, all_day_post_sent_at FROM events WHERE id = '${id}'`),
    ),
    Effect.map((rows) => rows[0]),
  );

const runBackfill = () => addAllDayDeferralStamps;

// ---------------------------------------------------------------------------
// §13.6 case: the backfill stamps EVERY row, unconditionally
// ---------------------------------------------------------------------------

describe('migration 1791500000 — all_day_post_sent_at / missed_rsvp_counted_at backfill (§13.6)', () => {
  it.effect(
    'stamps every row regardless of status, all_day, or date — no WHERE clause on the backfill',
    () =>
      Effect.Do.pipe(
        Effect.bind('setup', () => setupTeam('950100000000002001')),
        // Deliberately varied: active/cancelled/started, all-day/timed,
        // future/past — §13.6 requires the backfill to touch ALL of them.
        // A scoped backfill would leave the future `active` row armed and
        // cause a mass "Dnes:" post + missed-RSVP blast on first cron tick.
        Effect.bind('activeFutureAllDay', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            allDay: true,
            status: 'active',
            startAtIso: '2099-01-01T00:00:00Z',
          }),
        ),
        Effect.bind('startedPastTimed', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            allDay: false,
            status: 'started',
            startAtIso: '2000-01-01T10:00:00Z',
          }),
        ),
        Effect.bind('cancelledAllDay', ({ setup }) =>
          insertRawEvent({
            teamId: setup.teamId,
            createdBy: setup.memberId,
            allDay: true,
            status: 'cancelled',
            startAtIso: '2020-06-15T12:00:00Z',
          }),
        ),
        Effect.tap(() => runBackfill()),
        Effect.bind('rows', ({ activeFutureAllDay, startedPastTimed, cancelledAllDay }) =>
          Effect.all({
            activeFutureAllDay: readStamps(activeFutureAllDay),
            startedPastTimed: readStamps(startedPastTimed),
            cancelledAllDay: readStamps(cancelledAllDay),
          }),
        ),
        Effect.bind('unstampedCount', () =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.flatMap((sql) =>
              sql.unsafe<{ count: string }>(
                `SELECT count(*) FROM events WHERE all_day_post_sent_at IS NULL OR missed_rsvp_counted_at IS NULL`,
              ),
            ),
            Effect.map((r) => Number(r[0]?.count ?? -1)),
          ),
        ),
        Effect.tap(({ rows, unstampedCount }) =>
          Effect.sync(() => {
            expect(rows.activeFutureAllDay?.all_day_post_sent_at).not.toBeNull();
            expect(rows.activeFutureAllDay?.missed_rsvp_counted_at).not.toBeNull();
            expect(rows.startedPastTimed?.all_day_post_sent_at).not.toBeNull();
            expect(rows.startedPastTimed?.missed_rsvp_counted_at).not.toBeNull();
            expect(rows.cancelledAllDay?.all_day_post_sent_at).not.toBeNull();
            expect(rows.cancelledAllDay?.missed_rsvp_counted_at).not.toBeNull();
            // §7.12 case 10's "no status filter" guard, checked directly at
            // the SQL level: zero unstamped rows of ANY status.
            expect(unstampedCount).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('a second run is harmless (the backfill is idempotent)', () =>
    Effect.Do.pipe(
      Effect.bind('setup', () => setupTeam('950100000000002002')),
      Effect.bind('eventId', ({ setup }) =>
        insertRawEvent({
          teamId: setup.teamId,
          createdBy: setup.memberId,
          allDay: true,
          status: 'active',
          startAtIso: '2026-07-15T00:00:00Z',
          updatedAtIso: '2026-06-01T08:00:00Z',
        }),
      ),
      Effect.tap(() => runBackfill()),
      Effect.bind('afterFirstRun', ({ eventId }) => readStamps(eventId)),
      Effect.tap(() => runBackfill()),
      Effect.bind('afterSecondRun', ({ eventId }) => readStamps(eventId)),
      Effect.tap(({ afterFirstRun, afterSecondRun }) =>
        Effect.sync(() => {
          expect(afterSecondRun?.all_day_post_sent_at?.toISOString()).toBe(
            afterFirstRun?.all_day_post_sent_at?.toISOString(),
          );
          expect(afterSecondRun?.missed_rsvp_counted_at?.toISOString()).toBe(
            afterFirstRun?.missed_rsvp_counted_at?.toISOString(),
          );
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
