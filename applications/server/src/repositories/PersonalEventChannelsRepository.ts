import {
  Discord,
  type GroupModel,
  PersonalEventChannel,
  type Team,
  TeamMember,
} from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import {
  deprovisionableBucketSql,
  desiredBucketsSql,
  eventBucketSql,
  missingDesiredBucketSql,
} from '~/repositories/personalChannelBucket.js';

class MemberNeedingPersonalChannel extends Schema.Class<MemberNeedingPersonalChannel>(
  'MemberNeedingPersonalChannel',
)({
  team_member_id: TeamMember.TeamMemberId,
  discord_id: Discord.Snowflake,
  name: Schema.String,
  bucket: PersonalEventChannel.PersonalChannelBucket,
}) {}

class MemberToDeprovision extends Schema.Class<MemberToDeprovision>('MemberToDeprovision')({
  team_member_id: TeamMember.TeamMemberId,
  discord_channel_id: Discord.Snowflake,
  bucket: PersonalEventChannel.PersonalChannelBucket,
}) {}

class MemberToRename extends Schema.Class<MemberToRename>('MemberToRename')({
  team_member_id: TeamMember.TeamMemberId,
  discord_id: Discord.Snowflake,
  discord_channel_id: Discord.Snowflake,
  name: Schema.String,
  channel_format: Schema.String,
  bucket: PersonalEventChannel.PersonalChannelBucket,
}) {}

class PersonalChannelForEvent extends Schema.Class<PersonalChannelForEvent>(
  'PersonalChannelForEvent',
)({
  team_member_id: TeamMember.TeamMemberId,
  discord_id: Discord.Snowflake,
  personal_channel_id: Discord.Snowflake,
}) {}

const make = Effect.Do.pipe(
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.map(({ sql }) => {
    const _reserve = SqlSchema.findOneOption({
      Request: Schema.Struct({
        team_id: Schema.String,
        team_member_id: Schema.String,
        bucket: PersonalEventChannel.PersonalChannelBucket,
      }),
      Result: Schema.Struct({ id: Schema.String }),
      // Re-claimable lease: a fresh NULL reservation (mutual exclusion) or an already
      // provisioned row (non-NULL discord_channel_id) is left untouched by the DO UPDATE
      // guard clause, so the INSERT ... DO UPDATE ... WHERE returns no row for those cases.
      // A NULL reservation left stale for more than 15 minutes (e.g. a crashed worker) can
      // be re-claimed by bumping updated_at, which returns the row.
      execute: (input) => sql`
        INSERT INTO personal_event_channels (team_id, team_member_id, bucket)
        VALUES (${input.team_id}, ${input.team_member_id}, ${input.bucket})
        ON CONFLICT (team_id, team_member_id, bucket) DO UPDATE
          SET updated_at = now()
          WHERE personal_event_channels.discord_channel_id IS NULL
            AND personal_event_channels.updated_at < now() - interval '15 minutes'
        RETURNING id
      `,
    });

    const _saveChannelId = SqlSchema.void({
      Request: Schema.Struct({
        team_id: Schema.String,
        team_member_id: Schema.String,
        discord_channel_id: Discord.Snowflake,
        channel_format: Schema.String,
        bucket: PersonalEventChannel.PersonalChannelBucket,
      }),
      execute: (input) => sql`
        UPDATE personal_event_channels
        SET discord_channel_id = ${input.discord_channel_id},
            applied_channel_format = ${input.channel_format},
            updated_at = now()
        WHERE team_id = ${input.team_id} AND team_member_id = ${input.team_member_id}
          AND bucket = ${input.bucket}
      `,
    });

    const _saveChannelFormat = SqlSchema.void({
      Request: Schema.Struct({
        team_id: Schema.String,
        team_member_id: Schema.String,
        channel_format: Schema.String,
        bucket: PersonalEventChannel.PersonalChannelBucket,
      }),
      execute: (input) => sql`
        UPDATE personal_event_channels
        SET applied_channel_format = ${input.channel_format}, updated_at = now()
        WHERE team_id = ${input.team_id} AND team_member_id = ${input.team_member_id}
          AND bucket = ${input.bucket}
      `,
    });

    // Single CTE (plan §6.2/S3): a failure between two unwrapped statements used to be
    // able to orphan message rows forever. This is atomic AND scopes the message delete
    // to the dying channel only — a member-wide delete would, during a combined→split
    // switch, wipe rows the three new channels just created.
    const _deletePersonalChannel = SqlSchema.findOneOption({
      Request: Schema.Struct({
        team_id: Schema.String,
        team_member_id: Schema.String,
        bucket: PersonalEventChannel.PersonalChannelBucket,
      }),
      Result: Schema.Struct({
        discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      }),
      execute: (input) => sql`
        WITH gone AS (
          DELETE FROM personal_event_channels
          WHERE team_id = ${input.team_id}
            AND team_member_id = ${input.team_member_id}
            AND bucket = ${input.bucket}
          RETURNING discord_channel_id
        ), purged AS (
          DELETE FROM personal_event_messages pem
          USING gone
          WHERE pem.team_member_id = ${input.team_member_id}
            AND pem.personal_channel_id = gone.discord_channel_id
        )
        SELECT discord_channel_id FROM gone
      `,
    });

    const _getMembersNeeding = SqlSchema.findAll({
      Request: Schema.Struct({
        team_id: Schema.String,
        group_id: Schema.NullOr(Schema.String),
        limit: Schema.Number,
      }),
      Result: MemberNeedingPersonalChannel,
      execute: (input) => sql`
        SELECT tm.id AS team_member_id, u.discord_id, b.bucket,
          COALESCE(
            NULLIF(u.discord_display_name, ''),
            NULLIF(u.discord_nickname, ''),
            NULLIF(u.name, ''),
            u.discord_id
          ) AS name
        FROM team_members tm
        JOIN users u ON u.id = tm.user_id
        CROSS JOIN LATERAL unnest(${sql.unsafe(desiredBucketsSql('tm'))}) AS b(bucket)
        LEFT JOIN personal_event_channels pec
          ON pec.team_member_id = tm.id AND pec.team_id = tm.team_id AND pec.bucket = b.bucket
        WHERE tm.team_id = ${input.team_id}
          AND tm.active = true
          AND u.discord_id IS NOT NULL
          AND (pec.id IS NULL OR pec.discord_channel_id IS NULL)
          -- All four descendant walks in this file carry the same depth bound, required of every
          -- recursive groups.parent_id walk (applications/server/AGENTS.md). Nothing in the schema
          -- prevents a cycle and moveGroup only stops NEW ones, so a pre-existing or direct-SQL row
          -- would otherwise spin forever -- and there is no statement_timeout configured.
          --
          -- The poll walks below are the reason this matters beyond one team: their query takes no
          -- team scope at all, so it scans every team. ONE cyclic row anywhere stalled personal
          -- channel provisioning for EVERY guild on the instance, not just that team's.
          --
          -- These walks still do NOT filter is_archived, so a member reachable only through an
          -- archived subgroup is still treated as in scope. That is a real defect but a separate,
          -- DESTRUCTIVE change: adding the filter deprovisions existing channels and purges
          -- personal_event_messages, and all four walks must change together or provision and
          -- deprovision disagree and fight each other every tick.
          AND (
            ${input.group_id}::uuid IS NULL
            OR EXISTS (
              WITH RECURSIVE descendant_groups AS (
                SELECT id, 0 AS depth FROM groups WHERE id = ${input.group_id}::uuid AND team_id = ${input.team_id}
                UNION ALL
                SELECT g.id, dg.depth + 1 FROM groups g
                  JOIN descendant_groups dg ON g.parent_id = dg.id
                WHERE g.team_id = ${input.team_id} AND dg.depth < 32
              )
              SELECT 1 FROM group_members gm
              WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                AND gm.team_member_id = tm.id
            )
          )
        ORDER BY tm.id, b.bucket
        LIMIT ${input.limit}
      `,
    });

    const _getMembersToDeprovision = SqlSchema.findAll({
      Request: Schema.Struct({
        team_id: Schema.String,
        group_id: Schema.String,
        limit: Schema.Number,
      }),
      Result: MemberToDeprovision,
      execute: (input) => sql`
        SELECT tm.id AS team_member_id, pec.discord_channel_id, pec.bucket
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id AND tm.team_id = pec.team_id
        WHERE pec.team_id = ${input.team_id}
          AND pec.discord_channel_id IS NOT NULL
          AND NOT EXISTS (
            WITH RECURSIVE descendant_groups AS (
              SELECT id, 0 AS depth FROM groups WHERE id = ${input.group_id}::uuid AND team_id = ${input.team_id}
              UNION ALL
              SELECT g.id, dg.depth + 1 FROM groups g
                JOIN descendant_groups dg ON g.parent_id = dg.id
              WHERE g.team_id = ${input.team_id} AND dg.depth < 32
            )
            SELECT 1 FROM group_members gm
            WHERE gm.group_id IN (SELECT id FROM descendant_groups)
              AND gm.team_member_id = tm.id
          )
        ORDER BY tm.id
        LIMIT ${input.limit}
      `,
    });

    const _getInactiveMembersToDeprovision = SqlSchema.findAll({
      Request: Schema.Struct({
        team_id: Schema.String,
        limit: Schema.Number,
      }),
      Result: MemberToDeprovision,
      execute: (input) => sql`
        SELECT tm.id AS team_member_id, pec.discord_channel_id, pec.bucket
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id AND tm.team_id = pec.team_id
        WHERE pec.team_id = ${input.team_id}
          AND pec.discord_channel_id IS NOT NULL
          AND tm.active = false
        ORDER BY tm.id
        LIMIT ${input.limit}
      `,
    });

    // B3-gated — see `deprovisionableBucketSql`.
    const _getObsoleteBuckets = SqlSchema.findAll({
      Request: Schema.Struct({ team_id: Schema.String, limit: Schema.Number }),
      Result: MemberToDeprovision,
      execute: (input) => sql`
        SELECT tm.id AS team_member_id, pec.discord_channel_id, pec.bucket
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id AND tm.team_id = pec.team_id
        WHERE pec.team_id = ${input.team_id}
          AND ${sql.unsafe(deprovisionableBucketSql('tm', 'pec'))}
        ORDER BY tm.id
        LIMIT ${input.limit}
      `,
    });

    const _getChannelsToRename = SqlSchema.findAll({
      Request: Schema.Struct({ team_id: Schema.String, limit: Schema.Number }),
      Result: MemberToRename,
      execute: (input) => sql`
        SELECT tm.id AS team_member_id, u.discord_id, pec.discord_channel_id, pec.bucket,
          COALESCE(
            NULLIF(u.discord_display_name, ''),
            NULLIF(u.discord_nickname, ''),
            NULLIF(u.name, ''),
            u.discord_id
          ) AS name,
          ts.discord_personal_events_channel_format AS channel_format
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id AND tm.team_id = pec.team_id
        JOIN users u ON u.id = tm.user_id
        JOIN team_settings ts ON ts.team_id = pec.team_id
        WHERE pec.team_id = ${input.team_id}
          AND pec.discord_channel_id IS NOT NULL
          AND u.discord_id IS NOT NULL
          AND pec.applied_channel_format IS DISTINCT FROM ts.discord_personal_events_channel_format
        ORDER BY tm.id
        LIMIT ${input.limit}
      `,
    });

    const _getGuildsNeedingProvisioning = SqlSchema.findAll({
      Request: Schema.Struct({ limit: Schema.Number }),
      Result: Schema.Struct({ guild_id: Discord.Snowflake }),
      execute: (input) => sql`
        SELECT DISTINCT t.guild_id
        FROM teams t
        JOIN team_settings ts ON ts.team_id = t.id
        JOIN team_members tm ON tm.team_id = t.id
        LEFT JOIN personal_event_channels pec ON pec.team_member_id = tm.id AND pec.team_id = tm.team_id
        WHERE ts.discord_personal_events_category_id IS NOT NULL
          AND t.guild_id IS NOT NULL
          AND tm.active = true
          AND (
            -- (a) an eligible member still missing a channel for some desired bucket
            (
              ${sql.unsafe(missingDesiredBucketSql('tm', 'tm.team_id', 'tm.id'))}
              AND (
                ts.discord_personal_events_group_id IS NULL
                OR EXISTS (
                  WITH RECURSIVE descendant_groups AS (
                    SELECT id, 0 AS depth FROM groups
                      WHERE id = ts.discord_personal_events_group_id AND team_id = t.id
                    UNION ALL
                    SELECT g.id, dg.depth + 1 FROM groups g
                      JOIN descendant_groups dg ON g.parent_id = dg.id
                    WHERE g.team_id = t.id AND dg.depth < 32
                  )
                  SELECT 1 FROM group_members gm
                  WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                    AND gm.team_member_id = tm.id
                )
              )
            )
            -- (b) a member with a channel who is no longer in the configured group
            OR (
              pec.discord_channel_id IS NOT NULL
              AND ts.discord_personal_events_group_id IS NOT NULL
              AND NOT EXISTS (
                WITH RECURSIVE descendant_groups AS (
                  SELECT id, 0 AS depth FROM groups
                    WHERE id = ts.discord_personal_events_group_id AND team_id = t.id
                  UNION ALL
                  SELECT g.id, dg.depth + 1 FROM groups g
                    JOIN descendant_groups dg ON g.parent_id = dg.id
                  WHERE g.team_id = t.id AND dg.depth < 32
                )
                SELECT 1 FROM group_members gm
                WHERE gm.group_id IN (SELECT id FROM descendant_groups)
                  AND gm.team_member_id = tm.id
              )
            )
            -- (c) a channel whose name was rendered with an outdated format
            OR (
              pec.discord_channel_id IS NOT NULL
              AND pec.applied_channel_format IS DISTINCT FROM ts.discord_personal_events_channel_format
            )
            -- (e) an existing channel outside the desired bucket set. Shares the exact
            --     predicate _getObsoleteBuckets uses, B3 gate included, so a mode flip
            --     wakes the poll exactly when deprovision would be safe to run.
            OR (${sql.unsafe(deprovisionableBucketSql('tm', 'pec'))})
          )
        UNION
        -- (d) inactive members still holding a personal channel (unreachable via the active-member
        --     branch above; requires a separate UNION so the bot poll picks them up for de-provision)
        SELECT DISTINCT t.guild_id
        FROM teams t
        JOIN team_settings ts ON ts.team_id = t.id
        JOIN team_members tm ON tm.team_id = t.id
        JOIN personal_event_channels pec ON pec.team_member_id = tm.id AND pec.team_id = tm.team_id
        WHERE ts.discord_personal_events_category_id IS NOT NULL
          AND t.guild_id IS NOT NULL
          AND tm.active = false
          AND pec.discord_channel_id IS NOT NULL
        LIMIT ${input.limit}
      `,
    });

    const _findChannelOwner = SqlSchema.findOneOption({
      Request: Schema.Struct({
        team_id: Schema.String,
        channel_id: Schema.String,
      }),
      Result: Schema.Struct({
        team_member_id: TeamMember.TeamMemberId,
        discord_id: Discord.Snowflake,
      }),
      execute: (input) => sql`
        SELECT pec.team_member_id, u.discord_id
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id
        JOIN users u ON u.id = tm.user_id
        WHERE pec.team_id = ${input.team_id}
          AND pec.discord_channel_id = ${input.channel_id}
          AND u.discord_id IS NOT NULL
      `,
    });

    // Bucket routing (plan §3/§6.2) — the leverage point that keeps the bot almost
    // entirely bucket-unaware. The CASE yields exactly one bucket value per member,
    // so this returns exactly one row per member even in the transitional state
    // where a member holds an 'all' row AND split rows simultaneously (reachable
    // for a full tick under the B3 gate) — two rows would make reconcile double-post.
    const _listForEvent = SqlSchema.findAll({
      Request: Schema.Struct({ event_id: Schema.String }),
      Result: PersonalChannelForEvent,
      execute: (input) => sql`
        SELECT pec.team_member_id, u.discord_id, pec.discord_channel_id AS personal_channel_id
        FROM personal_event_channels pec
        JOIN team_members tm ON tm.id = pec.team_member_id
        JOIN users u ON u.id = tm.user_id
        JOIN events e ON e.team_id = pec.team_id
        WHERE e.id = ${input.event_id}
          AND pec.discord_channel_id IS NOT NULL
          AND u.discord_id IS NOT NULL
          AND pec.bucket = CASE WHEN tm.personal_channels_split
                                THEN ${sql.unsafe(eventBucketSql('e'))}
                                ELSE 'all' END
      `,
    });

    const reservePersonalChannel = (
      teamId: Team.TeamId,
      teamMemberId: TeamMember.TeamMemberId,
      bucket: PersonalEventChannel.PersonalChannelBucket = 'all',
    ) =>
      _reserve({ team_id: teamId, team_member_id: teamMemberId, bucket }).pipe(
        Effect.map(Option.isSome),
        catchSqlErrors,
      );

    const savePersonalChannelId = (
      teamId: Team.TeamId,
      teamMemberId: TeamMember.TeamMemberId,
      discordChannelId: Discord.Snowflake,
      channelFormat: string,
      bucket: PersonalEventChannel.PersonalChannelBucket = 'all',
    ) =>
      _saveChannelId({
        team_id: teamId,
        team_member_id: teamMemberId,
        discord_channel_id: discordChannelId,
        channel_format: channelFormat,
        bucket,
      }).pipe(catchSqlErrors);

    const savePersonalChannelFormat = (
      teamId: Team.TeamId,
      teamMemberId: TeamMember.TeamMemberId,
      channelFormat: string,
      bucket: PersonalEventChannel.PersonalChannelBucket = 'all',
    ) =>
      _saveChannelFormat({
        team_id: teamId,
        team_member_id: teamMemberId,
        channel_format: channelFormat,
        bucket,
      }).pipe(catchSqlErrors);

    const getChannelsToRename = (teamId: Team.TeamId, limit: number) =>
      _getChannelsToRename({ team_id: teamId, limit }).pipe(catchSqlErrors);

    const deletePersonalChannel = (
      teamId: Team.TeamId,
      teamMemberId: TeamMember.TeamMemberId,
      bucket: PersonalEventChannel.PersonalChannelBucket = 'all',
    ) =>
      _deletePersonalChannel({ team_id: teamId, team_member_id: teamMemberId, bucket }).pipe(
        Effect.map(Option.flatMap((row) => row.discord_channel_id)),
        catchSqlErrors,
      );

    const getMembersNeedingPersonalChannel = (
      teamId: Team.TeamId,
      groupId: Option.Option<GroupModel.GroupId>,
      limit: number,
    ) =>
      _getMembersNeeding({
        team_id: teamId,
        group_id: Option.getOrNull(groupId),
        limit,
      }).pipe(catchSqlErrors);

    const getMembersToDeprovision = (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      limit: number,
    ) =>
      _getMembersToDeprovision({ team_id: teamId, group_id: groupId, limit }).pipe(catchSqlErrors);

    const getInactiveMembersToDeprovision = (teamId: Team.TeamId, limit: number) =>
      _getInactiveMembersToDeprovision({ team_id: teamId, limit }).pipe(catchSqlErrors);

    const getObsoleteBucketsToDeprovision = (teamId: Team.TeamId, limit: number) =>
      _getObsoleteBuckets({ team_id: teamId, limit }).pipe(catchSqlErrors);

    const getGuildsNeedingPersonalProvisioning = (limit: number) =>
      _getGuildsNeedingProvisioning({ limit }).pipe(
        Effect.map((rows) => rows.map((r) => r.guild_id)),
        catchSqlErrors,
      );

    const listPersonalChannelsForEvent = (eventId: string) =>
      _listForEvent({ event_id: eventId }).pipe(catchSqlErrors);

    // Resolve the owner of a personal events channel by its Discord channel id alone
    // (NOT keyed to the caller) so admins can refresh another member's channel. The
    // bot decides own-vs-other by comparing the returned `discord_id` to the caller.
    const findPersonalChannelOwner = (teamId: Team.TeamId, channelId: Discord.Snowflake) =>
      _findChannelOwner({ team_id: teamId, channel_id: channelId }).pipe(catchSqlErrors);

    return {
      reservePersonalChannel,
      savePersonalChannelId,
      savePersonalChannelFormat,
      deletePersonalChannel,
      getMembersNeedingPersonalChannel,
      getMembersToDeprovision,
      getInactiveMembersToDeprovision,
      getObsoleteBucketsToDeprovision,
      getChannelsToRename,
      getGuildsNeedingPersonalProvisioning,
      listPersonalChannelsForEvent,
      findPersonalChannelOwner,
    };
  }),
);

export class PersonalEventChannelsRepository extends ServiceMap.Service<
  PersonalEventChannelsRepository,
  Effect.Success<typeof make>
>()('api/PersonalEventChannelsRepository') {
  static readonly Default = Layer.effect(PersonalEventChannelsRepository, make);
}
