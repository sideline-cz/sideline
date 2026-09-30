import {
  Discord as DiscordSchemas,
  MembershipPlan,
  type MembershipRpcModels,
} from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST, type DiscordRestService } from 'dfx/DiscordREST';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Effect, Metric, Option, Schema } from 'effect';
import { guildLocale, type Locale, userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { buildMembershipBoard } from '~/rest/membership/buildMembershipBoard.js';
import { buildMembershipPickView } from '~/rest/membership/buildMembershipPickView.js';
import { interactionUserId } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);
const decodePlanId = Schema.decodeUnknownSync(MembershipPlan.MembershipPlanId);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const stringProp = (value: unknown, key: string): string | undefined => {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === 'string' ? v : undefined;
};

const getCustomId = (interaction: DiscordTypes.APIInteraction): string =>
  stringProp(interaction.data, 'custom_id') ?? '';

const ephemeralDeferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  data: { flags: DiscordTypes.MessageFlags.Ephemeral },
};

/** Type 6 — edits the ephemeral in place. Legal here: no plan button opens a modal. */
const deferredUpdateMessage = Ix.response({
  type: DiscordTypes.InteractionCallbackTypes.DEFERRED_UPDATE_MESSAGE,
});

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
  context: string,
) =>
  rest
    .updateOriginalWebhookMessage(interaction.application_id, interaction.token, { payload })
    .pipe(logRestErrors(context));

/**
 * Terminal defect backstop for the detached fork that resolves a deferred reply — without it an
 * untagged defect leaves the ephemeral spinning forever. Mirrors the poll handlers.
 */
const withDefectBackstop =
  (
    rest: DiscordRestService,
    interaction: DiscordTypes.APIInteraction,
    locale: Locale,
    context: string,
  ) =>
  <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.catchDefect((defect) =>
        Effect.logError(context, defect).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_membership_err_generic({}, { locale }) },
              context,
            ),
          ),
        ),
      ),
    );

/**
 * Repaint the board the member just clicked, from the same view the picker renders.
 *
 * This is why no message id is stored anywhere: the "Pick your plan" button lives ON the board,
 * so its interaction hands us the board's own channel and message. Any click refreshes a board
 * gone stale through a rename, a reprice or an archive — for everyone, not just the clicker.
 * Best effort: a failure here must never cost the member their picker.
 */
const refreshBoard = (
  rest: DiscordRestService,
  interaction: DiscordTypes.APIInteraction,
  view: MembershipRpcModels.MembershipSelectionView,
) => {
  const messageId = interaction.message?.id;
  const channelId = interaction.message?.channel_id ?? interaction.channel_id;
  if (messageId === undefined || channelId === undefined) return Effect.void;
  const { embeds, components } = buildMembershipBoard(view, guildLocale(interaction));
  return rest
    .updateMessage(decodeSnowflake(channelId), decodeSnowflake(messageId), {
      embeds,
      components,
      allowed_mentions: { parse: [] },
    })
    .pipe(logRestErrors('membership board refresh'), Effect.asVoid);
};

/** Shared guard: both ids are required, and a DM interaction has neither. */
const requireGuildAndUser = (
  interaction: DiscordTypes.APIInteraction,
): Option.Option<{ guildId: string; discordUserId: DiscordSchemas.Snowflake }> => {
  const guildId = interaction.guild_id;
  const userId = interactionUserId(interaction);
  if (guildId === undefined || Option.isNone(userId)) return Option.none();
  return Option.some({ guildId, discordUserId: userId.value });
};

// ---------------------------------------------------------------------------
// membership-open button (on the public board)
// ---------------------------------------------------------------------------

export const MembershipOpenButton = Effect.Do.pipe(
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
    const ids = requireGuildAndUser(interaction);

    if (Option.isNone(ids)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_membership_err_no_guild({}, { locale }) },
            'membership-open: no guild or user',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const work = rpc['Membership/GetMembershipSelection']({
      guild_id: decodeSnowflake(ids.value.guildId),
      discord_user_id: ids.value.discordUserId,
    }).pipe(
      Effect.tap((view) => refreshBoard(rest, interaction, view)),
      Effect.flatMap((view) =>
        replyWebhook(
          rest,
          interaction,
          {
            ...buildMembershipPickView(view, locale, { withButtons: true }),
            allowed_mentions: { parse: [] },
          },
          'membership-open: picker',
        ),
      ),
      Effect.catchTag('MembershipGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_no_guild({}, { locale }) },
          'membership-open: guild not found',
        ),
      ),
      Effect.catchTag('MembershipNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_not_member({}, { locale }) },
          'membership-open: not member',
        ),
      ),
      Effect.catchTag('RpcClientError', (e) =>
        Effect.logError('membership-open: RPC failed', e).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_membership_err_generic({}, { locale }) },
              'membership-open: RPC error',
            ),
          ),
        ),
      ),
    );

    return Effect.as(
      Effect.forkDetach(
        work.pipe(withDefectBackstop(rest, interaction, locale, 'membership-open: defect')),
      ),
      ephemeralDeferred,
    );
  }),
  Effect.withSpan('interaction/membership-open-button'),
);

export const MembershipOpenButtonReg = Ix.messageComponent(
  Ix.idStartsWith('membership-open'),
  MembershipOpenButton,
);

// ---------------------------------------------------------------------------
// membership-mine button (on the public board) — read-only "my decision"
// ---------------------------------------------------------------------------

export const MembershipMineButton = Effect.Do.pipe(
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
    const ids = requireGuildAndUser(interaction);

    if (Option.isNone(ids)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_membership_err_no_guild({}, { locale }) },
            'membership-mine: no guild or user',
          ),
        ),
        ephemeralDeferred,
      );
    }

    const work = rpc['Membership/GetMembershipSelection']({
      guild_id: decodeSnowflake(ids.value.guildId),
      discord_user_id: ids.value.discordUserId,
    }).pipe(
      Effect.flatMap((view) =>
        replyWebhook(
          rest,
          interaction,
          {
            ...buildMembershipPickView(view, locale, { withButtons: false }),
            allowed_mentions: { parse: [] },
          },
          'membership-mine: view',
        ),
      ),
      Effect.catchTag('MembershipGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_no_guild({}, { locale }) },
          'membership-mine: guild not found',
        ),
      ),
      Effect.catchTag('MembershipNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_not_member({}, { locale }) },
          'membership-mine: not member',
        ),
      ),
      Effect.catchTag('RpcClientError', (e) =>
        Effect.logError('membership-mine: RPC failed', e).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_membership_err_generic({}, { locale }) },
              'membership-mine: RPC error',
            ),
          ),
        ),
      ),
    );

    return Effect.as(
      Effect.forkDetach(
        work.pipe(withDefectBackstop(rest, interaction, locale, 'membership-mine: defect')),
      ),
      ephemeralDeferred,
    );
  }),
  Effect.withSpan('interaction/membership-mine-button'),
);

export const MembershipMineButtonReg = Ix.messageComponent(
  Ix.idStartsWith('membership-mine'),
  MembershipMineButton,
);

// ---------------------------------------------------------------------------
// mp:{planId} button (on the per-user ephemeral picker)
// ---------------------------------------------------------------------------

export const MembershipPlanButton = Effect.Do.pipe(
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
    const ids = requireGuildAndUser(interaction);

    if (Option.isNone(ids)) {
      return Effect.as(
        Effect.forkDetach(
          replyWebhook(
            rest,
            interaction,
            { content: m.bot_membership_err_no_guild({}, { locale }) },
            'membership-plan: no guild or user',
          ),
        ),
        deferredUpdateMessage,
      );
    }

    // custom_id: mp:{planId} — the plan id is a UUID, which contains no colon.
    const planId = decodePlanId(getCustomId(interaction).slice('mp:'.length));

    const work = rpc['Membership/SelectMembershipPlan']({
      guild_id: decodeSnowflake(ids.value.guildId),
      discord_user_id: ids.value.discordUserId,
      plan_id: planId,
    }).pipe(
      Effect.flatMap((view) =>
        replyWebhook(
          rest,
          interaction,
          {
            ...buildMembershipPickView(view, locale, {
              withButtons: true,
              actionNote: m.bot_membership_pick_saved({}, { locale }),
            }),
            allowed_mentions: { parse: [] },
          },
          'membership-plan: picker',
        ),
      ),
      // The deadline is enforced in the server's UPDATE, not here — a board left open in a
      // scrollback still cannot write past it.
      Effect.catchTag('MembershipSelectionLocked', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_closed({}, { locale }) },
          'membership-plan: closed',
        ),
      ),
      Effect.catchTag('MembershipPlanUnavailable', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_plan_gone({}, { locale }) },
          'membership-plan: plan gone',
        ),
      ),
      Effect.catchTag('MembershipGuildNotFound', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_no_guild({}, { locale }) },
          'membership-plan: guild not found',
        ),
      ),
      Effect.catchTag('MembershipNotMember', () =>
        replyWebhook(
          rest,
          interaction,
          { content: m.bot_membership_err_not_member({}, { locale }) },
          'membership-plan: not member',
        ),
      ),
      Effect.catchTag('RpcClientError', (e) =>
        Effect.logError('membership-plan: RPC failed', e).pipe(
          Effect.flatMap(() =>
            replyWebhook(
              rest,
              interaction,
              { content: m.bot_membership_err_generic({}, { locale }) },
              'membership-plan: RPC error',
            ),
          ),
        ),
      ),
    );

    return Effect.as(
      Effect.forkDetach(
        work.pipe(withDefectBackstop(rest, interaction, locale, 'membership-plan: defect')),
      ),
      deferredUpdateMessage,
    );
  }),
  Effect.withSpan('interaction/membership-plan-button'),
);

export const MembershipPlanButtonReg = Ix.messageComponent(
  Ix.idStartsWith('mp:'),
  MembershipPlanButton,
);
