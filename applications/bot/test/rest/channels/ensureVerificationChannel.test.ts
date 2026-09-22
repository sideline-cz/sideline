/**
 * TDD tests for `~/rest/channels/ensureVerificationChannel.ts` (Task 10) — the
 * one bot-owned, permanent, read-only "start-here"/"nez-zacnes" channel.
 *
 * `listGuildChannels` → find by name → else `createGuildChannel` with
 * `topic: bot_verify_channel_topic` and exactly two permission overwrites
 * (`@everyone` → deny `ViewChannel`; the unverified role → allow/deny
 * `CHANNEL_ACCESS_VIEW`) using the constants that already exist at
 * `~/rest/permissions.js` / `~/rest/utils.js` — Task 10 adds neither. On
 * create only, posts one intro embed carrying the verify button and pins it.
 * A permanent Discord error (missing `MANAGE_CHANNELS`) logs a warning and
 * returns `None` — it must NEVER fail the join.
 *
 * Spec: .work-plans/discord-full-onboarding.md, Task 10, "Test specification"
 * §Task 10 ("channel present → returns id, no create and no second pinned
 * post; absent → creates with exactly two overwrites …, posts one message
 * with the button and pins it; permanent Discord error → logs and returns
 * None, never throws").
 */

import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ensureVerificationChannel } from '~/rest/channels/ensureVerificationChannel.js';
import { CHANNEL_ACCESS_VIEW, HIDDEN } from '~/rest/permissions.js';
import { allow, deny } from '~/rest/utils.js';

const GUILD_ID = '900000000000000001';
const UNVERIFIED_ROLE_ID = '900000000000000002';

// The design spec's authoritative en channel name — hardcoded here rather than
// read off `m.bot_verify_channel_name` so this fixture does not depend on the
// i18n keys Task 10 itself introduces.
const EN_CHANNEL_NAME = 'start-here';

type Overrides = {
  listGuildChannels?: ReturnType<typeof vi.fn>;
  createGuildChannel?: ReturnType<typeof vi.fn>;
  createMessage?: ReturnType<typeof vi.fn>;
  createPin?: ReturnType<typeof vi.fn>;
};

const makeRestLayer = (overrides: Overrides = {}) => {
  const listGuildChannels = overrides.listGuildChannels ?? vi.fn(() => Effect.succeed([]));
  const createGuildChannel =
    overrides.createGuildChannel ??
    vi.fn(() => Effect.succeed({ id: '900000000000000099', name: EN_CHANNEL_NAME, type: 0 }));
  const createMessage =
    overrides.createMessage ?? vi.fn(() => Effect.succeed({ id: '900000000000000199' }));
  const createPin = overrides.createPin ?? vi.fn(() => Effect.succeed(undefined));

  const calls = { listGuildChannels, createGuildChannel, createMessage, createPin };

  const rest = new Proxy({} as any, {
    get: (_target: unknown, prop: string) => {
      if (prop === 'listGuildChannels') return listGuildChannels;
      if (prop === 'createGuildChannel') return createGuildChannel;
      if (prop === 'createMessage') return createMessage;
      if (prop === 'createPin') return createPin;
      return () => Effect.succeed(undefined);
    },
  });
  return { layer: Layer.succeed(DiscordREST, rest), calls };
};

const run = <A>(effect: Effect.Effect<A, unknown, DiscordREST>, layer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer)) as unknown as Effect.Effect<A, never, never>,
  );

describe('ensureVerificationChannel — channel already exists', () => {
  it('returns its id, does NOT create a channel, and does NOT post a second pinned message', async () => {
    const EXISTING_CHANNEL_ID = '900000000000000010';
    const stub = makeRestLayer({
      listGuildChannels: vi.fn(() =>
        Effect.succeed([{ id: EXISTING_CHANNEL_ID, name: EN_CHANNEL_NAME, type: 0 }]),
      ),
    });

    const result = await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en'),
      stub.layer,
    );

    expect(Option.getOrNull(result)).toBe(EXISTING_CHANNEL_ID);
    expect(stub.calls.createGuildChannel).not.toHaveBeenCalled();
    expect(stub.calls.createMessage).not.toHaveBeenCalled();
    expect(stub.calls.createPin).not.toHaveBeenCalled();
  });
});

describe('ensureVerificationChannel — channel absent, creates it', () => {
  it('creates with exactly two permission overwrites (@everyone deny ViewChannel; role CHANNEL_ACCESS_VIEW)', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en'),
      stub.layer,
    );

    expect(stub.calls.createGuildChannel).toHaveBeenCalledTimes(1);
    const [, options] = stub.calls.createGuildChannel.mock.calls[0] as [
      string,
      { permission_overwrites: ReadonlyArray<{ id: string; allow?: number; deny?: number }> },
    ];
    expect(options.permission_overwrites).toHaveLength(2);

    const everyoneOverwrite = options.permission_overwrites.find((o) => o.id === GUILD_ID);
    const roleOverwrite = options.permission_overwrites.find((o) => o.id === UNVERIFIED_ROLE_ID);

    expect(everyoneOverwrite).toBeDefined();
    expect(Number(everyoneOverwrite?.deny)).toBe(deny(HIDDEN));

    expect(roleOverwrite).toBeDefined();
    expect(Number(roleOverwrite?.allow)).toBe(allow(CHANNEL_ACCESS_VIEW));
    expect(Number(roleOverwrite?.deny)).toBe(deny(CHANNEL_ACCESS_VIEW));
  });

  it('posts exactly one intro embed carrying the verify button, and pins it', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en'),
      stub.layer,
    );

    expect(stub.calls.createMessage).toHaveBeenCalledTimes(1);
    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      {
        embeds?: unknown[];
        components?: ReadonlyArray<{ components: ReadonlyArray<{ custom_id: string }> }>;
      },
    ];
    expect(body.embeds).toHaveLength(1);
    const buttons = (body.components ?? []).flatMap((row) => row.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));

    expect(stub.calls.createPin).toHaveBeenCalledTimes(1);
  });
});

describe('ensureVerificationChannel — permanent Discord error', () => {
  it('missing MANAGE_CHANNELS → logs a warning and returns None, never throws', async () => {
    const permanentError = {
      _tag: 'ErrorResponse',
      response: { status: 403 },
      data: { code: 50013 },
    };
    const stub = makeRestLayer({
      createGuildChannel: vi.fn(() => Effect.fail(permanentError)),
    });

    const result = await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en'),
      stub.layer,
    );

    expect(Option.isNone(result)).toBe(true);
  });
});
