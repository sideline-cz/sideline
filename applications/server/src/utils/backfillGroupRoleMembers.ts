import type { Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import type { GroupMissingRoleRow } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { applyDiscordFormat, DEFAULT_ROLE_FORMAT } from '~/utils/applyDiscordFormat.js';
import { hexColorToDiscordInt } from '~/utils/hexColorToDiscordInt.js';

const BACKFILL_LIMIT = 50;

const emitGroupRoleMemberBackfill = (row: GroupMissingRoleRow) =>
  Effect.Do.pipe(
    Effect.bind('teamSettingsRepo', () => TeamSettingsRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('maybeSettings', ({ teamSettingsRepo }) =>
      teamSettingsRepo.findByTeamId(row.team_id),
    ),
    Effect.flatMap(({ maybeSettings, channelSync }) => {
      const roleName = applyDiscordFormat(
        Option.match(maybeSettings, {
          onNone: () => DEFAULT_ROLE_FORMAT,
          onSome: (s) => s.discord_role_format,
        }),
        row.name,
        row.emoji,
      );
      const discordRoleColor = Option.map(row.color, hexColorToDiscordInt);
      // `row` is only ever an already-provisioned group (channel + role both present
      // — see `findActiveGroupsWithRole`'s selection), so this MUST NOT pass
      // `row.discord_channel_id` as the `existingChannelId` argument the way
      // `backfillRosterRoleMembers.ts` passes the roster's existing channel.
      // `handleRosterChannelCreated.ts` binds `Channel/GetRosterMapping` FIRST and
      // only then inspects `existing_channel_id`, so reusing the channel id there is
      // safe. `handleCreated.ts` (the group handler) matches `existing_channel_id`
      // FIRST, with no `Channel/GetMapping` at all, and unconditionally calls
      // `createRoleForChannel` — passing an existing channel id for an
      // already-provisioned group would create a DUPLICATE Discord role and
      // overwrite the mapping. Passing `Option.none()`/`undefined` instead routes the
      // event to `handleCreated.ts`'s branch 3 (role present -> reuse, no creation,
      // no mapping write), which then runs the shared member backfill. `roleName`/
      // `discordRoleColor` are still sent — not because branch 4/5 is a desirable
      // fallback (it isn't reachable here), but because
      // `src/rpc/channel/events.ts`'s `discord_role_name` falls back to the raw
      // `group_name` when it is NULL, so omitting it would guarantee an unformatted
      // role name in the (accepted) stale-role hazard case.
      return channelSync.emitChannelCreated(
        row.team_id,
        row.group_id,
        row.name,
        Option.none(),
        undefined,
        roleName,
        discordRoleColor,
      );
    }),
  );

export const backfillGroupRoleMembers = (teamId: Team.TeamId) =>
  Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.flatMap(({ sql }) =>
      sql
        .withTransaction(
          Effect.Do.pipe(
            // Serialize concurrent backfill sweeps for the same team via a
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
              channelMappings.countActiveGroupsWithRole(teamId),
            ),
            Effect.bind('rows', ({ channelMappings }) =>
              channelMappings.findActiveGroupsWithRole(teamId, BACKFILL_LIMIT),
            ),
            Effect.tap(({ rows }) =>
              Effect.forEach(rows, emitGroupRoleMemberBackfill, { concurrency: 1 }),
            ),
            Effect.let('processedCount', ({ rows }) => rows.length),
            Effect.let('remainingCount', ({ count, processedCount }) =>
              Math.max(0, count - processedCount),
            ),
            Effect.tap(({ processedCount, remainingCount }) =>
              Effect.logInfo(
                `Group role backfill: processed=${processedCount}, remaining=${remainingCount}`,
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
