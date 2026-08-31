// CC-4: the shared window constants for the invite-acceptance expiry sweep. There is exactly
// one producer (`InviteAcceptancesRepository.sweepExpired`, PR-3) of the daily, authoritative
// `'expired'` error code, and exactly one consumer of the *derived* window (`getJoinStatus`'s
// defensive guard, PR-5). Both import from here so they can never disagree about the boundary.
//
// The derived window MUST be strictly larger than the sweep window. The sweep is a daily cron;
// the derived guard runs on every 2-second poll. If they used the same window, a row would cross
// the derived boundary up to 24 hours before the sweep writes it, and a user reloading the page
// could see `'expired'` flip back to `'preparing'` on the next poll. Keeping the derived window
// one day wider guarantees the sweep always closes a row before the derived guard would have
// shown it as expired, so the UI never flips backwards.
export const INVITE_ACCEPTANCE_SWEEP_DAYS = 3;
export const INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS = INVITE_ACCEPTANCE_SWEEP_DAYS + 1;

// Should-fix 4 (whole-series review of commit 46806427): how long a minted `discord_code` stays
// usable — mirrors the bot's `max_age: 86400` on the one-time invite it creates
// (`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts`). Consumed by
// `joinStatusState.ts`'s `deriveJoinStatusState`, which is now the ONLY place that decides a
// `discord_code` is stale — `InviteAcceptancesRepository.findOpenByUserAndTeam` used to bake this
// same 24h boundary into a SQL `WHERE`, which filtered a stale-code row out of the result entirely
// (`None`) instead of letting it be classified `'expired'` with its dedicated copy.
export const DISCORD_CODE_MAX_AGE_HOURS = 24;
