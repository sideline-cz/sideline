import type { Discord, RosterModel, Team } from '@sideline/domain';
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';

const RECONCILE_LIMIT = 50;

const emitRosterRoleReconcileForRow = (
  teamId: Team.TeamId,
  row: {
    roster_id: RosterModel.RosterId;
    guild_id: Discord.Snowflake;
    discord_role_id: Discord.Snowflake;
  },
) =>
  Effect.Do.pipe(
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.flatMap(({ channelSync }) =>
      channelSync.emitRosterRoleReconcile(teamId, row.roster_id, row.discord_role_id),
    ),
  );

export const reconcileRosterRoleExtras = (teamId: Team.TeamId) =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.flatMap(({ sql }) =>
      sql
        .withTransaction(
          Effect.Do.pipe(
            // Serialize concurrent reconcile sweeps for the same team via a
            // transaction-scoped advisory lock. A second concurrent request for the
            // same teamId blocks here until the first transaction commits, at which
            // point the dedup guard (NOT EXISTS unprocessed event) prevents it from
            // re-queueing events that the first sweep already emitted.
            Effect.tap(() =>
              sql`SELECT pg_advisory_xact_lock(hashtext(${teamId}))`.pipe(
                catchSqlErrors,
                Effect.asVoid,
              ),
            ),
            Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
            Effect.bind('count', ({ channelMappings }) =>
              channelMappings.countActiveRoleIdsForReconcile(teamId),
            ),
            Effect.bind('rows', ({ channelMappings }) =>
              channelMappings.findActiveRoleIdsForReconcile(teamId, RECONCILE_LIMIT),
            ),
            Effect.tap(({ rows }) =>
              Effect.forEach(rows, (row) => emitRosterRoleReconcileForRow(teamId, row), {
                concurrency: 1,
              }),
            ),
            Effect.let('processedCount', ({ rows }) => rows.length),
            Effect.let('remainingCount', ({ count, processedCount }) =>
              Math.max(0, count - processedCount),
            ),
            Effect.tap(({ processedCount, remainingCount }) =>
              Effect.logInfo(
                `Roster role reconcile: processed=${processedCount}, remaining=${remainingCount}`,
              ),
            ),
            Effect.map(({ processedCount, remainingCount }) => ({
              processedCount,
              remainingCount,
            })),
          ),
        )
        .pipe(catchSqlErrors),
    ),
  );
