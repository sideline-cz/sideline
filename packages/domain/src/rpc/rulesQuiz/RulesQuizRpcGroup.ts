/**
 * The scheduled rules quiz outbox, drained by the bot.
 *
 * Same three-call shape as every other sync feed here — fetch pending, mark
 * processed, mark failed — because the bot's `ProcessorService` pattern is
 * built around exactly that and a fourth shape would earn nothing.
 *
 * `MarkFailed` deliberately does NOT consume the event: the row stays
 * unprocessed so the next poll retries it. A Discord blip must not silently
 * cost a team its quiz, and `attempts`/`last_error` are what make a
 * permanently-broken event visible instead of invisible.
 */
import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';

export class RulesQuizPendingEvent extends Schema.Class<RulesQuizPendingEvent>(
  'RulesQuizPendingEvent',
)({
  id: Schema.String,
  team_id: TeamId,
  guild_id: Discord.Snowflake,
  channel_id: Discord.Snowflake,
  /** Plain `Schema.String`, matching `SubmitAttemptResultInput.scenario_id` —
   * `ScenarioId` is a bare TS brand with no runtime constructor, so callers
   * never need to brand it. */
  scenario_id: Schema.String,
}) {}

export const RulesQuizRpcGroup = RpcGroup.make(
  Rpc.make('RulesQuiz/PendingEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(RulesQuizPendingEvent),
  }),
  Rpc.make('RulesQuiz/MarkProcessed', {
    payload: { id: Schema.String },
    success: Schema.Void,
  }),
  Rpc.make('RulesQuiz/MarkFailed', {
    payload: { id: Schema.String, error: Schema.String },
    success: Schema.Void,
  }),
);
