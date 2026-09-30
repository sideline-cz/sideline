import type { MembershipRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatMoney } from '~/rest/finance/formatMoney.js';

/** Discord blurple — selection open. */
const COLOR_OPEN = 0x5865f2;
/** Grey — past the selection deadline. */
const COLOR_CLOSED = 0x95a5a6;

/**
 * Hard cap on rendered plans. Discord allows 25 embed fields and 25 buttons (5 rows × 5), but
 * the ephemeral picker lays buttons out 4 per row, so 20 is the number BOTH surfaces can show.
 * Keeping one constant means the board can never advertise a plan the picker has no button for.
 */
export const MAX_PLANS = 20;

/** The unnamed seeded default plan renders the built-in translated label, same as the web. */
export const planLabel = (plan: MembershipRpcModels.MembershipPlanView, locale: Locale): string =>
  Option.getOrElse(plan.name, () => m.membershipPlan_defaultName({}, { locale }));

/** True once the team's selection deadline has passed. `None` = always open. */
export const isSelectionClosed = (view: MembershipRpcModels.MembershipSelectionView): boolean =>
  Option.isSome(view.deadline) &&
  DateTime.isLessThanOrEqualTo(view.deadline.value, DateTime.nowUnsafe());

/**
 * The public board.
 *
 * Its two buttons carry CONSTANT custom_ids — no plan id is interpolated anywhere on this
 * message. Per-plan buttons live only on the per-user ephemeral, so a team with two plans of the
 * same shape can never produce a duplicate custom_id and have Discord reject the whole message
 * with a 50035.
 */
export const buildMembershipBoard = (
  view: MembershipRpcModels.MembershipSelectionView,
  locale: Locale,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const closed = isSelectionClosed(view);

  const fields: Discord.RichEmbedField[] = view.plans.slice(0, MAX_PLANS).map((plan) => {
    const lines = [
      m.bot_membership_board_line(
        {
          price: formatMoney(plan.price_minor, plan.currency, locale),
          perTraining: formatMoney(plan.price_per_training_minor, plan.currency, locale),
        },
        { locale },
      ),
    ];
    if (plan.free_trainings_included > 0) {
      lines.push(
        m.bot_membership_board_free_trainings({ count: plan.free_trainings_included }, { locale }),
      );
    }
    const suffix = plan.is_default ? m.bot_membership_board_default_suffix({}, { locale }) : '';
    return { name: `${planLabel(plan, locale)}${suffix}`, value: lines.join('\n'), inline: false };
  });

  const description = Option.match(view.deadline, {
    onNone: () => undefined,
    onSome: (deadline) =>
      (closed ? m.bot_membership_closed_line : m.bot_membership_deadline_line)(
        {
          relative: toDiscordTimestamp(deadline, 'R'),
          absolute: toDiscordTimestamp(deadline, 'f'),
        },
        { locale },
      ),
  });

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_membership_board_title({}, { locale }),
      color: closed ? COLOR_CLOSED : COLOR_OPEN,
      description:
        view.plans.length === 0 ? m.bot_membership_board_empty({}, { locale }) : description,
      fields,
    },
  ];

  return {
    embeds,
    components: [
      UI.row([
        UI.button({
          style: Discord.ButtonStyleTypes.PRIMARY,
          label: m.bot_membership_board_pick_button({}, { locale }),
          custom_id: 'membership-open',
          disabled: closed || view.plans.length === 0,
        }),
        UI.button({
          style: Discord.ButtonStyleTypes.SECONDARY,
          label: m.bot_membership_board_mine_button({}, { locale }),
          custom_id: 'membership-mine',
        }),
      ]),
    ],
  };
};
