import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { UserId } from '~/models/User.js';

export const OAuthConnectionId = Schema.String.pipe(Schema.brand('OAuthConnectionId'));
export type OAuthConnectionId = typeof OAuthConnectionId.Type;

export const REQUIRED_DISCORD_SCOPE = 'guilds.join';

export const parseScopes = (raw: string): ReadonlyArray<string> =>
  raw.length === 0 ? [] : raw.split(' ').filter((s) => s.length > 0);

export const hasScope = (raw: string, scope: string): boolean => parseScopes(raw).includes(scope);

export class OAuthConnection extends Model.Class<OAuthConnection>('OAuthConnection')({
  id: Model.Generated(OAuthConnectionId),
  user_id: UserId,
  provider: Schema.String,
  access_token: Model.Sensitive(Schema.String),
  refresh_token: Model.Sensitive(Schema.OptionFromNullOr(Schema.String)),
  granted_scopes: Schema.String,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
