/**
 * Single-use exchange tokens behind the bot's `/login` command.
 *
 * The plaintext token lives only in the Discord ephemeral message and in the URL the
 * user clicks. This table stores `sha256(token)` — so a database read gives an attacker
 * a hash, not a credential, exactly like `team_onboarding_tokens`.
 *
 * **There is no secret comparison anywhere in this file, by construction.** `redeem`
 * looks up `WHERE token_hash = sha256(presented)`. A timing oracle on that index probe
 * leaks about the *hash*; turning that into a token needs a preimage. `timingSafeEqual`
 * would be cargo cult here, so its absence is deliberate rather than an oversight.
 */
import { Auth, Discord } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export interface CreateInput {
  readonly token_hash: string;
  readonly user_id: Auth.UserId;
  readonly issued_from_guild_id: Option.Option<Discord.Snowflake>;
  readonly expires_at: Date;
}

export interface RedeemInput {
  readonly token_hash: string;
  readonly session_token: string;
  readonly session_expires_at: Date;
}

const CreateRequest = Schema.Struct({
  token_hash: Schema.String,
  user_id: Auth.UserId,
  issued_from_guild_id: Schema.OptionFromNullOr(Discord.Snowflake),
  expires_at: Schema.instanceOf(Date),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _revokeOutstanding = SqlSchema.void({
    Request: Auth.UserId,
    execute: (userId) => sql`
      UPDATE discord_login_tokens
      SET revoked_at = now()
      WHERE user_id = ${userId} AND consumed_at IS NULL AND revoked_at IS NULL
    `,
  });

  const _create = SqlSchema.void({
    Request: CreateRequest,
    execute: (input) => sql`
      INSERT INTO discord_login_tokens (token_hash, user_id, issued_from_guild_id, expires_at)
      VALUES (${input.token_hash}, ${input.user_id}, ${input.issued_from_guild_id}, ${input.expires_at})
    `,
  });

  // ONE statement claims the token. Never read-then-write: a second concurrent redeem
  // matches zero rows because `consumed_at IS NULL` no longer holds, so single-use is
  // enforced by Postgres rather than by the order of two queries.
  const _claim = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Schema.String, user_id: Auth.UserId }),
    execute: (hash) => sql`
      UPDATE discord_login_tokens
      SET consumed_at = now()
      WHERE token_hash = ${hash}
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id
    `,
  });

  const _createSession = SqlSchema.findOne({
    Request: Schema.Struct({
      user_id: Auth.UserId,
      token: Schema.String,
      expires_at: Schema.instanceOf(Date),
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      INSERT INTO sessions (user_id, token, expires_at)
      VALUES (${input.user_id}, ${input.token}, ${input.expires_at})
      RETURNING id
    `,
  });

  const _linkSession = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String, session_id: Schema.String }),
    execute: (input) => sql`
      UPDATE discord_login_tokens SET session_id = ${input.session_id} WHERE id = ${input.id}
    `,
  });

  /** Revokes every outstanding link for the user, then issues a fresh one.
   *
   * The revoke is the feature's whole withdrawal story: "that link went somewhere
   * wrong" is answered by running `/login` again. It also caps an attacker spamming
   * the command at ONE live token, whatever the rate limiter does. */
  const issue = (input: CreateInput) =>
    sql
      .withTransaction(
        _revokeOutstanding(input.user_id).pipe(
          Effect.flatMap(() =>
            _create({
              token_hash: input.token_hash,
              user_id: input.user_id,
              issued_from_guild_id: input.issued_from_guild_id,
              expires_at: input.expires_at,
            }),
          ),
        ),
      )
      .pipe(catchSqlErrors);

  /** Claims the token and mints the session in ONE transaction. Returns `None` when the
   * token is unknown, already used, revoked or expired — every failure mode collapses to
   * the same answer on purpose, so the endpoint cannot leak which one it was. */
  const redeem = (input: RedeemInput) =>
    sql
      .withTransaction(
        _claim(input.token_hash).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) =>
                _createSession({
                  user_id: row.user_id,
                  token: input.session_token,
                  expires_at: input.session_expires_at,
                }).pipe(
                  Effect.orDie,
                  Effect.tap((session) => _linkSession({ id: row.id, session_id: session.id })),
                  Effect.as(Option.some({ user_id: row.user_id })),
                ),
            }),
          ),
        ),
      )
      .pipe(catchSqlErrors);

  return { issue, redeem };
});

export class DiscordLoginTokensRepository extends ServiceMap.Service<
  DiscordLoginTokensRepository,
  Effect.Success<typeof make>
>()('api/DiscordLoginTokensRepository') {
  static readonly Default = Layer.effect(DiscordLoginTokensRepository, make);
}
