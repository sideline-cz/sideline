import { Auth } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Redacted, type ServiceMap } from 'effect';
import { globalAdminDiscordIds } from '~/env.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

export const AuthMiddlewareLive = Layer.effect(
  Auth.AuthMiddleware,
  Effect.Do.pipe(
    Effect.bind('sessions', () => SessionsRepository.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.map(({ sessions, users }) => {
      type Sessions = ServiceMap.Service.Shape<typeof SessionsRepository>;
      type Users = ServiceMap.Service.Shape<typeof UsersRepository>;

      const resolveUser = (s: Sessions, u: Users, tokenValue: string) =>
        s.findByToken(tokenValue).pipe(
          Effect.mapError(() => new Auth.Unauthorized()),
          Effect.flatMap((sessionOpt) => {
            if (Option.isNone(sessionOpt)) {
              return Effect.fail(new Auth.Unauthorized());
            }
            return u.findById(sessionOpt.value.user_id).pipe(
              Effect.mapError(() => new Auth.Unauthorized()),
              Effect.flatMap((userOpt) => {
                if (Option.isNone(userOpt)) {
                  return Effect.fail(new Auth.Unauthorized());
                }
                const user = userOpt.value;
                return Effect.succeed(
                  new Auth.CurrentUser({
                    id: user.id,
                    discordId: user.discord_id,
                    username: user.username,
                    avatar: user.avatar,
                    isProfileComplete: user.is_profile_complete,
                    name: user.name,
                    birthDate: Option.map(user.birth_date, DateTime.formatIsoDateUtc),
                    gender: user.gender,
                    locale: user.locale,
                    isGlobalAdmin: globalAdminDiscordIds.has(user.discord_id),
                  }),
                );
              }),
            );
          }),
        );

      return Auth.AuthMiddleware.of({
        token: (httpEffect, { credential }) =>
          resolveUser(sessions, users, Redacted.value(credential)).pipe(
            Effect.flatMap((currentUser) =>
              Effect.provideService(httpEffect, Auth.CurrentUserContext, currentUser),
            ),
          ),
      });
    }),
  ),
);
