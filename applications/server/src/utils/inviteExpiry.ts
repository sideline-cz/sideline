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
