// `team_settings.auto_assign_variable_symbols` — the treasurer's opt-in to handing a joining
// member the next free `{year}{seq3}` symbol instead of running the bulk dialog after every
// signup. The hook lives in `addMember`, so all four join paths (invite accept, Discord
// auto-join, guild registration, new-team provisioning) are covered by construction.

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

const YEAR = String(new Date().getFullYear());

const enableAutoAssign = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO team_settings (team_id, auto_assign_variable_symbols)
        VALUES (${teamId}, true)
        ON CONFLICT (team_id) DO UPDATE SET auto_assign_variable_symbols = true
      `,
    ),
  );

const vsOf = (memberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql<{
          readonly variable_symbol: string | null;
        }>`SELECT variable_symbol FROM team_members WHERE id = ${memberId}`,
    ),
    Effect.map((rows) => rows[0]?.variable_symbol ?? null),
  );

const newTeam = (tag: string) =>
  Effect.gen(function* () {
    const owner = yield* createUser(`owner-${tag}`);
    const team = yield* createTeam(nextDiscordId(), owner.id);
    return team;
  });

describe('auto-assigning a variable symbol on join', () => {
  it.effect('is off by default — a team with no settings row assigns nothing', () =>
    Effect.gen(function* () {
      const team = yield* newTeam('off');
      const user = yield* createUser('joiner-off');
      const member = yield* createTeamMember(team.id, user.id);

      expect(yield* vsOf(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('assigns the first free symbol when the team opted in', () =>
    Effect.gen(function* () {
      const team = yield* newTeam('on');
      yield* enableAutoAssign(team.id);
      const user = yield* createUser('joiner-on');
      const member = yield* createTeamMember(team.id, user.id);

      expect(yield* vsOf(member.id)).toBe(`${YEAR}001`);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('skips symbols already taken, matching the index on leading zeros', () =>
    Effect.gen(function* () {
      const members = yield* TeamMembersRepository;
      const team = yield* newTeam('zeros');
      yield* enableAutoAssign(team.id);

      // Stored WITH a leading zero. Raw string equality would hand `{YEAR}001` straight back out;
      // the index would then reject it and the join would lose its symbol.
      const holderUser = yield* createUser('holder-zeros');
      const holder = yield* createTeamMember(team.id, holderUser.id);
      yield* members.setVariableSymbol(holder.id, team.id, Option.some(`0${YEAR}001`));

      const joinerUser = yield* createUser('joiner-zeros');
      const joiner = yield* createTeamMember(team.id, joinerUser.id);

      expect(yield* vsOf(joiner.id)).toBe(`${YEAR}002`);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('hands consecutive joiners consecutive symbols', () =>
    Effect.gen(function* () {
      const team = yield* newTeam('seq');
      yield* enableAutoAssign(team.id);

      const assigned: Array<string | null> = [];
      for (const tag of ['a', 'b', 'c']) {
        const user = yield* createUser(`joiner-seq-${tag}`);
        const member = yield* createTeamMember(team.id, user.id);
        assigned.push(yield* vsOf(member.id));
      }

      expect(assigned).toEqual([`${YEAR}001`, `${YEAR}002`, `${YEAR}003`]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a join inside a transaction still gets a symbol and still commits', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const team = yield* newTeam('tx');
      yield* enableAutoAssign(team.id);
      const user = yield* createUser('joiner-tx');

      // `provisionNewTeam` and the invite path both call `addMember` inside a transaction. The
      // assignment must not be able to abort it.
      const member = yield* sql.withTransaction(createTeamMember(team.id, user.id));

      expect(yield* vsOf(member.id)).toBe(`${YEAR}001`);
    }).pipe(Effect.provide(TestLayer)),
  );
});
