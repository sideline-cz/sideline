/**
 * Plan `.work-plans/fio-transaction-matching.md` D4 / D16 / T5. Mediates writes to
 * `bank_transactions`.
 *
 * `BankTransactionMatcher` (T8) deliberately does NOT go through this repository for its own
 * reads/writes — it needs every query to run on the SAME connection that holds its row locks
 * (see that file's header comment), so it uses its own captured `SqlClient.SqlClient` directly.
 * This repository serves `BankSyncPoller` (ingestion, via `upsertMany`) and the (out-of-scope,
 * T9) queue API.
 */
import { Auth, BankTransaction, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export interface FioMovementInsert {
  readonly fio_movement_id: number | string;
  readonly fio_order_id?: Option.Option<string>;
  readonly booked_on: string;
  readonly amount_minor: number;
  readonly currency: string;
  readonly variable_symbol?: Option.Option<string>;
  readonly constant_symbol?: Option.Option<string>;
  readonly specific_symbol?: Option.Option<string>;
  readonly counterparty_account?: Option.Option<string>;
  readonly counterparty_bank_code?: Option.Option<string>;
  readonly counterparty_name?: Option.Option<string>;
  readonly counterparty_bank_name?: Option.Option<string>;
  readonly counterparty_bic?: Option.Option<string>;
  readonly payer_reference?: Option.Option<string>;
  readonly message_for_recipient?: Option.Option<string>;
  readonly user_identification?: Option.Option<string>;
  readonly tx_type?: Option.Option<string>;
  readonly entered_by?: Option.Option<string>;
  readonly specification?: Option.Option<string>;
  readonly comment?: Option.Option<string>;
  readonly raw: unknown;
}

export interface ListByTeamFilters {
  readonly from?: Option.Option<string>;
  readonly to?: Option.Option<string>;
  readonly state?: Option.Option<BankTransaction.BankTransactionMatchState>;
  readonly direction?: Option.Option<BankTransaction.BankTransactionDirection>;
  readonly reason?: Option.Option<BankTransaction.BankTransactionMatchReason>;
  readonly q?: Option.Option<string>;
}

export interface BulkResolveResult {
  readonly resolvedCount: number;
}

const opt = <A>(v: Option.Option<A> | undefined): Option.Option<A> => v ?? Option.none();

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const SELECT_COLUMNS = sql`
    id, team_id, provider, fio_movement_id::text AS fio_movement_id, fio_order_id,
    booked_on::text AS booked_on, amount_minor, direction, currency,
    variable_symbol, constant_symbol, specific_symbol,
    counterparty_account, counterparty_bank_code, counterparty_name, counterparty_bank_name,
    counterparty_bic, payer_reference,
    message_for_recipient, user_identification, tx_type, entered_by, specification, comment,
    match_state, match_reason, match_evidence, auto_match_suppressed,
    ignored_reason, ignored_by_user_id, resolution_kind,
    raw, ingested_at, updated_at
  `;

  const upsertManyQuery = (teamId: Team.TeamId, movements: ReadonlyArray<FioMovementInsert>) => {
    if (movements.length === 0)
      return Effect.succeed<ReadonlyArray<BankTransaction.BankTransaction>>([]);
    const rows = movements.map((m) => {
      const matchState = m.amount_minor < 0 ? 'not_applicable' : 'unmatched';
      return sql`(
        ${teamId}, ${String(m.fio_movement_id)}::bigint,
        ${Option.getOrNull(opt(m.fio_order_id))}, ${m.booked_on}::date, ${m.amount_minor}, ${m.currency},
        ${Option.getOrNull(opt(m.variable_symbol))}, ${Option.getOrNull(opt(m.constant_symbol))},
        ${Option.getOrNull(opt(m.specific_symbol))},
        ${Option.getOrNull(opt(m.counterparty_account))}, ${Option.getOrNull(opt(m.counterparty_bank_code))},
        ${Option.getOrNull(opt(m.counterparty_name))}, ${Option.getOrNull(opt(m.counterparty_bank_name))},
        ${Option.getOrNull(opt(m.counterparty_bic))}, ${Option.getOrNull(opt(m.payer_reference))},
        ${Option.getOrNull(opt(m.message_for_recipient))}, ${Option.getOrNull(opt(m.user_identification))},
        ${Option.getOrNull(opt(m.tx_type))}, ${Option.getOrNull(opt(m.entered_by))},
        ${Option.getOrNull(opt(m.specification))}, ${Option.getOrNull(opt(m.comment))},
        ${matchState}, ${JSON.stringify(m.raw)}::jsonb
      )`;
    });
    return sql`
      INSERT INTO bank_transactions (
        team_id, fio_movement_id, fio_order_id, booked_on, amount_minor, currency,
        variable_symbol, constant_symbol, specific_symbol,
        counterparty_account, counterparty_bank_code, counterparty_name, counterparty_bank_name,
        counterparty_bic, payer_reference,
        message_for_recipient, user_identification, tx_type, entered_by, specification, comment,
        match_state, raw
      )
      VALUES ${sql.join(',', false)(rows)}
      -- Never resets match_state or clears any match link on re-import; ingested_at is untouched.
      ON CONFLICT (team_id, provider, fio_movement_id) DO UPDATE SET
        raw = EXCLUDED.raw, updated_at = now()
      RETURNING ${SELECT_COLUMNS}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BankTransaction.BankTransaction))),
    );
  };

  const findByIdQuery = SqlSchema.findOneOption({
    Request: BankTransaction.BankTransactionId,
    Result: BankTransaction.BankTransaction,
    execute: (id) => sql`SELECT ${SELECT_COLUMNS} FROM bank_transactions WHERE id = ${id}`,
  });

  const findByIdAndTeamQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: BankTransaction.BankTransactionId, team_id: Team.TeamId }),
    Result: BankTransaction.BankTransaction,
    execute: (input) => sql`
      SELECT ${SELECT_COLUMNS} FROM bank_transactions WHERE id = ${input.id} AND team_id = ${input.team_id}
    `,
  });

  // Step 2.5 — another INCOMING row in the same team, same normalised VS, same amount, within
  // +-7 days, already matched. Precedes every auto-match decision.
  const findDuplicateCandidateQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      exclude_id: BankTransaction.BankTransactionId,
      vs_norm: Schema.String,
      amount_minor: Schema.Number,
      booked_on: Schema.String,
    }),
    Result: BankTransaction.BankTransaction,
    execute: (input) => sql`
      SELECT ${SELECT_COLUMNS} FROM bank_transactions
      WHERE team_id = ${input.team_id} AND id <> ${input.exclude_id}
        AND direction = 'incoming' AND match_state = 'matched'
        AND amount_minor = ${input.amount_minor}
        AND NULLIF(ltrim(variable_symbol, '0'), '') = ${input.vs_norm}
        AND booked_on BETWEEN ${input.booked_on}::date - 7 AND ${input.booked_on}::date + 7
      LIMIT 1
    `,
  });

  const findUnmatchedForTeamQuery = SqlSchema.findAll({
    Request: Schema.Struct({ team_id: Team.TeamId, since: Schema.String }),
    Result: BankTransaction.BankTransaction,
    execute: (input) => sql`
      SELECT ${SELECT_COLUMNS} FROM bank_transactions
      WHERE team_id = ${input.team_id} AND match_state IN ('unmatched', 'partially_matched')
        AND auto_match_suppressed = false AND booked_on >= ${input.since}::date
      ORDER BY booked_on ASC, id ASC
    `,
  });

  const updateMatchEvidenceQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: BankTransaction.BankTransactionId,
      match_reason: Schema.OptionFromNullOr(BankTransaction.BankTransactionMatchReason),
      // Pre-serialised by the caller (`updateMatchEvidence` below) — `Schema.Unknown` inside
      // `OptionFromNullOr` does not round-trip through this SqlSchema request decode cleanly.
      match_evidence_json: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) => sql`
      UPDATE bank_transactions
      SET match_reason = ${input.match_reason},
          match_evidence = ${input.match_evidence_json}::jsonb,
          updated_at = now()
      WHERE id = ${input.id}
    `,
  });

  // No un-guarded write: only a row still in ('unmatched','partially_matched') may become
  // 'ignored' — a matched transaction with live payments (or one the poller just claimed) must
  // never be flipped, since the trigger returns early forever once match_state is terminal
  // (`recompute_bank_match_state`'s `IF v_state IN ('ignored','not_applicable') THEN RETURN`).
  const ignoreQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: BankTransaction.BankTransactionId,
      kind: BankTransaction.BankTransactionResolutionKind,
      reason: Schema.String,
      ignored_by_user_id: Auth.UserId,
    }),
    Result: BankTransaction.BankTransaction,
    execute: (input) => sql`
      UPDATE bank_transactions
      SET match_state = 'ignored', resolution_kind = ${input.kind},
          ignored_reason = ${input.reason}, ignored_by_user_id = ${input.ignored_by_user_id},
          updated_at = now()
      WHERE id = ${input.id} AND match_state IN ('unmatched', 'partially_matched')
      RETURNING ${SELECT_COLUMNS}
    `,
  });

  const bulkIgnoreQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      ids: Schema.Array(BankTransaction.BankTransactionId),
      kind: BankTransaction.BankTransactionResolutionKind,
      reason: Schema.String,
      ignored_by_user_id: Auth.UserId,
    }),
    Result: Schema.Struct({ id: BankTransaction.BankTransactionId }),
    execute: (input) => sql`
      UPDATE bank_transactions
      SET match_state = 'ignored', resolution_kind = ${input.kind},
          ignored_reason = ${input.reason}, ignored_by_user_id = ${input.ignored_by_user_id},
          updated_at = now()
      WHERE team_id = ${input.team_id} AND id = ANY(${input.ids})
        AND match_state IN ('unmatched', 'partially_matched')
      RETURNING id
    `,
  });

  // The un-ignore path (BLOCKER 3): clears the terminal state back to 'unmatched' and suppresses
  // auto-match so the poller does not immediately re-claim the row the treasurer is now looking
  // at. Only a row actually in 'ignored' may be un-ignored.
  const unignoreQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: BankTransaction.BankTransactionId, team_id: Team.TeamId }),
    Result: BankTransaction.BankTransaction,
    execute: (input) => sql`
      UPDATE bank_transactions
      SET match_state = 'unmatched', resolution_kind = NULL,
          ignored_reason = NULL, ignored_by_user_id = NULL,
          auto_match_suppressed = true, updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND match_state = 'ignored'
      RETURNING ${SELECT_COLUMNS}
    `,
  });

  const suppressAutoMatchQuery = SqlSchema.void({
    Request: Schema.Struct({ id: BankTransaction.BankTransactionId }),
    execute: (input) => sql`
      UPDATE bank_transactions SET auto_match_suppressed = true, match_reason = NULL, updated_at = now()
      WHERE id = ${input.id}
    `,
  });

  const clearAutoMatchSuppressionQuery = SqlSchema.void({
    Request: Schema.Struct({ id: BankTransaction.BankTransactionId }),
    execute: (input) => sql`
      UPDATE bank_transactions SET auto_match_suppressed = false, updated_at = now()
      WHERE id = ${input.id}
    `,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const upsertMany = (teamId: Team.TeamId, movements: ReadonlyArray<FioMovementInsert>) =>
    upsertManyQuery(teamId, movements).pipe(catchSqlErrors);

  const findById = (id: BankTransaction.BankTransactionId) =>
    findByIdQuery(id).pipe(catchSqlErrors);

  const findByIdAndTeam = (id: BankTransaction.BankTransactionId, teamId: Team.TeamId) =>
    findByIdAndTeamQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const listByTeam = (teamId: Team.TeamId, filters: ListByTeamFilters) => {
    const from = opt(filters.from);
    const to = opt(filters.to);
    const state = opt(filters.state);
    const direction = opt(filters.direction);
    const reason = opt(filters.reason);
    const q = opt(filters.q);
    return sql`
      SELECT ${SELECT_COLUMNS} FROM bank_transactions
      WHERE team_id = ${teamId}
        AND (${Option.isNone(from)} OR booked_on >= ${Option.getOrNull(from)}::date)
        AND (${Option.isNone(to)} OR booked_on <= ${Option.getOrNull(to)}::date)
        AND (${Option.isNone(state)} OR match_state = ${Option.getOrNull(state)})
        AND (${Option.isNone(direction)} OR direction = ${Option.getOrNull(direction)})
        AND (${Option.isNone(reason)} OR match_reason = ${Option.getOrNull(reason)})
        AND (${Option.isNone(q)} OR counterparty_name ILIKE ${Option.match(q, {
          onNone: () => null,
          onSome: (v) => `%${v}%`,
        })})
      ORDER BY booked_on DESC, id DESC
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BankTransaction.BankTransaction))),
      catchSqlErrors,
    );
  };

  const findDuplicateCandidate = (input: {
    readonly teamId: Team.TeamId;
    readonly excludeId: BankTransaction.BankTransactionId;
    readonly vsNorm: string;
    readonly amountMinor: number;
    readonly bookedOn: string;
  }) =>
    findDuplicateCandidateQuery({
      team_id: input.teamId,
      exclude_id: input.excludeId,
      vs_norm: input.vsNorm,
      amount_minor: input.amountMinor,
      booked_on: input.bookedOn,
    }).pipe(catchSqlErrors);

  const findUnmatchedForTeam = (teamId: Team.TeamId, sinceBookedOn: string) =>
    findUnmatchedForTeamQuery({ team_id: teamId, since: sinceBookedOn }).pipe(catchSqlErrors);

  const updateMatchEvidence = (
    id: BankTransaction.BankTransactionId,
    input: {
      readonly matchReason: Option.Option<BankTransaction.BankTransactionMatchReason>;
      readonly matchEvidence: Option.Option<unknown>;
    },
  ) =>
    updateMatchEvidenceQuery({
      id,
      match_reason: input.matchReason,
      match_evidence_json: Option.map(input.matchEvidence, (v) => JSON.stringify(v)),
    }).pipe(catchSqlErrors);

  /**
   * Returns `Option.none()` when the row was not in `('unmatched','partially_matched')` at the
   * time of the UPDATE (already matched/ignored/not_applicable, or claimed by the poller between
   * page render and click) — the caller (bank-sync.ts) turns that into
   * `BankSyncApi.BankTransactionAlreadyMatched`.
   */
  const ignore = (
    id: BankTransaction.BankTransactionId,
    input: {
      readonly kind: BankTransaction.BankTransactionResolutionKind;
      readonly reason: string;
      readonly ignoredByUserId: Auth.UserId;
    },
  ) =>
    ignoreQuery({
      id,
      kind: input.kind,
      reason: input.reason,
      ignored_by_user_id: input.ignoredByUserId,
    }).pipe(catchSqlErrors);

  const bulkIgnore = (input: {
    readonly teamId: Team.TeamId;
    readonly ids: ReadonlyArray<BankTransaction.BankTransactionId>;
    readonly kind: BankTransaction.BankTransactionResolutionKind;
    readonly reason: string;
    readonly ignoredByUserId: Auth.UserId;
  }): Effect.Effect<BulkResolveResult> =>
    bulkIgnoreQuery({
      team_id: input.teamId,
      ids: input.ids,
      kind: input.kind,
      reason: input.reason,
      ignored_by_user_id: input.ignoredByUserId,
    }).pipe(
      catchSqlErrors,
      Effect.map((rows) => ({ resolvedCount: rows.length })),
    );

  const suppressAutoMatch = (id: BankTransaction.BankTransactionId) =>
    suppressAutoMatchQuery({ id }).pipe(catchSqlErrors);

  const clearAutoMatchSuppression = (id: BankTransaction.BankTransactionId) =>
    clearAutoMatchSuppressionQuery({ id }).pipe(catchSqlErrors);

  /**
   * Returns `Option.none()` when the row was not `'ignored'` at the time of the UPDATE — the
   * caller turns that into `BankSyncApi.BankTransactionNotFound`-shaped 404/409 as appropriate.
   */
  const unignore = (id: BankTransaction.BankTransactionId, teamId: Team.TeamId) =>
    unignoreQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const summaryForTeam = (teamId: Team.TeamId) =>
    sql<{
      readonly imported_count: string;
      readonly pending_count: string;
      readonly matched_count: string;
      readonly ignored_count: string;
    }>`
      SELECT
        count(*)::text AS imported_count,
        count(*) FILTER (WHERE match_state IN ('unmatched','partially_matched'))::text AS pending_count,
        count(*) FILTER (WHERE match_state = 'matched')::text AS matched_count,
        count(*) FILTER (WHERE match_state = 'ignored')::text AS ignored_count
      FROM bank_transactions WHERE team_id = ${teamId}
    `.pipe(
      catchSqlErrors,
      Effect.map((rows) => ({
        importedCount: Number(rows[0]?.imported_count ?? 0),
        pendingCount: Number(rows[0]?.pending_count ?? 0),
        matchedCount: Number(rows[0]?.matched_count ?? 0),
        ignoredCount: Number(rows[0]?.ignored_count ?? 0),
      })),
    );

  return {
    upsertMany,
    findById,
    findByIdAndTeam,
    listByTeam,
    findDuplicateCandidate,
    findUnmatchedForTeam,
    updateMatchEvidence,
    ignore,
    bulkIgnore,
    unignore,
    suppressAutoMatch,
    clearAutoMatchSuppression,
    summaryForTeam,
  };
});

export class BankTransactionsRepository extends ServiceMap.Service<
  BankTransactionsRepository,
  Effect.Success<typeof make>
>()('api/BankTransactionsRepository') {
  static readonly Default = Layer.effect(BankTransactionsRepository, make);
}
