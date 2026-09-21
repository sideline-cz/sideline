// `1792000005_team_settings_timezone_check.ts` — the CHECK that stops a garbage
// IANA zone from reaching `team_settings.timezone`. A bad row there raises
// `time zone "..." not recognized` in every reader that does `AT TIME ZONE`,
// which is fleet-wide (the markStalePersonalMessagesDirty sweep), not per-team.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId, setTeamTimezone } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.gen(function* () {
  const user = yield* createUser('owner');
  return yield* createTeam(nextDiscordId(), user.id);
});

describe('team_settings.timezone CHECK constraint', () => {
  it.effect('accepts a canonical IANA zone', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      yield* setTeamTimezone(team.id, 'Europe/Berlin');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('rejects a zone Postgres cannot resolve', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const result = yield* Effect.result(setTeamTimezone(team.id, 'Garbage/Zone'));
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});
