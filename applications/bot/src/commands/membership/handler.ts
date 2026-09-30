import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildMembershipBoard } from '~/rest/membership/buildMembershipBoard.js';
import { retryPolicy } from '~/rest/utils.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

const logRestErrors =
  (context: string) =>
  <A, R>(
    effect: Effect.Effect<
      A,
      Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>,
      R
    >,
  ) =>
    effect.pipe(
      Effect.catchTag(['ErrorResponse', 'HttpClientError', 'RatelimitedResponse'], (e) =>
        Effect.logError(context, e),
      ),
    );

/** `Effect.suspend` so `Effect.retry` re-invokes the call rather than replaying a frozen value. */
const replyContent = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  content: string,
  context: string,
) =>
  Effect.suspend(() =>
    rest.updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
      payload: { content },
    }),
  ).pipe(
    Effect.catchTag('ErrorResponse', (e) => Effect.fail(e)),
    Effect.retry(retryPolicy),
    logRestErrors(context),
  );

export const membershipHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const embedLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const channelId = interaction.channel_id;
    const discordUserId = interactionUserId(interaction);

    const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
      type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: DiscordTypes.MessageFlags.Ephemeral },
    };

    if (guildId === undefined || channelId === undefined || Option.isNone(discordUserId)) {
      return Effect.succeed(
        Ix.response({
          type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: m.bot_membership_err_no_guild({}, { locale }),
            flags: DiscordTypes.MessageFlags.Ephemeral,
          },
        }),
      );
    }

    const work = Effect.Do.pipe(
      Effect.bind('rpc', () => SyncRpc.asEffect()),
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rpc, rest }) =>
        rpc['Membership/GetMembershipSelection']({
          guild_id: decodeSnowflake(guildId),
          discord_user_id: discordUserId.value,
        }).pipe(
          Effect.flatMap((view) => {
            // The permission lives on the server-resolved membership, not on Discord roles —
            // `default_member_permissions` only hides the command in the client.
            if (!view.can_manage) {
              return replyContent(
                rest,
                interaction,
                m.bot_membership_err_not_manager({}, { locale }),
                'membership command: forbidden',
              );
            }
            const { embeds, components } = buildMembershipBoard(view, embedLocale);
            return Effect.suspend(() =>
              rest.createMessage(decodeSnowflake(channelId), {
                embeds,
                components,
                allowed_mentions: { parse: [] },
              }),
            ).pipe(
              Effect.catchTag('ErrorResponse', (e) => Effect.fail(e)),
              Effect.retry(retryPolicy),
              Effect.flatMap(() =>
                replyContent(
                  rest,
                  interaction,
                  m.bot_membership_posted({}, { locale }),
                  'membership command: posted',
                ),
              ),
            );
          }),
          Effect.catchTag('MembershipGuildNotFound', () =>
            replyContent(
              rest,
              interaction,
              m.bot_membership_err_no_guild({}, { locale }),
              'membership command: guild not found',
            ),
          ),
          Effect.catchTag('MembershipNotMember', () =>
            replyContent(
              rest,
              interaction,
              m.bot_membership_err_not_member({}, { locale }),
              'membership command: not member',
            ),
          ),
          Effect.catchTag(
            ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse', 'RpcClientError'],
            (error) =>
              Effect.logError('Failed to post membership board', error).pipe(
                Effect.flatMap(() =>
                  replyContent(
                    rest,
                    interaction,
                    m.bot_membership_err_generic({}, { locale }),
                    'membership command: generic error',
                  ),
                ),
              ),
          ),
        ),
      ),
    );

    // Terminal backstop: the fork owns the deferred reply, so any unhandled failure still has to
    // resolve it or the user sits on "Sideline is thinking…" forever.
    return Effect.as(
      Effect.forkDetach(
        work.pipe(
          Effect.catchCause((cause) =>
            Effect.logError('membership command: unexpected failure', cause).pipe(
              Effect.andThen(DiscordREST.asEffect()),
              Effect.flatMap((rest) =>
                rest
                  .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                    payload: { content: m.bot_membership_err_generic({}, { locale }) },
                  })
                  .pipe(
                    Effect.catchTag(
                      ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                      (e) =>
                        Effect.logError('Failed to update membership command error response', e),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
      deferred,
    );
  }),
  Effect.withSpan('command/membership'),
);
