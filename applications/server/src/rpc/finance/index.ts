import {
  CzIban,
  type Discord,
  Fee,
  FeeAssignment,
  FinanceRpcEvents,
  FinanceRpcGroup,
  FinanceRpcModels,
  type PaymentReminder,
  Spayd,
  Team,
} from '@sideline/domain';
import { Bind, Options } from '@sideline/effect-lib';
import { Effect, Option, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTokenExpiryEventsRepository } from '~/repositories/BankTokenExpiryEventsRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { renderQrPng } from '~/services/QrRenderer.js';

// Split into two `.pipe()` chains (repositories, then handlers) — `Effect.Do.pipe(...)`'s
// combinator count otherwise exceeds `pipe`'s ~20-argument overload ceiling once the five new
// `Finance/*` bank-sync handlers are added, which silently degrades the WHOLE chain's inferred
// type to `unknown`/`any` (cascading through every downstream `Effect.bind`/`Effect.let`, not
// just the new ones — see the compile error this produced without the split).
const FinanceRpcRepos = Effect.Do.pipe(
  Effect.bind('teams', () => TeamsRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('members', () => TeamMembersRepository.asEffect()),
  Effect.bind('financeOverview', () => FinanceOverviewRepository.asEffect()),
  Effect.bind('paymentSyncRepo', () => PaymentReminderSyncEventsRepository.asEffect()),
  Effect.bind('paymentRemindersSentRepo', () => PaymentRemindersSentRepository.asEffect()),
  Effect.bind('bankTokenExpiryRepo', () => BankTokenExpiryEventsRepository.asEffect()),
  Effect.bind('bankSyncConfigRepo', () => BankSyncConfigRepository.asEffect()),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
);

/**
 * The single code `/finance` always shows. One SPAYD for the club's bank-account currency,
 * carrying the member's net outstanding total as `AM` — or, when they owe nothing, the very same
 * code with NO `AM`, which is the "any amount, any time" top-up code `getMyTopup` already serves
 * on the web.
 *
 * Fees in any other currency are deliberately outside the amount: a club has exactly one
 * configured account and a SPAYD carries exactly one amount in one currency. Those fees stay
 * visible in the embed's per-currency total line.
 *
 * `None` for every missing piece — no bank config, no IBAN, no variable symbol, an un-renderable
 * payload. The command then renders exactly as it did before the QR existed.
 */
export const buildMyStatusQr = (opts: {
  readonly iban: Option.Option<string>;
  readonly recipientName: Option.Option<string>;
  readonly variableSymbol: string | null;
  readonly currency: string;
  readonly netOutstandingMinor: number;
}): Effect.Effect<FinanceRpcModels.PaymentQrResult | null> => {
  const vsNorm = Option.fromNullishOr(opts.variableSymbol).pipe(
    Option.map((vs) => vs.trim().replace(/^0+/, '')),
    Option.filter((vs) => vs !== ''),
  );
  if (Option.isNone(opts.iban) || Option.isNone(vsNorm)) return Effect.succeed(null);

  const spaydOpt = Spayd.buildSpayd({
    acc: opts.iban.value,
    // Omitted entirely when nothing is owed — that absence IS the "no amount" half of the
    // feature, not a fallback. `0.00` would make banks prefill a zero-crown transfer.
    ...(opts.netOutstandingMinor > 0 ? { amountMinor: BigInt(opts.netOutstandingMinor) } : {}),
    currency: opts.currency,
    variableSymbol: vsNorm.value,
    recipientName: Option.getOrUndefined(
      Option.map(opts.recipientName, Spayd.transliterateToSpaydAscii),
    ),
  });

  return Option.match(spaydOpt, {
    onNone: () => Effect.succeed(null),
    onSome: (spayd) =>
      renderQrPng(spayd).pipe(
        Effect.map(
          (png) =>
            new FinanceRpcModels.PaymentQrResult({
              spayd,
              png_base64: Buffer.from(png).toString('base64'),
              filename: 'qr-finance-status.png',
            }),
        ),
        Effect.catchTag('QrRenderError', () => Effect.succeed(null)),
      ),
  });
};

export const FinanceRpcLive = FinanceRpcRepos.pipe(
  Effect.let(
    'Finance/GetMyStatus',
    ({ teams, users, members, financeOverview, bankSyncConfigRepo, sql }) =>
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
          // Raw SQL, not `MemberCreditsRepository` / `TeamMembersRepository`: every extra service
          // bound here joins `SyncRpcsLive`'s requirement union, which is already big enough that
          // one more member tips TypeScript's inference over and silently collapses `AppLive`'s
          // `R` to `unknown` — surfacing as an unrelated-looking error in `run.ts`. The same
          // reason `Finance/GetPaymentQr` below reads `fee_assignments` through `sql` directly.
          Effect.bind('member_', ({ member }) =>
            Effect.all(
              {
                creditAccounts: sql<{
                  readonly currency: string;
                  readonly balance_minor: string;
                }>`
                  SELECT currency, balance_minor::text AS balance_minor
                    FROM member_credit_accounts WHERE team_member_id = ${member.id}
                `.pipe(
                  Effect.map((rows) =>
                    rows.map((row) => ({
                      currency: row.currency,
                      balanceMinor: Number(row.balance_minor),
                    })),
                  ),
                ),
                variableSymbol: sql<{ readonly variable_symbol: string | null }>`
                  SELECT variable_symbol FROM team_members WHERE id = ${member.id}
                `.pipe(Effect.map((rows) => rows[0]?.variable_symbol ?? null)),
              },
              { concurrency: 2 },
            ).pipe(
              // A credit or symbol lookup that fails must not fail the whole command: the member
              // still gets their fee list, just without the QR and without the credit line.
              Effect.catchTag('SqlError', (e) =>
                Effect.logWarning('Finance/GetMyStatus: credit/symbol lookup failed', e).pipe(
                  Effect.as({
                    creditAccounts: [] as ReadonlyArray<{
                      readonly currency: string;
                      readonly balanceMinor: number;
                    }>,
                    variableSymbol: null as string | null,
                  }),
                ),
              ),
            ),
          ),
          Effect.let('creditAccounts', ({ member_ }) => member_.creditAccounts),
          Effect.let('variableSymbol', ({ member_ }) => member_.variableSymbol),
          Effect.bind('configOpt', ({ team }) => bankSyncConfigRepo.findByTeam(team.id)),
          Effect.bind('qr', ({ statusGroups, creditAccounts, configOpt, variableSymbol }) =>
            Option.match(configOpt, {
              onNone: () => Effect.succeed<FinanceRpcModels.PaymentQrResult | null>(null),
              onSome: (config) => {
                // Only the bank account's own currency can carry an amount — see
                // `buildMyStatusQr`. A member who owes nothing in it (or owes it off entirely in
                // credit) gets the no-amount code, which is the point of the feature.
                const group = statusGroups.find((g) => g.currency === config.currency);
                const creditMinor =
                  creditAccounts.find((a) => a.currency === config.currency)?.balanceMinor ?? 0;
                const netOutstandingMinor = Math.max(
                  0,
                  (group?.totalOutstandingMinor ?? 0) - creditMinor,
                );
                return buildMyStatusQr({
                  iban: Option.flatMap(config.account_number, (accountNumber) =>
                    Option.flatMap(config.bank_code, (bankCode) =>
                      CzIban.buildCzIban({
                        prefix: Option.getOrUndefined(config.account_prefix),
                        accountNumber,
                        bankCode,
                      }),
                    ),
                  ),
                  recipientName: config.recipient_name,
                  variableSymbol,
                  currency: config.currency,
                  netOutstandingMinor,
                });
              },
            }),
          ),
          Effect.map(({ statusGroups, creditAccounts, qr }) => {
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
                credit_minor: Schema.decodeSync(Fee.AmountMinor)(
                  creditAccounts.find((a) => a.currency === group.currency)?.balanceMinor ?? 0,
                ),
                assignments,
              });
            });
            return new FinanceRpcModels.GetMyStatusResult({ groups, qr });
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
                  // D15b — the 'assigned' kind has no due date to render urgency from
                  // (a fee with no due date is exactly the case an early QR helps most); the
                  // bot's embed still unconditionally formats a Discord timestamp for every
                  // kind, so a NULL is mapped to 'now' rather than epoch-0 (`new Date(null)`).
                  effective_due_at: Option.getOrElse(
                    Option.map(row.effective_due_at, (d) => d.toISOString()),
                    () => new Date().toISOString(),
                  ),
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
  // `Finance/GetPaymentQr` — SPAYD (Step 0-10, D1/D10) + `QrRenderer`. Never fails a reminder for
  // a QR problem: any missing piece (no bank-sync config, no usable IBAN, an un-renderable SPAYD
  // string) maps to `FinanceQrUnavailable`, and `handlePaymentReminderReady.ts` already sends the
  // reminder WITHOUT a QR on that failure.
  Effect.let(
    'Finance/GetPaymentQr',
    ({ sql, bankSyncConfigRepo }) =>
      ({
        assignment_id,
      }: {
        readonly assignment_id: FeeAssignment.FeeAssignmentId;
      }): Effect.Effect<FinanceRpcModels.PaymentQrResult, FinanceRpcModels.FinanceQrUnavailable> =>
        Effect.Do.pipe(
          Effect.bind(
            'row',
            () => sql<{
              readonly team_id: string;
              readonly variable_symbol: string | null;
              readonly amount_minor: string;
              readonly paid_minor: string;
              readonly currency: string;
              readonly fee_name: string;
            }>`
              SELECT f.team_id::text AS team_id, tm.variable_symbol,
                     fa.amount_minor::text, fa.paid_minor::text, f.currency, f.name AS fee_name
              FROM fee_assignments fa
              JOIN fees f ON f.id = fa.fee_id
              JOIN team_members tm ON tm.id = fa.team_member_id
              WHERE fa.id = ${assignment_id}
            `,
          ),
          Effect.flatMap(({ row }) => {
            const assignmentRow = row[0];
            if (assignmentRow === undefined) {
              return Effect.fail(new FinanceRpcModels.FinanceQrUnavailable());
            }
            return bankSyncConfigRepo
              .findByTeam(Schema.decodeSync(Team.TeamId)(assignmentRow.team_id))
              .pipe(Effect.map((configOpt) => ({ assignmentRow, configOpt })));
          }),
          Effect.flatMap(({ assignmentRow, configOpt }) =>
            Option.match(configOpt, {
              onNone: () => Effect.fail(new FinanceRpcModels.FinanceQrUnavailable()),
              onSome: (config) => {
                const computedIban = Option.flatMap(config.account_number, (accountNumber) =>
                  Option.flatMap(config.bank_code, (bankCode) =>
                    CzIban.buildCzIban({
                      prefix: Option.getOrUndefined(config.account_prefix),
                      accountNumber,
                      bankCode,
                    }),
                  ),
                );
                return Option.match(computedIban, {
                  onNone: () => Effect.fail(new FinanceRpcModels.FinanceQrUnavailable()),
                  onSome: (iban) => {
                    const outstanding = Math.max(
                      0,
                      Number(assignmentRow.amount_minor) - Number(assignmentRow.paid_minor),
                    );
                    const vsNorm = Option.fromNullishOr(assignmentRow.variable_symbol).pipe(
                      Option.map((vs) => vs.trim().replace(/^0+/, '')),
                      Option.filter((vs) => vs !== ''),
                    );
                    const spaydOpt = Spayd.buildSpayd({
                      acc: iban,
                      amountMinor: BigInt(outstanding),
                      currency: assignmentRow.currency,
                      message: Spayd.toSpaydMessage(assignmentRow.fee_name),
                      variableSymbol: Option.getOrUndefined(vsNorm),
                      recipientName: Option.getOrUndefined(
                        Option.map(config.recipient_name, Spayd.transliterateToSpaydAscii),
                      ),
                    });
                    return Option.match(spaydOpt, {
                      onNone: () => Effect.fail(new FinanceRpcModels.FinanceQrUnavailable()),
                      onSome: (spayd) =>
                        renderQrPng(spayd).pipe(
                          Effect.map(
                            (png) =>
                              new FinanceRpcModels.PaymentQrResult({
                                spayd,
                                png_base64: Buffer.from(png).toString('base64'),
                                filename: `qr-${assignment_id}.png`,
                              }),
                          ),
                          Effect.catchTag('QrRenderError', () =>
                            Effect.fail(new FinanceRpcModels.FinanceQrUnavailable()),
                          ),
                        ),
                    });
                  },
                });
              },
            }),
          ),
          Effect.catchTag('SqlError', (e) =>
            Effect.logWarning('Finance/GetPaymentQr: SQL error, reporting QR unavailable', e).pipe(
              Effect.andThen(Effect.fail(new FinanceRpcModels.FinanceQrUnavailable())),
            ),
          ),
        ),
  ),
  Effect.let(
    'Finance/GetUnprocessedBankTokenExpiryEvents',
    ({ bankTokenExpiryRepo }) =>
      ({ limit }: { readonly limit: number }) =>
        bankTokenExpiryRepo.findUnprocessed(limit).pipe(
          Effect.map((rows) =>
            rows.map(
              (row) =>
                new FinanceRpcEvents.BankTokenExpiringEvent({
                  id: row.id,
                  team_id: row.team_id,
                  guild_id: row.guild_id,
                  user_discord_id: row.user_discord_id,
                  days_until_expiry: row.threshold_days,
                }),
            ),
          ),
        ),
  ),
  Effect.let(
    'Finance/MarkBankTokenExpiryProcessed',
    ({ bankTokenExpiryRepo }) =>
      ({ id }: { readonly id: string }) =>
        bankTokenExpiryRepo.markProcessed(id),
  ),
  Effect.let(
    'Finance/MarkBankTokenExpiryFailed',
    ({ bankTokenExpiryRepo }) =>
      ({ id, error }: { readonly id: string; readonly error: string }) =>
        bankTokenExpiryRepo.markFailed(id, error),
  ),
  Effect.let(
    'Finance/MarkBankTokenExpirySent',
    ({ bankTokenExpiryRepo }) =>
      ({
        team_id,
        token_created_at,
        threshold_days,
      }: {
        readonly team_id: Team.TeamId;
        readonly token_created_at: string;
        readonly threshold_days: number;
      }) =>
        bankTokenExpiryRepo.markSent(team_id, token_created_at, threshold_days),
  ),
  Bind.remove('teams'),
  Bind.remove('users'),
  Bind.remove('members'),
  Bind.remove('financeOverview'),
  Bind.remove('paymentSyncRepo'),
  Bind.remove('paymentRemindersSentRepo'),
  Bind.remove('bankTokenExpiryRepo'),
  Bind.remove('bankSyncConfigRepo'),
  Bind.remove('sql'),
  (handlers) => FinanceRpcGroup.FinanceRpcGroup.toLayer(handlers),
);
