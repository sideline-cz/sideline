// B6 rolling-deploy guard for the /event create modal submit
// (src/interactions/event-create.ts).
//
// `custom_id` carries the selected event type in `parts[1]`. A modal opened
// against the OLD bot (pre-event-types) carries a `kind` literal there
// (`event-create:training:<uuid>`); one opened against the CURRENT bot
// carries an event-type id instead (`event-create:<uuid>:<uuid>`). Both can
// arrive at this handler across a bot deploy, so neither is trusted blindly
// — anything that is neither a known kind literal nor a real uuid is
// rejected outright (ephemeral `bot_event_unknown_type`), never defaulted.
//
// Harness mirrors src/commands/event/create.test.ts's sibling,
// src/interactions/event-create.test.ts (stub DiscordREST + SyncRpc layers,
// run the bare effect, flush microtasks so the detached fork completes).

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
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

const EVENT_TYPE_ID = '11111111-2222-4333-8444-555555555555';
const TRAINING_TYPE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

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
// SyncRpc stub — Event/CreateEvent and Event/GetEventTypesByGuild behaviour
// injected per test
// ---------------------------------------------------------------------------

const makeRpcStub = (
  createEvent: ReturnType<typeof vi.fn>,
  getEventTypesByGuild: ReturnType<typeof vi.fn> = vi.fn(() => Effect.succeed([])),
) => {
  const rpcStub = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (prop === 'Event/CreateEvent') return createEvent;
      if (prop === 'Event/GetEventTypesByGuild') return getEventTypesByGuild;
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
  fields: Record<string, string> = {
    event_title: 'My Event',
    event_start: '2099-06-01 18:00',
  },
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

describe('event-create modal submit — B6 rolling-deploy guard', () => {
  it('legacy modal `event-create:training:<uuid>` → sends event_type: training, no event_type_id', async () => {
    const restStub = makeRestStub();
    const createEvent = vi.fn((_payload: unknown) =>
      Effect.succeed({ event_id: 'e1', title: 'My Event' }),
    );
    // Legacy branch never calls GetEventTypesByGuild — dies if reached, to catch a regression
    // that routes the legacy `kind` branch through the id-lookup path.
    const getEventTypesByGuild = vi.fn(() =>
      Effect.die('GetEventTypesByGuild must not be called for a legacy kind literal'),
    );
    const rpcLayer = makeRpcStub(createEvent, getEventTypesByGuild);
    const interaction = makeModalInteraction(`event-create:training:${TRAINING_TYPE_ID}`);

    await runHandler(restStub.layer, rpcLayer, interaction);

    expect(createEvent).toHaveBeenCalledTimes(1);
    const payload = createEvent.mock.calls[0]?.[0] as {
      event_type: string;
      event_type_id: Option.Option<string>;
    };
    expect(payload.event_type).toBe('training');
    expect(Option.isNone(payload.event_type_id)).toBe(true);
  });

  it('current modal `event-create:<uuid>:<uuid>` → sends BOTH event_type and event_type_id', async () => {
    const restStub = makeRestStub();
    const createEvent = vi.fn((_payload: unknown) =>
      Effect.succeed({ event_id: 'e1', title: 'My Event' }),
    );
    const getEventTypesByGuild = vi.fn(() =>
      Effect.succeed([{ id: EVENT_TYPE_ID, kind: 'training', name: Option.none() }]),
    );
    const rpcLayer = makeRpcStub(createEvent, getEventTypesByGuild);
    const interaction = makeModalInteraction(`event-create:${EVENT_TYPE_ID}:${TRAINING_TYPE_ID}`);

    await runHandler(restStub.layer, rpcLayer, interaction);

    expect(getEventTypesByGuild).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledTimes(1);
    const payload = createEvent.mock.calls[0]?.[0] as {
      event_type: string;
      event_type_id: Option.Option<string>;
    };
    expect(payload.event_type).toBe('training');
    expect(Option.isSome(payload.event_type_id)).toBe(true);
    expect(Option.getOrNull(payload.event_type_id)).toBe(EVENT_TYPE_ID);
  });

  it('garbage `event-create:garbage:` → ephemeral bot_event_unknown_type, no CreateEvent call at all', async () => {
    const restStub = makeRestStub();
    const createEvent = vi.fn(() => Effect.succeed({ event_id: 'e1', title: 'My Event' }));
    const getEventTypesByGuild = vi.fn(() => Effect.succeed([]));
    const rpcLayer = makeRpcStub(createEvent, getEventTypesByGuild);
    const interaction = makeModalInteraction('event-create:garbage:');

    const response = (await runHandler(restStub.layer, rpcLayer, interaction)) as { type: number };

    // Still returns the deferred response (no "This interaction failed").
    expect(response.type).toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(createEvent).not.toHaveBeenCalled();

    const locale = userLocale(interaction);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledWith(APP_ID, INTERACTION_TOKEN, {
      payload: { content: m.bot_event_unknown_type({}, { locale }) },
    });
  });

  it('a current-modal id that GetEventTypesByGuild does not recognize (archived/deleted mid-flight) → ephemeral unknown-type, no CreateEvent call', async () => {
    const restStub = makeRestStub();
    const createEvent = vi.fn(() => Effect.succeed({ event_id: 'e1', title: 'My Event' }));
    // The id in the custom_id is not among the team's current event types.
    const getEventTypesByGuild = vi.fn(() => Effect.succeed([]));
    const rpcLayer = makeRpcStub(createEvent, getEventTypesByGuild);
    const interaction = makeModalInteraction(`event-create:${EVENT_TYPE_ID}:${TRAINING_TYPE_ID}`);

    await runHandler(restStub.layer, rpcLayer, interaction);

    expect(createEvent).not.toHaveBeenCalled();
    const locale = userLocale(interaction);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledWith(APP_ID, INTERACTION_TOKEN, {
      payload: { content: m.bot_event_unknown_type({}, { locale }) },
    });
  });
});
