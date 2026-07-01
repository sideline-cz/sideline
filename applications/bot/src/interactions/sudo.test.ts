// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until ~/interactions/sudo.ts and
// ~/rest/roles/ensureSudoRole.ts are created.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { SudoLeaveButton } from '~/interactions/sudo.js';
import { SUDO_ROLE_NAME } from '~/rest/roles/ensureSudoRole.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '900000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '900000000000000010' as DiscordTypes.Snowflake;
const MESSAGE_ID = '900000000000000011' as DiscordTypes.Snowflake;
const CLICKER_ID = '900000000000000030' as DiscordTypes.Snowflake;
const SUBJECT_ID = '900000000000000031' as DiscordTypes.Snowflake;
const SUDO_ROLE_ID = '900000000000000099' as DiscordTypes.Snowflake;
const APP_ID = '900000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-sudo-token';

// ---------------------------------------------------------------------------
// Discord REST stub
// ---------------------------------------------------------------------------

interface RestStubOptions {
  listGuildRoles?: ReturnType<typeof vi.fn>;
  createGuildRole?: ReturnType<typeof vi.fn>;
  deleteGuildMemberRole?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const listGuildRoles =
    options.listGuildRoles ??
    vi.fn(() => Effect.succeed([{ id: SUDO_ROLE_ID, name: SUDO_ROLE_NAME }]));
  const createGuildRole =
    options.createGuildRole ??
    vi.fn(() => Effect.succeed({ id: SUDO_ROLE_ID, name: SUDO_ROLE_NAME }));
  const deleteGuildMemberRole =
    options.deleteGuildMemberRole ?? vi.fn(() => Effect.succeed(undefined));
  const updateMessage = options.updateMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'listGuildRoles') return listGuildRoles;
      if (prop === 'createGuildRole') return createGuildRole;
      if (prop === 'deleteGuildMemberRole') return deleteGuildMemberRole;
      if (prop === 'updateMessage') return updateMessage;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return {
    layer,
    listGuildRoles,
    createGuildRole,
    deleteGuildMemberRole,
    updateMessage,
    updateOriginalWebhookMessage,
  };
};

// ---------------------------------------------------------------------------
// SyncRpc stub
// ---------------------------------------------------------------------------

interface SyncRpcStubOptions {
  'Guild/CheckTeamAdmin'?: ReturnType<typeof vi.fn>;
}

const adminResult = (isAdmin: boolean) =>
  vi.fn(() =>
    Effect.succeed({
      team_id: isAdmin ? { _tag: 'Some', value: 'team-1' } : { _tag: 'None' },
      is_admin: isAdmin,
    }),
  );

const makeSyncRpcStub = (options: SyncRpcStubOptions = {}) => {
  const rpcStub = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (options[prop as keyof SyncRpcStubOptions]) {
        return options[prop as keyof SyncRpcStubOptions];
      }
      if (prop === 'Guild/CheckTeamAdmin') {
        return adminResult(true);
      }
      return vi.fn(() => Effect.succeed(undefined));
    },
  });

  const layer = Layer.succeed(SyncRpc, rpcStub);
  return { layer, rpcStub };
};

// ---------------------------------------------------------------------------
// Interaction fixture
// ---------------------------------------------------------------------------

interface LeaveInteractionOptions {
  subjectUserId?: string;
  clickerId?: string;
  guildId?: string | undefined;
}

const makeLeaveInteraction = (
  subjectUserId: string = SUBJECT_ID,
  clickerId: string = CLICKER_ID,
  opts: LeaveInteractionOptions = {},
): DiscordTypes.APIInteraction => {
  const guildId = 'guildId' in opts ? opts.guildId : GUILD_ID;

  return {
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    guild_id: guildId as DiscordTypes.Snowflake | undefined,
    channel_id: CHANNEL_ID,
    channel: {
      id: CHANNEL_ID,
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: clickerId as DiscordTypes.Snowflake,
        username: 'clicker',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '0',
    },
    locale: 'en-US',
    data: {
      component_type: 2,
      custom_id: `sudo-leave:${subjectUserId}`,
    },
    message: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
    },
  } as unknown as DiscordTypes.APIInteraction;
};

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
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests — SudoLeaveButton (sudo-leave:{subjectUserId})
// ---------------------------------------------------------------------------

describe('SudoLeaveButton — sudo-leave:{subjectUserId}', () => {
  it('admin clicks Leave → revokes the subject role, updates message to ended state, ephemeral left', async () => {
    const rpcStub = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });
    const restStub = makeRestStub();

    const interaction = makeLeaveInteraction(SUBJECT_ID, CLICKER_ID);
    await runHandler(SudoLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(restStub.deleteGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, SUBJECT_ID, SUDO_ROLE_ID);

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ components: [] }),
    );
    const updateArgs = restStub.updateMessage.mock.calls[0] as unknown[];
    const updatePayload = JSON.stringify(updateArgs);
    expect(updatePayload).toContain(SUBJECT_ID);
    expect(updatePayload).toContain(CLICKER_ID);

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const ephemeralPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(ephemeralPayload).toContain(m.bot_sudo_left({}, { locale: 'en' }));
  });

  it('non-admin clicks Leave → immediate ephemeral not-admin, no revoke, shared message untouched', async () => {
    const rpcStub = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(false) });
    const restStub = makeRestStub();

    const interaction = makeLeaveInteraction(SUBJECT_ID, CLICKER_ID);
    await runHandler(SudoLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(restStub.deleteGuildMemberRole).not.toHaveBeenCalled();
    expect(restStub.updateMessage).not.toHaveBeenCalled();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const ephemeralPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(ephemeralPayload).toContain(m.bot_sudo_err_not_admin({}, { locale: 'en' }));
  });

  it('delete 404 (already ended) → message updated to ended state, ephemeral already-ended, no throw', async () => {
    const rpcStub = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });
    const restStub = makeRestStub({
      deleteGuildMemberRole: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 404 },
          data: { code: 10011, message: 'Unknown Role' },
          message: 'Unknown Role',
        }),
      ),
    });

    const interaction = makeLeaveInteraction(SUBJECT_ID, CLICKER_ID);
    await expect(
      runHandler(SudoLeaveButton, restStub.layer, rpcStub.layer, interaction),
    ).resolves.toBeDefined();

    expect(restStub.updateMessage).toHaveBeenCalledWith(
      CHANNEL_ID,
      MESSAGE_ID,
      expect.objectContaining({ components: [] }),
    );

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const ephemeralPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(ephemeralPayload).toContain(m.bot_sudo_already_ended({}, { locale: 'en' }));
  });

  it('delete 403 → message stays ACTIVE (components not stripped), ephemeral revoke-failed', async () => {
    const rpcStub = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });
    const restStub = makeRestStub({
      deleteGuildMemberRole: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });

    const interaction = makeLeaveInteraction(SUBJECT_ID, CLICKER_ID);
    await runHandler(SudoLeaveButton, restStub.layer, rpcStub.layer, interaction);

    // Either updateMessage was never called, or if it was, components were NOT emptied.
    const emptiedComponentsCall = restStub.updateMessage.mock.calls.find((call: unknown[]) => {
      const payload = call[2] as { components?: unknown[] } | undefined;
      return Array.isArray(payload?.components) && payload.components.length === 0;
    });
    expect(emptiedComponentsCall).toBeUndefined();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const ephemeralPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(ephemeralPayload).toContain(m.bot_sudo_err_revoke_failed({}, { locale: 'en' }));
  });

  it('missing guild_id on button → immediate ephemeral no-guild', async () => {
    const checkTeamAdminFn = adminResult(true);
    const rpcStub = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': checkTeamAdminFn });
    const restStub = makeRestStub();

    const interaction = makeLeaveInteraction(SUBJECT_ID, CLICKER_ID, { guildId: undefined });
    await runHandler(SudoLeaveButton, restStub.layer, rpcStub.layer, interaction);

    expect(checkTeamAdminFn).not.toHaveBeenCalled();
    expect(restStub.deleteGuildMemberRole).not.toHaveBeenCalled();
    expect(restStub.updateMessage).not.toHaveBeenCalled();

    expect(restStub.updateOriginalWebhookMessage).toHaveBeenCalled();
    const ephemeralPayload = JSON.stringify(restStub.updateOriginalWebhookMessage.mock.calls[0]);
    expect(ephemeralPayload).toContain(m.bot_sudo_err_no_guild({}, { locale: 'en' }));
  });
});
