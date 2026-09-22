import { Discord as DiscordSchemas } from '@sideline/domain';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { eventTypeKindLabel } from '~/rest/events/eventTypeKindLabel.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

// Clone of event-create-autocomplete.ts (training_type) for the `type` option itself. Event
// types are per-team, so — unlike the old hardcoded `choices` — this has to be a live RPC
// lookup (see commands/event/index.ts's comment on why `choices` was deleted).
export const EventTypeAutocomplete = Ix.autocomplete(
  (data, focused) => data.name === 'event' && focused.name === 'type',
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'autocomplete' }),
        1,
      ),
    ),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.flatMap(({ interaction, rpc }) => {
      const guildId = interaction.guild_id;

      if (!guildId) {
        return Effect.succeed(
          Ix.response({
            type: DiscordTypes.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [] },
          }),
        );
      }

      const locale = userLocale(interaction);

      // The RPC already orders rows by the team's `position` — no client-side sort here.
      return rpc['Event/GetEventTypesByGuild']({ guild_id: decodeSnowflake(guildId) }).pipe(
        Effect.map((types) =>
          pipe(
            [...types],
            Array.map((t) => ({
              name: Option.getOrElse(t.name, () => eventTypeKindLabel(t.kind, locale)).slice(
                0,
                100,
              ),
              value: t.id,
            })),
            Array.take(25),
          ),
        ),
        Effect.tapError((err) => Effect.logError('[autocomplete] RPC error', err)),
        // An autocomplete must never fail the interaction (Discord's 3s budget) — RPC down
        // just means no suggestions, never a thrown error.
        Effect.catchTag('RpcClientError', () =>
          Effect.succeed<ReadonlyArray<{ name: string; value: string }>>([]),
        ),
        // Same guarantee as the RpcClientError catch above, for an untagged defect (a died
        // fiber, a schema-decode throw) — an autocomplete must never fail the interaction.
        Effect.catchDefect(() =>
          Effect.succeed<ReadonlyArray<{ name: string; value: string }>>([]),
        ),
        Effect.map((choices) =>
          Ix.response({
            type: DiscordTypes.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices },
          }),
        ),
      );
    }),
    Effect.withSpan('interaction/event-type-autocomplete'),
  ),
);
