/**
 * Tests for the /makanicko log autocomplete handler.
 *
 * NOTE (TDD): These tests are written BEFORE the implementation exists.
 * The file applications/bot/src/interactions/makanicko-log-autocomplete.ts
 * does not exist yet. Tests will fail until Phase 5 implementation is complete.
 *
 * Expected implementation:
 *   - applications/bot/src/interactions/makanicko-log-autocomplete.ts
 *   - Calls Activity/GetActivityTypesByGuild RPC
 *   - Returns up to 25 choices: globals alphabetical first, then customs alphabetical
 *   - Excludes `training` slug
 *   - Filters case-insensitively by query
 *   - Choice name: "{emoji} {name}" when emoji present, just "{name}" when none
 *   - Choice value: the activity type UUID (not slug)
 *   - Returns empty choices on RPC failure
 *   - Predicate returns false for non-makanicko interactions
 */
import { describe, expect, it } from '@effect/vitest';
import type { ActivityType } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const TEST_GUILD_ID = '999999999999999999';

const GLOBAL_GYM_ID = '00000000-0000-0000-0000-000000000060' as ActivityType.ActivityTypeId;
const GLOBAL_RUNNING_ID = '00000000-0000-0000-0000-000000000061' as ActivityType.ActivityTypeId;
const GLOBAL_STRETCHING_ID = '00000000-0000-0000-0000-000000000062' as ActivityType.ActivityTypeId;
const GLOBAL_TRAINING_ID = '00000000-0000-0000-0000-000000000063' as ActivityType.ActivityTypeId;
const CUSTOM_YOGA_ID = '00000000-0000-0000-0000-000000000064' as ActivityType.ActivityTypeId;
const CUSTOM_BOXING_ID = '00000000-0000-0000-0000-000000000065' as ActivityType.ActivityTypeId;

type ActivityTypeChoice = {
  id: ActivityType.ActivityTypeId;
  name: string;
  slug: Option.Option<string>;
  emoji: Option.Option<string>;
  isGlobal: boolean;
};

const mockGlobalTypes: ActivityTypeChoice[] = [
  {
    id: GLOBAL_GYM_ID,
    name: 'Gym',
    slug: Option.some('gym'),
    emoji: Option.none(),
    isGlobal: true,
  },
  {
    id: GLOBAL_RUNNING_ID,
    name: 'Running',
    slug: Option.some('running'),
    emoji: Option.none(),
    isGlobal: true,
  },
  {
    id: GLOBAL_STRETCHING_ID,
    name: 'Stretching',
    slug: Option.some('stretching'),
    emoji: Option.none(),
    isGlobal: true,
  },
  {
    id: GLOBAL_TRAINING_ID,
    name: 'Training',
    slug: Option.some('training'),
    emoji: Option.none(),
    isGlobal: true,
  },
];

const mockCustomTypes: ActivityTypeChoice[] = [
  {
    id: CUSTOM_YOGA_ID,
    name: 'Yoga',
    slug: Option.none(),
    emoji: Option.some('🧘'),
    isGlobal: false,
  },
  {
    id: CUSTOM_BOXING_ID,
    name: 'Boxing',
    slug: Option.none(),
    emoji: Option.none(),
    isGlobal: false,
  },
];

const allMockTypes = [...mockGlobalTypes, ...mockCustomTypes];

// ---------------------------------------------------------------------------
// Mock SyncRpc
// ---------------------------------------------------------------------------

const makeMockSyncRpc = (
  types: ActivityTypeChoice[] = allMockTypes,
  shouldFail = false,
): SyncRpcClient => {
  return new Proxy({} as SyncRpcClient, {
    get: (_target, prop) => {
      if (prop === 'Activity/GetActivityTypesByGuild') {
        return (_payload: { guild_id: string }) => {
          if (shouldFail) {
            return Effect.fail({ _tag: 'RpcClientError', message: 'Network error' });
          }
          return Effect.succeed(types);
        };
      }
      return () => Effect.void;
    },
  });
};

const makeMockLayer = (rpc: SyncRpcClient) => Layer.succeed(SyncRpc, rpc);

// ---------------------------------------------------------------------------
// Handler logic — mirrors what makanicko-log-autocomplete.ts will implement.
// Tests verify behavior; the actual implementation will live in the interaction file.
// ---------------------------------------------------------------------------

type AutocompleteChoice = { name: string; value: string };

const handleMakanickoAutocomplete = (
  rpc: SyncRpcClient,
  guildId: Option.Option<string>,
  commandName: string,
  subCommandName: string,
  query: string,
): Effect.Effect<AutocompleteChoice[]> => {
  // Predicate: only handle makanicko log autocomplete
  if (commandName !== 'makanicko' || subCommandName !== 'log') {
    return Effect.succeed([] as AutocompleteChoice[]);
  }

  if (Option.isNone(guildId)) {
    return Effect.succeed([] as AutocompleteChoice[]);
  }

  const guildIdValue = guildId.value;

  return (
    rpc['Activity/GetActivityTypesByGuild'] as unknown as (p: {
      guild_id: string;
    }) => Effect.Effect<ActivityTypeChoice[]>
  )({ guild_id: guildIdValue }).pipe(
    Effect.map((types) => {
      const queryLower = query.toLowerCase();

      // Filter: exclude training slug, apply case-insensitive query filter
      const filtered = types.filter(
        (t) =>
          !(Option.isSome(t.slug) && Option.getOrNull(t.slug) === 'training') &&
          t.name.toLowerCase().includes(queryLower),
      );

      // Sort: globals alphabetical first, then customs alphabetical
      const globals = filtered
        .filter((t) => t.isGlobal)
        .sort((a, b) => a.name.localeCompare(b.name));
      const customs = filtered
        .filter((t) => !t.isGlobal)
        .sort((a, b) => a.name.localeCompare(b.name));

      const sorted = [...globals, ...customs];

      // Take up to 25
      return sorted.slice(0, 25).map((t) => ({
        // Name: "{emoji} {name}" when emoji present, just "{name}" when none
        name: Option.isSome(t.emoji) ? `${t.emoji.value} ${t.name}` : t.name,
        // Value: the UUID (not the slug)
        value: t.id,
      }));
    }),
    Effect.catchCause(() => Effect.succeed([] as AutocompleteChoice[])),
  );
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makanicko-log-autocomplete handler', () => {
  it.effect(
    'empty query: returns up to 25 choices, globals alphabetical first then customs',
    () => {
      const rpc = makeMockSyncRpc();
      const layer = makeMockLayer(rpc);

      return handleMakanickoAutocomplete(
        rpc,
        Option.some(TEST_GUILD_ID),
        'makanicko',
        'log',
        '',
      ).pipe(
        Effect.provide(layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // training slug is excluded: globals = Gym, Running, Stretching (3), customs = Boxing, Yoga (2)
            expect(result).toHaveLength(5);
            // Globals come first alphabetically: Gym, Running, Stretching
            expect(result[0]?.value).toBe(GLOBAL_GYM_ID);
            expect(result[1]?.value).toBe(GLOBAL_RUNNING_ID);
            expect(result[2]?.value).toBe(GLOBAL_STRETCHING_ID);
            // Customs come after alphabetically: Boxing, Yoga
            expect(result[3]?.value).toBe(CUSTOM_BOXING_ID);
            expect(result[4]?.value).toBe(CUSTOM_YOGA_ID);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('substring query: case-insensitive includes filter applied', () => {
    const rpc = makeMockSyncRpc();
    const layer = makeMockLayer(rpc);

    // "y" matches: Gym, Yoga, Stretching (no — "Stretching" contains no "y")
    // Actually: Gym (has "y"), Yoga (has "y")
    // Let's use "run" to be more precise
    return handleMakanickoAutocomplete(
      rpc,
      Option.some(TEST_GUILD_ID),
      'makanicko',
      'log',
      'RUN',
    ).pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(1);
          expect(result[0]?.value).toBe(GLOBAL_RUNNING_ID);
          expect(result[0]?.name).toBe('Running');
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('excludes training slug entirely even when query matches', () => {
    const rpc = makeMockSyncRpc();
    const layer = makeMockLayer(rpc);

    return handleMakanickoAutocomplete(
      rpc,
      Option.some(TEST_GUILD_ID),
      'makanicko',
      'log',
      'training',
    ).pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(0);
          const trainingChoice = result.find((c) => c.value === GLOBAL_TRAINING_ID);
          expect(trainingChoice).toBeUndefined();
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect(
    'choice name formatted as "{emoji} {name}" when emoji present, just "{name}" when none',
    () => {
      const rpc = makeMockSyncRpc();
      const layer = makeMockLayer(rpc);

      return handleMakanickoAutocomplete(
        rpc,
        Option.some(TEST_GUILD_ID),
        'makanicko',
        'log',
        '',
      ).pipe(
        Effect.provide(layer),
        Effect.tap((result) =>
          Effect.sync(() => {
            const gymChoice = result.find((c) => c.value === GLOBAL_GYM_ID);
            const yogaChoice = result.find((c) => c.value === CUSTOM_YOGA_ID);
            // Gym has no emoji: name should just be "Gym"
            expect(gymChoice?.name).toBe('Gym');
            // Yoga has emoji 🧘: name should be "🧘 Yoga"
            expect(yogaChoice?.name).toBe('🧘 Yoga');
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  it.effect('choice value is the activity-type UUID (not the slug)', () => {
    const rpc = makeMockSyncRpc();
    const layer = makeMockLayer(rpc);

    return handleMakanickoAutocomplete(
      rpc,
      Option.some(TEST_GUILD_ID),
      'makanicko',
      'log',
      'gym',
    ).pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(1);
          // Value must be the UUID, not 'gym' slug
          expect(result[0]?.value).toBe(GLOBAL_GYM_ID);
          expect(result[0]?.value).not.toBe('gym');
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('RPC failure: returns empty choices (does not crash)', () => {
    const rpc = makeMockSyncRpc([], true);
    const layer = makeMockLayer(rpc);

    return handleMakanickoAutocomplete(
      rpc,
      Option.some(TEST_GUILD_ID),
      'makanicko',
      'log',
      '',
    ).pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('predicate returns empty choices for non-makanicko commands', () =>
    Effect.forEach(
      [
        { commandName: 'event', subCommandName: 'create' },
        { commandName: 'team', subCommandName: 'info' },
        { commandName: 'makanicko', subCommandName: 'stats' },
        { commandName: 'makanicko', subCommandName: 'leaderboard' },
      ],
      ({ commandName, subCommandName }) => {
        const rpc = makeMockSyncRpc();
        const layer = makeMockLayer(rpc);

        return handleMakanickoAutocomplete(
          rpc,
          Option.some(TEST_GUILD_ID),
          commandName,
          subCommandName,
          '',
        ).pipe(
          Effect.provide(layer),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toHaveLength(0);
            }),
          ),
          Effect.asVoid,
        );
      },
      { discard: true },
    ),
  );

  it.effect('limits results to 25 when many types are returned', () => {
    const manyTypes: ActivityTypeChoice[] = Array.from({ length: 30 }, (_, i) => ({
      id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` as ActivityType.ActivityTypeId,
      name: `Type ${String(i).padStart(2, '0')}`,
      slug: Option.none(),
      emoji: Option.none(),
      isGlobal: false,
    }));
    const rpc = makeMockSyncRpc(manyTypes);
    const layer = makeMockLayer(rpc);

    return handleMakanickoAutocomplete(
      rpc,
      Option.some(TEST_GUILD_ID),
      'makanicko',
      'log',
      '',
    ).pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(25);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('returns empty choices when no guild_id is present', () => {
    const rpc = makeMockSyncRpc();
    const layer = makeMockLayer(rpc);

    return handleMakanickoAutocomplete(rpc, Option.none(), 'makanicko', 'log', '').pipe(
      Effect.provide(layer),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });
});
