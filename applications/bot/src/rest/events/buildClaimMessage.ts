import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { formatNameWithMention } from '../utils.js';
import { locationDisplay } from './locationDisplay.js';

const UNCLAIMED_COLOR = 0xed8936; // orange
const CLAIMED_COLOR = 0x57f287; // green (matches EVENT_TYPE_COLORS.training)
const CANCELLED_COLOR = 0xed4245; // red

const toDiscordTimestamp = (
  dt: DateTime.Utc,
  style: 'D' | 'F' | 'R' | 'd' | 'f' | 't' = 'f',
): string => {
  const unix = Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000);
  return `<t:${unix}:${style}>`;
};

const isSameDay = (a: DateTime.Utc, b: DateTime.Utc): boolean => {
  const pa = DateTime.toParts(a);
  const pb = DateTime.toParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
};

export type ClaimedByEntry = {
  readonly discord_id: Option.Option<string>;
  readonly name: Option.Option<string>;
  readonly nickname: Option.Option<string>;
  readonly display_name: Option.Option<string>;
  readonly username: Option.Option<string>;
};

export const buildClaimMessage = (opts: {
  title: string;
  startAt: DateTime.Utc;
  endAt: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  locationUrl: Option.Option<string>;
  description: Option.Option<string>;
  claimedBy: Option.Option<ClaimedByEntry>;
  eventStatus: string;
  teamId: string;
  eventId: string;
  locale: Locale;
}): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const { locale } = opts;
  const isActive = opts.eventStatus === 'active';
  const isCancelled = opts.eventStatus === 'cancelled';
  const isClaimed = Option.isSome(opts.claimedBy);

  // Determine embed color
  const color = isCancelled ? CANCELLED_COLOR : isClaimed ? CLAIMED_COLOR : UNCLAIMED_COLOR;

  // Build description parts
  const descParts: string[] = [];
  if (Option.isSome(opts.description)) {
    descParts.push(opts.description.value);
  }
  descParts.push(toDiscordTimestamp(opts.startAt, 'R'));

  // Build fields
  const fields: Array<Discord.RichEmbedField> = [];

  // When field
  const startTs = toDiscordTimestamp(opts.startAt, 'f');
  const when = Option.match(opts.endAt, {
    onNone: () => startTs,
    onSome: (endAt) => {
      const endStyle = isSameDay(opts.startAt, endAt) ? 't' : 'f';
      return `${startTs} — ${toDiscordTimestamp(endAt, endStyle)}`;
    },
  });
  fields.push({ name: m.bot_embed_when({}, { locale }), value: when, inline: false });

  // Where field (optional)
  Option.match(locationDisplay(opts.location, opts.locationUrl), {
    onNone: () => undefined,
    onSome: (value) =>
      fields.push({ name: m.bot_embed_where({}, { locale }), value, inline: false }),
  });

  // Status field — only when active
  if (isActive) {
    const statusDisplay = Option.match(opts.claimedBy, {
      onNone: () => m.bot_claim_status_unclaimed({}, { locale }),
      onSome: (claimer) =>
        m.bot_claim_status_claimed_by({ user: formatNameWithMention(claimer) }, { locale }),
    });
    fields.push({
      name: m.bot_claim_status_label({}, { locale }),
      value: statusDisplay,
      inline: false,
    });
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_claim_message_title({ title: opts.title }, { locale }),
      description: descParts.join('\n'),
      color,
      fields,
    },
  ];

  // Build components (buttons)
  const components: Array<Discord.ActionRowComponentForMessageRequest> = [];

  if (isActive) {
    const rowButtons: Array<Discord.ButtonComponentForMessageRequest> = [];
    if (isClaimed) {
      // Release button — Secondary (style 2)
      rowButtons.push(
        UI.button({
          style: 2, // style 2 = Secondary
          label: m.bot_unclaim_button({}, { locale }),
          custom_id: `unclaim:${opts.teamId}:${opts.eventId}`,
        }),
      );
    } else {
      // Claim button — Primary (style 1)
      rowButtons.push(
        UI.button({
          style: 1, // style 1 = Primary
          label: m.bot_claim_button({}, { locale }),
          custom_id: `claim:${opts.teamId}:${opts.eventId}`,
        }),
      );
    }
    if (rowButtons.length > 0) {
      components.push(UI.row(rowButtons));
    }
  }

  return { embeds, components };
};
