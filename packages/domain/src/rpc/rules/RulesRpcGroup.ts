/**
 * The bot's user-scoped write path into the rules trainer.
 *
 * The web trainer submits over HTTP, authenticated by the caller's session
 * (`RulesTrainerApi`'s `AuthMiddleware`). The bot has no user session — it
 * authenticates as itself — so it cannot use that endpoint at all. It
 * instead passes the acting participant's `discord_user_id` and the server
 * resolves it to a `users` row, exactly as `Carpool/LeaveCarpool` does.
 *
 * That resolution is the whole security boundary here: a Discord snowflake
 * arrives from an interaction Discord itself signed, and only ever maps to
 * the one account that has linked it.
 *
 * ⚠️ Scoring is **not** a trust boundary on either path — the honour-system
 * decision in `docs/plans/rules-trainer.md` applies identically. Picks are
 * re-scored server-side against the real chain because that keeps ONE
 * definition of a score, not because the client is distrusted.
 */
import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { SubmitAttemptResultInput } from '~/api/RulesTrainerApi.js';
import * as Discord from '~/models/Discord.js';
import { Level, RulesAttemptMode } from '~/models/RulesProgress.js';

/**
 * No linked Sideline account for that Discord user.
 *
 * A typed failure rather than a silent no-op: the bot tells the participant
 * their run was not saved and why, instead of implying it was.
 */
export class RulesUserNotLinked extends Schema.ErrorClass<RulesUserNotLinked>('RulesUserNotLinked')(
  {
    _tag: Schema.tag('RulesUserNotLinked'),
  },
) {}

/** What the participant needs told back: how they scored, and that it stuck. */
export class RulesAttemptSaved extends Schema.Class<RulesAttemptSaved>('RulesAttemptSaved')({
  score: Schema.Int,
  total: Schema.Int,
}) {}

export const RulesRpcGroup = RpcGroup.make(
  Rpc.make('Rules/SubmitAttempt', {
    payload: {
      discord_user_id: Discord.Snowflake,
      mode: RulesAttemptMode,
      packages: Schema.Array(Level),
      results: Schema.Array(SubmitAttemptResultInput),
    },
    success: RulesAttemptSaved,
    error: Schema.Union([RulesUserNotLinked]),
  }),
);
