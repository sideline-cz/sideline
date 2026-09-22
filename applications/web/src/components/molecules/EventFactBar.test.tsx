// Tests for the event-detail redesign's compact fact strip (EventFactBar). Covers the date/time
// range rendering, the all-day badge, the "active only" relative chip (never shown for
// cancelled/started events), the day-delta path that keeps an all-day event reading "tomorrow"
// instead of "in 16 hours", location/training-type facts, and accessibility (aria-hidden icons,
// sr-only labels). No RSVP deadline row exists — the component's own doc comment says so, and
// test 17 below locks that.

import { getLocale } from '@sideline/i18n/runtime';
import { render, screen } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTz } from '../../../test/tz.js';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      event_eventDate: 'Date',
      event_allDayLabel: 'All day',
      event_location: 'Location',
      event_trainingType: 'Training Type',
      common_opensInNewTab: 'opens in a new tab',
    };
    return map[key] ?? key;
  },
}));

const { EventFactBar } = await import('./EventFactBar.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type EventDetailFixture = {
  startAt: DateTime.Utc;
  endAt: Option.Option<DateTime.Utc>;
  allDay: boolean;
  startDate: Option.Option<string>;
  endDate: Option.Option<string>;
  status: 'active' | 'cancelled' | 'started';
  location: Option.Option<string>;
  locationUrl: Option.Option<string>;
  eventType: 'training' | 'match' | 'tournament' | 'meeting' | 'social' | 'other';
  trainingTypeName: Option.Option<string>;
};

function makeEventDetail(overrides: Partial<EventDetailFixture> = {}): EventDetailFixture {
  return {
    startAt: DateTime.makeUnsafe('2026-09-24T14:00:00Z'),
    endAt: Option.none(),
    allDay: false,
    startDate: Option.none(),
    endDate: Option.none(),
    status: 'active',
    location: Option.none(),
    locationUrl: Option.none(),
    eventType: 'match',
    trainingTypeName: Option.none(),
    ...overrides,
  };
}

function renderFactBar(overrides: Partial<EventDetailFixture> = {}) {
  const eventDetail = makeEventDetail(overrides);
  return render(<EventFactBar eventDetail={eventDetail as never} />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventFactBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timed same-day event renders one date + a time range joined by an en dash; no all-day badge', () => {
    const { container } = renderFactBar({
      startAt: DateTime.makeUnsafe('2026-09-24T14:00:00Z'),
      endAt: Option.some(DateTime.makeUnsafe('2026-09-24T16:00:00Z')),
    });

    // Timed events render in BROWSER-LOCAL time, so the clock values shift with the runner's
    // zone (CI runs this suite under three of them). Assert the shape — one date, two times
    // joined by an en dash — not a fixed offset. `datetime.test.ts` owns the offset itself.
    expect(container.textContent).toMatch(/\d{2}:\d{2} – \d{2}:\d{2}/);
    expect(screen.queryByText('All day')).toBeNull();
  });

  it('no endAt renders start only — no en dash in the date line', () => {
    const { container } = renderFactBar({
      startAt: DateTime.makeUnsafe('2026-09-24T14:00:00Z'),
      endAt: Option.none(),
    });

    expect(container.textContent).not.toContain('–');
  });

  it('all-day event shows the All-day badge and no clock time', () => {
    renderFactBar({ allDay: true, startDate: Option.some('2026-09-24') });

    expect(screen.getByText('All day')).not.toBeNull();
    expect(screen.queryByText(/\d{2}:\d{2}/)).toBeNull();
  });

  it('all-day uses the server-projected startDate, not the noon-UTC instant', () => {
    const { container } = renderFactBar({
      allDay: true,
      startAt: DateTime.makeUnsafe('2026-09-24T12:00:00Z'),
      startDate: Option.some('2026-09-25'),
    });

    expect(container.textContent).toContain('2026-09-25');
    expect(container.textContent).not.toContain('2026-09-24');
  });

  it('multi-day timed event renders both day parts', () => {
    // A 48h span so the range straddles a local day boundary in EVERY zone — a 3h span that is
    // cross-day in UTC collapses to a single local day in the Americas and the assertion would
    // then be testing the runner's offset rather than the component.
    const { container } = renderFactBar({
      startAt: DateTime.makeUnsafe('2026-09-24T12:00:00Z'),
      endAt: Option.some(DateTime.makeUnsafe('2026-09-26T12:00:00Z')),
    });

    const match = container.textContent?.match(
      /(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} → (\d{4}-\d{2}-\d{2}) \d{2}:\d{2}/,
    );
    expect(match).not.toBeNull();
    expect((match as RegExpMatchArray)[1]).not.toBe((match as RegExpMatchArray)[2]);
  });

  it('relative chip present for an active timed event, computed via Intl.RelativeTimeFormat (never a hardcoded string)', () => {
    const now = new Date(2026, 5, 1, 10, 0, 0);
    vi.setSystemTime(now);

    const startAt = DateTime.makeUnsafe(
      new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    );
    renderFactBar({ status: 'active', startAt, endAt: Option.none() });

    const expected = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(3, 'day');
    expect(screen.getByText(expected)).not.toBeNull();
  });

  it('no relative chip when status is cancelled', () => {
    const now = new Date(2026, 5, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const startAt = DateTime.makeUnsafe(
      new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    );

    renderFactBar({ status: 'cancelled', startAt });

    const expected = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(3, 'day');
    expect(screen.queryByText(expected)).toBeNull();
  });

  it('no relative chip when status is started', () => {
    const now = new Date(2026, 5, 1, 10, 0, 0);
    vi.setSystemTime(now);
    const startAt = DateTime.makeUnsafe(
      new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    );

    renderFactBar({ status: 'started', startAt });

    const expected = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(3, 'day');
    expect(screen.queryByText(expected)).toBeNull();
  });

  it('an all-day event tomorrow reads as "tomorrow", not "in 16 hours" — proves the day-delta path, not the instant-based one, is used', () => {
    // 20:00 local "now" on a calendar day; the all-day event's server-projected date is the NEXT
    // calendar day, only 16 hours away by the clock. If this used `formatRelative` (instant-based)
    // it would read something like "in 16 hours"; the day-delta path must read "tomorrow" instead.
    const now = new Date(2027, 5, 14, 20, 0, 0);
    vi.setSystemTime(now);

    renderFactBar({
      allDay: true,
      status: 'active',
      startAt: DateTime.makeUnsafe('2027-06-15T12:00:00Z'),
      startDate: Option.some('2027-06-15'),
      endAt: Option.none(),
    });

    const expected = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' }).format(1, 'day');
    expect(screen.getByText(expected)).not.toBeNull();
  });

  it('location with an https url renders an anchor opening in a new tab', () => {
    renderFactBar({
      location: Option.some('Stadium Letná'),
      locationUrl: Option.some('https://maps.example.com/letna'),
    });

    const link = screen.getByRole('link', { name: /Stadium Letná/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe('https://maps.example.com/letna');
  });

  it('location without a url renders plain text, not a link', () => {
    renderFactBar({ location: Option.some('Stadium Letná'), locationUrl: Option.none() });

    expect(screen.getByText('Stadium Letná')).not.toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('no location means no location row', () => {
    renderFactBar({ location: Option.none() });

    expect(screen.queryByText('Location')).toBeNull();
  });

  it('training type is NOT shown for a non-training event even when trainingTypeName is present', () => {
    renderFactBar({ eventType: 'match', trainingTypeName: Option.some('Goalkeeping') });

    expect(screen.queryByText('Goalkeeping')).toBeNull();
  });

  it('training type IS rendered for a training event (guards e2e/tests/events.spec.ts:45)', () => {
    renderFactBar({ eventType: 'training', trainingTypeName: Option.some('Goalkeeping') });

    expect(screen.getByText('Goalkeeping')).not.toBeNull();
  });

  it('every decorative icon is aria-hidden', () => {
    const { container } = renderFactBar({
      location: Option.some('Stadium Letná'),
      eventType: 'training',
      trainingTypeName: Option.some('Goalkeeping'),
    });

    const icons = container.querySelectorAll('svg');
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('every fact carries an sr-only label', () => {
    renderFactBar({
      location: Option.some('Stadium Letná'),
      eventType: 'training',
      trainingTypeName: Option.some('Goalkeeping'),
    });

    expect(screen.getByText('Date:')).not.toBeNull();
    expect(screen.getByText('Location:')).not.toBeNull();
    expect(screen.getByText('Training Type:')).not.toBeNull();
  });

  it('renders no RSVP-deadline row', () => {
    renderFactBar();

    expect(screen.queryByText(/deadline/i)).toBeNull();
  });

  describe('all-day server-projected date is timezone-independent', () => {
    // Non-vacuous pair: a midnight-anchored instant read locally would give the 23rd under a
    // negative-offset zone. Since `startDate` is supplied directly, the rendered day must be the
    // 24th under BOTH zones — proving the derived string wins over any instant-based reformat.
    it('renders the 24th under Pacific/Auckland', () => {
      withTz('Pacific/Auckland', () => {
        const { container } = renderFactBar({
          allDay: true,
          startAt: DateTime.makeUnsafe('2026-09-24T12:00:00Z'),
          startDate: Option.some('2026-09-24'),
        });
        expect(container.textContent).toContain('2026-09-24');
      });
    });

    it('renders the 24th under America/Los_Angeles', () => {
      withTz('America/Los_Angeles', () => {
        const { container } = renderFactBar({
          allDay: true,
          startAt: DateTime.makeUnsafe('2026-09-24T12:00:00Z'),
          startDate: Option.some('2026-09-24'),
        });
        expect(container.textContent).toContain('2026-09-24');
      });
    });
  });
});
