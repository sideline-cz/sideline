import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { summonHandler } from '~/commands/summon/handler.js';

// ---------------------------------------------------------------------------
// DiscordREST stub helpers
// ---------------------------------------------------------------------------

interface RestStubOptions {
  addThreadMember?: ReturnType<typeof vi.fn>;
  listGuildMembers?: ReturnType<typeof vi.fn>;
  updateOriginalWebhookMessage?: ReturnType<typeof vi.fn>;
}

const makeRestStub = (options: RestStubOptions = {}) => {
  const addThreadMember = options.addThreadMember ?? vi.fn(() => Effect.succeed(undefined));
  const listGuildMembers = options.listGuildMembers ?? vi.fn(() => Effect.succeed([]));
  const updateOriginalWebhookMessage =
    options.updateOriginalWebhookMessage ?? vi.fn(() => Effect.succeed(undefined));

  const rest = new Proxy({} as DiscordRestService, {
    get: (_target, prop: string) => {
      if (prop === 'addThreadMember') return addThreadMember;
      if (prop === 'listGuildMembers') return listGuildMembers;
      if (prop === 'updateOriginalWebhookMessage') return updateOriginalWebhookMessage;
      return () => Effect.succeed(undefined);
    },
  }) as unknown as DiscordRestService;

  const layer = Layer.succeed(DiscordREST, rest as unknown as InstanceType<typeof DiscordREST>);
  return { layer, addThreadMember, listGuildMembers, updateOriginalWebhookMessage };
};

// ---------------------------------------------------------------------------
// Interaction fixture
// ---------------------------------------------------------------------------

interface InteractionOptionFixture {
  type: number;
  name: string;
  value?: string;
}

interface InteractionFixtureOptions {
  channelType?: number;
  channelId?: string | undefined;
  options?: ReadonlyArray<InteractionOptionFixture>;
  locale?: string;
  guildId?: string | undefined;
  /** Defaults to MANAGE_THREADS so most tests look at the happy path. Override
   * with '0' to exercise the runtime permission gate. */
  permissions?: string;
}

// MANAGE_THREADS = 1n << 34n
const DEFAULT_PERMISSIONS = '17179869184';

const makeInteraction = (opts: InteractionFixtureOptions = {}): DiscordTypes.APIInteraction => {
  const channelType = opts.channelType ?? DiscordTypes.ChannelTypes.PUBLIC_THREAD;
  const channelId = opts.channelId === undefined ? 'thread-123' : opts.channelId;
  const locale = opts.locale ?? 'en-US';
  const guildId = opts.guildId === undefined ? '9999999999' : opts.guildId;
  const permissions = opts.permissions ?? DEFAULT_PERMISSIONS;

  return {
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: 'app-id-123' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: guildId as DiscordTypes.Snowflake | undefined,
    channel_id: channelId as DiscordTypes.Snowflake | undefined,
    channel: channelId
      ? ({
          id: channelId as DiscordTypes.Snowflake,
          type: channelType,
        } as unknown as DiscordTypes.APIInteraction['channel'])
      : undefined,
    member: {
      user: {
        id: 'invoker-1' as DiscordTypes.Snowflake,
        username: 'invoker',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
      permissions,
    },
    locale,
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'summon',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: opts.options ?? [],
    },
  } as unknown as DiscordTypes.APIInteraction;
};

const userOption = (value: string): InteractionOptionFixture => ({
  type: DiscordTypes.ApplicationCommandOptionType.USER,
  name: 'user',
  value,
});

const roleOption = (value: string): InteractionOptionFixture => ({
  type: DiscordTypes.ApplicationCommandOptionType.ROLE,
  name: 'role',
  value,
});

const makeMember = (id: string, roles: ReadonlyArray<string>) => ({
  user: { id, username: id, discriminator: '0000', global_name: null, avatar: null },
  roles,
  joined_at: '2024-01-01T00:00:00Z',
  deaf: false,
  mute: false,
  pending: false,
  flags: 0,
  nick: null,
  premium_since: null,
  banner: null,
  communication_disabled_until: null,
  avatar_decoration_data: null,
});

const runHandler = async (
  interaction: DiscordTypes.APIInteraction,
  restLayer: Layer.Layer<DiscordREST>,
) => {
  const response = await Effect.runPromise(
    summonHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(restLayer),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return response;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('summonHandler', () => {
  it('returns ephemeral "not a thread" message when invoked in a regular text channel', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.GUILD_TEXT,
        options: [userOption('target-1')],
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    expect(json).toContain('thread');
    expect(json).toMatch(/64|ephemeral/i);
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "not a thread" when invoked in a category channel', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.GUILD_CATEGORY,
        options: [userOption('target-1')],
      }),
      stub.layer,
    );

    expect(JSON.stringify(response)).toContain('thread');
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "forbidden" when invoker lacks Manage Threads', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        options: [userOption('target-1')],
        permissions: '0',
      }),
      stub.layer,
    );

    const json = JSON.stringify(response);
    expect(json.toLowerCase()).toContain('permission');
    expect(json).toMatch(/64|ephemeral/i);
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "forbidden" when interaction has no member.permissions', async () => {
    // Simulate a missing permissions field — DM-like or malformed payload.
    const stub = makeRestStub();
    const baseInteraction = makeInteraction({ options: [userOption('target-1')] }) as unknown as {
      member?: Record<string, unknown>;
    } & DiscordTypes.APIInteraction;
    const interaction = {
      ...baseInteraction,
      member: { ...(baseInteraction.member ?? {}), permissions: undefined },
    } as unknown as DiscordTypes.APIInteraction;
    const response = await runHandler(interaction, stub.layer);
    expect(JSON.stringify(response).toLowerCase()).toContain('permission');
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('returns ephemeral "missing target" when neither user nor role is provided', async () => {
    const stub = makeRestStub();
    const response = await runHandler(makeInteraction({ options: [] }), stub.layer);

    const json = JSON.stringify(response);
    expect(json.toLowerCase()).toContain('user');
    expect(stub.addThreadMember).not.toHaveBeenCalled();
  });

  it('user only — calls addThreadMember once and reports the user mention', async () => {
    const stub = makeRestStub();
    const response = await runHandler(
      makeInteraction({
        channelType: DiscordTypes.ChannelTypes.PUBLIC_THREAD,
        channelId: 'thread-123',
        options: [userOption('target-1')],
      }),
      stub.layer,
    );

    expect(response).toEqual({
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    });
    expect(stub.addThreadMember).toHaveBeenCalledWith('thread-123', 'target-1');
    expect(stub.listGuildMembers).not.toHaveBeenCalled();
    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(update)).toContain('<@target-1>');
  });

  it('role only — expands role members and calls addThreadMember for each', async () => {
    const members = [
      makeMember('user-a', ['role-x']),
      makeMember('user-b', ['role-x', 'role-y']),
      makeMember('user-c', ['role-y']), // does NOT have role-x — should be filtered out
      makeMember('user-d', ['role-x']),
    ];
    const stub = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed(members)),
    });

    await runHandler(
      makeInteraction({
        channelId: 'thread-xyz',
        options: [roleOption('role-x')],
      }),
      stub.layer,
    );

    expect(stub.listGuildMembers).toHaveBeenCalled();
    const addedIds = stub.addThreadMember.mock.calls.map((c: unknown[]) => c[1]).sort();
    expect(addedIds).toEqual(['user-a', 'user-b', 'user-d']);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const updateJson = JSON.stringify(update);
    expect(updateJson).toContain('<@&role-x>');
    expect(updateJson).toContain('3');
  });

  it('role only with no matching members — reports "no members" message', async () => {
    const stub = makeRestStub({
      listGuildMembers: vi.fn(() =>
        Effect.succeed([
          makeMember('user-a', ['other-role']),
          makeMember('user-b', ['another-role']),
        ]),
      ),
    });

    await runHandler(makeInteraction({ options: [roleOption('role-x')] }), stub.layer);

    expect(stub.addThreadMember).not.toHaveBeenCalled();
    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const updateJson = JSON.stringify(update);
    expect(updateJson.toLowerCase()).toMatch(/no members|nemá žádné/);
  });

  it('user + role — deduplicates and reports both counts', async () => {
    const members = [
      makeMember('target-1', ['role-x']), // overlaps with explicit user
      makeMember('user-b', ['role-x']),
      makeMember('user-c', ['role-x']),
    ];
    const stub = makeRestStub({
      listGuildMembers: vi.fn(() => Effect.succeed(members)),
    });

    await runHandler(
      makeInteraction({
        options: [userOption('target-1'), roleOption('role-x')],
      }),
      stub.layer,
    );

    const addedIds = stub.addThreadMember.mock.calls.map((c: unknown[]) => c[1]).sort();
    expect(addedIds).toEqual(['target-1', 'user-b', 'user-c']);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const updateJson = JSON.stringify(update);
    expect(updateJson).toContain('<@target-1>');
    expect(updateJson).toContain('<@&role-x>');
    // 2 = 3 added minus the explicit user
    expect(updateJson).toContain('2');
  });

  it('maps Discord 403 (response.status) to bot_summon_bot_forbidden', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 403 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });

    await runHandler(makeInteraction({ options: [userOption('target-1')] }), stub.layer);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(update).toLowerCase()).toContain('permission');
  });

  it('maps Discord JSON code 50013 (data.code) to bot_summon_bot_forbidden', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 400 },
          data: { code: 50013, message: 'Missing Permissions' },
          message: 'Missing Permissions',
        }),
      ),
    });

    await runHandler(makeInteraction({ options: [userOption('target-1')] }), stub.layer);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(update).toLowerCase()).toContain('permission');
  });

  it('does NOT map Discord 404 to forbidden — falls back to generic error', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 404 },
          data: { code: 10003, message: 'Unknown Channel' },
          message: 'Unknown Channel',
        }),
      ),
    });

    await runHandler(makeInteraction({ options: [userOption('target-1')] }), stub.layer);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const json = JSON.stringify(update).toLowerCase();
    expect(json).not.toContain('permission');
  });

  it('falls back to generic error on non-permission ErrorResponse', async () => {
    const stub = makeRestStub({
      addThreadMember: vi.fn(() =>
        Effect.fail({
          _tag: 'ErrorResponse' as const,
          response: { status: 500 },
          data: { code: 0, message: 'Internal' },
          message: 'Internal Server Error',
        }),
      ),
    });

    await runHandler(makeInteraction({ options: [userOption('target-1')] }), stub.layer);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(update).toLowerCase()).not.toContain('permission');
  });

  it('Czech locale renders Czech success text', async () => {
    const stub = makeRestStub();
    await runHandler(
      makeInteraction({
        options: [userOption('target-1')],
        locale: 'cs',
      }),
      stub.layer,
    );
    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    expect(JSON.stringify(update)).toContain('vlákn');
  });

  it('Czech locale renders Czech missing-target text', async () => {
    const stub = makeRestStub();
    const response = await runHandler(makeInteraction({ options: [], locale: 'cs' }), stub.layer);

    const json = JSON.stringify(response);
    expect(json).toMatch(/zadat|alespoň/);
  });

  it('sets allowed_mentions.users so the added user mention does not silently ping anyone', async () => {
    const stub = makeRestStub();
    await runHandler(makeInteraction({ options: [userOption('target-1')] }), stub.layer);

    const update = stub.updateOriginalWebhookMessage.mock.calls[0]?.[2];
    const payload = (update as { payload?: { allowed_mentions?: unknown } } | undefined)?.payload;
    const allowedMentions = (payload as { allowed_mentions?: unknown } | undefined)
      ?.allowed_mentions;
    expect(allowedMentions).toBeDefined();
    expect(allowedMentions).toEqual({ parse: [], users: ['target-1'] });
  });
});
