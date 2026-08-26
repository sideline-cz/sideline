import { RulesRpcGroup } from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { submitRulesAttempt } from '~/rules/submitAttempt.js';

/**
 * `Rules/SubmitAttempt` — the Discord bot's write path into the trainer.
 *
 * The only thing this adds over the HTTP handler is resolving the caller:
 * HTTP reads an authenticated session, this maps a Discord snowflake to a
 * `users` row. Everything after that — scoring, both inserts, and the
 * achievement fan-out across active memberships — is the SHARED
 * `submitRulesAttempt` pipeline, so a run answered in Discord earns exactly
 * what the same run answered on web would.
 *
 * An unlinked Discord user fails with `RulesUserNotLinked` rather than
 * silently succeeding, so the bot can tell the participant their run was not
 * saved instead of implying it was.
 */
export const RulesRpcLive = Effect.Do.pipe(
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.let(
    'Rules/SubmitAttempt',
    ({ users }) =>
      (payload: {
        readonly discord_user_id: string;
        readonly mode: 'practice' | 'exam';
        readonly packages: ReadonlyArray<number>;
        readonly results: ReadonlyArray<{
          readonly scenario_id: string;
          readonly steps: ReadonlyArray<Option.Option<number>>;
        }>;
      }) =>
        users.findByDiscordId(payload.discord_user_id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new RulesRpcGroup.RulesUserNotLinked()),
              onSome: (user) =>
                submitRulesAttempt(user.id, {
                  mode: payload.mode,
                  packages: payload.packages,
                  results: payload.results,
                }).pipe(
                  Effect.map(
                    (attempt) =>
                      new RulesRpcGroup.RulesAttemptSaved({
                        score: attempt.score,
                        total: attempt.total,
                      }),
                  ),
                ),
            }),
          ),
        ),
  ),
  Bind.remove('users'),
  (handlers) => RulesRpcGroup.RulesRpcGroup.toLayer(handlers),
);
