import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const TeamOnboardingTokenId = Schema.String.pipe(Schema.brand('TeamOnboardingTokenId'));
export type TeamOnboardingTokenId = typeof TeamOnboardingTokenId.Type;

export const OnboardingTokenTtl = Schema.Literals(['24h', '72h', '7d']);
export type OnboardingTokenTtl = typeof OnboardingTokenTtl.Type;

export class TeamOnboardingToken extends Model.Class<TeamOnboardingToken>('TeamOnboardingToken')({
  id: Model.Generated(TeamOnboardingTokenId),
  token_hash: Schema.String,
  proposed_name: Schema.String,
  bound_discord_id: Snowflake,
  created_by: UserId,
  created_at: Model.DateTimeInsertFromDate,
  expires_at: Schemas.DateTimeFromDate,
  consumed_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  consumed_by: Schema.OptionFromNullOr(UserId),
  resulting_team_id: Schema.OptionFromNullOr(TeamId),
  revoked_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}
