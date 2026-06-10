import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RostersRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        // Both null — this is the shape that previously broke findMemberEntries.
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
        overview_channel_id: Option.none(),
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
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createRoster = (teamId: Team.TeamId) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Squad',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Regression: findMemberEntries must SELECT discord_nickname / discord_display_name
//
// The shared RosterEntry result schema (TeamMembersRepository) requires
// `discord_nickname` and `discord_display_name` (added with the shared
// display-name change). findMemberEntries previously omitted them from its
// SELECT, so decoding the result row failed with
//   "SQL result parsing failed: Missing key at [0].discord_nickname"
// for ANY roster with at least one member — surfacing as a 500 on getRoster
// and a 404 on the web roster detail page. This test loads a roster with a
// member whose nickname/display-name are NULL and asserts it decodes.
// ---------------------------------------------------------------------------

describe('RostersRepository.findMemberEntriesById', () => {
  it.effect('decodes a member whose discord_nickname/display_name are null', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000001', 'nicknameless')),
      Effect.bind('team', ({ userId }) =>
        createTeam('500606060606060601' as Discord.Snowflake, userId),
      ),
      Effect.bind('member', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.bind('roster', ({ team }) => createRoster(team.id)),
      Effect.tap(({ roster, member }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.addMemberById(roster.id, member.id)),
        ),
      ),
      Effect.bind('entries', ({ roster }) =>
        RostersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findMemberEntriesById(roster.id)),
        ),
      ),
      Effect.tap(({ entries, member }) =>
        Effect.sync(() => {
          // Before the fix this Effect failed during result decode and never
          // reached here. Now it resolves with a properly-decoded entry.
          expect(entries).toHaveLength(1);
          expect(entries[0]?.member_id).toBe(member.id);
          expect(entries[0]?.username).toBe('nicknameless');
          expect(Option.isNone(entries[0]?.discord_nickname)).toBe(true);
          expect(Option.isNone(entries[0]?.discord_display_name)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
