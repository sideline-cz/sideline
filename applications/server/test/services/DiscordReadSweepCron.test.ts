import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { DiscordReadRequestsRepository } from '~/repositories/DiscordReadRequestsRepository.js';
import {
  DISCORD_READ_TTL_MINUTES,
  discordReadSweepEffect,
} from '~/services/DiscordReadSweepCron.js';

describe('DiscordReadSweepCron', () => {
  it.effect('one cycle sweeps rows older than the 5-minute TTL, once', () =>
    Effect.gen(function* () {
      const calls: Array<number> = [];
      const repo = Layer.succeed(DiscordReadRequestsRepository, {
        sweepOlderThan: (minutes: number) => {
          calls.push(minutes);
          return Effect.succeed(3);
        },
      } as never);

      yield* discordReadSweepEffect.pipe(Effect.provide(repo));

      expect(DISCORD_READ_TTL_MINUTES).toBe(5);
      expect(calls).toEqual([DISCORD_READ_TTL_MINUTES]);
    }),
  );
});
