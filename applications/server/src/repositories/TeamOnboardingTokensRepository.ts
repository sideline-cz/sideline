import { Auth, Discord, type OnboardingApi, Team, TeamOnboardingToken } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export interface MarkConsumedInput {
  readonly consumed_by: Auth.UserId;
  readonly resulting_team_id: Team.TeamId;
}

/**
 * Input shape for `create`. Accepts either `DateTime.Utc` or `Date` for `expires_at`.
 *
 * - The real repository converts `DateTime.Utc` → `Date` before passing to SQL.
 * - Callers may also pass a plain `Date` (e.g. from `DateTime.toDateUtc`).
 */
export interface CreateTokenInput {
  readonly token_hash: string;
  readonly proposed_name: string;
  readonly bound_discord_id: Discord.Snowflake;
  readonly created_by: Auth.UserId;
  readonly expires_at: DateTime.Utc | Date;
}

// Internal schema for the create query — expires_at is always a Date after conversion
const CreateInputSchema = Schema.Struct({
  token_hash: Schema.String,
  proposed_name: Schema.String,
  bound_discord_id: Discord.Snowflake,
  created_by: Auth.UserId,
  expires_at: Schema.instanceOf(Date),
});

const MarkConsumedRequest = Schema.Struct({
  id: TeamOnboardingToken.TeamOnboardingTokenId,
  consumed_by: Auth.UserId,
  resulting_team_id: Team.TeamId,
});

/**
 * Extended list item that includes both camelCase fields (for the HTTP response)
 * and a `created_at` alias (for repository-level ordering assertions in tests).
 */
export type AdminTokenListItem = OnboardingApi.OnboardingTokenListItem & {
  readonly created_at: DateTime.Utc;
};

// Row returned by the JOIN query for listForAdmin
class ListForAdminRow extends Schema.Class<ListForAdminRow>('ListForAdminRow')({
  id: TeamOnboardingToken.TeamOnboardingTokenId,
  proposed_name: Schema.String,
  bound_discord_id: Discord.Snowflake,
  created_at: Schema.Date,
  expires_at: Schema.Date,
  consumed_at: Schema.NullOr(Schema.Date),
  revoked_at: Schema.NullOr(Schema.Date),
  consumed_by: Schema.NullOr(Auth.UserId),
  resulting_team_id: Schema.NullOr(Team.TeamId),
  created_by_username: Schema.String,
}) {}

const toAdminListItem = (row: ListForAdminRow, now: Date): AdminTokenListItem => {
  const status: OnboardingApi.OnboardingTokenStatus =
    row.consumed_at !== null
      ? 'consumed'
      : row.revoked_at !== null
        ? 'revoked'
        : row.expires_at <= now
          ? 'expired'
          : 'active';

  const createdAt = DateTime.fromDateUnsafe(row.created_at);
  return {
    id: row.id,
    proposedName: row.proposed_name,
    boundDiscordId: row.bound_discord_id,
    created_at: createdAt,
    createdAt,
    expiresAt: DateTime.fromDateUnsafe(row.expires_at),
    status,
    consumedAt:
      row.consumed_at !== null
        ? Option.some(DateTime.fromDateUnsafe(row.consumed_at))
        : Option.none(),
    consumedBy: row.consumed_by !== null ? Option.some(row.consumed_by) : Option.none(),
    resultingTeamId:
      row.resulting_team_id !== null ? Option.some(row.resulting_team_id) : Option.none(),
    createdByUsername: row.created_by_username,
  };
};

const expiresAtToDate = (value: DateTime.Utc | Date): Date =>
  DateTime.isDateTime(value) ? DateTime.toDateUtc(value) : value;

const make = SqlClient.SqlClient.asEffect().pipe(
  Effect.map((sql) => {
    const createQuery = SqlSchema.findOne({
      Request: CreateInputSchema,
      Result: TeamOnboardingToken.TeamOnboardingToken,
      execute: (input) => sql`
        INSERT INTO team_onboarding_tokens (
          token_hash, proposed_name, bound_discord_id, created_by, expires_at
        )
        VALUES (
          ${input.token_hash}, ${input.proposed_name}, ${input.bound_discord_id}, ${input.created_by}, ${input.expires_at}
        )
        RETURNING *
      `,
    });

    const findByHashQuery = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: TeamOnboardingToken.TeamOnboardingToken,
      execute: (hash) => sql`SELECT * FROM team_onboarding_tokens WHERE token_hash = ${hash}`,
    });

    const findByIdQuery = SqlSchema.findOneOption({
      Request: TeamOnboardingToken.TeamOnboardingTokenId,
      Result: TeamOnboardingToken.TeamOnboardingToken,
      execute: (id) => sql`SELECT * FROM team_onboarding_tokens WHERE id = ${id}`,
    });

    const markConsumedQuery = SqlSchema.findOneOption({
      Request: MarkConsumedRequest,
      Result: Schema.Struct({ id: TeamOnboardingToken.TeamOnboardingTokenId }),
      execute: (input) => sql`
        UPDATE team_onboarding_tokens
        SET consumed_at = now(),
            consumed_by = ${input.consumed_by},
            resulting_team_id = ${input.resulting_team_id}
        WHERE id = ${input.id}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING id
      `,
    });

    const revokeQuery = SqlSchema.void({
      Request: TeamOnboardingToken.TeamOnboardingTokenId,
      execute: (id) => sql`
        UPDATE team_onboarding_tokens
        SET revoked_at = now()
        WHERE id = ${id}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
      `,
    });

    const listForAdminQuery = SqlSchema.findAll({
      Request: Schema.Void,
      Result: ListForAdminRow,
      execute: () =>
        sql`
          SELECT
            t.id,
            t.proposed_name,
            t.bound_discord_id,
            t.created_at,
            t.expires_at,
            t.consumed_at,
            t.revoked_at,
            t.consumed_by,
            t.resulting_team_id,
            COALESCE(u.username, 'unknown') AS created_by_username
          FROM team_onboarding_tokens t
          LEFT JOIN users u ON u.id = t.created_by
          ORDER BY t.created_at DESC, t.id DESC
        `,
    });

    return {
      create: (input: CreateTokenInput) =>
        createQuery({
          token_hash: input.token_hash,
          proposed_name: input.proposed_name,
          bound_discord_id: input.bound_discord_id,
          created_by: input.created_by,
          expires_at: expiresAtToDate(input.expires_at),
        }).pipe(
          catchSqlErrors,
          Effect.catchTag('NoSuchElementError', () =>
            Effect.die(new Error('TeamOnboardingTokensRepository.create: insert returned no row')),
          ),
        ),

      findByHash: (hash: string) => findByHashQuery(hash).pipe(catchSqlErrors),

      findById: (id: TeamOnboardingToken.TeamOnboardingTokenId) =>
        findByIdQuery(id).pipe(catchSqlErrors),

      markConsumed: (id: TeamOnboardingToken.TeamOnboardingTokenId, input: MarkConsumedInput) =>
        markConsumedQuery({
          id,
          consumed_by: input.consumed_by,
          resulting_team_id: input.resulting_team_id,
        }).pipe(catchSqlErrors),

      revoke: (id: TeamOnboardingToken.TeamOnboardingTokenId) =>
        revokeQuery(id).pipe(catchSqlErrors),

      listForAdmin: () =>
        listForAdminQuery(undefined).pipe(
          catchSqlErrors,
          Effect.map((rows) => {
            const now = new Date();
            return rows.map((row) => toAdminListItem(row, now));
          }),
        ),
    };
  }),
);

export class TeamOnboardingTokensRepository extends ServiceMap.Service<
  TeamOnboardingTokensRepository,
  Effect.Success<typeof make>
>()('api/TeamOnboardingTokensRepository') {
  static readonly Default = Layer.effect(TeamOnboardingTokensRepository, make);
}
