// Handler-level tests for the event-create modal submit.
//
// The handler defers an ephemeral reply and resolves it from an
// `Effect.forkDetach`'d fork via `updateOriginalWebhookMessage`. The regression
// these tests guard is the defect path: when `Event/CreateEvent` fails with an
// untagged defect (not a tagged error), the `catchCause` backstop must still
// update the original message so the user is never left on "Sideline is
// thinking…". Harness mirrors poll.test.ts (stub DiscordREST + SyncRpc layers,
// run the bare effect, flush microtasks so the detached fork completes).

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { EventCreateModalSubmit } from '~/interactions/event-create.js';
import { userLocale } from '~/locale.js';
import { SyncRpc } from '~/services/SyncRpc.js';

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target: Record<string, unknown>, prop: string) => {
      if (prop === 'NODE_ENV') return 'test';
      if (prop === 'SERVER_URL') return 'http://localhost:3000';
      if (prop === 'APP_ENV') return 'test';
      if (prop === 'APP_ORIGIN') return 'localhost';
      if (prop === 'OTEL_EXPORTER_OTLP_ENDPOINT') return 'http://localhost:4318';
      if (prop === 'OTEL_SERVICE_NAME') return 'sideline-bot';
      return undefined;
    },
  }),
}));

const APP_ID = '111111111111111111' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'interaction-token';
const GUILD_ID = '222222222222222222' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '333333333333333333';

// ---------------------------------------------------------------------------
// DiscordREST stub — captures updateOriginalWebhookMessage
// ---------------------------------------------------------------------------

const makeRestStub = (updateOriginalWebhookMessage = vi.fn(() => Effect.succeed(undefined))) => {
  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;
  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, updateOriginalWebhookMessage };
};

// ---------------------------------------------------------------------------
// SyncRpc stub — Event/CreateEvent behaviour is injected per test
// ---------------------------------------------------------------------------

const makeRpcStub = (createEvent: ReturnType<typeof vi.fn>) => {
  const rpcStub = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (prop === 'Event/CreateEvent') return createEvent;
      return vi.fn(() => Effect.succeed(undefined));
    },
  });
  return Layer.succeed(SyncRpc, rpcStub as unknown as InstanceType<typeof SyncRpc>);
};

// ---------------------------------------------------------------------------
// Modal interaction fixture
// ---------------------------------------------------------------------------

const makeModalInteraction = (
  customId: string,
  fields: Record<string, string>,
): DiscordTypes.APIInteraction =>
  ({
    id: '444444444444444444' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MODAL_SUBMIT,
    guild_id: GUILD_ID,
    member: {
      user: {
        id: USER_DISCORD_ID as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '8',
    },
    locale: 'en-US',
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// Runner — provides Interaction + ModalSubmitData + REST + RPC, flushes the fork
// ---------------------------------------------------------------------------

const runHandler = async (
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    EventCreateModalSubmit.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          ModalSubmitData,
          interaction.data as unknown as InstanceType<typeof ModalSubmitData>,
        ),
      ),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  // Allow the microtask/timer queue to flush so the forkDetach fork completes.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

const validFields = { event_title: 'My Event', event_start: '2099-06-01 18:00' };

describe('event-create modal submit', () => {
  it('immediately returns a deferred ephemeral response', async () => {
    const restStub = makeRestStub();
    const rpcLayer = makeRpcStub(
      vi.fn(() => Effect.succeed({ event_id: 'e1', title: 'My Event' })),
    );
    const interaction = makeModalInteraction('event-create:other', validFields);

    const response = (await runHandler(restStub.layer, rpcLayer, interaction)) as {
      type: number;
    };

    expect(response.type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
  });

  it('success → updates the original message with the created content (no error fallback)', async () => {
    const restStub = makeRestStub();
    const rpcLayer = makeRpcStub(
      vi.fn(() => Effect.succeed({ event_id: 'e1', title: 'My Event' })),
    );
    const interaction = makeModalInteraction('event-create:other', validFields);

    await runHandler(restStub.layer, rpcLayer, interaction);

    const locale = userLocale(interaction);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledWith(APP_ID, INTERACTION_TOKEN, {
      payload: { content: m.bot_event_created({ title: 'My Event' }, { locale }) },
    });
  });

  it('malformed event type in custom_id → decode defect is caught, deferred resolves with the error message', async () => {
    // `decodeEventType` throws on an unknown literal. Previously this ran
    // eagerly in the handler body (before the fork), killing the whole handler
    // with "This interaction failed". It now runs inside the forked effect, so
    // the throw becomes a defect the `catchCause` backstop resolves.
    const restStub = makeRestStub();
    const createEvent = vi.fn(() => Effect.succeed({ event_id: 'e1', title: 'My Event' }));
    const rpcLayer = makeRpcStub(createEvent);
    const interaction = makeModalInteraction('event-create:not-a-real-type', validFields);

    const response = (await runHandler(restStub.layer, rpcLayer, interaction)) as { type: number };

    // Still returns the deferred response (no "This interaction failed").
    expect(response.type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    // The RPC is never reached because the decode fails first.
    expect(createEvent).not.toHaveBeenCalled();

    const locale = userLocale(interaction);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledWith(APP_ID, INTERACTION_TOKEN, {
      payload: { content: m.bot_event_error({}, { locale }) },
    });
  });

  it('RPC dies with an untagged defect → backstop still resolves the deferred with the error message', async () => {
    const restStub = makeRestStub();
    const rpcLayer = makeRpcStub(
      vi.fn(() => Effect.die(new Error('server-side LogicError.die surfaced as a defect'))),
    );
    const interaction = makeModalInteraction('event-create:other', validFields);

    await runHandler(restStub.layer, rpcLayer, interaction);

    const locale = userLocale(interaction);
    // The fork must NOT die silently: the original message is updated with the
    // generic error content so the user is never stuck on "Sideline is thinking…".
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledWith(APP_ID, INTERACTION_TOKEN, {
      payload: { content: m.bot_event_error({}, { locale }) },
    });
  });
});
