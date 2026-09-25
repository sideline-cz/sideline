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
import { configuredIbanOf, isAccountMismatch } from '~/services/bankSyncAccount.js';
import {
  makeReal as makeRealFioApiClient,
  makeStub as makeStubFioApiClient,
} from '~/services/FioApiClient.js';
import { FioSecretCrypto } from '~/services/FioSecretCrypto.js';
import type { FioDecodedStatement } from '~/services/fioColumns.js';

// Prefix on every auto-created expense's description, so the attribution to the bank-sync
// configurer is self-explanatory wherever the row is read.
const AUTO_EXPENSE_DESCRIPTION_PREFIX = 'Automaticky z bankovního výpisu — ';

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
    // One computation, one source of truth for the whole cycle — gates both writes below.
    Effect.let('mismatch', ({ statement }) => isAccountMismatch(config, statement.info.iban)),
    Effect.tap(({ statement, mismatch }) =>
      mismatch
        ? Effect.void
        : deps.txRepo.upsertMany(
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
    // A period row from a foreign account poisons `deriveBalanceBefore` and the D13 continuity
    // check with balances no ingested movement can ever explain — gated the same as `upsertMany`.
    Effect.tap(({ statement, mismatch }) =>
      mismatch
        ? Effect.void
        : deps.configRepo.upsertStatementPeriod({
            teamId: config.team_id,
            dateStart: statement.info.dateStart,
            dateEnd: statement.info.dateEnd,
            openingBalanceMinor: statement.info.openingBalanceMinor,
            closingBalanceMinor: statement.info.closingBalanceMinor,
            currency: statement.info.currency,
          }),
    ),
    Effect.map(({ statement, mismatch }) => ({ statement, mismatch })),
  );

const dbNow = (deps: TeamDeps) =>
  deps.sql<{ readonly now: Date }>`SELECT now() AS now`.pipe(
    Effect.map((rows) => rows[0]?.now ?? new Date(0)),
    catchSqlErrors,
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

/**
 * Opt-in (`bank_sync_config.auto_create_expenses`): turn every freshly-polled OUTGOING movement
 * into an `expenses` row.
 *
 * Two deliberate decisions live here:
 *
 * 1. **Authorship.** `expenses.created_by_user_id` is `NOT NULL REFERENCES users(id)`, and an
 *    automatic write has no human actor, so the expense is attributed to whoever configured bank
 *    sync. That is a real person's name on a book entry they did not make, which is why the
 *    description says so in plain Czech — the Expenses list and `expense_history` both carry the
 *    explanation. This is a chosen trade-off, not an oversight.
 * 2. **Category.** Nothing in a Fio movement implies one, so every row lands as `'other'` for a
 *    treasurer to re-file. `bank_transaction_id` makes "auto-created, needs filing" a one-column
 *    filter.
 *
 * Scoped to movements FIRST SEEN during this cycle — `fio_movement_id = ANY(...)` alone is not
 * enough, because `computeWindow` re-fetches a rolling >=14-day window on EVERY hourly poll, so
 * that list is "everything in the window", not "everything new". Without the `ingested_at` floor
 * the poller would re-expense a fortnight of history the first time the flag is switched on, and
 * would resurrect any auto-created expense a treasurer deliberately deleted, once an hour, for
 * two weeks. `upsertMany`'s `ON CONFLICT DO UPDATE` deliberately leaves `ingested_at` untouched,
 * so it is a reliable first-seen stamp. `BankSyncBackfill` calls `upsertMany` directly and never
 * reaches this function, so imported history is untouched on that path too.
 *
 * `ON CONFLICT DO NOTHING` on `uq_expenses_bank_transaction_id` makes it idempotent: a re-polled
 * movement that already has an expense is skipped, and a treasurer who created one by hand wins.
 *
 * LIMITATION, by construction: bank data cannot distinguish a real expense from an internal
 * transfer, a member refund, or a returned payment — every outgoing movement becomes an expense.
 * The treasurer's lever is deleting the row, which the `ingested_at` floor above makes permanent.
 */
const autoCreateExpenses = (
  config: BankSyncConfig.BankSyncConfig,
  deps: TeamDeps,
  movementIds: ReadonlyArray<string>,
  cycleStartedAt: Date,
) => {
  if (!config.auto_create_expenses || movementIds.length === 0) return Effect.void;
  return deps.sql<Record<string, never>>`
    INSERT INTO expenses (
      team_id, amount_minor, currency, spent_at, category, description,
      bank_transaction_id, created_by_user_id, updated_by_user_id
    )
    SELECT
      bt.team_id,
      -bt.amount_minor,
      bt.currency,
      -- Noon UTC, mirroring the manual path's dateOnlyToUtcNoon, so the booking date cannot
      -- slide a day under timezone conversion.
      (bt.booked_on::text || ' 12:00:00+00')::timestamptz,
      'other',
      left(
        ${AUTO_EXPENSE_DESCRIPTION_PREFIX}
          || COALESCE(NULLIF(btrim(bt.counterparty_name), ''), 'neznámý příjemce')
          || COALESCE(' — ' || NULLIF(btrim(bt.message_for_recipient), ''), ''),
        500
      ),
      bt.id,
      ${config.configured_by_user_id},
      ${config.configured_by_user_id}
    FROM bank_transactions bt
    WHERE bt.team_id = ${config.team_id}::uuid
      AND bt.direction = 'outgoing'
      AND bt.fio_movement_id = ANY(${movementIds}::bigint[])
      AND bt.ingested_at >= ${cycleStartedAt}
    ON CONFLICT ON CONSTRAINT uq_expenses_bank_transaction_id DO NOTHING
  `.pipe(Effect.asVoid, catchSqlErrors);
};

// D10 — the warning carries both IBANs (club banking identifiers, printed on every QR code — not
// secrets); NEVER the token or a URL. Both `Option`s are `Some` whenever `isAccountMismatch` is
// true; the `'?'` fallbacks exist only so this builder is total.
const accountMismatchWarning = (
  config: BankSyncConfig.BankSyncConfig,
  statement: FioDecodedStatement,
): string =>
  `Fio's token reads ${Option.getOrElse(statement.info.iban, () => '?')} but this team is configured as ${Option.getOrElse(configuredIbanOf(config), () => '?')}. Ingestion halted; fix the account number or the token.`;

const runTeamCycle = (config: BankSyncConfig.BankSyncConfig, deps: TeamDeps): Effect.Effect<void> =>
  // Stamped BEFORE the fetch, so it is a floor no row ingested by this cycle can fall below.
  // Read from the DATABASE clock, not the app's: it is compared against `bank_transactions
  // .ingested_at`, which `now()` stamps server-side, and a replica whose clock runs ahead would
  // otherwise set a floor in the future and silently create nothing.
  Effect.flatMap(dbNow(deps), (cycleStartedAt) =>
    resolveTokenAndWindow(config, deps).pipe(
      Effect.flatMap(
        Option.match({
          // No token, or the decrypt/key-missing failure was already recorded above.
          onNone: () => Effect.void,
          onSome: ({ token, window }) =>
            fetchAndIngest(config, deps, token, window).pipe(
              Effect.flatMap(({ statement, mismatch }) =>
                mismatch
                  ? Effect.logError(
                      'BankSyncPoller: account mismatch — ingestion halted for this team',
                    ).pipe(
                      Effect.annotateLogs({ teamId: config.team_id }),
                      Effect.andThen(
                        deps.configRepo.recordAccountMismatch(
                          config.team_id,
                          accountMismatchWarning(config, statement),
                        ),
                      ),
                    )
                  : Effect.Do.pipe(
                      Effect.tap(() => deps.configRepo.recordSuccess(config.team_id)),
                      Effect.tap(() =>
                        window.coverageGap
                          ? deps.configRepo.recordCoverageGap(
                              config.team_id,
                              `Outage exceeds the ${String(FIO_HISTORY_WALL_DAYS)}-day Fio history wall — run a backfill.`,
                            )
                          : Effect.void,
                      ),
                      Effect.tap(() =>
                        matchIngested(
                          config,
                          deps,
                          statement.movements.map((m) => m.fioMovementId),
                        ),
                      ),
                      // Writes to the club's ledger, so a failure must not vanish: `catchSqlErrors`
                      // turns a `SqlError` into a defect, which `processTeam`'s `Effect.exit`
                      // would otherwise swallow AFTER `recordSuccess` already marked the team
                      // healthy. Log it and let the cycle finish — ingestion itself is committed.
                      Effect.tap(() =>
                        autoCreateExpenses(
                          config,
                          deps,
                          statement.movements.map((m) => m.fioMovementId),
                          cycleStartedAt,
                        ).pipe(
                          Effect.tapDefect((cause) =>
                            Effect.logError(
                              'BankSyncPoller: auto-create expenses failed',
                              cause,
                            ).pipe(Effect.annotateLogs({ teamId: config.team_id })),
                          ),
                          Effect.catchCause(() => Effect.void),
                        ),
                      ),
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
              // `'unreachable'` is deliberately NOT `'fio_error'`, so `isFioError`
              // (`bankSyncStatus.ts`) stays false and the config lands at `sync_failing` rather than
              // escalating to `invalid` — a transport blip is not evidence the token is dead.
              Effect.catchTag('FioUnreachable', () =>
                deps.configRepo.recordFailure(config.team_id, 'unreachable'),
              ),
            ),
        }),
      ),
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
        // `claimLeaseQuery`'s `RETURNING` is the config AS OF the claim, not the `findPollable()`
        // snapshot passed into `processTeam` — with `concurrency: 2` and a 4-minute cycle timeout
        // that snapshot can be minutes stale. Using the stale one here would mean a treasurer's
        // config save (which resets `next_attempt_at`) landing mid-cycle gets overwritten by this
        // cycle's `recordAccountMismatch`/`recordFailure` against the OLD account, making the fix
        // look like it didn't take.
        onSome: (fresh) =>
          runTeamCycle(fresh, deps).pipe(
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
