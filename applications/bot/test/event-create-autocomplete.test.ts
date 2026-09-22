import { describe, expect, it } from '@effect/vitest';
import type { TrainingType } from '@sideline/domain';
import { FocusedOptionContext, Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { EventCreateAutocomplete } from '~/interactions/event-create-autocomplete.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// --- Test IDs ---
const TEST_GUILD_ID = '999999999999999999';
const TEST_TT_1 = '00000000-0000-0000-0000-000000000050' as TrainingType.TrainingTypeId;
const TEST_TT_2 = '00000000-0000-0000-0000-000000000051' as TrainingType.TrainingTypeId;
const TEST_TT_3 = '00000000-0000-0000-0000-000000000052' as TrainingType.TrainingTypeId;

const TRAINING_EVENT_TYPE_ID = 'et-training';
const MATCH_EVENT_TYPE_ID = 'et-match';

const mockTrainingTypes = [
  { id: TEST_TT_1, name: 'Fitness' },
  { id: TEST_TT_2, name: 'Tactics' },
  { id: TEST_TT_3, name: 'Strength Training' },
];

const mockEventTypes = [
  { id: TRAINING_EVENT_TYPE_ID, kind: 'training', name: Option.none() },
  { id: MATCH_EVENT_TYPE_ID, kind: 'match', name: Option.none() },
];

// ---------------------------------------------------------------------------
// Real-handler harness for `~/interactions/event-create-autocomplete.js`
// (the `training_type` autocomplete). Since a bot deploy after this PR sends
// an event-type ID (not a kind literal) in the `type` option, the handler
// must resolve that id via Event/GetEventTypesByGuild before deciding whether
// to offer training types — this harness exercises the REAL resolution
// logic, not a hand-rolled mirror of it.
// ---------------------------------------------------------------------------

const makeMockSyncRpc = (opts: {
  eventTypes?: Array<{ id: string; kind: string; name: Option.Option<string> }>;
  trainingTypes?: Array<{ id: string; name: string }>;
  eventTypesShouldFail?: boolean;
  trainingTypesShouldFail?: boolean;
}): SyncRpcClient => {
  const {
    eventTypes = mockEventTypes,
    trainingTypes = mockTrainingTypes,
    eventTypesShouldFail = false,
    trainingTypesShouldFail = false,
  } = opts;

  return new Proxy({} as SyncRpcClient, {
    get: (_target, prop) => {
      if (prop === 'Event/GetEventTypesByGuild') {
        return (_payload: { guild_id: string }) => {
          if (eventTypesShouldFail) {
            return Effect.fail({ _tag: 'RpcClientError', message: 'down' });
          }
          return Effect.succeed(eventTypes);
        };
      }
      if (prop === 'Event/GetTrainingTypesByGuild') {
        return (_payload: { guild_id: string }) => {
          if (trainingTypesShouldFail) {
            return Effect.fail({ _tag: 'RpcClientError', message: 'down' });
          }
          return Effect.succeed(trainingTypes);
        };
      }
      return () => Effect.void;
    },
  });
};

const makeAutocompleteInteraction = (
  guildId: string | undefined,
  eventTypeOptionValue: string,
): DiscordTypes.APIInteraction =>
  ({
    id: '444444444444444444' as DiscordTypes.Snowflake,
    application_id: '111111111111111111' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE,
    guild_id: guildId as unknown as DiscordTypes.Snowflake,
    locale: 'en-US',
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'event',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [
        {
          name: 'create',
          type: 1,
          options: [
            { name: 'type', type: 3, value: eventTypeOptionValue },
            { name: 'training_type', type: 3, value: '', focused: true },
          ],
        },
      ],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const runAutocomplete = (
  rpc: SyncRpcClient,
  interaction: DiscordTypes.APIInteraction,
  focusedValue: string,
) =>
  Effect.runPromise(
    EventCreateAutocomplete.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(
        Layer.succeed(FocusedOptionContext, {
          name: 'training_type',
          type: 3,
          value: focusedValue,
        } as unknown as InstanceType<typeof FocusedOptionContext>),
      ),
      Effect.provide(Layer.succeed(SyncRpc, rpc)),
    ) as Effect.Effect<unknown, never, never>,
  );

type AutocompleteResponse = { data: { choices: ReadonlyArray<{ name: string; value: string }> } };

describe('event-create-autocomplete handler (training_type option)', () => {
  it('offers training types when the selected event-type id resolves to kind === training', async () => {
    const rpc = makeMockSyncRpc({});
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, TRAINING_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, 'fit')) as AutocompleteResponse;

    // 1 match ("Fitness") + the always-present "Other" sentinel choice.
    expect(response.data.choices.map((c) => c.value)).toContain(TEST_TT_1);
  });

  it('offers all training types (plus "Other") when query is empty and kind resolves to training', async () => {
    const rpc = makeMockSyncRpc({});
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, TRAINING_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, '')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(mockTrainingTypes.length + 1);
  });

  it('does NOT offer training types when the selected event-type id resolves to a non-training kind (match)', async () => {
    const rpc = makeMockSyncRpc({});
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, MATCH_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, '')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(0);
  });

  it('does NOT offer training types when the event-type id is unknown to the team (RPC returned no matching row)', async () => {
    const rpc = makeMockSyncRpc({});
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, 'not-a-real-event-type-id');

    const response = (await runAutocomplete(rpc, interaction, '')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(0);
  });

  it('returns empty choices when no guild_id is present', async () => {
    const rpc = makeMockSyncRpc({});
    const interaction = makeAutocompleteInteraction(undefined, TRAINING_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, 'fit')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(0);
  });

  it('returns empty choices when Event/GetEventTypesByGuild fails (never throws)', async () => {
    const rpc = makeMockSyncRpc({ eventTypesShouldFail: true });
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, TRAINING_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, '')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(0);
  });

  it('returns empty choices when Event/GetTrainingTypesByGuild fails (never throws)', async () => {
    const rpc = makeMockSyncRpc({ trainingTypesShouldFail: true });
    const interaction = makeAutocompleteInteraction(TEST_GUILD_ID, TRAINING_EVENT_TYPE_ID);

    const response = (await runAutocomplete(rpc, interaction, '')) as AutocompleteResponse;

    expect(response.data.choices).toHaveLength(0);
  });
});

describe('event-create modal custom_id parsing', () => {
  // Tests for parsing the modal custom_id format:
  // `event-create:{eventTypeIdOrKind}:{trainingTypeId}`
  //
  // Structural parsing only (segment split) — the semantic distinction
  // between a legacy kind literal and a current event-type id is covered by
  // test/interactions/event-create-legacy-modal.test.ts against the real
  // handler.

  const parseModalCustomId = (
    customId: string,
  ): { eventType: string; trainingTypeId: Option.Option<string> } => {
    const parts = customId.split(':');
    const eventType = parts[1] ?? 'other';
    const trainingTypeId = parts[2] ? Option.some(parts[2]) : Option.none();
    return { eventType, trainingTypeId };
  };

  it('parses eventType and trainingTypeId from 3-segment custom_id', () => {
    const { eventType, trainingTypeId } = parseModalCustomId(`event-create:training:${TEST_TT_1}`);
    expect(eventType).toBe('training');
    expect(Option.isSome(trainingTypeId)).toBe(true);
    expect(Option.getOrNull(trainingTypeId)).toBe(TEST_TT_1);
  });

  it('handles 2-segment custom_id (legacy, no training type)', () => {
    const { eventType, trainingTypeId } = parseModalCustomId('event-create:match');
    expect(eventType).toBe('match');
    expect(Option.isNone(trainingTypeId)).toBe(true);
  });

  it('handles 2-segment custom_id with training event type (no training type selected)', () => {
    const { eventType, trainingTypeId } = parseModalCustomId('event-create:training');
    expect(eventType).toBe('training');
    expect(Option.isNone(trainingTypeId)).toBe(true);
  });

  it('handles other event types in 3-segment custom_id', () => {
    const { eventType, trainingTypeId } = parseModalCustomId('event-create:match:some-id');
    expect(eventType).toBe('match');
    expect(Option.isSome(trainingTypeId)).toBe(true);
    expect(Option.getOrNull(trainingTypeId)).toBe('some-id');
  });
});
