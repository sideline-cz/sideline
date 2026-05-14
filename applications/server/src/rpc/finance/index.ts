import {
  type Discord,
  Fee,
  FeeAssignment,
  FinanceRpcGroup,
  FinanceRpcModels,
} from '@sideline/domain';
import { Bind, Options } from '@sideline/effect-lib';
import { Effect, Option, Schema } from 'effect';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

export const FinanceRpcLive = Effect.Do.pipe(
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('financeOverview', () => FinanceOverviewRepository.asEffect()),
  Effect.let(
    'Finance/GetMyStatus',
    ({ teams, users, members, financeOverview }) =>
      ({
        guild_id,
        discord_user_id,
      }: {
        readonly guild_id: Discord.Snowflake;
        readonly discord_user_id: Discord.Snowflake;
      }) =>
        Effect.Do.pipe(
          Effect.bind('team', () =>
            teams
              .findByGuildId(guild_id)
              .pipe(
                Effect.flatMap(Options.toEffect(() => new FinanceRpcModels.FinanceGuildNotFound())),
              ),
          ),
          Effect.bind('user', () =>
            users
              .findByDiscordId(discord_user_id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new FinanceRpcModels.FinanceMemberNotFound()),
                ),
              ),
          ),
          Effect.bind('member', ({ team, user }) =>
            members
              .findMembershipByIds(team.id, user.id)
              .pipe(
                Effect.flatMap(
                  Options.toEffect(() => new FinanceRpcModels.FinanceMemberNotFound()),
                ),
              ),
          ),
          Effect.tap(({ member }) =>
            member.active ? Effect.void : Effect.fail(new FinanceRpcModels.FinanceMemberNotFound()),
          ),
          Effect.bind('statusGroups', ({ team, user }) =>
            financeOverview.myStatus(team.id, user.id),
          ),
          Effect.map(({ statusGroups }) => {
            const groups = statusGroups.map((group) => {
              const assignments = group.assignments.map((row) => {
                const effectiveDueAtStr = Option.map(row.effective_due_at, (date: Date) =>
                  date.toISOString(),
                );
                return new FinanceRpcModels.FinanceStatusAssignment({
                  assignment_id: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(
                    row.assignment_id,
                  ),
                  fee_name: row.fee_name,
                  status: Schema.decodeUnknownSync(FeeAssignment.FeeAssignmentStatus)(row.status),
                  due_minor: Schema.decodeSync(Fee.AmountMinor)(row.due_minor),
                  paid_minor: Schema.decodeSync(Fee.AmountMinor)(row.paid_minor),
                  effective_due_at: effectiveDueAtStr,
                });
              });
              return new FinanceRpcModels.FinanceStatusCurrencyGroup({
                currency: Schema.decodeSync(Fee.CurrencyCode)(group.currency),
                total_outstanding_minor: Schema.decodeSync(Fee.AmountMinor)(
                  group.totalOutstandingMinor,
                ),
                assignments,
              });
            });
            return new FinanceRpcModels.GetMyStatusResult({ groups });
          }),
        ),
  ),
  Bind.remove('teams'),
  Bind.remove('users'),
  Bind.remove('members'),
  Bind.remove('financeOverview'),
  (handlers) => FinanceRpcGroup.FinanceRpcGroup.toLayer(handlers),
);
