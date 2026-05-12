import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { AgeThresholdRuleId } from '~/models/AgeThresholdRule.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { Gender } from '~/models/User.js';

export class AgeThresholdInfo extends Schema.Class<AgeThresholdInfo>('AgeThresholdInfo')({
  ruleId: AgeThresholdRuleId,
  teamId: TeamId,
  groupId: GroupId,
  groupName: Schema.String,
  minAge: Schema.OptionFromNullOr(Schema.Number),
  maxAge: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(Gender),
  requiredGroupId: Schema.OptionFromNullOr(GroupId),
}) {}

export class AgeGroupChange extends Schema.Class<AgeGroupChange>('AgeGroupChange')({
  memberId: TeamMemberId,
  memberName: Schema.String,
  groupId: GroupId,
  groupName: Schema.String,
  action: Schema.Literals(['added', 'removed']),
}) {}

export const CreateAgeThresholdRequest = Schema.Struct({
  groupId: GroupId,
  minAge: Schema.OptionFromOptionalKey(Schema.Number),
  maxAge: Schema.OptionFromOptionalKey(Schema.Number),
  gender: Schema.OptionFromOptionalKey(Gender),
  requiredGroupId: Schema.OptionFromOptionalKey(GroupId),
});
export type CreateAgeThresholdRequest = Schema.Schema.Type<typeof CreateAgeThresholdRequest>;

export const UpdateAgeThresholdRequest = Schema.Struct({
  minAge: Schema.OptionFromOptionalKey(Schema.Number),
  maxAge: Schema.OptionFromOptionalKey(Schema.Number),
  gender: Schema.OptionFromOptionalKey(Gender),
  requiredGroupId: Schema.OptionFromOptionalKey(GroupId),
});
export type UpdateAgeThresholdRequest = Schema.Schema.Type<typeof UpdateAgeThresholdRequest>;

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('AgeThresholdForbidden', {}) {}

export class RuleNotFound extends Schema.TaggedErrorClass<RuleNotFound>()(
  'AgeThresholdRuleNotFound',
  {},
) {}

export class GroupNotFound extends Schema.TaggedErrorClass<GroupNotFound>()(
  'AgeThresholdGroupNotFound',
  {},
) {}

export class AgeThresholdAlreadyExists extends Schema.TaggedErrorClass<AgeThresholdAlreadyExists>()(
  'AgeThresholdAlreadyExists',
  {},
) {}

export class AgeThresholdEmptyCriteria extends Schema.TaggedErrorClass<AgeThresholdEmptyCriteria>()(
  'AgeThresholdEmptyCriteria',
  {},
) {}

export class AgeThresholdSelfRequired extends Schema.TaggedErrorClass<AgeThresholdSelfRequired>()(
  'AgeThresholdSelfRequired',
  {},
) {}

export class AgeThresholdApiGroup extends HttpApiGroup.make('ageThreshold')
  .add(
    HttpApiEndpoint.get('listAgeThresholds', '/teams/:teamId/age-thresholds', {
      success: Schema.Array(AgeThresholdInfo),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createAgeThreshold', '/teams/:teamId/age-thresholds', {
      success: AgeThresholdInfo.pipe(HttpApiSchema.status(201)),
      error: [
        AgeThresholdEmptyCriteria.pipe(HttpApiSchema.status(400)),
        AgeThresholdSelfRequired.pipe(HttpApiSchema.status(400)),
        Forbidden.pipe(HttpApiSchema.status(403)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
        AgeThresholdAlreadyExists.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateAgeThresholdRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateAgeThreshold', '/teams/:teamId/age-thresholds/:ruleId', {
      success: AgeThresholdInfo,
      error: [
        AgeThresholdEmptyCriteria.pipe(HttpApiSchema.status(400)),
        AgeThresholdSelfRequired.pipe(HttpApiSchema.status(400)),
        Forbidden.pipe(HttpApiSchema.status(403)),
        RuleNotFound.pipe(HttpApiSchema.status(404)),
        GroupNotFound.pipe(HttpApiSchema.status(404)),
        AgeThresholdAlreadyExists.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateAgeThresholdRequest,
      params: { teamId: TeamId, ruleId: AgeThresholdRuleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteAgeThreshold', '/teams/:teamId/age-thresholds/:ruleId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RuleNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, ruleId: AgeThresholdRuleId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('evaluateAgeThresholds', '/teams/:teamId/age-thresholds/evaluate', {
      success: Schema.Array(AgeGroupChange),
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
