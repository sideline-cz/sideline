/**
 * `/login` — hands the caller a one-time link that opens the web app already signed in.
 *
 * **The reply carries a credential, and ephemerality is enforced by ORDER, not by care.**
 * This handler's return value is `ephemeralDeferred`. Discord receives that callback —
 * and fixes the interaction's visibility — BEFORE the forked work runs, and the RPC that
 * mints the token is inside that forked work. So at the moment a token exists there is no
 * interaction response left that could be public: every follow-up inherits the ephemeral
 * flag, enforced by Discord server-side. There is no ordering of these statements in which
 * the link reaches a shared channel.
 *
 * Two consequences a future change must preserve:
 *  - This handler must never call `rest.createMessage`. That posts to a channel, and
 *    `login.test.ts` asserts it is never reached.
 *  - The link must never appear as bare message content. Discord fetches URLs it finds in
 *    content to build a preview, and an unfurler GET would REDEEM the single-use token
 *    before the user clicked it. It goes in a link button and an inline code block, which
 *    Discord never unfurls.
 */

import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { type DateTime, Effect, Metric, Option, Schema } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

/** The flag that makes the whole feature safe. Set before the token exists — see the
 * module comment. */
const ephemeralDeferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: DiscordTypes.MessageFlags.Ephemeral },
};

type RestError = Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>;

const logRestErrors =
  (context: string) =>
  <A, R>(effect: Effect.Effect<A, RestError, R>) =>
    effect.pipe(
      Effect.catchTag(['ErrorResponse', 'HttpClientError', 'RatelimitedResponse'], (e) =>
        Effect.logError(context, e),
      ),
    );

type WebhookUpdatePayload = Parameters<
  DiscordRestService['updateOriginalWebhookMessage']
>[2]['payload'];

const replyWebhook = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  payload: WebhookUpdatePayload,
  context = 'webhook update',
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(logRestErrors(context));

/** The link appears twice and as bare content ZERO times: once as a button `url` (never
 * unfurled, never crawled) and once inside an inline code span, so a phone user can copy
 * it out of Discord's in-app browser into their real one. */
const buildLinkPayload = (url: string, expiresAt: DateTime.Utc, locale: 'en' | 'cs') => ({
  content: `${m.bot_login_ready({ expires: toDiscordTimestamp(expiresAt, 'R') }, { locale })}\n\`${url}\``,
  components: [
    UI.row([
      UI.button({
        style: DiscordTypes.ButtonStyleTypes.LINK,
        label: m.bot_login_btn_open({}, { locale }),
        url,
      }),
    ]),
  ],
  allowed_mentions: { parse: [] },
});

export const loginHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) => {
    const locale = userLocale(interaction);
    const maybeUserId = interactionUserId(interaction);
    const guildId = interaction.guild_id;

    const work = Effect.Do.pipe(
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rest }) => {
        if (Option.isNone(maybeUserId)) {
          return replyWebhook(
            rest,
            interaction,
            { content: m.bot_login_err_generic({}, { locale }) },
            'Failed to update login no-user response',
          );
        }

        return SyncRpc.asEffect().pipe(
          Effect.flatMap((rpc) =>
            rpc['Guild/IssueLoginLink']({
              discord_user_id: maybeUserId.value,
              guild_id:
                guildId === undefined ? Option.none() : Option.some(decodeSnowflake(guildId)),
            }),
          ),
          Effect.flatMap((link) =>
            replyWebhook(
              rest,
              interaction,
              buildLinkPayload(link.url, link.expires_at, locale),
              'Failed to update login link response',
            ),
          ),
          Effect.catchTags({
            LoginLinkUserNotFound: () =>
              replyWebhook(
                rest,
                interaction,
                { content: m.bot_login_err_not_registered({}, { locale }) },
                'Failed to update login not-registered response',
              ),
            LoginLinkRateLimited: (e) =>
              replyWebhook(
                rest,
                interaction,
                {
                  content: m.bot_login_err_rate_limited(
                    { minutes: Math.max(1, Math.ceil(e.retry_after_seconds / 60)) },
                    { locale },
                  ),
                },
                'Failed to update login rate-limited response',
              ),
            RpcClientError: (e) =>
              Effect.logError('login: IssueLoginLink RPC failed', e).pipe(
                Effect.flatMap(() =>
                  replyWebhook(
                    rest,
                    interaction,
                    { content: m.bot_login_err_generic({}, { locale }) },
                    'Failed to update login generic-error response',
                  ),
                ),
              ),
          }),
        );
      }),
    );

    // Terminal backstop: resolve the deferred reply on any unhandled failure or defect so
    // the user isn't stuck on "Sideline is thinking…". Mirrors `/sudo`.
    return Effect.as(
      Effect.forkDetach(
        work.pipe(
          Effect.catchCause((cause) =>
            Effect.logError('login command: unexpected failure', cause).pipe(
              Effect.andThen(DiscordREST.asEffect()),
              Effect.flatMap((rest) =>
                rest
                  .updateOriginalWebhookMessage(interaction.application_id, interaction.token, {
                    payload: { content: m.bot_login_err_generic({}, { locale }) },
                  })
                  .pipe(
                    Effect.catchTag(
                      ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                      (e) => Effect.logError('Failed to update login command error response', e),
                    ),
                  ),
              ),
            ),
          ),
        ),
      ),
      ephemeralDeferred,
    );
  }),
  Effect.withSpan('command/login'),
);
