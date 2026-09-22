import * as m from '@sideline/i18n/messages';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { createHandler } from '~/commands/event/create.js';
import { userLocale } from '~/locale.js';

// ---------------------------------------------------------------------------
// Regression guard: locks the CURRENT hand-built modal JSON shape for
// /event create, ahead of the dfx UI.* builder refactor. These assertions
// must keep passing unchanged once the production code is rewritten to use
// dfx builders — only the construction mechanism should change, not the
// resulting Discord API payload.
//
// `type` is now a per-team event-type id (or, for an in-flight command, a
// legacy kind literal — see interactions/event-create.ts's B6 handling),
// never one of the six hardcoded kind literals directly — Discord no longer
// registers static `choices` for it (they can't be per-team). Fixtures below
// use a real UUID as the "valid" case.
// ---------------------------------------------------------------------------

const TEXT_INPUT_COMPONENT_TYPE = 4;
const ACTION_ROW_COMPONENT_TYPE = 1;
const TEXT_INPUT_STYLE_SHORT = 1;
const TEXT_INPUT_STYLE_PARAGRAPH = 2;

const VALID_EVENT_TYPE_ID = '11111111-2222-4333-8444-555555555555';

/** Minimal APIInteraction for the /event create (sub)command, with an optional `type` option value. */
const makeInteraction = (eventType?: string): DiscordTypes.APIInteraction =>
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
      name: 'event',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [
        {
          name: 'create',
          type: 1,
          options: eventType !== undefined ? [{ name: 'type', type: 3, value: eventType }] : [],
        },
      ],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runCreateHandler = (interaction: DiscordTypes.APIInteraction) =>
  Effect.runPromise(createHandler.pipe(Effect.provide(Layer.succeed(Interaction, interaction))));

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

describe('event create modal', () => {
  it('modal custom_id is prefixed "event-create:" with the event type id and training type id', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));
    const data = (response as { data: { custom_id: string } }).data;

    expect(data.custom_id).toBe(`event-create:${VALID_EVENT_TYPE_ID}:`);
  });

  it('modal custom_id accepts a legacy kind literal too (in-flight /event create against the old bot registration)', async () => {
    const response = await runCreateHandler(makeInteraction('training'));
    const data = (response as { data: { custom_id: string } }).data;

    expect(data.custom_id).toBe('event-create:training:');
  });

  it('response type is MODAL', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));

    expect((response as { type: number }).type).toBe(DiscordTypes.InteractionCallbackTypes.MODAL);
  });

  it('has exactly 5 action rows, one text input per row', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.type).toBe(ACTION_ROW_COMPONENT_TYPE);
      expect(row.components).toHaveLength(1);
      expect(row.components[0]?.type).toBe(TEXT_INPUT_COMPONENT_TYPE);
    }
  });

  it('rows carry the exact custom_ids, in order: title, start, end, location, description', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const customIds = rows.map((row) => row.components[0]?.custom_id);

    expect(customIds).toEqual([
      'event_title',
      'event_start',
      'event_end',
      'event_location',
      'event_description',
    ]);
  });

  it('first four text inputs use SHORT style (1); description uses PARAGRAPH style (2)', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const styles = rows.map((row) => row.components[0]?.style);

    expect(styles).toEqual([
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_SHORT,
      TEXT_INPUT_STYLE_PARAGRAPH,
    ]);
  });

  it('title and start are required; end, location, description are optional', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));
    const rows = (response as { data: { components: ReadonlyArray<ActionRowComponent> } }).data
      .components;
    const required = rows.map((row) => row.components[0]?.required);

    expect(required).toEqual([true, true, false, false, false]);
  });

  it('matches the exact current modal JSON shape (full structural snapshot)', async () => {
    const response = await runCreateHandler(makeInteraction(VALID_EVENT_TYPE_ID));

    expect(response).toMatchInlineSnapshot(`
      {
        "data": {
          "components": [
            {
              "components": [
                {
                  "custom_id": "event_title",
                  "label": "Title",
                  "max_length": 100,
                  "required": true,
                  "style": 1,
                  "type": 4,
                },
              ],
              "type": 1,
            },
            {
              "components": [
                {
                  "custom_id": "event_start",
                  "label": "Start (YYYY-MM-DD HH:mm)",
                  "max_length": 16,
                  "placeholder": "2026-03-10 18:00",
                  "required": true,
                  "style": 1,
                  "type": 4,
                },
              ],
              "type": 1,
            },
            {
              "components": [
                {
                  "custom_id": "event_end",
                  "label": "End (YYYY-MM-DD HH:mm)",
                  "max_length": 16,
                  "placeholder": "2026-03-10 19:30",
                  "required": false,
                  "style": 1,
                  "type": 4,
                },
              ],
              "type": 1,
            },
            {
              "components": [
                {
                  "custom_id": "event_location",
                  "label": "Location",
                  "max_length": 200,
                  "placeholder": "e.g. Main Field",
                  "required": false,
                  "style": 1,
                  "type": 4,
                },
              ],
              "type": 1,
            },
            {
              "components": [
                {
                  "custom_id": "event_description",
                  "label": "Description",
                  "max_length": 1000,
                  "required": false,
                  "style": 2,
                  "type": 4,
                },
              ],
              "type": 1,
            },
          ],
          "custom_id": "event-create:11111111-2222-4333-8444-555555555555:",
          "title": "Create Event",
        },
        "type": 9,
      }
    `);
  });

  // ---------------------------------------------------------------------------
  // B7 guard — Discord does not constrain autocomplete values, so a user can
  // type anything, especially when the RPC was down at the time. `type` must
  // decode as a real uuid or one of the six legacy kind literals; anything
  // else is rejected with an ephemeral error and NO modal is opened.
  // ---------------------------------------------------------------------------

  describe('B7 — unrecognized `type` value', () => {
    it('a type value that is neither a uuid nor a kind literal → ephemeral error, no modal opened', async () => {
      const interaction = makeInteraction('literally anything the user typed');
      const response = await runCreateHandler(interaction);

      expect((response as { type: number }).type).toBe(
        DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      );
      const locale = userLocale(interaction);
      expect((response as { data: { content: string } }).data.content).toBe(
        m.bot_event_unknown_type({}, { locale }),
      );
      expect((response as { data: { flags?: number } }).data.flags).toBe(
        DiscordTypes.MessageFlags.Ephemeral,
      );
    });

    it('no `type` option at all → ephemeral error, no modal opened', async () => {
      const interaction = makeInteraction();
      const response = await runCreateHandler(interaction);

      expect((response as { type: number }).type).toBe(
        DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      );
      const locale = userLocale(interaction);
      expect((response as { data: { content: string } }).data.content).toBe(
        m.bot_event_unknown_type({}, { locale }),
      );
    });

    it('a value that merely looks close to a uuid, but is not one, → ephemeral error, no modal opened', async () => {
      const interaction = makeInteraction('11111111-2222-4333-8444-55555555555'); // 35 chars, one short
      const response = await runCreateHandler(interaction);

      expect((response as { type: number }).type).toBe(
        DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // custom_id length — Discord rejects the WHOLE message (error 50035) if any
  // component custom_id exceeds 100 characters. `event-create:<uuid>:<uuid>`
  // = 13 + 36 + 1 + 36 = 86 chars; must stay comfortably inside the budget.
  // ---------------------------------------------------------------------------

  describe('custom_id length budget', () => {
    it('custom_id built from a valid event-type id and training-type id is <= 100 chars', async () => {
      const interaction: DiscordTypes.APIInteraction = {
        ...makeInteraction(VALID_EVENT_TYPE_ID),
        data: {
          id: 'cmd-id' as DiscordTypes.Snowflake,
          name: 'event',
          type: DiscordTypes.ApplicationCommandType.CHAT,
          options: [
            {
              name: 'create',
              type: 1,
              options: [
                { name: 'type', type: 3, value: VALID_EVENT_TYPE_ID },
                {
                  name: 'training_type',
                  type: 3,
                  value: '66666666-7777-4888-8999-aaaaaaaaaaaa',
                },
              ],
            },
          ],
        },
      } as unknown as DiscordTypes.APIInteraction;

      const response = await runCreateHandler(interaction);
      const customId = (response as { data: { custom_id: string } }).data.custom_id;

      expect(customId.length).toBeLessThanOrEqual(100);
    });
  });
});
