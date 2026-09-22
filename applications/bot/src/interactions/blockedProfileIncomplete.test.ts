// TDD mode — written BEFORE the four `*ProfileIncomplete` catch arms exist.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// Spec: .work-plans/discord-full-onboarding.md, Task 8 ("offer the Verify
// button when an action is blocked") and its "Test specification" §Task 8.
// One file covering all four interaction files (nine call sites total, one
// call site per file exercised here since the plan says the other sites share
// the arm shape): `rsvp.ts` (RsvpButton), `upcoming-rsvp.ts`
// (UpcomingRsvpButton), `claim.ts` (ClaimButton), `carpool.ts`
// (CarpoolReserveButton, CarpoolAddModal).
//
// Every RPC write in this file fails with its `*ProfileIncomplete` tag; the
// bot must render `bot_verify_blocked_*` with the verify button INLINE in the
// same ephemeral follow-up, never issue a second write, and never re-render
// (upcoming-rsvp's `Guild/GetAllUpcomingEventsForUser` follow-up must not fire).

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, MessageComponentData, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { CarpoolAddModal, CarpoolReserveButton } from '~/interactions/carpool.js';
import { ClaimButton } from '~/interactions/claim.js';
import { RsvpButton } from '~/interactions/rsvp.js';
import { UpcomingRsvpButton } from '~/interactions/upcoming-rsvp.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const TOKEN = 'blocked-interaction-token';

const TEAM_ID = '00000000-0000-4000-8000-000000000010';
const EVENT_ID = '00000000-0000-4000-8000-000000000020';
const CAR_ID = 'car-1';

// ---------------------------------------------------------------------------
// Shared interaction / stub builders
// ---------------------------------------------------------------------------

const makeComponentInteraction = (
  customId: string,
  locale = 'en-US',
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
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
    locale,
    data: { component_type: 2, custom_id: customId },
  }) as unknown as DiscordTypes.APIInteraction;

const makeModalInteraction = (
  customId: string,
  fields: Record<string, string>,
  locale = 'en-US',
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567891' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: TOKEN,
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
    locale,
    data: {
      custom_id: customId,
      components: Object.entries(fields).map(([custom_id, value]) => ({
        type: 1,
        components: [{ type: 4, custom_id, value }],
      })),
    },
  }) as unknown as DiscordTypes.APIInteraction;

const makeRestStub = () => {
  const updateOriginalWebhookMessage = vi.fn(() => Effect.succeed(undefined));
  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;
  return { layer: Layer.succeed(DiscordREST, rest), updateOriginalWebhookMessage };
};

const makeRpcLayer = (
  overrides: Record<string, ReturnType<typeof vi.fn>>,
): Layer.Layer<SyncRpc> => {
  const rpc = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      return overrides[prop] ?? vi.fn(() => Effect.succeed(undefined));
    },
  });
  return Layer.succeed(SyncRpc, rpc as unknown as InstanceType<typeof SyncRpc>);
};

const runComponentHandler = async (
  component: { handle: Effect.Effect<unknown, unknown, unknown> },
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    component.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          MessageComponentData,
          interaction.data as DiscordTypes.APIMessageComponentInteractionData,
        ),
      ),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

const runModalHandler = async (
  component: { handle: Effect.Effect<unknown, unknown, unknown> },
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    component.handle.pipe(
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

/** Carpool's two handlers (`CarpoolReserveButton`/`CarpoolAddModal`) are raw
 * Effects, not `Ix.messageComponent(...)` wrappers — no `.handle` indirection,
 * and no `MessageComponentData` layer (carpool.ts reads custom_id off the raw
 * interaction via its own `getComponentData` helper). */
const runCarpoolEffect = async (
  effect: Effect.Effect<unknown, unknown, unknown>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

const findButtonRow = (components: unknown): ReadonlyArray<{ custom_id: string }> => {
  const rows = (components ?? []) as ReadonlyArray<{
    components: ReadonlyArray<{ custom_id: string }>;
  }>;
  return rows.flatMap((row) => row.components);
};

const assertNoDuplicateCustomIds = (components: unknown) => {
  const ids = findButtonRow(components).map((c) => c.custom_id);
  expect(new Set(ids).size).toBe(ids.length);
};

// ---------------------------------------------------------------------------
// 1. rsvp.ts — RsvpButton
// ---------------------------------------------------------------------------

describe('rsvp.ts — RsvpButton blocked by RsvpProfileIncomplete', () => {
  it('button → blocked reply carries the verify button, en locale', async () => {
    const submitRsvp = vi.fn(() => Effect.fail({ _tag: 'RsvpProfileIncomplete' }));
    const rpcLayer = makeRpcLayer({ 'Event/SubmitRsvp': submitRsvp });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsvp:${TEAM_ID}:${EVENT_ID}:yes`);

    await runComponentHandler(RsvpButton, restStub.layer, rpcLayer, interaction);

    expect(submitRsvp).toHaveBeenCalledTimes(1);
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string; components?: unknown } },
    ];
    const { payload } = call[2];
    expect(payload.content).toBe(
      m.bot_verify_blocked_rsvp({ response: m.rsvp_yes({}, { locale: 'en' }) }, { locale: 'en' }),
    );
    const buttons = findButtonRow(payload.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));
    assertNoDuplicateCustomIds(payload.components);
  });

  it('cs locale renders the Czech string', async () => {
    const submitRsvp = vi.fn(() => Effect.fail({ _tag: 'RsvpProfileIncomplete' }));
    const rpcLayer = makeRpcLayer({ 'Event/SubmitRsvp': submitRsvp });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`rsvp:${TEAM_ID}:${EVENT_ID}:yes`, 'cs-CZ');

    await runComponentHandler(RsvpButton, restStub.layer, rpcLayer, interaction);

    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string } },
    ];
    expect(call[2].payload.content).toBe(
      m.bot_verify_blocked_rsvp({ response: m.rsvp_yes({}, { locale: 'cs' }) }, { locale: 'cs' }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. upcoming-rsvp.ts — UpcomingRsvpButton
// ---------------------------------------------------------------------------

describe('upcoming-rsvp.ts — UpcomingRsvpButton blocked by RsvpProfileIncomplete', () => {
  it('blocked reply carries the verify button; no write side-effect, no re-render', async () => {
    const submitRsvp = vi.fn(() => Effect.fail({ _tag: 'RsvpProfileIncomplete' }));
    const getAllUpcoming = vi.fn(() => Effect.succeed({ events: [], total: 0, team_id: TEAM_ID }));
    const rpcLayer = makeRpcLayer({
      'Event/SubmitRsvp': submitRsvp,
      'Guild/GetAllUpcomingEventsForUser': getAllUpcoming,
    });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`upcoming-rsvp:${EVENT_ID}:${TEAM_ID}:yes`);

    await runComponentHandler(UpcomingRsvpButton, restStub.layer, rpcLayer, interaction);

    // Item 6: the RPC write fired exactly once, and no follow-up re-render of
    // the upcoming-events list happened — the personal card must be left alone.
    expect(submitRsvp).toHaveBeenCalledTimes(1);
    expect(getAllUpcoming).not.toHaveBeenCalled();

    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string; components?: unknown } },
    ];
    const { payload } = call[2];
    expect(payload.content).toBe(
      m.bot_verify_blocked_rsvp({ response: m.rsvp_yes({}, { locale: 'en' }) }, { locale: 'en' }),
    );
    const buttons = findButtonRow(payload.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));
  });
});

// ---------------------------------------------------------------------------
// 3. claim.ts — ClaimButton
// ---------------------------------------------------------------------------

describe('claim.ts — ClaimButton blocked by ClaimProfileIncomplete', () => {
  it('bot_verify_blocked_claim + the verify button, no {response} placeholder needed', async () => {
    const claimTraining = vi.fn(() => Effect.fail({ _tag: 'ClaimProfileIncomplete' }));
    const rpcLayer = makeRpcLayer({ 'Event/ClaimTraining': claimTraining });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`claim:${TEAM_ID}:${EVENT_ID}`);

    await runComponentHandler(ClaimButton, restStub.layer, rpcLayer, interaction);

    expect(claimTraining).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string; components?: unknown } },
    ];
    const { payload } = call[2];
    expect(payload.content).toBe(m.bot_verify_blocked_claim({}, { locale: 'en' }));
    const buttons = findButtonRow(payload.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));
  });
});

// ---------------------------------------------------------------------------
// 4. carpool.ts — CarpoolReserveButton (ReserveSeat) and CarpoolAddModal (AddCar)
// ---------------------------------------------------------------------------

describe('carpool.ts — CarpoolReserveButton blocked by CarpoolProfileIncomplete', () => {
  it('bot_verify_blocked_carpool + the verify button', async () => {
    const reserveSeat = vi.fn(() => Effect.fail({ _tag: 'CarpoolProfileIncomplete' }));
    const rpcLayer = makeRpcLayer({ 'Carpool/ReserveSeat': reserveSeat });
    const restStub = makeRestStub();
    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);

    await runCarpoolEffect(CarpoolReserveButton, restStub.layer, rpcLayer, interaction);

    expect(reserveSeat).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string; components?: unknown } },
    ];
    const { payload } = call[2];
    expect(payload.content).toBe(m.bot_verify_blocked_carpool({}, { locale: 'en' }));
    const buttons = findButtonRow(payload.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));
  });
});

describe('carpool.ts — CarpoolAddModal blocked by CarpoolProfileIncomplete', () => {
  it('bot_verify_blocked_carpool + the verify button (AddCar site)', async () => {
    const addCar = vi.fn(() => Effect.fail({ _tag: 'CarpoolProfileIncomplete' }));
    const rpcLayer = makeRpcLayer({ 'Carpool/AddCar': addCar });
    const restStub = makeRestStub();
    const interaction = makeModalInteraction(
      `carpool-add-modal:${CHANNEL_ID}:${CHANNEL_ID}:carpool-1`,
      { carpool_capacity: '4' },
    );

    await runModalHandler(CarpoolAddModal, restStub.layer, rpcLayer, interaction);

    expect(addCar).toHaveBeenCalledTimes(1);
    const call = restStub.updateOriginalWebhookMessage.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { payload: { content: string; components?: unknown } },
    ];
    const { payload } = call[2];
    expect(payload.content).toBe(m.bot_verify_blocked_carpool({}, { locale: 'en' }));
    const buttons = findButtonRow(payload.components);
    expect(buttons).toContainEqual(expect.objectContaining({ custom_id: 'profile-verify' }));
  });
});

// ---------------------------------------------------------------------------
// R2 pin: no resume is ever promised. A literal assert on the raw message
// string, independent of any interaction plumbing — pins the copy against a
// future re-add of the deleted `pvr:` resume machinery.
// ---------------------------------------------------------------------------

describe('bot_verify_blocked_* — no resume is promised (R2)', () => {
  it('bot_verify_blocked_rsvp tells the member to come back and tap it again, not that we saved it', () => {
    const cs = m.bot_verify_blocked_rsvp({ response: 'Ano' }, { locale: 'cs' });
    expect(cs).toContain('Ano');
    expect(cs.toLowerCase()).not.toContain('uložím');
    expect(cs.toLowerCase()).not.toContain('uložíme');
  });

  it('bot_verify_blocked_claim and bot_verify_blocked_carpool take no {response} placeholder', () => {
    const claim = m.bot_verify_blocked_claim({}, { locale: 'en' });
    const carpool = m.bot_verify_blocked_carpool({}, { locale: 'en' });
    expect(claim).not.toContain('{response}');
    expect(carpool).not.toContain('{response}');
  });
});
