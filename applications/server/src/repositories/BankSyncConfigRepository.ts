/**
 * Plan `.work-plans/fio-transaction-matching.md` D10b / T5. Mediates the ONLY writes to
 * `bank_sync_config`, `fio_token_throttle` and `bank_statement_periods`.
 */
import { BankSyncConfig, Discord, Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Duration, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export interface StatementPeriodRow {
  readonly dateStart: string;
  readonly dateEnd: string;
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
  readonly currency: string;
}

export interface UpsertBankSyncConfigInput {
  readonly team_id: Team.TeamId;
  readonly enabled: boolean;
  readonly auto_match_enabled: boolean;
  readonly auto_credit_enabled: Option.Option<boolean>;
  readonly auto_create_expenses: boolean;
  readonly account_prefix: Option.Option<string>;
  readonly account_number: Option.Option<string>;
  readonly bank_code: Option.Option<string>;
  readonly currency: string;
  readonly recipient_name: Option.Option<string>;
  readonly registered_id: Option.Option<string>;
  readonly registered_address: Option.Option<string>;
  readonly bank_name: Option.Option<string>;
  readonly fio_token_encrypted: Option.Option<string>;
  readonly fio_token_created_at: Option.Option<string>;
  readonly configured_by_user_id: string;
}

const StatementPeriodResult = Schema.Struct({
  date_start: Schema.String,
  date_end: Schema.String,
  opening_balance_minor: Schema.Union([Schema.Number, Schema.NumberFromString]),
  closing_balance_minor: Schema.Union([Schema.Number, Schema.NumberFromString]),
  currency: Schema.String,
});

/**
 * Row produced by `findExpiringCandidates` — `BankTokenExpiryCron`'s (T10b) driving query. A
 * candidate is a `(team, threshold_days)` pair whose Fio token (`token_created_at + 180 days`) is
 * EXACTLY 14, 7, or 1 calendar day(s) (UTC) from expiry right now, that has never been recorded
 * in `bank_token_expiry_sent` for this `token_created_at`, and that has no pending (unprocessed)
 * `bank_token_expiry_events` row already outstanding for the same threshold.
 */
class BankTokenExpiryCandidateRow extends Schema.Class<BankTokenExpiryCandidateRow>(
  'BankTokenExpiryCandidateRow',
)({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  user_discord_id: Discord.Snowflake,
  token_created_at: Schema.Date,
  token_expires_at: Schema.Date,
  threshold_days: Schema.Int,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const SELECT_COLUMNS = sql`
    team_id, provider, enabled, auto_match_enabled, auto_credit_enabled, auto_create_expenses,
    account_prefix, account_number, bank_code, iban, currency,
    recipient_name, registered_id, registered_address, bank_name,
    fio_token_encrypted, fio_token_created_at, fio_token_saved_at,
    backfill_from, backfill_cursor, backfill_status, backfill_run_id,
    last_synced_at, last_success_at, last_error_code, last_error_at,
    consecutive_failure_count, next_attempt_at, coverage_warning,
    poll_leased_until, poll_leased_by,
    configured_by_user_id, created_at, updated_at
  `;

  const findByTeamQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: BankSyncConfig.BankSyncConfig,
    execute: (teamId) =>
      sql`SELECT ${SELECT_COLUMNS} FROM bank_sync_config WHERE team_id = ${teamId}`,
  });

  const findPollableQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BankSyncConfig.BankSyncConfig,
    execute: () => sql`
      SELECT ${SELECT_COLUMNS} FROM bank_sync_config
      WHERE enabled = true AND fio_token_encrypted IS NOT NULL
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
    `,
  });

  // See `BankTokenExpiryCandidateRow` above. `candidates` computes the calendar-day distance to
  // expiry in UTC (both sides of the subtraction go through `AT TIME ZONE 'UTC'` so the result
  // never depends on the DB session's `TimeZone` setting), then the outer SELECT keeps only the
  // exact T-14/T-7/T-1 matches that are neither already recorded as sent nor already pending in
  // the outbox — an already-expired token's day-diff only ever equals one of these three values
  // once, in the past, so it naturally stops matching (and therefore stops firing) once it does.
  const findExpiringCandidatesQuery = SqlSchema.findAll({
    Request: Schema.Date,
    Result: BankTokenExpiryCandidateRow,
    execute: (now) => sql`
      WITH candidates AS (
        SELECT
          bsc.team_id,
          t.guild_id,
          u.discord_id AS user_discord_id,
          bsc.fio_token_created_at AS token_created_at,
          (bsc.fio_token_created_at + interval '180 days') AS token_expires_at,
          (
            DATE((bsc.fio_token_created_at + interval '180 days') AT TIME ZONE 'UTC')
            - DATE(${now}::timestamptz AT TIME ZONE 'UTC')
          ) AS threshold_days
        FROM bank_sync_config bsc
        JOIN teams t ON t.id = bsc.team_id
        JOIN users u ON u.id = bsc.configured_by_user_id
        WHERE bsc.enabled = true
          AND bsc.fio_token_encrypted IS NOT NULL
          AND bsc.fio_token_created_at IS NOT NULL
      )
      SELECT
        c.team_id, c.guild_id, c.user_discord_id, c.token_created_at, c.token_expires_at,
        c.threshold_days
      FROM candidates c
      WHERE c.threshold_days IN (14, 7, 1)
        AND NOT EXISTS (
          SELECT 1 FROM bank_token_expiry_sent bts
          WHERE bts.team_id = c.team_id
            AND bts.token_created_at = c.token_created_at
            AND bts.threshold_days = c.threshold_days
        )
        AND NOT EXISTS (
          SELECT 1 FROM bank_token_expiry_events bte
          WHERE bte.team_id = c.team_id
            AND bte.threshold_days = c.threshold_days
            AND bte.processed_at IS NULL
        )
    `,
  });

  const upsertQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      enabled: Schema.Boolean,
      auto_match_enabled: Schema.Boolean,
      auto_credit_enabled: Schema.OptionFromNullOr(Schema.Boolean),
      auto_create_expenses: Schema.Boolean,
      account_prefix: Schema.OptionFromNullOr(Schema.String),
      account_number: Schema.OptionFromNullOr(Schema.String),
      bank_code: Schema.OptionFromNullOr(Schema.String),
      currency: Schema.String,
      recipient_name: Schema.OptionFromNullOr(Schema.String),
      registered_id: Schema.OptionFromNullOr(Schema.String),
      registered_address: Schema.OptionFromNullOr(Schema.String),
      bank_name: Schema.OptionFromNullOr(Schema.String),
      fio_token_encrypted: Schema.OptionFromNullOr(Schema.String),
      fio_token_created_at: Schema.OptionFromNullOr(Schema.String),
      configured_by_user_id: Schema.String,
    }),
    Result: BankSyncConfig.BankSyncConfig,
    execute: (input) => sql`
      INSERT INTO bank_sync_config (
        team_id, enabled, auto_match_enabled, auto_credit_enabled, auto_create_expenses,
        account_prefix, account_number, bank_code, currency,
        recipient_name, registered_id, registered_address, bank_name,
        fio_token_encrypted, fio_token_created_at, fio_token_saved_at, configured_by_user_id
      ) VALUES (
        ${input.team_id}, ${input.enabled}, ${input.auto_match_enabled},
        -- ::boolean is load-bearing for the same reason fio_token_created_at's ::text is: the
        -- template emits a distinct placeholder per interpolation, so this parameter inherits
        -- no type from the one in the DO UPDATE clause below.
        COALESCE(${input.auto_credit_enabled}::boolean, false),
        ${input.auto_create_expenses},
        ${input.account_prefix}, ${input.account_number}, ${input.bank_code}, ${input.currency},
        ${input.recipient_name}, ${input.registered_id}, ${input.registered_address}, ${input.bank_name},
        ${input.fio_token_encrypted}, ${input.fio_token_created_at}::timestamptz,
        -- Server clock, never the caller's: see the fio_token_saved_at note on the model. The
        -- ::text cast is load-bearing — the sql template emits a DISTINCT placeholder per
        -- interpolation, so this is a second parameter that does not inherit the type the one
        -- above gets from the fio_token_encrypted TEXT column, and IS NOT NULL contributes no
        -- type information of its own. Without it Postgres fails at PARSE time with
        -- "could not determine data type of parameter", breaking every save.
        CASE WHEN ${input.fio_token_encrypted}::text IS NOT NULL THEN now() END,
        ${input.configured_by_user_id}
      )
      ON CONFLICT (team_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        auto_match_enabled = EXCLUDED.auto_match_enabled,
        -- the parameter, not EXCLUDED: EXCLUDED already COALESCEd absent to false above,
        -- which would silently switch the flag off for every save from an older bundle.
        auto_credit_enabled = COALESCE(${input.auto_credit_enabled}::boolean, bank_sync_config.auto_credit_enabled),
        auto_create_expenses = EXCLUDED.auto_create_expenses,
        account_prefix = EXCLUDED.account_prefix,
        account_number = EXCLUDED.account_number,
        bank_code = EXCLUDED.bank_code,
        currency = EXCLUDED.currency,
        recipient_name = EXCLUDED.recipient_name,
        registered_id = EXCLUDED.registered_id,
        registered_address = EXCLUDED.registered_address,
        bank_name = EXCLUDED.bank_name,
        -- absent (NULL) token means "keep the stored token" — mirrors
        -- EmailForwardingConfigRepository.upsertQuery's imap_secret_encrypted line.
        fio_token_encrypted = COALESCE(EXCLUDED.fio_token_encrypted, bank_sync_config.fio_token_encrypted),
        fio_token_created_at = COALESCE(EXCLUDED.fio_token_created_at, bank_sync_config.fio_token_created_at),
        -- No cast needed here, unlike the INSERT above: EXCLUDED.fio_token_encrypted is a typed
        -- column reference, not a parameter.
        fio_token_saved_at = CASE WHEN EXCLUDED.fio_token_encrypted IS NOT NULL
                                  THEN now() ELSE bank_sync_config.fio_token_saved_at END,
        configured_by_user_id = EXCLUDED.configured_by_user_id,
        -- every save resets backoff bookkeeping (test 99).
        consecutive_failure_count = 0,
        next_attempt_at = NULL,
        updated_at = now()
      RETURNING ${SELECT_COLUMNS}
    `,
  });

  // Distributed poll lease (D10b(b)). ALSO used by `/rematch` (D10b(c)) under a separate pair of
  // public methods with a shorter lease duration — the migration has only ONE lease column pair,
  // shared deliberately: a poll cycle and a manual rematch must not run concurrently over the
  // same team's rows regardless of which one asked first.
  const claimLeaseQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      holder: Schema.String,
      lease_seconds: Schema.Number,
    }),
    Result: BankSyncConfig.BankSyncConfig,
    execute: (input) => sql`
      UPDATE bank_sync_config
         SET poll_leased_until = now() + (${input.lease_seconds}::text || ' seconds')::interval,
             poll_leased_by = ${input.holder}, updated_at = now()
       WHERE team_id = ${input.team_id} AND (poll_leased_until IS NULL OR poll_leased_until < now())
       RETURNING ${SELECT_COLUMNS}
    `,
  });

  // [R4 — defect f] Guarded by the holder — without `AND poll_leased_by = holder`, a cycle that
  // overran its lease would clear WHOEVER holds it now, handing the same team to two replicas.
  const releaseLeaseQuery = SqlSchema.void({
    Request: Schema.Struct({ team_id: Team.TeamId, holder: Schema.String }),
    execute: (input) => sql`
      UPDATE bank_sync_config SET poll_leased_until = NULL, poll_leased_by = NULL, updated_at = now()
       WHERE team_id = ${input.team_id} AND poll_leased_by = ${input.holder}
    `,
  });

  // `coverage_warning` is only ever WRITTEN by `recordCoverageGap` and `recordAccountMismatch` —
  // nothing else clears it, so without this a stale gap/mismatch message (the mismatch text is an
  // imperative in the present tense: "Ingestion halted; fix the account number or the token")
  // would outlive whatever produced it and mislead the next investigation indefinitely. A real
  // success is exactly the signal that the previously-reported condition, whatever it was, no
  // longer holds.
  const recordSuccessQuery = SqlSchema.void({
    Request: Team.TeamId,
    execute: (teamId) => sql`
      UPDATE bank_sync_config
      SET last_synced_at = now(), last_success_at = now(),
          consecutive_failure_count = 0, last_error_code = NULL, last_error_at = NULL,
          next_attempt_at = NULL, coverage_warning = NULL, updated_at = now()
      WHERE team_id = ${teamId}
    `,
  });

  const recordFailureQuery = SqlSchema.void({
    Request: Schema.Struct({ team_id: Team.TeamId, error_code: Schema.String }),
    execute: (input) => sql`
      UPDATE bank_sync_config
      SET last_synced_at = now(), last_error_code = ${input.error_code}, last_error_at = now(),
          consecutive_failure_count = consecutive_failure_count + 1,
          next_attempt_at = now()
            + (LEAST(POWER(2, consecutive_failure_count + 1), 24)::text || ' hours')::interval,
          updated_at = now()
      WHERE team_id = ${input.team_id}
    `,
  });

  const recordCoverageGapQuery = SqlSchema.void({
    Request: Schema.Struct({ team_id: Team.TeamId, warning: Schema.String }),
    execute: (input) => sql`
      UPDATE bank_sync_config
      SET last_error_code = 'coverage_gap', last_error_at = now(), coverage_warning = ${input.warning},
          updated_at = now()
      WHERE team_id = ${input.team_id}
    `,
  });

  // A mismatch is a Fio SUCCESS we refuse to ingest. `recordSuccess` is therefore wrong (it clears
  // `last_error_code`, which alone ranks the card `ok` — a silently halted import), and plain
  // `recordFailure` loses the human-readable reason support needs. One UPDATE, so the error code
  // and the warning can never disagree. `consecutive_failure_count` is deliberately NOT
  // touched: that counter grades the TOKEN (it feeds the D11 `invalid` escalation's
  // `>= 3` gate in `bankSyncStatus.ts`), and a mismatch is not evidence about the token — bumping
  // it would let a run of mismatched polls poison the very count that is supposed to require
  // three REAL Fio failures before telling the treasurer their token is dead. Backoff is a flat
  // 6 hours, not exponential: the condition is terminal until a human edits the config, so growing
  // the delay buys nothing, and a successful `/bank-sync/test` afterwards clears it
  // (`clearPollBackoff`) well before that anyway.
  const recordAccountMismatchQuery = SqlSchema.void({
    Request: Schema.Struct({ team_id: Team.TeamId, warning: Schema.String }),
    execute: (input) => sql`
      UPDATE bank_sync_config
      SET last_synced_at = now(), last_error_code = 'account_mismatch', last_error_at = now(),
          coverage_warning = ${input.warning},
          next_attempt_at = now() + interval '6 hours',
          updated_at = now()
      WHERE team_id = ${input.team_id}
    `,
  });

  // B1 — a UI button must NEVER call `recordSuccess`. That would clear `last_error_code`, and
  // `bankSyncStatus.ts:70` (`if (Option.isNone(input.lastErrorCode)) return 'ok'`) ranks the card
  // `ok` off that alone. The probe's window is 2 days; the poller's is 14 (`BankSyncPoller.ts:39`,
  // `computeWindow` :64-73), so a 200 on the probe is NOT evidence the import works. It would also
  // reset `last_success_at`, the `silenceBaseline` for the D11 `invalid` rank (:73), letting
  // repeated clicks suppress `invalid` forever; and it does not clear `coverage_warning`.
  // This does 100% of the useful work — un-sticking the exponential poll backoff that
  // `findPollableQuery` (:84-92) filters on — and touches nothing D11 reads.
  const clearPollBackoffQuery = SqlSchema.void({
    Request: Team.TeamId,
    execute: (teamId) => sql`
      UPDATE bank_sync_config SET next_attempt_at = NULL, updated_at = now()
       WHERE team_id = ${teamId}
    `,
  });
  const clearPollBackoff = (teamId: Team.TeamId) =>
    clearPollBackoffQuery(teamId).pipe(catchSqlErrors);

  const upsertStatementPeriodQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      date_start: Schema.String,
      date_end: Schema.String,
      opening_balance_minor: Schema.Number,
      closing_balance_minor: Schema.Number,
      currency: Schema.String,
    }),
    execute: (input) => sql`
      INSERT INTO bank_statement_periods (
        team_id, date_start, date_end, opening_balance_minor, closing_balance_minor, currency
      ) VALUES (
        ${input.team_id}, ${input.date_start}::date, ${input.date_end}::date,
        ${input.opening_balance_minor}, ${input.closing_balance_minor}, ${input.currency}
      )
      ON CONFLICT (team_id, date_start, date_end) DO UPDATE SET
        opening_balance_minor = EXCLUDED.opening_balance_minor,
        closing_balance_minor = EXCLUDED.closing_balance_minor,
        currency = EXCLUDED.currency,
        fetched_at = now()
    `,
  });

  const findStatementPeriodsQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: StatementPeriodResult,
    execute: (teamId) => sql`
      SELECT date_start::text AS date_start, date_end::text AS date_end,
             opening_balance_minor, closing_balance_minor, currency
      FROM bank_statement_periods WHERE team_id = ${teamId}
      ORDER BY date_start ASC
    `,
  });

  // Backfill walk bookkeeping (§5) — the forked fiber writes this after each chunk so a crash
  // resumes from `backfill_cursor` rather than restarting.
  const updateBackfillProgressQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      backfill_from: Schema.OptionFromNullOr(Schema.String),
      backfill_cursor: Schema.OptionFromNullOr(Schema.String),
      backfill_status: Schema.OptionFromNullOr(BankSyncConfig.BankSyncBackfillStatus),
      backfill_run_id: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) => sql`
      UPDATE bank_sync_config
      SET backfill_from = COALESCE(${input.backfill_from}::date, backfill_from),
          backfill_cursor = COALESCE(${input.backfill_cursor}::date, backfill_cursor),
          backfill_status = ${input.backfill_status},
          backfill_run_id = ${input.backfill_run_id}::uuid,
          updated_at = now()
      WHERE team_id = ${input.team_id}
    `,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const findByTeam = (teamId: Team.TeamId) => findByTeamQuery(teamId).pipe(catchSqlErrors);

  const findPollable = () => findPollableQuery(undefined).pipe(catchSqlErrors);

  const findExpiringCandidates = (now: Date) =>
    findExpiringCandidatesQuery(now).pipe(catchSqlErrors);

  const upsert = (input: UpsertBankSyncConfigInput) =>
    upsertQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die(`Failed upserting bank_sync_config for team ${input.team_id}`),
      ),
    );

  const claimPollLease = (teamId: Team.TeamId, holder: string, leaseSeconds: number) =>
    claimLeaseQuery({ team_id: teamId, holder, lease_seconds: leaseSeconds }).pipe(catchSqlErrors);

  const releasePollLease = (teamId: Team.TeamId, holder: string) =>
    releaseLeaseQuery({ team_id: teamId, holder }).pipe(catchSqlErrors);

  const claimRematchLease = (teamId: Team.TeamId, holder: string, leaseSeconds: number) =>
    claimLeaseQuery({ team_id: teamId, holder, lease_seconds: leaseSeconds }).pipe(catchSqlErrors);

  const releaseRematchLease = (teamId: Team.TeamId, holder: string) =>
    releaseLeaseQuery({ team_id: teamId, holder }).pipe(catchSqlErrors);

  // D10b(a)/e(i)/e(ii) — a SINGLE autocommitted UPSERT statement. Returns a DURATION, never a DB
  // timestamp — the caller sleeps on the REPLICA's clock. This method's caller (`FioApiClient`)
  // must never wrap it in `sql.withTransaction`.
  //
  // NOTE — two copies of this SQL exist. `FioApiClient.ts`'s `makeReal` inlines the same
  // reservation directly (closing over its OWN captured `SqlClient.SqlClient`, per that file's
  // header comment: every query in a token-containment-sensitive path must run on the exact
  // connection instance the function was built with) rather than depending on this repository as
  // an ambient service. THIS copy is not currently wired to any production caller, but is kept —
  // rather than deleted — because `test/integration/repositories/BankSyncConfigRepository.test.ts`
  // tests 102/102b pin the reservation's autocommit invariant (D10b defect e(ii): the reservation
  // must never be wrapped in a lingering transaction) against the REPOSITORY's public contract,
  // independent of `FioApiClient`. Keep the two arithmetically identical — this one MUST carry the
  // same `Math.ceil` round-up-never-down fix as `FioApiClient.ts`'s copy, or wiring this one in
  // later would silently reintroduce a sub-30s throttle.
  //
  // `FioApiClient.ts`'s copy additionally carries a `maxWaitSeconds` budget guard on the conflict
  // `WHERE` clause (`/bank-sync/test`'s atomic throttle pre-check). That guard is intentionally
  // NOT mirrored here: this method has no caller that wants a "busy beyond budget" verdict (its
  // only consumer is 102/102b, which assert the autocommit property alone, not the budget), and
  // mirroring it would mean either threading a `FioRateLimited`-shaped failure through a
  // repository that otherwise never fails with a Fio-domain error, or silently swallowing the
  // "no row returned" case — both worse than the small, documented divergence here. If this
  // method ever gains a real caller that needs the budget check, add the identical `WHERE`
  // guard from `FioApiClient.ts` at that point, not before.
  const reserveThrottleSlot = (tokenFingerprint: string) =>
    sql<{ readonly wait_seconds: number | string }>`
      INSERT INTO fio_token_throttle (token_fingerprint, next_call_allowed_at)
      VALUES (${tokenFingerprint}, now() + interval '30 seconds')
      ON CONFLICT (token_fingerprint) DO UPDATE
        SET next_call_allowed_at = GREATEST(fio_token_throttle.next_call_allowed_at, now())
                                    + interval '30 seconds'
      RETURNING GREATEST(
        EXTRACT(EPOCH FROM (next_call_allowed_at - interval '30 seconds' - now())), 0
      )::float8 AS wait_seconds
    `.pipe(
      catchSqlErrors,
      Effect.map((rows) =>
        Duration.millis(Math.max(0, Math.ceil(Number(rows[0]?.wait_seconds ?? 0) * 1000))),
      ),
    );

  const recordSuccess = (teamId: Team.TeamId) => recordSuccessQuery(teamId).pipe(catchSqlErrors);

  const recordFailure = (teamId: Team.TeamId, errorCode: string) =>
    recordFailureQuery({ team_id: teamId, error_code: errorCode }).pipe(catchSqlErrors);

  const recordCoverageGap = (teamId: Team.TeamId, warning: string) =>
    recordCoverageGapQuery({ team_id: teamId, warning }).pipe(catchSqlErrors);

  const recordAccountMismatch = (teamId: Team.TeamId, warning: string) =>
    recordAccountMismatchQuery({ team_id: teamId, warning }).pipe(catchSqlErrors);

  const upsertStatementPeriod = (input: {
    readonly teamId: Team.TeamId;
    readonly dateStart: string;
    readonly dateEnd: string;
    readonly openingBalanceMinor: number;
    readonly closingBalanceMinor: number;
    readonly currency: string;
  }) =>
    upsertStatementPeriodQuery({
      team_id: input.teamId,
      date_start: input.dateStart,
      date_end: input.dateEnd,
      opening_balance_minor: input.openingBalanceMinor,
      closing_balance_minor: input.closingBalanceMinor,
      currency: input.currency,
    }).pipe(catchSqlErrors);

  const findStatementPeriods = (
    teamId: Team.TeamId,
  ): Effect.Effect<ReadonlyArray<StatementPeriodRow>, never, never> =>
    findStatementPeriodsQuery(teamId).pipe(
      catchSqlErrors,
      Effect.map((rows) =>
        rows.map((row) => ({
          dateStart: row.date_start,
          dateEnd: row.date_end,
          openingBalanceMinor: row.opening_balance_minor,
          closingBalanceMinor: row.closing_balance_minor,
          currency: row.currency,
        })),
      ),
    );

  const updateBackfillProgress = (input: {
    readonly teamId: Team.TeamId;
    readonly backfillFrom: Option.Option<string>;
    readonly backfillCursor: Option.Option<string>;
    readonly backfillStatus: Option.Option<BankSyncConfig.BankSyncBackfillStatus>;
    readonly backfillRunId: Option.Option<string>;
  }) =>
    updateBackfillProgressQuery({
      team_id: input.teamId,
      backfill_from: input.backfillFrom,
      backfill_cursor: input.backfillCursor,
      backfill_status: input.backfillStatus,
      backfill_run_id: input.backfillRunId,
    }).pipe(catchSqlErrors);

  return {
    findByTeam,
    upsert,
    findPollable,
    findExpiringCandidates,
    claimPollLease,
    releasePollLease,
    claimRematchLease,
    releaseRematchLease,
    reserveThrottleSlot,
    recordSuccess,
    recordFailure,
    recordCoverageGap,
    recordAccountMismatch,
    clearPollBackoff,
    upsertStatementPeriod,
    findStatementPeriods,
    updateBackfillProgress,
  };
});

export class BankSyncConfigRepository extends ServiceMap.Service<
  BankSyncConfigRepository,
  Effect.Success<typeof make>
>()('api/BankSyncConfigRepository') {
  static readonly Default = Layer.effect(BankSyncConfigRepository, make);
}
