import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const BankSyncProvider = Schema.Literals(['fio']);
export type BankSyncProvider = typeof BankSyncProvider.Type;

/**
 * D11 — computed server-side by the pure `bankSyncStatus` ladder (`applications/server`) and
 * sent to the client as a literal; the web must never re-derive it. `'expiring_soon'` is
 * deliberately NOT a member of this union — token expiry is additive
 * (`BankSyncConfigView.expiringSoon: boolean`), never a rank of this ladder, because a token
 * that is both expiring AND failing must report both facts, not just one.
 *
 * `'account_mismatch'` outranks `'invalid'`: the token demonstrably works, it is the *account*
 * that is wrong, so telling the treasurer to replace the token is the wrong instruction. The
 * poller sets it via `last_error_code = 'account_mismatch'` when it refuses to ingest a statement
 * whose `info.iban` disagrees with the configured account, and it is terminal — no retry count and
 * no elapsed time clear it. A config edit does NOT clear it either (the row's
 * `consecutive_failure_count`/`next_attempt_at` reset on save, but `last_error_code` survives);
 * what actually clears the rank is the next successful poll's `recordSuccess`. It shares a literal
 * name with `BankSyncApi.BankSyncTestStatus`'s member and nothing else: that union is one probe's
 * verdict, this one is the state of automatic importing.
 */
export const BankSyncStatusCode = Schema.Literals([
  'not_connected',
  'misconfigured',
  'account_mismatch',
  'invalid',
  'activating',
  'sync_failing',
  'ok',
]);
export type BankSyncStatusCode = typeof BankSyncStatusCode.Type;

/**
 * Progress of the detached backfill fiber (§5), polled by the client via
 * `BankSyncConfigView.backfillStatus`. `'history_locked'` here is distinct from
 * `BankSyncStatusCode` — a live-sync failure and a backfill hitting Fio's 10-minute unlock
 * window are reported through separate fields.
 */
export const BankSyncBackfillStatus = Schema.Literals([
  'running',
  'complete',
  'history_locked',
  'budget',
  'failed',
]);
export type BankSyncBackfillStatus = typeof BankSyncBackfillStatus.Type;

export class BankSyncConfig extends Model.Class<BankSyncConfig>('BankSyncConfig')({
  team_id: TeamId,
  provider: BankSyncProvider,
  enabled: Schema.Boolean,
  auto_match_enabled: Schema.Boolean,

  // Account identity — feeds the pure CZ IBAN builder (CzIban.buildCzIban) -> SPAYD ACC.
  account_prefix: Schema.OptionFromNullOr(Schema.String),
  account_number: Schema.OptionFromNullOr(Schema.String),
  bank_code: Schema.OptionFromNullOr(Schema.String),
  // Meant to cache Fio's `info.iban` for a cross-check display, but nothing in the repo ever
  // writes this column (read-only in SELECT_COLUMNS, `BankSyncConfigRepository.ts`) — it is
  // currently always `None`.
  iban: Schema.OptionFromNullOr(Schema.String),
  currency: Schema.String,

  // Organisation identity, printed on the PDF header (D13).
  recipient_name: Schema.OptionFromNullOr(Schema.String),
  registered_id: Schema.OptionFromNullOr(Schema.String),
  registered_address: Schema.OptionFromNullOr(Schema.String),
  bank_name: Schema.OptionFromNullOr(Schema.String),

  // Secret (AES-256-GCM, `v1.<iv>.<tag>.<ct>` base64url) — excluded from json variants.
  fio_token_encrypted: Model.Sensitive(Schema.OptionFromNullOr(Schema.String)),
  fio_token_created_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  // Server-derived, unlike `fio_token_created_at` (a calendar date the treasurer types, snapped
  // to 12:00 UTC and settable into the future). Stamped with the DB's own `now()` by
  // `BankSyncConfigRepository`'s upsert every time a new encrypted token is actually written,
  // and only then — never accepted from a caller, which is why it is absent from that query's
  // `Request` schema. The nearest thing we have to "when did Fio's clock start on this token".
  //
  // Read it as a FLOOR, never as proof, and never as an `activating` verdict on its own:
  //   - `None` means no server-stamped token write — a pre-migration row, or a fixture that
  //     inserts straight into the table. It does NOT mean "no token".
  //   - A stale NON-null stamp is possible for one deploy window: an old image writes a token
  //     without touching this column, so `ON CONFLICT` leaves the previous token's stamp in
  //     place. (Errs safe — a fresh token reads as old.)
  //   - Re-saving the SAME plaintext token re-stamps it. The ciphertext differs every time
  //     (random IV), so SQL cannot tell a replacement from a re-paste — which means a treasurer
  //     re-pasting a REVOKED token restarts this clock.
  fio_token_saved_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),

  // Backfill walk (the bounded loop writes the cursor after each chunk, §5).
  backfill_from: Schema.OptionFromNullOr(Schema.String), // DATE, as 'YYYY-MM-DD'
  backfill_cursor: Schema.OptionFromNullOr(Schema.String), // DATE, as 'YYYY-MM-DD'
  backfill_status: Schema.OptionFromNullOr(BankSyncBackfillStatus),
  backfill_run_id: Schema.OptionFromNullOr(Schema.String),

  // Status / backoff bookkeeping (D11).
  last_synced_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  last_success_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  last_error_code: Schema.OptionFromNullOr(Schema.String),
  last_error_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  consecutive_failure_count: Schema.Int,
  next_attempt_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  coverage_warning: Schema.OptionFromNullOr(Schema.String),

  // Distributed poll lease (D10b(b)).
  poll_leased_until: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  poll_leased_by: Schema.OptionFromNullOr(Schema.String),

  configured_by_user_id: UserId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
