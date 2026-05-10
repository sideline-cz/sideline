import { Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { OnboardingRoleCache } from '~/services/OnboardingRoleCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

export const handleGuildMemberUpdate = (member: {
  guild_id: string;
  user: { id: string };
  roles: ReadonlyArray<string>;
  pending?: boolean;
}): Effect.Effect<void, never, SyncRpc | DiscordREST | OnboardingRoleCache> => {
  if (member.pending !== false) {
    return Effect.void;
  }

  return Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('cache', () => OnboardingRoleCache.asEffect()),
    Effect.flatMap(({ rpc, rest, cache }) =>
      cache.get(member.guild_id).pipe(
        Effect.flatMap((cached) =>
          Option.match(cached, {
            onNone: () =>
              rpc['Guild/GetOnboardingRulesRoleId']({
                guild_id: decodeSnowflake(member.guild_id),
              }).pipe(
                Effect.tap((roleId) => cache.set(member.guild_id, roleId)),
                Effect.catchTag('RpcClientError', (e) => {
                  return Effect.logWarning('Failed to get onboarding rules role id', e).pipe(
                    Effect.as(Option.none<string>()),
                  );
                }),
              ),
            onSome: (cachedValue) => Effect.succeed(cachedValue),
          }),
        ),
        Effect.flatMap((roleIdOpt) =>
          Option.match(roleIdOpt, {
            onNone: () => Effect.void,
            onSome: (roleId) => {
              if (member.roles.includes(roleId)) {
                return Effect.void;
              }
              return rest.addGuildMemberRole(member.guild_id, member.user.id, roleId).pipe(
                Effect.catchTags({
                  RatelimitedResponse: (e) =>
                    Effect.logWarning('Rate-limited adding onboarding role', e),
                  HttpClientError: (e) => Effect.logWarning('HTTP error adding onboarding role', e),
                  ErrorResponse: (e) =>
                    Effect.logWarning('Discord error adding onboarding role', e),
                }),
                Effect.asVoid,
              );
            },
          }),
        ),
      ),
    ),
  );
};
