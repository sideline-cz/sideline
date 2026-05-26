import { Auth } from '@sideline/domain';
import { Effect, Layer, Option, Redacted, type ServiceMap } from 'effect';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { toCurrentUser } from '~/utils/toCurrentUser.js';

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
                return Effect.succeed(toCurrentUser(userOpt.value));
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
