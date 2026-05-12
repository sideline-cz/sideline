import { AgeThresholdApi, Auth, type GroupModel, type Team, type User } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';

const forbidden = new AgeThresholdApi.Forbidden();

const requireNonEmptyCriteria = (
  minAge: Option.Option<number>,
  maxAge: Option.Option<number>,
  gender: Option.Option<User.Gender>,
  requiredGroupId: Option.Option<GroupModel.GroupId>,
) =>
  Option.isNone(minAge) &&
  Option.isNone(maxAge) &&
  Option.isNone(gender) &&
  Option.isNone(requiredGroupId)
    ? Effect.fail(new AgeThresholdApi.AgeThresholdEmptyCriteria())
    : Effect.void;

const requireDistinctRequiredGroup = (
  targetGroupId: GroupModel.GroupId,
  requiredGroupId: Option.Option<GroupModel.GroupId>,
) =>
  Option.exists(requiredGroupId, (g) => g === targetGroupId)
    ? Effect.fail(new AgeThresholdApi.AgeThresholdSelfRequired())
    : Effect.void;

const validateRequiredGroup = (
  teamId: Team.TeamId,
  requiredGroupId: Option.Option<GroupModel.GroupId>,
  groups: ServiceMap.Service.Shape<typeof GroupsRepository>,
) =>
  Option.match(requiredGroupId, {
    onNone: () => Effect.void,
    onSome: (gid) =>
      groups.findGroupById(gid).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new AgeThresholdApi.GroupNotFound()),
            onSome: (group) =>
              group.team_id !== teamId
                ? Effect.fail(new AgeThresholdApi.GroupNotFound())
                : Effect.void,
          }),
        ),
      ),
  });

export const AgeThresholdApiLive = HttpApiBuilder.group(Api, 'ageThreshold', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('thresholds', () => AgeThresholdRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('ageCheck', () => AgeCheckService.asEffect()),
    Effect.map(({ members, thresholds, groups, ageCheck }) =>
      handlers
        .handle('listAgeThresholds', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'group:manage', forbidden),
            ),
            Effect.bind('rules', () => thresholds.findRulesByTeamId(teamId)),
            Effect.map(({ rules }) =>
              Array.map(
                rules,
                (r) =>
                  new AgeThresholdApi.AgeThresholdInfo({
                    ruleId: r.id,
                    teamId: r.team_id,
                    groupId: r.group_id,
                    groupName: r.group_name,
                    minAge: r.min_age,
                    maxAge: r.max_age,
                    gender: r.gender,
                    requiredGroupId: r.required_group_id,
                  }),
              ),
            ),
          ),
        )
        .handle('createAgeThreshold', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'group:manage', forbidden),
            ),
            Effect.tap(() =>
              requireNonEmptyCriteria(
                payload.minAge,
                payload.maxAge,
                payload.gender,
                payload.requiredGroupId,
              ),
            ),
            Effect.tap(() =>
              requireDistinctRequiredGroup(payload.groupId, payload.requiredGroupId),
            ),
            Effect.tap(() => validateRequiredGroup(teamId, payload.requiredGroupId, groups)),
            Effect.bind('group', () =>
              groups.findGroupById(payload.groupId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new AgeThresholdApi.GroupNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ group }) =>
              group.team_id !== teamId
                ? Effect.fail(new AgeThresholdApi.GroupNotFound())
                : Effect.void,
            ),
            Effect.bind('rule', () =>
              thresholds.insertRule(
                teamId,
                payload.groupId,
                payload.minAge,
                payload.maxAge,
                payload.gender,
                payload.requiredGroupId,
              ),
            ),
            Effect.map(
              ({ rule }) =>
                new AgeThresholdApi.AgeThresholdInfo({
                  ruleId: rule.id,
                  teamId: rule.team_id,
                  groupId: rule.group_id,
                  groupName: rule.group_name,
                  minAge: rule.min_age,
                  maxAge: rule.max_age,
                  gender: rule.gender,
                  requiredGroupId: rule.required_group_id,
                }),
            ),
            Effect.catchTag('AgeThresholdAlreadyExistsError', () =>
              Effect.fail(new AgeThresholdApi.AgeThresholdAlreadyExists()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating age threshold — no row returned'),
            ),
          ),
        )
        .handle('updateAgeThreshold', ({ params: { teamId, ruleId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'group:manage', forbidden),
            ),
            Effect.tap(() =>
              requireNonEmptyCriteria(
                payload.minAge,
                payload.maxAge,
                payload.gender,
                payload.requiredGroupId,
              ),
            ),
            Effect.bind('existing', () =>
              thresholds.findRuleById(ruleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new AgeThresholdApi.RuleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId
                ? Effect.fail(new AgeThresholdApi.RuleNotFound())
                : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              requireDistinctRequiredGroup(existing.group_id, payload.requiredGroupId),
            ),
            Effect.tap(() => validateRequiredGroup(teamId, payload.requiredGroupId, groups)),
            Effect.bind('updated', () =>
              thresholds.updateRuleById(
                ruleId,
                payload.minAge,
                payload.maxAge,
                payload.gender,
                payload.requiredGroupId,
              ),
            ),
            Effect.map(
              ({ updated }) =>
                new AgeThresholdApi.AgeThresholdInfo({
                  ruleId: updated.id,
                  teamId: updated.team_id,
                  groupId: updated.group_id,
                  groupName: updated.group_name,
                  minAge: updated.min_age,
                  maxAge: updated.max_age,
                  gender: updated.gender,
                  requiredGroupId: updated.required_group_id,
                }),
            ),
            Effect.catchTag('AgeThresholdAlreadyExistsError', () =>
              Effect.fail(new AgeThresholdApi.AgeThresholdAlreadyExists()),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed updating age threshold — no row returned'),
            ),
          ),
        )
        .handle('deleteAgeThreshold', ({ params: { teamId, ruleId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'group:manage', forbidden),
            ),
            Effect.bind('existing', () =>
              thresholds.findRuleById(ruleId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new AgeThresholdApi.RuleNotFound()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId
                ? Effect.fail(new AgeThresholdApi.RuleNotFound())
                : Effect.void,
            ),
            Effect.tap(() => thresholds.deleteRuleById(ruleId)),
            Effect.asVoid,
          ),
        )
        .handle('evaluateAgeThresholds', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'group:manage', forbidden),
            ),
            Effect.bind('changes', () => ageCheck.evaluate(teamId, new Date())),
            Effect.map(({ changes }) => changes),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Age threshold evaluation — unexpected missing element'),
            ),
          ),
        ),
    ),
  ),
);
