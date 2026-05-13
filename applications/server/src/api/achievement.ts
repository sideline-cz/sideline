import {
  Achievement,
  AchievementApi,
  Auth,
  CustomAchievement,
  type RoleProvisionRpcGroup,
} from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';

const forbidden = new AchievementApi.AchievementForbidden();

// Used to distinguish a custom achievement id (UUID) from arbitrary strings that
// would otherwise satisfy the unrestricted `CustomAchievementId` brand.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const AchievementApiLive = HttpApiBuilder.group(Api, 'achievement', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('settings', () => AchievementSettingsRepository.asEffect()),
    Effect.bind('customs', () => CustomAchievementsRepository.asEffect()),
    Effect.bind('roleMappings', () => AchievementRoleMappingsRepository.asEffect()),
    Effect.bind('drpe', () => DiscordRoleProvisionEventsRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('preview', () => AchievementPreview.asEffect()),
    Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
    Effect.map(
      ({ members, settings, customs, roleMappings, drpe, teams, preview, activityTypes }) =>
        handlers
          .handle('listAchievements', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('overrides', () => settings.findOverridesByTeam(teamId)),
              Effect.bind('roleMappingsList', () => roleMappings.findAllByTeam(teamId)),
              Effect.bind('customList', () => customs.findByTeam(teamId)),
              Effect.map(({ overrides, roleMappingsList, customList }) => {
                const roleMappingsMap = new Map(
                  roleMappingsList.map((r) => [r.slug, r.discord_role_id]),
                );

                const builtIns = Achievement.ACHIEVEMENTS.map((a) => {
                  const effectiveThreshold = Achievement.effectiveThreshold(a.slug, overrides);
                  const discordRoleId = roleMappingsMap.get(a.slug) ?? null;
                  return new AchievementApi.AchievementOverview({
                    keyOrId: a.slug,
                    name: Achievement.BUILT_IN_ENGLISH_NAMES[a.slug],
                    description: '',
                    titleKey: Option.some(Achievement.i18nTitleKey(a.slug)),
                    descriptionKey: Option.some(Achievement.i18nDescriptionKey(a.slug)),
                    kind: 'built_in',
                    ruleKind: Achievement.builtInRuleKind(a.slug),
                    effectiveThreshold,
                    defaultThreshold: Option.some(a.defaultThreshold),
                    discordRoleId: Option.fromNullishOr(discordRoleId),
                    isBuiltIn: true,
                  });
                });

                const customRows = customList.map(
                  (c) =>
                    new AchievementApi.AchievementOverview({
                      keyOrId: c.id,
                      name: c.name,
                      description: c.description,
                      titleKey: Option.none(),
                      descriptionKey: Option.none(),
                      kind: 'custom',
                      ruleKind: c.rule_kind,
                      effectiveThreshold: c.threshold,
                      defaultThreshold: Option.none(),
                      discordRoleId: c.discord_role_id,
                      isBuiltIn: false,
                    }),
                );

                return [...builtIns, ...customRows];
              }),
            ),
          )
          .handle('previewBuiltInThreshold', ({ params: { teamId, slug }, query: { threshold } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('result', () => preview.preview(teamId, slug, threshold)),
              Effect.map(
                ({ result }) =>
                  new AchievementApi.PreviewResponse({
                    qualifyingCount: result.qualifyingCount,
                    removedMembers: result.removedMembers.map(
                      (m) =>
                        new AchievementApi.RemovedMember({
                          teamMemberId: m.teamMemberId,
                          memberName: m.memberName,
                        }),
                    ),
                    botCanManageRoles: result.botCanManageRoles,
                  }),
              ),
            ),
          )
          .handle('setBuiltInThreshold', ({ params: { teamId, slug }, payload: { threshold } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.tap(() => settings.upsertOverride(teamId, slug, threshold)),
              Effect.asVoid,
            ),
          )
          .handle('setRoleMapping', ({ params: { teamId, keyOrId }, payload }) => {
            // Validate keyOrId: must be a known built-in slug or a valid UUID (custom achievement id)
            const slugOpt = Schema.decodeUnknownOption(Achievement.AchievementSlug)(keyOrId);
            const customIdOpt =
              Option.isSome(slugOpt) || !UUID_PATTERN.test(keyOrId)
                ? Option.none<CustomAchievement.CustomAchievementId>()
                : Schema.decodeUnknownOption(CustomAchievement.CustomAchievementId)(keyOrId);

            if (Option.isNone(slugOpt) && Option.isNone(customIdOpt)) {
              return Effect.fail(new AchievementApi.AchievementNotFound());
            }

            const kind: RoleProvisionRpcGroup.RoleProvisionKind = Option.isSome(slugOpt)
              ? 'builtin_achievement'
              : 'custom_achievement';

            return Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              // Supersede any pending outbox row for this (team, kind, ref_id) before applying new mapping
              Effect.tap(() => drpe.supersede(teamId, kind, keyOrId)),
              Effect.tap(() => {
                if (payload.source === 'existing') {
                  const roleId = payload.roleId;
                  if (Option.isSome(slugOpt)) {
                    return roleMappings.upsert(teamId, slugOpt.value, roleId);
                  }
                  if (Option.isSome(customIdOpt)) {
                    return customs.setRoleMapping(teamId, customIdOpt.value, Option.some(roleId));
                  }
                }

                if (payload.source === 'none') {
                  if (Option.isSome(slugOpt)) {
                    return roleMappings.delete(teamId, slugOpt.value);
                  }
                  if (Option.isSome(customIdOpt)) {
                    return customs.setRoleMapping(teamId, customIdOpt.value, Option.none());
                  }
                }

                // source === 'auto_create'
                return Effect.Do.pipe(
                  Effect.bind('team', () =>
                    teams.findById(teamId).pipe(
                      Effect.flatMap(
                        Option.match({
                          onNone: () => Effect.fail(new AchievementApi.NoGuildLinked()),
                          onSome: Effect.succeed,
                        }),
                      ),
                    ),
                  ),
                  Effect.flatMap(({ team }) => {
                    const guildId = team.guild_id;
                    if (Option.isSome(slugOpt)) {
                      const desiredName = Achievement.BUILT_IN_ENGLISH_NAMES[slugOpt.value];
                      return drpe.enqueue(teamId, guildId, kind, keyOrId, desiredName);
                    }
                    if (Option.isSome(customIdOpt)) {
                      // custom: look up the name from the DB
                      return customs.findById(teamId, customIdOpt.value).pipe(
                        Effect.flatMap(
                          Option.match({
                            onNone: () => Effect.fail(new AchievementApi.AchievementNotFound()),
                            onSome: (c) => drpe.enqueue(teamId, guildId, kind, keyOrId, c.name),
                          }),
                        ),
                      );
                    }
                    return Effect.fail(new AchievementApi.AchievementNotFound());
                  }),
                );
              }),
              Effect.asVoid,
            );
          })
          .handle('createCustom', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.tap(() => {
                if (
                  payload.ruleKind === 'activity_type_count' &&
                  Option.isNone(payload.activityTypeSlug)
                ) {
                  return Effect.fail(new AchievementApi.InvalidCustomRule());
                }
                return Effect.void;
              }),
              Effect.tap(() => {
                if (
                  payload.ruleKind === 'activity_type_count' &&
                  Option.isSome(payload.activityTypeSlug)
                ) {
                  return activityTypes.findBySlug(payload.activityTypeSlug.value).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.fail(new AchievementApi.InvalidCustomRule()),
                        onSome: () => Effect.void,
                      }),
                    ),
                  );
                }
                return Effect.void;
              }),
              Effect.tap(() =>
                customs
                  .insert({
                    team_id: teamId,
                    name: payload.name,
                    description: payload.description,
                    emoji: payload.emoji,
                    rule_kind: payload.ruleKind,
                    threshold: payload.threshold,
                    activity_type_slug: payload.activityTypeSlug,
                    discord_role_id: payload.discordRoleId,
                  })
                  .pipe(
                    Effect.catchTag('CustomAchievementNameTakenError', () =>
                      Effect.fail(new AchievementApi.CustomAchievementNameTaken()),
                    ),
                  ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('updateCustom', ({ params: { teamId, customId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.tap(() => {
                const newRuleKind = Option.getOrNull(payload.ruleKind);
                const newActivityTypeSlug = payload.activityTypeSlug;
                if (newRuleKind === 'activity_type_count' && Option.isNone(newActivityTypeSlug)) {
                  return Effect.fail(new AchievementApi.InvalidCustomRule());
                }
                return Effect.void;
              }),
              Effect.tap(() => {
                const newRuleKind = Option.getOrNull(payload.ruleKind);
                if (
                  newRuleKind === 'activity_type_count' &&
                  Option.isSome(payload.activityTypeSlug)
                ) {
                  return activityTypes.findBySlug(payload.activityTypeSlug.value).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.fail(new AchievementApi.InvalidCustomRule()),
                        onSome: () => Effect.void,
                      }),
                    ),
                  );
                }
                return Effect.void;
              }),
              Effect.bind('existing', () =>
                customs.findById(teamId, customId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(new AchievementApi.CustomAchievementNotFound()),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.tap(() =>
                customs
                  .update(teamId, customId, {
                    name: payload.name,
                    description: payload.description,
                    emoji: payload.emoji,
                    rule_kind: payload.ruleKind,
                    threshold: payload.threshold,
                    activity_type_slug: payload.activityTypeSlug,
                    discord_role_id: payload.discordRoleId,
                  })
                  .pipe(
                    Effect.catchTag('CustomAchievementNameTakenError', () =>
                      Effect.fail(new AchievementApi.CustomAchievementNameTaken()),
                    ),
                  ),
              ),
              Effect.asVoid,
            ),
          )
          .handle('deleteCustom', ({ params: { teamId, customId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.tap(() => customs.delete(teamId, customId)),
              Effect.asVoid,
            ),
          ),
    ),
  ),
);
