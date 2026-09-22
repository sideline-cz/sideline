/**
 * Tests for the /event create `type` autocomplete handler
 * (src/interactions/event-type-autocomplete.ts).
 *
 * Event types are per-team, so (unlike the old hardcoded `choices`) this is a
 * live RPC lookup via Event/GetEventTypesByGuild. The handler trusts the RPC's
 * own ordering (the server already orders by `position`) and never sorts
 * client-side. An autocomplete must never fail the interaction (Discord's 3s
 * budget) — an RPC failure degrades to `{ choices: [] }`, never a throw.
 *
 * `EventTypeAutocomplete` is a dfx `Ix.autocomplete(predicate, handle)` value;
 * we run `.handle` directly (mirrors how event-create.test.ts runs
 * `EventCreateModalSubmit` directly rather than the `Ix.modalSubmit` wrapper),
 * since the predicate itself is only consulted by dfx's own dispatcher.
 */

import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { EventTypeAutocomplete } from '~/interactions/event-type-autocomplete.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const GUILD_ID = '222222222222222222' as DiscordTypes.Snowflake;

const makeAutocompleteInteraction = (): DiscordTypes.APIInteraction =>
  ({
    id: '444444444444444444' as DiscordTypes.Snowflake,
    application_id: '111111111111111111' as DiscordTypes.Snowflake,
    token: 'interaction-token',
    version: 1,
    type: DiscordTypes.InteractionTypes.APPLICATION_COMMAND_AUTOCOMPLETE,
    guild_id: GUILD_ID,
    locale: 'en-US',
    data: {
      id: 'cmd-id' as DiscordTypes.Snowflake,
      name: 'event',
      type: DiscordTypes.ApplicationCommandType.CHAT,
      options: [
        {
          name: 'create',
          type: 1,
          options: [{ name: 'type', type: 3, value: '', focused: true }],
        },
      ],
    },
  }) as unknown as DiscordTypes.APIInteraction;

const makeRpcLayer = (
  getEventTypesByGuild: (payload: { guild_id: string }) => Effect.Effect<unknown, unknown>,
) => {
  const rpcStub = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === 'Event/GetEventTypesByGuild') return getEventTypesByGuild;
      return () => Effect.void;
    },
  });
  return Layer.succeed(SyncRpc, rpcStub as unknown as InstanceType<typeof SyncRpc>);
};

const runAutocomplete = (
  rpcLayer: Layer.Layer<SyncRpc>,
  interaction: DiscordTypes.APIInteraction,
) =>
  Effect.runPromise(
    EventTypeAutocomplete.handle.pipe(
      Effect.provide(Layer.succeed(Interaction, interaction)),
      Effect.provide(rpcLayer),
    ) as Effect.Effect<unknown, never, never>,
  );

describe('event-type-autocomplete handler', () => {
  it("returns the team's event types as choices, preserving the server's position order", async () => {
    // The RPC's own ordering already reflects the team's `position`; deliberately out of
    // alphabetical/id order here to prove the handler does not re-sort client-side.
    const rpcLayer = makeRpcLayer(() =>
      Effect.succeed([
        { id: 'id-social', kind: 'social', name: Option.none() },
        { id: 'id-training', kind: 'training', name: Option.some('Ranní trénink') },
        { id: 'id-match', kind: 'match', name: Option.none() },
      ]),
    );

    const response = (await runAutocomplete(rpcLayer, makeAutocompleteInteraction())) as {
      data: { choices: ReadonlyArray<{ name: string; value: string }> };
    };

    expect(response.data.choices.map((c) => c.value)).toEqual([
      'id-social',
      'id-training',
      'id-match',
    ]);
  });

  it('a row whose name is None falls back to the localized kind label', async () => {
    const rpcLayer = makeRpcLayer(() =>
      Effect.succeed([{ id: 'id-social', kind: 'social', name: Option.none() }]),
    );

    const response = (await runAutocomplete(rpcLayer, makeAutocompleteInteraction())) as {
      data: { choices: ReadonlyArray<{ name: string; value: string }> };
    };

    expect(response.data.choices).toHaveLength(1);
    // en locale kind label for 'social' — see rest/events/eventTypeKindLabel.ts / m.event_type_social.
    expect(response.data.choices[0]?.name).not.toBe('');
    expect(response.data.choices[0]?.value).toBe('id-social');
  });

  it('a row with a custom name renders that name verbatim, not the kind label', async () => {
    const rpcLayer = makeRpcLayer(() =>
      Effect.succeed([{ id: 'id-training', kind: 'training', name: Option.some('Ranní trénink') }]),
    );

    const response = (await runAutocomplete(rpcLayer, makeAutocompleteInteraction())) as {
      data: { choices: ReadonlyArray<{ name: string; value: string }> };
    };

    expect(response.data.choices[0]?.name).toBe('Ranní trénink');
  });

  it('an RPC failure returns { choices: [] } and never throws', async () => {
    const rpcLayer = makeRpcLayer(() => Effect.fail({ _tag: 'RpcClientError', message: 'down' }));

    const response = (await runAutocomplete(rpcLayer, makeAutocompleteInteraction())) as {
      data: { choices: ReadonlyArray<unknown> };
    };

    expect(response.data.choices).toEqual([]);
  });

  it('an RPC defect (untagged failure) still resolves without throwing', async () => {
    const rpcLayer = makeRpcLayer(() => Effect.die(new Error('unexpected')));

    // Must not reject: an autocomplete handler dying kills the interaction outright.
    await expect(runAutocomplete(rpcLayer, makeAutocompleteInteraction())).resolves.toBeDefined();
  });

  it('no guild_id → returns { choices: [] } without calling the RPC', async () => {
    let called = false;
    const rpcLayer = makeRpcLayer(() => {
      called = true;
      return Effect.succeed([]);
    });
    const interaction = {
      ...makeAutocompleteInteraction(),
      guild_id: undefined,
    } as unknown as DiscordTypes.APIInteraction;

    const response = (await runAutocomplete(rpcLayer, interaction)) as {
      data: { choices: ReadonlyArray<unknown> };
    };

    expect(response.data.choices).toEqual([]);
    expect(called).toBe(false);
  });
});
