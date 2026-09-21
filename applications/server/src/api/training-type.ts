import { Auth, type Team, type TrainingType, TrainingTypeApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';

type TrainingTypeRowLike = {
  readonly id: TrainingType.TrainingTypeId;
  readonly team_id: Team.TeamId;
  readonly name: string;
};

/**
 * Pure row -> DTO map for `TrainingTypeApi.TrainingTypeInfo`. `ownerGroupName`
 * and `memberGroupName` vary across call sites (the list/read path resolves
 * the real group names, create/update pass `Option.none()`), so they are
 * explicit parameters rather than baked into the row shape.
 */
export const toTrainingTypeInfo = (
  row: TrainingTypeRowLike,
  ownerGroupName: Option.Option<string>,
  memberGroupName: Option.Option<string>,
): TrainingTypeApi.TrainingTypeInfo =>
  new TrainingTypeApi.TrainingTypeInfo({
    trainingTypeId: row.id,
    teamId: row.team_id,
    name: row.name,
    ownerGroupName,
    memberGroupName,
  });

const forbidden = new TrainingTypeApi.Forbidden();

export const TrainingTypeApiLive = HttpApiBuilder.group(Api, 'trainingType', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.map(({ members, trainingTypes }) =>
      handlers
        .handle('listTrainingTypes', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('list', () => trainingTypes.findTrainingTypesByTeamId(teamId)),
            Effect.map(
              ({ list, isAdmin }) =>
                new TrainingTypeApi.TrainingTypeListResponse({
                  canAdmin: isAdmin,
                  trainingTypes: Array.map(list, (t) =>
                    toTrainingTypeInfo(t, t.owner_group_name, t.member_group_name),
                  ),
                }),
            ),
          ),
        )
        .handle('createTrainingType', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'training-type:create', forbidden),
            ),
            Effect.bind('trainingType', () =>
              trainingTypes.insertTrainingType(
                teamId,
                payload.name,
                payload.ownerGroupId,
                payload.memberGroupId,
                payload.discordChannelId,
              ),
            ),
            Effect.map(({ trainingType }) =>
              toTrainingTypeInfo(trainingType, Option.none(), Option.none()),
            ),
            Effect.catchTag('TrainingTypeNameAlreadyTakenError', () =>
              Effect.fail(new TrainingTypeApi.TrainingTypeNameAlreadyTaken()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating training type — no row returned'),
            ),
          ),
        )
        .handle('getTrainingType', ({ params: { teamId, trainingTypeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('trainingType', () =>
              trainingTypes.findTrainingTypeByIdWithGroup(trainingTypeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TrainingTypeApi.TrainingTypeNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ trainingType }) =>
              trainingType.team_id !== teamId
                ? Effect.fail(new TrainingTypeApi.TrainingTypeNotFound())
                : Effect.void,
            ),
            Effect.map(
              ({ trainingType, isAdmin }) =>
                new TrainingTypeApi.TrainingTypeDetail({
                  trainingTypeId: trainingType.id,
                  teamId: trainingType.team_id,
                  name: trainingType.name,
                  ownerGroupId: trainingType.owner_group_id,
                  ownerGroupName: trainingType.owner_group_name,
                  memberGroupId: trainingType.member_group_id,
                  memberGroupName: trainingType.member_group_name,
                  discordChannelId: trainingType.discord_channel_id,
                  canAdmin: isAdmin,
                }),
            ),
          ),
        )
        .handle('updateTrainingType', ({ params: { teamId, trainingTypeId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('existing', () =>
              trainingTypes.findTrainingTypeById(trainingTypeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TrainingTypeApi.TrainingTypeNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId
                ? Effect.fail(new TrainingTypeApi.TrainingTypeNotFound())
                : Effect.void,
            ),
            Effect.bind('updated', ({ existing }) =>
              trainingTypes.updateTrainingType(
                trainingTypeId,
                payload.name,
                Option.match(payload.ownerGroupId, {
                  onNone: () => existing.owner_group_id,
                  onSome: (v) => v,
                }),
                Option.match(payload.memberGroupId, {
                  onNone: () => existing.member_group_id,
                  onSome: (v) => v,
                }),
                Option.match(payload.discordChannelId, {
                  onNone: () => existing.discord_channel_id,
                  onSome: (v) => v,
                }),
              ),
            ),
            Effect.map(({ updated }) => toTrainingTypeInfo(updated, Option.none(), Option.none())),
            Effect.catchTag('TrainingTypeNameAlreadyTakenError', () =>
              Effect.fail(new TrainingTypeApi.TrainingTypeNameAlreadyTaken()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed updating training type — no row returned'),
            ),
          ),
        )
        .handle('deleteTrainingType', ({ params: { teamId, trainingTypeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'training-type:delete', forbidden),
            ),
            Effect.bind('existing', () =>
              trainingTypes.findTrainingTypeById(trainingTypeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new TrainingTypeApi.TrainingTypeNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId
                ? Effect.fail(new TrainingTypeApi.TrainingTypeNotFound())
                : Effect.void,
            ),
            Effect.tap(() => trainingTypes.deleteTrainingTypeById(trainingTypeId)),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
