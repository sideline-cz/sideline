import type { MembershipRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';
import { formatMoney } from '~/rest/finance/formatMoney.js';
import { MAX_PLANS, planLabel, selectionState } from './buildMembershipBoard.js';

const COLOR_OPEN = 0x5865f2;
const COLOR_CLOSED = 0x95a5a6;

/** Discord button labels cap at 80 characters. */
const BUTTON_LABEL_MAX = 80;

const truncateButtonLabel = (label: string): string =>
  label.length <= BUTTON_LABEL_MAX ? label : `${label.slice(0, BUTTON_LABEL_MAX - 1)}…`;

/** Buttons per action row. 4 × 5 rows = `MAX_PLANS`. */
const BUTTONS_PER_ROW = 4;

/** custom_id for a plan button: prefix + a 36-char UUID = 39 chars, well under Discord's 100. */
export const planCustomId = (planId: string): string => `mp:${planId}`;

/**
 * The per-user ephemeral: current plan plus one button per plan.
 *
 * `withButtons: false` is the "My plan" button's read-only rendering — same text, no controls.
 * One builder for both so the two can never disagree about which plan the member is on.
 */
export const buildMembershipPickView = (
  view: MembershipRpcModels.MembershipSelectionView,
  locale: Locale,
  options: { readonly withButtons: boolean; readonly actionNote?: string },
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  // Both closed states disable identically; the footer string is true for either.
  const closed = selectionState(view) !== 'open';

  // `None` means never picked — NOT "on the default plan". Resolve against the plan list exactly
  // as the web does; a selection pointing at a since-archived plan reads back as never-picked,
  // which is the truthful thing to show.
  const current = Option.flatMap(view.selected_plan_id, (id) =>
    Option.fromNullishOr(view.plans.find((plan) => plan.plan_id === id)),
  );

  const descriptionParts: string[] = [];
  if (options.actionNote !== undefined) descriptionParts.push(options.actionNote);
  descriptionParts.push(
    Option.match(current, {
      onNone: () => m.bot_membership_pick_none({}, { locale }),
      onSome: (plan) =>
        m.bot_membership_pick_current({ name: planLabel(plan, locale) }, { locale }),
    }),
  );

  const components: Discord.ActionRowComponentForMessageRequest[] = [];
  if (options.withButtons) {
    const visible = view.plans.slice(0, MAX_PLANS);
    for (let i = 0; i < visible.length; i += BUTTONS_PER_ROW) {
      components.push(
        UI.row(
          visible.slice(i, i + BUTTONS_PER_ROW).map((plan) => {
            const isSelected = Option.exists(current, (c) => c.plan_id === plan.plan_id);
            return UI.button({
              style: isSelected
                ? Discord.ButtonStyleTypes.PRIMARY
                : Discord.ButtonStyleTypes.SECONDARY,
              label: truncateButtonLabel(
                `${planLabel(plan, locale)} · ${formatMoney(plan.price_minor, plan.currency, locale)}`,
              ),
              custom_id: planCustomId(plan.plan_id),
              disabled: closed,
            });
          }),
        ),
      );
    }
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_membership_pick_title({}, { locale }),
      color: closed ? COLOR_CLOSED : COLOR_OPEN,
      description: descriptionParts.join('\n'),
      footer: options.withButtons
        ? {
            text: closed
              ? m.bot_membership_pick_footer_closed({}, { locale })
              : m.bot_membership_pick_footer({}, { locale }),
          }
        : undefined,
    },
  ];

  return { embeds, components };
};
