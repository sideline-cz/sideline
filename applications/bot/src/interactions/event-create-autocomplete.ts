import { Discord as DiscordSchemas } from '@sideline/domain';
import * as Ix from 'dfx/Interactions/index';
import { FocusedOptionContext, Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, pipe, Schema } from 'effect';
import { discordInteractionsTotal } from '~/metrics.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

export const EventCreateAutocomplete = Ix.autocomplete(
  (data, focused) => data.name === 'event' && focused.name === 'training_type',
  Effect.Do.pipe(
    Effect.tap(() =>
      Metric.update(
        Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'autocomplete' }),
        1,
      ),
    ),
    Effect.bind('interaction', () => Interaction.asEffect()),
    Effect.bind('focused', () => FocusedOptionContext.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.tap(() => Effect.logInfo('[autocomplete] handler invoked')),
    Effect.flatMap(({ interaction, focused, rpc }) => {
      const guildId = interaction.guild_id;
      const data = interaction.data;

      // For subcommands, options are nested: data.options[0] = "create" subcommand,
      // and the actual options (type, training_type) are in data.options[0].options
      const subCommandOptions =
        data && 'options' in data && data.options?.[0] && 'options' in data.options[0]
          ? (data.options[0].options ?? [])
          : [];

      // `type` now carries an event-type id (or, for an in-flight command, a legacy kind
      // literal — see interactions/event-create.ts's B6 handling), never the kind directly.
      // Resolving whether it's a `training` type takes its own RPC lookup.
      const eventTypeId = pipe(
        [...subCommandOptions],
        Array.findFirst((o) => o.name === 'type'),
        Option.flatMap((o) => ('value' in o ? Option.some(String(o.value)) : Option.none())),
        Option.getOrElse(() => ''),
      );

      if (!guildId) {
        return Effect.succeed(
          Ix.response({
            type: DiscordTypes.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices: [] },
          }),
        );
      }

      const query =
        focused && 'value' in focused && typeof focused.value === 'string' ? focused.value : '';

      return rpc['Event/GetEventTypesByGuild']({ guild_id: decodeSnowflake(guildId) }).pipe(
        Effect.flatMap((eventTypes) => {
          const isTraining = pipe(
            eventTypes,
            Array.findFirst((t) => t.id === eventTypeId),
            Option.exists((t) => t.kind === 'training'),
          );

          if (!isTraining) {
            return Effect.logInfo(
              `[autocomplete] skipping: eventTypeId=${eventTypeId}, options=${JSON.stringify(subCommandOptions)}`,
            ).pipe(Effect.as<ReadonlyArray<{ name: string; value: string }>>([]));
          }

          return rpc['Event/GetTrainingTypesByGuild']({
            guild_id: decodeSnowflake(guildId),
          }).pipe(
            Effect.map((types) => [
              ...pipe(
                [...types],
                Array.filter((tt) => tt.name.toLowerCase().includes(query.toLowerCase())),
                Array.map((tt) => ({
                  name: tt.name.slice(0, 100),
                  value: tt.id,
                })),
                Array.take(24),
              ),
              { name: 'Other', value: '' },
            ]),
          );
        }),
        Effect.tapError((err) => Effect.logError('[autocomplete] RPC error', err)),
        Effect.catchTag('RpcClientError', () =>
          Effect.succeed<ReadonlyArray<{ name: string; value: string }>>([]),
        ),
        // Same guarantee as the RpcClientError catch above, for an untagged defect (a died
        // fiber, a schema-decode throw) — an autocomplete must never fail the interaction.
        Effect.catchDefect(() =>
          Effect.succeed<ReadonlyArray<{ name: string; value: string }>>([]),
        ),
        Effect.tap((choices) =>
          Effect.logInfo(`[autocomplete] returning ${choices.length} choices`),
        ),
        Effect.map((choices) =>
          Ix.response({
            type: DiscordTypes.InteractionCallbackTypes.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT,
            data: { choices },
          }),
        ),
      );
    }),
    Effect.withSpan('interaction/event-create-autocomplete'),
  ),
);
