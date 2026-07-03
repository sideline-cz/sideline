import type { PollRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';

/** Discord blurple — open poll color */
export const COLOR_OPEN = 0x5865f2;
/** Grey — closed poll color */
export const COLOR_CLOSED = 0x95a5a6;

/** Regional indicator letter: position 0 → 🇦, 1 → 🇧, etc. */
export const regionalIndicator = (position: number): string =>
  String.fromCodePoint(0x1f1e6 + position);

/**
 * Maximum character length for a Discord button label is 80.
 * A regional indicator emoji is 2 chars (surrogate pair) + 1 space = 3 chars overhead.
 * So the label portion of the button text is capped at 77 chars.
 */
const BUTTON_LABEL_MAX = 80;
const BUTTON_INDICATOR_OVERHEAD = 3; // 2 (emoji surrogate pair) + 1 (space)
const BUTTON_LABEL_CONTENT_MAX = BUTTON_LABEL_MAX - BUTTON_INDICATOR_OVERHEAD;

/** Truncate a label to fit the button content budget, appending … if truncated. */
export const truncateButtonLabel = (label: string): string => {
  if (label.length <= BUTTON_LABEL_CONTENT_MAX) return label;
  return `${label.slice(0, BUTTON_LABEL_CONTENT_MAX - 1)}…`;
};

/**
 * Discord embed title limit is 256 characters.
 * The poll title prefix "📊 " is 3 characters (emoji 2-char surrogate pair + space),
 * so the question portion must be ≤253 to stay within budget.
 * This constant is the max length of the full composed title (prefix + question).
 */
const EMBED_TITLE_MAX = 256;

/** Defensively truncate a string so it fits within the Discord embed title limit. */
const truncateEmbedTitle = (title: string): string => {
  if (title.length <= EMBED_TITLE_MAX) return title;
  return `${title.slice(0, EMBED_TITLE_MAX - 1)}…`;
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
      title: truncateEmbedTitle(`📊 ${view.question}`),
      color: isClosed ? COLOR_CLOSED : COLOR_OPEN,
      description: descriptionParts.length > 0 ? descriptionParts.join('\n') : undefined,
      fields,
      footer: { text: footerText },
    },
  ];

  // The "Who voted?" button is shown on both open and closed boards.
  const votersButton: Discord.ButtonComponentForMessageRequest = UI.button({
    style: Discord.ButtonStyleTypes.SECONDARY,
    label: m.bot_poll_voters_button({}, { locale }),
    custom_id: `poll-voters:${view.poll_id}`,
  });

  // Closed board: action row with only the voters button (vote/add/close are omitted).
  if (isClosed) {
    return {
      embeds,
      components: [UI.row([votersButton])],
    };
  }

  // Open board: one action row with Vote + Add option + Close poll + Who voted? buttons
  const actionRow: Discord.ActionRowComponentForMessageRequest = UI.row([
    UI.button({
      style: Discord.ButtonStyleTypes.PRIMARY,
      label: m.bot_poll_vote_button({}, { locale }),
      custom_id: `poll-open:${view.poll_id}`,
    }),
    UI.button({
      style: Discord.ButtonStyleTypes.SECONDARY,
      label: m.bot_poll_add_option_button({}, { locale }),
      custom_id: `poll-add:${view.poll_id}`,
    }),
    UI.button({
      style: Discord.ButtonStyleTypes.DANGER,
      label: m.bot_poll_close_button({}, { locale }),
      custom_id: `poll-close:${view.poll_id}`,
    }),
    votersButton,
  ]);

  return { embeds, components: [actionRow] };
};
