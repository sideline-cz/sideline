// Guild/CompleteMemberProfile marks the user's profile globally complete: it
// persists name, birth date, gender, and `is_profile_complete = true` via
// `UsersRepository.completeProfile`, plus (optionally) the jersey number on the
// caller's membership in the guild's team — all inside a single transaction.
//
// Template: applications/server/test/rpc/RegisterMember.test.ts — same file
// (~/rpc/guild/index.ts → GuildsRpcLive), same "build the whole Layer, call through
// RpcTest.makeClient" approach, since GuildsRpcLive binds ALL of these repositories
// up front (Effect.bind chain) regardless of which single RPC tag is invoked.
// Repositories irrelevant to Guild/CompleteMemberProfile are stubbed with a
// catch-all Proxy (never called by this RPC branch, so their shape doesn't matter).

import { it as itEffect } from '@effect/vitest';
import type { Auth, Discord, Team, TeamMember } from '@sideline/domain';
import { GuildRpcGroup } from '@sideline/domain';
import { DateTime, Effect, Exit, Layer, Option } from 'effect';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, describe, expect } from 'vitest';
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

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const UNKNOWN_GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const ACTIVE_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const ACTIVE_USER_ID = '00000000-0000-0000-0000-000000000031' as Auth.UserId;
const ACTIVE_DISCORD_USER_ID = '200000000000000001' as Discord.Snowflake;
const NON_MEMBER_DISCORD_USER_ID = '200000000000000099' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// In-memory capture stores (reset between tests)
// ---------------------------------------------------------------------------

let completeProfileCalls: Array<Record<string, unknown>>;
let jerseyNumberCalls: Array<{ memberId: string; jerseyNumber: Option.Option<number> }>;
let jerseyNumberShouldFail: boolean;
let transactionInvocations: number;
// Ordered log shared by the transaction + both write mocks — used to prove both
// writes happen strictly between a single transaction's start and end, not just
// that "some" transaction and "some" writes independently occurred.
let eventLog: Array<string>;

const resetStores = () => {
  completeProfileCalls = [];
  jerseyNumberCalls = [];
  jerseyNumberShouldFail = false;
  transactionInvocations = 0;
  eventLog = [];
};

beforeEach(resetStores);
afterEach(resetStores);

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

const normalizeCapturedBirthDate = (value: unknown): string | undefined => {
  const unwrapped = Option.isOption(value) ? Option.getOrUndefined(value) : value;
  if (unwrapped === undefined || unwrapped === null) return undefined;
  if (typeof unwrapped === 'string') return unwrapped.slice(0, 10);
  if (unwrapped instanceof Date) return unwrapped.toISOString().slice(0, 10);
  if (DateTime.isDateTime(unwrapped)) return DateTime.formatIsoDateUtc(unwrapped);
  return undefined;
};

const normalizeCapturedGender = (value: unknown): string | undefined => {
  const unwrapped = Option.isOption(value) ? Option.getOrUndefined(value) : value;
  return typeof unwrapped === 'string' ? unwrapped : undefined;
};

const normalizeCapturedName = (value: unknown): string | undefined => {
  const unwrapped = Option.isOption(value) ? Option.getOrUndefined(value) : value;
  return typeof unwrapped === 'string' ? unwrapped : undefined;
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findByGuildId: (guildId: Discord.Snowflake) => {
    if (guildId === GUILD_ID) {
      return Effect.succeed(
        Option.some({
          id: TEAM_ID,
          guild_id: GUILD_ID,
          name: 'Test Team',
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake, teamId: Team.TeamId) => {
    if (discordId === ACTIVE_DISCORD_USER_ID && teamId === TEAM_ID) {
      return Effect.succeed(
        Option.some({
          id: ACTIVE_MEMBER_ID,
          team_id: TEAM_ID,
          user_id: ACTIVE_USER_ID,
          active: true,
          role_names: ['Player'],
          permissions: ['roster:view', 'member:view'],
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
  setJerseyNumber: (memberId: TeamMember.TeamMemberId, jerseyNumber: Option.Option<number>) => {
    eventLog.push('setJerseyNumber');
    jerseyNumberCalls.push({ memberId, jerseyNumber });
    return jerseyNumberShouldFail
      ? Effect.die(new Error('setJerseyNumber: simulated DB failure'))
      : Effect.void;
  },
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  // Guild/CompleteMemberProfile now marks the profile globally complete via
  // `completeProfile` (name + birth_date + gender + is_profile_complete = true) —
  // it must capture exactly {id, name, birth_date, gender}.
  completeProfile: (input: Record<string, unknown>) => {
    eventLog.push('completeProfile');
    completeProfileCalls.push(input);
    return Effect.void;
  },
  findById: () => Effect.succeed(Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

// Identity `withTransaction` (like RegisterMember.test.ts's MockSqlClientLayer) but
// counts invocations AND records tx-start/tx-end into the shared `eventLog` so
// tests can assert the two writes happen inside a single transaction's callback,
// not just that a transaction was called at some point. This is a unit-level
// proxy only — it cannot demonstrate real Postgres rollback (that's covered by
// integration/manual testing); it only proves (a) `sql.withTransaction(...)` is
// on the write path and wraps both writes, and (b) a failure from either write
// surfaces as an overall RPC failure instead of being swallowed.
const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([]);
    },
    {
      safe: undefined as any,
      withoutTransforms: function (this: any) {
        return this;
      },
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
        transactionInvocations++;
        eventLog.push('tx-start');
        // `ensuring` runs the finalizer on every Exit (success, typed failure, or
        // defect) — mirroring that a real transaction always closes (commit or
        // rollback) around its body.
        return effect.pipe(Effect.ensuring(Effect.sync(() => eventLog.push('tx-end'))));
      },
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([] as never[]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => Effect.succeed([] as never[]),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => Effect.succeed([] as never[]),
      or: (..._args: unknown[]) => Effect.succeed([] as never[]),
    },
  ) as unknown as SqlClient.SqlClient,
);

// Repositories GuildsRpcLive binds but that Guild/CompleteMemberProfile never
// touches — a catch-all Proxy stands in so the Layer graph is satisfiable.
const voidProxy = () => new Proxy({} as any, { get: () => () => Effect.void });

const TestLayer = GuildsRpcLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      MockTeamsRepositoryLayer,
      MockUsersRepositoryLayer,
      MockTeamMembersRepositoryLayer,
      MockSqlClientLayer,
      Layer.succeed(BotGuildsRepository, voidProxy()),
      Layer.succeed(DiscordChannelsRepository, voidProxy()),
      Layer.succeed(DiscordRolesRepository, voidProxy()),
      Layer.succeed(DiscordRoleMappingRepository, voidProxy()),
      Layer.succeed(DiscordChannelMappingRepository, voidProxy()),
      Layer.succeed(GroupsRepository, voidProxy()),
      Layer.succeed(InviteAcceptancesRepository, voidProxy()),
      Layer.succeed(PendingGuildJoinsRepository, voidProxy()),
      Layer.succeed(TeamSettingsRepository, voidProxy()),
      Layer.succeed(PersonalEventChannelsRepository, voidProxy()),
      Layer.succeed(PersonalEventOverflowCategoriesRepository, voidProxy()),
      Layer.succeed(EventsRepository, voidProxy()),
      Layer.succeed(SudoSessionsRepository, voidProxy()),
    ),
  ),
);

// ---------------------------------------------------------------------------
// RPC call helper
// ---------------------------------------------------------------------------

type CompleteMemberProfileResult = {
  readonly name: string;
  readonly birth_date: string;
  readonly gender: string;
  readonly jersey_number: Option.Option<number>;
};

const callCompleteMemberProfile = (payload: {
  guild_id?: Discord.Snowflake;
  discord_user_id: Discord.Snowflake;
  name: string;
  birth_date: string;
  gender: string;
  jersey_number: Option.Option<number>;
}) =>
  Effect.scoped(
    (RpcTest.makeClient(GuildRpcGroup.GuildRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Guild/CompleteMemberProfile']({
            guild_id: payload.guild_id ?? GUILD_ID,
            discord_user_id: payload.discord_user_id,
            name: payload.name,
            birth_date: payload.birth_date,
            gender: payload.gender,
            jersey_number: payload.jersey_number,
          }) as Effect.Effect<any, any, any>,
      ),
    ),
  ).pipe(Effect.provide(TestLayer)) as Effect.Effect<CompleteMemberProfileResult, any, never>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Guild/CompleteMemberProfile — success path', () => {
  itEffect.effect(
    'valid guild + active membership + jersey Some(10) → writes name/birth date/gender and jersey, echoes payload',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.some(10),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.name).toBe('Jane Doe');
            expect(result.birth_date).toBe('1990-05-01');
            expect(result.gender).toBe('male');
            expect(Option.getOrNull(result.jersey_number)).toBe(10);

            expect(completeProfileCalls).toHaveLength(1);
            const captured = completeProfileCalls[0];
            expect(captured.id).toBe(ACTIVE_USER_ID);
            // Asserts the actual persisted VALUES (not just that a write
            // happened) — catches a swapped-argument or wrong-value bug that
            // `captured.id === ACTIVE_USER_ID` alone would miss.
            expect(normalizeCapturedName(captured.name)).toBe('Jane Doe');
            expect(normalizeCapturedBirthDate(captured.birth_date)).toBe('1990-05-01');
            expect(normalizeCapturedGender(captured.gender)).toBe('male');

            expect(jerseyNumberCalls).toHaveLength(1);
            expect(jerseyNumberCalls[0].memberId).toBe(ACTIVE_MEMBER_ID);
            expect(Option.getOrNull(jerseyNumberCalls[0].jerseyNumber)).toBe(10);
          }),
        ),
      ),
  );
});

describe('Guild/CompleteMemberProfile — marks the profile complete', () => {
  itEffect.effect(
    'completeProfile is invoked exactly once with name/birth_date/gender, marking the profile globally complete',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'female',
        jersey_number: Option.some(7),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(completeProfileCalls).toHaveLength(1);
            const captured = completeProfileCalls[0];
            expect(Option.getOrNull(captured.name as Option.Option<string>)).toBe('Jane Doe');
            expect(Option.isSome(captured.birth_date as Option.Option<unknown>)).toBe(true);
            expect(Option.getOrNull(captured.gender as Option.Option<string>)).toBe('female');
          }),
        ),
      ),
  );
});

describe('Guild/CompleteMemberProfile — blank jersey means "leave unchanged"', () => {
  itEffect.effect('jersey_number: None → setJerseyNumber is NOT called, echoed back as None', () =>
    callCompleteMemberProfile({
      discord_user_id: ACTIVE_DISCORD_USER_ID,
      name: 'Jane Doe',
      birth_date: '1990-05-01',
      gender: 'other',
      jersey_number: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Option.isNone(result.jersey_number)).toBe(true);
          expect(jerseyNumberCalls).toHaveLength(0);
          // The name/birth date/gender write still happens regardless of jersey.
          expect(completeProfileCalls).toHaveLength(1);
        }),
      ),
    ),
  );
});

describe('Guild/CompleteMemberProfile — guild not found', () => {
  itEffect.effect(
    'guild_id with no linked team → Failure(CompleteProfileGuildNotFound), no writes',
    () =>
      callCompleteMemberProfile({
        guild_id: UNKNOWN_GUILD_ID,
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CompleteProfileGuildNotFound');
            }
            expect(completeProfileCalls).toHaveLength(0);
            expect(jerseyNumberCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

describe('Guild/CompleteMemberProfile — caller is not a member of the guild-linked team', () => {
  itEffect.effect(
    'discord_user_id with no active membership → Failure(CompleteProfileNotMember), no writes',
    () =>
      callCompleteMemberProfile({
        discord_user_id: NON_MEMBER_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CompleteProfileNotMember');
            }
            expect(completeProfileCalls).toHaveLength(0);
            expect(jerseyNumberCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

describe('Guild/CompleteMemberProfile — defensive server-side revalidation', () => {
  itEffect.effect(
    'blank name (bot-side validation bypassed) → Failure(CompleteProfileInvalidInput), no writes',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: '   ',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CompleteProfileInvalidInput');
            }
            expect(completeProfileCalls).toHaveLength(0);
            expect(jerseyNumberCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );

  itEffect.effect(
    'malformed birth_date (bot-side validation bypassed) → Failure(CompleteProfileInvalidInput), no writes',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: 'not-a-date',
        gender: 'male',
        jersey_number: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CompleteProfileInvalidInput');
            }
            expect(completeProfileCalls).toHaveLength(0);
            expect(jerseyNumberCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );

  itEffect.effect(
    'jersey_number Some(100) — out of 0-99 range (bot-side validation bypassed) → Failure(CompleteProfileInvalidInput), no writes',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.some(100),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Failure');
            if (result._tag === 'Failure') {
              expect(result.failure._tag).toBe('CompleteProfileInvalidInput');
            }
            expect(completeProfileCalls).toHaveLength(0);
            expect(jerseyNumberCalls).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ),
  );
});

describe('Guild/CompleteMemberProfile — transactional writes', () => {
  itEffect.effect(
    'wraps the completeProfile write AND the jersey write inside a single sql.withTransaction call',
    () =>
      callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.some(5),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Exactly one transaction per RPC call — two separate transactions
            // (or none at all) would fail this, unlike a bare `> 0` check.
            expect(transactionInvocations).toBe(1);

            const startIndex = eventLog.indexOf('tx-start');
            const endIndex = eventLog.indexOf('tx-end');
            const completeProfileWriteIndex = eventLog.indexOf('completeProfile');
            const jerseyWriteIndex = eventLog.indexOf('setJerseyNumber');

            expect(startIndex).toBeGreaterThanOrEqual(0);
            expect(endIndex).toBeGreaterThan(startIndex);
            // Both writes must fall strictly between THIS transaction's start
            // and end — proving they share one transaction, not two.
            expect(completeProfileWriteIndex).toBeGreaterThan(startIndex);
            expect(completeProfileWriteIndex).toBeLessThan(endIndex);
            expect(jerseyWriteIndex).toBeGreaterThan(startIndex);
            expect(jerseyWriteIndex).toBeLessThan(endIndex);
          }),
        ),
      ),
  );

  itEffect.effect(
    'setJerseyNumber failing inside the transaction → the overall RPC call fails (Postgres then rolls back both writes; not independently verifiable from this mock)',
    () => {
      jerseyNumberShouldFail = true;
      return callCompleteMemberProfile({
        discord_user_id: ACTIVE_DISCORD_USER_ID,
        name: 'Jane Doe',
        birth_date: '1990-05-01',
        gender: 'male',
        jersey_number: Option.some(5),
      }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            // Only one transaction attempt — the failure aborts it, it doesn't
            // get retried as a fresh transaction.
            expect(transactionInvocations).toBe(1);
            // The transaction still "closes" (tx-end recorded via `ensuring`)
            // even though the body defected — the same guarantee a real
            // Postgres transaction gives when it rolls back on error.
            expect(eventLog).toContain('tx-end');
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
