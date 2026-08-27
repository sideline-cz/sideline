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
 * Whether this team is due right now.
 *
 * Two independent conditions, both required: the team's LOCAL clock reads the
 * configured `HH:MM`, and enough days have passed since the last post. The
 * minute check is what keeps the cron's once-per-minute tick from posting all
 * day; the interval check is what makes it every N days rather than daily.
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
  if (local === undefined || local !== args.time) return false;
  if (args.lastScheduledForMs === undefined) return true;
  const elapsedDays = (args.nowMs - args.lastScheduledForMs) / (24 * 60 * 60 * 1000);
  // `- 0.5` tolerates the minute-granularity window and any DST shift, without
  // ever allowing two posts inside the same interval.
  return elapsedDays >= args.intervalDays - 0.5;
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

/** Once a minute, matching the other schedule-driven crons — the `HH:MM`
 * check needs minute granularity to fire at all. */
export const RulesQuizCronEffect = rulesQuizCronEffect.pipe(
  withCronMetrics('rules_quiz'),
  Effect.repeat(Schedule.spaced('1 minute')),
);
