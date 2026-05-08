import { Auth, EventApi, type Team, TeamApi } from '@sideline/domain';
import { Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

const forbidden = new EventApi.Forbidden();

const teamToInfo = (team: Team.Team) =>
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

export const TeamApiLive = HttpApiBuilder.group(Api, 'team', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.map(({ members, teams }) =>
      handlers
        .handle('getTeamInfo', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('team', () => getTeamOrForbidden(teams, teamId)),
            Effect.map(({ team }) => teamToInfo(team)),
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
            Effect.bind('updated', ({ existing }) =>
              teams.update({
                id: teamId,
                name: Option.getOrElse(payload.name, () => existing.name),
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
                welcome_channel_id: Option.match(payload.welcomeChannelId, {
                  onNone: () => existing.welcome_channel_id,
                  onSome: (v) => v,
                }),
                system_log_channel_id: Option.match(payload.systemLogChannelId, {
                  onNone: () => existing.system_log_channel_id,
                  onSome: (v) => v,
                }),
                welcome_message_template: Option.match(payload.welcomeMessageTemplate, {
                  onNone: () => existing.welcome_message_template,
                  onSome: (v) => v,
                }),
              }),
            ),
            Effect.map(({ updated }) => teamToInfo(updated)),
          ),
        ),
    ),
  ),
);
