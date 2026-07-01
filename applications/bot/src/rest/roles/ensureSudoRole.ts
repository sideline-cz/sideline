import { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as DiscordTypes from 'dfx/types';
import { Effect, Schema } from 'effect';
import { retryPolicy } from '../utils.js';

/** Name of the Discord role granted to a team admin while they are in `/sudo` mode. */
export const SUDO_ROLE_NAME = 'Sideline Sudo';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

/**
 * Ensures the guild has a `SUDO_ROLE_NAME` role, creating it (with the Administrator
 * permission) if missing, and returns its id.
 *
 * If more than one role happens to share the name — e.g. a create-race where two
 * `/sudo` invocations both missed the role and both created one — deterministically
 * picks the lowest id (oldest, since Discord snowflakes are monotonically increasing)
 * and logs a warning so the duplicate can be cleaned up manually.
 */
export const ensureSudoRole = (guildId: DiscordSchemas.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roles', ({ rest }) => rest.listGuildRoles(guildId)),
    Effect.bind('existing', ({ roles }) =>
      Effect.succeed(roles.filter((role) => role.name === SUDO_ROLE_NAME)),
    ),
    Effect.flatMap(({ rest, existing }) => {
      if (existing.length > 0) {
        const sorted = [...existing].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        const chosen = sorted[0];
        const chosenId = decodeSnowflake(chosen ? chosen.id : existing[0].id);
        return Effect.succeed(chosenId).pipe(
          Effect.tap(() =>
            existing.length > 1
              ? Effect.logWarning(
                  `Found ${existing.length} "${SUDO_ROLE_NAME}" roles in guild ${guildId} — using the oldest (${chosenId})`,
                )
              : Effect.void,
          ),
        );
      }
      return Effect.suspend(() =>
        rest.createGuildRole(guildId, {
          name: SUDO_ROLE_NAME,
          permissions: Number(DiscordTypes.Permissions.Administrator),
        }),
      ).pipe(
        Effect.retry(retryPolicy),
        Effect.tap((role) =>
          Effect.logInfo(
            `Auto-created Discord role "${SUDO_ROLE_NAME}" (${role.id}) in guild ${guildId}`,
          ),
        ),
        Effect.map((role) => decodeSnowflake(role.id)),
      );
    }),
  );
