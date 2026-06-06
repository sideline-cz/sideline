import type { EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Array, DateTime, Option, pipe } from 'effect';
import type { Locale } from '~/locale.js';
import { formatName } from '../utils.js';
import { locationDisplay } from './locationDisplay.js';

export const YES_EMBED_LIMIT = 20;

const EVENT_TYPE_COLORS: Record<string, number> = {
  training: 0x57f287, // green
  match: 0xed4245, // red
  tournament: 0xfee75c, // yellow
  meeting: 0x5865f2, // blurple
  social: 0xeb459e, // pink
  other: 0x99aab5, // grey
};

const DEFAULT_COLOR = 0x99aab5;

const CANCELLED_COLOR = 0xed4245;

const STARTED_COLOR = 0xfee75c; // yellow

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

export const buildEventEmbed = (opts: {
  teamId: string;
  eventId: string;
  title: string;
  description: Option.Option<string>;
  imageUrl: Option.Option<string>;
  startAt: DateTime.Utc;
  endAt: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  locationUrl: Option.Option<string>;
  eventType: string;
  counts: EventRpcModels.RsvpCountsResult;
  yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>;
  locale: Locale;
  isStarted?: boolean;
  allDay?: boolean;
}): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const locale = opts.locale;
  const descParts: string[] = [];
  if (opts.isStarted) {
    descParts.push(m.bot_event_started({}, { locale }));
  }
  if (Option.isSome(opts.description)) {
    descParts.push(opts.description.value);
  }
  descParts.push(toDiscordTimestamp(opts.startAt, 'R'));

  const fields: Array<Discord.RichEmbedField> = [];

  const when = opts.allDay
    ? Option.match(opts.endAt, {
        onNone: () => toDiscordTimestamp(opts.startAt, 'D'),
        onSome: (endAt) =>
          isSameDay(opts.startAt, endAt)
            ? toDiscordTimestamp(opts.startAt, 'D')
            : `${toDiscordTimestamp(opts.startAt, 'D')} — ${toDiscordTimestamp(endAt, 'D')}`,
      })
    : Option.match(opts.endAt, {
        onNone: () => toDiscordTimestamp(opts.startAt, 'f'),
        onSome: (endAt) => {
          const endStyle = isSameDay(opts.startAt, endAt) ? 't' : 'f';
          return `${toDiscordTimestamp(opts.startAt, 'f')} — ${toDiscordTimestamp(endAt, endStyle)}`;
        },
      });
  fields.push({ name: m.bot_embed_when({}, { locale }), value: when, inline: false });

  Option.match(locationDisplay(opts.location, opts.locationUrl), {
    onNone: () => undefined,
    onSome: (value) =>
      fields.push({ name: m.bot_embed_where({}, { locale }), value, inline: false }),
  });

  fields.push({
    name: m.bot_embed_rsvps({}, { locale }),
    value: m.bot_embed_rsvp_summary(
      {
        yes: String(opts.counts.yesCount),
        no: String(opts.counts.noCount),
        maybe: String(opts.counts.maybeCount),
      },
      { locale },
    ),
  });

  if (!opts.isStarted && opts.yesAttendees.length > 0) {
    const names = pipe(opts.yesAttendees, Array.map(formatName), Array.join(', '));
    const extra =
      opts.counts.yesCount > opts.yesAttendees.length
        ? ` +${opts.counts.yesCount - opts.yesAttendees.length} more`
        : '';
    fields.push({
      name: m.bot_embed_going({}, { locale }),
      value: names + extra,
      inline: false,
    });
  }

  const color = opts.isStarted
    ? STARTED_COLOR
    : (EVENT_TYPE_COLORS[opts.eventType] ?? DEFAULT_COLOR);

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: opts.title,
      description: descParts.join('\n'),
      color,
      fields,
      ...(Option.isSome(opts.imageUrl) ? { thumbnail: { url: opts.imageUrl.value } } : {}),
    },
  ];

  const components: Array<Discord.ActionRowComponentForMessageRequest> = [];

  const rowButtons: Array<Discord.ButtonComponentForMessageRequest> = [];

  if (opts.counts.canRsvp) {
    rowButtons.push(
      {
        type: 2,
        style: 3,
        label: m.bot_btn_yes({}, { locale }),
        custom_id: `rsvp:${opts.teamId}:${opts.eventId}:yes`,
      },
      {
        type: 2,
        style: 4,
        label: m.bot_btn_no({}, { locale }),
        custom_id: `rsvp:${opts.teamId}:${opts.eventId}:no`,
      },
      {
        type: 2,
        style: 2,
        label: m.bot_btn_maybe({}, { locale }),
        custom_id: `rsvp:${opts.teamId}:${opts.eventId}:maybe`,
      },
    );
  }

  if (!opts.isStarted) {
    rowButtons.push({
      type: 2,
      style: 2,
      label: m.bot_btn_attendees({}, { locale }),
      custom_id: `attendees:${opts.teamId}:${opts.eventId}:0`,
    });
  }

  if (rowButtons.length > 0) {
    components.push({ type: 1, components: rowButtons });
  }

  return { embeds, components };
};

export const buildCancelledEmbed = (
  title: string,
  locale: Locale,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => ({
  embeds: [
    {
      title: `~~${title}~~`,
      description: m.bot_event_cancelled({}, { locale }),
      color: CANCELLED_COLOR,
    },
  ],
  components: [],
});
