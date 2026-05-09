import { Discord, GroupModel, Team, TeamInvite, User } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class InviteWithContextRow extends Schema.Class<InviteWithContextRow>('InviteWithContextRow')({
  // invite columns (prefixed ti_)
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

class InviteListRow extends Schema.Class<InviteListRow>('InviteListRow')({
  id: TeamInvite.TeamInviteId,
  code: Schema.String,
  active: Schema.Boolean,
  group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  group_name: Schema.OptionFromNullOr(Schema.String),
  inviter_name: Schema.OptionFromNullOr(Schema.String),
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  created_at: Schemas.DateTimeFromDate,
  created_by: User.UserId,
}) {}

const DeactivateByTeamExceptInput = Schema.Struct({
  teamId: Schema.String,
  excludeId: Schema.String,
});

const DeactivateByIdInput = Schema.Struct({
  inviteId: Schema.String,
  teamId: Schema.String,
});

const make = SqlClient.SqlClient.asEffect().pipe(
  Effect.map((sql) => {
    const findByCode = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: TeamInvite.TeamInvite,
      execute: (code) =>
        sql`SELECT * FROM team_invites WHERE code = ${code} AND active = true AND (expires_at IS NULL OR expires_at > now())`,
    });

    const findByTeam = SqlSchema.findAll({
      Request: Schema.String,
      Result: TeamInvite.TeamInvite,
      execute: (teamId) => sql`SELECT * FROM team_invites WHERE team_id = ${teamId}`,
    });

    const create = SqlSchema.findOne({
      Request: TeamInvite.TeamInvite.insert,
      Result: TeamInvite.TeamInvite,
      execute: (input) => sql`
        INSERT INTO team_invites (team_id, code, active, created_by, expires_at, group_id)
        VALUES (${input.team_id}, ${input.code}, ${input.active}, ${input.created_by}, ${input.expires_at}, ${input.group_id})
        RETURNING *
      `,
    });

    const deactivateByTeam = SqlSchema.void({
      Request: Schema.String,
      execute: (teamId) =>
        sql`UPDATE team_invites SET active = false WHERE team_id = ${teamId} AND active = true`,
    });

    const deactivateByTeamExcept = SqlSchema.void({
      Request: DeactivateByTeamExceptInput,
      execute: ({ teamId, excludeId }) =>
        sql`UPDATE team_invites SET active = false WHERE team_id = ${teamId} AND active = true AND id != ${excludeId}`,
    });

    const deactivateById = SqlSchema.findOneOption({
      Request: DeactivateByIdInput,
      Result: TeamInvite.TeamInvite,
      execute: ({ inviteId, teamId }) =>
        sql`UPDATE team_invites SET active = false WHERE id = ${inviteId} AND team_id = ${teamId} RETURNING *`,
    });

    const findByCodeWithContext = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: InviteWithContextRow,
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
        FROM team_invites ti
        JOIN users u ON u.id = ti.created_by
        JOIN teams t ON t.id = ti.team_id
        LEFT JOIN groups g ON g.id = ti.group_id AND g.is_archived = false
        WHERE ti.code = ${code}
          AND ti.active = true
          AND (ti.expires_at IS NULL OR ti.expires_at > now())
      `,
    });

    const listForTeam = SqlSchema.findAll({
      Request: Schema.String,
      Result: InviteListRow,
      execute: (teamId) => sql`
        SELECT
          ti.id         AS id,
          ti.code       AS code,
          ti.active     AS active,
          g.id          AS group_id,
          g.name        AS group_name,
          u.username    AS inviter_name,
          ti.expires_at AS expires_at,
          ti.created_at AS created_at,
          ti.created_by AS created_by
        FROM team_invites ti
        JOIN users u ON u.id = ti.created_by
        LEFT JOIN groups g ON g.id = ti.group_id AND g.is_archived = false
        WHERE ti.team_id = ${teamId}
        ORDER BY ti.created_at DESC
      `,
    });

    return {
      findByCode: (code: string) => findByCode(code).pipe(catchSqlErrors),
      findByTeam: (teamId: string) => findByTeam(teamId).pipe(catchSqlErrors),
      create: (input: typeof TeamInvite.TeamInvite.insert.Type) =>
        create(input).pipe(catchSqlErrors),
      deactivateByTeam: (teamId: string) => deactivateByTeam(teamId).pipe(catchSqlErrors),
      deactivateByTeamExcept: (input: typeof DeactivateByTeamExceptInput.Type) =>
        deactivateByTeamExcept(input).pipe(catchSqlErrors),
      deactivateById: (input: typeof DeactivateByIdInput.Type) =>
        deactivateById(input).pipe(catchSqlErrors),
      findByCodeWithContext: (code: string) =>
        findByCodeWithContext(code).pipe(
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
      listForTeam: (teamId: string) =>
        listForTeam(teamId).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              id: row.id,
              code: row.code,
              active: row.active,
              groupId: row.group_id,
              groupName: row.group_name,
              inviterName: row.inviter_name,
              expiresAt: row.expires_at,
              createdAt: row.created_at,
              createdBy: row.created_by,
            })),
          ),
          catchSqlErrors,
        ),
    };
  }),
);

export class TeamInvitesRepository extends ServiceMap.Service<
  TeamInvitesRepository,
  Effect.Success<typeof make>
>()('api/TeamInvitesRepository') {
  static readonly Default = Layer.effect(TeamInvitesRepository, make);
}
