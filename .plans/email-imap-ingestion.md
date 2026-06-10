# IMAP Email Ingestion (alongside webhook)

**Branch:** `worktree-feat+email-imap-ingestion` · **Worktree** off `origin/main`

## Goal

Add a per-team **IMAP polling** ingestion method beside the existing webhook. The poller
parses fetched mail into the existing provider-neutral `InboundEmailPayload` and calls the
same `EmailMessagesRepository.insertReceived()`, so the entire downstream pipeline
(`EmailSummarizer` → LLM → coach approval → Discord post) is **unchanged**. Both methods may
run at once.

## Locked decisions

- **Per-team config in DB** — extend `EmailForwardingConfig`.
- **Encrypted secret at rest** — AES-256-GCM, app-held key from env. Secret is write-only,
  never returned by the API.
- **Cron polling, UID-tracked** — a new `ImapPoller` Effect cron (template: `EmailSummarizer`).

---

## A. Domain (`@sideline/domain`) — build first

`packages/domain/src/models/EmailForwarding.ts` — add to `EmailForwardingConfig` (DB row):

| Field | Schema | Notes |
|---|---|---|
| `imap_enabled` | `Schema.Boolean` | default false |
| `imap_host` | `OptionFromNullOr(String)` | |
| `imap_port` | `OptionFromNullOr(Int)` | default 993 applied in UI/repo |
| `imap_username` | `OptionFromNullOr(String)` | |
| `imap_secret_encrypted` | `OptionFromNullOr(String)` | **never in any API view** |
| `imap_use_tls` | `Schema.Boolean` | default true |
| `imap_folder` | `OptionFromNullOr(String)` | default `INBOX` |
| `imap_last_seen_uid` | `Schema.Int` | 0 = nothing seen |
| `imap_uid_validity` | `OptionFromNullOr(Int)` | detect mailbox reset |
| `imap_last_synced_at` | `OptionFromNullOr(DateTimeUtc)` | **(blocker fix #1)** distinct from `updated_at` |

`packages/domain/src/api/EmailForwardingApi.ts`:

- **`EmailForwardingConfigView`** (read) gains `imapEnabled, imapHost, imapPort, imapUsername,
  imapUseTls, imapFolder, imapSecretSet: boolean` (derived `Option.isSome(secret)`),
  `imapLastSeenUid: Option<number>`, `imapLastSyncedAt: Option<DateTimeUtc>`.
  **No secret value, ever** — mirrors how `inbound_token` is omitted today.
- **`UpsertEmailForwardingConfigRequest`** (write) gains `imap_enabled, imap_host, imap_port,
  imap_username, imap_use_tls, imap_folder`, and the secret as
  **`imap_secret: Schema.OptionFromOptional(Schema.NonEmptyString)`** — **(blocker fix #3)** per
  `packages/domain/AGENTS.md`: missing key → `None` = *keep existing*; present → set/replace.

---

## B. Migration

`packages/migrations/src/before/<next-ts>_add_imap_to_email_forwarding_config.ts`
(timestamp strictly > current max; verify with `ls … | sort | tail -1`).

`ALTER TABLE email_forwarding_config ADD COLUMN IF NOT EXISTS …` for all 10 columns above
(all nullable / defaulted → backward compatible). `imap_enabled BOOLEAN NOT NULL DEFAULT false`,
`imap_use_tls BOOLEAN NOT NULL DEFAULT true`, `imap_last_seen_uid INTEGER NOT NULL DEFAULT 0`,
`imap_last_synced_at TIMESTAMPTZ`, rest `TEXT`/`INTEGER` nullable.

Partial index for the poller scan:
```sql
CREATE INDEX IF NOT EXISTS idx_email_forwarding_imap_enabled
  ON email_forwarding_config (team_id)
  WHERE imap_enabled = true AND enabled = true;
```

**Idempotency column on `email_messages`** — **(blocker fix #2)**: add nullable `message_id TEXT`
+ partial unique index so re-fetch after a crash, or webhook+IMAP both-on, can't double-ingest:
```sql
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_messages_team_message_id
  ON email_messages (team_id, message_id) WHERE message_id IS NOT NULL;
```

---

## C. Server (`applications/server`)

### C1. Crypto helper — `services/EmailSecretCrypto.ts` (new)
- Effect service wrapping `node:crypto` AES-256-GCM. Format `v1.<b64 iv>.<b64 tag>.<b64 ct>`,
  fresh `randomBytes(12)` IV per call.
- `encrypt(s) → Effect<string, EmailSecretKeyMissing>`, `decrypt(blob) → Effect<string,
  EmailSecretDecryptError | EmailSecretKeyMissing>`. Tagged errors (`Data.TaggedError`).
- Key from env, base64-decoded, **validated = exactly 32 bytes**. **(blocker fix #4)** Key is
  *optional* at boot; a missing/invalid key yields `EmailSecretKeyMissing` **only when
  encrypt/decrypt is actually called** (poller finds rows, or upsert receives a secret).
- Never logs key or plaintext; generic error on any tag/format failure.

### C2. env — `env.ts`
`EMAIL_IMAP_ENCRYPTION_KEY: Schema.OptionFromNullishOr(Schema.RedactedFromValue(Schema.NonEmptyString))`
— **(blocker fix #4)** mirrors `LLM_API_KEY`, so no-IMAP deploys/tests/local-dev boot unchanged.
Document in `.env.example` (base64 32-byte key; generate via `openssl rand -base64 32`).

### C3. IMAP client — `services/ImapClient.ts` (new)
- Wraps `imapflow` + `mailparser` behind an Effect interface (poller never imports the libs →
  tests inject a fake). **Spike CJS/NodeNext interop first** (`import pkg from 'imapflow'`).
- `fetchSince({host,port,username,secret,useTls,folder,sinceUid}) → Effect<ImapFetchResult,
  ImapConnectionError>` where `ImapFetchResult = { uidValidity, uidNext, messages: [{uid,
  payload: InboundEmailPayload, messageId: Option<string>}] }`.
- Reads `uidValidity`/`uidNext` from `mailbox` after open (**concern fix**: `uidNext` is the
  cold-start baseline source — no body fetch). Fetches bounded range `sinceUid+1 : sinceUid+50`
  (50/team/cycle cap; backlog drains over cycles). `Effect.acquireRelease` for the connection;
  bounded `socketTimeout`.
- MIME→payload: `from`←`parsed.from.text`, `to`←addresses, `subject`, `text`←`parsed.text`,
  `html`←`Option.fromNullable(parsed.html || undefined)`, `received_at`←`parsed.date` via
  `DateTime.unsafeFromDate` (fallback now), attachments→`EmailAttachmentPayload`
  (`content.toString('base64')`, filename/type truncated 255), `messageId`←`parsed.messageId`.

### C4. Poller cron — `services/ImapPoller.ts` (new)
Mirrors `EmailSummarizer`: `imapPollerEffect` (`Effect.Do.pipe`, `withCronMetrics('imap-poller')`),
exported `ImapPoller = imapPollerEffect.pipe(Effect.repeat(Schedule.cron('*/5 * * * *')))`.

Body: `configRepo.findImapEnabled()` → `Effect.all(configs.map(processTeam ▸ Effect.exit),
{ concurrency: 2 })` — **per-team isolation**, one team's failure never aborts others.

`processTeam`:
1. `crypto.decrypt(secret)` — on `EmailSecretDecryptError`/`KeyMissing`: log team id, **skip team,
   don't advance watermark**.
2. `imap.fetchSince(...)`.
3. **UIDVALIDITY check**: stored validity `Some` and ≠ returned → mailbox reset; re-baseline
   `last_seen_uid = uidNext-1`, store new validity, **skip ingest this cycle** (documented).
4. **Cold start** (`last_seen_uid = 0` && `uid_validity = None`): baseline `last_seen_uid =
   uidNext-1`, store validity, **ingest nothing historical** (see Decision D1).
5. Otherwise, per message ascending UID:
   - allowed-sender filter (reuse webhook logic) — non-match = examined, not ingested.
   - attachment-size limits (shared module, below) — oversized = examined, not ingested.
   - insert in `sql.withTransaction`: `insertReceived({…, message_id})` + `insertMany(attachments)`.
     **On `(team_id, message_id)` unique conflict → skip** (already ingested; crash/dup-safe).
6. **Watermark: single end-of-cycle write** — **(blocker fix #2)** `updateImapSync(teamId,
   maxExaminedUid, uidValidity, syncedAt=now)`, advancing past examined-but-filtered messages too.
   Always write `imap_last_synced_at` even on a zero-new-mail cycle.

> **Lost-mail note (documented behavior):** because filtered/oversized messages still advance the
> watermark, **editing allowed-senders does not retroactively ingest already-polled mail.** This is
> inherent to watermark+filter; Message-ID dedup makes re-fetch safe but we do not rewind UIDs.

### C5. Shared attachment limits — `services/emailAttachmentLimits.ts` (new)
Extract `MAX_ATTACHMENT_BYTES` (10MB), `MAX_TOTAL_ATTACHMENT_BYTES` (25MB), and pure
`validateAttachmentSizes(...)` from `email-webhook.ts`; webhook imports them (single source; its
test stays green).

### C6. Repository — `EmailForwardingConfigRepository.ts`
- `EmailForwardingConfigRow` + both SELECT lists gain the 10 columns.
- `upsert` accepts already-encrypted `imap_secret_encrypted: Option<string>`; SQL
  `COALESCE(${secret ?? null}, …secret)` keeps existing when `None`. `imap_folder` `COALESCE … 'INBOX'`.
- `findImapEnabled()` — `SqlSchema.findAll` where `imap_enabled AND enabled AND
  imap_secret_encrypted IS NOT NULL`.
- `updateImapSync(teamId, lastSeenUid, uidValidity, syncedAt)` — one `UPDATE` of
  `imap_last_seen_uid, imap_uid_validity, imap_last_synced_at`.
- Extend `MockEmailForwardingConfigRepositoryLayer` in `test/mocks/emailMocks.ts`.
- `EmailMessagesRepository.insertReceived` gains optional `message_id`; on unique-conflict the
  poller treats it as skip (use `ON CONFLICT DO NOTHING` returning no row, or catch the constraint).

### C7. API — `api/email-forwarding.ts`
- `toConfigView`/`defaultConfigView`: map new view fields; `imapSecretSet =
  Option.isSome(row.imap_secret_encrypted)`; never read the secret.
- `upsertEmailForwardingConfig`: bind `EmailSecretCrypto`; encrypt `payload.imap_secret` only when
  `Some` (→ `EmailSecretKeyMissing` surfaces a clear 4xx/5xx if key unset); pass
  `imap_secret_encrypted: Option<string>` + other IMAP fields to repo.

### C8. Wiring
- `AppLive.ts`: provide `EmailSecretCrypto.Default` (API handler needs it).
- `run.ts`: add `ImapPollerCronEffect` (provide config/messages/attachments repos + ImapClient +
  EmailSecretCrypto) to the `Effect.all([...], { concurrency: 'unbounded' })`, beside the summarizer.
- Add `imapflow`, `mailparser` to `applications/server/package.json`; `pnpm install` at root.

> **Single-replica assumption** (concern): the server runs as one process (`run.ts`), so the cron
> fiber can't self-overlap. If multi-replica is ever introduced, add a per-team claim
> (`imap_polling_at` guard) — noted as follow-up, not built now.

---

## D. Web (`applications/web`) — Team Settings

`components/pages/TeamSettingsPage.tsx` `EmailForwardingCard`: restructure into an **"Ingestion
methods"** group with two labelled sub-sections under the existing master switch:
- **Webhook (push)** — existing inbound-URL block.
- **IMAP mailbox (poll)** — `imap_enabled` switch gating a fieldset: host, port (993), Use TLS
  (on), username, **password (write-only, 3-state)**, folder (INBOX), and a read-only sync-status row.
- Shared allowed-senders / coach / target channels stay below, unchanged. Both methods may be on.

**Write-only secret** — state A (no secret: password input) / B (secret set: "✓ Password is set" +
Replace, no input) / C (replace: empty input + Cancel). Payload `imap_secret`: omit when keeping
existing, send string when set/replaced.

**Validation when `imap_enabled` on**: host & username required; secret required only when
`imapSecretSet === false`; port int 1–65535 (default 993); folder defaults INBOX. Disable-IMAP
preserves stored values server-side.

**Sync status**: `imapLastSyncedAt` relative time + `imapLastSeenUid` (de-emphasised). "Never synced"
copy must explain Decision D1 (only mail received after enabling is processed). Connection-test
button = **out of scope / phase 2**.

**i18n**: ~25 new `team_email_forwarding_imap_*` keys in `messages/{en,cs}.json` (full en+cs copy in
designer spec); update `…_enabled_help` to mention webhook/IMAP/both. Run paraglide compile.

---

## Decisions for your sign-off

- **D1 — Cold start = ingest nothing historical.** On first enable (and on UIDVALIDITY reset) we
  baseline to the current mailbox tip and process only *new* mail thereafter. Rationale: avoids
  flooding the approval queue with a full historical inbox. UI copy states this explicitly. The
  alternative (bounded backfill, e.g. "since now−24h") is deferred. *Override here if you'd prefer
  a backfill.*
- **D2 — Both methods allowed on simultaneously**, with Message-ID dedup preventing double-posts
  (rather than making the two mutually exclusive). *Say if you'd rather force a single method.*

## Test spec (TDD — written before implementation)

- **EmailSecretCrypto**: round-trip; ciphertext≠plaintext & differs per call; tamper→error;
  malformed→error; wrong-key→error; **missing key→`EmailSecretKeyMissing` (not boot crash)**.
- **ImapPoller** (fake ImapClient): maps N msgs to `insertReceived`; **end-of-cycle single
  watermark write to max examined UID**; passes stored `sinceUid` (no re-fetch of seen);
  attachment-limit skip still advances watermark; sender-filter skip still advances; **per-team
  isolation on failure**; decrypt-failure isolation; UIDVALIDITY reset re-baselines & skips;
  cold-start baselines & ingests nothing; **Message-ID dedup → duplicate insert skipped**;
  received_at fallback.
- **EmailForwardingConfigRepository** (integration): upsert stores IMAP + encrypted secret;
  omitted secret preserved; `updateImapSync` persists uid+validity+synced_at; `findImapEnabled`
  filters correctly.
- **API**: PUT encrypts secret (stored ≠ plaintext), response has `imapSecretSet` & no secret; GET
  never returns secret; PUT without secret → preserve path.
- **Webhook regression**: `email-webhook.test.ts` green after `emailAttachmentLimits` extraction.

## Build order

domain edit → `pnpm --filter @sideline/domain build` → add server deps + `pnpm install` →
migration (verify timestamp) → i18n compile → server typecheck → web typecheck → tests.

---

## CANONICAL INTERFACE CONTRACTS (tester + developers MUST match these exactly)

Patterns are copied from `EmailSummarizer.ts` / `LlmClient.ts` / `EmailForwardingConfigRepository.ts`.
All new standalone services use `Effect.Do.pipe` (no generators) per AGENTS.md. Errors use
`Data.TaggedError`. Services use `ServiceMap.Service<Self, Shape>()('api/Name')` with a
`static readonly Default = Layer.effect(...)`.

### env (`applications/server/src/env.ts`)
```ts
EMAIL_IMAP_ENCRYPTION_KEY: Schema.toStandardSchemaV1(
  Schema.OptionFromNullishOr(Schema.RedactedFromValue(Schema.NonEmptyString)),
),
// → env.EMAIL_IMAP_ENCRYPTION_KEY : Option<Redacted<string>>   (mirrors LLM_API_KEY)
```

### EmailSecretCrypto (`applications/server/src/services/EmailSecretCrypto.ts`)
```ts
export class EmailSecretKeyMissing extends Data.TaggedError('EmailSecretKeyMissing')<{
  readonly message: string;
}> {}
export class EmailSecretDecryptError extends Data.TaggedError('EmailSecretDecryptError')<{
  readonly message: string;
}> {}

interface EmailSecretCryptoService {
  readonly encrypt: (plaintext: string) => Effect.Effect<string, EmailSecretKeyMissing>;
  readonly decrypt: (blob: string) => Effect.Effect<string, EmailSecretDecryptError | EmailSecretKeyMissing>;
}
export class EmailSecretCrypto extends ServiceMap.Service<EmailSecretCrypto, EmailSecretCryptoService>()(
  'api/EmailSecretCrypto',
) { static readonly Default = Layer.effect(EmailSecretCrypto, make); }
```
- AES-256-GCM, format `v1.<b64url iv>.<b64url tag>.<b64url ct>`, 12-byte random IV per call.
- `make` reads `env.EMAIL_IMAP_ENCRYPTION_KEY` (Option<Redacted>). Key resolution + 32-byte length
  validation happens INSIDE `encrypt`/`decrypt` (not at layer build), so a missing/short key yields
  `EmailSecretKeyMissing` only when used — layer construction NEVER fails. (Decode base64 of the key;
  require exactly 32 bytes else `EmailSecretKeyMissing`.)
- Never log key or plaintext. Any tag/format/parse failure → `EmailSecretDecryptError` (generic msg).
- **Test seam:** the crypto service must let tests supply a key. Simplest: read from env at call
  time; the test sets `process.env.EMAIL_IMAP_ENCRYPTION_KEY` before importing, OR expose an internal
  `makeWithKey(Option<string>)` the `Default` layer calls with the env value and tests call directly
  with a known 32-byte base64 key. **Prefer `makeWithKey` so tests don't depend on process.env.**

### ImapClient (`applications/server/src/services/ImapClient.ts`)
```ts
export class ImapConnectionError extends Data.TaggedError('ImapConnectionError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ImapFetchParams {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secret: string;       // plaintext (already decrypted by the poller)
  readonly useTls: boolean;
  readonly folder: string;
  readonly sinceUid: number;     // fetch UIDs strictly greater than this
}
export interface ImapFetchedMessage {
  readonly uid: number;
  readonly payload: EmailForwarding.InboundEmailPayload;
  readonly messageId: Option.Option<string>;
}
export interface ImapFetchResult {
  readonly uidValidity: number;
  readonly uidNext: number;      // mailbox tip; cold-start baseline = uidNext - 1
  readonly messages: ReadonlyArray<ImapFetchedMessage>;
}
interface ImapClientService {
  readonly fetchSince: (params: ImapFetchParams) => Effect.Effect<ImapFetchResult, ImapConnectionError>;
}
export class ImapClient extends ServiceMap.Service<ImapClient, ImapClientService>()('api/ImapClient') {
  static readonly Default = Layer.effect(ImapClient, make);
}
```
- Wraps `imapflow` (connect, `getMailboxLock(folder)`, read `mailbox.uidValidity`/`mailbox.uidNext`,
  `fetch('${sinceUid+1}:*', { source: true, uid: true }, { uid: true })`) + `mailparser` simpleParser.
  Cap to 50 msgs/cycle (slice the returned messages or fetch `${sinceUid+1}:${sinceUid+50}`).
- All library calls wrapped in `Effect.tryPromise` → `ImapConnectionError`. Connection closed via
  `Effect.acquireRelease`/`ensuring`. Bounded `socketTimeout`. `{ logger: false }`.
- MIME→payload: `from`=`parsed.from?.text ?? ''`, `to`=address strings array, `subject`,
  `text`=`parsed.text ?? ''`, `html`=`Option.fromNullable(parsed.html || undefined)`,
  `received_at`=`Option.fromNullable(parsed.date)` mapped through `DateTime.unsafeFromDate`,
  `attachments`=`Option.some(...)` of `EmailAttachmentPayload` (filename/content_type truncated 255,
  `content_base64`=`att.content.toString('base64')`, `size`=byte length).
  `messageId`=`Option.fromNullable(parsed.messageId)`.

### ImapPoller (`applications/server/src/services/ImapPoller.ts`)
```ts
export const imapPollerEffect: Effect.Effect<void, never,
  EmailForwardingConfigRepository | EmailMessagesRepository | EmailAttachmentsRepository
  | ImapClient | EmailSecretCrypto | SqlClient.SqlClient>;   // single run, exported for tests
export const ImapPoller = imapPollerEffect.pipe(Effect.repeat(Schedule.cron('*/5 * * * *')), Effect.asVoid);
```
- Body: bind the 6 deps via `.asEffect()`; `configRepo.findImapEnabled()` →
  `Effect.all(configs.map(c => processTeam(...c).pipe(Effect.exit)), { concurrency: 2 })`;
  `withCronMetrics('imap-poller')`.
- `processTeam` per the plan: decrypt (skip on error, no watermark change) → fetchSince →
  UIDVALIDITY/cold-start baseline handling → per-message ascending: sender filter / attachment limits
  (use shared `emailAttachmentLimits`) / `sql.withTransaction(insertReceived + insertMany)` with
  message_id (skip on unique conflict) → single end-of-cycle `updateImapSync(teamId, maxExaminedUid,
  uidValidity, now)`. Never log secrets/bodies (log team_id only).

### emailAttachmentLimits (`applications/server/src/services/emailAttachmentLimits.ts`)
```ts
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export type AttachmentSizeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };
export const validateAttachmentSizes: (
  attachments: ReadonlyArray<EmailForwarding.EmailAttachmentPayload>,
) => AttachmentSizeCheck;
```
`email-webhook.ts` imports these (keeps its existing 413 behavior; its test must stay green).

### EmailMessagesRepository.insertReceived — add optional message_id
```ts
insertReceived(input: {
  team_id; from_address; subject; body; received_at: DateTime.Utc;
  message_id?: string | undefined;   // NEW — written to email_messages.message_id
}): Effect<EmailForwarding.EmailMessageId, never, ...>
```
The poller relies on the `(team_id, message_id)` partial-unique index to dedup. Decide the skip
mechanism: either `ON CONFLICT (team_id, message_id) DO NOTHING` returning `Option<id>` (poller
treats `None` as "already ingested, skip attachments") **or** detect the unique-violation SqlError in
the poller and treat as skip. **Prefer `ON CONFLICT DO NOTHING` returning Option** — cleaner, no
error-string matching. If `message_id` is undefined (webhook path), keep current always-insert
behavior. Webhook caller may pass `message_id: undefined` (unchanged behavior) — do NOT break the
existing webhook insert.

> NOTE: changing `insertReceived` to return `Option<id>` would ripple to the webhook caller. To
> avoid that, ADD a separate method `insertReceivedDedup(input) : Effect<Option<EmailMessageId>>`
> used only by the poller, leaving `insertReceived` untouched. **Use this approach** — minimal blast
> radius. Update `MockEmailMessagesRepositoryLayer` with the new method.

### EmailForwardingConfigRepository — new methods + row columns
```ts
// EmailForwardingConfigRow: add all 10 imap columns (Schema.OptionFromNullOr for nullable;
//   imap_last_synced_at: Schema.DateTimeUtcFromDate in Option; imap_last_seen_uid: Schema.Int; bools).
findImapEnabled(): Effect<ReadonlyArray<EmailForwardingConfigRow>, never, ...>   // SqlSchema.findAll
updateImapSync(teamId, lastSeenUid: number, uidValidity: number, syncedAt: DateTime.Utc): Effect<void, never, ...>
upsert(input: { ...existing..., imap_enabled, imap_host: Option<string>, imap_port: Option<number>,
  imap_username: Option<string>, imap_secret_encrypted: Option<string>, imap_use_tls,
  imap_folder: Option<string> }): Effect<EmailForwardingConfigRow, never, ...>
//   upsert SQL: COALESCE(${secret ?? null}, imap_secret_encrypted) to preserve when None;
//   folder COALESCE(${folder}, 'INBOX'); does NOT touch last_seen_uid/uid_validity/last_synced_at.
```
Update `MockEmailForwardingConfigRepositoryLayer`: add `findImapEnabled: () => Effect.succeed([])`,
`updateImapSync: () => Effect.void`.

### API view mapping (`api/email-forwarding.ts`)
`toConfigView`: map imap fields; `imapSecretSet = Option.isSome(row.imap_secret_encrypted)`;
`imapLastSeenUid`/`imapLastSyncedAt` from the row. `defaultConfigView`: imap defaults
(enabled false, tls true, others None, secretSet false, lastSeenUid/lastSyncedAt None).
`upsertEmailForwardingConfig`: bind `EmailSecretCrypto`; `Option.match(payload.imap_secret, { onNone:
Effect.succeed(Option.none()), onSome: s => crypto.encrypt(s).pipe(Effect.map(Option.some)) })`;
pass result as `imap_secret_encrypted` to repo.
