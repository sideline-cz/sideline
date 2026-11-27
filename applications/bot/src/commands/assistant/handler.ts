import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

const THREAD_NAME_MAX = 100;
// Archive after a day of silence; the owner can reopen it just by posting.
const AUTO_ARCHIVE_MINUTES = 1440;

const ephemeral = (content: string) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: DiscordTypes.MessageFlags.Ephemeral },
  });

/** `private` unless the invoker explicitly picked `public`. */
export const isPublicThread = (interaction: DiscordTypes.APIInteraction): boolean => {
  const data = interaction.data;
  const options = data !== undefined && 'options' in data ? (data.options ?? []) : [];
  return options.some((o) => o.name === 'visibility' && 'value' in o && o.value === 'public');
};

/**
 * `/assistant`: check the invoker can use the assistant, open a thread in this channel, register
 * it as theirs, and greet them in it. A refused user gets an ephemeral reply and no thread.
 */
export const assistantHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const userIdOption = interactionUserId(interaction);
    const channelId = interaction.channel_id;
    const guildId = interaction.guild_id;
    if (Option.isNone(userIdOption) || channelId === undefined || guildId === undefined) {
      return Effect.succeed(ephemeral(m.bot_assistant_thread_failed({}, { locale })));
    }
    const userId = userIdOption.value;
    const actor = { guild_id: decodeSnowflake(guildId), discord_user_id: userId };
    const user = interaction.member?.user ?? interaction.user;
    const displayName = interaction.member?.nick ?? user?.global_name ?? user?.username ?? userId;
    const isPublic = isPublicThread(interaction);

    const work = Effect.Do.pipe(
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.flatMap(({ rest, rpc }) => {
        const reply = (content: string) =>
          rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
            payload: { content, allowed_mentions: { parse: [] } },
          });

        const openThread = Effect.suspend(() =>
          rest
            .createThread(channelId, {
              name: m
                .bot_assistant_thread_name(
                  { name: displayName },
                  { locale: guildLocale(interaction) },
                )
                .slice(0, THREAD_NAME_MAX),
              type: isPublic
                ? DiscordTypes.ChannelTypes.PUBLIC_THREAD
                : DiscordTypes.ChannelTypes.PRIVATE_THREAD,
              auto_archive_duration: AUTO_ARCHIVE_MINUTES,
            })
            .pipe(
              Effect.tap((thread) =>
                rpc['Assistant/RegisterThread']({
                  ...actor,
                  thread_id: decodeSnowflake(thread.id),
                }).pipe(
                  // An unregistered thread would ignore every message: remove it rather than
                  // leave a dead thread behind.
                  Effect.tapError(() => rest.deleteChannel(thread.id).pipe(Effect.ignore)),
                ),
              ),
              Effect.tap((thread) => rest.addThreadMember(thread.id, userId)),
              Effect.tap((thread) =>
                rest.createMessage(thread.id, {
                  content: m.bot_assistant_greeting({ user: `<@${userId}>` }, { locale }),
                  allowed_mentions: { users: [userId] },
                }),
              ),
              Effect.flatMap((thread) =>
                reply(m.bot_assistant_opened({ thread: `<#${thread.id}>` }, { locale })),
              ),
              Effect.catchTag(
                ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                (error) =>
                  Effect.logWarning('Assistant: failed to open thread', error).pipe(
                    Effect.andThen(reply(m.bot_assistant_thread_failed({}, { locale }))),
                  ),
              ),
            ),
        );

        return rpc['Assistant/Authorize'](actor).pipe(
          Effect.flatMap(({ enabled }) =>
            enabled ? openThread : reply(m.bot_assistant_disabled({}, { locale })),
          ),
          Effect.catchTag('AssistantNotLinked', () =>
            reply(m.bot_assistant_not_linked({}, { locale })),
          ),
          Effect.catchTag('AssistantNotMember', () =>
            reply(m.bot_assistant_not_member({}, { locale })),
          ),
          Effect.catchCause((cause) =>
            Effect.logError('Assistant: command failed', cause).pipe(
              Effect.andThen(reply(m.bot_assistant_error({}, { locale }))),
              Effect.ignore,
            ),
          ),
        );
      }),
    );

    const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    };
    return Effect.as(Effect.forkDetach(work), deferred);
  }),
  Effect.withSpan('command/assistant'),
);
