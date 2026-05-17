import {
  type Discord,
  Fee,
  FeeAssignment,
  FinanceRpcEvents,
  FinanceRpcGroup,
  FinanceRpcModels,
  type PaymentReminder,
} from '@sideline/domain';
import { Bind, Options } from '@sideline/effect-lib';
import { Effect, Option, Schema } from 'effect';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

export const FinanceRpcLive = Effect.Do.pipe(
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('financeOverview', () => FinanceOverviewRepository.asEffect()),
  Effect.bind('paymentSyncRepo', () => PaymentReminderSyncEventsRepository.asEffect()),
  Effect.bind('paymentRemindersSentRepo', () => PaymentRemindersSentRepository.asEffect()),
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
  Effect.let(
    'Finance/GetUnprocessedPaymentReminders',
    ({ paymentSyncRepo }) =>
      ({ limit }: { readonly limit: number }) =>
        paymentSyncRepo.findUnprocessed(limit).pipe(
          Effect.map((rows) =>
            rows.map(
              (row) =>
                new FinanceRpcEvents.PaymentReminderReadyEvent({
                  id: row.id,
                  team_id: row.team_id,
                  guild_id: row.guild_id,
                  assignment_id: row.assignment_id,
                  kind: row.kind,
                  fee_name: row.fee_name,
                  effective_due_at: row.effective_due_at.toISOString(),
                  currency: row.currency,
                  amount_minor: row.amount_minor,
                  paid_minor: row.paid_minor,
                  user_discord_id: row.user_discord_id,
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'Finance/MarkPaymentReminderProcessed',
    ({ paymentSyncRepo }) =>
      ({ id }: { readonly id: string }) =>
        paymentSyncRepo.markProcessed(id),
  ),
  Effect.let(
    'Finance/MarkPaymentReminderFailed',
    ({ paymentSyncRepo }) =>
      ({ id, error }: { readonly id: string; readonly error: string }) =>
        paymentSyncRepo.markFailed(id, error),
  ),
  Effect.let(
    'Finance/MarkReminderSent',
    ({ paymentRemindersSentRepo }) =>
      ({
        assignment_id,
        kind,
      }: {
        readonly assignment_id: FeeAssignment.FeeAssignmentId;
        readonly kind: PaymentReminder.PaymentReminderKind;
      }) =>
        paymentRemindersSentRepo.markSent(assignment_id, kind),
  ),
  Bind.remove('teams'),
  Bind.remove('users'),
  Bind.remove('members'),
  Bind.remove('financeOverview'),
  Bind.remove('paymentSyncRepo'),
  Bind.remove('paymentRemindersSentRepo'),
  (handlers) => FinanceRpcGroup.FinanceRpcGroup.toLayer(handlers),
);
