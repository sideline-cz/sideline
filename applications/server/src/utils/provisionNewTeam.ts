import {
  Auth,
  type Discord,
  type Onboarding,
  OnboardingApi,
  Role,
  type Team,
  type User,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Option, pipe } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import {
  type MemberAlreadyExistsError,
  TeamMembersRepository,
} from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';

export interface ProvisionNewTeamPayload {
  readonly name: string;
  readonly guildId: Discord.Snowflake;
  readonly description: Option.Option<string>;
  readonly sport: Option.Option<string>;
  readonly logoUrl: Option.Option<string>;
  readonly welcomeChannelId: Option.Option<Discord.Snowflake>;
  readonly systemLogChannelId: Option.Option<Discord.Snowflake>;
  readonly onboardingLocale: Onboarding.OnboardingLocale;
}

/**
 * Callback to atomically mark an onboarding token consumed inside the team-provision
 * transaction. Returning `Option.none` indicates the token was already consumed (race);
 * the transaction is then aborted with `OnboardingTokenAlreadyConsumed`.
 */
export type MarkConsumedFn = (
  teamId: Team.TeamId,
) => Effect.Effect<Option.Option<unknown>, never, never>;

interface ProvisionNewTeamArgs {
  readonly payload: ProvisionNewTeamPayload;
  readonly currentUserId: User.UserId;
  /**
   * Optional token-consumption hook called as the last step inside the transaction.
   * Omitted by callers (e.g. the legacy `createTeam` endpoint) that do not use
   * onboarding tokens.
   */
  readonly markConsumed?: MarkConsumedFn;
}

/**
 * Provisions a new team inside a database transaction. If `markConsumed` is provided
 * and returns `Option.none`, the transaction is aborted with `OnboardingTokenAlreadyConsumed`.
 */
export function provisionNewTeam(
  args: ProvisionNewTeamArgs & { readonly markConsumed: MarkConsumedFn },
): Effect.Effect<
  Auth.UserTeam,
  MemberAlreadyExistsError | OnboardingApi.OnboardingTokenAlreadyConsumed,
  TeamsRepository | RolesRepository | TeamMembersRepository | SqlClient.SqlClient
>;
export function provisionNewTeam(
  args: Omit<ProvisionNewTeamArgs, 'markConsumed'>,
): Effect.Effect<
  Auth.UserTeam,
  MemberAlreadyExistsError,
  TeamsRepository | RolesRepository | TeamMembersRepository | SqlClient.SqlClient
>;
export function provisionNewTeam({
  payload,
  currentUserId,
  markConsumed,
}: ProvisionNewTeamArgs): Effect.Effect<
  Auth.UserTeam,
  MemberAlreadyExistsError | OnboardingApi.OnboardingTokenAlreadyConsumed,
  TeamsRepository | RolesRepository | TeamMembersRepository | SqlClient.SqlClient
> {
  return Effect.Do.pipe(
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.flatMap(({ sql }) =>
      sql
        .withTransaction(
          Effect.Do.pipe(
            Effect.bind('teams', () => TeamsRepository.asEffect()),
            Effect.bind('roles', () => RolesRepository.asEffect()),
            Effect.bind('members', () => TeamMembersRepository.asEffect()),
            Effect.bind('team', ({ teams }) =>
              teams.insert({
                name: payload.name,
                guild_id: payload.guildId,
                description: payload.description,
                sport: payload.sport,
                logo_url: payload.logoUrl,
                created_by: currentUserId,
                created_at: undefined,
                updated_at: undefined,
                welcome_channel_id: payload.welcomeChannelId,
                system_log_channel_id: payload.systemLogChannelId,
                welcome_message_template: Option.none(),
                rules_channel_id: Option.none(),
                achievement_channel_id: Option.none(),
                onboarding_rules_role_id: Option.none(),
                onboarding_rules_prompt_id: Option.none(),
                onboarding_locale: payload.onboardingLocale,
                onboarding_synced_at: Option.none(),
                onboarding_sync_status: 'pending',
                onboarding_sync_error: Option.none(),
              }),
            ),
            Effect.bind('seededRoles', ({ roles, team }) =>
              roles.seedTeamRolesWithPermissions(team.id),
            ),
            Effect.bind('adminRole', ({ seededRoles }) =>
              pipe(
                seededRoles,
                Array.findFirst((r) => r.name === 'Admin'),
                Option.match({
                  onNone: () => Effect.die(new Error('Admin role missing after seeding team')),
                  onSome: Effect.succeed,
                }),
              ),
            ),
            Effect.bind('newMember', ({ members, team }) =>
              members.addMember({
                team_id: team.id,
                user_id: currentUserId,
                active: true,
                joined_at: undefined,
              }),
            ),
            Effect.tap(({ members, newMember, adminRole }) =>
              members.assignRole(newMember.id, adminRole.id),
            ),
            Effect.tap(({ team }) =>
              markConsumed === undefined
                ? Effect.void
                : markConsumed(team.id).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () =>
                          Effect.fail(new OnboardingApi.OnboardingTokenAlreadyConsumed()),
                        onSome: () => Effect.void,
                      }),
                    ),
                  ),
            ),
            Effect.map(
              ({ team }) =>
                new Auth.UserTeam({
                  teamId: team.id,
                  teamName: team.name,
                  logoUrl: team.logo_url,
                  roleNames: ['Admin'],
                  permissions: [...Role.defaultPermissions.Admin],
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Team provision failed — no row returned'),
            ),
          ),
        )
        .pipe(catchSqlErrors),
    ),
  );
}
