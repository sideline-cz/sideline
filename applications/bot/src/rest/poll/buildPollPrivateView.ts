import type { PollRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import { regionalIndicator, truncateButtonLabel } from './buildPollEmbed.js';

/** Discord blurple — used for both open board and private view */
const COLOR_OPEN = 0x5865f2;

/**
 * Build the per-user ephemeral private vote view.
 *
 * @param view      The poll view (includes my_option_ids for this user).
 * @param locale    The user's locale.
 * @param actionNote Optional action toast string prepended to the embed description.
 */
export const buildPollPrivateView = (
  view: PollRpcModels.PollView,
  locale: Locale,
  actionNote?: string,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const isClosed = view.status === 'closed';

  // Build per-option toggle buttons, 4 per row, capped at 10 options
  const BUTTONS_PER_ROW = 4;
  const visibleOptions = view.options.slice(0, 10);
  const components: Discord.ActionRowComponentForMessageRequest[] = [];

  for (let i = 0; i < visibleOptions.length; i += BUTTONS_PER_ROW) {
    const batch = visibleOptions.slice(i, i + BUTTONS_PER_ROW);
    const buttonRow: Discord.ActionRowComponentForMessageRequest = {
      type: 1,
      components: batch.map((opt) => {
        const isSelected = view.my_option_ids.includes(opt.option_id);
        return {
          type: 2,
          style: isSelected ? 1 : 2, // Primary=1 (selected), Secondary=2 (unselected)
          label: `${regionalIndicator(opt.position)} ${truncateButtonLabel(opt.label)}`,
          custom_id: `poll-vote:${view.poll_id}:${opt.option_id}`,
          disabled: isClosed,
        };
      }),
    };
    components.push(buttonRow);
  }

  // Build selection summary
  const selectedOptions = view.options.filter((opt) => view.my_option_ids.includes(opt.option_id));

  let selectionSummary: string;
  if (selectedOptions.length === 0) {
    selectionSummary = m.bot_poll_private_none({}, { locale });
  } else {
    const optionsText = selectedOptions
      .map((opt) => `${regionalIndicator(opt.position)} ${opt.label}`)
      .join(', ');
    selectionSummary = m.bot_poll_private_selection({ options: optionsText }, { locale });
  }

  // Build description: optional action note + selection summary
  const descriptionParts: string[] = [];
  if (actionNote !== undefined && actionNote.length > 0) {
    descriptionParts.push(actionNote);
  }
  descriptionParts.push(selectionSummary);
  const description = descriptionParts.join('\n');

  // Build footer
  const footerText = view.multiple
    ? m.bot_poll_private_footer_open_multi({}, { locale })
    : m.bot_poll_private_footer_open({}, { locale });

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_poll_private_title({ question: view.question }, { locale }),
      color: COLOR_OPEN,
      description,
      footer: { text: footerText },
    },
  ];

  return { embeds, components };
};
