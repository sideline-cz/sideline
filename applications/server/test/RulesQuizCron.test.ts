// `localHhMm`, `isDue` and `pickScenarioId` were exported to be testable and
// then never were — and the gap cost a real missed post: the owner configured
// a quiz for 22:35 Prague and nothing arrived.
//
// The cause is the first test below. `isDue` required an exact `HH:MM` match,
// and cron ticks drift, so a minute with no tick in it lost the post silently
// — no error, no log, nothing to notice.

import { describe, expect, it } from 'vitest';
import { isDue, localHhMm, pickScenarioId } from '~/services/RulesQuizCron.js';

/** 2026-08-28 20:35 UTC — 22:35 in Prague (CEST, UTC+2). */
const AUG_2035_UTC = Date.UTC(2026, 7, 28, 20, 35, 0);
const DAY = 24 * 60 * 60 * 1000;

const due = (over: Partial<Parameters<typeof isDue>[0]> = {}) =>
  isDue({
    nowMs: AUG_2035_UTC,
    timezone: 'Europe/Prague',
    time: '22:35',
    intervalDays: 7,
    lastScheduledForMs: undefined,
    ...over,
  });

describe('localHhMm', () => {
  it('reads the wall clock in the team timezone, not the server one', () => {
    expect(localHhMm(AUG_2035_UTC, 'Europe/Prague')).toBe('22:35');
    expect(localHhMm(AUG_2035_UTC, 'UTC')).toBe('20:35');
    expect(localHhMm(AUG_2035_UTC, 'America/New_York')).toBe('16:35');
  });

  it('honours the DST offset rather than a fixed one', () => {
    // Prague is UTC+2 in August and UTC+1 in January. A hardcoded offset would
    // put every winter post an hour out.
    expect(localHhMm(Date.UTC(2026, 0, 28, 20, 35, 0), 'Europe/Prague')).toBe('21:35');
  });

  it('returns undefined for a timezone Intl does not know', () => {
    // Must skip that one team, never throw the cycle for everyone else.
    expect(localHhMm(AUG_2035_UTC, 'Mars/Olympus_Mons')).toBeUndefined();
  });
});

describe('isDue', () => {
  it('fires at the configured minute', () => {
    expect(due()).toBe(true);
  });

  // ── The regression that lost a real post ────────────────────────────────
  it('still fires when no tick landed exactly on the configured minute', () => {
    // Ticks drift by however long each cycle takes, so after hours of uptime
    // they straddle a minute instead of landing in it. Under the old exact
    // match both of these were false and the post was skipped for the whole
    // interval.
    expect(due({ nowMs: AUG_2035_UTC + 61_000 })).toBe(true); // 22:36
    expect(due({ nowMs: AUG_2035_UTC + 25 * 60_000 })).toBe(true); // 23:00
  });

  it('fires late when the server was down at the configured time', () => {
    // A morning slot recovered two hours late is far better than losing the
    // post for the whole interval.
    const morning = { time: '08:00', nowMs: Date.UTC(2026, 7, 28, 6, 0, 0) }; // 08:00 Prague
    expect(due(morning)).toBe(true);
    expect(due({ ...morning, nowMs: Date.UTC(2026, 7, 28, 8, 0, 0) })).toBe(true); // 10:00
  });

  it('gives up on recovery once the local day rolls over', () => {
    // The known limit of comparing against the local wall clock: at-or-past
    // stops being true at local midnight, so a 22:35 slot missed across
    // midnight waits for the next interval rather than posting at 00:35 with
    // yesterday's date attached. Deliberate — a situation arriving in the
    // small hours labelled as the previous day's is worse than one skipped —
    // but it means a late-evening slot has a shorter recovery window than a
    // morning one.
    expect(due({ nowMs: AUG_2035_UTC + 2 * 60 * 60_000 })).toBe(false); // 00:35 next day
  });

  it('does not fire before the configured time', () => {
    expect(due({ nowMs: AUG_2035_UTC - 60_000 })).toBe(false);
    expect(due({ nowMs: AUG_2035_UTC - 12 * 60 * 60_000 })).toBe(false);
  });

  it('does not fire for a team whose timezone is unusable', () => {
    expect(due({ timezone: 'Mars/Olympus_Mons' })).toBe(false);
  });

  describe('interval', () => {
    it('is what actually prevents a second post inside the window', () => {
      // The at-or-past check is true all evening; this is the only thing
      // stopping a post every minute until midnight.
      const justPosted = { lastScheduledForMs: AUG_2035_UTC - 60_000 };
      expect(due(justPosted)).toBe(false);
      expect(due({ ...justPosted, nowMs: AUG_2035_UTC + 30 * 60_000 })).toBe(false);
    });

    it('fires again once the interval has elapsed', () => {
      expect(due({ lastScheduledForMs: AUG_2035_UTC - 7 * DAY })).toBe(true);
    });

    it('does not fire a day early', () => {
      expect(due({ lastScheduledForMs: AUG_2035_UTC - 6 * DAY })).toBe(false);
    });

    it('counts a post that ran past local midnight against THAT calendar day', () => {
      // Previously true: the half-day slack let a post 6d21h old through on a
      // weekly schedule. Counting calendar days makes this false — a post that
      // landed at 01:35 consumed the 22nd, so the next one is seven days from
      // the 22nd, not from the 21st it was aiming at.
      //
      // The trade is deliberate. That slack is exactly what produced the
      // twice-a-day bug below, and it cannot be kept for weekly while being
      // dropped for daily: it is one comparison. A schedule that walks a day
      // after a late post is a far smaller problem than one that posts twice.
      expect(due({ lastScheduledForMs: AUG_2035_UTC - (7 * DAY - 3 * 60 * 60_000) })).toBe(false);
      expect(due({ lastScheduledForMs: AUG_2035_UTC - 7 * DAY })).toBe(true);
    });

    it('handles a daily schedule', () => {
      expect(due({ intervalDays: 1, lastScheduledForMs: AUG_2035_UTC - DAY })).toBe(true);
      expect(due({ intervalDays: 1, lastScheduledForMs: AUG_2035_UTC - 60_000 })).toBe(false);
    });

    it('does NOT post a second time twelve hours later', () => {
      // The regression this whole comparison exists for. Reported in
      // production: a quiz configured once a day at 10:00 arrived at 10:00
      // AND 22:00, every day.
      //
      // The at-or-past time check is satisfied all evening, so the interval
      // check is the only thing holding the day shut. Under
      // `elapsedDays >= intervalDays - 0.5` it re-armed after twelve hours and
      // let the evening tick through.
      const tenPrague = Date.UTC(2026, 7, 28, 8, 0); // 10:00 CEST
      const tenPmPrague = Date.UTC(2026, 7, 28, 20, 0); // 22:00 CEST, same local day

      expect(
        due({
          nowMs: tenPmPrague,
          time: '10:00',
          intervalDays: 1,
          lastScheduledForMs: tenPrague,
        }),
      ).toBe(false);

      // ...and still fires the next day at the configured time.
      expect(
        due({
          nowMs: tenPrague + DAY,
          time: '10:00',
          intervalDays: 1,
          lastScheduledForMs: tenPrague,
        }),
      ).toBe(true);
    });

    it('does not double-post for an early-morning slot either', () => {
      // The case that rules out simply shrinking the slack. The window runs
      // from the configured time to local midnight, so a 00:30 slot leaves
      // 23.5 hours of open window — nearly any tolerance at all re-opens the
      // hole. Counting calendar days is indifferent to where in the day the
      // slot sits.
      const halfPastMidnight = Date.UTC(2026, 7, 27, 22, 30); // 00:30 CEST on the 28th
      const lateEvening = Date.UTC(2026, 7, 28, 21, 0); // 23:00 CEST, same local day

      expect(
        due({
          nowMs: lateEvening,
          time: '00:30',
          intervalDays: 1,
          lastScheduledForMs: halfPastMidnight,
        }),
      ).toBe(false);
    });

    it('fires immediately the first time, rather than after a full interval', () => {
      // Enabling the feature should show something that evening.
      expect(due({ lastScheduledForMs: undefined })).toBe(true);
    });
  });
});

describe('pickScenarioId', () => {
  it('is deterministic under an injected rng', () => {
    expect(pickScenarioId(() => 0)).toBe(pickScenarioId(() => 0));
  });

  it('can reach both ends of the content', () => {
    expect(pickScenarioId(() => 0)).toBeDefined();
    // 0.999… must not index past the end.
    expect(pickScenarioId(() => 0.9999999)).toBeDefined();
  });
});
