import { Effect, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';

const cronEffect = Effect.Do.pipe(
  Effect.bind('thresholds', () => AgeThresholdRepository.asEffect()),
  Effect.bind('ageCheck', () => AgeCheckService.asEffect()),
  Effect.tap(() => Effect.logInfo('AgeCheckCron: starting evaluation cycle')),
  Effect.bind('teamIds', ({ thresholds }) => thresholds.getAllTeamsWithRules()),
  Effect.let('today', () => new Date()),
  Effect.tap(({ teamIds, ageCheck, today }) =>
    Effect.all(
      teamIds.map((teamId) =>
        ageCheck
          .evaluate(teamId, today)
          .pipe(
            Effect.tap((changes) =>
              changes.length > 0
                ? Effect.logInfo(
                    `AgeCheckCron: team ${teamId} — ${String(changes.length)} role changes applied`,
                  )
                : Effect.void,
            ),
          ),
      ),
    ),
  ),
  Effect.tap(() => Effect.logInfo('AgeCheckCron: evaluation cycle complete')),
  Effect.asVoid,
  withCronMetrics('age-check'),
);

const cronSchedule = Schedule.cron('0 2 * * *');

export const AgeCheckCron = cronEffect.pipe(Effect.repeat(cronSchedule), Effect.asVoid);
