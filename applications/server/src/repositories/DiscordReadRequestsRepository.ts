/**
 * `discord_read_requests` — the outbox for a live Discord read (migration
 * `1795100000_create_discord_read_requests`). The AI tool `read_discord_messages` inserts a row
 * and polls `consume`; the bot claims it with `pickUnprocessed` and answers with `submitResult`.
 *
 * Every method is ONE short statement, never a transaction: the tool polls for up to 15 s and
 * must not hold a connection across the wait.
 *
 * `result` goes through TEXT both ways (`::jsonb` in, `::text` out), same rule as
 * `AiActionProposalsRepository`: the round trip must not depend on how the driver marshals jsonb.
 */
import { Discord, DiscordReadRequest, Team } from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const ResultFromJson = Schema.fromJsonString(DiscordReadRequest.DiscordReadResult);

const IdRow = Schema.Struct({ id: DiscordReadRequest.DiscordReadRequestId });

const PendingRow = Schema.Struct({
  id: DiscordReadRequest.DiscordReadRequestId,
  channel_id: Discord.Snowflake,
  since_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  message_limit: Schema.Int,
});

const AbandonedRow = Schema.Struct({
  picked: Schema.Boolean,
  result: Schema.OptionFromNullOr(ResultFromJson),
});

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    // The cutoff is computed on the DB clock. A NULL hour count gives a NULL cutoff, because
    // NULL * interval is NULL.
    const _insert = SqlSchema.findOne({
      Request: Schema.Struct({
        team_id: Team.TeamId,
        channel_id: Discord.Snowflake,
        since_hours: Schema.OptionFromNullOr(Schema.Int),
        limit: Schema.Int,
      }),
      Result: IdRow,
      execute: (i) => sql`
        INSERT INTO discord_read_requests (team_id, channel_id, since_at, message_limit)
        VALUES (${i.team_id}, ${i.channel_id},
                now() - ${i.since_hours}::int * interval '1 hour', ${i.limit})
        RETURNING id
      `,
    });

    // No picked_at IS NULL filter: a bot that restarts mid-read must get the row again. The 30 s
    // age gate stops the bot from reading Discord for a waiter that has already given up (15 s).
    const _pickUnprocessed = SqlSchema.findAll({
      Request: Schema.Number,
      Result: PendingRow,
      execute: (limit) => sql`
        UPDATE discord_read_requests SET picked_at = COALESCE(picked_at, now())
        WHERE id IN (
          SELECT id FROM discord_read_requests
          WHERE processed_at IS NULL AND created_at > now() - interval '30 seconds'
          ORDER BY created_at, id
          LIMIT ${limit}
        )
        RETURNING id, channel_id, since_at, message_limit
      `,
    });

    // The result write IS the ack. First write wins; zero rows (already answered, or the waiter
    // deleted the row) is a success no-op.
    const _submitResult = SqlSchema.void({
      Request: Schema.Struct({
        id: DiscordReadRequest.DiscordReadRequestId,
        result: ResultFromJson,
      }),
      execute: (i) => sql`
        UPDATE discord_read_requests SET result = ${i.result}::jsonb, processed_at = now()
        WHERE id = ${i.id} AND processed_at IS NULL
      `,
    });

    const _consume = SqlSchema.findOneOption({
      Request: DiscordReadRequest.DiscordReadRequestId,
      Result: Schema.Struct({ result: ResultFromJson }),
      execute: (id) => sql`
        DELETE FROM discord_read_requests
        WHERE id = ${id} AND processed_at IS NOT NULL
        RETURNING result::text AS result
      `,
    });

    const _abandon = SqlSchema.findOneOption({
      Request: DiscordReadRequest.DiscordReadRequestId,
      Result: AbandonedRow,
      execute: (id) => sql`
        DELETE FROM discord_read_requests
        WHERE id = ${id}
        RETURNING (picked_at IS NOT NULL) AS picked, result::text AS result
      `,
    });

    const _sweepOlderThan = SqlSchema.findAll({
      Request: Schema.Int,
      Result: IdRow,
      execute: (minutes) => sql`
        DELETE FROM discord_read_requests
        WHERE created_at < now() - ${minutes}::int * interval '1 minute'
        RETURNING id
      `,
    });

    return {
      insert: (params: {
        readonly teamId: Team.TeamId;
        readonly channelId: Discord.Snowflake;
        readonly sinceHours: Option.Option<number>;
        readonly limit: number;
      }) =>
        _insert({
          team_id: params.teamId,
          channel_id: params.channelId,
          since_hours: params.sinceHours,
          limit: params.limit,
        }).pipe(
          Effect.map((row) => row.id),
          catchSqlErrors,
          Effect.catchTag('NoSuchElementError', () =>
            LogicError.die('discord_read_requests insert returned no row'),
          ),
        ),

      pickUnprocessed: (limit: number) => _pickUnprocessed(limit).pipe(catchSqlErrors),

      submitResult: (
        id: DiscordReadRequest.DiscordReadRequestId,
        result: DiscordReadRequest.DiscordReadResult,
      ) => _submitResult({ id, result }).pipe(catchSqlErrors),

      /** Read-once: deletes the row and returns its result, or `None` while the bot has not
       *  answered (the row then stays). */
      consume: (id: DiscordReadRequest.DiscordReadRequestId) =>
        _consume(id).pipe(Effect.map(Option.map((row) => row.result)), catchSqlErrors),

      /** Deletes the row whatever its state. `picked` tells "bot never saw it" from "bot too
       *  slow"; `result` keeps an answer that landed after the last `consume`. `None` = no row. */
      abandon: (id: DiscordReadRequest.DiscordReadRequestId) =>
        _abandon(id).pipe(
          Effect.map(Option.map((row) => ({ picked: row.picked, result: row.result }))),
          catchSqlErrors,
        ),

      sweepOlderThan: (minutes: number) =>
        _sweepOlderThan(minutes).pipe(
          Effect.map((rows) => rows.length),
          catchSqlErrors,
        ),
    };
  }),
);

export class DiscordReadRequestsRepository extends ServiceMap.Service<
  DiscordReadRequestsRepository,
  Effect.Success<typeof make>
>()('api/DiscordReadRequestsRepository') {
  static readonly Default = Layer.effect(DiscordReadRequestsRepository, make);
}
