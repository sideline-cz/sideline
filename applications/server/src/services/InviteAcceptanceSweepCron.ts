import { Effect, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { INVITE_ACCEPTANCE_SWEEP_DAYS } from '~/utils/inviteExpiry.js';

// CC-4 / CC-5, PR-3 step 8: the ongoing backstop for the pre-deploy sweep (see PR-3 step 0 in
// `.work-plans/discord-onboarding-fix-plan.md`). Closes any `invite_acceptances` row that has
// neither a `discord_code` nor an error code and is older than the shared window
// (`applications/server/src/utils/inviteExpiry.ts`) to the terminal `'expired'` code.
//
// `Effect.repeat(Schedule.cron(...))` runs its body once immediately at startup, but it is one of
// many concurrent effects in `run.ts`'s `Effect.all` and is NOT sequenced ahead of the bot's 1 Hz
// `fastPollLoop` poll — this is exactly why the backlog is swept by hand, before this code ships
// (PR-3 step 0), rather than relying on this cron to win that race.
const cronEffect = Effect.Do.pipe(
  Effect.bind('acceptances', () => InviteAcceptancesRepository.asEffect()),
  Effect.tap(({ acceptances }) => acceptances.sweepExpired(INVITE_ACCEPTANCE_SWEEP_DAYS)),
  Effect.asVoid,
  withCronMetrics('invite-acceptance-sweep'),
);

export const InviteAcceptanceSweepCron = cronEffect.pipe(
  Effect.repeat(Schedule.cron('0 3 * * *')),
  Effect.asVoid,
);
