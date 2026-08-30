import { ALL_PACKAGES } from '@sideline/rules/content';
import { DateTime, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { RulesQuizSyncEventsRepository } from '~/repositories/RulesQuizSyncEventsRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';

/**
 * Posts one rules situation to a team's nominated channel every N days at a
 * local time. Enabled per team by setting `rules_quiz_channel_id`; every team
 * without one is skipped, which is all of them until someone opts in.
 *
 * **The schedule is anchored to the last post, not to a calendar.** "Next" is
 * N days after `MAX(scheduled_for)` for that team, so an outage, an
 * unreachable Discord, or enabling the feature mid-week never produces a
 * catch-up burst and never needs drift correction — the cadence simply
 * resumes from whatever actually went out. The trade is that the weekday
 * walks if a post is ever delayed past its window, which is the accepted
 * cost of not having a second source of truth for the schedule.
 *
 * Timezone handling follows `applications/web/AGENTS.md`'s team-scoped-date
 * rules: `rules_quiz_time` is `HH:MM` in the TEAM's `timezone`, never the
 * server's. That class of bug only appears for teams whose timezone differs
 * from the host's, and only at the boundary, so it will not show up in local
 * dev.
 */

const ALL_SCENARIO_IDS: readonly string[] = ALL_PACKAGES.flatMap((pkg) =>
  pkg.scenarios.map((s) => s.id),
);

/**
 * Local wall-clock `HH:MM` for `nowMs` in `timezone`, or `undefined` if the
 * timezone is not one Intl recognises — a bad value must skip the team, never
 * throw the whole cycle for everyone else.
 */
export const localHhMm = (nowMs: number, timezone: string): string | undefined => {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('hour')}:${get('minute')}`;
  } catch {
    return undefined;
  }
};

/**
 * Local calendar date as `YYYY-MM-DD` for `nowMs` in `timezone`, or
 * `undefined` if Intl does not know the zone. `en-CA` is the locale whose
 * short date format IS ISO order, so no reassembly is needed.
 */
export const localYmd = (nowMs: number, timezone: string): string | undefined => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs));
  } catch {
    return undefined;
  }
};

/**
 * Whole days between two `YYYY-MM-DD` dates. Both are parsed at UTC midnight,
 * so this counts CALENDAR days and a DST transition between them cannot make
 * the answer 6.958 instead of 7.
 */
const daysBetweenYmd = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (24 * 60 * 60 * 1000);

/**
 * Whether this team is due right now.
 *
 * Two conditions, both required: the team's LOCAL clock is at or past the
 * configured `HH:MM`, and at least `intervalDays` LOCAL CALENDAR DAYS have
 * turned over since the last post. The time check opens the day's window; the
 * day-count check is the only thing that closes it, so it has to be exact —
 * see the note on the comparison itself.
 *
 * Never posted before (`lastScheduledForMs` absent) is due immediately at the
 * next matching minute — enabling the feature should not mean waiting a full
 * interval to see anything.
 */
export const isDue = (args: {
  readonly nowMs: number;
  readonly timezone: string;
  readonly time: string;
  readonly intervalDays: number;
  readonly lastScheduledForMs: number | undefined;
}): boolean => {
  const local = localHhMm(args.nowMs, args.timezone);
  if (local === undefined) return false;
  // At-or-past, NOT an exact match.
  //
  // An exact `local === time` check silently drops a post whenever no tick
  // lands inside the configured minute — and ticks drift, because each cycle
  // costs a database round trip. After a few hours of uptime the drift
  // crosses a minute boundary, a tick lands at 22:34:5x and the next at
  // 22:36:0x, and 22:35 is never observed at all. Nothing logs, because from
  // the cron's point of view no team was ever due.
  //
  // Comparing lexicographically is safe: both sides are zero-padded `HH:MM`.
  //
  // The window this opens (due from the configured time until midnight local)
  // is closed by the interval check below, which is what actually prevents a
  // second post. The two conditions were never independent — the minute match
  // was doing duplicate-suppression it was never reliable enough to do.
  //
  // It also means a post missed because the server was down goes out when the
  // server comes back, rather than being skipped for the whole interval.
  if (local < args.time) return false;
  if (args.lastScheduledForMs === undefined) return true;

  // Whole LOCAL CALENDAR DAYS since the last post — not elapsed milliseconds.
  //
  // This used to be `elapsedDays >= intervalDays - 0.5`, and the half-day
  // slack combined with the at-or-past window above to post TWICE A DAY on a
  // daily schedule: a post at 10:00 satisfies the window all evening, and at
  // 22:00 the elapsed check re-arms because 12h >= 1 - 0.5 days. Observed in
  // production as 10:00 and 22:00 every day. The window and the slack are
  // each defensible alone; together they left nothing enforcing the interval.
  //
  // Shrinking the slack does not fix it, it just moves it: the window runs
  // from the configured time to local midnight, so any slack larger than
  // (midnight - time) re-opens the same hole — and for an early-morning slot
  // like 00:30 that window is 23.5h, so almost any slack at all does.
  //
  // Comparing calendar dates closes it by construction. A day can only be
  // counted once, whatever time within it the post actually went out, so the
  // "once a day" guarantee no longer depends on tick timing at all. It also
  // cannot drift the way an elapsed-milliseconds comparison does, where each
  // post is timed from the last one and jitter accumulates forward.
  const lastDay = localYmd(args.lastScheduledForMs, args.timezone);
  const nowDay = localYmd(args.nowMs, args.timezone);
  if (lastDay === undefined || nowDay === undefined) return false;
  return daysBetweenYmd(lastDay, nowDay) >= args.intervalDays;
};

/** `rng` is injectable so tests are deterministic, the same affordance
 * `@sideline/rules`' own `shuffle`/`buildPerms` expose. */
export const pickScenarioId = (rng: () => number = Math.random): string | undefined =>
  ALL_SCENARIO_IDS[Math.floor(rng() * ALL_SCENARIO_IDS.length)];

export const rulesQuizCronEffect = Effect.Do.pipe(
  Effect.bind('settingsRepo', () => TeamSettingsRepository.asEffect()),
  Effect.bind('eventsRepo', () => RulesQuizSyncEventsRepository.asEffect()),
  Effect.bind('now', () => DateTime.now),
  Effect.bind('teams', ({ settingsRepo }) => settingsRepo.findAllWithRulesQuizChannel()),
  Effect.tap(({ teams, now, eventsRepo }) =>
    Effect.forEach(
      teams,
      (team) => {
        const nowMs = DateTime.toEpochMillis(now);
        const due = isDue({
          nowMs,
          timezone: team.timezone,
          time: team.rules_quiz_time,
          intervalDays: team.rules_quiz_interval_days,
          lastScheduledForMs: Option.match(team.last_scheduled_for, {
            onNone: () => undefined,
            onSome: (d) => DateTime.toEpochMillis(d),
          }),
        });
        if (!due) return Effect.void;

        const scenarioId = pickScenarioId();
        if (scenarioId === undefined) return Effect.void;

        return eventsRepo
          .insertEvent({
            team_id: team.team_id,
            channel_id: team.rules_quiz_channel_id,
            scenario_id: scenarioId,
            scheduled_for: now,
          })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo(
                `RulesQuizCron: queued ${scenarioId} for team ${team.team_id} in ${team.rules_quiz_channel_id}`,
              ),
            ),
            // One team's failure must never abort the cycle for the rest.
            Effect.catchCause((cause) =>
              Effect.logWarning(`RulesQuizCron: failed to queue for team ${team.team_id}`, cause),
            ),
          );
      },
      { concurrency: 1 },
    ),
  ),
  Effect.asVoid,
);

/**
 * `fixed`, not `spaced`. `spaced` waits a minute AFTER each cycle finishes, so
 * every database round trip pushes the next tick later and the schedule walks
 * off wall-clock time over a day of uptime. `fixed` keeps ticks on the minute
 * regardless of how long a cycle takes.
 *
 * `isDue` no longer depends on this — it compares at-or-past precisely so a
 * missed minute cannot lose a post — but a cron that quietly stops matching
 * the clock is worth not having either way.
 */
export const RulesQuizCronEffect = rulesQuizCronEffect.pipe(
  withCronMetrics('rules_quiz'),
  Effect.repeat(Schedule.fixed('1 minute')),
);
