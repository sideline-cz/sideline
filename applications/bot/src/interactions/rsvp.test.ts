// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// Regression guard: locks the CURRENT hand-built MODAL JSON shape produced
// by RsvpAddMessageButton, ahead of the dfx UI.* builder refactor. The
// payload shape must stay byte-for-byte identical once the production code
// is rewritten to use dfx builders.

import { Interaction, MessageComponentData } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { RsvpAddMessageButton } from '~/interactions/rsvp.js';
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
  // RsvpAddMessageButton is the Ix.messageComponent(...) registration wrapper;
  // the handler Effect lives on its `.handle` property.
  return Effect.runPromise(
    RsvpAddMessageButton.handle.pipe(
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

describe('RsvpAddMessageButton modal shape', () => {
  it('returns a MODAL response with custom_id "rsvp-modal:<teamId>:<eventId>:<response>"', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as { type: number; data: { custom_id: string } };

    expect(typed.type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
    expect(typed.data.custom_id).toBe(`rsvp-modal:${TEAM_ID}:${EVENT_ID}:yes`);
  });

  it('has exactly one action row with one PARAGRAPH-style text input, custom_id "rsvp_message"', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
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

  // ---------------------------------------------------------------------------
  // coming_later — the message is REQUIRED (server enforces via
  // RsvpMessageRequired), so the modal's text input must be built with
  // required: true. yes/no keep required: false (message optional).
  // ---------------------------------------------------------------------------

  it('builds the text input with required: true for coming_later', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:coming_later`);
    const typed = response as {
      data: {
        components: ReadonlyArray<{ type: number; components: ReadonlyArray<TextInputComponent> }>;
      };
    };
    const input = typed.data.components[0]?.components[0];
    expect(input?.required).toBe(true);
    expect(input?.label).toBe('Add a reason (required)');
  });

  it('builds the text input with required: false for yes', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as {
      data: {
        components: ReadonlyArray<{ type: number; components: ReadonlyArray<TextInputComponent> }>;
      };
    };
    const input = typed.data.components[0]?.components[0];
    expect(input?.required).toBe(false);
  });

  it('builds the text input with required: false for no', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:no`);
    const typed = response as {
      data: {
        components: ReadonlyArray<{ type: number; components: ReadonlyArray<TextInputComponent> }>;
      };
    };
    const input = typed.data.components[0]?.components[0];
    expect(input?.required).toBe(false);
  });

  it('modal custom_id for coming_later is "rsvp-modal:<teamId>:<eventId>:coming_later"', async () => {
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:coming_later`);
    const typed = response as { data: { custom_id: string } };
    expect(typed.data.custom_id).toBe(`rsvp-modal:${TEAM_ID}:${EVENT_ID}:coming_later`);
  });
  // ---------------------------------------------------------------------------
  // Prefill — the modal must show the member's existing note so "Edit message"
  // doesn't read as though the note was lost.
  // ---------------------------------------------------------------------------

  it("prefills the text input with the member's stored note", async () => {
    const response = await runHandler(
      `rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`,
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
    const response = await runHandler(`rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`);
    const typed = response as {
      data: { components: ReadonlyArray<{ components: ReadonlyArray<object> }> };
    };
    expect(typed.data.components[0]?.components[0]).not.toHaveProperty('value');
  });

  it('falls back to an empty modal when the prefill RPC fails', async () => {
    const response = await runHandler(
      `rsvp-add-msg:${TEAM_ID}:${EVENT_ID}:yes`,
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
