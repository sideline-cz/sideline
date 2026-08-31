import {
  Discord,
  GroupModel,
  InviteAcceptance,
  Onboarding,
  Team,
  TeamInvite,
  User,
} from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// PR-2 wire expand (CC-1) / PR-3 contract: matches the widened `Invite/PendingAcceptances`
// success shape (`PendingAcceptanceEntry`) so the row can be returned to the RPC handler as-is.
// `findPending` now genuinely selects a null `welcome_channel_id` and a false `bot_present` —
// the temporary wire guard that kept both non-null is removed below (PR-3).
class PendingAcceptanceRow extends Schema.Class<PendingAcceptanceRow>('PendingAcceptanceRow')({
  acceptance_id: InviteAcceptance.InviteAcceptanceId,
  guild_id: Discord.Snowflake,
  welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  bot_present: Schema.Boolean,
}) {}

class AcceptanceWithContextRow extends Schema.Class<AcceptanceWithContextRow>(
  'AcceptanceWithContextRow',
)({
  // team_invites columns
  ti_id: TeamInvite.TeamInviteId,
  ti_team_id: Team.TeamId,
  ti_code: Schema.String,
  ti_active: Schema.Boolean,
  ti_created_by: User.UserId,
  ti_created_at: Schema.Date,
  ti_expires_at: Schema.OptionFromNullOr(Schema.Date),
  ti_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  // joined columns
  group_name: Schema.OptionFromNullOr(Schema.String),
  inviter_username: Schema.String,
  inviter_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
  team_name: Schema.String,
}) {}

const SetDiscordCodeInput = Schema.Struct({
  acceptanceId: InviteAcceptance.InviteAcceptanceId,
  discordCode: Schema.String,
});

const MarkFailedInput = Schema.Struct({
  acceptanceId: InviteAcceptance.InviteAcceptanceId,
  errorCode: Onboarding.InviteGeneratorErrorCode,
  errorDetail: Schema.String,
});

const CreateInput = Schema.Struct({
  team_invite_id: TeamInvite.TeamInviteId,
  user_id: User.UserId,
});

const OpenByUserAndInviteInput = Schema.Struct({
  user_id: User.UserId,
  team_invite_id: TeamInvite.TeamInviteId,
});

const OpenByUserAndTeamInput = Schema.Struct({
  user_id: User.UserId,
  team_id: Team.TeamId,
});

const CountRecentInput = Schema.Struct({
  user_id: User.UserId,
  team_invite_id: TeamInvite.TeamInviteId,
});
const CountRecentResult = Schema.Struct({
  count: Schema.Number,
});

const SweepExpiredInput = Schema.Struct({
  older_than_days: Schema.Number,
});

const make = SqlClient.SqlClient.asEffect().pipe(
  Effect.map((sql) => {
    const create = SqlSchema.findOne({
      Request: CreateInput,
      Result: InviteAcceptance.InviteAcceptance,
      execute: (input) => sql`
        INSERT INTO invite_acceptances (team_invite_id, user_id)
        VALUES (${input.team_invite_id}, ${input.user_id})
        RETURNING *
      `,
    });

    const findById = SqlSchema.findOneOption({
      Request: InviteAcceptance.InviteAcceptanceId,
      Result: InviteAcceptance.InviteAcceptance,
      execute: (id) => sql`SELECT * FROM invite_acceptances WHERE id = ${id}`,
    });

    // PR-9 / CC-15: `getJoinStatus` needs the team a bare acceptance id belongs to, in order to
    // check `team_members.discord_joined_at` for that (team, user) pair — `InviteAcceptance`
    // itself carries no `team_id`, only `team_invite_id`.
    const findTeamIdById = SqlSchema.findOneOption({
      Request: InviteAcceptance.InviteAcceptanceId,
      Result: Schema.Struct({ team_id: Team.TeamId }),
      execute: (id) => sql`
        SELECT ti.team_id FROM invite_acceptances ia
        JOIN team_invites ti ON ti.id = ia.team_invite_id
        WHERE ia.id = ${id}
      `,
    });

    // "Open" = not terminally failed AND, if a code was already minted, still usable.
    // `discord_code_error_code` makes a row terminal (CC-14). A row with a `discord_code` is
    // only open while that one-time code can still work: the bot mints codes with
    // `max_age: 86400` (`applications/bot/src/rcp/inviteGenerator/ProcessorService.ts`), so a
    // code generated more than 24h ago is dead. Consumption (a single `max_uses: 1`) isn't
    // observable server-side, so this only closes the permanent (expired) case — that's fine
    // and expected (BLOCKER 2, third review of PR-4).
    const findOpenByUserAndInvite = SqlSchema.findOneOption({
      Request: OpenByUserAndInviteInput,
      Result: InviteAcceptance.InviteAcceptance,
      execute: (input) => sql`
        SELECT * FROM invite_acceptances
        WHERE user_id = ${input.user_id} AND team_invite_id = ${input.team_invite_id}
          AND discord_code_error_code IS NULL
          AND (discord_code IS NULL OR generated_at > now() - interval '24 hours')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    });

    // PR-5 / CC-14 step 5: what `getMyPendingDiscordJoin` reads through — joined through
    // `team_invites` and filtered by `team_id` instead of a specific invite, as
    // `findOpenByUserAndInvite` is. Despite the name, "open" here does NOT mean "not terminally
    // failed" the way `findOpenByUserAndInvite` does (blocker B, whole-series review of
    // `fix/discord-onboarding-webapp`): `getMyPendingDiscordJoin` is the ONLY caller, and it is
    // itself the only web surface for `deriveJoinStatusState`'s `'failed'` state — a row with
    // `discord_code_error_code` set (e.g. `welcome_channel_missing`, the dominant cohort of the
    // original onboarding root cause) must still be RETURNED here so `deriveJoinStatusState` can
    // turn it into the one actionable error message the product has. Filtering it out here meant
    // that message was unreachable and a captain-fixable failure looked identical to "no pending
    // join at all".
    //
    // Should-fix 4 (whole-series review of commit 46806427): the staleness predicate
    // (`generated_at > now() - 24h`) that used to live in this query's `WHERE` is GONE — the same
    // "the SQL should not decide, `deriveJoinStatusState` should" principle blocker B already
    // applied to `discord_code_error_code IS NULL`. A stale-code row is still RETURNED here now;
    // `deriveJoinStatusState` (`joinStatusState.ts`, `isStaleDiscordCode`) is what turns it into
    // `'expired'`. Filtering it out here meant that row vanished into `None`, and the web showed
    // generic "No invite available" instead of `'expired'`'s dedicated copy.
    //
    // The `ORDER BY` still returns exactly one row per (user, team), so it must resolve which row
    // wins when the pair has several — and a plain `created_at DESC` reintroduces a different
    // failure mode dropping the `WHERE` clause exposed: a row with a currently-USABLE code that
    // is not the newest would otherwise be shadowed by a newer row that has no usable code at all
    // (e.g. a newest row that terminally failed). The leading boolean key prefers any row with a
    // live, unexpired `discord_code` over one without, regardless of recency; only when NEITHER
    // candidate row has a usable code does it fall through to `created_at DESC` — which is
    // exactly when surfacing the newest (e.g. most recently failed) row matters, per the
    // `getMyPendingDiscordJoin` rationale above.
    const findOpenByUserAndTeam = SqlSchema.findOneOption({
      Request: OpenByUserAndTeamInput,
      Result: InviteAcceptance.InviteAcceptance,
      execute: (input) => sql`
        SELECT ia.* FROM invite_acceptances ia
        JOIN team_invites ti ON ti.id = ia.team_invite_id
        WHERE ia.user_id = ${input.user_id} AND ti.team_id = ${input.team_id}
        ORDER BY
          (ia.discord_code IS NOT NULL AND ia.generated_at > now() - interval '24 hours') DESC,
          ia.created_at DESC,
          ia.id DESC
        LIMIT 1
      `,
    });

    // Newest acceptance for a (user, invite) pair regardless of state — used by
    // `resolveOrCreateAcceptance` (CC-14) to reuse a rate-limited or terminally-failed row as-is.
    const findNewestByUserAndInvite = SqlSchema.findOneOption({
      Request: OpenByUserAndInviteInput,
      Result: InviteAcceptance.InviteAcceptance,
      execute: (input) => sql`
        SELECT * FROM invite_acceptances
        WHERE user_id = ${input.user_id} AND team_invite_id = ${input.team_invite_id}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    });

    // CC-14's rate limit: ≤3 regenerations per hour per (user, invite) pair. BLOCKER 1 (third
    // review of PR-4): scoped to the pair, not just the user — a global count let a user who
    // had joined several OTHER invites recently get fail-closed on the very first click of an
    // invite they had never touched (the "four squads" production bug).
    const countRecentByUserAndInvite = SqlSchema.findOne({
      Request: CountRecentInput,
      Result: CountRecentResult,
      execute: (input) => sql`
        SELECT COUNT(*)::int AS count FROM invite_acceptances
        WHERE user_id = ${input.user_id} AND team_invite_id = ${input.team_invite_id}
          AND created_at > now() - interval '1 hour'
      `,
    });

    // PR-3 contract (CC-1 release B): the temporary wire guard that kept `welcome_channel_id`
    // non-null and `bot_present` hardcoded `TRUE` is gone. `bot_guilds` is now a LEFT JOIN — a
    // team whose guild the bot has never joined still needs to be selected so the bot's
    // `bot_not_in_guild` short-circuit (ProcessorService) can fail it loudly instead of the row
    // vanishing forever. No age predicate here (CC-4): the sweep and the derived guard (PR-5)
    // bound stale rows with a terminal code, never a filter.
    const findPending = SqlSchema.findAll({
      Request: Schema.Number,
      Result: PendingAcceptanceRow,
      execute: (limit) => sql`
        SELECT
          ia.id                     AS acceptance_id,
          t.guild_id                AS guild_id,
          t.welcome_channel_id      AS welcome_channel_id,
          (b.guild_id IS NOT NULL)  AS bot_present
        FROM invite_acceptances ia
        JOIN team_invites ti      ON ti.id = ia.team_invite_id
        JOIN teams t              ON t.id = ti.team_id
        LEFT JOIN bot_guilds b    ON b.guild_id = t.guild_id
        WHERE ia.discord_code IS NULL
          -- CC-0 rule 2: a welcome_channel_missing row re-opens once the captain sets the
          -- welcome channel (TeamSettingsPage.tsx -> updateTeamInfo). Every other error code
          -- stays terminal here.
          AND (ia.discord_code_error_code IS NULL
               OR (ia.discord_code_error_code = 'welcome_channel_missing'
                   AND t.welcome_channel_id IS NOT NULL))
        ORDER BY ia.created_at ASC
        LIMIT ${limit}
      `,
    });

    // CC-14 / PR-3 step 5: clears any previously-stored error so a row that re-opened via the
    // `welcome_channel_missing` re-open clause above (or the regenerate primitive) does not end
    // up with both a `discord_code` and a stale `discord_code_error_code`. `getJoinStatus`
    // already prefers `discord_code` when present, so this is belt-and-braces — but the stored
    // row should not lie about its own state.
    const setDiscordCode = SqlSchema.void({
      Request: SetDiscordCodeInput,
      execute: ({ acceptanceId, discordCode }) => sql`
        UPDATE invite_acceptances
        SET discord_code = ${discordCode},
            discord_code_error_code = NULL,
            discord_code_error_detail = NULL,
            generated_at = now()
        WHERE id = ${acceptanceId}
      `,
    });

    const markFailed = SqlSchema.void({
      Request: MarkFailedInput,
      execute: ({ acceptanceId, errorCode, errorDetail }) => sql`
        UPDATE invite_acceptances
        SET discord_code_error_code = ${errorCode},
            discord_code_error_detail = ${errorDetail},
            generated_at = now()
        WHERE id = ${acceptanceId}
      `,
    });

    // CC-4 / CC-5: the authoritative backstop for rows `findPending` would otherwise retry
    // forever. Idempotent (re-running affects 0 rows the second time) and NEVER touches
    // `created_at` — CC-5 rejects rewriting audit timestamps outright. Already perfectly served
    // by `idx_invite_acceptances_pending`, whose predicate is byte-for-byte this WHERE clause.
    const sweepExpired = SqlSchema.void({
      Request: SweepExpiredInput,
      execute: ({ older_than_days }) => sql`
        UPDATE invite_acceptances
        SET discord_code_error_code = 'expired',
            discord_code_error_detail = 'aged out before generation',
            generated_at = now()
        WHERE discord_code IS NULL
          AND discord_code_error_code IS NULL
          AND created_at < now() - (${older_than_days} * interval '1 day')
      `,
    });

    const findByDiscordCodeWithContext = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: AcceptanceWithContextRow,
      execute: (code) => sql`
        SELECT
          ti.id          AS ti_id,
          ti.team_id     AS ti_team_id,
          ti.code        AS ti_code,
          ti.active      AS ti_active,
          ti.created_by  AS ti_created_by,
          ti.created_at  AS ti_created_at,
          ti.expires_at  AS ti_expires_at,
          g.id           AS ti_group_id,
          g.name         AS group_name,
          u.username     AS inviter_username,
          u.discord_id   AS inviter_discord_id,
          t.name         AS team_name
        FROM invite_acceptances ia
        JOIN team_invites ti ON ti.id = ia.team_invite_id
        JOIN users u         ON u.id = ti.created_by
        JOIN teams t         ON t.id = ti.team_id
        LEFT JOIN groups g   ON g.id = ti.group_id AND g.is_archived = false
        WHERE ia.discord_code = ${code}
          AND ti.active = true
          AND (ti.expires_at IS NULL OR ti.expires_at > now())
        LIMIT 1
      `,
    });

    const RecentByUserAndGuildInput = Schema.Struct({
      discord_id: Schema.String,
      guild_id: Schema.String,
    });

    const findRecentByUserAndGuildWithContext = SqlSchema.findOneOption({
      Request: RecentByUserAndGuildInput,
      Result: AcceptanceWithContextRow,
      execute: ({ discord_id, guild_id }) => sql`
        SELECT
          ti.id          AS ti_id,
          ti.team_id     AS ti_team_id,
          ti.code        AS ti_code,
          ti.active      AS ti_active,
          ti.created_by  AS ti_created_by,
          ti.created_at  AS ti_created_at,
          ti.expires_at  AS ti_expires_at,
          g.id           AS ti_group_id,
          g.name         AS group_name,
          u.username     AS inviter_username,
          u.discord_id   AS inviter_discord_id,
          t.name         AS team_name
        FROM invite_acceptances ia
        JOIN team_invites ti ON ti.id = ia.team_invite_id
        JOIN users joined    ON joined.id = ia.user_id
        JOIN users u         ON u.id = ti.created_by
        JOIN teams t         ON t.id = ti.team_id
        LEFT JOIN groups g   ON g.id = ti.group_id AND g.is_archived = false
        WHERE joined.discord_id = ${discord_id}
          AND t.guild_id = ${guild_id}
          AND ti.active = true
          AND (ti.expires_at IS NULL OR ti.expires_at > now())
          AND ia.created_at > now() - interval '15 minutes'
        ORDER BY ia.created_at DESC
        LIMIT 1
      `,
    });

    const toContext = (row: AcceptanceWithContextRow) => ({
      id: row.ti_id,
      team_id: row.ti_team_id,
      code: row.ti_code,
      active: row.ti_active,
      created_by: row.ti_created_by,
      created_at: row.ti_created_at,
      expires_at: row.ti_expires_at,
      group_id: row.ti_group_id,
      group_name: row.group_name,
      inviter_username: row.inviter_username,
      inviter_discord_id: row.inviter_discord_id,
      team_name: row.team_name,
    });

    return {
      create: (input: typeof CreateInput.Type) => create(input).pipe(catchSqlErrors),
      findById: (id: InviteAcceptance.InviteAcceptanceId) => findById(id).pipe(catchSqlErrors),
      findTeamIdById: (id: InviteAcceptance.InviteAcceptanceId) =>
        findTeamIdById(id).pipe(Effect.map(Option.map((row) => row.team_id)), catchSqlErrors),
      findOpenByUserAndInvite: (userId: User.UserId, teamInviteId: TeamInvite.TeamInviteId) =>
        findOpenByUserAndInvite({ user_id: userId, team_invite_id: teamInviteId }).pipe(
          catchSqlErrors,
        ),
      findOpenByUserAndTeam: (userId: User.UserId, teamId: Team.TeamId) =>
        findOpenByUserAndTeam({ user_id: userId, team_id: teamId }).pipe(catchSqlErrors),
      findNewestByUserAndInvite: (userId: User.UserId, teamInviteId: TeamInvite.TeamInviteId) =>
        findNewestByUserAndInvite({ user_id: userId, team_invite_id: teamInviteId }).pipe(
          catchSqlErrors,
        ),
      countRecentByUserAndInvite: (userId: User.UserId, teamInviteId: TeamInvite.TeamInviteId) =>
        countRecentByUserAndInvite({ user_id: userId, team_invite_id: teamInviteId }).pipe(
          Effect.map((row) => row.count),
          catchSqlErrors,
        ),
      findPending: (limit: number) => findPending(limit).pipe(catchSqlErrors),
      setDiscordCode: (input: typeof SetDiscordCodeInput.Type) =>
        setDiscordCode(input).pipe(catchSqlErrors),
      markFailed: (input: typeof MarkFailedInput.Type) => markFailed(input).pipe(catchSqlErrors),
      sweepExpired: (olderThanDays: number) =>
        sweepExpired({ older_than_days: olderThanDays }).pipe(catchSqlErrors),
      findByDiscordCodeWithContext: (code: string) =>
        findByDiscordCodeWithContext(code).pipe(Effect.map(Option.map(toContext)), catchSqlErrors),
      findRecentByUserAndGuildWithContext: (discordId: string, guildId: string) =>
        findRecentByUserAndGuildWithContext({ discord_id: discordId, guild_id: guildId }).pipe(
          Effect.map(Option.map(toContext)),
          catchSqlErrors,
        ),
    };
  }),
);

export class InviteAcceptancesRepository extends ServiceMap.Service<
  InviteAcceptancesRepository,
  Effect.Success<typeof make>
>()('api/InviteAcceptancesRepository') {
  static readonly Default = Layer.effect(InviteAcceptancesRepository, make);
}
