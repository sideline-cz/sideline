import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Forbidden } from '~/api/EventApi.js';
import { Snowflake } from '~/models/Discord.js';
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
  systemLogChannelId: Schema.OptionFromOptional(Schema.OptionFromNullOr(Snowflake)),
  welcomeMessageTemplate: Schema.OptionFromOptional(
    Schema.OptionFromNullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
  ),
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
  ) {}
