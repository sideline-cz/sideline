import { Discord as DiscordSchemas } from '@sideline/domain';
import * as Ix from 'dfx/Interactions/index';
import { FocusedOptionContext, Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, Effect, Metric, Option, Order, pipe, Schema } from 'effect';
import { discordInteractionsTotal } from '~/metrics.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

export const MakanickoLogAutocomplete = Ix.autocomplete(
  (data, focused) => data.name === 'makanicko' && focused.name === 'activity',
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
    Effect.flatMap(({ interaction, focused, rpc }) => {
      const guildId = interaction.guild_id;

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

      return rpc['Activity/GetActivityTypesByGuild']({
        guild_id: decodeSnowflake(guildId),
      }).pipe(
        Effect.map((types) => {
          const queryLower = query.toLowerCase();

          const filtered = pipe(
            [...types],
            Array.filter(
              (t) =>
                !(Option.isSome(t.slug) && t.slug.value === 'training') &&
                t.name.toLowerCase().includes(queryLower),
            ),
          );

          const byName = Order.make<{ name: string }>((a, b) => {
            const cmp = a.name.localeCompare(b.name);
            return cmp < 0 ? -1 : cmp > 0 ? 1 : 0;
          });

          const globals = pipe(
            filtered,
            Array.filter((t) => t.isGlobal),
            Array.sort(byName),
          );

          const customs = pipe(
            filtered,
            Array.filter((t) => !t.isGlobal),
            Array.sort(byName),
          );

          return pipe(
            [...globals, ...customs],
            Array.take(25),
            Array.map((t) => ({
              name: Option.isSome(t.emoji) ? `${t.emoji.value} ${t.name}` : t.name,
              value: t.id,
            })),
          );
        }),
        Effect.tapError((err) => Effect.logError('[makanicko-autocomplete] RPC error', err)),
        Effect.catchTag('RpcClientError', () =>
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
    Effect.withSpan('interaction/makanicko-log-autocomplete'),
  ),
);
