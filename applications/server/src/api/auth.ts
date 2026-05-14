import {
  ApiGroup,
  Auth,
  Discord,
  OAuthConnection,
  Role,
  type Team,
  type User,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import type { OAuth2Tokens } from 'arctic';
import { DiscordConfig, DiscordREST, DiscordRESTLive, MemoryRateLimitStoreLive } from 'dfx';
import {
  Array,
  DateTime,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
  Redacted,
  Schema,
  type ServiceMap,
  Struct,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { Redirect } from '~/api/index.js';
import { env, globalAdminDiscordIds } from '~/env.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';

class AuthError extends Schema.TaggedErrorClass<AuthError>()('AuthError', {
  error: Schema.Literal('auth_failed'),
  reason: Schema.String,
}) {
  static withReason = (reason: string) => new AuthError({ error: 'auth_failed', reason });

  static failCause = (cause: unknown) =>
    Effect.logError('[auth/callback] unexpected error during OAuth flow', cause).pipe(
      Effect.flatMap(() => Effect.fail(this.withReason('oauth_failed'))),
    );
}

const CustomClient = HttpClient.HttpClient.asEffect().pipe(
  Effect.bindTo('client'),
  Effect.bind('config', () => DiscordConfig.DiscordConfig.asEffect()),
  Effect.map(({ client, config }) =>
    client.pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(config.token)),
      HttpClient.tapRequest(Effect.logDebug),
    ),
  ),
  Layer.effect(HttpClient.HttpClient),
);

const LoginSchema = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.String.pipe(Schema.check(Schema.isUUID())),
    redirectUrl: Schema.URLFromString,
    scopeRetry: Schema.OptionFromOptionalKey(Schema.Boolean),
  }),
);

type LoginState = Schema.Schema.Type<typeof LoginSchema>;

const buildScopeRetryRedirect = (
  state: LoginState,
  discord: ServiceMap.Service.Shape<typeof DiscordOAuth>,
) =>
  Effect.sync(() => crypto.randomUUID()).pipe(
    Effect.bindTo('id'),
    Effect.let('redirectUrl', () => state.redirectUrl),
    Effect.let('scopeRetry', () => Option.some(true)),
    Effect.flatMap(Schema.encodeEffect(LoginSchema)),
    Effect.flatMap(discord.createAuthorizationURL),
    Effect.map(Redirect.fromUrl),
    Effect.map(Redirect.toResponse),
    Effect.catchTag('SchemaError', AuthError.failCause),
  );

const completeDiscordLogin = ({
  oauth,
  grantedScopes,
  state,
  users,
  sessions,
  oauthConnections,
  pendingGuildJoins,
}: {
  oauth: OAuth2Tokens;
  grantedScopes: string;
  state: LoginState;
  users: ServiceMap.Service.Shape<typeof UsersRepository>;
  sessions: ServiceMap.Service.Shape<typeof SessionsRepository>;
  oauthConnections: ServiceMap.Service.Shape<typeof OAuthConnectionsRepository>;
  pendingGuildJoins: ServiceMap.Service.Shape<typeof PendingGuildJoinsRepository>;
}) =>
  Effect.Do.pipe(
    Effect.let('DiscordConfigLive', () =>
      DiscordConfig.layer({
        token: Redacted.make(oauth.accessToken()),
      }),
    ),
    Effect.bind('client', ({ DiscordConfigLive }) =>
      DiscordREST.asEffect().pipe(
        Effect.provide(
          DiscordRESTLive.pipe(
            Layer.provideMerge(CustomClient),
            Layer.provideMerge(MemoryRateLimitStoreLive),
            Layer.provideMerge(DiscordConfigLive),
          ),
        ),
      ),
    ),
    Effect.tap(() =>
      Effect.logInfo('[auth/callback] Discord REST client ready, calling getMyUser()'),
    ),
    Effect.bind('discordUser', ({ client }) => client.getMyUser()),
    Effect.tap(({ discordUser }) =>
      Effect.logInfo('[auth/callback] getMyUser() succeeded', {
        discordId: discordUser.id,
        username: discordUser.username,
      }),
    ),
    Effect.let('sessionToken', () => crypto.randomUUID()),
    Effect.bind('now', () => DateTime.now),
    Effect.let('expiresAt', ({ now }) => DateTime.add(now, { days: 30 })),
    Effect.bind('dbUser', ({ discordUser }) =>
      users.upsertFromDiscord({
        discord_id: discordUser.id,
        username: discordUser.username,
        avatar: Option.fromNullishOr(discordUser.avatar),
        discord_nickname: Option.none(),
        discord_display_name: Option.fromNullishOr(discordUser.global_name),
      }),
    ),
    Effect.tap(({ dbUser }) =>
      Effect.logInfo('[auth/callback] user upserted in db', { userId: dbUser.id }),
    ),
    Effect.bind('previousScopes', ({ dbUser }) =>
      oauthConnections.getGrantedScopes(dbUser.id, 'discord'),
    ),
    Effect.tap(({ dbUser }) =>
      oauthConnections.upsert(
        dbUser.id,
        'discord',
        oauth.accessToken(),
        Option.fromNullishOr(oauth.refreshToken()),
        grantedScopes,
      ),
    ),
    Effect.tap(({ dbUser, previousScopes }) => {
      const hadScopeBefore = Option.match(previousScopes, {
        onNone: () => false,
        onSome: (raw) => OAuthConnection.hasScope(raw, OAuthConnection.REQUIRED_DISCORD_SCOPE),
      });
      const hasScopeNow = OAuthConnection.hasScope(
        grantedScopes,
        OAuthConnection.REQUIRED_DISCORD_SCOPE,
      );
      return hasScopeNow && !hadScopeBefore
        ? pendingGuildJoins
            .requeueFailedForUser(dbUser.id)
            .pipe(
              Effect.tap(() =>
                Effect.logInfo(
                  '[auth/callback] guilds.join scope newly granted — requeued failed pending_guild_joins',
                  { userId: dbUser.id },
                ),
              ),
            )
        : Effect.void;
    }),
    Effect.bind('session', ({ dbUser, sessionToken, expiresAt }) =>
      // biome-ignore lint/suspicious/noExplicitAny: TypeScript can't resolve Session.insert.Type in this chain depth
      sessions.create({
        user_id: dbUser.id,
        token: sessionToken,
        expires_at: expiresAt as any,
        created_at: undefined,
      }),
    ),
    Effect.tap(() => Effect.logInfo('[auth/callback] session created, redirecting')),
    Effect.map(({ sessionToken }) =>
      pipe(
        Redirect.fromUrl(state.redirectUrl),
        Redirect.withSearchParam('token', sessionToken),
        Redirect.toResponse,
      ),
    ),
    Effect.catchTag('ErrorResponse', (e) =>
      Effect.logError('[auth/callback] Discord API returned ErrorResponse in getMyUser()', e).pipe(
        Effect.flatMap(() => Effect.fail(AuthError.withReason('profile_failed'))),
      ),
    ),
    Effect.catchTag('RatelimitedResponse', (e) =>
      Effect.logError('[auth/callback] Discord API rate-limited us', e).pipe(
        Effect.flatMap(() => Effect.fail(AuthError.withReason('rate_limited'))),
      ),
    ),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'OAuth token exchange — failed to create user session'),
    ),
  );

const handleDiscordLogin = ({
  code,
  state,
  discord,
  users,
  sessions,
  oauthConnections,
  pendingGuildJoins,
}: {
  code: string;
  state: LoginState;
  discord: ServiceMap.Service.Shape<typeof DiscordOAuth>;
  users: ServiceMap.Service.Shape<typeof UsersRepository>;
  sessions: ServiceMap.Service.Shape<typeof SessionsRepository>;
  oauthConnections: ServiceMap.Service.Shape<typeof OAuthConnectionsRepository>;
  pendingGuildJoins: ServiceMap.Service.Shape<typeof PendingGuildJoinsRepository>;
}) =>
  discord.validateAuthorizationCode(code).pipe(
    Effect.tap(() =>
      Effect.logInfo(
        '[auth/callback] oauth token exchange succeeded, building Discord REST client',
      ),
    ),
    Effect.flatMap((oauth) => {
      const grantedScopes = oauth.hasScopes() ? oauth.scopes().join(' ') : '';
      const hasRequiredScope = OAuthConnection.hasScope(
        grantedScopes,
        OAuthConnection.REQUIRED_DISCORD_SCOPE,
      );
      const alreadyRetried = Option.getOrElse(state.scopeRetry, () => false);
      if (!hasRequiredScope && !alreadyRetried) {
        return Effect.logInfo('[auth/callback] missing required scope — redirecting for re-auth', {
          grantedScopes,
        }).pipe(Effect.flatMap(() => buildScopeRetryRedirect(state, discord)));
      }
      return completeDiscordLogin({
        oauth,
        grantedScopes,
        state,
        users,
        sessions,
        oauthConnections,
        pendingGuildJoins,
      });
    }),
    Effect.catchTag(['HttpClientError', 'DiscordOAuthError'], AuthError.failCause),
  );

const emptyTeams: ReadonlyArray<Auth.UserTeam> = [];

const MANAGE_GUILD = 0x20n;
const ADMINISTRATOR = 0x8n;

const makeUserDiscordClient = (accessToken: string) =>
  DiscordREST.asEffect().pipe(
    Effect.provide(
      DiscordRESTLive.pipe(
        Layer.provideMerge(CustomClient),
        Layer.provideMerge(MemoryRateLimitStoreLive),
        Layer.provideMerge(
          DiscordConfig.layer({
            token: Redacted.make(accessToken),
          }),
        ),
      ),
    ),
  );

export const AuthApiLive = HttpApiBuilder.group(Api, 'auth', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('discord', () => DiscordOAuth.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('sessions', () => SessionsRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('botGuilds', () => BotGuildsRepository.asEffect()),
    Effect.bind('oauthConnections', () => OAuthConnectionsRepository.asEffect()),
    Effect.bind('pendingGuildJoins', () => PendingGuildJoinsRepository.asEffect()),
    Effect.map(
      ({
        discord,
        users,
        sessions,
        members,
        teams,
        roles,
        botGuilds,
        oauthConnections,
        pendingGuildJoins,
      }) =>
        handlers
          .handle('getLogin', () =>
            Effect.succeed(
              new URL(
                env.SERVER_URL + Auth.AuthApiGroup.pipe(ApiGroup.getEndpoint('doLogin')).path,
              ),
            ),
          )
          .handle('doLogin', () =>
            Effect.sync(() => crypto.randomUUID()).pipe(
              Effect.bindTo('id'),
              Effect.let('redirectUrl', () => env.FRONTEND_URL),
              Effect.let('scopeRetry', () => Option.none<boolean>()),
              Effect.flatMap(Schema.encodeEffect(LoginSchema)),
              Effect.flatMap(discord.createAuthorizationURL),
              Effect.map(Redirect.fromUrl),
              Effect.map(Redirect.toResponse),
              Effect.catchTag('SchemaError', AuthError.failCause),
              Effect.catchTag('AuthError', (e) =>
                pipe(
                  Redirect.fromUrl(env.FRONTEND_URL),
                  Redirect.withSearchParam('error', e.error),
                  Redirect.withSearchParam('reason', e.reason),
                  Redirect.toResponse,
                  Effect.succeed,
                ),
              ),
            ),
          )
          .handle('callback', ({ query: { code, state, error } }) =>
            Effect.Do.pipe(
              Effect.tap(() =>
                Effect.logInfo('[auth/callback] received callback', {
                  hasCode: Option.isSome(code),
                  hasState: Option.isSome(state),
                  hasError: Option.isSome(error),
                }),
              ),
              Effect.bind('code', () => Effect.fromOption(code)),
              Effect.bind('stateRaw', () => Effect.fromOption(state)),
              Effect.catchTag('NoSuchElementError', () =>
                Effect.fail(AuthError.withReason(Option.getOrElse(error, () => 'missing_params'))),
              ),
              Effect.bind('state', ({ stateRaw }) => Schema.decodeEffect(LoginSchema)(stateRaw)),
              Effect.tap(({ state }) =>
                Effect.logInfo('[auth/callback] state decoded', {
                  redirectUrl: state.redirectUrl.toString(),
                  frontendUrl: env.FRONTEND_URL.toString(),
                }),
              ),
              Effect.andThen(({ state, code }) =>
                handleDiscordLogin({
                  code,
                  state,
                  discord,
                  users,
                  sessions,
                  oauthConnections,
                  pendingGuildJoins,
                }),
              ),
              Effect.catchTag('SchemaError', AuthError.failCause),
              Effect.catchTag('AuthError', (e) =>
                pipe(
                  Redirect.fromUrl(env.FRONTEND_URL),
                  Redirect.withSearchParam('error', e.error),
                  Redirect.withSearchParam('reason', e.reason),
                  Redirect.toResponse,
                  Effect.succeed,
                ),
              ),
            ),
          )
          .handle('me', () => Auth.CurrentUserContext.asEffect())
          .handle('updateLocale', ({ payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('updated', ({ currentUser }) =>
                users.updateLocale({
                  id: currentUser.id,
                  locale: payload.locale,
                }),
              ),

              Effect.map(
                ({ updated }) =>
                  new Auth.CurrentUser({
                    id: updated.id,
                    discordId: updated.discord_id,
                    username: updated.username,
                    avatar: updated.avatar,
                    isProfileComplete: updated.is_profile_complete,
                    name: updated.name,
                    birthDate: Option.map(updated.birth_date, DateTime.formatIsoDateUtc),
                    gender: updated.gender,
                    locale: updated.locale,
                    isGlobalAdmin: globalAdminDiscordIds.has(updated.discord_id),
                  }),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed updating locale — no row returned'),
              ),
            ),
          )
          .handle('updateProfile', ({ payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('updated', ({ currentUser }) =>
                users.updateAdminProfile({
                  id: currentUser.id,
                  name: payload.name,
                  birth_date: Option.map(payload.birthDate, DateTime.makeUnsafe),
                  gender: payload.gender,
                }),
              ),

              Effect.map(
                ({ updated }) =>
                  new Auth.CurrentUser({
                    id: updated.id,
                    discordId: updated.discord_id,
                    username: updated.username,
                    avatar: updated.avatar,
                    isProfileComplete: updated.is_profile_complete,
                    name: updated.name,
                    birthDate: Option.map(updated.birth_date, DateTime.formatIsoDateUtc),
                    gender: updated.gender,
                    locale: updated.locale,
                    isGlobalAdmin: globalAdminDiscordIds.has(updated.discord_id),
                  }),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed updating admin profile — no row returned'),
              ),
            ),
          )
          .handle('completeProfile', ({ payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('updated', ({ currentUser }) =>
                users.completeProfile({
                  id: currentUser.id,
                  name: Option.some(payload.name),
                  birth_date: Option.some(DateTime.makeUnsafe(payload.birthDate)),
                  gender: Option.some(payload.gender),
                }),
              ),

              Effect.map(
                ({ updated }) =>
                  new Auth.CurrentUser({
                    id: updated.id,
                    discordId: updated.discord_id,
                    username: updated.username,
                    avatar: updated.avatar,
                    isProfileComplete: updated.is_profile_complete,
                    name: updated.name,
                    birthDate: Option.map(updated.birth_date, DateTime.formatIsoDateUtc),
                    gender: updated.gender,
                    locale: updated.locale,
                    isGlobalAdmin: globalAdminDiscordIds.has(updated.discord_id),
                  }),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed completing user profile — no row returned'),
              ),
            ),
          )
          .handle('myTeams', () =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('memberships', ({ currentUser }) => members.findByUser(currentUser.id)),
              Effect.flatMap(
                flow(
                  Struct.get('memberships'),
                  Array.map((m) =>
                    teams.findById(m.team_id).pipe(
                      Effect.flatMap(
                        Option.match({
                          onNone: () => Effect.fail(new Auth.Unauthorized()),
                          onSome: Effect.succeed,
                        }),
                      ),
                      Effect.map(
                        (team) =>
                          new Auth.UserTeam({
                            teamId: team.id,
                            teamName: team.name,
                            logoUrl: team.logo_url,
                            roleNames: m.role_names,
                            permissions: m.permissions,
                          }),
                      ),
                    ),
                  ),
                  (all) => Effect.all(all, { concurrency: 'unbounded' }),
                ),
              ),
            ),
          )
          .handle('myGuilds', () =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('accessToken', ({ currentUser }) =>
                oauthConnections.getAccessToken(currentUser.id, 'discord').pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new Auth.Unauthorized()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('client', ({ accessToken }) => makeUserDiscordClient(accessToken)),
              Effect.bind('guilds', ({ client }) => client.listMyGuilds()),
              Effect.flatMap(({ guilds }) =>
                Effect.all(
                  pipe(
                    guilds,
                    Array.filter((g) => {
                      const perms = BigInt(g.permissions);
                      return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
                    }),
                    Array.map((g) =>
                      botGuilds.exists(Schema.decodeSync(Discord.Snowflake)(g.id)).pipe(
                        Effect.map(
                          (present) =>
                            new Auth.DiscordGuild({
                              id: Schema.decodeSync(Discord.Snowflake)(g.id),
                              name: g.name,
                              icon: Option.fromNullishOr(g.icon),
                              owner: g.owner,
                              botPresent: present,
                            }),
                        ),
                      ),
                    ),
                  ),
                  { concurrency: 'unbounded' },
                ),
              ),
              Effect.catchTag('HttpClientError', () => Effect.fail(new Auth.Unauthorized())),
              Effect.catchTag('ErrorResponse', () => Effect.fail(new Auth.Unauthorized())),
              Effect.catchTag('RatelimitedResponse', () => Effect.fail(new Auth.Unauthorized())),
            ),
          )
          .handle('createTeam', ({ payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('team', ({ currentUser }) =>
                teams.insert({
                  name: payload.name,
                  guild_id: payload.guildId,
                  description: Option.none(),
                  sport: Option.none(),
                  logo_url: Option.none(),
                  created_by: currentUser.id,
                  created_at: undefined,
                  updated_at: undefined,
                  welcome_channel_id: Option.none(),
                  system_log_channel_id: Option.none(),
                  welcome_message_template: Option.none(),
                  rules_channel_id: Option.none(),
                  overview_channel_id: Option.none(),
                  onboarding_rules_role_id: Option.none(),
                  onboarding_rules_prompt_id: Option.none(),
                  onboarding_locale: 'en',
                  onboarding_synced_at: Option.none(),
                  onboarding_sync_status: 'pending',
                  onboarding_sync_error: Option.none(),
                }),
              ),
              Effect.bind('seededRoles', ({ team }) => roles.seedTeamRolesWithPermissions(team.id)),
              Effect.bind('adminRole', ({ seededRoles }) =>
                pipe(
                  seededRoles,
                  Array.findFirst((r) => r.name === 'Admin'),
                  Option.match({
                    onNone: () => Effect.fail(new Auth.Unauthorized()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
              Effect.bind('newMember', ({ team, currentUser }) =>
                members.addMember({
                  team_id: team.id,
                  user_id: currentUser.id,
                  active: true,
                  joined_at: undefined,
                }),
              ),
              Effect.tap(({ newMember, adminRole }) =>
                members.assignRole(newMember.id, adminRole.id),
              ),
              Effect.map(
                ({ team }) =>
                  new Auth.UserTeam({
                    teamId: team.id,
                    teamName: team.name,
                    logoUrl: team.logo_url,
                    roleNames: ['Admin'],
                    permissions: [...Role.defaultPermissions.Admin],
                  }),
              ),
              Effect.catchTag(
                'MemberAlreadyExistsError',
                LogicError.withMessage(() => 'Unexpected duplicate member during team creation'),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed creating team — no row returned'),
              ),
            ),
          )
          .handle('autoJoinTeams', () => {
            const tryJoinTeam = (team: Team.Team, userId: User.UserId) =>
              members.findMembershipByIds(team.id, userId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      members.getPlayerRoleId(team.id).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () => Effect.succeed(Option.none<Auth.UserTeam>()),
                            onSome: (role) =>
                              Effect.Do.pipe(
                                Effect.bind('membership', () =>
                                  members.addMember({
                                    team_id: team.id,
                                    user_id: userId,
                                    active: true,
                                    joined_at: undefined,
                                  }),
                                ),
                                Effect.tap(({ membership }) =>
                                  members.assignRole(membership.id, role.id),
                                ),
                                Effect.tap(() =>
                                  Effect.logInfo('[auth/autoJoinTeams] joined team', {
                                    teamId: team.id,
                                    teamName: team.name,
                                  }),
                                ),
                                Effect.map(() =>
                                  Option.some(
                                    new Auth.UserTeam({
                                      teamId: team.id,
                                      teamName: team.name,
                                      logoUrl: team.logo_url,
                                      roleNames: ['Player'],
                                      permissions: [...Role.defaultPermissions.Player],
                                    }),
                                  ),
                                ),
                                Effect.catchTag('MemberAlreadyExistsError', () =>
                                  Effect.succeed(Option.none<Auth.UserTeam>()),
                                ),
                              ),
                          }),
                        ),
                      ),
                    onSome: () => Effect.succeed(Option.none<Auth.UserTeam>()),
                  }),
                ),
              );

            return Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.flatMap(({ currentUser }) =>
                !currentUser.isProfileComplete
                  ? Effect.succeed(emptyTeams)
                  : oauthConnections.getAccessToken(currentUser.id, 'discord').pipe(
                      Effect.flatMap(
                        Option.match({
                          onNone: () => Effect.succeed(emptyTeams),
                          onSome: (accessToken) =>
                            Effect.Do.pipe(
                              Effect.bind('client', () => makeUserDiscordClient(accessToken)),
                              Effect.bind('guilds', ({ client }) => client.listMyGuilds()),
                              Effect.let('guildIds', ({ guilds }) =>
                                Array.map(guilds, (g) =>
                                  Schema.decodeSync(Discord.Snowflake)(g.id),
                                ),
                              ),
                              Effect.flatMap(({ guildIds }) =>
                                Array.isArrayEmpty(guildIds)
                                  ? Effect.succeed(emptyTeams)
                                  : teams.findByGuildIds(guildIds).pipe(
                                      Effect.flatMap((matchingTeams) =>
                                        Effect.all(
                                          Array.map(matchingTeams, (team) =>
                                            tryJoinTeam(team, currentUser.id),
                                          ),
                                          { concurrency: 'unbounded' },
                                        ),
                                      ),
                                      Effect.map(Array.getSomes),
                                    ),
                              ),
                              Effect.catchTag(
                                ['HttpClientError', 'ErrorResponse', 'RatelimitedResponse'],
                                () => Effect.succeed(emptyTeams),
                              ),
                            ),
                        }),
                      ),
                    ),
              ),
              // NoSuchElementException can be produced by Auth.CurrentUserContext when no session exists
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(
                  () => 'Auto-join teams — unexpected missing session or current user',
                ),
              ),
            );
          }),
    ),
  ),
);
