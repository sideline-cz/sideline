// The classification branch is the only real logic here: the repository's atomic UPDATE reports
// nothing but a row count, so these tests pin which error tag each zero-row cause produces — and
// that the bot honours the selection deadline exactly like the HTTP path does.

import { it as itEffect } from '@effect/vitest';
import type { Discord, MembershipPlan, Team, TeamMember } from '@sideline/domain';
import { MembershipRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { beforeEach, describe, expect } from 'vitest';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { MembershipRpcLive } from '~/rpc/membership/index.js';

const GUILD_ID = '900000000000000001' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '900000000000000099' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000090' as Team.TeamId;
const TREASURER_DISCORD_ID = '900000000000000010' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '900000000000000011' as Discord.Snowflake;
const NON_MEMBER_DISCORD_ID = '900000000000000012' as Discord.Snowflake;
const TREASURER_MEMBER_ID = '00000000-0000-0000-0000-000000000091' as TeamMember.TeamMemberId;
const MEMBER_MEMBER_ID = '00000000-0000-0000-0000-000000000092' as TeamMember.TeamMemberId;
const PLAN_A = '00000000-0000-0000-0000-0000000000a1' as MembershipPlan.MembershipPlanId;
const PLAN_B = '00000000-0000-0000-0000-0000000000a2' as MembershipPlan.MembershipPlanId;

// Drives the stubbed repository per test.
let selectRowsAffected: number;
let storedSelection: Option.Option<{
  membership_plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
  membership_selection_deadline: Option.Option<DateTime.Utc>;
}>;
let selectCalls: Array<unknown>;

beforeEach(() => {
  selectRowsAffected = 1;
  storedSelection = Option.some({
    membership_plan_id: Option.none(),
    membership_selection_deadline: Option.none(),
  });
  selectCalls = [];
});

const planRow = (id: MembershipPlan.MembershipPlanId, isDefault: boolean) => ({
  id,
  team_id: TEAM_ID,
  name: Option.some('Plan'),
  price_minor: 45000,
  currency: 'CZK',
  price_per_training_minor: 8000,
  free_trainings_included: 0,
  expires_at: Option.none(),
  is_default: isDefault,
});

const MockTeamsRepository = Layer.succeed(TeamsRepository, {
  findById: () => Effect.succeed(Option.none()),
  findByGuildId: (guildId: Discord.Snowflake) =>
    Effect.succeed(
      guildId === GUILD_ID
        ? Option.some({
            id: TEAM_ID,
            name: 'Membership Test Team',
            guild_id: GUILD_ID,
            created_by: 'user-1',
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          })
        : Option.none(),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepository = Layer.succeed(TeamMembersRepository, {
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, teamId: Team.TeamId) => {
    if (teamId !== TEAM_ID) return Effect.succeed(Option.none());
    if (discordId === TREASURER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: TREASURER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-treasurer',
          active: true,
          role_names: ['Treasurer'],
          permissions: ['finance:view', 'finance:manage_fees'] as string[],
        }),
      );
    }
    if (discordId === MEMBER_DISCORD_ID) {
      return Effect.succeed(
        Option.some({
          id: MEMBER_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: 'user-member',
          active: true,
          role_names: ['Player'],
          permissions: ['finance:view'] as string[],
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
} as any);

const MockMembershipPlansRepository = Layer.succeed(MembershipPlansRepository, {
  findMembershipPlansByTeamId: () =>
    Effect.succeed([planRow(PLAN_A, true), planRow(PLAN_B, false)]),
  findMemberSelection: () => Effect.succeed(storedSelection),
  selectMembershipPlan: (input: unknown) => {
    selectCalls.push(input);
    return Effect.succeed(selectRowsAffected);
  },
} as any);

const TestLayer = MembershipRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(MockTeamsRepository, MockTeamMembersRepository, MockMembershipPlansRepository),
  ),
);

const callRpc = (method: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (
      RpcTest.makeClient(MembershipRpcGroup.MembershipRpcGroup) as Effect.Effect<any, never, any>
    ).pipe(Effect.flatMap((rpc: any) => rpc[method](payload) as Effect.Effect<any, any, any>)),
  ).pipe(Effect.provide(TestLayer));

describe('Membership/GetMembershipSelection', () => {
  itEffect.effect('returns the plan list and the caller’s own selection', () =>
    Effect.gen(function* () {
      storedSelection = Option.some({
        membership_plan_id: Option.some(PLAN_B),
        membership_selection_deadline: Option.none(),
      });

      const view = yield* callRpc('Membership/GetMembershipSelection', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
      });

      expect(view.plans).toHaveLength(2);
      expect(Option.getOrNull(view.selected_plan_id)).toBe(PLAN_B);
    }),
  );

  itEffect.effect('reports can_manage only for a fee manager', () =>
    Effect.gen(function* () {
      const asMember = yield* callRpc('Membership/GetMembershipSelection', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
      });
      const asTreasurer = yield* callRpc('Membership/GetMembershipSelection', {
        guild_id: GUILD_ID,
        discord_user_id: TREASURER_DISCORD_ID,
      });

      expect(asMember.can_manage).toBe(false);
      expect(asTreasurer.can_manage).toBe(true);
    }),
  );

  itEffect.effect('fails with MembershipGuildNotFound for an unlinked guild', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        callRpc('Membership/GetMembershipSelection', {
          guild_id: UNKNOWN_GUILD_ID,
          discord_user_id: MEMBER_DISCORD_ID,
        }),
      );

      expect(error._tag).toBe('MembershipGuildNotFound');
    }),
  );

  itEffect.effect('fails with MembershipNotMember for an outsider', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        callRpc('Membership/GetMembershipSelection', {
          guild_id: GUILD_ID,
          discord_user_id: NON_MEMBER_DISCORD_ID,
        }),
      );

      expect(error._tag).toBe('MembershipNotMember');
    }),
  );
});

describe('Membership/SelectMembershipPlan', () => {
  itEffect.effect('writes through the shared repository call and returns the fresh view', () =>
    Effect.gen(function* () {
      storedSelection = Option.some({
        membership_plan_id: Option.some(PLAN_B),
        membership_selection_deadline: Option.none(),
      });

      const view = yield* callRpc('Membership/SelectMembershipPlan', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
        plan_id: PLAN_B,
      });

      expect(selectCalls).toEqual([
        { member_id: MEMBER_MEMBER_ID, team_id: TEAM_ID, plan_id: PLAN_B },
      ]);
      expect(Option.getOrNull(view.selected_plan_id)).toBe(PLAN_B);
    }),
  );

  itEffect.effect('reports MembershipSelectionLocked once the deadline has passed', () =>
    Effect.gen(function* () {
      // The UPDATE refuses the write — the bot cannot bypass the deadline the HTTP path enforces.
      selectRowsAffected = 0;
      storedSelection = Option.some({
        membership_plan_id: Option.none(),
        membership_selection_deadline: Option.some(
          DateTime.subtract(DateTime.nowUnsafe(), { hours: 1 }),
        ),
      });

      const error = yield* Effect.flip(
        callRpc('Membership/SelectMembershipPlan', {
          guild_id: GUILD_ID,
          discord_user_id: MEMBER_DISCORD_ID,
          plan_id: PLAN_A,
        }),
      );

      expect(error._tag).toBe('MembershipSelectionLocked');
    }),
  );

  itEffect.effect('reports MembershipPlanUnavailable when the deadline is still open', () =>
    Effect.gen(function* () {
      selectRowsAffected = 0;

      const error = yield* Effect.flip(
        callRpc('Membership/SelectMembershipPlan', {
          guild_id: GUILD_ID,
          discord_user_id: MEMBER_DISCORD_ID,
          plan_id: PLAN_A,
        }),
      );

      expect(error._tag).toBe('MembershipPlanUnavailable');
    }),
  );

  itEffect.effect('reports MembershipNotMember when the member row is gone', () =>
    Effect.gen(function* () {
      // Deactivated between the membership check and the UPDATE — "plan not found" would lie.
      selectRowsAffected = 0;
      storedSelection = Option.none();

      const error = yield* Effect.flip(
        callRpc('Membership/SelectMembershipPlan', {
          guild_id: GUILD_ID,
          discord_user_id: MEMBER_DISCORD_ID,
          plan_id: PLAN_A,
        }),
      );

      expect(error._tag).toBe('MembershipNotMember');
    }),
  );

  itEffect.effect('a future deadline still lets the write through', () =>
    Effect.gen(function* () {
      storedSelection = Option.some({
        membership_plan_id: Option.some(PLAN_A),
        membership_selection_deadline: Option.some(DateTime.add(DateTime.nowUnsafe(), { days: 7 })),
      });

      const view = yield* callRpc('Membership/SelectMembershipPlan', {
        guild_id: GUILD_ID,
        discord_user_id: MEMBER_DISCORD_ID,
        plan_id: PLAN_A,
      });

      expect(Option.getOrNull(view.selected_plan_id)).toBe(PLAN_A);
      expect(Option.isSome(view.deadline)).toBe(true);
    }),
  );
});
