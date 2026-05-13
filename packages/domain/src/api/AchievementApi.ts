import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { AchievementSlug } from '~/models/Achievement.js';
import { CustomAchievementId, CustomRuleKind } from '~/models/CustomAchievement.js';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class AchievementOverview extends Schema.Class<AchievementOverview>('AchievementOverview')({
  keyOrId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  titleKey: Schema.OptionFromNullOr(Schema.String),
  descriptionKey: Schema.OptionFromNullOr(Schema.String),
  kind: Schema.Literals(['built_in', 'custom']),
  ruleKind: CustomRuleKind,
  effectiveThreshold: Schema.Int,
  defaultThreshold: Schema.OptionFromNullOr(Schema.Int),
  discordRoleId: Schema.OptionFromNullOr(Schema.String),
  isBuiltIn: Schema.Boolean,
}) {}

export class RemovedMember extends Schema.Class<RemovedMember>('RemovedMember')({
  teamMemberId: TeamMemberId,
  memberName: Schema.String,
}) {}

export class PreviewResponse extends Schema.Class<PreviewResponse>('PreviewResponse')({
  qualifyingCount: Schema.Int,
  removedMembers: Schema.Array(RemovedMember),
  botCanManageRoles: Schema.Boolean,
}) {}

export const SetRoleMappingRequest = Schema.Union([
  Schema.Struct({ source: Schema.Literal('existing'), roleId: Snowflake }),
  Schema.Struct({ source: Schema.Literal('auto_create') }),
  Schema.Struct({ source: Schema.Literal('none') }),
]);
export type SetRoleMappingRequest = Schema.Schema.Type<typeof SetRoleMappingRequest>;

export const SetBuiltInThresholdRequest = Schema.Struct({
  threshold: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
});
export type SetBuiltInThresholdRequest = Schema.Schema.Type<typeof SetBuiltInThresholdRequest>;

export const CreateCustomRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  emoji: Schema.OptionFromNullOr(Schema.String),
  ruleKind: CustomRuleKind,
  threshold: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  activityTypeSlug: Schema.OptionFromNullOr(Schema.String),
  discordRoleId: Schema.OptionFromNullOr(Schema.String),
});
export type CreateCustomRequest = Schema.Schema.Type<typeof CreateCustomRequest>;

export const UpdateCustomRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(Schema.NonEmptyString),
  description: Schema.OptionFromNullOr(Schema.NonEmptyString),
  emoji: Schema.OptionFromNullOr(Schema.String),
  ruleKind: Schema.OptionFromNullOr(CustomRuleKind),
  threshold: Schema.OptionFromNullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  activityTypeSlug: Schema.OptionFromNullOr(Schema.String),
  discordRoleId: Schema.OptionFromNullOr(Schema.String),
});
export type UpdateCustomRequest = Schema.Schema.Type<typeof UpdateCustomRequest>;

export class AchievementForbidden extends Schema.TaggedErrorClass<AchievementForbidden>()(
  'AchievementForbidden',
  {},
) {}

export class AchievementNotFound extends Schema.TaggedErrorClass<AchievementNotFound>()(
  'AchievementNotFound',
  {},
) {}

export class CustomAchievementNotFound extends Schema.TaggedErrorClass<CustomAchievementNotFound>()(
  'CustomAchievementNotFound',
  {},
) {}

export class CustomAchievementNameTaken extends Schema.TaggedErrorClass<CustomAchievementNameTaken>()(
  'CustomAchievementNameTaken',
  {},
) {}

export class InvalidThreshold extends Schema.TaggedErrorClass<InvalidThreshold>()(
  'InvalidThreshold',
  {},
) {}

export class InvalidCustomRule extends Schema.TaggedErrorClass<InvalidCustomRule>()(
  'InvalidCustomRule',
  {},
) {}

export class NoGuildLinked extends Schema.TaggedErrorClass<NoGuildLinked>()('NoGuildLinked', {}) {}

export class AchievementApiGroup extends HttpApiGroup.make('achievement')
  .add(
    HttpApiEndpoint.get('listAchievements', '/teams/:teamId/achievements', {
      success: Schema.Array(AchievementOverview),
      error: AchievementForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'previewBuiltInThreshold',
      '/teams/:teamId/achievements/built-in/:slug/preview',
      {
        success: PreviewResponse,
        error: [
          AchievementForbidden.pipe(HttpApiSchema.status(403)),
          AchievementNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, slug: AchievementSlug },
        query: {
          threshold: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
        },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put(
      'setBuiltInThreshold',
      '/teams/:teamId/achievements/built-in/:slug/threshold',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          AchievementForbidden.pipe(HttpApiSchema.status(403)),
          AchievementNotFound.pipe(HttpApiSchema.status(404)),
          InvalidThreshold.pipe(HttpApiSchema.status(400)),
        ],
        payload: SetBuiltInThresholdRequest,
        params: { teamId: TeamId, slug: AchievementSlug },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('setRoleMapping', '/teams/:teamId/achievements/:keyOrId/role-mapping', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        AchievementForbidden.pipe(HttpApiSchema.status(403)),
        AchievementNotFound.pipe(HttpApiSchema.status(404)),
        NoGuildLinked.pipe(HttpApiSchema.status(400)),
      ],
      payload: SetRoleMappingRequest,
      params: { teamId: TeamId, keyOrId: Schema.String },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createCustom', '/teams/:teamId/achievements/custom', {
      success: Schema.Void.pipe(HttpApiSchema.status(201)),
      error: [
        AchievementForbidden.pipe(HttpApiSchema.status(403)),
        CustomAchievementNameTaken.pipe(HttpApiSchema.status(409)),
        InvalidCustomRule.pipe(HttpApiSchema.status(400)),
      ],
      payload: CreateCustomRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateCustom', '/teams/:teamId/achievements/custom/:customId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        AchievementForbidden.pipe(HttpApiSchema.status(403)),
        CustomAchievementNotFound.pipe(HttpApiSchema.status(404)),
        CustomAchievementNameTaken.pipe(HttpApiSchema.status(409)),
        InvalidCustomRule.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpdateCustomRequest,
      params: { teamId: TeamId, customId: CustomAchievementId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteCustom', '/teams/:teamId/achievements/custom/:customId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        AchievementForbidden.pipe(HttpApiSchema.status(403)),
        CustomAchievementNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, customId: CustomAchievementId },
    }).middleware(AuthMiddleware),
  ) {}
