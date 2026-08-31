/**
 * `Role/MarkEventProcessed` — per-member Discord-role provenance (the blocker fix, whole-series
 * review of commit 46806427).
 *
 * `discord_role_mappings.adopted` is a MAPPING-level fact and cannot answer the MEMBER-level
 * question the diff functions (`reconcileMemberDiscordRoles.ts` / `syncMemberDiscordRoles.ts`)
 * need: did THIS member receive the role via Sideline. `member_role_grants` is written here,
 * from the RPC layer that composes `RoleSyncEventsRepository` (which already knows the event's
 * `role_id` / `event_type` / `team_member_id` off the same UPDATE that marks the event processed)
 * and `TeamMembersRepository` (the provenance store) — repositories never depend on one another
 * (see `AGENTS.md`), so this orchestration belongs here, not inside either repository.
 *
 * These tests exercise `RolesRpcLive` directly via `RpcTest.makeClient`, with both repositories
 * mocked, so they pin the ORCHESTRATION (which event types cause which grant-repository calls)
 * without needing a database. Round-tripping `TeamMembersRepository.recordRoleGrant` /
 * `clearRoleGrant` / `findGrantedRoleIds` against real Postgres is covered separately in
 * `test/integration/repositories/TeamMembersRepository.test.ts`.
 */
import { it as itEffect } from '@effect/vitest';
import type { Role, RoleSyncEvent, TeamMember } from '@sideline/domain';
import { RoleRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { describe, expect } from 'vitest';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { RolesRpcLive } from '~/rpc/role/index.js';

const TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000032' as TeamMember.TeamMemberId;
const ROLE_ID = '00000000-0000-0000-0000-000000000031' as Role.RoleId;

const voidProxy = () => new Proxy({} as any, { get: () => () => Effect.void });

type MarkProcessedFixture = {
  readonly team_member_id: Option.Option<TeamMember.TeamMemberId>;
  readonly role_id: Role.RoleId;
  readonly event_type: RoleSyncEvent.RoleSyncEventType;
};

const runMarkEventProcessed = (fixture: MarkProcessedFixture) => {
  const grantCalls: Array<{ teamMemberId: TeamMember.TeamMemberId; roleId: Role.RoleId }> = [];
  const clearCalls: Array<{ teamMemberId: TeamMember.TeamMemberId; roleId: Role.RoleId }> = [];

  const layer = RolesRpcLive.pipe(
    Layer.provide(
      Layer.succeed(RoleSyncEventsRepository, {
        markProcessed: () => Effect.succeed(fixture),
      } as unknown as Effect.Success<ReturnType<typeof RoleSyncEventsRepository.asEffect>>),
    ),
    Layer.provide(Layer.succeed(DiscordRoleMappingRepository, voidProxy())),
    Layer.provide(
      Layer.succeed(TeamMembersRepository, {
        recordRoleGrant: (teamMemberId: TeamMember.TeamMemberId, roleId: Role.RoleId) => {
          grantCalls.push({ teamMemberId, roleId });
          return Effect.void;
        },
        clearRoleGrant: (teamMemberId: TeamMember.TeamMemberId, roleId: Role.RoleId) => {
          clearCalls.push({ teamMemberId, roleId });
          return Effect.void;
        },
      } as unknown as Effect.Success<ReturnType<typeof TeamMembersRepository.asEffect>>),
    ),
  );

  return Effect.scoped(
    // biome-ignore lint/suspicious/noExplicitAny: RpcTest.makeClient is untyped here, matching the
    // established pattern in RulesRpc.test.ts / EmailRpc.test.ts.
    (RpcTest.makeClient(RoleRpcGroup.RoleRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        // biome-ignore lint/suspicious/noExplicitAny: see above
        (rpc: any) =>
          rpc['Role/MarkEventProcessed']({
            id: 'event-1' as RoleSyncEvent.RoleSyncEventId,
            tick_started_at: DateTime.nowUnsafe(),
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(
    Effect.provide(layer),
    Effect.map(() => ({ grantCalls, clearCalls })),
  ) as Effect.Effect<{ grantCalls: typeof grantCalls; clearCalls: typeof clearCalls }, unknown>;
};

describe('Role/MarkEventProcessed — member_role_grants provenance (blocker, whole-series review)', () => {
  itEffect.effect(
    'a processed role_assigned event records a grant for (team_member_id, role_id)',
    () =>
      Effect.gen(function* () {
        const { grantCalls, clearCalls } = yield* runMarkEventProcessed({
          team_member_id: Option.some(TEAM_MEMBER_ID),
          role_id: ROLE_ID,
          event_type: 'role_assigned',
        });

        expect(grantCalls).toEqual([{ teamMemberId: TEAM_MEMBER_ID, roleId: ROLE_ID }]);
        expect(clearCalls).toEqual([]);
      }),
  );

  itEffect.effect(
    'a processed role_unassigned event clears the grant for (team_member_id, role_id)',
    () =>
      Effect.gen(function* () {
        const { grantCalls, clearCalls } = yield* runMarkEventProcessed({
          team_member_id: Option.some(TEAM_MEMBER_ID),
          role_id: ROLE_ID,
          event_type: 'role_unassigned',
        });

        expect(clearCalls).toEqual([{ teamMemberId: TEAM_MEMBER_ID, roleId: ROLE_ID }]);
        expect(grantCalls).toEqual([]);
      }),
  );

  itEffect.effect(
    'a processed team-scoped event (role_created, no team_member_id) touches neither grants nor clears',
    () =>
      Effect.gen(function* () {
        const { grantCalls, clearCalls } = yield* runMarkEventProcessed({
          team_member_id: Option.none(),
          role_id: ROLE_ID,
          event_type: 'role_created',
        });

        expect(grantCalls).toEqual([]);
        expect(clearCalls).toEqual([]);
      }),
  );

  itEffect.effect(
    'a processed team-scoped event (role_deleted, no team_member_id) touches neither grants nor clears',
    () =>
      Effect.gen(function* () {
        const { grantCalls, clearCalls } = yield* runMarkEventProcessed({
          team_member_id: Option.none(),
          role_id: ROLE_ID,
          event_type: 'role_deleted',
        });

        expect(grantCalls).toEqual([]);
        expect(clearCalls).toEqual([]);
      }),
  );
});
