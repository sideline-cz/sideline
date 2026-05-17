import { Auth, type FeeAssignment, ICalApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Effect, Option } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { env } from '~/env.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';

const HISTORY_CAP_MS = 180 * 24 * 60 * 60 * 1000;

const formatDateTimeUtc = (dt: DateTime.Utc): string => {
  const s = DateTime.formatIso(dt);
  return `${s.replace(/[-:]/g, '').replace(/\.\d+/, '').replace('Z', '')}Z`;
};

const formatDateOnly = (dt: Date, tz: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt);
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  return `${year}${month}${day}`;
};

const addOneDay = (dateStr: string): string => {
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = parseInt(dateStr.slice(6, 8), 10);
  const next = new Date(Date.UTC(year, month, day + 1));
  const y = String(next.getUTCFullYear()).padStart(4, '0');
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
};

const escapeICalText = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

const buildWebcalUrl = (token: string): string => {
  const serverUrl = env.SERVER_URL.toString().replace(/\/$/, '');
  return `webcal://${serverUrl.replace(/^https?:\/\//, '')}/ical/${token}`;
};

type PaymentRow = {
  assignment_id: FeeAssignment.FeeAssignmentId;
  fee_name: string;
  currency: string;
  amount_minor: number;
  paid_minor: number;
  effective_due_at: Date;
  computed_status: FeeAssignment.FeeAssignmentStatus;
  stored_status: FeeAssignment.StoredAssignmentStatus;
  team_name?: string;
  team_timezone?: string;
};

const buildPaymentVEvents = (rows: ReadonlyArray<PaymentRow>, now: DateTime.Utc): Array<string> => {
  const nowMs = new Date(DateTime.formatIso(now)).getTime();
  const dtstamp = formatDateTimeUtc(now);
  const lines: Array<string> = [];

  for (const row of rows) {
    // Skip paid and waived
    if (row.computed_status === 'paid' || row.stored_status === 'waived') continue;
    // Skip beyond 180-day history cap
    if (nowMs - row.effective_due_at.getTime() > HISTORY_CAP_MS) continue;

    // The SQL query in findUnpaidAssignmentsForUser always returns a non-null team_timezone
    // (COALESCE(ts.timezone, 'UTC')); the `?? 'UTC'` only protects test mocks that omit it.
    const tz = row.team_timezone ?? 'UTC';
    const dtstart = formatDateOnly(row.effective_due_at, tz);
    const dtend = addOneDay(dtstart);
    const outstanding = row.amount_minor - row.paid_minor;
    const outstandingFormatted = (outstanding / 100).toFixed(2).replace(/\.?0+$/, '');
    const summaryPrefix = row.computed_status === 'overdue' ? '[Overdue] ' : '';
    const summary = `${summaryPrefix}Payment due — ${row.fee_name} (${outstandingFormatted} ${row.currency})`;

    const paidFormatted = (row.paid_minor / 100).toFixed(2).replace(/\.?0+$/, '');
    const description = [
      `Status: ${escapeICalText(row.computed_status)}`,
      `Outstanding: ${escapeICalText(outstandingFormatted)} ${escapeICalText(row.currency)}`,
      `Paid: ${escapeICalText(paidFormatted)} ${escapeICalText(row.currency)}`,
      `Team: ${escapeICalText(row.team_name ?? 'Sideline')}`,
    ].join('\\n');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:payment-${row.assignment_id}@sideline`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${dtstart}`);
    lines.push(`DTEND;VALUE=DATE:${dtend}`);
    lines.push(`SUMMARY:${escapeICalText(summary)}`);
    lines.push(`DESCRIPTION:${description}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('BEGIN:VALARM');
    lines.push('TRIGGER:-P1D');
    lines.push('ACTION:DISPLAY');
    lines.push('DESCRIPTION:Payment due tomorrow');
    lines.push('END:VALARM');
    lines.push('END:VEVENT');
  }

  return lines;
};

const buildICalFeed = (
  events: ReadonlyArray<{
    id: string;
    title: string;
    description: Option.Option<string>;
    start_at: DateTime.Utc;
    end_at: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    location_url: Option.Option<string>;
    status: string;
    event_type: string;
    team_name: string;
    rsvp_response: string;
  }>,
  paymentRows: ReadonlyArray<PaymentRow>,
  now: DateTime.Utc,
): string => {
  const teamName =
    events.length > 0 ? events[0].team_name : (paymentRows[0]?.team_name ?? 'Sideline');
  const calName = `${teamName} - Sideline events`;
  const dtstamp = formatDateTimeUtc(now);
  const lines: Array<string> = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sideline//Calendar//EN',
    `CALNAME:${escapeICalText(calName)}`,
    `X-WR-CALNAME:${escapeICalText(calName)}`,
  ];

  for (const event of events) {
    const prefix = event.rsvp_response === 'maybe' ? '[Maybe] ' : '';
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.id}@sideline`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${formatDateTimeUtc(event.start_at)}`);
    Option.map(event.end_at, (endAt) => {
      lines.push(`DTEND:${formatDateTimeUtc(endAt)}`);
    });
    lines.push(`SUMMARY:${escapeICalText(`${prefix}${event.title}`)}`);
    const description = Option.match(event.location_url, {
      onNone: () => event.description,
      onSome: (url) =>
        Option.some(
          Option.match(event.description, {
            onNone: () => url,
            onSome: (desc) => `${desc}\n\n${url}`,
          }),
        ),
    });
    Option.map(description, (desc) => {
      lines.push(`DESCRIPTION:${escapeICalText(desc)}`);
    });
    Option.map(event.location, (loc) => {
      lines.push(`LOCATION:${escapeICalText(loc)}`);
    });
    lines.push(`STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`);
    lines.push('END:VEVENT');
  }

  // Payment VEVENTs
  const paymentLines = buildPaymentVEvents(paymentRows, now);
  lines.push(...paymentLines);

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
};

export const ICalApiLive = HttpApiBuilder.group(Api, 'ical', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('icalTokens', () => ICalTokensRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('feeAssignments', () => FeeAssignmentsRepository.asEffect()),
    Effect.map(({ icalTokens, events, feeAssignments }) =>
      handlers
        .handle('getICalToken', () =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('existing', ({ currentUser }) => icalTokens.findByUserId(currentUser.id)),
            Effect.bind('token', ({ existing, currentUser }) =>
              Option.match(existing, {
                onNone: () => icalTokens.create(currentUser.id),
                onSome: Effect.succeed,
              }),
            ),
            Effect.map(
              ({ token }) =>
                new ICalApi.ICalTokenResponse({
                  token: token.token,
                  url: buildWebcalUrl(token.token),
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating iCal token — no row returned'),
            ),
          ),
        )
        .handle('regenerateICalToken', () =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('token', ({ currentUser }) => icalTokens.regenerate(currentUser.id)),
            Effect.map(
              ({ token }) =>
                new ICalApi.ICalTokenResponse({
                  token: token.token,
                  url: buildWebcalUrl(token.token),
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed regenerating iCal token — no row returned'),
            ),
          ),
        )
        .handle('getICalFeed', ({ params: { token } }) =>
          Effect.Do.pipe(
            Effect.bind('icalToken', () => icalTokens.findByToken(token)),
            Effect.bind('tokenRow', ({ icalToken }) =>
              Option.match(icalToken, {
                onNone: () => Effect.fail(new ICalApi.ICalTokenNotFound()),
                onSome: Effect.succeed,
              }),
            ),
            Effect.bind('userEvents', ({ tokenRow }) =>
              events.findEventsByUserId(tokenRow.user_id),
            ),
            Effect.bind('unpaidAssignments', ({ tokenRow }) =>
              feeAssignments.findUnpaidAssignmentsForUser(tokenRow.user_id),
            ),
            Effect.bind('now', () => DateTime.now),
            Effect.map(({ userEvents, unpaidAssignments, now }) =>
              HttpServerResponse.text(buildICalFeed(userEvents, unpaidAssignments, now), {
                contentType: 'text/calendar; charset=utf-8',
              }),
            ),
          ),
        ),
    ),
  ),
);
