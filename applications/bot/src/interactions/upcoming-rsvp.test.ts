// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// Regression guard: locks the CURRENT hand-built MODAL JSON shape produced
// by UpcomingAddMessageButton, ahead of the dfx UI.* builder refactor. The
// payload shape must stay byte-for-byte identical once the production code
// is rewritten to use dfx builders.

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, MessageComponentData, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { UpcomingAddMessageButton, UpcomingRsvpModal } from '~/interactions/upcoming-rsvp.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '600000000000000011' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

const TEAM_ID = '00000000-0000-4000-8000-000000000010';
const EVENT_ID = '00000000-0000-4000-8000-000000000020';

const makeComponentInteraction = (customId: string): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: {
      id: CHANNEL_ID,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: USER_DISCORD_ID,
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
      component_type: 2,
      custom_id: customId,
    },
    message: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// The button now prefills the modal from `Event/GetRsvpMessage`; `storedMessage`
// stubs what the member currently has saved.
const makePrefillRpcLayer = (storedMessage: Effect.Effect<Option.Option<string>, unknown>) =>
  Layer.succeed(SyncRpc, {
    'Event/GetRsvpMessage': () => storedMessage,
  } as unknown as InstanceType<typeof SyncRpc>);

const runHandler = async (
  customId: string,
  storedMessage: Effect.Effect<Option.Option<string>, unknown> = Effect.succeed(Option.none()),
) => {
  const interaction = makeComponentInteraction(customId);
  // UpcomingAddMessageButton is the Ix.messageComponent(...) registration wrapper;
  // the handler Effect lives on its `.handle` property.
  return Effect.runPromise(
    UpcomingAddMessageButton.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          MessageComponentData,
          interaction.data as DiscordTypes.APIMessageComponentInteractionData,
        ),
      ),
      Effect.provide(makePrefillRpcLayer(storedMessage)),
    ) as Effect.Effect<unknown, never, never>,
  );
};

type TextInputComponent = {
  type: number;
  custom_id: string;
  label: string;
  style: number;
  required: boolean;
  max_length: number;
};

describe('UpcomingAddMessageButton modal shape', () => {
  it('returns a MODAL response with custom_id "u-modal:<teamId>:<eventId>:<response>"', async () => {
    const response = await runHandler(`u-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as { type: number; data: { custom_id: string } };

    expect(typed.type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    expect(typed.data.custom_id).toBe(`u-modal:${TEAM_ID}:${EVENT_ID}:yes`);
  });

  it('has exactly one action row with one PARAGRAPH-style text input, custom_id "rsvp_message"', async () => {
    const response = await runHandler(`u-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as {
      data: {
        components: ReadonlyArray<{ type: number; components: ReadonlyArray<TextInputComponent> }>;
      };
    };

    expect(typed.data.components).toHaveLength(1);
    const row = typed.data.components[0];
    expect(row?.type).toBe(1);
    expect(row?.components).toHaveLength(1);

    const input = row?.components[0];
    expect(input).toEqual({
      type: 4,
      custom_id: 'rsvp_message',
      label: 'Add a message (optional)',
      style: 2,
      required: false,
      max_length: 200,
    });
  });

  it('builds a required text input with the "reason (required)" label for coming_later', async () => {
    const response = await runHandler(`u-add-msg:${TEAM_ID}:${EVENT_ID}:coming_later`);
    const typed = response as {
      data: {
        components: ReadonlyArray<{ type: number; components: ReadonlyArray<TextInputComponent> }>;
      };
    };
    const input = typed.data.components[0]?.components[0];
    expect(input?.required).toBe(true);
    expect(input?.label).toBe('Add a reason (required)');
  });
  // ---------------------------------------------------------------------------
  // Prefill — the modal must show the member's existing note so "Edit message"
  // doesn't read as though the note was lost.
  // ---------------------------------------------------------------------------

  it("prefills the text input with the member's stored note", async () => {
    const response = await runHandler(
      `u-add-msg:${TEAM_ID}:${EVENT_ID}:yes`,
      Effect.succeed(Option.some('running 10 min late')),
    );
    const typed = response as {
      data: {
        components: ReadonlyArray<{
          components: ReadonlyArray<TextInputComponent & { value?: string }>;
        }>;
      };
    };
    expect(typed.data.components[0]?.components[0]?.value).toBe('running 10 min late');
  });

  it('omits `value` entirely when the member has no stored note', async () => {
    const response = await runHandler(`u-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as {
      data: { components: ReadonlyArray<{ components: ReadonlyArray<object> }> };
    };
    expect(typed.data.components[0]?.components[0]).not.toHaveProperty('value');
  });

  it('falls back to an empty modal when the prefill RPC fails', async () => {
    const response = await runHandler(
      `u-add-msg:${TEAM_ID}:${EVENT_ID}:yes`,
      Effect.fail({ _tag: 'RpcClientError' }),
    );
    const typed = response as {
      type: number;
      data: { components: ReadonlyArray<{ components: ReadonlyArray<object> }> };
    };
    expect(typed.type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    expect(typed.data.components[0]?.components[0]).not.toHaveProperty('value');
  });
});

// ---------------------------------------------------------------------------
// Regression: UpcomingRsvpModal must edit the member's PERSISTENT personal card
// with `Guild/GetAllUpcomingEventsForUser` (unpaginated), not the paginated
// `Event/GetUpcomingEventsForUser` — and must never blank the card's embed +
// buttons when the target event isn't found. See `renderUpcomingPagePayload`
// in upcoming-rsvp.ts and the harness in test/interactions/rsvp.test.ts
// (~line 255+), which this compact local stub is modeled on.
// ---------------------------------------------------------------------------

// A minimal upcoming-event entry — same shape used by
// test/rcp/event/handleReconcile.test.ts's `makeUpcomingEvent`.
const makeEntry = (eventId: string, title: string) => ({
  event_id: eventId,
  team_id: TEAM_ID,
  title,
  description: Option.none(),
  image_url: Option.none(),
  start_at: DateTime.makeUnsafe('2027-06-01T18:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  location_url: Option.none(),
  event_type: 'match',
  yes_count: 2,
  no_count: 0,
  maybe_count: 1,
  all_day: false,
  status: 'active',
  my_response: Option.some('coming_later' as const),
  my_response_actual: Option.some('coming_later' as const),
  my_message: Option.some('running late'),
  start_date: Option.none(),
  end_date: Option.none(),
});

// 15 entries; the target (EVENT_ID) sits at index 12, well past any 10-item page.
const ALL_15_ENTRIES = Array.from({ length: 15 }, (_, i) =>
  i === 12
    ? makeEntry(EVENT_ID, 'Target Event')
    : makeEntry(`00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, `Event ${i}`),
);
const FIRST_10_PAGINATED = ALL_15_ENTRIES.slice(0, 10); // excludes the target at index 12

const submitRsvpSuccess = () =>
  Effect.succeed({
    yesCount: 2,
    noCount: 0,
    maybeCount: 1,
    canRsvp: true,
    isLateRsvp: false,
    lateRsvpChannelId: Option.none(),
    message: Option.none(),
    userName: Option.some('Alice'),
    userNickname: Option.none(),
    userDisplayName: Option.none(),
    userUsername: Option.none(),
  });

const makeRestStub = () => {
  const updateOriginalWebhookMessage = vi.fn(() => Effect.succeed(undefined));
  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;
  return {
    layer: Layer.succeed(DiscordREST, rest),
    updateOriginalWebhookMessage,
  };
};

// `overrides` lets each test control `Guild/GetAllUpcomingEventsForUser` /
// `Event/GetUpcomingEventsForUser` independently — the whole point of these
// tests is to prove the handler reads the unpaginated RPC, so both must be
// stubbed to DIFFERENT results (see hater note in the architect's spec).
const makeRpcLayer = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>>,
) => {
  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/SubmitRsvp': submitRsvpSuccess,
    'Event/GetYesAttendeesForEmbed': () => Effect.succeed([]),
  };
  const rpc = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return overrides[prop] ?? defaults[prop] ?? (() => Effect.succeed(undefined));
    },
  });
  return Layer.succeed(SyncRpc, rpc as unknown as InstanceType<typeof SyncRpc>);
};

const makeModalInteraction = (
  customId: string,
  fields: Record<string, string>,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567892' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MODAL_SUBMIT,
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    member: {
      user: {
        id: USER_DISCORD_ID,
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

const runModalHandler = async (
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    UpcomingRsvpModal.handle.pipe(
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
  // Flush the Effect.forkDetach'd background work (same technique as
  // test/interactions/rsvp.test.ts's runModalHandler — the TestClock does
  // not drive a detached fork, so bare timers are required here).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

describe('UpcomingRsvpModal — reads the unpaginated upcoming-events RPC', () => {
  it('event at index 12 of 15 (past any 10-item page): patches the card with the real embed + 2 button rows', async () => {
    const restStub = makeRestStub();
    const rpcLayer = makeRpcLayer({
      'Guild/GetAllUpcomingEventsForUser': () =>
        Effect.succeed({ events: ALL_15_ENTRIES, total: 15, team_id: TEAM_ID }),
      // If the handler ever regresses to this paginated RPC, the target event
      // (index 12) is NOT in this page — the payload would fall back to the
      // "not found" content-only branch and this test fails with the actual
      // production symptom (a blanked/stubbed card), not an incidental crash.
      'Event/GetUpcomingEventsForUser': () =>
        Effect.succeed({ events: FIRST_10_PAGINATED, total: 15, team_id: TEAM_ID }),
    });
    const interaction = makeModalInteraction(`u-modal:${TEAM_ID}:${EVENT_ID}:coming_later`, {
      rsvp_message: 'running a bit late',
    });

    await runModalHandler(restStub.layer, rpcLayer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { embeds?: unknown[]; components?: unknown[] } },
    ];
    const { payload } = call[2];
    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds?.[0] as { title: string } | undefined;
    expect(embed?.title).toBe('Target Event');
    expect(payload.components).toHaveLength(2);
  });

  it('event genuinely absent from the unpaginated result: content-only PATCH — no embeds/components keys at all', async () => {
    const restStub = makeRestStub();
    const rpcLayer = makeRpcLayer({
      // Target event is absent even from the unpaginated result (e.g. cancelled,
      // or the member left the group) — the not-found branch must fire.
      'Guild/GetAllUpcomingEventsForUser': () =>
        Effect.succeed({
          events: [makeEntry('00000000-0000-4000-8000-000000009999', 'Other')],
          total: 1,
          team_id: TEAM_ID,
        }),
      'Event/GetUpcomingEventsForUser': () =>
        Effect.succeed({ events: [], total: 0, team_id: TEAM_ID }),
    });
    const interaction = makeModalInteraction(`u-modal:${TEAM_ID}:${EVENT_ID}:coming_later`, {
      rsvp_message: 'running a bit late',
    });

    await runModalHandler(restStub.layer, rpcLayer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: Record<string, unknown> },
    ];
    const { payload } = call[2];
    // The destructive-blank regression: the old code sent `embeds: []` /
    // `components: []` here, which PATCHes those fields to empty and destroys
    // the persistent card. The fix omits the keys entirely so Discord's PATCH
    // semantics (absent field = untouched) leave the live card alone.
    expect('embeds' in payload).toBe(false);
    expect('components' in payload).toBe(false);
    expect(payload.content).toBe(m.bot_rsvp_event_not_found({}, { locale: 'en' }));
  });
});
