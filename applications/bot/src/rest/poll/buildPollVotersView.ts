import type { PollRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
import {
  EMBED_FIELD_VALUE_LIMIT,
  formatNameWithMention,
  joinEntriesWithLimit,
} from '~/rest/utils.js';
import { COLOR_CLOSED, COLOR_OPEN, regionalIndicator } from './buildPollEmbed.js';

/**
 * Discord's total embed text budget in code points.
 * We stop filling voter lists beyond ~5800 to leave headroom for the last field's name/value.
 */
const EMBED_TEXT_BUDGET = 5800;

/**
 * Count code points in a string (matches [...str].length semantics used by Discord).
 */
const cpLen = (s: string): number => [...s].length;

/**
 * Build the field value for a poll option's voter list.
 * - If vote_count === 0, returns the "none" string.
 * - Otherwise, joins voters with `joinEntriesWithLimit`, incorporating the server-side
 *   60-voter cap (capHidden = vote_count - voters.length) into the "…and N more" suffix
 *   so the count always reflects the TRUE number of hidden voters.
 */
const buildVoterFieldValue = (opt: PollRpcModels.PollOptionVoters, locale: Locale): string => {
  if (opt.vote_count === 0) {
    return m.bot_poll_voters_none({}, { locale });
  }

  // capHidden: voters the server's 60-cap dropped — joinEntriesWithLimit can't see them.
  const capHidden = opt.vote_count - opt.voters.length;
  const entries = opt.voters.map(formatNameWithMention);

  // Primary rendering: joinEntriesWithLimit reserves space for capHidden in the suffix.
  const joined = joinEntriesWithLimit(
    entries,
    (shownRemaining) => m.bot_poll_voters_more({ count: shownRemaining + capHidden }, { locale }),
    EMBED_FIELD_VALUE_LIMIT,
  );

  // When capHidden === 0, joinEntriesWithLimit already produced the final value (it owns both the
  // "all fit" and "truncated with suffix" cases). When capHidden > 0 but joinEntriesWithLimit did
  // NOT truncate, the bare join omits the server-capped voters from the count — we must append our
  // own "…and N more" suffix that includes them.
  if (capHidden === 0 || joined !== entries.join(', ')) {
    return joined;
  }

  // All entries fit length-wise, but capHidden voters are still unaccounted for. Fit as many
  // entries as possible alongside a suffix whose count includes both dropped and capped voters.
  // Keep at least one entry (k >= 1) so we never emit a leading-separator "…, and N more".
  for (let k = entries.length; k >= 1; k--) {
    const candidate = entries.slice(0, k).join(', ');
    const moreCount = entries.length - k + capHidden;
    const suffix = `, ${m.bot_poll_voters_more({ count: moreCount }, { locale })}`;
    if (candidate.length + suffix.length <= EMBED_FIELD_VALUE_LIMIT) {
      return `${candidate}${suffix}`;
    }
  }

  // Even a single entry plus the suffix won't fit — just show the total count.
  return m.bot_poll_voters_more({ count: opt.vote_count }, { locale });
};

/**
 * Build the ephemeral per-user "Who voted?" view for a poll.
 */
export const buildPollVotersView = (
  view: PollRpcModels.PollVotersView,
  locale: Locale,
): { embeds: ReadonlyArray<Discord.RichEmbed>; components: [] } => {
  const isClosed = view.status === 'closed';

  const title = m.bot_poll_voters_title({ question: view.question }, { locale });
  const footerText = m.bot_poll_voters_footer({ total: view.total_votes }, { locale });

  // Track cumulative code-point budget already consumed by title + footer + field names/values.
  let budgetUsed = cpLen(title) + cpLen(footerText);

  const fields: Discord.RichEmbedField[] = [];

  for (const opt of view.options) {
    const fieldName = `${regionalIndicator(opt.position)} ${opt.label} · ${opt.vote_count}`;
    const fieldValue = buildVoterFieldValue(opt, locale);

    // Global embed-budget guard: if this full field would push us over ~5800 code points,
    // collapse it to a name + count-only value so the total stays ≤ 6000.
    const fullCost = cpLen(fieldName) + cpLen(fieldValue);
    if (budgetUsed + fullCost > EMBED_TEXT_BUDGET) {
      // Collapsed value: count-only (or none for zero-vote options).
      const collapsedValue =
        opt.vote_count === 0
          ? m.bot_poll_voters_none({}, { locale })
          : m.bot_poll_voters_more({ count: opt.vote_count }, { locale });
      const collapsedCost = cpLen(fieldName) + cpLen(collapsedValue);
      budgetUsed += collapsedCost;
      fields.push({ name: fieldName, value: collapsedValue, inline: false });
    } else {
      budgetUsed += fullCost;
      fields.push({ name: fieldName, value: fieldValue, inline: false });
    }
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title,
      color: isClosed ? COLOR_CLOSED : COLOR_OPEN,
      fields,
      footer: { text: footerText },
    },
  ];

  return { embeds, components: [] };
};
