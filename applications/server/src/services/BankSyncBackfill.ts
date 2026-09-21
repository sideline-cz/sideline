/**
 * Plan `.work-plans/fio-transaction-matching.md` §5 — a bounded loop in a **detached fiber**,
 * polled by the client. `POST /bank-sync/backfill` (T6/T9, out of this task's scope) forks this
 * with `Effect.forkDetach` (this beta's equivalent of `Effect.forkDaemon`, which does not exist
 * in `effect@4.0.0-beta.40`) and returns 202 immediately; the client polls `GET /bank-sync` for
 * `backfillCursor` / `backfillStatus` / `backfillRunId`.
 *
 * Walks BACKWARDS from `to` in 60-day chunks, writing `backfill_cursor` after every committed
 * chunk so a crash resumes rather than restarting. Stops on: cursor < from | 12 requests |
 * 8 minutes | a 422 (history locked — leaves the cursor in place, the last committed position).
 * A 413 halves the chunk (60 -> 30 -> 15 -> 7 -> 3 -> 1) and retries the SAME window; a 1-day 413
 * is surfaced as `failed`, never silently swallowed.
 */
import type { BankSyncConfig } from '@sideline/domain';
import { Effect, Option, type Redacted } from 'effect';
import { HttpClient } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import {
  BankTransactionsRepository,
  type FioMovementInsert,
} from '~/repositories/BankTransactionsRepository.js';
import { isAccountMismatch } from '~/services/bankSyncAccount.js';
import {
  makeReal as makeRealFioApiClient,
  makeStub as makeStubFioApiClient,
} from '~/services/FioApiClient.js';
import { FioSecretCrypto } from '~/services/FioSecretCrypto.js';

const INITIAL_CHUNK_DAYS = 60;
const MIN_CHUNK_DAYS = 1;
const BACKFILL_MAX_REQUESTS = 12;
const BACKFILL_MAX_DURATION_MILLIS = 8 * 60 * 1000;

type BackfillOutcome = 'complete' | 'budget' | 'history_locked' | 'failed';

const addDaysToDateString = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const maxDate = (a: string, b: string): string => (a > b ? a : b);

interface WalkState {
  readonly cursor: string; // the (inclusive) end of the NEXT chunk to fetch, walking backwards
  readonly chunkDays: number;
  readonly requests: number;
}

interface WalkDeps {
  readonly configRepo: BankSyncConfigRepositoryShape;
  readonly txRepo: BankTransactionsRepositoryShape;
  readonly client:
    | ReturnType<typeof makeRealFioApiClient>
    | ReturnType<typeof makeStubFioApiClient>;
  readonly config: BankSyncConfig.BankSyncConfig;
  readonly teamId: string;
  readonly from: string;
  readonly to: string;
  readonly runId: string;
  readonly token: Redacted.Redacted<string>;
  readonly startedAtMillis: number;
}

type BankSyncConfigRepositoryShape = Effect.Success<
  ReturnType<typeof BankSyncConfigRepository.asEffect>
>;
type BankTransactionsRepositoryShape = Effect.Success<
  ReturnType<typeof BankTransactionsRepository.asEffect>
>;

const step = (deps: WalkDeps, state: WalkState): Effect.Effect<BackfillOutcome> => {
  if (state.cursor < deps.from) return Effect.succeed('complete');
  if (state.requests >= BACKFILL_MAX_REQUESTS) return Effect.succeed('budget');
  if (Date.now() - deps.startedAtMillis >= BACKFILL_MAX_DURATION_MILLIS)
    return Effect.succeed('budget');

  const chunkFrom = maxDate(deps.from, addDaysToDateString(state.cursor, -(state.chunkDays - 1)));

  return deps.client
    .fetchPeriod({ token: deps.token, from: chunkFrom, to: state.cursor, teamId: deps.teamId })
    .pipe(
      Effect.flatMap((statement) => ingestChunk(deps, state, chunkFrom, statement)),
      Effect.catchTag('FioHistoryLocked', () => Effect.succeed<BackfillOutcome>('history_locked')),
      Effect.catchTag('FioTooManyMovements', () => {
        const halved = Math.max(MIN_CHUNK_DAYS, Math.floor(state.chunkDays / 2));
        // A 1-day chunk is still too big — surfaced, never silently swallowed.
        if (halved === state.chunkDays) return Effect.succeed<BackfillOutcome>('failed');
        return step(deps, { ...state, chunkDays: halved, requests: state.requests + 1 });
      }),
      Effect.catchTag(
        [
          'FioServerError',
          'FioBadRequest',
          'FioRateLimited',
          'FioResponseInvalid',
          'FioNotConfigured',
          'FioUnreachable',
        ],
        () => Effect.succeed<BackfillOutcome>('failed'),
      ),
    );
};

const ingestChunk = (
  deps: WalkDeps,
  state: WalkState,
  chunkFrom: string,
  statement: Effect.Success<ReturnType<WalkDeps['client']['fetchPeriod']>>,
): Effect.Effect<BackfillOutcome> => {
  // Same guard the poller applies (`services/bankSyncAccount.ts`) — the Backfill button is
  // reachable exactly when a team is halted for this reason, so without this check a treasurer
  // could import up to 90 days of a foreign account plus the poisoned statement-period rows the
  // poller guard exists to prevent. The first chunk's answer settles the whole walk; every later
  // chunk is fetched with the same token against the same account.
  if (isAccountMismatch(deps.config, statement.info.iban)) return Effect.succeed('failed');

  const nextCursor = addDaysToDateString(chunkFrom, -1);
  return deps.txRepo
    .upsertMany(
      deps.teamId as never,
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
    )
    .pipe(
      Effect.tap(() =>
        deps.configRepo.upsertStatementPeriod({
          teamId: deps.teamId as never,
          dateStart: statement.info.dateStart,
          dateEnd: statement.info.dateEnd,
          openingBalanceMinor: statement.info.openingBalanceMinor,
          closingBalanceMinor: statement.info.closingBalanceMinor,
          currency: statement.info.currency,
        }),
      ),
      Effect.tap(() =>
        deps.configRepo.updateBackfillProgress({
          teamId: deps.teamId as never,
          backfillFrom: Option.none(),
          backfillCursor: Option.some(nextCursor),
          backfillStatus: Option.some('running'),
          backfillRunId: Option.some(deps.runId),
        }),
      ),
      Effect.flatMap(() =>
        step(deps, {
          cursor: nextCursor,
          chunkDays: INITIAL_CHUNK_DAYS,
          requests: state.requests + 1,
        }),
      ),
    );
};

const runWalk = (deps: WalkDeps): Effect.Effect<void> =>
  step(deps, { cursor: deps.to, chunkDays: INITIAL_CHUNK_DAYS, requests: 0 }).pipe(
    Effect.flatMap((finalStatus) =>
      deps.configRepo.updateBackfillProgress({
        teamId: deps.teamId as never,
        backfillFrom: Option.none(),
        backfillCursor: Option.none(),
        backfillStatus: Option.some(finalStatus),
        backfillRunId: Option.some(deps.runId),
      }),
    ),
  );

export const runBackfill = (
  teamId: string,
  from: string,
  to: string,
  runId: string,
): Effect.Effect<
  void,
  never,
  BankSyncConfigRepository | BankTransactionsRepository | FioSecretCrypto | SqlClient.SqlClient
> =>
  Effect.Do.pipe(
    Effect.bind('configRepo', () => BankSyncConfigRepository.asEffect()),
    Effect.bind('txRepo', () => BankTransactionsRepository.asEffect()),
    Effect.bind('crypto', () => FioSecretCrypto.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.bind('httpClientOpt', () => Effect.serviceOption(HttpClient.HttpClient)),
    Effect.bind('config', ({ configRepo }) => configRepo.findByTeam(teamId as never)),
    Effect.flatMap(({ configRepo, txRepo, crypto, sql, httpClientOpt, config }) =>
      Option.match(config, {
        onNone: () => Effect.void,
        onSome: (cfg) =>
          Option.match(cfg.fio_token_encrypted, {
            onNone: () => Effect.void,
            onSome: (tokenEncrypted) =>
              configRepo
                .updateBackfillProgress({
                  teamId: teamId as never,
                  backfillFrom: Option.some(from),
                  backfillCursor: Option.some(to),
                  backfillStatus: Option.some('running'),
                  backfillRunId: Option.some(runId),
                })
                .pipe(
                  Effect.andThen(() =>
                    crypto.decrypt(tokenEncrypted).pipe(
                      Effect.map(Option.some),
                      Effect.catchTag(['FioSecretKeyMissing', 'FioSecretDecryptError'], () =>
                        configRepo
                          .updateBackfillProgress({
                            teamId: teamId as never,
                            backfillFrom: Option.none(),
                            backfillCursor: Option.none(),
                            backfillStatus: Option.some('failed'),
                            backfillRunId: Option.some(runId),
                          })
                          .pipe(Effect.as(Option.none())),
                      ),
                    ),
                  ),
                  Effect.flatMap((tokenOpt) =>
                    Option.match(tokenOpt, {
                      onNone: () => Effect.void,
                      onSome: (token) =>
                        runWalk({
                          configRepo,
                          txRepo,
                          client: Option.isSome(httpClientOpt)
                            ? makeRealFioApiClient(httpClientOpt.value, sql)
                            : makeStubFioApiClient(),
                          config: cfg,
                          teamId,
                          from,
                          to,
                          runId,
                          token,
                          startedAtMillis: Date.now(),
                        }),
                    }),
                  ),
                ),
          }),
      }),
    ),
  );
