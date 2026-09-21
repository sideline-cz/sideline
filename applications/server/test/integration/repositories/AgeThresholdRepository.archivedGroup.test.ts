// TDD mode — fix/archived-ancestor-walk, T3.
//
// `AgeThresholdRepository.findRulesByTeamId` (backing `findByTeamIdQuery`, `AgeThresholdRepository.ts`
// ~:81-92) joins `age_threshold_rules atr` to `groups g` with NO `g.is_archived = false` predicate.
// `AgeCheckService.evaluateTeam` (`~/services/AgeCheckService.ts`) calls this method nightly at
// 02:00 (`AgeCheckCron`, `Schedule.cron('0 2 * * *')`) for
// every team with rules and feeds the result straight into `detectChanges`/`commitChanges`, which
// calls `groups.addMemberById` — so archiving a group (`UPDATE groups SET is_archived = true`, a
// single row; it does NOT touch `age_threshold_rules`, and the `groups` row survives with no FK
// cascade) never stops its age-threshold rule from matching. The cron keeps adding members to a
// group the rest of the system already treats as deleted, and — because `commitChanges` writes a
// real `group_members` row — that then feeds `addGroupMember`'s own channel-sync emit
// (`api/group.ts`), which (until T2 lands) emits `member_added` for the archived group too, which
// the bot's `handleMemberAdded.ts` turns into `createRoleOnly` — recreating a Discord role for a
// deleted group, forever, on every nightly sweep.
//
// This test drives the real repository against a real Postgres instance (query semantics, per
// `applications/server/AGENTS.md`'s "Testing" rule 4 preferring integration tests for this), not
// `AgeCheckService`'s own unit tests (`test/AgeCheckService.test.ts`), which mock `thresholds`
// entirely and so cannot exercise the join.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  AgeThresholdRepository.Default,
  GroupsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers — same shape as `GroupsRepository.test.ts`.
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
        name: 'Age Threshold Archived Group Test Team',
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
    ),
  );

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

const insertAgeRule = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
  AgeThresholdRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRule(
        teamId,
        groupId,
        Option.some(6),
        Option.some(9),
        Option.none(),
        Option.none(),
      ),
    ),
  );

const findRulesByTeamId = (teamId: Team.TeamId) =>
  AgeThresholdRepository.asEffect().pipe(Effect.andThen((repo) => repo.findRulesByTeamId(teamId)));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgeThresholdRepository.findRulesByTeamId — must skip rules whose group is archived', () => {
  it.effect('baseline: a rule attached to an ACTIVE group is returned', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('910900000000000001', 'age-rule-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('911000000000000001' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('memberUserId', () => createUser('910900000000000002', 'age-rule-member-1')),
      // A matching active roster member — the realistic shape `evaluateTeam` runs against,
      // even though `findRulesByTeamId` itself is member-agnostic (it lists rules, not matches).
      Effect.tap(({ team, memberUserId }) => addActiveMember(team.id, memberUserId)),
      Effect.bind('group', ({ team }) => createGroup(team.id, 'U8')),
      Effect.tap(({ team, group }) => insertAgeRule(team.id, group.id)),
      Effect.bind('rules', ({ team }) => findRulesByTeamId(team.id)),
      Effect.tap(({ rules, group }) =>
        Effect.sync(() => {
          expect(rules.map((r) => r.group_id)).toContain(group.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'a rule attached to an ARCHIVED group is no longer returned — regression for the hourly AgeCheckService sweep re-adding members to a deleted group',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('910900000000000003', 'age-rule-owner-2')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('911000000000000002' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('memberUserId', () => createUser('910900000000000004', 'age-rule-member-2')),
        Effect.tap(({ team, memberUserId }) => addActiveMember(team.id, memberUserId)),
        Effect.bind('group', ({ team }) => createGroup(team.id, 'U8 (archived)')),
        Effect.tap(({ team, group }) => insertAgeRule(team.id, group.id)),
        // Precondition: the rule is visible before archiving — proves the assertion below fails
        // for the right reason (archiving specifically), not because the fixture never wires the
        // rule to the group at all.
        Effect.bind('rulesBeforeArchive', ({ team }) => findRulesByTeamId(team.id)),
        Effect.tap(({ rulesBeforeArchive, group }) =>
          Effect.sync(() => {
            expect(rulesBeforeArchive.map((r) => r.group_id)).toContain(group.id);
          }),
        ),
        // Archiving is a single-row `UPDATE groups SET is_archived = true` — it does NOT touch
        // `age_threshold_rules`, and the `groups` row survives (no FK cascade fires).
        Effect.tap(({ group }) => archiveGroup(group.id)),
        Effect.bind('rulesAfterArchive', ({ team }) => findRulesByTeamId(team.id)),
        Effect.tap(({ rulesAfterArchive, group }) =>
          Effect.sync(() => {
            expect(rulesAfterArchive.map((r) => r.group_id)).not.toContain(group.id);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
