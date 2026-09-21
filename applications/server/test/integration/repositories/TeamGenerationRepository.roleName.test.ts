// `findYesMembersForEvent.role_name` is a correlated `LIMIT 1` over `member_roles`.
// It had no ORDER BY, so a member holding more than one role got whichever row
// Postgres happened to hand back — a different role between two runs of the same
// generation. The total order is `is_built_in ASC, name ASC, id ASC`: a position
// role beats the built-ins every member carries, and ties break alphabetically.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamGenerationRepository } from '~/repositories/TeamGenerationRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventRsvpsRepository.Default,
  EventsRepository.Default,
  RolesRepository.Default,
  TeamGenerationRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Team Generation Role Name Test Team',
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
    Effect.map((tm) => tm.id),
  );

const createEvent = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Role Name Determinism Event',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(new Date('2099-12-31T18:00:00Z')),
        endAt: Option.none(),
        location: Option.none(),
        ownerGroupId: Option.none(),
        memberGroupId: Option.none(),
        trainingTypeId: Option.none(),
        seriesId: Option.none(),
        createdBy,
      }),
    ),
  );

// Assign a role by name, whether built-in (seeded by `initializeTeamRoles`) or custom.
const assignRoleByName = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId, name: string) =>
  Effect.all([RolesRepository.asEffect(), TeamMembersRepository.asEffect()]).pipe(
    Effect.flatMap(([roles, members]) =>
      roles.findRoleByTeamAndName(teamId, name).pipe(
        Effect.flatMap(
          Option.match({
            onSome: (role) => Effect.succeed(role),
            onNone: () => roles.insertRole(teamId, name),
          }),
        ),
        Effect.flatMap((role) => members.assignRole(memberId, role.id)),
      ),
    ),
  );

describe('TeamGenerationRepository.findYesMembersForEvent — role_name is deterministic', () => {
  it.effect('picks the alphabetically first custom role over every built-in role', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('940000000000000001', 'tg-role-owner')),
      Effect.bind('memberUserId', () => createUser('940000000000000002', 'tg-role-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('941010101010101010' as Discord.Snowflake, ownerUserId),
      ),
      Effect.tap(({ team }) =>
        RolesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.initializeTeamRoles(team.id)),
        ),
      ),
      Effect.bind('ownerMemberId', ({ team, ownerUserId }) => addTeamMember(team.id, ownerUserId)),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      // Built-ins are inserted (and so likely returned) first — 'Admin' is what an
      // unordered LIMIT 1 hands back, and 'Handler' is what an alphabetical-only
      // order would pick over 'Cutter'.
      Effect.tap(({ team, memberId }) => assignRoleByName(team.id, memberId, 'Admin')),
      Effect.tap(({ team, memberId }) => assignRoleByName(team.id, memberId, 'Player')),
      Effect.tap(({ team, memberId }) => assignRoleByName(team.id, memberId, 'Handler')),
      Effect.tap(({ team, memberId }) => assignRoleByName(team.id, memberId, 'Cutter')),
      Effect.bind('event', ({ team, ownerMemberId }) => createEvent(team.id, ownerMemberId)),
      Effect.tap(({ event, memberId }) =>
        EventRsvpsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.upsertRsvp(event.id, memberId, 'yes', Option.none())),
        ),
      ),
      Effect.bind('rows', ({ event }) =>
        TeamGenerationRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findYesMembersForEvent(event.id)),
        ),
      ),
      Effect.tap(({ rows, memberId }) =>
        Effect.sync(() => {
          const row = rows.find((r) => r.team_member_id === memberId);
          expect(row).toBeDefined();
          expect(Option.getOrNull(row?.role_name ?? Option.none())).toBe('Cutter');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
