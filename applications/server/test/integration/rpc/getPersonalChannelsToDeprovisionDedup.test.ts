// Nastavitelná docházka (plan §6.3, §10.2, deprovision dedup). The dedup
// `Set` that merges `Guild/GetPersonalChannelsToDeprovision`'s sources lives
// in the HANDLER (`applications/server/src/rpc/guild/index.ts`, currently
// keyed on `team_member_id` alone), NOT in a repository query — a repository
// test cannot see this bug. A split member with THREE obsolete channels must
// come back as three rows, one per bucket; today's `team_member_id`-only key
// collapses them to one, silently leaking two channels forever.
//
// Real Postgres (testcontainers), real RPC handler (`GuildsRpcLive`) — the
// same wiring as `GuildGetAllUpcomingEventsForUserVisibility.test.ts`.
//
// Rows are seeded directly via raw SQL against `personal_event_channels`
// (bypassing the repository layer, which is mid-refactor for this feature —
// plan §6.2) so this test exercises ONLY the handler-level merge/dedup fix,
// independent of whichever repository signature the developer lands on.

import { it as itEffect } from '@effect/vitest';
import type { Discord, Team, TeamMember, User } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach, describe, expect } from 'vitest';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { PersonalEventOverflowCategoriesRepository } from '~/repositories/PersonalEventOverflowCategoriesRepository.js';
import { SudoSessionsRepository } from '~/repositories/SudoSessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GuildsRpcLive } from '~/rpc/guild/index.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const PlainRepositories = Layer.mergeAll(
  BotGuildsRepository.Default,
  DiscordChannelsRepository.Default,
  DiscordRolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  DiscordRoleMappingRepository.Default,
  DiscordChannelMappingRepository.Default,
  GroupsRepository.Default,
  InviteAcceptancesRepository.Default,
  PendingGuildJoinsRepository.Default,
  TeamSettingsRepository.Default,
  PersonalEventChannelsRepository.Default,
  PersonalEventOverflowCategoriesRepository.Default,
  EventsRepository.Default,
  SudoSessionsRepository.Default,
);

const SetupLayer = PlainRepositories.pipe(Layer.provideMerge(TestPgClient));

const RpcTestLayer = GuildsRpcLive.pipe(
  Layer.provide(PlainRepositories),
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

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
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Dedup Test Team',
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

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId, active = true) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active, joined_at: undefined }),
    ),
  );

const deactivateMember = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.deactivateMemberByIds(teamId, memberId)),
  );

/** Insert a bucket-carrying personal_event_channels row directly via SQL —
 * bypasses the repository layer, which is mid-refactor for bucket support. */
const seedProvisionedChannel = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  bucket: 'all' | 'training' | 'tournament' | 'other',
  discordChannelId: string,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      sql.unsafe(`
        INSERT INTO personal_event_channels
          (team_id, team_member_id, discord_channel_id, applied_channel_format, bucket)
        VALUES ('${teamId}', '${memberId}', '${discordChannelId}', 'events-{discord_id}', '${bucket}')
      `),
    ),
  );

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

const callGetPersonalChannelsToDeprovision = (params: {
  guild_id: Discord.Snowflake;
  limit: number;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/GetPersonalChannelsToDeprovision']({
            guild_id: params.guild_id,
            limit: params.limit,
          }) as Effect.Effect<
            ReadonlyArray<{ team_member_id: string; discord_channel_id: string; bucket: string }>,
            unknown,
            never
          >,
      ),
      Effect.exit,
    ),
  ).pipe(Effect.provide(RpcTestLayer));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Guild/GetPersonalChannelsToDeprovision — dedup key must be member:bucket, not member alone', () => {
  itEffect.effect(
    'a split member flipped back to one, holding three obsolete channels with the "all" channel provisioned, still active and in-group → returns THREE rows, one per bucket',
    () =>
      Effect.gen(function* () {
        const ownerUserId = yield* createUser(
          '900000000000000001' as Discord.Snowflake,
          'dedup-owner',
        );
        const team = yield* createTeam('900000000000000010' as Discord.Snowflake, ownerUserId);
        const memberUserId = yield* createUser(
          '900000000000000002' as Discord.Snowflake,
          'dedup-member',
        );
        const member = yield* addTeamMember(team.id, memberUserId);

        // Member is active and NOT in any restricted group (no discord_personal_events_group_id
        // configured) — the group-based and inactive-based deprovision sources see NOTHING for
        // this member. The three obsolete split channels are ONLY discoverable via the
        // obsolete-bucket source (plan §6.2/§6.3), which the merge must not collapse.
        yield* seedProvisionedChannel(team.id, member.id, 'training', '900100000000000001');
        yield* seedProvisionedChannel(team.id, member.id, 'tournament', '900100000000000002');
        yield* seedProvisionedChannel(team.id, member.id, 'other', '900100000000000003');
        // The member has flipped back to combined and the new "all" channel is fully
        // provisioned — the B3 gate is satisfied, so all three split channels are obsolete.
        yield* seedProvisionedChannel(team.id, member.id, 'all', '900100000000000004');

        const exit = yield* callGetPersonalChannelsToDeprovision({
          guild_id: '900000000000000010' as Discord.Snowflake,
          limit: 100,
        });
        const rows = Option.getOrThrowWith(
          Exit.getSuccess(exit),
          () => new Error('Expected RPC exit success'),
        );

        const memberRows = rows.filter((r) => r.team_member_id === member.id);
        const buckets = memberRows.map((r) => r.bucket).sort();
        expect(buckets).toEqual(['other', 'tournament', 'training']);
        expect(memberRows).toHaveLength(3);
      }).pipe(Effect.provide(SetupLayer)),
  );

  itEffect.effect(
    'a member who is BOTH inactive and out-of-group still yields one row PER BUCKET, not one row total',
    () =>
      Effect.gen(function* () {
        const ownerUserId = yield* createUser(
          '901000000000000001' as Discord.Snowflake,
          'dedup-owner-2',
        );
        const team = yield* createTeam('901000000000000010' as Discord.Snowflake, ownerUserId);
        const memberUserId = yield* createUser(
          '901000000000000002' as Discord.Snowflake,
          'dedup-member-2',
        );
        const member = yield* addTeamMember(team.id, memberUserId);

        // Split member with three provisioned channels...
        yield* seedProvisionedChannel(team.id, member.id, 'training', '901100000000000001');
        yield* seedProvisionedChannel(team.id, member.id, 'tournament', '901100000000000002');
        yield* seedProvisionedChannel(team.id, member.id, 'other', '901100000000000003');
        // ...who is ALSO deactivated — routes through `getInactiveMembersToDeprovision`,
        // whose query (unlike the obsolete-bucket query) has no B3 gate, and which today
        // fans out to one row PER pec row already (since a split member owns three
        // personal_event_channels rows) — the handler-level Set must not collapse that
        // fan-out down to one via a member_id-only key.
        yield* deactivateMember(team.id, member.id);

        const exit = yield* callGetPersonalChannelsToDeprovision({
          guild_id: '901000000000000010' as Discord.Snowflake,
          limit: 100,
        });
        const rows = Option.getOrThrowWith(
          Exit.getSuccess(exit),
          () => new Error('Expected RPC exit success'),
        );

        const memberRows = rows.filter((r) => r.team_member_id === member.id);
        expect(memberRows).toHaveLength(3);
        const channelIds = memberRows.map((r) => r.discord_channel_id).sort();
        expect(channelIds).toEqual(
          ['901100000000000001', '901100000000000002', '901100000000000003'].sort(),
        );
      }).pipe(Effect.provide(SetupLayer)),
  );
});
