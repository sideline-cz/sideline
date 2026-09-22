/**
 * TDD tests for `~/rest/roles/ensureUnverifiedRole.ts` (Task 10) — the
 * bot-owned "Sideline Unverified" role, resolved by name with
 * `ensureSudoRole.ts`'s exact pattern (list → find by name → create,
 * deterministic oldest-id tiebreak, no DB row).
 *
 * Two exports:
 *   - `findUnverifiedRole(guildId)` → `Effect<Option<Snowflake>>` — resolve
 *     ONLY, never creates. Used on the revoke path (a revoke must never
 *     create the very role it is trying to remove).
 *   - `ensureUnverifiedRole(guildId)` → `Effect<Snowflake>` — find-or-create,
 *     `permissions: 0` (never `Administrator`). Used on the grant path.
 *
 * Spec: .work-plans/discord-full-onboarding.md, Task 10, "Test specification"
 * §Task 10 ("role present → returns its id, no create; absent →
 * ensureUnverifiedRole creates with permissions: 0 and findUnverifiedRole
 * returns None without creating; two roles with the same name → the lowest
 * id plus a warning").
 */

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureUnverifiedRole,
  findUnverifiedRole,
  UNVERIFIED_ROLE_NAME,
} from '~/rest/roles/ensureUnverifiedRole.js';

const GUILD_ID = '800000000000000001';

const makeRestLayer = (
  roles: ReadonlyArray<{ id: string; name: string }>,
  overrides: { createGuildRole?: ReturnType<typeof vi.fn> } = {},
) => {
  const listGuildRoles = vi.fn(() => Effect.succeed(roles));
  const createGuildRole =
    overrides.createGuildRole ??
    vi.fn((_guildId: string, options: { name: string; permissions: number }) =>
      Effect.succeed({ id: '800000000000000099', name: options.name }),
    );
  const rest = new Proxy({} as any, {
    get: (_target: unknown, prop: string) => {
      if (prop === 'listGuildRoles') return listGuildRoles;
      if (prop === 'createGuildRole') return createGuildRole;
      return () => Effect.succeed(undefined);
    },
  });
  return { layer: Layer.succeed(DiscordREST, rest), listGuildRoles, createGuildRole };
};

const run = <A>(effect: Effect.Effect<A, unknown, DiscordREST>, layer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as unknown as Effect.Effect<A, never, never>,
  );

describe('findUnverifiedRole — resolve only, NEVER creates', () => {
  it('role present → returns Some(id), no create', async () => {
    const EXISTING_ID = '800000000000000010';
    const stub = makeRestLayer([{ id: EXISTING_ID, name: UNVERIFIED_ROLE_NAME }]);

    const result = await run(findUnverifiedRole(GUILD_ID as any), stub.layer);

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrNull(result)).toBe(EXISTING_ID);
    expect(stub.createGuildRole).not.toHaveBeenCalled();
  });

  it('role absent → returns None, WITHOUT creating one', async () => {
    const stub = makeRestLayer([]);

    const result = await run(findUnverifiedRole(GUILD_ID as any), stub.layer);

    expect(Option.isNone(result)).toBe(true);
    expect(stub.createGuildRole).not.toHaveBeenCalled();
  });

  it('two roles with the same name → deterministically picks the lowest (oldest) id and warns', async () => {
    const LOWER_ID = '800000000000000010';
    const HIGHER_ID = '800000000000000020';
    const stub = makeRestLayer([
      { id: HIGHER_ID, name: UNVERIFIED_ROLE_NAME },
      { id: LOWER_ID, name: UNVERIFIED_ROLE_NAME },
    ]);

    const messages: string[] = [];
    const levels: string[] = [];
    const loggerLayer = Logger.layer([
      Logger.make((options) => {
        messages.push(String(options.message));
        levels.push(String(options.logLevel));
      }),
    ]);

    const result = await Effect.runPromise(
      findUnverifiedRole(GUILD_ID as any).pipe(
        Effect.provide(Layer.merge(stub.layer, loggerLayer)),
      ) as unknown as Effect.Effect<Option.Option<string>, never, never>,
    );

    expect(Option.getOrNull(result)).toBe(LOWER_ID);
    expect(levels.some((l) => l.toLowerCase().includes('warn'))).toBe(true);
  });
});

describe('ensureUnverifiedRole — find-or-create', () => {
  it('role present → returns its id, no create', async () => {
    const EXISTING_ID = '800000000000000010';
    const stub = makeRestLayer([{ id: EXISTING_ID, name: UNVERIFIED_ROLE_NAME }]);

    const result = await run(ensureUnverifiedRole(GUILD_ID as any), stub.layer);

    expect(result).toBe(EXISTING_ID);
    expect(stub.createGuildRole).not.toHaveBeenCalled();
  });

  it('role absent → creates it with permissions: 0 (never Administrator)', async () => {
    const stub = makeRestLayer([]);

    await run(ensureUnverifiedRole(GUILD_ID as any), stub.layer);

    expect(stub.createGuildRole).toHaveBeenCalledTimes(1);
    const [, options] = stub.createGuildRole.mock.calls[0] as [
      string,
      { permissions: number; name: string },
    ];
    expect(options.permissions).toBe(0);
    expect(options.name).toBe(UNVERIFIED_ROLE_NAME);
  });
});
