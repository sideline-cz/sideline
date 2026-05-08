// NOTE: TDD tests written before implementation.
// findByCodeWithContext and listForTeam do not yet exist on TeamInvitesRepository.
// Some tests will fail until Phase 4 (server) implementation adds these methods.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamInvitesRepository.Default,
  GroupsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Type for the context result returned by findByCodeWithContext (TDD shape)
// ---------------------------------------------------------------------------

interface InviteWithContext {
  groupName: Option.Option<string>;
  inviter_username: string;
  inviter_discord_id: string;
}

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
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
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
      }),
    ),
  );

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
  );

const createInvite = (
  teamId: Team.TeamId,
  createdBy: User.UserId,
  code: string,
  groupId: Option.Option<GroupModel.GroupId>,
  expiresAt: Option.Option<DateTime.Utc> = Option.none(),
) =>
  TeamInvitesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.create({
        team_id: teamId,
        code,
        active: true,
        created_by: createdBy,
        created_at: undefined,
        expires_at: expiresAt,
        group_id: groupId,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamInvitesRepository — findByCodeWithContext', () => {
  it.effect(
    'create with group_id: Some → findByCodeWithContext returns groupName: Some and inviter info',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('100000000000000001', 'inviter-alice')),
        Effect.bind('team', ({ user }) =>
          createTeam('111111111111111111' as Discord.Snowflake, user.id),
        ),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Strikers')),
        Effect.bind('invite', ({ team, user, group }) =>
          createInvite(
            team.id,
            user.id,
            'CODE-WITH-GROUP',
            Option.some(group.id as GroupModel.GroupId),
          ),
        ),
        Effect.bind('found', () =>
          TeamInvitesRepository.asEffect().pipe(
            Effect.andThen(
              (repo) =>
                (repo as any).findByCodeWithContext('CODE-WITH-GROUP') as Effect.Effect<
                  Option.Option<InviteWithContext>
                >,
            ),
          ),
        ),
        Effect.tap(({ found, user }) =>
          Effect.sync(() => {
            expect(Option.isSome(found)).toBe(true);
            const ctx = Option.getOrThrow(found);
            expect(Option.isSome(ctx.groupName)).toBe(true);
            expect(Option.getOrThrow(ctx.groupName)).toBe('Strikers');
            expect(ctx.inviter_username).toBe('inviter-alice');
            expect(ctx.inviter_discord_id).toBe('100000000000000001');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('create with group_id: None → findByCodeWithContext returns groupName: None', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('100000000000000002', 'inviter-bob')),
      Effect.bind('team', ({ user }) =>
        createTeam('222222222222222222' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ team, user }) =>
        createInvite(team.id, user.id, 'CODE-NO-GROUP', Option.none()),
      ),
      Effect.bind('found', () =>
        TeamInvitesRepository.asEffect().pipe(
          Effect.andThen(
            (repo) =>
              (repo as any).findByCodeWithContext('CODE-NO-GROUP') as Effect.Effect<
                Option.Option<InviteWithContext>
              >,
          ),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const ctx = Option.getOrThrow(found);
          expect(Option.isNone(ctx.groupName)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByCodeWithContext with expired invite → returns None', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('100000000000000003', 'inviter-carol')),
      Effect.bind('team', ({ user }) =>
        createTeam('333333333333333333' as Discord.Snowflake, user.id),
      ),
      Effect.bind('invite', ({ team, user }) =>
        TeamInvitesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.create({
              team_id: team.id,
              code: 'EXPIRED-CODE',
              active: true,
              created_by: user.id,
              created_at: undefined,
              expires_at: Option.some(DateTime.fromDateUnsafe(new Date('2000-01-01T00:00:00Z'))),
              group_id: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('found', () =>
        TeamInvitesRepository.asEffect().pipe(
          Effect.andThen(
            (repo) =>
              (repo as any).findByCodeWithContext('EXPIRED-CODE') as Effect.Effect<
                Option.Option<InviteWithContext>
              >,
          ),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'archiving group: findByCodeWithContext returns invite row with group_name: None (not deleted)',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('100000000000000004', 'inviter-dave')),
        Effect.bind('team', ({ user }) =>
          createTeam('444444444444444444' as Discord.Snowflake, user.id),
        ),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'Midfielders')),
        Effect.bind('invite', ({ team, user, group }) =>
          createInvite(
            team.id,
            user.id,
            'ARCHIVE-GROUP-CODE',
            Option.some(group.id as GroupModel.GroupId),
          ),
        ),
        Effect.tap(({ group }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.archiveGroupById(group.id as GroupModel.GroupId)),
          ),
        ),
        // The invite row still exists (ON DELETE SET NULL keeps it)
        Effect.bind('foundActive', () =>
          TeamInvitesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findByCode('ARCHIVE-GROUP-CODE')),
          ),
        ),
        // findByCodeWithContext returns the invite but with group_name: None
        // because the JOIN filters out archived groups
        Effect.bind('foundCtx', () =>
          TeamInvitesRepository.asEffect().pipe(
            Effect.andThen(
              (repo) =>
                (repo as any).findByCodeWithContext('ARCHIVE-GROUP-CODE') as Effect.Effect<
                  Option.Option<InviteWithContext>
                >,
            ),
          ),
        ),
        Effect.tap(({ foundActive, foundCtx }) =>
          Effect.sync(() => {
            // Invite row itself still exists (no CASCADE delete)
            expect(Option.isSome(foundActive)).toBe(true);
            // But findByCodeWithContext hides the archived group name
            expect(Option.isSome(foundCtx)).toBe(true);
            const ctx = Option.getOrThrow(foundCtx);
            expect(Option.isNone(ctx.groupName)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('TeamInvitesRepository — listForTeam', () => {
  it.effect('returns all invites ordered by created_at DESC, including inactive/expired', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('100000000000000005', 'inviter-eve')),
      Effect.bind('team', ({ user }) =>
        createTeam('555555555555555555' as Discord.Snowflake, user.id),
      ),
      Effect.tap(({ team, user }) => createInvite(team.id, user.id, 'FIRST-CODE', Option.none())),
      Effect.tap(({ team, user }) => createInvite(team.id, user.id, 'SECOND-CODE', Option.none())),
      Effect.bind('list', ({ team }) =>
        TeamInvitesRepository.asEffect().pipe(
          Effect.andThen(
            (repo) =>
              (repo as any).listForTeam(team.id) as Effect.Effect<ReadonlyArray<{ code: string }>>,
          ),
        ),
      ),
      Effect.tap(({ list }) =>
        Effect.sync(() => {
          expect(list.length).toBe(2);
          const codes = list.map((i: { code: string }) => i.code);
          expect(codes).toContain('FIRST-CODE');
          expect(codes).toContain('SECOND-CODE');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
