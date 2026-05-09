import { OAuthConnection, User } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const UpsertInput = Schema.Struct({
  user_id: User.UserId,
  provider: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.OptionFromNullOr(Schema.String),
  granted_scopes: Schema.String,
});

const FindInput = Schema.Struct({
  user_id: User.UserId,
  provider: Schema.String,
});

class AccessTokenRow extends Schema.Class<AccessTokenRow>('AccessTokenRow')({
  access_token: Schema.String,
}) {}

class GrantedScopesRow extends Schema.Class<GrantedScopesRow>('GrantedScopesRow')({
  granted_scopes: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _upsertConnection = SqlSchema.findOne({
    Request: UpsertInput,
    Result: OAuthConnection.OAuthConnection,
    execute: (input) => sql`
      INSERT INTO oauth_connections (user_id, provider, access_token, refresh_token, granted_scopes)
      VALUES (${input.user_id}, ${input.provider}, ${input.access_token}, ${input.refresh_token}, ${input.granted_scopes})
      ON CONFLICT (user_id, provider) DO UPDATE SET
        access_token = ${input.access_token},
        refresh_token = ${input.refresh_token},
        granted_scopes = ${input.granted_scopes},
        updated_at = now()
      RETURNING *
    `,
  });

  const _findByUserAndProvider = SqlSchema.findOneOption({
    Request: FindInput,
    Result: OAuthConnection.OAuthConnection,
    execute: (input) => sql`
      SELECT * FROM oauth_connections
      WHERE user_id = ${input.user_id} AND provider = ${input.provider}
    `,
  });

  const _findAccessToken = SqlSchema.findOneOption({
    Request: FindInput,
    Result: AccessTokenRow,
    execute: (input) => sql`
      SELECT access_token FROM oauth_connections
      WHERE user_id = ${input.user_id} AND provider = ${input.provider}
    `,
  });

  const _findGrantedScopes = SqlSchema.findOneOption({
    Request: FindInput,
    Result: GrantedScopesRow,
    execute: (input) => sql`
      SELECT granted_scopes FROM oauth_connections
      WHERE user_id = ${input.user_id} AND provider = ${input.provider}
    `,
  });

  const upsert = (
    userId: User.UserId,
    provider: string,
    accessToken: string,
    refreshToken: Option.Option<string>,
    grantedScopes: string,
  ) =>
    _upsertConnection({
      user_id: userId,
      provider,
      access_token: accessToken,
      refresh_token: refreshToken,
      granted_scopes: grantedScopes,
    }).pipe(catchSqlErrors);

  const findByUser = (userId: User.UserId, provider: string) =>
    _findByUserAndProvider({ user_id: userId, provider }).pipe(catchSqlErrors);

  const getAccessToken = (userId: User.UserId, provider: string) =>
    _findAccessToken({ user_id: userId, provider }).pipe(
      catchSqlErrors,
      Effect.map(Option.map((row) => row.access_token)),
    );

  const getGrantedScopes = (userId: User.UserId, provider: string) =>
    _findGrantedScopes({ user_id: userId, provider }).pipe(
      catchSqlErrors,
      Effect.map(Option.map((row) => row.granted_scopes)),
    );

  return {
    upsert,
    findByUser,
    getAccessToken,
    getGrantedScopes,
  };
});

export class OAuthConnectionsRepository extends ServiceMap.Service<
  OAuthConnectionsRepository,
  Effect.Success<typeof make>
>()('api/OAuthConnectionsRepository') {
  static readonly Default = Layer.effect(OAuthConnectionsRepository, make);
}
