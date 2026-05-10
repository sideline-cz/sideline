import { Auth, EventApi, type Team, TeamApi } from '@sideline/domain';
import { Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

const forbidden = new EventApi.Forbidden();

const hasOnboardingFieldChange = (
  existing: {
    readonly name: string;
    readonly rules_channel_id: Option.Option<string>;
    readonly onboarding_rules_role_id: Option.Option<string>;
    readonly onboarding_locale: string;
    readonly welcome_channel_id: Option.Option<string>;
  },
  next: {
    readonly name: string;
    readonly rules_channel_id: Option.Option<string>;
    readonly onboarding_rules_role_id: Option.Option<string>;
    readonly onboarding_locale: string;
    readonly welcome_channel_id: Option.Option<string>;
  },
): boolean =>
  existing.name !== next.name ||
  Option.getOrNull(existing.rules_channel_id) !== Option.getOrNull(next.rules_channel_id) ||
  Option.getOrNull(existing.onboarding_rules_role_id) !==
    Option.getOrNull(next.onboarding_rules_role_id) ||
  existing.onboarding_locale !== next.onboarding_locale ||
  Option.getOrNull(existing.welcome_channel_id) !== Option.getOrNull(next.welcome_channel_id);

const parseOnboardingSyncError = (raw: Option.Option<string>): Option.Option<string> => {
  if (Option.isNone(raw)) return Option.none();
  try {
    const parsed = JSON.parse(raw.value) as { code?: unknown; detail?: unknown };
    if (typeof parsed.code === 'string' && typeof parsed.detail === 'string') {
      return Option.some(JSON.stringify({ code: parsed.code, detail: parsed.detail }));
    }
    return Option.some(JSON.stringify({ code: 'generic', detail: raw.value }));
  } catch {
    return Option.some(JSON.stringify({ code: 'generic', detail: raw.value }));
  }
};

const teamToInfo = (team: Team.Team, isCommunityEnabled: boolean) =>
  new TeamApi.TeamInfo({
    teamId: team.id,
    name: team.name,
    description: team.description,
    sport: team.sport,
    logoUrl: team.logo_url,
    guildId: team.guild_id,
    welcomeChannelId: team.welcome_channel_id,
    systemLogChannelId: team.system_log_channel_id,
    welcomeMessageTemplate: team.welcome_message_template,
    rulesChannelId: team.rules_channel_id,
    onboardingRulesRoleId: team.onboarding_rules_role_id,
    onboardingLocale: team.onboarding_locale,
    onboardingSyncStatus: team.onboarding_sync_status,
    onboardingSyncedAt: team.onboarding_synced_at,
    onboardingSyncError: parseOnboardingSyncError(team.onboarding_sync_error),
    isCommunityEnabled,
  });

const getTeamOrForbidden = (
  teams: ServiceMap.Service.Shape<typeof TeamsRepository>,
  teamId: Team.TeamId,
) =>
  teams
    .findById(teamId)
    .pipe(
      Effect.flatMap((opt) =>
        Option.isSome(opt) ? Effect.succeed(opt.value) : Effect.fail(forbidden),
      ),
    );

const getIsCommunityEnabled = (
  botGuilds: ServiceMap.Service.Shape<typeof BotGuildsRepository>,
  guildId: Team.Team['guild_id'],
) =>
  botGuilds
    .findByGuildId(guildId)
    .pipe(
      Effect.map((opt) =>
        Option.match(opt, { onNone: () => false, onSome: (g) => g.is_community_enabled }),
      ),
    );

export const TeamApiLive = HttpApiBuilder.group(Api, 'team', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('botGuilds', () => BotGuildsRepository.asEffect()),
    Effect.map(({ members, teams, botGuilds }) =>
      handlers
        .handle('getTeamInfo', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('team', () => getTeamOrForbidden(teams, teamId)),
            Effect.bind('isCommunityEnabled', ({ team }) =>
              getIsCommunityEnabled(botGuilds, team.guild_id),
            ),
            Effect.map(({ team, isCommunityEnabled }) => teamToInfo(team, isCommunityEnabled)),
          ),
        )
        .handle('updateTeamInfo', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.bind('existing', () => getTeamOrForbidden(teams, teamId)),
            Effect.bind('nextFields', ({ existing }) => {
              const rules_channel_id = Option.match(payload.rulesChannelId, {
                onNone: () => existing.rules_channel_id,
                onSome: (v) => v,
              });
              const onboarding_rules_role_id = Option.match(payload.onboardingRulesRoleId, {
                onNone: () => existing.onboarding_rules_role_id,
                onSome: (v) => v,
              });
              const onboarding_locale = Option.getOrElse(
                payload.onboardingLocale,
                () => existing.onboarding_locale,
              );
              const welcome_channel_id = Option.match(payload.welcomeChannelId, {
                onNone: () => existing.welcome_channel_id,
                onSome: (v) => v,
              });
              const name = Option.getOrElse(payload.name, () => existing.name);
              return Effect.succeed({
                name,
                rules_channel_id,
                onboarding_rules_role_id,
                onboarding_locale,
                welcome_channel_id,
              });
            }),
            Effect.bind('updated', ({ existing, nextFields }) =>
              teams.update({
                id: teamId,
                name: nextFields.name,
                description: Option.match(payload.description, {
                  onNone: () => existing.description,
                  onSome: (v) => v,
                }),
                sport: Option.match(payload.sport, {
                  onNone: () => existing.sport,
                  onSome: (v) => v,
                }),
                logo_url: Option.match(payload.logoUrl, {
                  onNone: () => existing.logo_url,
                  onSome: (v) => v,
                }),
                welcome_channel_id: nextFields.welcome_channel_id,
                system_log_channel_id: Option.match(payload.systemLogChannelId, {
                  onNone: () => existing.system_log_channel_id,
                  onSome: (v) => v,
                }),
                welcome_message_template: Option.match(payload.welcomeMessageTemplate, {
                  onNone: () => existing.welcome_message_template,
                  onSome: (v) => v,
                }),
                rules_channel_id: nextFields.rules_channel_id,
                onboarding_rules_role_id: nextFields.onboarding_rules_role_id,
                onboarding_locale: nextFields.onboarding_locale,
              }),
            ),
            Effect.tap(({ existing, nextFields }) => {
              if (
                hasOnboardingFieldChange(
                  {
                    name: existing.name,
                    rules_channel_id: existing.rules_channel_id,
                    onboarding_rules_role_id: existing.onboarding_rules_role_id,
                    onboarding_locale: existing.onboarding_locale,
                    welcome_channel_id: existing.welcome_channel_id,
                  },
                  nextFields,
                )
              ) {
                return teams.markOnboardingSyncPending(teamId);
              }
              return Effect.void;
            }),
            Effect.bind('isCommunityEnabled', ({ updated }) =>
              getIsCommunityEnabled(botGuilds, updated.guild_id),
            ),
            Effect.map(({ updated, isCommunityEnabled }) =>
              teamToInfo(updated, isCommunityEnabled),
            ),
          ),
        )
        .handle('retryOnboardingSync', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) => requirePermission(membership, 'team:manage', forbidden)),
            Effect.tap(() => teams.markOnboardingSyncPending(teamId)),
            Effect.bind('team', () => getTeamOrForbidden(teams, teamId)),
            Effect.bind('isCommunityEnabled', ({ team }) =>
              getIsCommunityEnabled(botGuilds, team.guild_id),
            ),
            Effect.map(({ team, isCommunityEnabled }) => teamToInfo(team, isCommunityEnabled)),
          ),
        ),
    ),
  ),
);
