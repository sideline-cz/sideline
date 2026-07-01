// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { sudoHandler } from '~/commands/sudo/handler.js';
import { SUDO_ROLE_NAME } from '~/rest/roles/ensureSudoRole.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const GUILD_ID = '900000000000000001';
const INVOKER_ID = '900000000000000030';
const SUDO_ROLE_ID = '900000000000000099';
const SYSTEM_CHANNEL_ID = '900000000000000077';

// ---------------------------------------------------------------------------
// Discord REST stub helpers
// ---------------------------------------------------------------------------

interface RestStubOptions {
  listGuildRoles?: ReturnType<typeof vi.fn>;
  createGuildRole?: ReturnType<typeof vi.fn>;
  addGuildMemberRole?: ReturnType<typeof vi.fn>;
  deleteGuildMemberRole?: ReturnType<typeof vi.fn>;
  getGuild?: ReturnType<typeof vi.fn>;
  createMessage?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const listGuildRoles =
    options.listGuildRoles ??
    vi.fn(() => Effect.succeed([{ id: SUDO_ROLE_ID, name: SUDO_ROLE_NAME }]));
  const createGuildRole =
    options.createGuildRole ??
    vi.fn(() => Effect.succeed({ id: SUDO_ROLE_ID, name: SUDO_ROLE_NAME }));
  const addGuildMemberRole = options.addGuildMemberRole ?? vi.fn(() => Effect.succeed(undefined));
  const deleteGuildMemberRole =
    options.deleteGuildMemberRole ?? vi.fn(() => Effect.succeed(undefined));
  const getGuild =
    options.getGuild ??
    vi.fn(() =>
      Effect.succeed({ system_channel_id: SYSTEM_CHANNEL_ID, preferred_locale: 'en-US' }),
    );
  const createMessage = options.createMessage ?? vi.fn(() => Effect.succeed(undefined));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'listGuildRoles') return listGuildRoles;
      if (prop === 'createGuildRole') return createGuildRole;
      if (prop === 'addGuildMemberRole') return addGuildMemberRole;
      if (prop === 'deleteGuildMemberRole') return deleteGuildMemberRole;
      if (prop === 'getGuild') return getGuild;
      if (prop === 'createMessage') return createMessage;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return {
    layer,
    listGuildRoles,
    createGuildRole,
    addGuildMemberRole,
    deleteGuildMemberRole,
    getGuild,
    createMessage,
    updateOriginalWebhookMessage,
  };
};

// ---------------------------------------------------------------------------
// SyncRpc stub helpers
// ---------------------------------------------------------------------------

interface SyncRpcOptions {
  'Guild/CheckTeamAdmin'?: ReturnType<typeof vi.fn>;
}

const makeSyncRpcStub = (options: SyncRpcOptions = {}) => {
  const defaultCheckTeamAdmin = vi.fn(() =>
    Effect.succeed({ team_id: { _tag: 'Some', value: 'team-1' }, is_admin: true }),
  );

  const rpc = new Proxy({} as any, {
    get: (_target, prop: string) => {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
      if (prop === 'Guild/CheckTeamAdmin') {
        return options['Guild/CheckTeamAdmin'] ?? defaultCheckTeamAdmin;
      }
      return () => Effect.succeed(undefined);
    },
  });

  const layer = Layer.succeed(SyncRpc, rpc);
  return {
    layer,
    checkTeamAdmin: options['Guild/CheckTeamAdmin'] ?? defaultCheckTeamAdmin,
  };
};

const adminResult = (isAdmin: boolean) =>
  vi.fn(() =>
    Effect.succeed({
      team_id: isAdmin ? { _tag: 'Some', value: 'team-1' } : { _tag: 'None' },
      is_admin: isAdmin,
    }),
  );

// ---------------------------------------------------------------------------
// Interaction fixture
// ---------------------------------------------------------------------------

interface InteractionFixtureOptions {
  guildId?: string | undefined;
  locale?: string;
  invokerRoles?: ReadonlyArray<string>;
}

const makeInteraction = (opts: InteractionFixtureOptions = {}): DiscordTypes.APIInteraction => {
  const locale = opts.locale ?? 'en-US';
  const guildId = 'guildId' in opts ? opts.guildId : GUILD_ID;

  return {
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: 'app-id-123' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: guildId as DiscordTypes.Snowflake | undefined,
    channel_id: 'channel-123' as DiscordTypes.Snowflake,
    channel: {
      id: 'channel-123' as DiscordTypes.Snowflake,
      name: 'general',
      type: DiscordTypes.ChannelTypes.GUILD_TEXT,
    } as unknown as DiscordTypes.APIInteraction['channel'],
    member: {
      user: {
        id: INVOKER_ID as DiscordTypes.Snowflake,
        username: 'invoker',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: opts.invokerRoles ?? [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions: '0',
    },
    locale,
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'sudo',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [],
    },
  } as unknown as DiscordTypes.APIInteraction;
};

// ---------------------------------------------------------------------------
// runHandler: flush detached forks with two setTimeout(0) ticks
// ---------------------------------------------------------------------------

const runHandler = async (
  interaction: DiscordTypes.APIInteraction,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) => {
  const response = await Effect.runPromise(
    sudoHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
      Effect.provide(rpcLayer),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests — sudoHandler
// ---------------------------------------------------------------------------

describe('sudoHandler', () => {
  it('returns a deferred ephemeral ack immediately, before any REST/RPC work resolves', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    const response = await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });
  });

  it('admin, not elevated, sudo role exists, system channel set → grants role, posts audit message, ephemeral entered', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(rest.createGuildRole).not.toHaveBeenCalled();
    expect(rest.addGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.addGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, INVOKER_ID, SUDO_ROLE_ID);

    expect(rest.createMessage).toHaveBeenCalled();
    const createArgs = rest.createMessage.mock.calls[0] as unknown[];
    expect(createArgs[0]).toBe(SYSTEM_CHANNEL_ID);
    const createPayload = JSON.stringify(createArgs);
    expect(createPayload).toContain(`sudo-leave:${INVOKER_ID}`);

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_entered({}, { locale: 'en' }));
  });

  it('admin, not elevated, sudo role missing → creates the role with Administrator permission before granting it', async () => {
    const rest = makeRestStub({ listGuildRoles: vi.fn(() => Effect.succeed([])) });
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(rest.createGuildRole).toHaveBeenCalledTimes(1);
    const createRoleArgs = rest.createGuildRole.mock.calls[0] as unknown[];
    const createRoleOptions = createRoleArgs[1] as { permissions?: unknown };
    expect(Number(createRoleOptions.permissions)).toBe(
      Number(DiscordTypes.Permissions.Administrator),
    );

    expect(rest.addGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.createMessage).toHaveBeenCalled();
  });

  it('admin, already elevated → revokes role, ephemeral left, no audit message posted', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [SUDO_ROLE_ID] }), rest.layer, rpc.layer);

    expect(rest.deleteGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.deleteGuildMemberRole).toHaveBeenCalledWith(GUILD_ID, INVOKER_ID, SUDO_ROLE_ID);
    expect(rest.addGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.createMessage).not.toHaveBeenCalled();

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_left({}, { locale: 'en' }));
  });

  it('non-admin → no role ops, no message, ephemeral not-admin', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(false) });

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    expect(rest.addGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.createGuildRole).not.toHaveBeenCalled();
    expect(rest.createMessage).not.toHaveBeenCalled();

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_err_not_admin({}, { locale: 'en' }));
  });

  it('no system channel set → role still granted, no audit message, ephemeral no-system-channel', async () => {
    const rest = makeRestStub({
      getGuild: vi.fn(() => Effect.succeed({ system_channel_id: null, preferred_locale: 'en-US' })),
    });
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(rest.addGuildMemberRole).toHaveBeenCalledTimes(1);
    expect(rest.createMessage).not.toHaveBeenCalled();

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_err_no_system_channel({}, { locale: 'en' }));
  });

  it('grant permission error (403 / code 50013) → ephemeral grant-failed, no audit message', async () => {
    const rest = makeRestStub({
      addGuildMemberRole: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(rest.createMessage).not.toHaveBeenCalled();
    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_err_grant_failed({}, { locale: 'en' }));
  });

  it('RPC transport failure (CheckTeamAdmin fails) → ephemeral generic error, no role/message side effects', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({
      'Guild/CheckTeamAdmin': vi.fn(() => Effect.fail({ _tag: 'RpcClientError' as const })),
    });

    await runHandler(makeInteraction(), rest.layer, rpc.layer);

    expect(rest.addGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.deleteGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.createMessage).not.toHaveBeenCalled();

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_err_generic({}, { locale: 'en' }));
  });

  it('missing guild_id (DM context) → immediate ephemeral no-guild, no RPC/REST calls', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub();

    await runHandler(makeInteraction({ guildId: undefined }), rest.layer, rpc.layer);

    expect(rpc.checkTeamAdmin).not.toHaveBeenCalled();
    expect(rest.addGuildMemberRole).not.toHaveBeenCalled();
    expect(rest.createMessage).not.toHaveBeenCalled();

    expect(rest.updateOriginalWebhookMessage).toHaveBeenCalled();
    const webhookPayload = JSON.stringify(rest.updateOriginalWebhookMessage.mock.calls[0]);
    expect(webhookPayload).toContain(m.bot_sudo_err_no_guild({}, { locale: 'en' }));
  });

  it('the posted audit message description contains the Discord timestamp token "<t:"', async () => {
    const rest = makeRestStub();
    const rpc = makeSyncRpcStub({ 'Guild/CheckTeamAdmin': adminResult(true) });

    await runHandler(makeInteraction({ invokerRoles: [] }), rest.layer, rpc.layer);

    expect(rest.createMessage).toHaveBeenCalled();
    const createPayload = JSON.stringify(rest.createMessage.mock.calls[0]);
    expect(createPayload).toContain('<t:');
  });
});
