import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Forbidden } from '~/api/EventApi.js';
import { Snowflake } from '~/models/Discord.js';
import { OnboardingLocale, OnboardingSyncStatus } from '~/models/Onboarding.js';
import { TeamId } from '~/models/Team.js';

export class TeamInfo extends Schema.Class<TeamInfo>('TeamInfo')({
  teamId: TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  sport: Schema.OptionFromNullOr(Schema.String),
  logoUrl: Schema.OptionFromNullOr(Schema.String),
  guildId: Snowflake,
  welcomeChannelId: Schema.OptionFromNullOr(Snowflake),
  systemLogChannelId: Schema.OptionFromNullOr(Snowflake),
  welcomeMessageTemplate: Schema.OptionFromNullOr(Schema.String),
  rulesChannelId: Schema.OptionFromNullOr(Snowflake),
  achievementChannelId: Schema.OptionFromNullOr(Snowflake),
  onboardingRulesRoleId: Schema.OptionFromNullOr(Snowflake),
  onboardingLocale: OnboardingLocale,
  onboardingSyncStatus: OnboardingSyncStatus,
  onboardingSyncedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  onboardingSyncError: Schema.OptionFromNullOr(Schema.String),
  isCommunityEnabled: Schema.Boolean,
}) {}

export const UpdateTeamRequest = Schema.Struct({
  name: Schema.OptionFromOptional(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(100))),
  ),
  description: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  ),
  sport: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(50)))),
  ),
  logoUrl: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)))),
  ),
  welcomeChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  achievementChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  systemLogChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  welcomeMessageTemplate: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  ),
  rulesChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingRulesRoleId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  onboardingLocale: Schema.OptionFromOptional(OnboardingLocale),
});
export type UpdateTeamRequest = Schema.Schema.Type<typeof UpdateTeamRequest>;

export class TeamApiGroup extends HttpApiGroup.make('team')
  .add(
    HttpApiEndpoint.get('getTeamInfo', '/teams/:teamId', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateTeamInfo', '/teams/:teamId', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      payload: UpdateTeamRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('retryOnboardingSync', '/teams/:teamId/onboarding/retry', {
      success: TeamInfo,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
