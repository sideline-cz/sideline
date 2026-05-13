import { type ActivityType, ActivityTypeApi, Auth, type Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import type { ActivityTypeRow } from '~/repositories/ActivityTypesRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new ActivityTypeApi.Forbidden();

const findOrFail = (
  activityTypes: {
    findByIdScoped: (
      id: ActivityType.ActivityTypeId,
      teamId: Team.TeamId,
    ) => Effect.Effect<Option.Option<ActivityTypeRow>>;
  },
  id: ActivityType.ActivityTypeId,
  teamId: Team.TeamId,
): Effect.Effect<ActivityTypeRow, ActivityTypeApi.ActivityTypeNotFound> =>
  activityTypes.findByIdScoped(id, teamId).pipe(
    Effect.flatMap((opt) =>
      Option.match(opt, {
        onNone: () => Effect.fail(new ActivityTypeApi.ActivityTypeNotFound()),
        onSome: (row) => Effect.succeed(row),
      }),
    ),
  );

const toInfo = (t: ActivityTypeRow, usageCount: number): ActivityTypeApi.ActivityTypeInfo =>
  new ActivityTypeApi.ActivityTypeInfo({
    id: t.id,
    teamId: t.team_id,
    name: t.name,
    slug: t.slug,
    emoji: t.emoji,
    description: t.description,
    usageCount,
  });

export const ActivityTypeApiLive = HttpApiBuilder.group(Api, 'activityType', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
    Effect.map(({ members, activityTypes }) =>
      handlers
        .handle('listActivityTypes', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('list', () => activityTypes.findByTeamId(teamId)),
            Effect.map(
              ({ list, membership }) =>
                new ActivityTypeApi.ActivityTypeListResponse({
                  canAdmin:
                    hasPermission(membership, 'activity-type:create') ||
                    hasPermission(membership, 'activity-type:delete'),
                  activityTypes: list.map((t) => toInfo(t, t.usageCount)),
                }),
            ),
          ),
        )
        .handle('createActivityType', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'activity-type:create', forbidden),
            ),
            Effect.flatMap(() => {
              const trimmedName = payload.name.trim();
              return activityTypes.findByNameInScope(trimmedName, teamId).pipe(
                Effect.flatMap((nameCheck) =>
                  Option.isSome(nameCheck)
                    ? Effect.fail(
                        new ActivityTypeApi.ActivityTypeNameAlreadyTaken({ name: trimmedName }),
                      )
                    : Effect.void,
                ),
                Effect.flatMap(() =>
                  activityTypes
                    .insertCustom({
                      team_id: teamId,
                      name: trimmedName,
                      emoji: payload.emoji,
                      description: payload.description,
                    })
                    .pipe(
                      Effect.catchTag('ActivityTypeNameAlreadyTakenError', () =>
                        Effect.fail(
                          new ActivityTypeApi.ActivityTypeNameAlreadyTaken({ name: trimmedName }),
                        ),
                      ),
                      Effect.map((created) => toInfo(created, 0)),
                    ),
                ),
              );
            }),
          ),
        )
        .handle('getActivityType', ({ params: { teamId, activityTypeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.flatMap(() =>
              activityTypes.findByIdScoped(activityTypeId, teamId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new ActivityTypeApi.ActivityTypeNotFound()),
                    onSome: (t) => Effect.succeed(toInfo(t, 0)),
                  }),
                ),
              ),
            ),
          ),
        )
        .handle('updateActivityType', ({ params: { teamId, activityTypeId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              // admins with :create can also edit
              requirePermission(membership, 'activity-type:create', forbidden),
            ),
            Effect.flatMap(() =>
              findOrFail(activityTypes, activityTypeId, teamId).pipe(
                Effect.tap((existing) =>
                  Option.isNone(existing.team_id)
                    ? Effect.fail(new ActivityTypeApi.ActivityTypeProtected())
                    : Effect.void,
                ),
                Effect.flatMap((existing) => {
                  const newName = Option.match(payload.name, {
                    onNone: () => existing.name,
                    onSome: (v) => v.trim(),
                  });
                  const newEmoji = Option.match(payload.emoji, {
                    onNone: () => existing.emoji,
                    onSome: (v) => v,
                  });
                  const newDescription = Option.match(payload.description, {
                    onNone: () => existing.description,
                    onSome: (v) => v,
                  });
                  const nameCheckEffect: Effect.Effect<
                    Option.Option<ActivityTypeRow>,
                    never,
                    never
                  > = newName !== existing.name
                    ? activityTypes.findByNameInScope(newName, teamId)
                    : Effect.succeed(Option.none<ActivityTypeRow>());
                  return nameCheckEffect.pipe(
                    Effect.flatMap((nameCheck) =>
                      Option.isSome(nameCheck) && nameCheck.value.id !== existing.id
                        ? Effect.fail(
                            new ActivityTypeApi.ActivityTypeNameAlreadyTaken({ name: newName }),
                          )
                        : Effect.void,
                    ),
                    Effect.flatMap(() =>
                      activityTypes
                        .updateCustom({
                          id: activityTypeId,
                          team_id: teamId,
                          name: newName,
                          emoji: newEmoji,
                          description: newDescription,
                        })
                        .pipe(
                          Effect.catchTag('ActivityTypeNameAlreadyTakenError', () =>
                            Effect.fail(
                              new ActivityTypeApi.ActivityTypeNameAlreadyTaken({ name: newName }),
                            ),
                          ),
                          Effect.flatMap(
                            Option.match({
                              onNone: () => Effect.fail(new ActivityTypeApi.ActivityTypeNotFound()),
                              onSome: (updated) => Effect.succeed(toInfo(updated, 0)),
                            }),
                          ),
                        ),
                    ),
                  );
                }),
              ),
            ),
          ),
        )
        .handle('deleteActivityType', ({ params: { teamId, activityTypeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'activity-type:delete', forbidden),
            ),
            Effect.flatMap(() =>
              findOrFail(activityTypes, activityTypeId, teamId).pipe(
                Effect.tap((existing) =>
                  Option.isNone(existing.team_id)
                    ? Effect.fail(new ActivityTypeApi.ActivityTypeProtected())
                    : Effect.void,
                ),
                Effect.flatMap(() =>
                  activityTypes.countLogsForType(activityTypeId, teamId).pipe(
                    Effect.flatMap((logCount) =>
                      logCount > 0
                        ? Effect.fail(
                            new ActivityTypeApi.ActivityTypeHasLogs({ usageCount: logCount }),
                          )
                        : Effect.void,
                    ),
                    Effect.flatMap(() => activityTypes.deleteCustom(activityTypeId, teamId)),
                    Effect.asVoid,
                  ),
                ),
              ),
            ),
          ),
        ),
    ),
  ),
);
