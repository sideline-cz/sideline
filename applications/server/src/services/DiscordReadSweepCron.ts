import { Effect, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';

/**
 * Minutes a `discord_read_requests` row may live. The privacy policy quotes this number ("never
 * longer than five minutes"); change both together.
 */
export const DISCORD_READ_TTL_MINUTES = 5;

/**
 * The backstop for live Discord reads. The AI tool deletes its row when it reads the result or
 * gives up (15 s), so this only catches rows a crashed server replica left behind. Several
 * replicas each run it; a DELETE by age is safe to run in parallel.
 */
export const discordReadSweepEffect = Effect.Do.pipe(
  Effect.bind('reads', () => DiscordReadRequestsRepository.asEffect()),
  Effect.bind('swept', ({ reads }) => reads.sweepOlderThan(DISCORD_READ_TTL_MINUTES)),
  Effect.tap(({ swept }) =>
    swept === 0
      ? Effect.void
      : Effect.logInfo(
          `DiscordReadSweepCron: deleted ${String(swept)} live-read row(s) older than ${String(DISCORD_READ_TTL_MINUTES)} minutes`,
        ),
  ),
  Effect.asVoid,
  withCronMetrics('discord-read-sweep'),
);

export const DiscordReadSweepCron = discordReadSweepEffect.pipe(
  Effect.repeat(Schedule.cron('* * * * *')),
  Effect.asVoid,
);
