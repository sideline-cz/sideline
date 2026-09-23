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

import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  buildIntroEmbed,
  ensureVerificationChannel,
} from '~/rest/channels/ensureVerificationChannel.js';
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
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en', Option.none()),
      stub.layer,
    );

    expect(Option.getOrNull(result)).toBe(EXISTING_CHANNEL_ID);
    expect(stub.calls.createGuildChannel).not.toHaveBeenCalled();
    expect(stub.calls.createMessage).not.toHaveBeenCalled();
    expect(stub.calls.createPin).not.toHaveBeenCalled();
  });

  it('does NOT reconcile the existing pinned message — no listPins/updateMessage/createMessage at all', async () => {
    // Deviation #4 in the plan: the update path lives in the onboarding sync loop
    // (ProcessorService.reconcileVerifyIntro), never here. Guard against a future
    // regression that wires a reconcile into this early return.
    const EXISTING_CHANNEL_ID = '900000000000000010';
    const listPins = vi.fn(() => Effect.succeed({ items: [], has_more: false }));
    const updateMessage = vi.fn(() => Effect.succeed({ id: 'msg' }));
    const stub = makeRestLayer({
      listGuildChannels: vi.fn(() =>
        Effect.succeed([{ id: EXISTING_CHANNEL_ID, name: EN_CHANNEL_NAME, type: 0 }]),
      ),
    });
    // Extend the proxy with the two methods the plan explicitly forbids calling here.
    const rest = new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (prop === 'listGuildChannels') return stub.calls.listGuildChannels;
        if (prop === 'createGuildChannel') return stub.calls.createGuildChannel;
        if (prop === 'createMessage') return stub.calls.createMessage;
        if (prop === 'createPin') return stub.calls.createPin;
        if (prop === 'listPins') return listPins;
        if (prop === 'updateMessage') return updateMessage;
        return () => Effect.succeed(undefined);
      },
    });
    const layer = Layer.succeed(DiscordREST, rest);

    await run(
      ensureVerificationChannel(
        GUILD_ID as any,
        UNVERIFIED_ROLE_ID as any,
        'en',
        Option.some('Custom body.'),
      ),
      layer,
    );

    expect(listPins).not.toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
    expect(stub.calls.createMessage).not.toHaveBeenCalled();
  });
});

describe('ensureVerificationChannel — channel absent, creates it', () => {
  it('creates with exactly two permission overwrites (@everyone deny ViewChannel; role CHANNEL_ACCESS_VIEW)', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en', Option.none()),
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
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en', Option.none()),
      stub.layer,
    );

    expect(stub.calls.createMessage).toHaveBeenCalledTimes(1);
    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      {
        embeds?: ReadonlyArray<{
          title?: string;
          description?: string;
          fields?: ReadonlyArray<{ name: string; value: string }>;
        }>;
        components?: ReadonlyArray<{ components: ReadonlyArray<{ custom_id: string }> }>;
      },
    ];
    expect(body.embeds).toHaveLength(1);
    const buttons = (body.components ?? []).flatMap((row) => row.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));

    expect(stub.calls.createPin).toHaveBeenCalledTimes(1);
  });

  it('no template → description uses the built-in m.bot_verify_intro_description copy', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en', Option.none()),
      stub.layer,
    );

    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      { embeds: ReadonlyArray<{ title: string; description: string }> },
    ];
    expect(body.embeds[0].description).toBe(m.bot_verify_intro_description({}, { locale: 'en' }));
    expect(body.embeds[0].title).toBe(m.bot_verify_intro_title({}, { locale: 'en' }));
  });

  it('Option.some(custom template) → description uses it; title and both fields stay hardcoded', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(
        GUILD_ID as any,
        UNVERIFIED_ROLE_ID as any,
        'en',
        Option.some('Custom body.'),
      ),
      stub.layer,
    );

    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      {
        embeds: ReadonlyArray<{
          title: string;
          description: string;
          fields: ReadonlyArray<{ name: string; value: string }>;
        }>;
      },
    ];
    expect(body.embeds[0].description).toBe('Custom body.');
    expect(body.embeds[0].title).toBe(m.bot_verify_intro_title({}, { locale: 'en' }));
    expect(body.embeds[0].fields).toHaveLength(2);
    expect(body.embeds[0].fields[0].name).toBe(
      m.bot_verify_intro_unlocks_name({}, { locale: 'en' }),
    );
    expect(body.embeds[0].fields[1].name).toBe(m.bot_verify_intro_why_name({}, { locale: 'en' }));
  });

  it('whitespace-only template → falls back to the built-in copy', async () => {
    const stub = makeRestLayer();

    await run(
      ensureVerificationChannel(
        GUILD_ID as any,
        UNVERIFIED_ROLE_ID as any,
        'en',
        Option.some('   \n\t  '),
      ),
      stub.layer,
    );

    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      { embeds: ReadonlyArray<{ description: string }> },
    ];
    expect(body.embeds[0].description).toBe(m.bot_verify_intro_description({}, { locale: 'en' }));
  });

  it("locale 'cs' → uses the cs description when no template is set", async () => {
    const stub = makeRestLayer({
      createGuildChannel: vi.fn(() =>
        Effect.succeed({ id: '900000000000000099', name: 'nez-zacnes', type: 0 }),
      ),
    });

    await run(
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'cs', Option.none()),
      stub.layer,
    );

    const [, body] = stub.calls.createMessage.mock.calls[0] as [
      string,
      { embeds: ReadonlyArray<{ title: string; description: string }> },
    ];
    expect(body.embeds[0].description).toBe(m.bot_verify_intro_description({}, { locale: 'cs' }));
    expect(body.embeds[0].title).toBe(m.bot_verify_intro_title({}, { locale: 'cs' }));
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
      ensureVerificationChannel(GUILD_ID as any, UNVERIFIED_ROLE_ID as any, 'en', Option.none()),
      stub.layer,
    );

    expect(Option.isNone(result)).toBe(true);
  });
});

describe('buildIntroEmbed', () => {
  it('Option.none() → description falls back to the built-in copy', () => {
    const embed = buildIntroEmbed('en', Option.none());
    expect(embed.description).toBe(m.bot_verify_intro_description({}, { locale: 'en' }));
  });

  it('blank string → falls back to the built-in copy, same as Option.none()', () => {
    const embed = buildIntroEmbed('en', Option.some('   '));
    expect(embed.description).toBe(m.bot_verify_intro_description({}, { locale: 'en' }));
  });

  it('non-blank template → used verbatim as description', () => {
    const embed = buildIntroEmbed('en', Option.some('  Custom body.  '));
    expect(embed.description).toBe('  Custom body.  ');
  });
});
