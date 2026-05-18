import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { infoHandler } from '~/commands/info/handler.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// APP_VERSION is read from the bot's package.json, which changesets bumps on
// every release — stub it so the snapshot stays stable across version bumps.
vi.mock('~/version.js', () => ({
  APP_VERSION: '0.0.0-test',
}));

// ---------------------------------------------------------------------------
// SyncRpc stub helpers
// ---------------------------------------------------------------------------

/**
 * Builds a SyncRpc Layer where BotInfo/GetServerVersion returns the given
 * server version string, and all other calls return a no-op.
 */
const makeSucceedSyncRpcLayer = (serverVersion: string): Layer.Layer<SyncRpc> =>
  Layer.succeed(
    SyncRpc,
    new Proxy({} as SyncRpcClient, {
      get: (_target, prop: string) => {
        if (prop === 'BotInfo/GetServerVersion') {
          return () => Effect.succeed(serverVersion);
        }
        // All other RPC calls succeed with empty/void
        return () => Effect.succeed(undefined);
      },
    }) as unknown as InstanceType<typeof SyncRpc>,
  );

/**
 * Builds a SyncRpc Layer where BotInfo/GetServerVersion fails with an
 * RpcClientError-like error to simulate a network/RPC failure.
 */
const makeFailSyncRpcLayer = (): Layer.Layer<SyncRpc> =>
  Layer.succeed(
    SyncRpc,
    new Proxy({} as SyncRpcClient, {
      get: (_target, prop: string) => {
        if (prop === 'BotInfo/GetServerVersion') {
          return () =>
            Effect.fail({
              _tag: 'RpcClientError' as const,
              message: 'Connection refused',
            });
        }
        return () => Effect.succeed(undefined);
      },
    }) as unknown as InstanceType<typeof SyncRpc>,
  );

// ---------------------------------------------------------------------------
// Minimal Interaction literal (only fields the handler reads)
// ---------------------------------------------------------------------------

const makeInteraction = (): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: 'app-id-123' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    guild_id: '9999999999' as DiscordTypes.Snowflake,
    member: {
      user: {
        id: 'user-123' as DiscordTypes.Snowflake,
        username: 'testuser',
        discriminator: '0001',
        global_name: null,
        avatar: null,
      },
      roles: [],
      joined_at: '2024-01-01T00:00:00Z',
      deaf: false,
      mute: false,
    },
    locale: 'en-US',
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'info',
      type: DiscordTypes.ApplicationCommandType.CHAT,
    },
  }) as unknown as DiscordTypes.APIInteraction;

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

/**
 * Runs the infoHandler effect with the given SyncRpc layer and a minimal
 * Interaction injected into the service context.
 */
const runInfoHandler = (syncRpcLayer: Layer.Layer<SyncRpc>) =>
  Effect.runPromise(
    infoHandler.pipe(
      Effect.provide(Layer.succeed(Interaction, makeInteraction())),
      Effect.provide(syncRpcLayer),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('infoHandler', () => {
  it('handler returns an ephemeral embed containing bot version, server version, credits, and link to https://majksa.com', async () => {
    const response = await runInfoHandler(makeSucceedSyncRpcLayer('0.18.0'));

    // Should be an CHANNEL_MESSAGE_WITH_SOURCE or similar immediate response
    expect(response).toBeDefined();

    const json = JSON.stringify(response);

    // Ephemeral flag must be set (64 = MessageFlags.Ephemeral)
    expect(json).toMatch(/64|ephemeral/i);

    // Should contain the fetched server version
    expect(json).toContain('0.18.0');

    // Should contain a link to majksa.com
    expect(json).toContain('majksa.com');

    // Snapshot covers full structure + content on first successful run
    expect(response).toMatchInlineSnapshot(`
      {
        "data": {
          "embeds": [
            {
              "color": 5793266,
              "description": "Discord-first sports team management.",
              "fields": [
                {
                  "inline": true,
                  "name": "Bot",
                  "value": "0.0.0-test",
                },
                {
                  "inline": true,
                  "name": "Server",
                  "value": "0.18.0",
                },
                {
                  "inline": true,
                  "name": "Author",
                  "value": "[majksa](https://majksa.com)",
                },
              ],
              "footer": {
                "text": "Made with ❤ by majksa",
              },
              "title": "Sideline",
              "url": "https://majksa.com",
            },
          ],
          "flags": 64,
        },
        "type": 4,
      }
    `);
  });

  it('handler falls back to "unknown" for server version when RPC fails', async () => {
    const response = await runInfoHandler(makeFailSyncRpcLayer());

    expect(response).toBeDefined();

    const json = JSON.stringify(response);

    // Server version should gracefully show "unknown" when RPC fails
    expect(json).toContain('unknown');

    // Response should still be ephemeral
    expect(json).toMatch(/64|ephemeral/i);

    // Credits / link should still appear
    expect(json).toContain('majksa.com');
  });
});
