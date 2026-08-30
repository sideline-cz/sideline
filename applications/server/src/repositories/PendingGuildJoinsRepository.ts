import { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const PendingJoinRow = Schema.Struct({
  id: Schema.String.pipe(Schema.check(Schema.isUUID())),
  guild_id: Discord.Snowflake,
  discord_id: Schema.String,
  access_token: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _enqueue = SqlSchema.void({
    Request: Schema.Struct({ user_id: User.UserId, team_id: Team.TeamId }),
    execute: (input) => sql`
      INSERT INTO pending_guild_joins (user_id, team_id)
      VALUES (${input.user_id}, ${input.team_id})
      ON CONFLICT (user_id, team_id) DO UPDATE SET
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        created_at = now(),
        processed_at = NULL
      WHERE pending_guild_joins.status <> 'done'
    `,
  });

  const _listPending = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PendingJoinRow,
    execute: () => sql`
      SELECT pgj.id, t.guild_id, u.discord_id, oc.access_token
      FROM pending_guild_joins pgj
      JOIN teams t ON t.id = pgj.team_id
      JOIN users u ON u.id = pgj.user_id
      JOIN oauth_connections oc ON oc.user_id = pgj.user_id AND oc.provider = 'discord'
      WHERE pgj.status = 'pending'
      ORDER BY pgj.created_at ASC
      LIMIT 50
    `,
  });

  const _markDone = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String.pipe(Schema.check(Schema.isUUID())) }),
    execute: (input) => sql`
      UPDATE pending_guild_joins
      SET status = 'done', processed_at = now()
      WHERE id = ${input.id}
    `,
  });

  const _markFailed = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String.pipe(Schema.check(Schema.isUUID())),
      error: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE pending_guild_joins
      SET status = 'failed', attempts = attempts + 1, last_error = ${input.error}, processed_at = now()
      WHERE id = ${input.id}
    `,
  });

  const _requeueFailedForUser = SqlSchema.void({
    Request: Schema.Struct({ user_id: User.UserId }),
    // Blocker 2 (PR-4 review): only requeue rows whose team membership is still active. Without
    // this predicate, a user who deliberately leaves a guild (which deactivates their
    // `team_members` row via `Guild/RemoveMember`) gets silently re-added by the bot on every
    // subsequent login, forever — a login is not evidence the user still wants to be in the
    // guild, and intent may have reversed since the row was enqueued.
    //
    // Should-fix 4 (third review of PR-4): this does NOT close the loop unconditionally.
    // `deactivateMemberAndCascade` (`applications/server/src/utils/deactivateMemberCascade.ts`)
    // refuses to deactivate a member holding `team:manage` when they are the last one
    // (`reason === 'last_admin'`, to avoid orphaning the team) — that member's `team_members`
    // row stays `active`, so this `EXISTS` is still satisfied and their failed row is still
    // requeued on every login even though they deliberately left the guild. Chosen fix: this
    // comment, not the cascade — relaxing `deactivateMemberAndCascade`'s last-admin guard to let
    // a captain fully leave would orphan team management, which is a separate, larger decision
    // than this PR's scope (a guild leave that would orphan the team is arguably a case the
    // product should surface to the user, not silently allow). A captain in this situation can
    // still stop the requeue loop via "Get a new invite" once PR-5 ships, or by demoting/
    // reassigning `team:manage` before leaving.
    execute: (input) => sql`
      UPDATE pending_guild_joins
      SET status = 'pending', attempts = 0, last_error = NULL, processed_at = NULL
      WHERE user_id = ${input.user_id} AND status = 'failed'
        AND EXISTS (
          SELECT 1 FROM team_members tm
          WHERE tm.team_id = pending_guild_joins.team_id
            AND tm.user_id = pending_guild_joins.user_id
            AND tm.active
        )
    `,
  });

  const enqueue = (userId: User.UserId, teamId: Team.TeamId) =>
    _enqueue({ user_id: userId, team_id: teamId }).pipe(catchSqlErrors);

  const listPending = () => _listPending().pipe(catchSqlErrors);

  const markDone = (id: string) => _markDone({ id }).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) => _markFailed({ id, error }).pipe(catchSqlErrors);

  const requeueFailedForUser = (userId: User.UserId) =>
    _requeueFailedForUser({ user_id: userId }).pipe(catchSqlErrors);

  return { enqueue, listPending, markDone, markFailed, requeueFailedForUser };
});

export class PendingGuildJoinsRepository extends ServiceMap.Service<
  PendingGuildJoinsRepository,
  Effect.Success<typeof make>
>()('api/PendingGuildJoinsRepository') {
  static readonly Default = Layer.effect(PendingGuildJoinsRepository, make);
}
