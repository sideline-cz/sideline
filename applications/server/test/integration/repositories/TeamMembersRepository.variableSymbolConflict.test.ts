// Regression suite for the production 500 on
// `POST /teams/:teamId/members/variable-symbols/assign` (team Poletíme!, 2026-10-06).
//
// `setVariableSymbol` recovers from the unique violation by SELECTing the current holder so the
// 409 can name them. `assignVariableSymbols` runs the whole batch inside one `sql.withTransaction`,
// and Postgres aborts a transaction the moment a statement raises — so that recovery SELECT came
// back with `current transaction is aborted, commands ignored until end of transaction block`,
// `catchSqlErrors` turned it into a `LogicError` defect, and the request 500'd.
//
// The first test is the reproduction. Without the savepoint in `setVariableSymbol` the defect
// escapes `Effect.result` entirely and the test dies rather than seeing a typed failure.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
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

const HOLDER_NAME = 'Petra Svobodová';

/**
 * Owner plus two members of one team, the first already holding `heldVs`. The holder gets a real
 * `users.name` — that column is what the conflict reports, and `upsertFromDiscord` leaves it NULL.
 */
const twoMembersOneHolding = (tag: string, heldVs: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const members = yield* TeamMembersRepository;
    const owner = yield* createUser(`owner-${tag}`);
    const team = yield* createTeam(nextDiscordId(), owner.id);
    const holderUser = yield* createUser(`holder-${tag}`);
    const claimantUser = yield* createUser(`claimant-${tag}`);
    yield* sql`UPDATE users SET name = ${HOLDER_NAME} WHERE id = ${holderUser.id}`;
    const holder = yield* createTeamMember(team.id, holderUser.id);
    const claimant = yield* createTeamMember(team.id, claimantUser.id);
    yield* members.setVariableSymbol(holder.id, team.id, Option.some(heldVs));
    return { sql, members, team, holder, claimant };
  });

const expectConflict = (result: { readonly _tag: string }, holderMemberId: string) => {
  expect(result._tag).toBe('Failure');
  const failure = (
    result as unknown as {
      readonly failure: {
        _tag: string;
        holderMemberId: string;
        holderName: unknown;
        holderActive: boolean;
      };
    }
  ).failure;
  expect(failure._tag).toBe('VariableSymbolConflict');
  expect(failure.holderMemberId).toBe(holderMemberId);
  return failure;
};

describe('setVariableSymbol — conflict inside an open transaction', () => {
  it.effect('fails with VariableSymbolConflict naming the holder, not a defect', () =>
    Effect.gen(function* () {
      const { sql, members, team, holder, claimant } = yield* twoMembersOneHolding('tx', '2026001');

      // Exactly the handler's shape: the assignment runs inside one transaction.
      const result = yield* Effect.result(
        sql.withTransaction(
          members.setVariableSymbol(claimant.id, team.id, Option.some('2026001')),
        ),
      );

      const failure = expectConflict(result, holder.id);
      expect(Option.getOrNull(failure.holderName as Option.Option<string>)).toBe(HOLDER_NAME);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leading zeros collide the same way the unique index does', () =>
    Effect.gen(function* () {
      const { sql, members, team, holder, claimant } = yield* twoMembersOneHolding(
        'zeros',
        '2026001',
      );

      const result = yield* Effect.result(
        sql.withTransaction(
          members.setVariableSymbol(claimant.id, team.id, Option.some('02026001')),
        ),
      );

      expectConflict(result, holder.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('the batch stays all-or-nothing — an earlier assignment rolls back too', () =>
    Effect.gen(function* () {
      const { sql, members, team, claimant } = yield* twoMembersOneHolding('batch', '2026001');
      const spareUser = yield* createUser('spare-batch');
      const spare = yield* createTeamMember(team.id, spareUser.id);

      yield* Effect.result(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* members.setVariableSymbol(spare.id, team.id, Option.some('2026099'));
            yield* members.setVariableSymbol(claimant.id, team.id, Option.some('2026001'));
          }),
        ),
      );

      // The savepoint un-aborts the transaction for the holder lookup; it must NOT leave the
      // first assignment committed once the outer transaction rolls back.
      const rows = yield* sql<{
        readonly variable_symbol: string | null;
      }>`SELECT variable_symbol FROM team_members WHERE id = ${spare.id}`;
      expect(rows[0]?.variable_symbol).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('setVariableSymbol — holder with no `users.name`', () => {
  // The common case in production: ~72% of symbol holders joined via Discord and never got
  // `users.name` populated, so the raw `u.name` select reported `None` and the treasurer saw
  // "— already has this symbol". The fixture here deliberately does NOT set a name.
  it.effect('falls back down the display-name chain instead of naming nobody', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const members = yield* TeamMembersRepository;
      const owner = yield* createUser('owner-noname');
      const team = yield* createTeam(nextDiscordId(), owner.id);
      const holderUser = yield* createUser('filip28');
      const claimantUser = yield* createUser('claimant-noname');
      yield* sql`UPDATE users SET name = NULL, discord_display_name = 'Filip' WHERE id = ${holderUser.id}`;
      const holder = yield* createTeamMember(team.id, holderUser.id);
      const claimant = yield* createTeamMember(team.id, claimantUser.id);
      yield* members.setVariableSymbol(holder.id, team.id, Option.some('2026013'));

      const result = yield* Effect.result(
        members.setVariableSymbol(claimant.id, team.id, Option.some('2026013')),
      );

      const failure = expectConflict(result, holder.id);
      expect(Option.getOrNull(failure.holderName as Option.Option<string>)).toBe('Filip');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('falls all the way back to the Discord username', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const members = yield* TeamMembersRepository;
      const owner = yield* createUser('owner-username');
      const team = yield* createTeam(nextDiscordId(), owner.id);
      const holderUser = yield* createUser('filip28');
      const claimantUser = yield* createUser('claimant-username');
      yield* sql`UPDATE users SET name = NULL WHERE id = ${holderUser.id}`;
      const holder = yield* createTeamMember(team.id, holderUser.id);
      const claimant = yield* createTeamMember(team.id, claimantUser.id);
      yield* members.setVariableSymbol(holder.id, team.id, Option.some('2026014'));

      const result = yield* Effect.result(
        members.setVariableSymbol(claimant.id, team.id, Option.some('2026014')),
      );

      const failure = expectConflict(result, holder.id);
      expect(Option.getOrNull(failure.holderName as Option.Option<string>)).toBe('filip28');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('setVariableSymbol — the holder has left the team', () => {
  // The symbol stays reserved after deactivation on purpose: `uq_team_members_team_variable_symbol`
  // has no `active` predicate, so a late transfer quoting an old symbol can never be attributed to
  // whoever came after them. The treasurer therefore needs to be told the blocker has left, or an
  // unrecognised name reads as a bug rather than a reserved number.
  it.effect('still conflicts, and reports the holder as inactive', () =>
    Effect.gen(function* () {
      const { sql, members, team, holder, claimant } = yield* twoMembersOneHolding(
        'inactive',
        '2026001',
      );
      yield* sql`UPDATE team_members SET active = false WHERE id = ${holder.id}`;

      const result = yield* Effect.result(
        members.setVariableSymbol(claimant.id, team.id, Option.some('2026001')),
      );

      const failure = expectConflict(result, holder.id);
      expect(Option.getOrNull(failure.holderName as Option.Option<string>)).toBe(HOLDER_NAME);
      expect(failure.holderActive).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an active holder is reported as active', () =>
    Effect.gen(function* () {
      const { members, team, holder, claimant } = yield* twoMembersOneHolding('active', '2026002');

      const result = yield* Effect.result(
        members.setVariableSymbol(claimant.id, team.id, Option.some('2026002')),
      );

      expect(expectConflict(result, holder.id).holderActive).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('findTakenVariableSymbols — what a free-number picker must see', () => {
  // The suggestion endpoint used to build its "taken" set from `findRosterByTeam`, which is
  // `WHERE tm.active = true`. A departed member keeps their symbol, so the picker happily offered
  // a number the unique index then rejected — the treasurer hit 409 on a number the UI had just
  // handed them. This query mirrors the index instead, active members and former members alike.
  it.effect('includes a departed member, normalised the way the index normalises', () =>
    Effect.gen(function* () {
      const { sql, members, team, holder } = yield* twoMembersOneHolding('taken', '2026046');
      yield* sql`UPDATE team_members SET active = false WHERE id = ${holder.id}`;

      const taken = yield* members.findTakenVariableSymbols(team.id);

      expect(taken).toContain('2026046');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('strips leading zeros so a padded symbol cannot be re-offered', () =>
    Effect.gen(function* () {
      const { sql, members, team, holder } = yield* twoMembersOneHolding('zeros-taken', '2026047');
      yield* sql`UPDATE team_members SET variable_symbol = '02026047', active = false WHERE id = ${holder.id}`;

      const taken = yield* members.findTakenVariableSymbols(team.id);

      expect(taken).toContain('2026047');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('is scoped to the team', () =>
    Effect.gen(function* () {
      const { members, team } = yield* twoMembersOneHolding('scope', '2026048');
      const otherOwner = yield* createUser('other-owner');
      const otherTeam = yield* createTeam(nextDiscordId(), otherOwner.id);

      expect(yield* members.findTakenVariableSymbols(otherTeam.id)).toEqual([]);
      expect(yield* members.findTakenVariableSymbols(team.id)).toContain('2026048');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('setVariableSymbol — conflict with no surrounding transaction', () => {
  it.effect('still reports the holder (the single-member roster path)', () =>
    Effect.gen(function* () {
      const { members, team, holder, claimant } = yield* twoMembersOneHolding('solo', '2026001');

      const result = yield* Effect.result(
        members.setVariableSymbol(claimant.id, team.id, Option.some('2026001')),
      );

      const failure = expectConflict(result, holder.id);
      expect(Option.getOrNull(failure.holderName as Option.Option<string>)).toBe(HOLDER_NAME);
    }).pipe(Effect.provide(TestLayer)),
  );
});
