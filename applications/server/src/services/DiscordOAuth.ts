import { ApiGroup, Auth } from '@sideline/domain';
import { Discord } from 'arctic';
import { Effect, Layer, Redacted, ServiceMap } from 'effect';
import { env } from '~/env.js';

const make = Effect.Do.pipe(
  Effect.let('clientId', () => env.DISCORD_CLIENT_ID),
  Effect.let('clientSecret', () => Redacted.value(env.DISCORD_CLIENT_SECRET)),
  Effect.let(
    'redirectUri',
    () => env.DISCORD_REDIRECT + Auth.AuthApiGroup.pipe(ApiGroup.getEndpoint('callback')).path,
  ),
  Effect.let(
    'client',
    ({ clientId, clientSecret, redirectUri }) =>
      new Discord(clientId, clientSecret, redirectUri.toString()),
  ),
  Effect.map(
    ({ client }) =>
      ({
        createAuthorizationURL: (state: string) =>
          Effect.sync(() =>
            client.createAuthorizationURL(state, null, ['identify', 'guilds', 'guilds.join']),
          ),
        validateAuthorizationCode: (code: string) =>
          Effect.tryPromise({
            try: () => client.validateAuthorizationCode(code, null),
            catch: (error) => new DiscordOAuthError({ cause: error }),
          }),
      }) as const,
  ),
);

export class DiscordOAuth extends ServiceMap.Service<DiscordOAuth, Effect.Success<typeof make>>()(
  'api/DiscordOAuth',
) {
  static readonly Default = Layer.effect(DiscordOAuth, make);
}

export class DiscordOAuthError {
  readonly _tag = 'DiscordOAuthError';
  constructor(readonly options: { readonly cause: unknown }) {}
}
