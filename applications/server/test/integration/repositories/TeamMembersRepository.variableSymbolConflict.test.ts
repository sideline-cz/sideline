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
      readonly failure: { _tag: string; holderMemberId: string; holderName: unknown };
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
