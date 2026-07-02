import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { DateTime, Effect, Metric, Option, Schema } from 'effect';
import { formatSudoDuration } from '~/commands/sudo/duration.js';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { isDiscordNotFoundError, isDiscordPermissionError } from '~/rest/discordErrors.js';
import { ensureSudoRole } from '~/rest/roles/ensureSudoRole.js';
import { DfxGuild, interactionUserId } from '~/schemas.js';
import type { SyncRpcClient } from '~/services/SyncRpc.js';
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
    UI.row([
      UI.button({
        style: 4, // Danger
        label: m.bot_sudo_btn_leave({}, { locale: embedLocale }),
        custom_id: `sudo-leave:${userId}`,
      }),
    ]),
  ],
});

/** Pure predicate: whether the invoker already holds the sudo role. Returns `false`
 * (not elevated) when `interaction.member` is absent — the caller separately logs a
 * warning in that case (rather than silently defaulting), since a mis-toggle (granting
 * when the user may already be elevated) would otherwise have no diagnostic trail. */
const isElevated = (
  interaction: DiscordTypes.APIInteraction,
  sudoRoleId: DiscordSchemas.Snowflake,
): boolean => {
  const roles = interaction.member?.roles;
  return Array.isArray(roles) && roles.includes(sudoRoleId);
};

/** Post the audit entry (if a system channel is configured) and persist the session
 * so it can later be closed by `EndSudoSession` (either the button or a toggle-off
 * `/sudo` re-run). Runs only after the role grant has already succeeded — any failure
 * here must NOT be reported as a grant failure, since the user is already elevated. */
const postAuditAndReply = (
  rest: DiscordRestService,
  rpc: SyncRpcClient,
  interaction: DiscordTypes.APIInteraction,
  locale: 'en' | 'cs',
  embedLocale: 'en' | 'cs',
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
) =>
  rest.getGuild(guildId).pipe(
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
          const startedAt = DateTime.nowUnsafe();
          const timestamp = toDiscordTimestamp(startedAt);
          const { embeds, components } = buildSudoAuditMessage(userId, timestamp, embedLocale);
          return rest
            .createMessage(systemChannelId, {
              embeds,
              components,
              allowed_mentions: { parse: [] },
            })
            .pipe(
              Effect.flatMap((message) =>
                rpc['Guild/BeginSudoSession']({
                  guild_id: guildId,
                  discord_user_id: userId,
                  system_channel_id: systemChannelId,
                  audit_message_id: decodeSnowflake(message.id),
                  started_at: startedAt,
                }),
              ),
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
  );

/** Grant the sudo role, then post the audit entry. The grant and audit phases have
 * distinct error handling: a grant failure means the role was NOT granted (safe to
 * report as such), while an audit-phase failure happens AFTER the role was already
 * granted, so it must tell the user sudo is on rather than claiming the grant failed. */
const enterSudoMode = (
  rest: DiscordRestService,
  rpc: SyncRpcClient,
  interaction: DiscordTypes.APIInteraction,
  locale: 'en' | 'cs',
  embedLocale: 'en' | 'cs',
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
  sudoRoleId: DiscordSchemas.Snowflake,
) =>
  rest.addGuildMemberRole(guildId, userId, sudoRoleId).pipe(
    Effect.flatMap(() => Effect.logWarning(`Sudo mode granted to ${userId} in guild ${guildId}`)),
    Effect.flatMap(() =>
      postAuditAndReply(rest, rpc, interaction, locale, embedLocale, guildId, userId).pipe(
        Effect.catchTags({
          ErrorResponse: (error) =>
            Effect.logError('sudo: audit-phase Discord REST call failed', error).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_audit_failed({}, { locale }) },
                  'Failed to update sudo audit-failed response',
                ),
              ),
            ),
          SchemaError: (error) =>
            Effect.logError('sudo: failed to decode getGuild response', error).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_audit_failed({}, { locale }) },
                  'Failed to update sudo audit-failed response',
                ),
              ),
            ),
          RpcClientError: (error) =>
            Effect.logError('sudo: BeginSudoSession RPC failed', error).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_audit_failed({}, { locale }) },
                  'Failed to update sudo audit-failed response',
                ),
              ),
            ),
          HttpClientError: (error) =>
            Effect.logError('sudo: audit-phase Discord REST call failed', error).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_audit_failed({}, { locale }) },
                  'Failed to update sudo audit-failed response',
                ),
              ),
            ),
          RatelimitedResponse: (error) =>
            Effect.logError('sudo: audit-phase Discord REST call failed', error).pipe(
              Effect.flatMap(() =>
                replyWebhook(
                  rest,
                  interaction,
                  { content: m.bot_sudo_err_audit_failed({}, { locale }) },
                  'Failed to update sudo audit-failed response',
                ),
              ),
            ),
        }),
      ),
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
  );

/** Close the shared audit message the same way the "Leave sudo" button does, swallowing
 * REST failures (a failure to edit the message must not fail the toggle-off — the role
 * has already been revoked). A 404 on the message (deleted) is treated as fine. */
const closeAuditMessage = (
  rest: DiscordRestService,
  session: {
    started_at: DateTime.Utc;
    system_channel_id: DiscordSchemas.Snowflake;
    audit_message_id: DiscordSchemas.Snowflake;
  },
  userId: DiscordSchemas.Snowflake,
  embedLocale: 'en' | 'cs',
) => {
  const now = DateTime.nowUnsafe();
  const elapsedMs =
    Number(DateTime.toEpochMillis(now)) - Number(DateTime.toEpochMillis(session.started_at));
  const description = m.bot_sudo_log_ended(
    {
      userId,
      actorId: userId,
      from: toDiscordTimestamp(session.started_at),
      to: toDiscordTimestamp(now),
      duration: formatSudoDuration(elapsedMs),
    },
    { locale: embedLocale },
  );
  return rest
    .updateMessage(session.system_channel_id, session.audit_message_id, {
      embeds: [
        {
          title: m.bot_sudo_log_title_ended({}, { locale: embedLocale }),
          description,
          color: 0x57f287,
        },
      ],
      components: [],
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag('ErrorResponse', (error) =>
        isDiscordNotFoundError(error)
          ? Effect.void
          : Effect.logError('sudo: failed to close audit message on toggle-off', error),
      ),
      Effect.catchTag(['HttpClientError', 'RatelimitedResponse'], (error) =>
        Effect.logError('sudo: failed to close audit message on toggle-off', error),
      ),
    );
};

/** End the session (if any) + close the audit message (if a session exists), then
 * reply with `replyMessage`. A transient `RpcClientError` from `EndSudoSession` is
 * logged and swallowed rather than failing the interaction — the role has already
 * been revoked, so the user still gets the success reply; the session row may be
 * left orphaned (acceptable — the button still works as a fallback). */
const endSessionAndReply = (
  rest: DiscordRestService,
  rpc: SyncRpcClient,
  interaction: DiscordTypes.APIInteraction,
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
  embedLocale: 'en' | 'cs',
  replyMessage: string,
  replyContext: string,
) =>
  rpc['Guild/EndSudoSession']({ guild_id: guildId, discord_user_id: userId }).pipe(
    Effect.flatMap(({ session }) =>
      Option.match(session, {
        onNone: () => Effect.void,
        onSome: (s) => closeAuditMessage(rest, s, userId, embedLocale),
      }),
    ),
    Effect.catchTag('RpcClientError', (e) =>
      Effect.logError(
        'sudo: EndSudoSession RPC failed after role was already revoked — session may be orphaned',
        e,
      ),
    ),
    Effect.flatMap(() => replyWebhook(rest, interaction, { content: replyMessage }, replyContext)),
  );

const leaveSudoMode = (
  rest: DiscordRestService,
  rpc: SyncRpcClient,
  interaction: DiscordTypes.APIInteraction,
  locale: 'en' | 'cs',
  embedLocale: 'en' | 'cs',
  guildId: DiscordSchemas.Snowflake,
  userId: DiscordSchemas.Snowflake,
  sudoRoleId: DiscordSchemas.Snowflake,
) =>
  rest.deleteGuildMemberRole(guildId, userId, sudoRoleId).pipe(
    Effect.flatMap(() =>
      endSessionAndReply(
        rest,
        rpc,
        interaction,
        guildId,
        userId,
        embedLocale,
        m.bot_sudo_left({}, { locale }),
        'Failed to update sudo left response',
      ),
    ),
    Effect.catchTag('ErrorResponse', (error) => {
      // Already gone (role/member unknown) — treat as success, still end the session
      // and close the audit message if one exists.
      if (isDiscordNotFoundError(error)) {
        return endSessionAndReply(
          rest,
          rpc,
          interaction,
          guildId,
          userId,
          embedLocale,
          m.bot_sudo_already_ended({}, { locale }),
          'Failed to update sudo already-ended response',
        );
      }
      // Permission (or any other) error: the user is still elevated — leave the
      // session + audit message ACTIVE (do not call EndSudoSession / close it) so an
      // admin can retry or use the "Leave sudo" button.
      return replyWebhook(
        rest,
        interaction,
        { content: m.bot_sudo_err_revoke_failed({}, { locale }) },
        'Failed to update sudo revoke-failed response',
      );
    }),
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
            }).pipe(Effect.map((admin) => ({ rpc, admin }))),
          ),
          Effect.flatMap(({ rpc, admin }) => {
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
                  ? leaveSudoMode(
                      rest,
                      rpc,
                      interaction,
                      locale,
                      embedLocale,
                      snowflakeGuildId,
                      userId,
                      sudoRoleId,
                    )
                  : enterSudoMode(
                      rest,
                      rpc,
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
