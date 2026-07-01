import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { DateTime, Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { isDiscordPermissionError } from '~/rest/discordErrors.js';
import { ensureSudoRole } from '~/rest/roles/ensureSudoRole.js';
import { DfxGuild, interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodeGuild = Schema.decodeUnknownEffect(DfxGuild);

const ephemeralDeferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: DiscordTypes.MessageFlags.Ephemeral },
};

/** The error union shared by every dfx DiscordREST call. */
type RestError = Effect.Error<ReturnType<DiscordRestService['updateOriginalWebhookMessage']>>;

/** Log and swallow the three Discord REST failure tags. */
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

/** Update the deferred ephemeral webhook reply, swallowing REST failures. */
const replyWebhook = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  payload: WebhookUpdatePayload,
  context = 'webhook update',
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(logRestErrors(context));

const toDiscordTimestamp = (dt: DateTime.Utc): string =>
  `<t:${Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000)}:F>`;

/** Builds the audit embed + "Leave sudo" button posted to the system channel when a
 * team admin enters sudo mode. Permanent, guild-visible message → uses guild locale. */
const buildSudoAuditMessage = (
  userId: DiscordSchemas.Snowflake,
  timestamp: string,
  embedLocale: 'en' | 'cs',
) => ({
  embeds: [
    {
      title: m.bot_sudo_log_title({}, { locale: embedLocale }),
      description: m.bot_sudo_log_active({ userId, timestamp }, { locale: embedLocale }),
      footer: { text: m.bot_sudo_log_footer({}, { locale: embedLocale }) },
      color: 0xe67e22,
    },
  ],
  components: [
    {
      type: 1 as const,
      components: [
        {
          type: 2 as const,
          style: 4 as const, // Danger
          label: m.bot_sudo_btn_leave({}, { locale: embedLocale }),
          custom_id: `sudo-leave:${userId}`,
        },
      ],
    },
  ],
});

/** Whether the invoker already holds the sudo role. Logs a warning (rather than
 * silently defaulting to "not elevated") when `interaction.member` is absent, since
 * that would otherwise cause a mis-toggle (granting when the user may already be
 * elevated) with no diagnostic trail. */
const isElevated = (
  interaction: DiscordTypes.APIInteraction,
  sudoRoleId: DiscordSchemas.Snowflake,
): boolean => {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) && roles.includes(sudoRoleId);
};

/** Grant the sudo role and — if a system channel is configured — post an audit entry
 * with a "Leave sudo" button. */
const enterSudoMode = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  locale: 'en' | 'cs',
  embedLocale: 'en' | 'cs',
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
  sudoRoleId: DiscordSchemas.Snowflake,
) =>
  rest.addGuildMemberRole(guildId, userId, sudoRoleId).pipe(
    Effect.flatMap(() => Effect.logWarning(`Sudo mode granted to ${userId} in guild ${guildId}`)),
    Effect.flatMap(() => rest.getGuild(guildId)),
    Effect.flatMap(decodeGuild),
    Effect.flatMap((guild) =>
      Option.match(guild.system_channel_id, {
        onNone: () =>
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_no_system_channel({}, { locale }) },
            'Failed to update sudo no-system-channel response',
          ),
        onSome: (systemChannelId) => {
          const timestamp = toDiscordTimestamp(DateTime.nowUnsafe());
          const { embeds, components } = buildSudoAuditMessage(userId, timestamp, embedLocale);
          return rest
            .createMessage(systemChannelId, {
              embeds,
              components,
              allowed_mentions: { parse: [] },
            })
            .pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_entered({}, { locale }) },
                  'Failed to update sudo entered response',
                ),
              ),
            );
        },
      }),
    ),
    Effect.catchTag('ErrorResponse', (error) =>
      isDiscordPermissionError(error)
        ? replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_grant_failed({}, { locale }) },
            'Failed to update sudo grant-failed response',
          )
        : Effect.fail(error),
    ),
    Effect.catchTag('SchemaError', (error) =>
      Effect.logError('sudo: failed to decode getGuild response', error).pipe(
        Effect.flatMap(() =>
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_generic({}, { locale }) },
            'Failed to update sudo generic-error response (decode failure)',
          ),
        ),
      ),
    ),
  );

const leaveSudoMode = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  locale: 'en' | 'cs',
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
  sudoRoleId: DiscordSchemas.Snowflake,
) =>
  rest
    .deleteGuildMemberRole(guildId, userId, sudoRoleId)
    .pipe(
      Effect.flatMap(() =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_sudo_left({}, { locale }) },
          'Failed to update sudo left response',
        ),
      ),
    );

/**
 * `/sudo` — lets a team admin temporarily elevate to Discord Administrator on the
 * guild by granting a dedicated `Sideline Sudo` role. Toggles: if the invoker is not
 * currently elevated, grants the role and (when a system channel is configured) posts
 * an audit entry with a "Leave sudo" button; if already elevated, revokes the role.
 * Authorization is enforced via `Guild/CheckTeamAdmin` (server-side), not via Discord
 * `default_member_permissions`, so the command stays visible to team admins regardless
 * of their Discord-native permissions.
 *
 * Discord requires an ACK within 3 seconds; the full admin-check + role + audit-post
 * chain can easily exceed that, so the handler defers immediately and does all the
 * work in a detached fork, delivering the final outcome via a webhook edit — mirroring
 * `~/interactions/sudo.ts` (`SudoLeaveButton`) and `~/commands/poll/handler.ts`.
 */
export const sudoHandler = Interaction.asEffect().pipe(
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
    const maybeUserId = interactionUserId(interaction);

    const work = Effect.Do.pipe(
      Effect.bind('rest', () => DiscordREST.asEffect()),
      Effect.flatMap(({ rest }) => {
        if (guildId === undefined || Option.isNone(maybeUserId)) {
          return replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_no_guild({}, { locale }) },
            'Failed to update sudo no-guild response',
          );
        }

        const snowflakeGuildId = decodeSnowflake(guildId);
        const userId = maybeUserId.value;

        return SyncRpc.asEffect().pipe(
          Effect.flatMap((rpc) =>
            rpc['Guild/CheckTeamAdmin']({
              guild_id: snowflakeGuildId,
              discord_user_id: userId,
            }),
          ),
          Effect.flatMap((admin) => {
            if (!admin.is_admin) {
              return replyWebhook(
                rest,
                interaction,
                { content: m.bot_sudo_err_not_admin({}, { locale }) },
                'Failed to update sudo not-admin response',
              );
            }

            return ensureSudoRole(snowflakeGuildId).pipe(
              Effect.tap(() =>
                interaction.member === undefined || interaction.member === null
                  ? Effect.logWarning(
                      `sudo: interaction.member missing for user ${userId} in guild ${snowflakeGuildId} — elevation check defaulted to "not elevated"`,
                    )
                  : Effect.void,
              ),
              Effect.flatMap((sudoRoleId) =>
                isElevated(interaction, sudoRoleId)
                  ? leaveSudoMode(rest, interaction, locale, snowflakeGuildId, userId, sudoRoleId)
                  : enterSudoMode(
                      rest,
                      interaction,
                      locale,
                      embedLocale,
                      snowflakeGuildId,
                      userId,
                      sudoRoleId,
                    ),
              ),
            );
          }),
          Effect.catchTag('RpcClientError', (e) =>
            Effect.logError('sudo: CheckTeamAdmin RPC failed', e).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_generic({}, { locale }) },
                  'Failed to update sudo generic-error response',
                ),
              ),
            ),
          ),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (e) =>
            Effect.logError('sudo: Discord REST call failed', e).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_generic({}, { locale }) },
                  'Failed to update sudo generic-error response',
                ),
              ),
            ),
          ),
        );
      }),
    );

    return Effect.as(Effect.forkDetach(work), ephemeralDeferred);
  }),
  Effect.withSpan('command/sudo'),
);
