import { Discord as DiscordSchemas } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { DateTime, Effect, Metric, Option, Schema } from 'effect';
import { formatSudoDuration } from '~/commands/sudo/duration.js';
import { guildLocale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { isDiscordNotFoundError } from '~/rest/discordErrors.js';
import { ensureSudoRole } from '~/rest/roles/ensureSudoRole.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Discord epoch (2015-01-01T00:00:00.000Z), in Unix epoch millis — the offset baked
 * into every Discord snowflake's timestamp bits. */
const DISCORD_EPOCH_MS = 1420070400000;

/** Derives the creation time of a Discord snowflake (message, user, etc.) from its
 * embedded timestamp bits. Used as a fallback "from" time for audit messages that
 * predate session tracking (no persisted `started_at`). */
const snowflakeToDate = (snowflake: DiscordSchemas.Snowflake): DateTime.Utc =>
  DateTime.fromDateUnsafe(new Date(Number(BigInt(snowflake) >> 22n) + DISCORD_EPOCH_MS));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringProp = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
};

/** Extract custom_id from interaction data. */
const getCustomId = (interaction: DiscordTypes.APIInteraction): string =>
  stringProp(interaction.data, 'custom_id') ?? '';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

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

/** Builds the "sudo mode ended" embed that replaces the active audit message.
 * Permanent, guild-visible message → uses guild locale. */
const buildSudoEndedMessage = (
  subjectUserId: DiscordSchemas.Snowflake,
  actorId: DiscordSchemas.Snowflake,
  startedAt: DateTime.Utc,
  embedLocale: 'en' | 'cs',
) => {
  const now = DateTime.nowUnsafe();
  const elapsedMs = Number(DateTime.toEpochMillis(now)) - Number(DateTime.toEpochMillis(startedAt));
  return {
    embeds: [
      {
        title: m.bot_sudo_log_title_ended({}, { locale: embedLocale }),
        description: m.bot_sudo_log_ended(
          {
            userId: subjectUserId,
            actorId,
            from: toDiscordTimestamp(startedAt),
            to: toDiscordTimestamp(now),
            duration: formatSudoDuration(elapsedMs),
          },
          { locale: embedLocale },
        ),
        color: 0x57f287,
      },
    ],
    components: [],
  };
};

/** Replace the shared audit message with its "ended" state, swallowing REST failures.
 * A no-op if the interaction lacks a channel/message id (defensive — always present on
 * a real message-component interaction). */
const markEndedOnSharedMessage = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  subjectUserId: DiscordSchemas.Snowflake,
  actorId: DiscordSchemas.Snowflake,
  startedAt: DateTime.Utc,
  embedLocale: 'en' | 'cs',
) => {
  const channelId = interaction.message?.channel_id ?? interaction.channel_id;
  const messageId = interaction.message?.id;
  if (channelId === undefined || messageId === undefined) return Effect.void;
  const { embeds, components } = buildSudoEndedMessage(
    subjectUserId,
    actorId,
    startedAt,
    embedLocale,
  );
  return rest
    .updateMessage(channelId, messageId, { embeds, components })
    .pipe(Effect.asVoid, logRestErrors('Failed to update sudo-ended message'));
};

// ---------------------------------------------------------------------------
// sudo-leave:{subjectUserId} button
// ---------------------------------------------------------------------------

export const SudoLeaveButton = Effect.Do.pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'button' }),
      1,
    ),
  ),
  Effect.bind('interaction', () => Interaction.asEffect()),
  Effect.bind('rpc', () => SyncRpc.asEffect()),
  Effect.bind('rest', () => DiscordREST.asEffect()),
  Effect.flatMap(({ interaction, rpc, rest }) => {
    const locale = userLocale(interaction);
    const embedLocale = guildLocale(interaction);
    const guildId = interaction.guild_id;
    const clickerIdOption = interactionUserId(interaction);
    const customId = getCustomId(interaction);

    // custom_id: sudo-leave:{subjectUserId}
    const colonIdx = customId.indexOf(':');
    const subjectUserIdRaw = customId.slice(colonIdx + 1);

    // Guard: DM-context interactions have no guild_id — return ephemeral error immediately.
    if (guildId === undefined) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_no_guild({}, { locale }) },
            'Failed to update sudo-leave no-guild response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    if (Option.isNone(clickerIdOption)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_no_guild({}, { locale }) },
            'Failed to update sudo-leave no-user response',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const snowflakeGuildId = decodeSnowflake(guildId);
    const clickerId = clickerIdOption.value;
    const subjectUserId = decodeSnowflake(subjectUserIdRaw);

    const checkAndRevoke = rpc['Guild/CheckTeamAdmin']({
      guild_id: snowflakeGuildId,
      discord_user_id: clickerId,
    }).pipe(
      Effect.flatMap((admin) => {
        // Not an admin: ephemeral error, the shared audit message is left untouched
        // (NOT edited).
        if (!admin.is_admin) {
          return replyWebhook(
            rest,
            interaction,
            { content: m.bot_sudo_err_not_admin({}, { locale }) },
            'Failed to update sudo-leave not-admin response',
          );
        }

        // startedAt fallback: no persisted session (e.g. a pre-existing audit message
        // predating session tracking) → derive "from" from the audit message's own
        // snowflake-embedded creation time, so from/to/duration are always shown.
        const fallbackStartedAt = interaction.message?.id
          ? snowflakeToDate(decodeSnowflake(interaction.message.id))
          : DateTime.nowUnsafe();

        const endSessionAndMarkEnded = (replyMessage: string, replyContext: string) =>
          rpc['Guild/EndSudoSession']({
            guild_id: snowflakeGuildId,
            discord_user_id: subjectUserId,
          }).pipe(
            Effect.flatMap(({ session }) => {
              const startedAt = Option.match(session, {
                onNone: () => fallbackStartedAt,
                onSome: (s) => s.started_at,
              });
              return markEndedOnSharedMessage(
                rest,
                interaction,
                subjectUserId,
                clickerId,
                startedAt,
                embedLocale,
              );
            }),
            // A transient RpcClientError here means the role was already revoked but
            // the session may be left orphaned — log and swallow rather than failing
            // the interaction, since the user should still get the success reply.
            Effect.catchTag('RpcClientError', (e) =>
              Effect.logError(
                'sudo-leave: EndSudoSession RPC failed after role was already revoked — session may be orphaned',
                e,
              ),
            ),
            Effect.flatMap(() =>
              replyWebhook(rest, interaction, { content: replyMessage }, replyContext),
            ),
          );

        return ensureSudoRole(snowflakeGuildId).pipe(
          Effect.flatMap((sudoRoleId) =>
            rest.deleteGuildMemberRole(snowflakeGuildId, subjectUserId, sudoRoleId),
          ),
          Effect.flatMap(() =>
            endSessionAndMarkEnded(
              m.bot_sudo_left({}, { locale }),
              'Failed to update sudo-leave response',
            ),
          ),
          Effect.catchTag('ErrorResponse', (error) => {
            // Already gone (role/member unknown) — treat as success, still mark ended.
            if (isDiscordNotFoundError(error)) {
              return endSessionAndMarkEnded(
                m.bot_sudo_already_ended({}, { locale }),
                'Failed to update sudo-already-ended response',
              );
            }
            // Permission (or any other) error: leave the message ACTIVE — do not
            // strip components / mark it ended.
            return replyWebhook(
              rest,
              interaction,
              { content: m.bot_sudo_err_revoke_failed({}, { locale }) },
              'Failed to update sudo-revoke-failed response',
            );
          }),
        );
      }),
      Effect.catchTag('RpcClientError', (e) =>
        Effect.logError('sudo-leave: CheckTeamAdmin RPC failed', e).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_sudo_err_generic({}, { locale }) },
              'Failed to update sudo-leave generic-error response',
            ),
          ),
        ),
      ),
      // Terminal backstop: the inner deleteGuildMemberRole/ensureSudoRole chain
      // only handles ErrorResponse, and the outer catch only RpcClientError — so
      // an HttpClientError/RatelimitedResponse or an untagged defect would leak
      // and leave the deferred reply unresolved ("Sideline is thinking…"). Always
      // resolve it. Mirrors the profile-complete / event-create backstop.
      Effect.catchCause((cause) =>
        Effect.logError('sudo-leave: unexpected failure', cause).pipe(
          Effect.andThen(
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_sudo_err_generic({}, { locale }) },
              'Failed to update sudo-leave backstop response',
            ),
          ),
        ),
      ),
    );

    return Effect.as(Effect.forkDetach(checkAndRevoke), ephemeralDeferred);
  }),
  Effect.withSpan('interaction/sudo-leave-button'),
);

export const SudoLeaveButtonReg = Ix.messageComponent(
  Ix.idStartsWith('sudo-leave:'),
  SudoLeaveButton,
);
