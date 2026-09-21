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
 */
export const BankSyncStatusCode = Schema.Literals([
  'not_connected',
  'misconfigured',
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
  // Cached from Fio's `info.iban` — cross-check only, never authoritative over the computed IBAN.
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
