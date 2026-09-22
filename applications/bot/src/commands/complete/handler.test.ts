import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { completeHandler } from '~/commands/complete/handler.js';

// ---------------------------------------------------------------------------
// Task 6 rewrite: the handler no longer parses a `gender` command option or
// builds the modal inline — gender moved into the modal itself
// (`~/commands/complete/modal.js`), so the handler is now a guild check plus
// one call to `buildProfileCompleteModal`. The modal's own payload shape is
// covered by `test/commands/complete/modal.test.ts`; this file only pins the
// handler's two behaviours: the no-guild ephemeral, and delegating to the
// shared modal builder otherwise.
// ---------------------------------------------------------------------------

/** Minimal APIInteraction for /complete. */
const makeInteraction = (guildId?: string): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: 'app-id-123' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND,
    ...(guildId !== undefined ? { guild_id: guildId as DiscordTypes.Snowflake } : {}),
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
      name: 'complete',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runCompleteHandler = (interaction: DiscordTypes.APIInteraction) =>
  Effect.runPromise(completeHandler.pipe(Effect.provide(Layer.succeed(Interaction, interaction))));

describe('complete command handler', () => {
  it('no guild_id → ephemeral bot_complete_no_guild, no modal', async () => {
    const response = await runCompleteHandler(makeInteraction(undefined));

    expect((response as { type: number }).type).toBe(
      DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    );
    const data = (response as { data: { flags?: number } }).data;
    expect(data.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });

  it('with a guild → opens the shared profile-complete modal', async () => {
    const response = await runCompleteHandler(makeInteraction('9999999999'));

    expect((response as { type: number }).type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    const data = (response as { data: { custom_id: string } }).data;
    expect(data.custom_id).toBe('profile-complete');
  });
});
