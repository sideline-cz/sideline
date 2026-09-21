/**
 * Plan `.work-plans/fio-transaction-matching.md` D1 / D10b / §5 / T7. Hourly cron, mirroring
 * `services/ImapPoller.ts`'s shape: per-team `Effect.exit` isolation, bounded concurrency,
 * `withCronMetrics`. `Schedule.cron(...)` fires once immediately at startup (see
 * `services/InviteAcceptanceSweepCron.ts`).
 *
 * D1 — polls `/periods` with a rolling, derived window (no `set-last-*`, no server-side cursor):
 * `from = max(today-89, min(today-14, last_success_at_date - 1))`, `to = today`. An outage longer
 * than the window is detected (the clamp fires) rather than silently skipped — `coverage_gap` is
 * recorded loudly instead.
 */
import { type BankSyncConfig, BankTransaction } from '@sideline/domain';
import {
  DateTime,
  Duration,
  Effect,
  Option,
  type Redacted,
  Schedule,
  Schema,
  type ServiceMap,
} from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { withCronMetrics } from '~/metrics.js';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import {
  BankTransactionsRepository,
  type FioMovementInsert,
} from '~/repositories/BankTransactionsRepository.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { make as makeMatcher } from '~/services/BankTransactionMatcher.js';
import {
  makeReal as makeRealFioApiClient,
  makeStub as makeStubFioApiClient,
} from '~/services/FioApiClient.js';
import { FioSecretCrypto } from '~/services/FioSecretCrypto.js';

const SYNC_WINDOW_DAYS = 14; // module constant, not a user-facing knob (B-cut-4)
const FIO_HISTORY_WALL_DAYS = 89; // Fio's 90-day limit, one day of slack
// D10b(n)'s load-bearing invariant is `timeout < lease`: FetchHttpClient.layer has no request
// timeout of its own, and `Effect.repeat(Schedule.cron(...))` cannot tick until the current
// invocation completes, so one team's hung Fio call would otherwise freeze bank sync for every
// team, indefinitely. The two numbers are derived together — raise one, raise the other.
const TEAM_CYCLE_TIMEOUT_MINUTES = 4;
const POLL_LEASE_SECONDS = 360; // 6 minutes — worked example: 4-minute timeout, 6-minute lease.
const POLL_HOLDER_PREFIX = 'bank-sync-poller';

const addDaysToDateString = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const minDate = (a: string, b: string): string => (a < b ? a : b);
const maxDate = (a: string, b: string): string => (a > b ? a : b);

interface SyncWindow {
  readonly from: string;
  readonly to: string;
  readonly coverageGap: boolean;
}

const computeWindow = (today: string, lastSuccessAt: Option.Option<DateTime.Utc>): SyncWindow => {
  const defaultFrom = addDaysToDateString(today, -SYNC_WINDOW_DAYS);
  const desiredFrom = Option.match(lastSuccessAt, {
    onNone: () => defaultFrom,
    onSome: (dt) => minDate(defaultFrom, addDaysToDateString(DateTime.formatIsoDateUtc(dt), -1)),
  });
  const wallFrom = addDaysToDateString(today, -FIO_HISTORY_WALL_DAYS);
  const clampedFrom = maxDate(wallFrom, desiredFrom);
  return { from: clampedFrom, to: today, coverageGap: clampedFrom > desiredFrom };
};

interface TeamDeps {
  readonly configRepo: ServiceMap.Service.Shape<typeof BankSyncConfigRepository>;
  readonly txRepo: ServiceMap.Service.Shape<typeof BankTransactionsRepository>;
  readonly crypto: ServiceMap.Service.Shape<typeof FioSecretCrypto>;
  readonly sql: SqlClient.SqlClient;
  readonly httpClientOpt: Option.Option<HttpClient.HttpClient>;
}

interface TokenAndWindow {
  readonly token: Redacted.Redacted<string>;
  readonly window: SyncWindow;
}

// Resolves the encrypted token and the window. `None` means the failure has ALREADY been
// recorded (no token configured is a no-op; a decrypt failure records it) and the caller should
// stop — never propagates a typed failure for these, since there is no HTTP call to retry.
const resolveTokenAndWindow = (
  config: BankSyncConfig.BankSyncConfig,
  deps: TeamDeps,
): Effect.Effect<Option.Option<TokenAndWindow>> => {
  const today = DateTime.formatIsoDateUtc(DateTime.nowUnsafe());
  const window = computeWindow(today, config.last_success_at);
  return Option.match(config.fio_token_encrypted, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (tokenEncrypted) =>
      deps.crypto.decrypt(tokenEncrypted).pipe(
        Effect.map((token): Option.Option<TokenAndWindow> => Option.some({ token, window })),
        Effect.catchTag('FioSecretKeyMissing', () =>
          deps.configRepo
            .recordFailure(config.team_id, 'key_missing')
            .pipe(Effect.as<Option.Option<TokenAndWindow>>(Option.none())),
        ),
        Effect.catchTag('FioSecretDecryptError', () =>
          deps.configRepo
            .recordFailure(config.team_id, 'fio_error')
            .pipe(Effect.as<Option.Option<TokenAndWindow>>(Option.none())),
        ),
      ),
  });
};

// Fetches the statement and ingests it (upsert transactions + statement period).
const fetchAndIngest = (
  config: BankSyncConfig.BankSyncConfig,
  deps: TeamDeps,
  token: Redacted.Redacted<string>,
  window: SyncWindow,
) =>
  Effect.Do.pipe(
    Effect.let('client', () =>
      Option.isSome(deps.httpClientOpt)
        ? makeRealFioApiClient(deps.httpClientOpt.value, deps.sql)
        : makeStubFioApiClient(),
    ),
    Effect.bind('statement', ({ client }) =>
      client.fetchPeriod({ token, from: window.from, to: window.to, teamId: config.team_id }),
    ),
    Effect.tap(({ statement }) =>
      deps.txRepo.upsertMany(
        config.team_id,
        statement.movements.map(
          (m): FioMovementInsert => ({
            fio_movement_id: m.fioMovementId,
            fio_order_id: m.orderId,
            booked_on: m.bookedOn,
            amount_minor: m.amountMinor,
            currency: m.currency,
            variable_symbol: m.variableSymbol,
            constant_symbol: m.constantSymbol,
            specific_symbol: m.specificSymbol,
            counterparty_account: m.counterpartyAccount,
            counterparty_bank_code: m.counterpartyBankCode,
            counterparty_name: m.counterpartyName,
            counterparty_bank_name: m.counterpartyBankName,
            counterparty_bic: m.counterpartyBic,
            payer_reference: m.payerReference,
            message_for_recipient: m.messageForRecipient,
            user_identification: m.userIdentification,
            tx_type: m.txType,
            entered_by: m.enteredBy,
            specification: m.specification,
            comment: m.comment,
            raw: m.raw,
          }),
        ),
      ),
    ),
    Effect.tap(({ statement }) =>
      deps.configRepo.upsertStatementPeriod({
        teamId: config.team_id,
        dateStart: statement.info.dateStart,
        dateEnd: statement.info.dateEnd,
        openingBalanceMinor: statement.info.openingBalanceMinor,
        closingBalanceMinor: statement.info.closingBalanceMinor,
        currency: statement.info.currency,
      }),
    ),
    Effect.map(({ statement }) => statement),
  );

// Runs the (self-contained) matcher over every freshly-ingested, still-unmatched incoming row.
const matchIngested = (
  config: BankSyncConfig.BankSyncConfig,
  deps: TeamDeps,
  movementIds: ReadonlyArray<string>,
) => {
  if (!config.auto_match_enabled || movementIds.length === 0) return Effect.void;
  return deps.sql<{ readonly id: string }>`
    SELECT id::text AS id FROM bank_transactions
    WHERE team_id = ${config.team_id}::uuid AND match_state = 'unmatched'
      AND fio_movement_id = ANY(${movementIds}::bigint[])
  `.pipe(
    Effect.flatMap((rows) =>
      makeMatcher().pipe(
        Effect.provideService(SqlClient.SqlClient, deps.sql),
        Effect.flatMap((matcher) =>
          Effect.forEach(
            rows,
            (row) => matcher.matchOne(Schema.decodeSync(BankTransaction.BankTransactionId)(row.id)),
            { concurrency: 1, discard: true },
          ),
        ),
      ),
    ),
    catchSqlErrors,
  );
};

const runTeamCycle = (config: BankSyncConfig.BankSyncConfig, deps: TeamDeps): Effect.Effect<void> =>
  resolveTokenAndWindow(config, deps).pipe(
    Effect.flatMap(
      Option.match({
        // No token, or the decrypt/key-missing failure was already recorded above.
        onNone: () => Effect.void,
        onSome: ({ token, window }) =>
          fetchAndIngest(config, deps, token, window).pipe(
            Effect.tap(() => deps.configRepo.recordSuccess(config.team_id)),
            Effect.tap(() =>
              window.coverageGap
                ? deps.configRepo.recordCoverageGap(
                    config.team_id,
                    `Outage exceeds the ${String(FIO_HISTORY_WALL_DAYS)}-day Fio history wall — run a backfill.`,
                  )
                : Effect.void,
            ),
            Effect.tap((statement) =>
              matchIngested(
                config,
                deps,
                statement.movements.map((m) => m.fioMovementId),
              ),
            ),
            Effect.asVoid,
            Effect.catchTag('FioServerError', () =>
              deps.configRepo.recordFailure(config.team_id, 'fio_error'),
            ),
            Effect.catchTag('FioRateLimited', () =>
              deps.configRepo.recordFailure(config.team_id, 'rate_limited'),
            ),
            Effect.catchTag('FioTooManyMovements', () =>
              deps.configRepo.recordFailure(config.team_id, 'too_many_movements'),
            ),
            Effect.catchTag('FioHistoryLocked', () =>
              deps.configRepo.recordFailure(config.team_id, 'history_locked'),
            ),
            Effect.catchTag('FioBadRequest', () =>
              deps.configRepo.recordFailure(config.team_id, 'bad_request'),
            ),
            Effect.catchTag('FioResponseInvalid', () =>
              deps.configRepo.recordFailure(config.team_id, 'fio_error'),
            ),
            Effect.catchTag('FioNotConfigured', () =>
              deps.configRepo.recordFailure(config.team_id, 'not_configured'),
            ),
          ),
      }),
    ),
  );

const processTeam = (
  config: BankSyncConfig.BankSyncConfig,
  deps: TeamDeps,
): Effect.Effect<void> => {
  const holder = `${POLL_HOLDER_PREFIX}-${process.pid.toString()}-${Math.random().toString(36).slice(2)}`;

  return deps.configRepo.claimPollLease(config.team_id, holder, POLL_LEASE_SECONDS).pipe(
    Effect.flatMap((leaseOpt) =>
      Option.match(leaseOpt, {
        onNone: () => Effect.void,
        onSome: () =>
          runTeamCycle(config, deps).pipe(
            Effect.timeout(Duration.minutes(TEAM_CYCLE_TIMEOUT_MINUTES)),
            Effect.catchTag('TimeoutError', () =>
              deps.configRepo.recordFailure(config.team_id, 'timeout'),
            ),
            Effect.ensuring(deps.configRepo.releasePollLease(config.team_id, holder)),
          ),
      }),
    ),
    Effect.tapError((e) =>
      Effect.logWarning(`BankSyncPoller: unexpected error for team ${config.team_id}`, e),
    ),
    Effect.exit,
    Effect.asVoid,
  );
};

export const bankSyncPollerEffect: Effect.Effect<
  void,
  never,
  BankSyncConfigRepository | BankTransactionsRepository | FioSecretCrypto | SqlClient.SqlClient
> = Effect.Do.pipe(
  Effect.bind('configRepo', () => BankSyncConfigRepository.asEffect()),
  Effect.bind('txRepo', () => BankTransactionsRepository.asEffect()),
  Effect.bind('crypto', () => FioSecretCrypto.asEffect()),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.bind('httpClientOpt', () => Effect.serviceOption(HttpClient.HttpClient)),
  Effect.tap(() => Effect.logInfo('BankSyncPoller: starting cycle')),
  // Housekeeping — one row per token forever is harmless at this scale, but the delete costs
  // nothing.
  Effect.tap(
    ({ sql }) =>
      sql`DELETE FROM fio_token_throttle WHERE next_call_allowed_at < now() - interval '7 days'`,
  ),
  Effect.bind('configs', ({ configRepo }) => configRepo.findPollable()),
  Effect.tap(({ configs, configRepo, txRepo, crypto, sql, httpClientOpt }) =>
    Effect.all(
      configs.map((config) =>
        processTeam(config, { configRepo, txRepo, crypto, sql, httpClientOpt }),
      ),
      { concurrency: 2 },
    ),
  ),
  Effect.tap(({ configs }) =>
    Effect.logInfo(`BankSyncPoller: cycle complete, ${String(configs.length)} team(s)`),
  ),
  Effect.asVoid,
  catchSqlErrors,
  withCronMetrics('bank-sync-poller'),
);

export const BankSyncPoller = bankSyncPollerEffect.pipe(
  Effect.repeat(Schedule.cron('0 * * * *')),
  Effect.asVoid,
);
