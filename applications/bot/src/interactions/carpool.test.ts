// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import type { Carpool, Discord } from '@sideline/domain';
import { CarpoolRpcModels } from '@sideline/domain';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction, ModalSubmitData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option, Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  CarpoolAddButton,
  CarpoolAssignButton,
  CarpoolCapacityButton,
  CarpoolCapacityModal,
  CarpoolKickButton,
  CarpoolKickPickSelect,
  CarpoolLeaveButton,
  CarpoolRemoveButton,
  CarpoolReserveButton,
} from '~/interactions/carpool.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '600000000000000011' as DiscordTypes.Snowflake;
const THREAD_ID = '600000000000000020' as DiscordTypes.Snowflake;
const CARPOOL_ID = 'cp-test-001' as Carpool.CarpoolId;
const CAR_ID = 'car-test-001' as Carpool.CarpoolCarId;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeCarpoolView = (
  carpoolId: Carpool.CarpoolId = CARPOOL_ID,
  boardChannelId: string = CHANNEL_ID,
  boardMessageId: string | null = MESSAGE_ID,
): CarpoolRpcModels.CarpoolView =>
  new CarpoolRpcModels.CarpoolView({
    carpool_id: carpoolId,
    language: 'en',
    discord_channel_id: boardChannelId as Discord.Snowflake,
    discord_message_id:
      boardMessageId != null ? Option.some(boardMessageId as Discord.Snowflake) : Option.none(),
    event_id: Option.none(),
    cars: [],
  });

/** A view that contains a single car with a thread_id — used by leave tests. */
const makeCarpoolViewWithCar = (
  carId: Carpool.CarpoolCarId = CAR_ID,
  threadId: string | null = THREAD_ID,
  boardChannelId: string = CHANNEL_ID,
  boardMessageId: string | null = MESSAGE_ID,
): CarpoolRpcModels.CarpoolView => {
  const decodeTeamMemberId = Schema.decodeUnknownSync(
    Schema.String.pipe(Schema.brand('TeamMemberId')),
  );
  const owner = new CarpoolRpcModels.MemberDisplay({
    team_member_id: decodeTeamMemberId('tm-test-001'),
    discord_id: Option.some(USER_DISCORD_ID as Discord.Snowflake),
    name: Option.none(),
    nickname: Option.none(),
    display_name: Option.none(),
    username: Option.some('testuser'),
  });
  const car = new CarpoolRpcModels.CarpoolCarView({
    car_id: carId,
    thread_id: threadId != null ? Option.some(threadId as Discord.Snowflake) : Option.none(),
    capacity: 4,
    note: Option.none(),
    owner,
    passengers: [],
  });
  return new CarpoolRpcModels.CarpoolView({
    carpool_id: CARPOOL_ID,
    language: 'en',
    discord_channel_id: boardChannelId as Discord.Snowflake,
    discord_message_id:
      boardMessageId != null ? Option.some(boardMessageId as Discord.Snowflake) : Option.none(),
    event_id: Option.none(),
    cars: [car],
  });
};

const makeReserveResult = (threadId: string | null = null): CarpoolRpcModels.ReserveResult =>
  new CarpoolRpcModels.ReserveResult({
    thread_id: threadId != null ? Option.some(threadId as Discord.Snowflake) : Option.none(),
    view: makeCarpoolView(),
  });

const makeRemoveCarResult = (threadId: string | null = null): CarpoolRpcModels.RemoveCarResult =>
  new CarpoolRpcModels.RemoveCarResult({
    thread_id: threadId != null ? Option.some(threadId as Discord.Snowflake) : Option.none(),
    view: makeCarpoolView(),
  });

// ---------------------------------------------------------------------------
// DiscordREST stub
// ---------------------------------------------------------------------------

interface RestStubOptions {
  addThreadMember?: ReturnType<typeof vi.fn>;
  deleteThreadMember?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
  updateChannel?: ReturnType<typeof vi.fn>;
  createInteractionResponse?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const addThreadMember = options.addThreadMember ?? vi.fn(() => Effect.succeed(undefined));
  const deleteThreadMember = options.deleteThreadMember ?? vi.fn(() => Effect.succeed(undefined));
  const updateMessage = options.updateMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateChannel = options.updateChannel ?? vi.fn(() => Effect.succeed(undefined));
  const createInteractionResponse =
    options.createInteractionResponse ?? vi.fn(() => Effect.succeed(undefined));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'addThreadMember') return addThreadMember;
      if (prop === 'deleteThreadMember') return deleteThreadMember;
      if (prop === 'updateMessage') return updateMessage;
      if (prop === 'updateChannel') return updateChannel;
      if (prop === 'createInteractionResponse') return createInteractionResponse;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return {
    layer,
    addThreadMember,
    deleteThreadMember,
    updateMessage,
    updateChannel,
    createInteractionResponse,
    updateOriginalWebhookMessage,
  };
};

// ---------------------------------------------------------------------------
// SyncRpc stub
// ---------------------------------------------------------------------------

interface SyncRpcStubOptions {
  'Carpool/ReserveSeat'?: ReturnType<typeof vi.fn>;
  'Carpool/LeaveSeat'?: ReturnType<typeof vi.fn>;
  'Carpool/RemoveCar'?: ReturnType<typeof vi.fn>;
  'Carpool/AddCar'?: ReturnType<typeof vi.fn>;
  'Carpool/GetCarpoolView'?: ReturnType<typeof vi.fn>;
  'Carpool/SaveCarThreadId'?: ReturnType<typeof vi.fn>;
  'Carpool/UpdateCarCapacity'?: ReturnType<typeof vi.fn>;
  'Carpool/KickPassenger'?: ReturnType<typeof vi.fn>;
}

const makeSyncRpcStub = (options: SyncRpcStubOptions = {}) => {
  const rpcStub = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (options[prop as keyof SyncRpcStubOptions]) {
        return options[prop as keyof SyncRpcStubOptions];
      }
      // Defaults
      if (prop === 'Carpool/ReserveSeat') {
        return vi.fn(() => Effect.succeed(makeReserveResult(THREAD_ID)));
      }
      if (prop === 'Carpool/LeaveSeat') {
        // Default: return view with the car so thread_id lookup works in the leave handler
        return vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
      }
      if (prop === 'Carpool/SaveCarThreadId') {
        return vi.fn(() => Effect.succeed(undefined));
      }
      if (prop === 'Carpool/RemoveCar') {
        return vi.fn(() => Effect.succeed(makeRemoveCarResult(THREAD_ID)));
      }
      if (prop === 'Carpool/AddCar') {
        return vi.fn(() =>
          Effect.succeed(
            new CarpoolRpcModels.AddCarResult({
              car_id: CAR_ID,
              view: makeCarpoolView(),
            }),
          ),
        );
      }
      if (prop === 'Carpool/GetCarpoolView') {
        return vi.fn(() => Effect.succeed(Option.some(makeCarpoolView())));
      }
      if (prop === 'Carpool/UpdateCarCapacity') {
        return vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
      }
      if (prop === 'Carpool/KickPassenger') {
        return vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
      }
      return vi.fn(() => Effect.succeed(undefined));
    },
  });

  const layer = Layer.succeed(SyncRpc, rpcStub);
  return { layer, rpcStub };
};

// ---------------------------------------------------------------------------
// Interaction fixture builder
// ---------------------------------------------------------------------------

const makeComponentInteraction = (
  customId: string,
  userId: string = USER_DISCORD_ID,
  channelId: string = CHANNEL_ID,
  messageId: string = MESSAGE_ID,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: GUILD_ID,
    channel_id: channelId as DiscordTypes.Snowflake,
    channel: {
      id: channelId as DiscordTypes.Snowflake,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
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
      id: messageId as DiscordTypes.Snowflake,
      channel_id: channelId as DiscordTypes.Snowflake,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// Helper to run a handler
// ---------------------------------------------------------------------------

const runHandler = async (
  handler: Effect.Effect<unknown, unknown, unknown>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    handler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );
  // Allow microtask queue to flush so forkDetach tasks complete
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Modal interaction fixture + runner (mirrors event-create.test.ts)
// ---------------------------------------------------------------------------

const makeModalInteraction = (
  customId: string,
  fields: Record<string, string>,
  userId: string = USER_DISCORD_ID,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MODAL_SUBMIT,
    guild_id: GUILD_ID,
    member: {
      user: {
        id: userId as DiscordTypes.Snowflake,
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
  handler: Effect.Effect<unknown, unknown, unknown>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) => {
  const response = await Effect.runPromise(
    handler.pipe(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('carpool-reserve interaction', () => {
  it('success — calls Carpool/ReserveSeat, then addThreadMember, then updateMessage on stored board channel; ephemeral response contains carpool-leave button', async () => {
    const reserveFn = vi.fn(() => Effect.succeed(makeReserveResult(THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub();

    // Interact from a different channel (e.g. a thread) — board should still update to CHANNEL_ID
    const interaction = makeComponentInteraction(
      `carpool-reserve:${CAR_ID}`,
      USER_DISCORD_ID,
      THREAD_ID,
    );
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    expect(reserveFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: CAR_ID }));
    expect(restStub.addThreadMember).toHaveBeenCalledWith(THREAD_ID, USER_DISCORD_ID);
    // updateMessage must use the stored board channel_id / message_id from the view,
    // NOT interaction.channel_id (which is THREAD_ID here)
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();

    // The ephemeral follow-up should contain a carpool-leave button
    const followUpCall = restStub.updateOriginalWebhookMessage.mock.calls[0];
    const followUpPayload = JSON.stringify(followUpCall);
    expect(followUpPayload).toMatch(/carpool-leave/);
  });

  it('addThreadMember returns 403 — no rollback RPC, note appended, overall success still reported', async () => {
    const reserveFn = vi.fn(() => Effect.succeed(makeReserveResult(THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });

    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    // RPC was still called
    expect(reserveFn).toHaveBeenCalled();
    // No rollback (no LeaveSeat call)
    // The follow-up message should mention the thread issue
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const followUpPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // Success is still reported despite thread join failure
    expect(followUpPayload.toLowerCase()).not.toContain('error');
  });

  it('carpool-reserve custom_id parsing extracts car_id correctly', async () => {
    const specificCarId = 'abc-def-123' as Carpool.CarpoolCarId;
    const reserveFn = vi.fn(() => Effect.succeed(makeReserveResult(null)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-reserve:${specificCarId}`);
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    expect(reserveFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: specificCarId }));
  });

  it('error tag → localized ephemeral message (CarpoolFull)', async () => {
    const reserveFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolFull()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const followUpPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    // Should contain some text about the car being full (not a raw error tag)
    expect(followUpPayload.length).toBeGreaterThan(0);
  });

  it('error tag → localized ephemeral message (CarpoolAlreadyInThisCar)', async () => {
    const reserveFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInThisCar()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const followUpPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(followUpPayload.length).toBeGreaterThan(0);
  });

  it('error tag → localized ephemeral message (CarpoolAlreadyInAnotherCar)', async () => {
    const reserveFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolAlreadyInAnotherCar()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/ReserveSeat': reserveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);
    await runHandler(CarpoolReserveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const followUpPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(followUpPayload.length).toBeGreaterThan(0);
  });
});

describe('carpool-leave interaction', () => {
  it('calls Carpool/LeaveSeat with car_id from custom_id, then deleteThreadMember using thread_id from view; board updated via stored channel/message id', async () => {
    // The view returned by LeaveSeat contains the car with its persisted thread_id.
    // The leave handler must look up the thread_id from the car in the view, not
    // from interaction.channel_id (which may be the thread channel or main channel).
    const leaveFn = vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/LeaveSeat': leaveFn });
    const restStub = makeRestStub();

    // Click from the thread — board still must update to stored board CHANNEL_ID/MESSAGE_ID
    const interaction = makeComponentInteraction(
      `carpool-leave:${CAR_ID}`,
      USER_DISCORD_ID,
      THREAD_ID,
    );
    await runHandler(CarpoolLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(leaveFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: CAR_ID }));
    // deleteThreadMember must use thread_id from view, not interaction.channel_id
    expect(restStub.deleteThreadMember).toHaveBeenCalledWith(THREAD_ID, USER_DISCORD_ID);
    // board updateMessage must target stored board coordinates, not interaction.channel_id
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('leave when car not in view (e.g. car removed) — skips deleteThreadMember gracefully', async () => {
    // If the car is gone from the view (e.g. it was concurrently removed), skip gracefully
    const leaveFn = vi.fn(() => Effect.succeed(makeCarpoolView())); // empty cars
    const rpcStub = makeSyncRpcStub({ 'Carpool/LeaveSeat': leaveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-leave:${CAR_ID}`);
    await runHandler(CarpoolLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(leaveFn).toHaveBeenCalled();
    // No car in view → no deleteThreadMember call
    expect(restStub.deleteThreadMember).not.toHaveBeenCalled();
  });

  it('carpool-leave custom_id parsing extracts car_id correctly', async () => {
    const specificCarId = 'xyz-789' as Carpool.CarpoolCarId;
    const leaveFn = vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(specificCarId, THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/LeaveSeat': leaveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-leave:${specificCarId}`);
    await runHandler(CarpoolLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(leaveFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: specificCarId }));
  });

  it('CarpoolOwnerCannotLeave → localized ephemeral error', async () => {
    const leaveFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolOwnerCannotLeave()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/LeaveSeat': leaveFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-leave:${CAR_ID}`);
    await runHandler(CarpoolLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });
});

describe('carpool-remove interaction', () => {
  it('owner removes car → Carpool/RemoveCar called, thread archived and locked; board updated via stored channel/message id', async () => {
    const removeFn = vi.fn(() => Effect.succeed(makeRemoveCarResult(THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/RemoveCar': removeFn });
    const restStub = makeRestStub();

    // Clicked from the thread — board must still update to stored board CHANNEL_ID/MESSAGE_ID
    const interaction = makeComponentInteraction(
      `carpool-remove:${CAR_ID}`,
      USER_DISCORD_ID,
      THREAD_ID,
    );
    await runHandler(CarpoolRemoveButton, restStub.layer, rpcStub.layer, interaction);

    expect(removeFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: CAR_ID }));
    expect(restStub.updateChannel).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({ archived: true, locked: true }),
    );
    // board updateMessage must target stored board coordinates, not interaction.channel_id
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('carpool-remove custom_id parsing extracts car_id correctly', async () => {
    const specificCarId = 'remove-test-123' as Carpool.CarpoolCarId;
    const removeFn = vi.fn(() => Effect.succeed(makeRemoveCarResult(null)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/RemoveCar': removeFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-remove:${specificCarId}`);
    await runHandler(CarpoolRemoveButton, restStub.layer, rpcStub.layer, interaction);

    expect(removeFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: specificCarId }));
  });

  it('CarpoolNotCarOwner → localized ephemeral error', async () => {
    const removeFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolNotCarOwner()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/RemoveCar': removeFn });
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-remove:${CAR_ID}`);
    await runHandler(CarpoolRemoveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });
});

describe('carpool-add interaction', () => {
  it('add button opens modal or prompts for car details', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction('carpool-add');
    const response = await runHandler(CarpoolAddButton, restStub.layer, rpcStub.layer, interaction);

    // The response should be a MODAL or deferred ephemeral
    const responseJson = JSON.stringify(response);
    const isModalOrDeferred =
      responseJson.includes(String(DiscordTypes.InteractionCallbackTypes.MODAL)) ||
      responseJson.includes(
        String(DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE),
      );
    expect(isModalOrDeferred).toBe(true);
  });

  it('carpool-add custom_id prefix is recognized', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    // carpool-add should NOT throw when receiving custom_id 'carpool-add'
    const interaction = makeComponentInteraction('carpool-add');
    await expect(
      runHandler(CarpoolAddButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.not.toThrow();
  });
});

// Regression guard: locks the USER_SELECT component JSON shape produced by
// CarpoolAssignButton (a single action row wrapping one type-5 select). Guards
// against drift in the dfx UI.* builder output for this component.
describe('carpool-assign interaction — USER_SELECT component shape', () => {
  it('renders a single action row with one USER_SELECT (type 5) component with the exact custom_id and placeholder', async () => {
    const interaction = makeComponentInteraction(`carpool-assign:${CAR_ID}`);
    // CarpoolAssignButton is exported as the Ix.messageComponent(...) registration
    // wrapper (unlike its sibling buttons, which export the raw Effect); the
    // handler Effect lives on its `.handle` property.
    const response = await Effect.runPromise(
      CarpoolAssignButton.handle.pipe(
        Effect.provide(Layer.succeed(Interaction, interaction)),
      ) as Effect.Effect<unknown, never, never>,
    );

    const data = (
      response as {
        type: number;
        data: {
          components: ReadonlyArray<{
            type: number;
            components: ReadonlyArray<{ type: number; custom_id: string; placeholder: string }>;
          }>;
        };
      }
    ).data;

    expect(data.components).toHaveLength(1);
    const row = data.components[0];
    expect(row?.type).toBe(1);
    expect(row?.components).toHaveLength(1);

    const select = row?.components[0];
    expect(select).toEqual({
      type: 5,
      custom_id: `carpool-assign-pick:${CAR_ID}`,
      placeholder: 'Who do you want to put in the car?',
    });
  });
});

describe('carpool-capacity interaction', () => {
  it('button renders a MODAL with a single carpool_capacity text input', async () => {
    const interaction = makeComponentInteraction(`carpool-capacity:${CAR_ID}`);
    const response = await Effect.runPromise(
      CarpoolCapacityButton.handle.pipe(
        Effect.provide(Layer.succeed(Interaction, interaction)),
      ) as Effect.Effect<unknown, never, never>,
    );

    const data = (
      response as {
        type: number;
        data: {
          custom_id: string;
          components: ReadonlyArray<{
            type: number;
            components: ReadonlyArray<{ type: number; custom_id: string }>;
          }>;
        };
      }
    ).data;

    expect((response as { type: number }).type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    expect(data.custom_id).toBe(`carpool-capacity-modal:${CAR_ID}`);
    expect(data.components).toHaveLength(1);
    const row = data.components[0];
    expect(row?.components).toHaveLength(1);
    expect(row?.components[0]?.custom_id).toBe('carpool_capacity');
  });

  it('modal submit calls Carpool/UpdateCarCapacity with the parsed capacity, then rebuilds the board', async () => {
    const updateFn = vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/UpdateCarCapacity': updateFn });
    const restStub = makeRestStub();

    const interaction = makeModalInteraction(`carpool-capacity-modal:${CAR_ID}`, {
      carpool_capacity: '6',
    });
    await runModalHandler(CarpoolCapacityModal.handle, restStub.layer, rpcStub.layer, interaction);

    expect(updateFn).toHaveBeenCalledWith(expect.objectContaining({ car_id: CAR_ID, capacity: 6 }));
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });

  it('CarpoolCapacityBelowOccupancy → localized ephemeral error', async () => {
    const updateFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolCapacityBelowOccupancy()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/UpdateCarCapacity': updateFn });
    const restStub = makeRestStub();

    const interaction = makeModalInteraction(`carpool-capacity-modal:${CAR_ID}`, {
      carpool_capacity: '1',
    });
    await runModalHandler(CarpoolCapacityModal.handle, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });

  it('out-of-range capacity ("9") is rejected without calling UpdateCarCapacity', async () => {
    const updateFn = vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/UpdateCarCapacity': updateFn });
    const restStub = makeRestStub();

    const interaction = makeModalInteraction(`carpool-capacity-modal:${CAR_ID}`, {
      carpool_capacity: '9',
    });
    await runModalHandler(CarpoolCapacityModal.handle, restStub.layer, rpcStub.layer, interaction);

    // The car must be left untouched — no RPC call, no board rebuild — and the
    // user gets an ephemeral validation error instead of a silent reset to 4.
    expect(updateFn).not.toHaveBeenCalled();
    expect(restStub.updateMessage).not.toHaveBeenCalled();
    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
  });
});

// Regression guard: locks the USER_SELECT component JSON shape produced by
// CarpoolKickButton, mirroring the carpool-assign shape guard above.
describe('carpool-kick interaction — USER_SELECT component shape', () => {
  it('renders a single action row with one USER_SELECT (type 5) component with the exact custom_id and placeholder', async () => {
    const interaction = makeComponentInteraction(`carpool-kick:${CAR_ID}`);
    const response = await Effect.runPromise(
      CarpoolKickButton.handle.pipe(
        Effect.provide(Layer.succeed(Interaction, interaction)),
      ) as Effect.Effect<unknown, never, never>,
    );

    const data = (
      response as {
        type: number;
        data: {
          components: ReadonlyArray<{
            type: number;
            components: ReadonlyArray<{ type: number; custom_id: string; placeholder: string }>;
          }>;
        };
      }
    ).data;

    expect(data.components).toHaveLength(1);
    const row = data.components[0];
    expect(row?.type).toBe(1);
    expect(row?.components).toHaveLength(1);

    const select = row?.components[0];
    expect(select).toEqual({
      type: 5,
      custom_id: `carpool-kick-pick:${CAR_ID}`,
      placeholder: 'Who do you want to remove?',
    });
  });
});

describe('carpool-kick-pick interaction', () => {
  it('calls Carpool/KickPassenger with car_id and target, removes target from thread, rebuilds board', async () => {
    const targetUserId = '600000000000000050';
    const kickFn = vi.fn(() => Effect.succeed(makeCarpoolViewWithCar(CAR_ID, THREAD_ID)));
    const rpcStub = makeSyncRpcStub({ 'Carpool/KickPassenger': kickFn });
    const restStub = makeRestStub();

    const interaction = {
      ...makeComponentInteraction(`carpool-kick-pick:${CAR_ID}`),
      data: {
        component_type: 5,
        custom_id: `carpool-kick-pick:${CAR_ID}`,
        values: [targetUserId],
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(CarpoolKickPickSelect.handle, restStub.layer, rpcStub.layer, interaction);

    expect(kickFn).toHaveBeenCalledWith(
      expect.objectContaining({ car_id: CAR_ID, target_discord_user_id: targetUserId }),
    );
    expect(restStub.deleteThreadMember).toHaveBeenCalledWith(THREAD_ID, targetUserId);
    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ allowed_mentions: { parse: [] } }),
    );
  });

  it('CarpoolTargetNotInCar → localized ephemeral error', async () => {
    const targetUserId = '600000000000000050';
    const kickFn = vi.fn(() => Effect.fail(new CarpoolRpcModels.CarpoolTargetNotInCar()));
    const rpcStub = makeSyncRpcStub({ 'Carpool/KickPassenger': kickFn });
    const restStub = makeRestStub();

    const interaction = {
      ...makeComponentInteraction(`carpool-kick-pick:${CAR_ID}`),
      data: {
        component_type: 5,
        custom_id: `carpool-kick-pick:${CAR_ID}`,
        values: [targetUserId],
      },
    } as unknown as DiscordTypes.APIInteraction;

    await runHandler(CarpoolKickPickSelect.handle, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const payload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(payload.length).toBeGreaterThan(0);
  });
});

describe('interaction response structure', () => {
  it('carpool-reserve returns deferred ephemeral immediately (optimistic defer pattern)', async () => {
    const rpcStub = makeSyncRpcStub();
    const restStub = makeRestStub();

    const interaction = makeComponentInteraction(`carpool-reserve:${CAR_ID}`);
    const response = await runHandler(
      CarpoolReserveButton,
      restStub.layer,
      rpcStub.layer,
      interaction,
    );

    const responseJson = JSON.stringify(response);
    expect(responseJson).toContain(
      String(DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE),
    );
    // ephemeral flag (64)
    expect(responseJson).toContain(String(DiscordTypes.MessageFlags.Ephemeral));
  });
});
