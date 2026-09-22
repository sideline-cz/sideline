// TDD mode — written BEFORE `~/interactions/profile-verify.ts` exists.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
// Pattern: applications/bot/src/interactions/upcoming-rsvp.test.ts's
// `makeComponentInteraction` helper, reused verbatim — no RPC stub is needed
// (a `MODAL` response cannot be deferred and makes no RPC call).
//
// Spec: .work-plans/discord-full-onboarding.md, Task 7 ("a Verify button that
// opens the profile modal") and its "Test specification" §Task 7.

import * as m from '@sideline/i18n/messages';
import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildVerifyButton, ProfileVerifyButton } from '~/interactions/profile-verify.js';

const GUILD_ID = '600000000000000001' as DiscordTypes.Snowflake;
const CHANNEL_ID = '600000000000000010' as DiscordTypes.Snowflake;
const USER_DISCORD_ID = '600000000000000030' as DiscordTypes.Snowflake;
const APP_ID = '600000000000000040' as DiscordTypes.Snowflake;
const INTERACTION_TOKEN = 'test-interaction-token';

const makeComponentInteraction = (
  customId: string,
  guildId: DiscordTypes.Snowflake | undefined,
): DiscordTypes.APIInteraction =>
  ({
    id: '1234567890' as DiscordTypes.Snowflake,
    application_id: APP_ID,
    token: INTERACTION_TOKEN,
    version: 1,
    type: DiscordTypes.InteractionTypes.MESSAGE_COMPONENT,
    ...(guildId !== undefined ? { guild_id: guildId } : {}),
    channel_id: CHANNEL_ID,
    ...(guildId !== undefined
      ? {
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
        }
      : {
          // Pressed in a DM: no `guild_id`, no `member` — the user rides at
          // the top level instead (matches handler.ts:18-26's guard).
          user: {
            id: USER_DISCORD_ID,
            username: 'testuser',
            discriminator: '0001',
            global_name: null,
            avatar: null,
          },
        }),
    locale: 'en-US',
    data: {
      component_type: 2,
      custom_id: customId,
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runHandler = (interaction: DiscordTypes.APIInteraction) =>
  Effect.runPromise(
    ProfileVerifyButton.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(
          MessageComponentData,
          interaction.data as DiscordTypes.APIMessageComponentInteractionData,
        ),
      ),
    ) as Effect.Effect<unknown, never, never>,
  );

describe('ProfileVerifyButton', () => {
  it('button → MODAL, data.custom_id === "profile-complete"', async () => {
    const response = await runHandler(makeComponentInteraction('profile-verify', GUILD_ID));
    const typed = response as { type: number; data: { custom_id: string } };

    expect(typed.type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    expect(typed.data.custom_id).toBe('profile-complete');
  });

  it('the modal response is NOT deferred — no DEFERRED_* callback type', async () => {
    const response = await runHandler(makeComponentInteraction('profile-verify', GUILD_ID));
    const typed = response as { type: number };

    expect(typed.type).not.toBe(
      DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    );
    expect(typed.type).not.toBe(DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE);
  });

  it('no guild_id (pressed in a DM) → ephemeral bot_complete_no_guild, no modal', async () => {
    const response = await runHandler(makeComponentInteraction('profile-verify', undefined));
    const typed = response as {
      type: number;
      data: { content: string; flags: number };
    };

    expect(typed.type).toBe(DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(typed.data.content).toBe(m.bot_complete_no_guild({}, { locale: 'en' }));
    expect(typed.data.flags).toBe(DiscordTypes.MessageFlags.Ephemeral);
  });
});

describe('buildVerifyButton — mints the single entry id used by tasks 8, 9 and 10', () => {
  it('custom_id is exactly "profile-verify" (14 chars), well under the 100-char cap', () => {
    const button = buildVerifyButton('en');
    expect(button.custom_id).toBe('profile-verify');
    expect(button.custom_id.length).toBe(14);
    expect(button.custom_id.length).toBeLessThanOrEqual(100);
  });

  it('style is 1 (PRIMARY)', () => {
    const button = buildVerifyButton('en');
    expect(button.style).toBe(1);
  });

  it('label is locale-driven — en and cs differ', () => {
    const en = buildVerifyButton('en');
    const cs = buildVerifyButton('cs');
    expect(en.label).toBe(m.bot_verify_button({}, { locale: 'en' }));
    expect(cs.label).toBe(m.bot_verify_button({}, { locale: 'cs' }));
    expect(en.label).not.toBe(cs.label);
  });

  it("carries no state — the same button shape regardless of locale's custom_id", () => {
    const en = buildVerifyButton('en');
    const cs = buildVerifyButton('cs');
    expect(en.custom_id).toBe(cs.custom_id);
  });
});
