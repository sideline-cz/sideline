// TDD mode — PR 3 of the all-day-Discord-start-time plan (§12 step 6, §13 intro).
//
// `events.all_day_anchored` does not exist yet (migration
// `1791300000_add_all_day_anchored_flag.ts`, §13 intro table, is not written).
// Every test below is expected to FAIL until the developer:
//   1. adds the migration: `ALTER TABLE events ADD COLUMN IF NOT EXISTS
//      all_day_anchored BOOLEAN NOT NULL DEFAULT FALSE` — nothing else (§13
//      intro's warning: the OTHER two migrations in that table, `1791400000`
//      and `1791500000`, are placeholders that ship with LATER prs and must be
//      re-picked at merge time — do not create them here);
//   2. stamps `all_day_anchored = ${input.all_day}` on BOTH SQL writers in
//      `EventsRepository.ts` — the `insert` statement and the `update`
//      statement (§12 step 6's table) — using the INPUT value, never a
//      hardcoded `TRUE` (§12 step 6's box: a hardcoded `TRUE` would falsify
//      case 2 below, and would let reverted pre-PR-3 code leave `TRUE` on a
//      noon sentinel that PR 3c's migration would then skip forever).
//
// This is a Postgres integration test (testcontainers, see
// test/integration/globalSetup.ts) — the column's existence, its NOT NULL/
// DEFAULT FALSE properties, and the two SQL writers are schema/SQL facts a
// mock cannot verify.
//
// ⚠ TDD note on what "red" looks like right now. Every test in this file
// fails at HEAD, but for TWO different reasons layered on top of each other:
// until the migration lands, ALL five fail at *setup* with "column
// all_day_anchored does not exist" — that is step 1's prerequisite, not yet
// a statement about step 2. Once the migration is added (and the package
// rebuilt — this is a `packages/migrations` change, see the root AGENTS.md),
// the suite re-settles into its real signal: the column-properties test and
// three of the four stamp tests turn green→red *for the right reason*
// (asserting `TRUE`/flips that step 2 hasn't implemented yet), while
// "insertEvent: a TIMED row is stamped ... FALSE" already passes — a
// TIMED row gets `FALSE` whether or not the stamp exists, so it is a
// regression guard, not an acceptance test, exactly like §7.10 cases 9/10/12
// in `eventAllDayAnchor.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers (mirrors EventsRepository.test.ts's seeding pattern)
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

const insertEvent = (
  teamId: Team.TeamId,
  createdBy: TeamMember.TeamMemberId,
  allDay: boolean,
  startAtIso = '2026-07-15T12:00:00Z',
) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'tournament',
        title: allDay ? 'All-day event' : 'Timed event',
        description: Option.none(),
        startAt: DateTime.makeUnsafe(startAtIso),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
        allDay,
      }),
    ),
  );

/** Reads `all_day_anchored` directly — the column is never projected by any
 * `SELECT` in `EventsRepository.ts` (plan §12 step 6: "nothing in the
 * application ever reads it"), so a raw query is the only way to observe it. */
const readAllDayAnchored = (eventId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      sql.unsafe<{ all_day_anchored: boolean }>(
        `SELECT all_day_anchored FROM events WHERE id = '${eventId}'`,
      ),
    ),
    Effect.map((rows) => rows[0]?.all_day_anchored),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migration 1791300000 — all_day_anchored column (PR 3, plan §13 intro)', () => {
  it.effect('the column exists, is NOT NULL, and defaults to FALSE', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql.unsafe<{
        column_name: string;
        is_nullable: string;
        data_type: string;
        column_default: string | null;
      }>(
        `SELECT column_name, is_nullable, data_type, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'all_day_anchored'`,
      );

      expect(cols, 'all_day_anchored column does not exist').toHaveLength(1);
      const col = cols.at(0);
      if (!col) throw new Error('unreachable — length checked above');
      expect(col.data_type).toBe('boolean');
      expect(col.is_nullable, 'all_day_anchored must be NOT NULL').toBe('NO');
      // Postgres reports boolean defaults as the literal text `false`.
      expect(col.column_default, 'all_day_anchored must DEFAULT FALSE').toContain('false');
    }).pipe(Effect.provide(TestPgClient)),
  );
});

describe('EventsRepository — all_day_anchored stamp (PR 3, plan §12 step 6)', () => {
  it.effect('insertEvent: an all-day row is stamped all_day_anchored = TRUE', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('320000000000000001', 'anchor-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('321010101010101011' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true),
      ),
      Effect.bind('flag', ({ inserted }) => readAllDayAnchored(inserted.id)),
      Effect.tap(({ flag }) =>
        Effect.sync(() => {
          expect(flag).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('insertEvent: a TIMED row is stamped all_day_anchored = FALSE, not TRUE', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('320000000000000002', 'anchor-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('321010101010101012' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, false),
      ),
      Effect.bind('flag', ({ inserted }) => readAllDayAnchored(inserted.id)),
      Effect.tap(({ flag }) =>
        Effect.sync(() => {
          expect(flag).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('updateEvent: flipping a timed row to all-day flips all_day_anchored to TRUE', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('320000000000000003', 'anchor-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('321010101010101013' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
      Effect.bind('inserted', ({ team, tm }) =>
        insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, false),
      ),
      Effect.bind('flagBefore', ({ inserted }) => readAllDayAnchored(inserted.id)),
      Effect.bind('updated', ({ inserted }) =>
        EventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.updateEvent({
              id: inserted.id,
              title: inserted.title,
              eventType: inserted.event_type,
              trainingTypeId: Option.none(),
              description: Option.none(),
              startAt: inserted.start_at,
              endAt: Option.none(),
              location: Option.none(),
              ownerGroupId: Option.none(),
              memberGroupId: Option.none(),
              allDay: true,
            }),
          ),
        ),
      ),
      Effect.bind('flagAfter', ({ inserted }) => readAllDayAnchored(inserted.id)),
      Effect.tap(({ flagBefore, flagAfter }) =>
        Effect.sync(() => {
          expect(flagBefore).toBe(false);
          expect(flagAfter).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'updateEvent: flipping an all-day row BACK to timed flips all_day_anchored to FALSE (never hardcoded TRUE)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('320000000000000004', 'anchor-owner-4')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('321010101010101014' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('tm', ({ team, ownerId }) => addTeamMember(team.id, ownerId)),
        Effect.bind('inserted', ({ team, tm }) =>
          insertEvent(team.id, (tm as any).id as TeamMember.TeamMemberId, true),
        ),
        Effect.bind('flagBefore', ({ inserted }) => readAllDayAnchored(inserted.id)),
        Effect.bind('updated', ({ inserted }) =>
          EventsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.updateEvent({
                id: inserted.id,
                title: inserted.title,
                eventType: inserted.event_type,
                trainingTypeId: Option.none(),
                description: Option.none(),
                startAt: inserted.start_at,
                endAt: Option.none(),
                location: Option.none(),
                ownerGroupId: Option.none(),
                memberGroupId: Option.none(),
                allDay: false,
              }),
            ),
          ),
        ),
        Effect.bind('flagAfter', ({ inserted }) => readAllDayAnchored(inserted.id)),
        Effect.tap(({ flagBefore, flagAfter }) =>
          Effect.sync(() => {
            expect(flagBefore).toBe(true);
            expect(flagAfter).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
