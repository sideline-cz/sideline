import { Discord, Onboarding, Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const TeamUpdateInput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logo_url: Schema.OptionFromNullOr(Schema.String),
  welcome_channel_id: Schema.OptionFromNullOr(Schema.String),
  system_log_channel_id: Schema.OptionFromNullOr(Schema.String),
  welcome_message_template: Schema.OptionFromNullOr(Schema.String),
  rules_channel_id: Schema.OptionFromNullOr(Schema.String),
  onboarding_rules_role_id: Schema.OptionFromNullOr(Schema.String),
  onboarding_locale: Onboarding.OnboardingLocale,
});

class PendingOnboardingSyncRow extends Schema.Class<PendingOnboardingSyncRow>(
  'PendingOnboardingSyncRow',
)({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  team_name: Schema.String,
  onboarding_locale: Onboarding.OnboardingLocale,
  rules_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  welcome_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  training_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  overview_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  onboarding_rules_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  onboarding_rules_prompt_id: Schema.OptionFromNullOr(Discord.Snowflake),
  is_community_enabled: Schema.Boolean,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: Team.Team,
    execute: (id) => sql`SELECT * FROM teams WHERE id = ${id}`,
  });

  const insertQuery = SqlSchema.findOne({
    Request: Team.Team.insert,
    Result: Team.Team,
    execute: (input) => sql`
      INSERT INTO teams (name, guild_id, description, sport, logo_url, created_by, welcome_channel_id)
      VALUES (${input.name}, ${input.guild_id}, ${input.description}, ${input.sport}, ${input.logo_url}, ${input.created_by}, ${input.welcome_channel_id})
      RETURNING *
    `,
  });

  const findById = (id: Team.TeamId) => findByIdQuery(id).pipe(catchSqlErrors);

  const insert = (input: typeof Team.Team.insert.Type) =>
    insertQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'Team insert returned no row'),
      ),
    );

  const findByGuildQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Team.Team,
    execute: (guildId) => sql`SELECT * FROM teams WHERE guild_id = ${guildId}`,
  });

  const findByGuildId = (guildId: Discord.Snowflake) =>
    findByGuildQuery(guildId).pipe(catchSqlErrors);

  const findByGuildIds = (guildIds: ReadonlyArray<typeof Discord.Snowflake.Type>) => {
    if (guildIds.length === 0) {
      return Effect.succeed([] as Team.Team[]);
    }
    return sql`SELECT * FROM teams WHERE guild_id IN ${sql.in([...guildIds])}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Team.Team))),
      catchSqlErrors,
    );
  };

  const updateTeamQuery = SqlSchema.findOne({
    Request: TeamUpdateInput,
    Result: Team.Team,
    execute: (input) => sql`
      UPDATE teams SET
        name = ${input.name},
        description = ${input.description},
        sport = ${input.sport},
        logo_url = ${input.logo_url},
        welcome_channel_id = ${input.welcome_channel_id},
        system_log_channel_id = ${input.system_log_channel_id},
        welcome_message_template = ${input.welcome_message_template},
        rules_channel_id = ${input.rules_channel_id},
        onboarding_rules_role_id = ${input.onboarding_rules_role_id},
        onboarding_locale = ${input.onboarding_locale},
        updated_at = now()
      WHERE id = ${input.id}
      RETURNING *
    `,
  });

  const update = (input: {
    readonly id: Team.TeamId;
    readonly name: string;
    readonly description: Option.Option<string>;
    readonly sport: Option.Option<string>;
    readonly logo_url: Option.Option<string>;
    readonly welcome_channel_id: Option.Option<string>;
    readonly system_log_channel_id: Option.Option<string>;
    readonly welcome_message_template: Option.Option<string>;
    readonly rules_channel_id: Option.Option<string>;
    readonly onboarding_rules_role_id: Option.Option<string>;
    readonly onboarding_locale: Onboarding.OnboardingLocale;
  }) =>
    updateTeamQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'Team update returned no row'),
      ),
    );

  const claimPendingOnboardingSyncs = (limit: number) =>
    sql`
      WITH claimed AS (
        UPDATE teams SET onboarding_sync_status = 'syncing'
        WHERE id IN (
          SELECT id FROM teams
          WHERE onboarding_sync_status = 'pending'
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, guild_id, name, onboarding_locale,
                  rules_channel_id, welcome_channel_id, overview_channel_id,
                  onboarding_rules_role_id, onboarding_rules_prompt_id
      )
      SELECT
        c.id AS team_id,
        c.guild_id,
        c.name AS team_name,
        c.onboarding_locale,
        c.rules_channel_id,
        c.welcome_channel_id,
        c.overview_channel_id,
        c.onboarding_rules_role_id,
        c.onboarding_rules_prompt_id,
        ts.discord_channel_training AS training_channel_id,
        COALESCE(bg.is_community_enabled, false) AS is_community_enabled
      FROM claimed c
      LEFT JOIN team_settings ts ON ts.team_id = c.id
      LEFT JOIN bot_guilds bg ON bg.guild_id = c.guild_id
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PendingOnboardingSyncRow))),
      catchSqlErrors,
    );

  const markOnboardingSyncPending = (teamId: Team.TeamId) =>
    sql`
      UPDATE teams
      SET onboarding_sync_status = 'pending',
          onboarding_sync_error = NULL
      WHERE id = ${teamId}
    `.pipe(Effect.asVoid, catchSqlErrors);

  const markOnboardingSyncDoneIfSyncing = (
    teamId: Team.TeamId,
    promptId: Option.Option<string>,
  ) => {
    const promptValue = Option.getOrNull(promptId);
    return sql`
      UPDATE teams
      SET onboarding_sync_status = 'done',
          onboarding_synced_at = now(),
          onboarding_rules_prompt_id = COALESCE(${promptValue}, onboarding_rules_prompt_id)
      WHERE id = ${teamId}
        AND onboarding_sync_status = 'syncing'
      RETURNING id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      catchSqlErrors,
    );
  };

  const markOnboardingSyncFailedIfSyncing = (teamId: Team.TeamId, errorJson: string) =>
    sql`
      UPDATE teams
      SET onboarding_sync_status = 'failed',
          onboarding_sync_error = ${errorJson}
      WHERE id = ${teamId}
        AND onboarding_sync_status = 'syncing'
    `.pipe(Effect.asVoid, catchSqlErrors);

  const revertOnboardingSyncIfSyncing = (teamId: Team.TeamId) =>
    sql`
      UPDATE teams
      SET onboarding_sync_status = 'pending',
          onboarding_sync_error = NULL
      WHERE id = ${teamId}
        AND onboarding_sync_status = 'syncing'
    `.pipe(Effect.asVoid, catchSqlErrors);

  const markOnboardingSyncSkippedIfSyncing = (teamId: Team.TeamId) =>
    sql`
      UPDATE teams
      SET onboarding_sync_status = 'done',
          onboarding_sync_error = ${JSON.stringify({ code: 'community_disabled', detail: 'Community feature not enabled' })}
      WHERE id = ${teamId}
        AND onboarding_sync_status = 'syncing'
    `.pipe(Effect.asVoid, catchSqlErrors);

  const flipPendingOnboardingSyncForGuild = (guildId: Discord.Snowflake) =>
    sql`
      UPDATE teams
      SET onboarding_sync_status = 'pending',
          onboarding_sync_error = NULL
      WHERE guild_id = ${guildId}
        AND (
          (onboarding_sync_status = 'done' AND onboarding_sync_error::jsonb->>'code' = 'community_disabled')
          OR
          (onboarding_sync_status = 'failed' AND onboarding_sync_error::jsonb->>'code' = 'community_disabled')
        )
    `.pipe(Effect.asVoid, catchSqlErrors);

  const getOnboardingRulesRoleIdByGuildId = (guildId: Discord.Snowflake) =>
    sql`
      SELECT onboarding_rules_role_id FROM teams WHERE guild_id = ${guildId}
    `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              onboarding_rules_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
            }),
          ),
        ),
      ),
      Effect.map((rows) =>
        rows.length > 0 ? rows[0].onboarding_rules_role_id : Option.none<Discord.Snowflake>(),
      ),
      catchSqlErrors,
    );

  // Sets teams.overview_channel_id for the team matching guild_id. Returns the number
  // of rows whose value actually changed so the caller can re-trigger onboarding sync
  // only when the channel moved.
  const setOverviewChannelByGuildId = (guildId: Discord.Snowflake, channelId: Discord.Snowflake) =>
    sql<{ id: Team.TeamId }>`
      UPDATE teams
      SET overview_channel_id = ${channelId},
          updated_at = now()
      WHERE guild_id = ${guildId}
        AND (overview_channel_id IS DISTINCT FROM ${channelId})
      RETURNING id
    `.pipe(catchSqlErrors);

  return {
    findById,
    insert,
    findByGuildId,
    findByGuildIds,
    update,
    claimPendingOnboardingSyncs,
    markOnboardingSyncPending,
    markOnboardingSyncDoneIfSyncing,
    markOnboardingSyncFailedIfSyncing,
    revertOnboardingSyncIfSyncing,
    markOnboardingSyncSkippedIfSyncing,
    flipPendingOnboardingSyncForGuild,
    getOnboardingRulesRoleIdByGuildId,
    setOverviewChannelByGuildId,
  };
});

export class TeamsRepository extends ServiceMap.Service<
  TeamsRepository,
  Effect.Success<typeof make>
>()('api/TeamsRepository') {
  static readonly Default = Layer.effect(TeamsRepository, make);
}
