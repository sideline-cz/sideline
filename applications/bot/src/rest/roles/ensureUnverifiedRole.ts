import { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { retryPolicy } from '../utils.js';

/**
 * Name of the bot-owned Discord role granted to a member with an incomplete profile
 * while `team_settings.require_complete_profile` is on (Deliverable D / Task 10).
 *
 * Deliberately has **no Sideline `roles` row** — that absence is what keeps this role
 * from ever being auto-assigned or auto-stripped by anything else in the app; nothing
 * treats it as a permissions construct, so nothing manages it but the join/leave and
 * verify flows in this module. Do not add a `roles` row for this role.
 */
export const UNVERIFIED_ROLE_NAME = 'Sideline Unverified';

const decodeSnowflake = Schema.decodeUnknownSync(DiscordSchemas.Snowflake);

/** Deterministically picks the lowest (oldest) id among same-named roles, matching
 * `ensureSudoRole`'s tiebreak — a create-race where two joins both missed the role
 * and both created one resolves to the same id everywhere, and the duplicate is
 * flagged for manual cleanup rather than silently ignored. */
const pickOldest = (
  guildId: DiscordSchemas.Snowflake,
  roles: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) => {
  const sorted = [...roles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = sorted[0];
  const chosenId = decodeSnowflake(chosen ? chosen.id : roles[0].id);
  return Effect.succeed(chosenId).pipe(
    Effect.tap(() =>
      roles.length > 1
        ? Effect.logWarning(
            `Found ${roles.length} "${UNVERIFIED_ROLE_NAME}" roles in guild ${guildId} — using the oldest (${chosenId})`,
          )
        : Effect.void,
    ),
  );
};

/**
 * Resolve-only — NEVER creates. Used on the revoke path: creating the very role you
 * are trying to remove is absurd, and the revoke must be safe to call unconditionally
 * on every `guildMemberAdd` for an already-complete member.
 */
export const findUnverifiedRole = (guildId: DiscordSchemas.Snowflake) =>
  DiscordREST.asEffect().pipe(
    Effect.flatMap((rest) => rest.listGuildRoles(guildId)),
    Effect.map((roles) => roles.filter((role) => role.name === UNVERIFIED_ROLE_NAME)),
    Effect.flatMap((existing) =>
      existing.length === 0
        ? Effect.succeed(Option.none<DiscordSchemas.Snowflake>())
        : pickOldest(guildId, existing).pipe(Effect.map(Option.some)),
    ),
  );

/**
 * Find-or-create. `permissions: 0` — never `Administrator` — this role exists purely
 * to gate channel visibility via a channel-level overwrite (`ensureVerificationChannel`),
 * never to grant guild-level capability.
 */
export const ensureUnverifiedRole = (guildId: DiscordSchemas.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('existing', ({ rest }) =>
      rest
        .listGuildRoles(guildId)
        .pipe(Effect.map((roles) => roles.filter((role) => role.name === UNVERIFIED_ROLE_NAME))),
    ),
    Effect.flatMap(({ rest, existing }) => {
      if (existing.length > 0) return pickOldest(guildId, existing);
      return Effect.suspend(() =>
        rest.createGuildRole(guildId, { name: UNVERIFIED_ROLE_NAME, permissions: 0 }),
      ).pipe(
        Effect.retry(retryPolicy),
        Effect.tap((role) =>
          Effect.logInfo(
            `Auto-created Discord role "${UNVERIFIED_ROLE_NAME}" (${role.id}) in guild ${guildId}`,
          ),
        ),
        Effect.map((role) => decodeSnowflake(role.id)),
      );
    }),
  );
