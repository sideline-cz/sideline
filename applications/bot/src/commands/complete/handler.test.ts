import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { completeHandler } from '~/commands/complete/handler.js';

// ---------------------------------------------------------------------------
// Regression guard: locks the /complete profile modal JSON shape after the
// raw-literal -> dfx UI.* builder refactor. These assertions must keep passing
// unchanged if the construction mechanism changes again — only the mechanism
// should change, never the resulting Discord API payload. Structural (not a
// full snapshot) to avoid coupling to i18n copy.
// ---------------------------------------------------------------------------

const TEXT_INPUT_COMPONENT_TYPE = 4;
const ACTION_ROW_COMPONENT_TYPE = 1;
const TEXT_INPUT_STYLE_SHORT = 1;

/** Minimal APIInteraction for /complete, with an optional `gender` option value. */
const makeInteraction = (gender?: string): DiscordTypes.APIInteraction =>
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
      name: 'complete',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: gender !== undefined ? [{ name: 'gender', type: 3, value: gender }] : [],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runCompleteHandler = (interaction: DiscordTypes.APIInteraction) =>
  Effect.runPromise(completeHandler.pipe(Effect.provide(Layer.succeed(Interaction, interaction))));

type TextInputComponent = {
  type: number;
  custom_id: string;
  label: string;
  style: number;
  required: boolean;
  placeholder?: string;
  max_length: number;
};

type ActionRowComponent = {
  type: number;
  components: ReadonlyArray<TextInputComponent>;
};

describe('complete profile modal', () => {
  it('response type is MODAL', async () => {
    const response = await runCompleteHandler(makeInteraction('male'));

    expect((response as { type: number }).type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
  });

  it('modal custom_id is prefixed "profile-complete:" with the selected gender', async () => {
    const response = await runCompleteHandler(makeInteraction('female'));
    const data = (response as { data: { custom_id: string } }).data;

    expect(data.custom_id).toBe('profile-complete:female');
  });

  it('modal custom_id falls back to gender "other" when no option is given', async () => {
    const response = await runCompleteHandler(makeInteraction());
    const data = (response as { data: { custom_id: string } }).data;

    expect(data.custom_id).toBe('profile-complete:other');
  });

  it('has exactly 3 action rows, one text input per row', async () => {
    const response = await runCompleteHandler(makeInteraction('other'));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.type).toBe(ACTION_ROW_COMPONENT_TYPE);
      expect(row.components).toHaveLength(1);
      expect(row.components[0]?.type).toBe(TEXT_INPUT_COMPONENT_TYPE);
    }
  });

  it('rows carry the exact custom_ids, in order: name, birth_date, jersey_number', async () => {
    const response = await runCompleteHandler(makeInteraction('other'));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const customIds = rows.map((row) => row.components[0]?.custom_id);

    expect(customIds).toEqual(['profile_name', 'profile_birth_date', 'profile_jersey_number']);
  });

  it('all three text inputs use SHORT style (1)', async () => {
    const response = await runCompleteHandler(makeInteraction('other'));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const styles = rows.map((row) => row.components[0]?.style);

    expect(styles).toEqual([
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_SHORT,
    ]);
  });

  it('name and birth_date are required; jersey_number is optional', async () => {
    const response = await runCompleteHandler(makeInteraction('other'));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const required = rows.map((row) => row.components[0]?.required);

    expect(required).toEqual([true, true, false]);
  });

  it('preserves the exact max_length per field: name 100, birth_date 10, jersey_number 2', async () => {
    const response = await runCompleteHandler(makeInteraction('other'));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const maxLengths = rows.map((row) => row.components[0]?.max_length);

    expect(maxLengths).toEqual([100, 10, 2]);
  });
});
