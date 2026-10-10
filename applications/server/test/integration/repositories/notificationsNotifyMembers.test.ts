// `notifyMembers` swallows its own failures on purpose — a notification must never turn a
// committed cancel or fee assignment into a 500. That makes its SQL invisible to every other
// test: a wrong column name or a broken `::uuid[]` cast would log a warning and leave each
// caller's assertions green.
//
// This is the one test that looks at the rows. It is the thing that fails if the write breaks.
//
// NOTE: integration test — requires Docker + PostgreSQL (started by globalSetup.ts).
// Run with: pnpm test:integration

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  NotificationsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const createUser = (discordId: Discord.Snowflake, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Notification Test Team',
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
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const seed = Effect.Do.pipe(
  Effect.bind('user', () => createUser('900000000000000001' as Discord.Snowflake, 'notify-me')),
  Effect.bind('team', ({ user }) => createTeam('900000000000000002' as Discord.Snowflake, user.id)),
  Effect.bind('member', ({ team, user }) => addTeamMember(team.id, user.id)),
);

describe('NotificationsRepository.notifyMembers (real SQL)', () => {
  it.effect('writes a row the member can read back, link and all', () =>
    Effect.Do.pipe(
      Effect.bind('seeded', () => seed),
      Effect.bind('repo', () => NotificationsRepository.asEffect()),
      Effect.tap(({ repo, seeded }) =>
        repo.notifyMembers(
          seeded.team.id,
          [seeded.member.id as TeamMember.TeamMemberId],
          'event_cancelled',
          `/teams/${seeded.team.id}/events/abc`,
          () => ({ title: 'Event cancelled', body: 'Friday training has been cancelled.' }),
        ),
      ),
      Effect.bind('rows', ({ repo, seeded }) =>
        repo.findByUserAndTeam(seeded.user.id, seeded.team.id),
      ),
      Effect.tap(({ rows, seeded }) =>
        Effect.sync(() => {
          expect(rows).toHaveLength(1);
          expect(rows[0]?.type).toBe('event_cancelled');
          expect(rows[0]?.title).toBe('Event cancelled');
          expect(rows[0]?.link).toBe(`/teams/${seeded.team.id}/events/abc`);
          expect(rows[0]?.is_read).toBe(false);
        }),
      ),
      Effect.asVoid,
      Effect.provide(TestLayer),
    ),
  );

  it.effect('counts the unread row, then stops counting it once read', () =>
    Effect.Do.pipe(
      Effect.bind('seeded', () => seed),
      Effect.bind('repo', () => NotificationsRepository.asEffect()),
      Effect.tap(({ repo, seeded }) =>
        repo.notifyMembers(
          seeded.team.id,
          [seeded.member.id as TeamMember.TeamMemberId],
          'fee_assigned',
          null,
          () => ({ title: 'New fee', body: 'Hall hire was assigned to you.' }),
        ),
      ),
      Effect.bind('before', ({ repo, seeded }) =>
        repo.unreadCountForTeam(seeded.user.id, seeded.team.id),
      ),
      Effect.tap(({ repo, seeded }) => repo.markAllAsReadForTeam(seeded.user.id, seeded.team.id)),
      Effect.bind('after', ({ repo, seeded }) =>
        repo.unreadCountForTeam(seeded.user.id, seeded.team.id),
      ),
      Effect.tap(({ before, after }) =>
        Effect.sync(() => {
          expect(before).toBe(1);
          expect(after).toBe(0);
        }),
      ),
      Effect.asVoid,
      Effect.provide(TestLayer),
    ),
  );

  it.effect('renders each recipient in their own users.locale', () =>
    // The reason notifyMembers takes a render function at all. If the locale were ignored, every
    // Czech member would silently get English — the exact failure the feature exists to prevent,
    // and one that no caller could observe.
    Effect.Do.pipe(
      Effect.bind('seeded', () => seed),
      Effect.bind('users', () => UsersRepository.asEffect()),
      Effect.bind('czUser', () =>
        createUser('900000000000000003' as Discord.Snowflake, 'ctu-member'),
      ),
      Effect.tap(({ users, czUser }) => users.updateLocale({ id: czUser.id, locale: 'cs' })),
      Effect.bind('czMember', ({ seeded, czUser }) => addTeamMember(seeded.team.id, czUser.id)),
      Effect.bind('repo', () => NotificationsRepository.asEffect()),
      Effect.tap(({ repo, seeded, czMember }) =>
        repo.notifyMembers(
          seeded.team.id,
          [seeded.member.id as TeamMember.TeamMemberId, czMember.id as TeamMember.TeamMemberId],
          'event_cancelled',
          null,
          (locale) => ({ title: `title-${locale}`, body: `body-${locale}` }),
        ),
      ),
      Effect.bind('enRows', ({ repo, seeded }) =>
        repo.findByUserAndTeam(seeded.user.id, seeded.team.id),
      ),
      Effect.bind('czRows', ({ repo, seeded, czUser }) =>
        repo.findByUserAndTeam(czUser.id, seeded.team.id),
      ),
      Effect.tap(({ enRows, czRows }) =>
        Effect.sync(() => {
          expect(enRows).toHaveLength(1);
          expect(czRows).toHaveLength(1);
          expect(enRows[0]?.title).toBe('title-en');
          expect(czRows[0]?.title).toBe('title-cs');
        }),
      ),
      Effect.asVoid,
      Effect.provide(TestLayer),
    ),
  );

  it.effect('skips a member who has left the team', () =>
    Effect.Do.pipe(
      Effect.bind('seeded', () => seed),
      Effect.bind('repo', () => NotificationsRepository.asEffect()),
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.tap(({ members, seeded }) =>
        members.deactivateMemberByIds(seeded.team.id, seeded.member.id),
      ),
      Effect.tap(({ repo, seeded }) =>
        repo.notifyMembers(
          seeded.team.id,
          [seeded.member.id as TeamMember.TeamMemberId],
          'event_cancelled',
          null,
          () => ({ title: 'Event cancelled', body: 'Should not be delivered.' }),
        ),
      ),
      Effect.bind('rows', ({ repo, seeded }) =>
        repo.findByUserAndTeam(seeded.user.id, seeded.team.id),
      ),
      Effect.tap(({ rows }) => Effect.sync(() => expect(rows).toHaveLength(0))),
      Effect.asVoid,
      Effect.provide(TestLayer),
    ),
  );
});
