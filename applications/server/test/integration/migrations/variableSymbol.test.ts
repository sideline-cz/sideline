// Plan `.work-plans/fio-transaction-matching.md` D3 / §7.2 tests 176-179.
//
// Unlike most files in this suite, `1792000000_add_team_member_variable_symbol.ts` and every
// repository this file needs (`TeamsRepository`, `UsersRepository`, `TeamMembersRepository`)
// ALREADY EXIST — this migration and the pure domain modules were delivered in an earlier phase
// (T1/T2's migration half). `variable_symbol` itself is written via raw SQL here rather than a
// not-yet-existing `TeamMembersRepository.setVariableSymbol`, so this file is expected to run
// (not merely compile) once `packages/migrations` is rebuilt to pick up the new file.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const setVs = (memberId: string, vs: string | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`UPDATE team_members SET variable_symbol = ${vs} WHERE id = ${memberId}`,
    ),
  );

// ---------------------------------------------------------------------------
// 176 — multiple NULLs allowed
// ---------------------------------------------------------------------------

describe('team_members.variable_symbol — multiple NULLs allowed (176)', () => {
  it.effect('two members with no variable_symbol coexist in the same team', () =>
    Effect.gen(function* () {
      const user = yield* createUser('owner');
      const team = yield* createTeam(nextDiscordId(), user.id);
      const u1 = yield* createUser('member-1');
      const u2 = yield* createUser('member-2');
      const m1 = yield* createTeamMember(team.id, u1.id);
      const m2 = yield* createTeamMember(team.id, u2.id);
      expect(m1.id).toBeDefined();
      expect(m2.id).toBeDefined();
      // Both default to NULL — no error inserting either.
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 177 — '012345' vs '12345' collide in a team (leading-zero-stripped uniqueness)
// ---------------------------------------------------------------------------

describe('team_members.variable_symbol — leading-zero-stripped uniqueness within a team (177)', () => {
  it.effect("'012345' and '12345' collide in the same team", () =>
    Effect.gen(function* () {
      const user = yield* createUser('owner-collide');
      const team = yield* createTeam(nextDiscordId(), user.id);
      const u1 = yield* createUser('member-collide-1');
      const u2 = yield* createUser('member-collide-2');
      const m1 = yield* createTeamMember(team.id, u1.id);
      const m2 = yield* createTeamMember(team.id, u2.id);

      yield* setVs(m1.id, '12345');
      const result = yield* Effect.result(setVs(m2.id, '012345'));
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 178 — same VS in two different teams is allowed
// ---------------------------------------------------------------------------

describe('team_members.variable_symbol — uniqueness is per-team (178)', () => {
  it.effect('the same VS is allowed for members of two DIFFERENT teams', () =>
    Effect.gen(function* () {
      const userA = yield* createUser('owner-a');
      const teamA = yield* createTeam(nextDiscordId(), userA.id, 'Team A');
      const memberUserA = yield* createUser('member-a');
      const memberA = yield* createTeamMember(teamA.id, memberUserA.id);

      const userB = yield* createUser('owner-b');
      const teamB = yield* createTeam(nextDiscordId(), userB.id, 'Team B');
      const memberUserB = yield* createUser('member-b');
      const memberB = yield* createTeamMember(teamB.id, memberUserB.id);

      yield* setVs(memberA.id, '99999');
      const result = yield* Effect.result(setVs(memberB.id, '99999'));
      expect(result._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 179 — the CHECK rejects non-numeric and 11-digit values
// ---------------------------------------------------------------------------

describe('team_members.variable_symbol — shape CHECK (179)', () => {
  it.effect("'abc' is rejected", () =>
    Effect.gen(function* () {
      const user = yield* createUser('owner-shape-1');
      const team = yield* createTeam(nextDiscordId(), user.id);
      const memberUser = yield* createUser('member-shape-1');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const result = yield* Effect.result(setVs(member.id, 'abc'));
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an 11-digit value is rejected (max 10)', () =>
    Effect.gen(function* () {
      const user = yield* createUser('owner-shape-2');
      const team = yield* createTeam(nextDiscordId(), user.id);
      const memberUser = yield* createUser('member-shape-2');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const result = yield* Effect.result(setVs(member.id, '12345678901'));
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a 10-digit value is accepted (the boundary)', () =>
    Effect.gen(function* () {
      const user = yield* createUser('owner-shape-3');
      const team = yield* createTeam(nextDiscordId(), user.id);
      const memberUser = yield* createUser('member-shape-3');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const result = yield* Effect.result(setVs(member.id, '1234567890'));
      expect(result._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});
