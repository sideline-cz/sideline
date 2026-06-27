import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Blurple — Discord's brand color, used for informational embeds */
const COLOR_BLURPLE = 0x5865f2;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discord embed description hard limit (chars) */
const EMBED_DESCRIPTION_LIMIT = 4096;

/** Leave headroom for the ellipsis when truncating */
const TRUNCATION_HEADROOM = 3;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type BuildSummaryEmbedOptions = {
  summary: string;
  count: number;
  participants: number;
  range: string;
  capped: boolean;
  locale: Locale;
};

export const buildSummaryEmbed = (opts: BuildSummaryEmbedOptions): Discord.RichEmbed => {
  const { summary, count, participants, range, capped, locale } = opts;

  const maxLength = EMBED_DESCRIPTION_LIMIT - TRUNCATION_HEADROOM;
  const description = summary.length > maxLength ? `${summary.slice(0, maxLength)}...` : summary;

  const footerText = capped
    ? m.bot_summarize_footer_capped({ count, participants, range }, { locale })
    : m.bot_summarize_footer({ count, participants, range }, { locale });

  const embed: Discord.RichEmbed = {
    title: m.bot_summarize_embed_title({}, { locale }),
    color: COLOR_BLURPLE,
    description,
    footer: { text: footerText },
  };

  return embed;
};
