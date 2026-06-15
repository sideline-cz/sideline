import { Auth, Discord, DisplayName, GlobalAdminApi, type User } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { requireGlobalAdmin } from '~/utils/requireGlobalAdmin.js';

const forbidden = new GlobalAdminApi.GlobalAdminForbidden();

const pickUsername = (user: User.User): string =>
  Option.getOrElse(
    DisplayName.pickDisplayName({
      name: user.name,
      nickname: user.discord_nickname,
      displayName: user.discord_display_name,
      username: Option.some(user.username),
    }),
    () => user.username,
  );

const userToListItem = (
  user: User.User,
  source: GlobalAdminApi.GlobalAdminSource,
  revocable: boolean,
  isSelf: boolean,
): GlobalAdminApi.GlobalAdminListItem => ({
  discordId: user.discord_id,
  userId: Option.some(user.id),
  username: Option.some(pickUsername(user)),
  avatar: user.avatar,
  source,
  grantedAt: user.global_admin_granted_at,
  revocable,
  isSelf,
});

const buildAdminList = (
  dbAdmins: ReadonlyArray<User.User>,
  allowlist: ReadonlySet<string>,
  currentUser: Auth.CurrentUser,
  findByDiscordId: (id: string) => Effect.Effect<Option.Option<User.User>>,
): Effect.Effect<ReadonlyArray<GlobalAdminApi.GlobalAdminListItem>> => {
  // Build map from DB admins
  const map = new Map<string, GlobalAdminApi.GlobalAdminListItem>();

  for (const row of dbAdmins) {
    const isSelf = row.discord_id === currentUser.discordId;
    const inEnv = allowlist.has(row.discord_id);
    map.set(row.discord_id, userToListItem(row, 'db', !isSelf && !inEnv, isSelf));
  }

  // Process env IDs (env source overrides any DB row for the same discord ID)
  return Effect.forEach([...allowlist], (envDiscordId) => {
    const isSelf = envDiscordId === currentUser.discordId;
    const existing = map.get(envDiscordId);
    if (existing !== undefined) {
      map.set(envDiscordId, { ...existing, source: 'env', revocable: false, isSelf });
      return Effect.void;
    }
    return findByDiscordId(envDiscordId).pipe(
      Effect.map((maybeUser) =>
        Option.match(maybeUser, {
          onSome: (user) => map.set(envDiscordId, userToListItem(user, 'env', false, isSelf)),
          onNone: () =>
            map.set(envDiscordId, {
              discordId: Schema.decodeSync(Discord.Snowflake)(envDiscordId),
              userId: Option.none(),
              username: Option.none(),
              avatar: Option.none(),
              source: 'env',
              grantedAt: Option.none(),
              revocable: false,
              isSelf,
            }),
        }),
      ),
    );
  }).pipe(Effect.map(() => [...map.values()]));
};

export const GlobalAdminApiLive = HttpApiBuilder.group(Api, 'globalAdmin', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('allowlistService', () => GlobalAdminAllowlist.asEffect()),
    Effect.map(({ users, allowlistService }) => {
      // Refetch the DB admins + allowlist and assemble the response rows. Shared
      // by `listGlobalAdmins` and the refreshed list returned from `grantGlobalAdmin`.
      const loadAdminList = (currentUser: Auth.CurrentUser) =>
        Effect.Do.pipe(
          Effect.bind('dbAdmins', () => users.listGlobalAdmins()),
          Effect.bind('allowlist', () => allowlistService.asEffect),
          Effect.flatMap(({ dbAdmins, allowlist }) =>
            buildAdminList(dbAdmins, allowlist, currentUser, users.findByDiscordId),
          ),
        );

      return handlers
        .handle('listGlobalAdmins', () =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.flatMap(({ currentUser }) => loadAdminList(currentUser)),
          ),
        )
        .handle('grantGlobalAdmin', ({ payload }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('granted', () => users.grantGlobalAdmin(payload.discordId)),
            Effect.tap(({ granted, currentUser }) =>
              Option.isNone(granted)
                ? Effect.fail(new GlobalAdminApi.GlobalAdminUserNotFound())
                : Effect.logInfo('global_admin.granted', {
                    discordId: payload.discordId,
                    actorId: currentUser.id,
                  }),
            ),
            Effect.flatMap(({ currentUser }) => loadAdminList(currentUser)),
          ),
        )
        .handle('revokeGlobalAdmin', ({ params: { userId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requireGlobalAdmin(forbidden)),
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              currentUser.id === userId
                ? Effect.fail(new GlobalAdminApi.GlobalAdminSelfRevokeError())
                : Effect.void,
            ),
            Effect.bind('target', () =>
              users
                .findById(userId)
                .pipe(
                  Effect.flatMap((maybeUser) =>
                    Option.isNone(maybeUser)
                      ? Effect.fail(new GlobalAdminApi.GlobalAdminUserNotFound())
                      : Effect.succeed(maybeUser.value),
                  ),
                ),
            ),
            Effect.bind('allowlist', () => allowlistService.asEffect),
            Effect.tap(({ target, allowlist }) =>
              allowlist.has(target.discord_id)
                ? Effect.fail(new GlobalAdminApi.GlobalAdminEnvManaged())
                : Effect.void,
            ),
            Effect.tap(({ target }) =>
              !target.is_global_admin
                ? Effect.fail(new GlobalAdminApi.GlobalAdminUserNotFound())
                : Effect.void,
            ),
            Effect.bind('dbAdmins', () => users.listGlobalAdmins()),
            Effect.let(
              'dbAdminDiscordIds',
              ({ dbAdmins }) => new Set<string>(dbAdmins.map((u) => u.discord_id)),
            ),
            Effect.let(
              'envAdminCount',
              ({ allowlist, dbAdminDiscordIds }) =>
                [...allowlist].filter((id) => !dbAdminDiscordIds.has(id)).length,
            ),
            Effect.bind('revokeResult', ({ envAdminCount }) =>
              users.revokeGlobalAdminGuarded(userId, envAdminCount),
            ),
            Effect.flatMap(({ revokeResult, currentUser }) =>
              Option.isNone(revokeResult)
                ? Effect.fail(new GlobalAdminApi.GlobalAdminLastAdminError())
                : Effect.logInfo('global_admin.revoked', { userId, actorId: currentUser.id }),
            ),
            Effect.asVoid,
          ),
        );
    }),
  ),
);
