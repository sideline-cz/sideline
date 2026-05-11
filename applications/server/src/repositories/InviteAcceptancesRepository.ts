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

class PendingAcceptanceRow extends Schema.Class<PendingAcceptanceRow>('PendingAcceptanceRow')({
  acceptance_id: InviteAcceptance.InviteAcceptanceId,
  guild_id: Discord.Snowflake,
  welcome_channel_id: Discord.Snowflake,
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

    const findPending = SqlSchema.findAll({
      Request: Schema.Number,
      Result: PendingAcceptanceRow,
      execute: (limit) => sql`
        SELECT
          ia.id                AS acceptance_id,
          t.guild_id           AS guild_id,
          t.welcome_channel_id AS welcome_channel_id
        FROM invite_acceptances ia
        JOIN team_invites ti ON ti.id = ia.team_invite_id
        JOIN teams t         ON t.id = ti.team_id
        JOIN bot_guilds b    ON b.guild_id = t.guild_id
        WHERE ia.discord_code IS NULL
          AND ia.discord_code_error_code IS NULL
          AND t.welcome_channel_id IS NOT NULL
          AND b.is_community_enabled = true
        ORDER BY ia.created_at ASC
        LIMIT ${limit}
      `,
    });

    const setDiscordCode = SqlSchema.void({
      Request: SetDiscordCodeInput,
      execute: ({ acceptanceId, discordCode }) => sql`
        UPDATE invite_acceptances
        SET discord_code = ${discordCode}, generated_at = now()
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

    return {
      create: (input: typeof CreateInput.Type) => create(input).pipe(catchSqlErrors),
      findById: (id: InviteAcceptance.InviteAcceptanceId) => findById(id).pipe(catchSqlErrors),
      findPending: (limit: number) => findPending(limit).pipe(catchSqlErrors),
      setDiscordCode: (input: typeof SetDiscordCodeInput.Type) =>
        setDiscordCode(input).pipe(catchSqlErrors),
      markFailed: (input: typeof MarkFailedInput.Type) => markFailed(input).pipe(catchSqlErrors),
      findByDiscordCodeWithContext: (code: string) =>
        findByDiscordCodeWithContext(code).pipe(
          Effect.map(
            Option.map((row) => ({
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
            })),
          ),
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
