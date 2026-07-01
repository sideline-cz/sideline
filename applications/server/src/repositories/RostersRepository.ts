import { Discord, RosterModel, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { RosterEntry } from '~/repositories/TeamMembersRepository.js';

class RosterWithCount extends Schema.Class<RosterWithCount>('RosterWithCount')({
  id: RosterModel.RosterId,
  team_id: Team.TeamId,
  name: Schema.String,
  active: Schema.Boolean,
  color: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(Schema.String),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  created_at: Schema.DateTimeUtcFromDate,
  member_count: Schema.Number,
}) {}

const RosterInsertInput = Schema.Struct({
  team_id: Schema.String,
  name: Schema.String,
  active: Schema.Boolean,
  color: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(Schema.String),
});

const RosterUpdateInput = Schema.Struct({
  id: RosterModel.RosterId,
  name: Schema.OptionFromNullOr(Schema.String),
  active: Schema.OptionFromNullOr(Schema.Boolean),
  color: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(Schema.String),
  discord_channel_id: Schema.OptionFromOptional(Schema.OptionFromNullOr(Discord.Snowflake)),
});

const RosterMemberInput = Schema.Struct({
  roster_id: RosterModel.RosterId,
  team_member_id: TeamMember.TeamMemberId,
});

const RosterMemberEntriesInput = Schema.Struct({
  roster_id: RosterModel.RosterId,
});

class RosterIdRow extends Schema.Class<RosterIdRow>('RosterIdRow')({
  roster_id: RosterModel.RosterId,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeam = SqlSchema.findAll({
    Request: Schema.String,
    Result: RosterWithCount,
    execute: (teamId) => sql`
      SELECT r.id, r.team_id, r.name, r.active, r.color, r.emoji, r.discord_channel_id, r.created_at,
             (SELECT COUNT(*) FROM roster_members rm WHERE rm.roster_id = r.id)::int AS member_count
      FROM rosters r
      WHERE r.team_id = ${teamId}
      ORDER BY r.created_at DESC
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: RosterModel.RosterId,
    Result: RosterModel.Roster,
    execute: (id) => sql`SELECT * FROM rosters WHERE id = ${id}`,
  });

  const insertOne = SqlSchema.findOne({
    Request: RosterInsertInput,
    Result: RosterModel.Roster,
    execute: (input) => sql`
      INSERT INTO rosters (team_id, name, active, color, emoji)
      VALUES (${input.team_id}, ${input.name}, ${input.active}, ${input.color}, ${input.emoji})
      RETURNING *
    `,
  });

  const updateOne = SqlSchema.findOne({
    Request: Schema.Struct({
      id: RosterModel.RosterId,
      name: Schema.OptionFromNullOr(Schema.String),
      active: Schema.OptionFromNullOr(Schema.Boolean),
      color: Schema.OptionFromNullOr(Schema.String),
      emoji: Schema.OptionFromNullOr(Schema.String),
      update_channel: Schema.Boolean,
      discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    }),
    Result: RosterModel.Roster,
    execute: (i) => sql`
      UPDATE rosters
      SET name = COALESCE(${i.name}, name),
          active = COALESCE(${i.active}, active),
          color = ${i.color},
          emoji = ${i.emoji},
          discord_channel_id = CASE WHEN ${i.update_channel} THEN ${i.discord_channel_id} ELSE discord_channel_id END
      WHERE id = ${i.id}
      RETURNING *
    `,
  });

  const deleteOne = SqlSchema.void({
    Request: RosterModel.RosterId,
    execute: (id) => sql`DELETE FROM rosters WHERE id = ${id}`,
  });

  const findMemberEntries = SqlSchema.findAll({
    Request: RosterMemberEntriesInput,
    Result: RosterEntry,
    execute: (input) => sql`
      SELECT tm.id AS member_id, tm.user_id, u.discord_id,
             COALESCE(
               (SELECT string_agg(DISTINCT r.name, ',' ORDER BY r.name)
                FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                WHERE mr.team_member_id = tm.id), ''
             ) AS role_names,
             COALESCE(
               (SELECT string_agg(DISTINCT perm, ',') FROM (
                 SELECT rp.permission AS perm
                 FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                 WHERE mr.team_member_id = tm.id
                 UNION
                 SELECT rp.permission AS perm
                 FROM group_members gm
                 JOIN LATERAL (
                   WITH RECURSIVE ancestors AS (
                     SELECT gm.group_id AS id
                     UNION ALL
                     SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                   )
                   SELECT id FROM ancestors
                 ) anc ON true
                 JOIN role_groups rg ON rg.group_id = anc.id
                 JOIN role_permissions rp ON rp.role_id = rg.role_id
                 WHERE gm.team_member_id = tm.id
               ) all_perms), ''
             ) AS permissions,
             u.name, u.birth_date::text AS birth_date, u.gender, tm.jersey_number,
             u.username, u.avatar, u.discord_nickname, u.discord_display_name,
             to_char(tm.joined_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS joined_at,
             tm.active AS active
      FROM roster_members rmb
      JOIN team_members tm ON tm.id = rmb.team_member_id
      JOIN users u ON u.id = tm.user_id
      WHERE rmb.roster_id = ${input.roster_id}
    `,
  });

  const addMember = SqlSchema.void({
    Request: RosterMemberInput,
    execute: (input) => sql`
      INSERT INTO roster_members (roster_id, team_member_id)
      VALUES (${input.roster_id}, ${input.team_member_id})
      ON CONFLICT DO NOTHING
    `,
  });

  const removeMember = SqlSchema.void({
    Request: RosterMemberInput,
    execute: (input) => sql`
      DELETE FROM roster_members
      WHERE roster_id = ${input.roster_id} AND team_member_id = ${input.team_member_id}
    `,
  });

  const removeAllForMemberQuery = SqlSchema.void({
    Request: TeamMember.TeamMemberId,
    execute: (memberId) => sql`DELETE FROM roster_members WHERE team_member_id = ${memberId}`,
  });

  const findByTeamId = (teamId: Team.TeamId) => findByTeam(teamId).pipe(catchSqlErrors);

  const findRosterById = (rosterId: RosterModel.RosterId) =>
    findById(rosterId).pipe(catchSqlErrors);

  const insert = (input: typeof RosterInsertInput.Type) => insertOne(input).pipe(catchSqlErrors);

  const update = (input: typeof RosterUpdateInput.Type) =>
    updateOne({
      id: input.id,
      name: input.name,
      active: input.active,
      color: input.color,
      emoji: input.emoji,
      update_channel: Option.isSome(input.discord_channel_id),
      discord_channel_id: Option.getOrElse(input.discord_channel_id, () => Option.none()),
    }).pipe(catchSqlErrors);

  const _delete = (id: RosterModel.RosterId) => deleteOne(id).pipe(catchSqlErrors);

  const addMemberById = (rosterId: RosterModel.RosterId, teamMemberId: TeamMember.TeamMemberId) =>
    addMember({ roster_id: rosterId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  const removeMemberById = (
    rosterId: RosterModel.RosterId,
    teamMemberId: TeamMember.TeamMemberId,
  ) => removeMember({ roster_id: rosterId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  const removeAllForMember = (memberId: TeamMember.TeamMemberId) =>
    removeAllForMemberQuery(memberId).pipe(catchSqlErrors);

  const findMemberEntriesById = (rosterId: RosterModel.RosterId) =>
    findMemberEntries({ roster_id: rosterId }).pipe(catchSqlErrors);

  const findRosterIdsByMemberQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: RosterIdRow,
    execute: (memberId) => sql`
      SELECT roster_id FROM roster_members WHERE team_member_id = ${memberId}
    `,
  });

  const findRosterIdsByMember = (memberId: TeamMember.TeamMemberId) =>
    findRosterIdsByMemberQuery(memberId).pipe(
      Effect.map((rows) => rows.map((r) => r.roster_id)),
      catchSqlErrors,
    );

  return {
    findByTeamId,
    findRosterById,
    insert,
    update,
    delete: _delete,
    addMemberById,
    removeMemberById,
    findMemberEntriesById,
    findRosterIdsByMember,
    removeAllForMember,
  };
});

export class RostersRepository extends ServiceMap.Service<
  RostersRepository,
  Effect.Success<typeof make>
>()('api/RostersRepository') {
  static readonly Default = Layer.effect(RostersRepository, make);
}
