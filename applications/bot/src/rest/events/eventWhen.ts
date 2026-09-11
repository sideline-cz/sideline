import * as m from '@sideline/i18n/messages';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { discordDateInstant, toDiscordTimestamp } from '~/rest/discordTimestamp.js';

/** Exported (tested directly, and reused by callers that need the same UTC-day comparison). */
export const isSameUtcDay = (a: DateTime.Utc, b: DateTime.Utc): boolean =>
  DateTime.formatIsoDateUtc(a) === DateTime.formatIsoDateUtc(b);

export type EventWhen = {
  readonly startAt: DateTime.Utc;
  /** UTC calendar date (`YYYY-MM-DD`) of `startAt`, used only by the all-day branch. Carried
   * separately from `startAt` because the display instant for an all-day event must be
   * reconstructed from the calendar date (§11.4 of the plan), not read off the stored instant. */
  readonly startDate: string;
  readonly endAt: Option.Option<DateTime.Utc>;
  readonly endDate: Option.Option<string>;
  readonly allDay: boolean;
  readonly locale: Locale;
};

/** All-day rendering: `<t:S:D>` alone, or `<t:S:D> — <t:E:D>` when `endDate` is strictly after
 * `startDate`. Bad data (`endDate` before or equal to `startDate`) falls back to the single-day
 * form — never an inverted range. The display instants are reconstructed from the date strings
 * via `discordDateInstant`, which anchors at 12:00Z of that date and is total (never throws). */
const allDayDates = (opts: EventWhen): string => {
  const startInstant = discordDateInstant(opts.startDate, opts.startAt);
  const rangeEndDate = Option.filter(opts.endDate, (endDate) => endDate > opts.startDate);

  return Option.match(rangeEndDate, {
    onNone: () => toDiscordTimestamp(startInstant, 'D'),
    onSome: (endDate) => {
      const endFallback = Option.getOrElse(opts.endAt, () => opts.startAt);
      const endInstant = discordDateInstant(endDate, endFallback);
      return `${toDiscordTimestamp(startInstant, 'D')} — ${toDiscordTimestamp(endInstant, 'D')}`;
    },
  });
};

const allDayMarker = (locale: Locale): string => m.bot_embed_all_day({}, { locale });

const timedWhen = (opts: EventWhen): string =>
  Option.match(opts.endAt, {
    onNone: () => toDiscordTimestamp(opts.startAt, 'f'),
    onSome: (endAt) => {
      const style = isSameUtcDay(opts.startAt, endAt) ? 't' : 'f';
      return `${toDiscordTimestamp(opts.startAt, 'f')} — ${toDiscordTimestamp(endAt, style)}`;
    },
  });

/** "Kdy" fields, reminder embeds. */
export const formatEventWhen = (opts: EventWhen): string =>
  opts.allDay ? `${allDayDates(opts)} · ${allDayMarker(opts.locale)}` : timedWhen(opts);

/** `handleStarted` ONLY. The timed branch deliberately ignores `endAt` — `handleStarted.ts`
 * has always emitted a single `<t:S:F>` with no end range, and that must stay byte-identical. */
export const formatEventWhenLong = (opts: EventWhen): string =>
  opts.allDay
    ? `${allDayDates(opts)} · ${allDayMarker(opts.locale)}`
    : toDiscordTimestamp(opts.startAt, 'F');
