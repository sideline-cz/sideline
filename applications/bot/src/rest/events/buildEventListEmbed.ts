import type { EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { locationDisplay } from './locationDisplay.js';

const EVENT_COLOR = 0x5865f2;

const EVENT_TYPE_EMOJIS: Record<string, string> = {
  training: '\u{1F3C3}',
  match: '\u{26BD}',
  tournament: '\u{1F3C6}',
  meeting: '\u{1F4CB}',
  social: '\u{1F389}',
  other: '\u{1F4C5}',
};

const toDiscordTimestamp = (
  dt: DateTime.Utc,
  style: 'D' | 'F' | 'R' | 'd' | 'f' | 't' = 'f',
): string => {
  const unix = Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000);
  return `<t:${unix}:${style}>`;
};

const formatEntry = (entry: EventRpcModels.GuildEventListEntry, locale: Locale): string => {
  const emoji = EVENT_TYPE_EMOJIS[entry.event_type] ?? EVENT_TYPE_EMOJIS.other;
  const locationPart = Option.match(locationDisplay(entry.location, entry.location_url), {
    onNone: () => '',
    onSome: (text) => `\n\u{1F4CD} ${text}`,
  });
  const rsvpSummary = m.bot_embed_rsvp_summary(
    {
      yes: String(entry.yes_count),
      no: String(entry.no_count),
      maybe: String(entry.maybe_count),
    },
    { locale },
  );
  const startTs = toDiscordTimestamp(entry.start_at, entry.all_day ? 'D' : 'f');
  return `${emoji} **${entry.title}**\n${startTs}${locationPart}\n${rsvpSummary}`;
};

export const PAGE_SIZE = 5;

export const buildEventListEmbed = (opts: {
  events: ReadonlyArray<EventRpcModels.GuildEventListEntry>;
  total: number;
  offset: number;
  guildId: string;
  locale: Locale;
}): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const locale = opts.locale;
  const page = Math.floor(opts.offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(opts.total / PAGE_SIZE));

  const description =
    opts.events.length === 0
      ? m.bot_event_list_empty({}, { locale })
      : opts.events.map((e) => formatEntry(e, locale)).join('\n\n');

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_event_list_title({}, { locale }),
      description,
      color: EVENT_COLOR,
      footer: {
        text: m.bot_event_list_footer(
          {
            page: String(page),
            totalPages: String(totalPages),
            total: String(opts.total),
          },
          { locale },
        ),
      },
    },
  ];

  const components: Array<Discord.ActionRowComponentForMessageRequest> = [];

  if (opts.total > PAGE_SIZE) {
    components.push(
      UI.row([
        UI.button({
          style: 2,
          label: m.bot_btn_prev({}, { locale }),
          custom_id: `event-list-page:${opts.guildId}:${opts.offset - PAGE_SIZE}`,
          disabled: opts.offset === 0,
        }),
        UI.button({
          style: 2,
          label: m.bot_btn_next({}, { locale }),
          custom_id: `event-list-page:${opts.guildId}:${opts.offset + PAGE_SIZE}`,
          disabled: opts.offset + PAGE_SIZE >= opts.total,
        }),
      ]),
    );
  }

  return { embeds, components };
};
