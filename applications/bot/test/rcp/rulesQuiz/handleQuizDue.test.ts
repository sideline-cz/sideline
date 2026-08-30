/**
 * `handleQuizDue` — the scheduled quiz's Discord side.
 *
 * The centrepiece is the **spoiler flag**. The discussion thread exists to
 * argue about the ruling, which makes its contents a spoiler by construction:
 * without `IS_SPOILER_CHANNEL` the first reply that scrolls past hands the
 * answer to everyone still working the situation. That is a silent failure —
 * the thread looks completely normal, it just is not blurred — so nothing but
 * a test catches a regression in it.
 *
 * The bit itself is written by hand (dfx 1.0.11 exposes no `ChannelFlags`
 * enum), which is exactly the kind of constant that rots quietly. It is
 * asserted here as a literal rather than imported, so that changing the
 * source constant fails this test instead of silently agreeing with itself.
 */

import type { Discord, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';

/** `1 << 21`, per Discord's channel documentation. Deliberately a literal —
 * see the file header. */
const IS_SPOILER_CHANNEL = 2_097_152;

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const THREAD_ID = '222222222222222222' as Discord.Snowflake;
const MESSAGE_ID = '333333333333333333' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0009-000000000001' as Team.TeamId;

type RestCalls = {
  createMessage: unknown[];
  createThreadFromMessage: unknown[];
  updateChannel: unknown[];
};

/**
 * `threadFlags` is what Discord reports the freshly-created thread already
 * carries. It matters: the handler must OR onto it, never assign over it.
 */
const makeRest = (
  opts: {
    readonly threadFlags?: number;
    readonly failThread?: boolean;
    readonly failUpdateChannel?: boolean;
  } = {},
) => {
  const calls: RestCalls = { createMessage: [], createThreadFromMessage: [], updateChannel: [] };

  const handlers: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    getGuild: () => Effect.succeed({ preferred_locale: 'en' }),
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: MESSAGE_ID });
    },
    createThreadFromMessage: (...args: any[]) => {
      calls.createThreadFromMessage.push(args);
      return opts.failThread === true
        ? Effect.fail(new Error('missing CreatePublicThreads'))
        : Effect.succeed({ id: THREAD_ID, flags: opts.threadFlags ?? 0 });
    },
    updateChannel: (...args: any[]) => {
      calls.updateChannel.push(args);
      return opts.failUpdateChannel === true
        ? Effect.fail(new Error('missing ManageThreads'))
        : Effect.succeed({});
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        // `withFiles` is a combinator, not a request — it returns a function
        // wrapping an effect. Unreached here because `RULES_GIF_DIR` is unset
        // in tests, but a bare `() => Effect.void` would be the wrong shape if
        // that ever changed.
        if (prop === 'withFiles') return () => (effect: unknown) => effect;
        return handlers[prop] ?? (() => Effect.void);
      },
    }),
  );

  return { calls, layer };
};

const anEvent = (scenarioId: string) => ({
  id: 'evt-1',
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  channel_id: CHANNEL_ID,
  scenario_id: scenarioId,
});

/** A real scenario id — `handleQuizDue` fails hard on an unknown one. */
const someScenarioId = async (): Promise<string> => {
  const { ALL_SCENARIOS } = await import('~/rest/rules/pickScenario.js');
  const first = ALL_SCENARIOS[0];
  if (!first) throw new Error('content has no scenarios');
  return first.id;
};

const run = (effect: Effect.Effect<void, unknown, DiscordREST>, rest: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(Effect.provide(effect, rest) as Effect.Effect<void, never, never>);

describe('handleQuizDue — the discussion thread', () => {
  it('marks the created thread as a spoiler channel', async () => {
    const { handleQuizDue } = await import('~/rcp/rulesQuiz/handleQuizDue.js');
    const { calls, layer } = makeRest();

    await run(handleQuizDue(anEvent(await someScenarioId()) as any), layer);

    expect(calls.createThreadFromMessage).toHaveLength(1);
    expect(calls.updateChannel).toHaveLength(1);

    const [channelId, body] = calls.updateChannel[0] as [string, { flags: number }];
    expect(channelId).toBe(THREAD_ID);
    expect(body.flags & IS_SPOILER_CHANNEL).toBe(IS_SPOILER_CHANNEL);
  });

  it('ORs the flag onto the thread’s existing flags rather than replacing them', async () => {
    // A bare `flags: IS_SPOILER_CHANNEL` would clear every other bit Discord
    // had already set — the failure would be invisible until someone noticed
    // a thread had quietly lost an unrelated property.
    const { handleQuizDue } = await import('~/rcp/rulesQuiz/handleQuizDue.js');
    const existing = 1 << 1; // PINNED
    const { calls, layer } = makeRest({ threadFlags: existing });

    await run(handleQuizDue(anEvent(await someScenarioId()) as any), layer);

    const [, body] = calls.updateChannel[0] as [string, { flags: number }];
    expect(body.flags).toBe(existing | IS_SPOILER_CHANNEL);
    expect(body.flags & existing).toBe(existing);
  });

  it('still posts the situation when the thread cannot be marked', async () => {
    // Non-fatal by design: the event is marked processed either way, and
    // retrying would repost the situation — worse than an unblurred thread.
    const { handleQuizDue } = await import('~/rcp/rulesQuiz/handleQuizDue.js');
    const { calls, layer } = makeRest({ failUpdateChannel: true });

    await expect(
      run(handleQuizDue(anEvent(await someScenarioId()) as any), layer),
    ).resolves.toBeUndefined();
    expect(calls.createMessage).toHaveLength(1);
    expect(calls.updateChannel).toHaveLength(1);
  });

  it('does not try to mark a thread that was never created', async () => {
    const { handleQuizDue } = await import('~/rcp/rulesQuiz/handleQuizDue.js');
    const { calls, layer } = makeRest({ failThread: true });

    await expect(
      run(handleQuizDue(anEvent(await someScenarioId()) as any), layer),
    ).resolves.toBeUndefined();
    expect(calls.createMessage).toHaveLength(1);
    expect(calls.updateChannel).toHaveLength(0);
  });
});
