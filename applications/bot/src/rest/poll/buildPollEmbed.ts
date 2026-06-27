import type { PollRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';

/** Discord blurple — open poll color */
const COLOR_OPEN = 0x5865f2;
/** Grey — closed poll color */
const COLOR_CLOSED = 0x95a5a6;

/** Regional indicator letter: position 0 → 🇦, 1 → 🇧, etc. */
const regionalIndicator = (position: number): string => String.fromCodePoint(0x1f1e6 + position);

/**
 * Maximum character length for a Discord button label is 80.
 * A regional indicator emoji is 2 chars (surrogate pair) + 1 space = 3 chars overhead.
 * So the label portion of the button text is capped at 77 chars.
 */
const BUTTON_LABEL_MAX = 80;
const BUTTON_INDICATOR_OVERHEAD = 3; // 2 (emoji surrogate pair) + 1 (space)
const BUTTON_LABEL_CONTENT_MAX = BUTTON_LABEL_MAX - BUTTON_INDICATOR_OVERHEAD;

/** Truncate a label to fit the button content budget, appending … if truncated. */
const truncateButtonLabel = (label: string): string => {
  if (label.length <= BUTTON_LABEL_CONTENT_MAX) return label;
  return `${label.slice(0, BUTTON_LABEL_CONTENT_MAX - 1)}…`;
};

/** Progress bar: filled blocks for percent filled, empty blocks for rest. */
const buildBar = (count: number, total: number): string => {
  const FILLED = '█';
  const EMPTY = '░';
  const BAR_LENGTH = 10;
  if (total === 0) return EMPTY.repeat(BAR_LENGTH);
  const filled = Math.round((count / total) * BAR_LENGTH);
  return FILLED.repeat(filled) + EMPTY.repeat(BAR_LENGTH - filled);
};

export const buildPollEmbed = (
  view: PollRpcModels.PollView,
  locale: Locale,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const isClosed = view.status === 'closed';
  const totalVotes = view.total_votes;

  // Build option fields
  const fields: Discord.RichEmbedField[] = view.options.map((opt) => {
    const indicator = regionalIndicator(opt.position);
    const bar = buildBar(opt.vote_count, totalVotes);
    const percent = totalVotes > 0 ? Math.round((opt.vote_count / totalVotes) * 100) : 0;
    return {
      name: `${indicator} ${opt.label}`,
      value: `${bar} ${opt.vote_count} · ${percent}%`,
      inline: false,
    };
  });

  // Build footer
  let footerText: string;
  if (isClosed) {
    if (totalVotes === 0) {
      footerText = m.bot_poll_footer_closed_empty({}, { locale });
    } else {
      const maxVotes = Math.max(...view.options.map((o) => o.vote_count));
      const winners = view.options.filter((o) => o.vote_count === maxVotes);
      if (winners.length > 1) {
        footerText = m.bot_poll_footer_closed_tie({}, { locale });
      } else {
        const winner = winners[0];
        footerText = m.bot_poll_footer_closed(
          { winner: winner !== undefined ? winner.label : '' },
          { locale },
        );
      }
    }
  } else if (view.multiple) {
    footerText = m.bot_poll_footer_open_multi({}, { locale });
  } else {
    footerText = m.bot_poll_footer_open({}, { locale });
  }

  // Build description with optional deadline line
  const descriptionParts: string[] = [];
  Option.match(view.deadline, {
    onNone: () => undefined,
    onSome: (deadline) => {
      const unixSeconds = Math.floor(DateTime.toEpochMillis(deadline) / 1000);
      descriptionParts.push(
        m.bot_poll_deadline_line(
          { relative: `<t:${unixSeconds}:R>`, absolute: `<t:${unixSeconds}:f>` },
          { locale },
        ),
      );
    },
  });

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: `📊 ${view.question}`,
      color: isClosed ? COLOR_CLOSED : COLOR_OPEN,
      description: descriptionParts.length > 0 ? descriptionParts.join('\n') : undefined,
      fields,
      footer: { text: footerText },
    },
  ];

  // Build vote button rows (4 per row, cap 10)
  const BUTTONS_PER_ROW = 4;
  const components: Discord.ActionRowComponentForMessageRequest[] = [];

  for (let i = 0; i < view.options.length; i += BUTTONS_PER_ROW) {
    const batch = view.options.slice(i, i + BUTTONS_PER_ROW);
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

  // Add action row with Add option + Close poll buttons (only for open polls)
  if (!isClosed) {
    const actionRow: Discord.ActionRowComponentForMessageRequest = {
      type: 1,
      components: [
        {
          type: 2,
          style: 1, // Primary
          label: m.bot_poll_add_option_button({}, { locale }),
          custom_id: `poll-add:${view.poll_id}`,
        },
        {
          type: 2,
          style: 4, // Danger
          label: m.bot_poll_close_button({}, { locale }),
          custom_id: `poll-close:${view.poll_id}`,
        },
      ],
    };
    components.push(actionRow);
  }

  return { embeds, components };
};
