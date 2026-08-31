// Should-fix 4 (whole-series review of commit 46806427): `deriveJoinStatusState` is now the ONLY
// place that decides whether a `discord_code` is stale. This used to be a SQL `WHERE` clause on
// `InviteAcceptancesRepository.findOpenByUserAndTeam` (`generated_at > now() - interval '24
// hours'`) that filtered a stale-code row out of the query result entirely — the caller saw
// `None` and rendered generic "No invite available" instead of the `'expired'` state this union
// already has dedicated copy for (CC-3). See `joinStatusState.ts` and
// `InviteAcceptancesRepository.ts`'s `findOpenByUserAndTeam` doc comment for the full rationale.

import { describe, expect, it } from '@effect/vitest';
import type { Onboarding } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { DISCORD_CODE_MAX_AGE_HOURS } from '~/utils/inviteExpiry.js';
import { deriveJoinStatusState } from '~/utils/joinStatusState.js';

const baseAcceptance = {
  discord_code: Option.none<string>(),
  discord_code_error_code: Option.none<Onboarding.InviteGeneratorErrorCode>(),
  created_at: DateTime.nowUnsafe(),
  generated_at: Option.none<Date>(),
};

describe('deriveJoinStatusState — discord_code staleness (should-fix 4)', () => {
  it("a fresh discord_code (generated moments ago) is 'ready'", () => {
    const result = deriveJoinStatusState({
      ...baseAcceptance,
      discord_code: Option.some('fresh-code'),
      generated_at: Option.some(DateTime.toDateUtc(DateTime.nowUnsafe())),
    });

    expect(result.state).toBe('ready');
    expect(Option.getOrNull(result.discordInviteUrl)).toBe('https://discord.gg/fresh-code');
  });

  it("a discord_code generated just under DISCORD_CODE_MAX_AGE_HOURS ago is still 'ready'", () => {
    const generatedAt = DateTime.toDateUtc(
      DateTime.subtract(DateTime.nowUnsafe(), { hours: DISCORD_CODE_MAX_AGE_HOURS - 1 }),
    );

    const result = deriveJoinStatusState({
      ...baseAcceptance,
      discord_code: Option.some('almost-stale-code'),
      generated_at: Option.some(generatedAt),
    });

    expect(result.state).toBe('ready');
  });

  it("a discord_code generated more than DISCORD_CODE_MAX_AGE_HOURS ago is 'expired', not 'ready'", () => {
    const generatedAt = DateTime.toDateUtc(
      DateTime.subtract(DateTime.nowUnsafe(), { hours: DISCORD_CODE_MAX_AGE_HOURS + 1 }),
    );

    const result = deriveJoinStatusState({
      ...baseAcceptance,
      discord_code: Option.some('stale-code'),
      generated_at: Option.some(generatedAt),
    });

    expect(result.state).toBe('expired');
    // CC-3: expiry is carried by `state`, never by `errorCode`, and no dead invite URL leaks out.
    expect(Option.isNone(result.errorCode)).toBe(true);
    expect(Option.isNone(result.discordInviteUrl)).toBe(true);
  });

  it('discordJoined still wins over a stale discord_code — joined beats everything', () => {
    const generatedAt = DateTime.toDateUtc(
      DateTime.subtract(DateTime.nowUnsafe(), { hours: DISCORD_CODE_MAX_AGE_HOURS + 1 }),
    );

    const result = deriveJoinStatusState(
      {
        ...baseAcceptance,
        discord_code: Option.some('stale-code'),
        generated_at: Option.some(generatedAt),
      },
      true,
    );

    expect(result.state).toBe('joined');
  });

  it('a present discord_code_error_code still wins when there is no discord_code at all', () => {
    const result = deriveJoinStatusState({
      ...baseAcceptance,
      discord_code_error_code: Option.some('bot_missing_perms'),
    });

    expect(result.state).toBe('failed');
  });
});
