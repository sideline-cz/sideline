import { Schema, ServiceMap } from 'effect';
import {
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  HttpApiSchema,
  HttpApiSecurity,
} from 'effect/unstable/httpapi';
import { Snowflake } from '~/models/Discord.js';
import { Permission } from '~/models/Role.js';
import { TeamId } from '~/models/Team.js';
import { Gender, Locale, UserId } from '~/models/User.js';

export { UserId } from '~/models/User.js';

export const MIN_AGE = 6;
export const DEFAULT_BIRTH_YEAR_OFFSET = 18;

export class UserTeam extends Schema.Class<UserTeam>('UserTeam')({
  teamId: TeamId,
  teamName: Schema.String,
  logoUrl: Schema.OptionFromNullOr(Schema.String),
  roleNames: Schema.Array(Schema.String),
  permissions: Schema.Array(Permission),
}) {}

export class CurrentUser extends Schema.Class<CurrentUser>('CurrentUser')({
  id: UserId,
  discordId: Schema.String,
  username: Schema.String,
  avatar: Schema.OptionFromNullOr(Schema.String),
  isProfileComplete: Schema.Boolean,
  name: Schema.OptionFromNullOr(Schema.String),
  birthDate: Schema.OptionFromNullOr(Schema.String),
  gender: Schema.OptionFromNullOr(Gender),
  locale: Locale,
  isGlobalAdmin: Schema.Boolean,
}) {}

export const UpdateLocaleRequest = Schema.Struct({
  locale: Locale,
});
export type UpdateLocaleRequest = Schema.Schema.Type<typeof UpdateLocaleRequest>;

export const CreateTeamRequest = Schema.Struct({
  name: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(100)),
  ),
  guildId: Snowflake,
});
export type CreateTeamRequest = Schema.Schema.Type<typeof CreateTeamRequest>;

export class DiscordGuild extends Schema.Class<DiscordGuild>('DiscordGuild')({
  id: Snowflake,
  name: Schema.String,
  icon: Schema.OptionFromNullOr(Schema.String),
  owner: Schema.Boolean,
  botPresent: Schema.Boolean,
}) {}

export const CompleteProfileRequest = Schema.Struct({
  name: Schema.String,
  birthDate: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((s) => {
        const d = new Date(s);
        if (Number.isNaN(d.getTime())) return 'Invalid date';
        if (d < new Date('1900-01-01')) return 'Date must be after 1900-01-01';
        const minDate = new Date();
        minDate.setFullYear(minDate.getFullYear() - MIN_AGE);
        if (d > minDate) return `Must be at least ${MIN_AGE} years old`;
        return true;
      }),
    ),
  ),
  gender: Gender,
});
export type CompleteProfileRequest = Schema.Schema.Type<typeof CompleteProfileRequest>;

export const UpdateProfileRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(Schema.String),
  birthDate: Schema.OptionFromNullOr(
    Schema.String.pipe(
      Schema.check(
        Schema.makeFilter<string>((s) => {
          const d = new Date(s);
          if (Number.isNaN(d.getTime())) return 'Invalid date';
          if (d < new Date('1900-01-01')) return 'Date must be after 1900-01-01';
          const minDate = new Date();
          minDate.setFullYear(minDate.getFullYear() - MIN_AGE);
          if (d > minDate) return `Must be at least ${MIN_AGE} years old`;
          return true;
        }),
      ),
    ),
  ),
  gender: Schema.OptionFromNullOr(Gender),
});
export type UpdateProfileRequest = Schema.Schema.Type<typeof UpdateProfileRequest>;

export class Unauthorized extends Schema.TaggedErrorClass<Unauthorized>()('Unauthorized', {}) {}

export class CurrentUserContext extends ServiceMap.Service<CurrentUserContext, CurrentUser>()(
  'CurrentUserContext',
) {}

export class AuthMiddleware extends HttpApiMiddleware.Service<
  AuthMiddleware,
  { provides: CurrentUserContext }
>()('AuthMiddleware', {
  error: Unauthorized.pipe(HttpApiSchema.status(401)),
  security: { token: HttpApiSecurity.bearer },
}) {}

export class AuthApiGroup extends HttpApiGroup.make('auth')
  .add(
    HttpApiEndpoint.get('getLogin', '/login/url', {
      success: Schema.URLFromString,
    }),
  )
  .add(
    HttpApiEndpoint.get('doLogin', '/login', {
      success: Schema.Void.pipe(HttpApiSchema.status(302)),
    }),
  )
  .add(
    HttpApiEndpoint.get('callback', '/callback', {
      success: Schema.Void.pipe(HttpApiSchema.status(302)),
      query: {
        code: Schema.OptionFromOptional(Schema.String),
        state: Schema.OptionFromOptional(Schema.String),
        error: Schema.OptionFromOptional(Schema.String),
      },
    }),
  )
  .add(
    HttpApiEndpoint.get('me', '/me', {
      success: CurrentUser,
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('completeProfile', '/profile', {
      success: CurrentUser,
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
      payload: CompleteProfileRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateLocale', '/me/locale', {
      success: CurrentUser,
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
      payload: UpdateLocaleRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateProfile', '/me', {
      success: CurrentUser,
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
      payload: UpdateProfileRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('myTeams', '/me/teams', {
      success: Schema.Array(UserTeam),
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('myGuilds', '/me/guilds', {
      success: Schema.Array(DiscordGuild),
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createTeam', '/me/teams', {
      success: UserTeam,
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
      payload: CreateTeamRequest,
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('autoJoinTeams', '/me/teams/auto-join', {
      success: Schema.Array(UserTeam),
      error: Unauthorized.pipe(HttpApiSchema.status(401)),
    }).middleware(AuthMiddleware),
  )
  .prefix('/auth') {}
