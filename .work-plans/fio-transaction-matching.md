# Párování transakcí s Fio — implementation plan

Story: Fio bank transaction matching for Ultimate Frisbee Horní Počernice, z.s.
Scope (approved): **ingest + match + QR (SPAYD) + export**, configured **per team**.
Branch: `feat/fio-transaction-matching`.

> **Revision 2** — incorporates the adversarial review's 11 blockers, the should-fixes, the
> authorized cuts, and the coordinator's cross-document rulings against
> `.work-plans/fio-transaction-matching-design.md`. Changes are marked **[R2]**.
> §9 lists what I pushed back on.

All external research here is **verified ground truth** — do not re-research the Fio API, SPAYD,
the CZ IBAN algorithm, or the library choices. Implement from the spec below.

---

## 0. What already exists — REUSE, DO NOT REBUILD

| Thing | Where |
|---|---|
| `fees`, `fee_assignments`, `payments`, `expenses` | `packages/migrations/src/before/1783000000_create_finance.ts` |
| `recompute_paid_minor` trigger (maintains `fee_assignments.paid_minor` on any `payments` INSERT/UPDATE/DELETE) | same migration, L79-100. **App code must NEVER write `paid_minor`.** |
| `fee_assignment_status_v` view (`pending\|partial\|paid\|overdue\|waived`) | same migration |
| Models `Fee`, `FeeAssignment`, `Payment`, `Expense`, `PaymentReminder` | `packages/domain/src/models/` |
| `FeesRepository`, `FeeAssignmentsRepository`, `PaymentsRepository`, `ExpensesRepository`, `FinanceOverviewRepository` | `applications/server/src/repositories/` |
| `PaymentReminderCron` + `payment_reminder_sync_events` outbox + bot handler | `applications/server/src/services/PaymentReminderCron.ts`, `applications/bot/src/rcp/finance/` |
| `PaymentsRepository.insert(...)` | the **only** way the matcher may create a payment, with `method: 'bank_transfer'` |
| `PaymentsRepository.void_(id, { voidedByUserId, voidReason, voidedAt })` | the **only** way to undo a payment |
| `FinanceApi.updateAssignment` → `waived` + `waivedReason` | the existing write path for "beru jako vyrovnané v plné výši" (§4.6 mode 2) — **no new waiver machinery needed** |
| GDPR manifest + its drift test | `applications/server/src/gdpr/exportManifest.ts`, `applications/server/test/integration/gdpr/exportManifest.test.ts` |

### Precedents this plan mirrors

| Concern | Reference |
|---|---|
| Per-team config + encrypted secret + write-only over HTTP | `repositories/EmailForwardingConfigRepository.ts`, `packages/domain/src/api/EmailForwardingApi.ts` |
| AES-256-GCM at rest, `v1.<iv>.<tag>.<ct>` base64url, `makeWithKey(Option<string>)` test seam | `services/EmailSecretCrypto.ts` |
| Per-team poller, `Effect.exit` isolation, `withCronMetrics` | `services/ImapPoller.ts` |
| Outbound HTTP on Effect 4 (`effect/unstable/http`, `Effect.serviceOption(HttpClient.HttpClient)`, `Redacted`, `Schema.decodeUnknownEffect`) | `services/LlmClient.ts` (`makeReal`/`makeStub` at ~L816-856) |
| `Effect.retry(Schedule.exponential(...).pipe(Schedule.take(n)))` | `services/TranslationCache.ts:61` |
| `Schedule.cron(...)` fires **once immediately at startup** | `services/InviteAcceptanceSweepCron.ts:11` |
| `Effect.catchDefect` + `Effect.failCause(Cause.die(defect))` | `services/TrainingAutoLogCron.ts` |
| Raw/binary HTTP response + `content-disposition` | `api/email-forwarding.ts` `downloadEmailAttachment`, `api/ical.ts:268` |
| Web authenticated download → Blob → `<a download>` | `web/src/components/pages/EmailDetailPage.tsx:185-225`, `DataExportCard.tsx:76-98` |
| Write-only secret UI 3-state | `web/.../team-settings/EmailForwardingCard.tsx` + `emailForwardingForm.ts` (`imapSecretPayload`) |
| Bot file attachment + `attachment://` embed image | `bot/src/rest/rules/clips.ts`, `bot/src/rcp/rulesQuiz/handleQuizDue.ts:88-92` |
| Zoned instant from calendar + clock parts | `server/AGENTS.md:1068-1082`, `src/utils/seriesOccurrence.ts` |

---

## 1. Design decisions

### D1 — Use `/periods`, not `/last` *(confirmed correct by review — keep)*

Poll `GET https://fioapi.fio.cz/v1/rest/periods/{token}/{from}/{to}/transactions.json` with a rolling
overlap window. Do **not** use `/last` in the poll.

**Why this beats `/last` on the spec's own non-functional requirement** ("Stav zarážky ukládat, aby
výpadek nic nepřeskočil"):

1. Fio advances the server-side cursor on **every** `/last` request that returned movements. Fetch,
   then crash before commit, and those movements are gone from the `/last` stream forever. Recovery
   needs `set-last-id` with the id we just lost.
2. `/last` is id-ordered, so a **back-dated** movement can be skipped entirely.
3. A DB restore from backup desynchronises us from the bank's cursor undetectably.

`/periods` has **no server-side state**. With `UNIQUE (team_id, provider, fio_movement_id)` and
`ON CONFLICT DO NOTHING`, every poll is idempotent: re-fetching the window is free, a crash loses
nothing, an outage shorter than the window self-heals, a restore self-heals, back-dated movements are
picked up. **Same one request per poll.** The durable "zarážka" becomes the set of committed movement
ids — stronger than a cursor, because it is derived from what we actually stored.

**[R2] The window is derived, not configured** (`sync_window_days` column dropped — B-cut-4):

```
SYNC_WINDOW_DAYS = 14                       // module constant, not a user-facing knob
FIO_HISTORY_WALL_DAYS = 89                  // 90-day limit, one day of slack
from = max(today - 89d, min(today - 14d, (last_success_at at team tz)::date - 1d))
to   = today
```

An outage longer than 14 days therefore widens the window automatically instead of losing data — which
was the hole in revision 1 that defeated D1's own justification. If `today - from > 89`, the gap can
no longer be closed by the live poll: set `last_error_code = 'coverage_gap'` and surface it loudly
(the treasurer must run a backfill with an Internetbanking unlock).

**[R2] `set-last-id` / `set-last-date` are NOT implemented** (B-cut-5). They were dead code by this
plan's own description, and each is another token-bearing URL to keep out of spans and logs (B1).

### D2 — Separate encryption key, shared algorithm *(keep)*

Extract the AES-256-GCM primitives from `EmailSecretCrypto` into a key-agnostic pure module
`applications/server/src/services/secretBox.ts`; build two thin services over it: `EmailSecretCrypto`
(unchanged, `EMAIL_IMAP_ENCRYPTION_KEY`) and `FioSecretCrypto` (`FIO_TOKEN_ENCRYPTION_KEY`).

A Fio token is a materially higher-value secret than an IMAP app password. Sharing a key means a
compromise of one is a compromise of the other, rotating one forces re-entry of the other (so neither
gets rotated), and `EmailSecretDecryptError` in a Fio log line actively misleads during an incident.
Two hand-maintained GCM copies drift; extraction gives separate blast radius, separate rotation,
separate error tags, one implementation. Cost: one env var, generated identically
(`openssl rand -base64 32`), following the existing "Optional Secret That Fails On Use, Not On Boot"
pattern — a missing key yields a typed `FioSecretKeyMissing` at use time and never fails boot.

`EmailSecretCrypto`'s exported names, error tags and `makeWithKey` seam stay byte-identical so its
tests pass unmodified.

### D3 — `variable_symbol` is `TEXT`, matched on a normalised form *(keep; ruled: design's Q2 closed in favour of this)*

`team_members.variable_symbol TEXT`, `CHECK (variable_symbol ~ '^[0-9]{1,10}$')`, unique **per team on
the leading-zero-stripped form**:

```sql
CREATE UNIQUE INDEX uq_team_members_team_variable_symbol
  ON team_members (team_id, (NULLIF(ltrim(variable_symbol, '0'), '')))
  WHERE variable_symbol IS NOT NULL;
```

Fio returns VS as a string; SPAYD `X-VS` is "max 10 integer characters" (leading zeros count); the
treasurer may have printed `0042` on a paper form. Matching on the stripped form makes Fio's
`"0012345"` match a stored `"12345"`. The partial index permits many NULLs and forbids `012345` +
`12345` coexisting in one team. `ltrim(text,text)` and `NULLIF` are IMMUTABLE, so the index is legal.
**Not `jersey_number`** — that is INTEGER 0–99 and non-unique.

### D4 — `bank_transactions.amount_minor` is SIGNED, with a generated `direction` *(confirmed correct — keep)*

`BIGINT NOT NULL CHECK (amount_minor <> 0)`, negative = outgoing, plus
`direction TEXT GENERATED ALWAYS AS (CASE WHEN amount_minor < 0 THEN 'outgoing' ELSE 'incoming' END) STORED`.

This is grant-audit evidence; the bank's own figure must survive verbatim. An unsigned amount plus a
hand-maintained direction is two facts that can disagree; a generated column cannot.
`payments.amount_minor` keeps its `CHECK > 0` because the matcher only ever sees incoming rows.

**node-pg trap:** `BIGINT` (int8) comes back as a **string**. Model it with the union shape
`Fee.AmountMinor` already uses (`packages/domain/src/models/Fee.ts`) — a bare `Schema.Int` fails decode
on every row. Same for `fio_movement_id`.

### D5 — `recorded_by_user_id` for a system-created payment = the configuring treasurer *(keep; still open question Q3)*

`bank_sync_config.configured_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT`, set to
the user who last saved the team's config; the matcher passes it as `recordedByUserId`.

Machine-readable provenance does **not** live there — **[R2]** it lives in `payments.matched_by ∈
{'auto','manual'}` and `payments.bank_transaction_id` (D7), plus `bank_transactions.match_evidence`
JSONB. The payment `note` is stamped `Fio #<movement_id>`.

Rejected: a synthetic system user (`users.discord_id` is NOT NULL UNIQUE; a fake row surfaces in
rosters, display chains, GDPR exports, the global-admin allowlist); a nullable FK (forces every reader
— `PaymentsRepository.listByTeam`'s `LEFT JOIN users ru`, `PaymentView.recorderName`, the web payments
table — to learn a null case, a large blast radius for an audit-quality *loss*).

`ON DELETE RESTRICT` guarantees the row survives. Re-saving the config re-points only future payments.

### D6 — Pure SPAYD / IBAN code lives in `packages/domain/src/models/` *(ruled: this plan wins)*

`CzIban.ts` and `Spayd.ts` as **pure algorithm modules** with paired tests in `packages/domain/test/`
— the convention in `packages/domain/AGENTS.md`, precedents `Elo.ts` (imports nothing), `DisplayName.ts`
(pure `effect` helpers only). `@sideline/domain` is already a dependency of server, bot and web, so the
web imports the same implementation. **The design's proposed second copy in `web/src/lib/finance/`
must not be created.**

QR *rendering* stays server-side (`services/QrRenderer.ts`, `qrcode`); `qrcode`'s CLI-only `yargs`
transitive dep never reaches the web bundle.

**[R3 — F1] The browser must NOT use a plain `<img src=".../qr.png">`.** Revision 2 specified exactly
that and it would have 401'd for every player: `applications/web/src/lib/token.ts` stores the API token
in **localStorage** (`BrowserKeyValueStore.layerLocalStorage`), not a cookie, so a browser-issued image
request carries no `Authorization` header. Use the same authenticated-fetch → `blob()` →
`URL.createObjectURL` flow already cited for the CSV/PDF export
(`EmailDetailPage.tsx:185-225`), and **`URL.revokeObjectURL` on unmount** — the QR renders once per
outstanding assignment, so a leaked object URL per row is a real leak, not a theoretical one. See
§3.4's `useQrObjectUrl` hook. The endpoint keeps its three-way containment check regardless.

### D7 — **[R2 — REPLACES revision 1's link table]** One payment → one bank transaction, via a column on `payments`

**Revision 1 specified a `bank_transaction_payments` link table. That is cut (B-cut-1).** The
justification was self-refuting: the matcher and `/match` both write **one payment per assignment**,
so the real cardinality is one transaction → many payments, which a plain FK models exactly. The
`UNIQUE (payment_id)` index revision 1 added was the tell. History is already covered by
`voided_at`/`voided_by_user_id`/`void_reason` on `payments`. The link table's duplicated
`amount_minor` was itself the "two facts that can disagree" defect D4 exists to prevent.

```sql
ALTER TABLE payments ADD COLUMN bank_transaction_id UUID REFERENCES bank_transactions(id) ON DELETE RESTRICT;
ALTER TABLE payments ADD COLUMN matched_by TEXT CHECK (matched_by IN ('auto','manual'));
-- both or neither
ALTER TABLE payments ADD CONSTRAINT payments_bank_match_pair
  CHECK ((bank_transaction_id IS NULL AND matched_by IS NULL)
      OR (bank_transaction_id IS NOT NULL AND matched_by IS NOT NULL));
```

Cutting the table removes a table, a repository, a join, a duplicated amount and ~6 tests — **and it
makes D7b possible**, which is the real prize.

### D7b — **[R2 — B4]** `match_state` is maintained by a trigger on `payments`, not by app code

`applications/server/src/api/finance.ts` already exposes `voidPayment` (reachable from the existing
payments UI) with no knowledge of the bank tables. Voiding an auto-created payment there drops
`paid_minor` correctly while leaving `match_state = 'matched'` — the transaction never returns to the
queue, the partial index excludes it, and the money is unallocated and invisible on every screen.

Fix with the same mechanism the repo already uses for `paid_minor`.

**[R4 — residual ruling taken: ONE trigger, not two.** Revision 3 added a second trigger and relied on
Postgres firing per-row triggers in **name order** (`payments_recompute_bank_match_state` <
`payments_recompute_paid_minor`) to get the lock order right. That is real Postgres behaviour, but
nothing tested it and a rename would have changed only deadlock *probability*, not any asserted
outcome — a fragility with no failing test. The new migration therefore **drops** the existing
`payments_recompute_paid_minor` trigger and installs a single replacement whose function calls the two
recomputes in an explicit, readable order. Both recompute functions are untouched.**

```sql
CREATE OR REPLACE FUNCTION recompute_bank_match_state(p_tx_id UUID) RETURNS void AS $$
DECLARE v_amount BIGINT; v_state TEXT; v_matched BIGINT;
BEGIN
  SELECT abs(amount_minor), match_state INTO v_amount, v_state
  FROM bank_transactions WHERE id = p_tx_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  -- Human-set terminal states are never overwritten by payment activity.
  IF v_state IN ('ignored','not_applicable') THEN RETURN; END IF;

  SELECT COALESCE(SUM(p.amount_minor), 0)::BIGINT INTO v_matched
  FROM payments p WHERE p.bank_transaction_id = p_tx_id AND p.voided_at IS NULL;

  UPDATE bank_transactions
     SET match_state = CASE WHEN v_matched = 0 THEN 'unmatched'
                            WHEN v_matched >= v_amount THEN 'matched'
                            ELSE 'partially_matched' END,
         updated_at = now()
   WHERE id = p_tx_id;
END; $$ LANGUAGE plpgsql;

-- Replaces payments_recompute_trigger(). Same paid_minor semantics, plus the bank match state,
-- with the lock order (bank_transactions -> fee_assignments) explicit in the code rather than
-- implied by two trigger names sorting a particular way.
CREATE OR REPLACE FUNCTION payments_finance_recompute() RETURNS trigger AS $$
DECLARE a UUID; b UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.bank_transaction_id IS NOT NULL THEN PERFORM recompute_bank_match_state(OLD.bank_transaction_id); END IF;
    PERFORM recompute_paid_minor(OLD.fee_assignment_id);
    RETURN OLD;
  END IF;

  -- [R4 — defect m] When a payment is re-pointed between two bank transactions, lock the LOWER
  -- id first so two concurrent re-points in opposite directions cannot self-deadlock.
  IF TG_OP = 'UPDATE' AND OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id
     AND OLD.bank_transaction_id IS NOT NULL AND NEW.bank_transaction_id IS NOT NULL THEN
    a := LEAST(OLD.bank_transaction_id, NEW.bank_transaction_id);
    b := GREATEST(OLD.bank_transaction_id, NEW.bank_transaction_id);
    PERFORM recompute_bank_match_state(a);
    PERFORM recompute_bank_match_state(b);
  ELSE
    IF NEW.bank_transaction_id IS NOT NULL THEN PERFORM recompute_bank_match_state(NEW.bank_transaction_id); END IF;
    IF TG_OP = 'UPDATE' AND OLD.bank_transaction_id IS DISTINCT FROM NEW.bank_transaction_id
       AND OLD.bank_transaction_id IS NOT NULL THEN
      PERFORM recompute_bank_match_state(OLD.bank_transaction_id);
    END IF;
  END IF;

  PERFORM recompute_paid_minor(NEW.fee_assignment_id);
  IF TG_OP = 'UPDATE' AND OLD.fee_assignment_id <> NEW.fee_assignment_id THEN
    PERFORM recompute_paid_minor(OLD.fee_assignment_id);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_recompute_paid_minor ON payments;
CREATE TRIGGER payments_finance_recompute
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_finance_recompute();
```

**No trigger name is load-bearing any more.** The order is the order of the `PERFORM` statements.
The old `payments_recompute_trigger()` function is left in place (unreferenced) rather than dropped,
so a rollback to the previous image can re-create its trigger.

### D8 — CSV formatting *(confirmed correct — keep)*

| Aspect | Choice | Rationale |
|---|---|---|
| Delimiter | `;` | cs-CZ list separator. A comma crams every row into column A. **The quoting predicate must test `;`, not `,`.** |
| Encoding | UTF-8 **with BOM**, emitted exactly once at index 0 | Without it Windows Excel decodes ANSI and `Novák` → `NovÃ¡k`. |
| Line ending | `\r\n` | |
| Decimal separator | `,` (`1234,50`) | Czech Excel reads `1234.50` as text, so `SUM()` returns empty. Unambiguous because `;` is the delimiter. **Q2.** |
| Formula injection | Prefix `'` when the first char is `= + - @ TAB CR`, **text columns only, never numeric** | Counterparty names come from Fio and are untrusted. Amounts legitimately start with `-`; prefixing them corrupts every outgoing row. |
| Leading zeros | **Not solvable in CSV.** Documented, not worked around. | `0123456789` becomes `123456789`; quoting does not prevent it, and a leading apostrophe is *not* a fix (Excel's text marker applies to typed cells, not CSV import, where it renders literally). Mitigations: the **PDF** is the audit artefact and renders VS verbatim; the docs page instructs "Data → From Text/CSV → VS column = Text". **Q1.** |

Columns (Czech header, matching the design's §7.5):
`Datum;Protistrana;Účet protistrany;Variabilní symbol;Zpráva pro příjemce;Částka;Měna;Stav přiřazení;Přiřazeno k;Poznámka`

### D9 — PDF: vendored TTF, never a base-14 font *(confirmed correct — keep)*

`pdfkit`'s base-14 `encodeText` maps through `WIN_ANSI_MAP` with **no validation and no fallback**.
`ě` (U+011B = 283) is absent, so it emits a **three**-hex-digit token into a stream of two-hex-digit
bytes and desynchronises **the entire rest of the string** — silently. WinAnsi covers `á é í ó ú ý š ž`
but breaks on `č ď ě ň ř ť ů`, so a smoke test using only `á/é/í` passes while the document is garbage.

Vendor `NotoSans-Regular.ttf` + `NotoSans-Bold.ttf` (OFL-1.1, ~450 kB each, Latin Extended-A) at
`applications/server/src/assets/fonts/` with `LICENSE-OFL.txt`. `doc.registerFont('body', absPath)` /
`'bold'` at renderer construction; call `doc.font('body')` **before every `.text()`** (a font set once
does not survive `.addPage()` on all pdfkit paths).

Two build traps:
1. Production image is `node:25-slim`, which **ships no fonts**. A system font path works under local
   Nix and fails in the container.
2. **`tsc -b` does not copy `.ttf`.** The server builds to `build/esm`; the Dockerfile does
   `COPY --from=build /app/applications/server/build/esm applications/server/build`. Add an explicit
   copy step to the server `build` script mirroring `src/assets/` → `build/esm/assets/`, plus a
   `postbuild` assertion (model on `packages/rules/scripts/assert-dist.mjs`). No Dockerfile change
   needed. Resolve at runtime with `new URL('../assets/fonts/NotoSans-Regular.ttf', import.meta.url)`
   from `src/services/BankStatementPdf.ts` — correct under both `tsx src/run.ts` and `build/esm`.

### D10 — **[R2 — B1]** The Fio token must never reach a span, a log, or a `Cause`

**This is the most serious defect in revision 1 and it is verified, not theoretical.**
`node_modules/effect/dist/unstable/http/HttpClient.js:204` sets `span.attribute("url.full",
url.toString())` **unconditionally**, and `applications/server/src/env.ts:43` makes
`OTEL_EXPORTER_OTLP_ENDPOINT` a **required** var. Fio puts the 64-character token in the URL **path**.
Revision 1's "never log the URL" covered our own log calls and missed the span entirely, so every poll
would have written the live bank token in plaintext into SigNoz, retained, visible to anyone with
dashboard access.

Second path, same root: `TransportError`/`HttpClientError` expose a `message` getter derived from the
request and `TransportError.methodAndUrl` is the full URL — so any DNS failure, `ECONNRESET` or timeout
renders the token into a `Cause` that the poller then logs.

Four mandatory defences, all inside `FioApiClient`:

1. **Disable the client tracer for Fio.** `HttpClient.TracerDisabledWhen` is a
   `ServiceMap.Reference` at `HttpClient.js:528` defaulting to `constFalse`. Set it to
   `(req) => new URL(req.url).hostname === 'fioapi.fio.cz'`, provided on the layer that builds the
   client.

   **[R4 — defect d] `Layer.provide`-ing the reference under the client-construction layer does NOT
   work.** `HttpClient.js:178` reads `fiber.getRef(TracerDisabledWhen)(request)` at **execute** time,
   inside `Effect.withFiber` — the caller's fiber services, which a construction-time layer is not
   part of (and `layerMergedServices` merges caller-wins). Wrap the client **value** instead, so the
   service is provided around `postprocess`, which is where the span code lives
   (`HttpClient.transform` at `HttpClient.js:83`):

   ```typescript
   const fioClient = HttpClient.transform(client, (effect) =>
     Effect.provideService(effect, HttpClient.TracerDisabledWhen, isFioUrl).pipe(
       Effect.withTracerEnabled(false),
     ),
   );
   // [R4] String prefix, not `new URL(...)`: a relative URL makes the URL constructor THROW, and
   // that throw is a defect raised inside Effect.withFiber, not a typed failure.
   const isFioUrl = (req: HttpClientRequest.HttpClientRequest) =>
     req.url.startsWith('https://fioapi.fio.cz/');
   ```

2. **Never let a platform error escape the client.**
   **[R4 — defect c] `Effect.catchTag('HttpClientError', 'TransportError', …)` would not have
   caught.** `TransportError` is a **`reason` class nested inside** `HttpClientError`
   (`HttpClientError.js:17,54`), not a top-level error-channel tag; the only tag `client.execute`
   fails with is `HttpClientError`. Worse, the leak path is `HttpClientError.message` →
   `this.reason.message` → `TransportError.methodAndUrl` = `` `${method} ${request.url}` ``, and the
   `HttpClientError` constructor **lifts `reason.cause` to its own `cause`** (`:19-22`), so
   `Cause.pretty` renders the tokenised URL twice.

   Correct containment: `Effect.catchTag('HttpClientError', …)` **plus** a final
   `Effect.catchCause` (re-raising interruption-only causes per the `ChatAgent` idiom), converting to
   typed `Fio*` errors that carry **only** a status code, an endpoint name and a team id. **No
   original error is embedded as `cause`.**

   **The containment must wrap the body decode too.** `StatusCodeError`, `DecodeError` and
   `EmptyBodyError` all carry `methodAndUrl`, so if the response is decoded with
   `HttpClientResponse.schemaBodyJson`, a Fio schema change produces a `DecodeError` whose message is
   the tokenised URL. Decode **inside** the containment boundary, never after it.
3. **`Redacted` end-to-end.** `Schema.RedactedFromValue(Schema.NonEmptyString)` on the
   `UpsertBankSyncConfigRequest` payload field (precedent: `env.ts:59`), through
   `FioSecretCrypto.decrypt` (returns `Redacted.Redacted<string>`), with `Redacted.value()` called at
   exactly one place: URL construction inside the client.
4. **Emit our own span** named `fio/<endpoint>` with attributes `team.id` and `fio.endpoint` only —
   observability without the URL.

Never construct a log message from a request, response or error object obtained from `HttpClient`.

### D10b — **[R2 — B8]** The throttle, the poll lock and `/rematch` idempotency are all in the database

`Semaphore.make(1)` + `Ref<Map<…>>` live in **one Node process**, and there is no advisory lock,
`SKIP LOCKED` lease or leader election anywhere in `applications/server/src`. Two replicas — or the
~30 s overlap of any rolling deploy — means both hit Fio inside 30 s (a 409 storm that never
converges) and both run the matcher over the same fresh rows (B2 at scale). The SHA-256-of-token
keying was right; the storage location was wrong.

**Three mechanisms, all SQL, all cheaper than the in-memory version:**

**(a) Per-token 30 s throttle — one atomic upsert that *reserves a slot*, then sleeps outside any lock.**
Fio allows one request per token per 30 s counting reads AND writes; the limit is per-token, not
per-IP, so two teams sharing a token must share the budget.

```sql
INSERT INTO fio_token_throttle (token_fingerprint, next_call_allowed_at)
VALUES ($1, now() + interval '30 seconds')
ON CONFLICT (token_fingerprint) DO UPDATE
  SET next_call_allowed_at = GREATEST(fio_token_throttle.next_call_allowed_at, now())
                             + interval '30 seconds'
-- [R4 — defect e(i)] Return a DURATION, not a DB timestamp. The caller sleeps on the replica's
-- clock; comparing a DB timestamp against it makes every reservation wrong by the clock skew, in
-- whichever direction is unsafe.
RETURNING GREATEST(next_call_allowed_at - interval '30 seconds' - now(), interval '0') AS wait;
```

The caller sleeps for `wait`, then issues the request. Reserving *before* sleeping means two replicas
get two different slots instead of colliding. `token_fingerprint` is
`sha256(Redacted.value(token)).hex.slice(0, 16)` — never the token.
**This reservation lives inside `FioApiClient`, so no caller can bypass it** (the client therefore
depends on `SqlClient`; that is deliberate).

**[R4 — defect e(ii)] Invariant: the reservation runs in its OWN autocommitted statement, and no
caller may wrap a Fio fetch in `sql.withTransaction`.** "Sleeps outside any lock" is only true if the
`ON CONFLICT` row lock is released at statement end. Inside an enclosing transaction the lock is held
across the sleep *and* the HTTP call, and a second replica blocks on it — precisely what D10b exists
to prevent. State it at the client's public methods; integration test 102 proves it.

**Housekeeping:** the poller issues
`DELETE FROM fio_token_throttle WHERE next_call_allowed_at < now() - interval '7 days'` once per
cycle. One row per token forever is harmless at this scale, but the delete costs nothing.

**(b) Per-team poll lease** on `bank_sync_config`:
`poll_leased_until TIMESTAMPTZ`, `poll_leased_by TEXT`.

```sql
UPDATE bank_sync_config
   SET poll_leased_until = now() + interval '5 minutes', poll_leased_by = $1, updated_at = now()
 WHERE team_id = $2 AND (poll_leased_until IS NULL OR poll_leased_until < now())
RETURNING *;
```

`Option.none()` ⇒ another replica holds it, skip this team this cycle. **The lease is not a row lock**
— no lock is held across the HTTP call.

**[R4 — defect f] The release must be guarded by the holder:**

```sql
UPDATE bank_sync_config SET poll_leased_until = NULL, poll_leased_by = NULL, updated_at = now()
 WHERE team_id = $1 AND poll_leased_by = $2     -- <- the guard
```

Run in `Effect.ensuring`. Without `AND poll_leased_by = $2`, a cycle that overran its lease (a
`timeout` cannot interrupt promptly inside an uninterruptible SQL round-trip) clears **whoever holds
it now**, handing the same team to two replicas at once — the exact failure the lease prevents.

**[R4 — defect n] Timing budget, stated as an invariant: `cycle timeout < lease duration`.**
Revision 3 had `timeout('4 minutes')` = 240 s against a 409 ladder of
`exponential('30 seconds', 2) |> take(3)` = 30+60+120 = 210 s **plus** four throttle reservations of
up to 30 s each ≈ 330 s — so a team under sustained 409s always died mid-ladder on the timeout instead
of backing off cleanly. Fixed by shortening the ladder:

| Knob | Value |
|---|---|
| 409 ladder | `Schedule.exponential('30 seconds', 2).pipe(Schedule.take(2))` → 30 + 60 = 90 s |
| worst-case cycle | 90 s of ladder + 3 × 30 s reservations ≈ 180 s |
| `Effect.timeout` on the per-team cycle | **4 minutes** (240 s) |
| lease | **6 minutes** |

**(c) `/rematch` takes a lease too**, but a **60-second** one — it is a local operation and a 5-minute
lease would 409 a treasurer for up to four minutes after an unrelated poll. **[R4 — residual]** It
also **checks the config row exists first**, so a team with no config gets `BankSyncNotConfigured`
(404) rather than an indistinguishable `BankSyncBusy` (409) from a lease claim that returned zero rows
for the wrong reason.

**Retry ladder position, stated explicitly:** the 409 ladder sits **outside** the throttle reservation
— each attempt makes a fresh reservation and a fresh sleep. It is therefore scoped to one team's
token and never blocks another team. There is no process-wide semaphore. The per-team loop runs at
`{ concurrency: 2 }` and that concurrency is real.

**HTTP status dispatch** (verified by live probing — there is no 401 and no 403, and every error body
is empty with `content-length: 0`; dispatch on status only, never parse an error body):

| Status | Typed error | Retry? |
|---|---|---|
| 2xx | success | — |
| `409` | `FioRateLimited` | **Yes** — `Effect.retry(fx, { schedule: Schedule.exponential('30 seconds', 2).pipe(Schedule.take(3)), while: (e) => e._tag === 'FioRateLimited' })`. Read `Retry-After` opportunistically; **assume absent** (not in the 60-page PDF, could not be verified) and hard-code 30 s. |
| `413` | `FioTooManyMovements` | **[R2]** Halve the chunk and retry, down to a 1-day chunk. A 1-day 413 is surfaced, not swallowed. |
| `422` | `FioHistoryLocked` | No. "Unlock history in Internetbanking (10-minute window)." |
| `404` | `FioBadRequest` | No — our bug. |
| `500` | `FioServerError` | **NEVER.** A non-existent / expired / revoked token returns 500. A blanket "retry on 5xx" hammers Fio forever on a dead token. |

The poller backs the team off on `FioServerError`: `consecutive_failure_count += 1`,
`next_attempt_at = now() + LEAST(2^consecutive_failure_count, 24) hours`; the pollable query filters
`AND (next_attempt_at IS NULL OR next_attempt_at <= now())`. Saving the config resets both.

### D11 — **[R2 — B11]** Status inference: a transient failure is not an expired token

Revision 1 declared a healthy token expired after **one** 500. One five-minute Fio outage, one
`ECONNRESET`, or a `FIO_TOKEN_ENCRYPTION_KEY` missing from a deploy would have put a red alert in
front of the treasurer telling them to replace a perfectly good token — and they would have.

**[R2]** The literal set is the design's, extended (ruled: design wins), computed **server-side** in
the pure `services/bankSyncStatus.ts` and sent as a literal. The web must never re-derive it, so the
bot's T−14 DM and the web banner cannot drift.

```
BankSyncStatusCode = 'not_connected' | 'misconfigured' | 'invalid' | 'activating'
                   | 'sync_failing'  | 'ok'
```

**[R4 — blocker 4, ruled: design wins on both counts.]** Two changes from revision 3:
`failing` is renamed **`sync_failing`**, and **`expiring_soon` is removed from the union entirely**.
Revision 3 had it at rank 4 of one exclusive ladder, which meant a token that was **both expiring and
failing** reported `expiring_soon` and the failure vanished from the UI — the single state most likely
to co-occur with another, silently masking it. Expiry is **additive**, evaluated separately:

```
BankSyncConfigView.expiringSoon: boolean        // token_created_at + 180d - now <= 14d
BankSyncConfigView.tokenExpiresAt: Option<DateTime>
```

The card renders the expiry banner **alongside** whatever `status` says. Revision 3's DTO carried only
`status`, so the additive banner had nothing to key off.

Ladder, six ranks, first match wins (`not_connected` is evaluated first only because it is mutually
exclusive with every other condition):

| # | Condition | Status | Treasurer's action |
|---|---|---|---|
| 1 | `fio_token_encrypted IS NULL` | `not_connected` | Connect the account. |
| 2 | last error is `FioSecretKeyMissing` | `misconfigured` | **"Contact the administrator."** Never "replace your token" — the token is fine. |
| 3 | `last_error_code='fio_error'` AND `consecutive_failure_count >= 3` AND `last_error_at − COALESCE(last_success_at, token_created_at) > 6h` | `invalid` | Generate a new token. |
| 4 | `last_error_code='fio_error'` AND `token_created_at > now − 5 min` | `activating` | Nothing; Fio needs ~5 min after token creation. Not warning-coloured. |
| 5 | `last_error_code` is set but rules 3–4 did not fire | `sync_failing` | Neutral: "Načítání se nedaří, zkoušíme dál." No call to action. |
| 6 | otherwise | `ok` | |

`expiringSoon` is computed independently of all six and is **never** suppressed by them.

`rate_limited` and `too_many_movements` never reach the status — they are internal.
`history_locked` is **not** in this ladder: it is reported separately as `backfillStatus`, a property
of the backfill panel, because live sync is unaffected by it.

**[R2]** Revision 1's `token_expired` / `token_rejected` / `token_expired_by_date` are folded into
`invalid` — the treasurer's action is identical for all three, and three red states that mean one
thing is three chances to pick the wrong copy. `token_created_at + 180d ≤ now` is reported through
`tokenExpiresAt` on the DTO so the copy can say "vypršel" rather than "byl odmítnut".
The T−14 Discord DM (T10b) keys off `expiringSoon` / `tokenExpiresAt`, not off `status`.

**Q4 folded in:** the config form carries an optional "token created on" date defaulting to today. We
cannot read the real expiry from Fio, so without it the T−14 warning is only correct for a token
pasted on the day it was created.

### D12 — **[R2 — B7]** GDPR manifest entries are a required code change, not a note

`applications/server/test/integration/gdpr/exportManifest.test.ts` reads real FKs out of
`information_schema` and asserts `EXPORT_MANIFEST` covers **every** FK into `users` / `team_members`
exactly, with no drift permitted. This feature adds FKs, so **the test hard-fails until the manifest
is updated**. Revision 1 filed this as "document the outcome" (R6); it is a blocker.

Worse: `bank_sync_config` references `users`, so a naive `{kind:'export'}` disposition would put
`fio_token_encrypted` — the encrypted live bank credential — into the treasurer's downloadable data
export. `exportManifest.ts`'s own header warns about exactly this ("Putting a live session token or an
OAuth refresh token in it turns a privacy feature into a credential leak").

Required entries in `EXPORT_MANIFEST` (alphabetical within the `users` block):

```typescript
skip('bank_sync_config', 'users', ['configured_by_user_id'],
     'The club’s banking configuration — account number, IBAN, IČO, registered address and the encrypted Fio token. None of it is personal data ABOUT this person; the only tie is who last saved it. Exporting it would put the club’s bank credentials into an individual’s downloadable file.',
     { kind: 'keep', reason: 'Team-level configuration; deleting it would break the team’s finance sync. The reference is pseudonymised by scrubbing `users`.' }),
skip('bank_transactions', 'users', ['ignored_by_user_id'],
     'Bank movements of the club, including names and account numbers of NON-MEMBERS who never consented to appear in anyone’s personal export. The only tie to this person is who clicked “ignore”.',
     { kind: 'keep', reason: 'Accounting evidence for a grant audit; the reference is pseudonymised by scrubbing `users`.' }),
```

**[R4 — blocker 5 + residual, decided: `skip(...)`, not `own(...)` with `redact`.]**
Revision 3 used `own(... , ['fio_token_encrypted'])`, which would have **failed CI**:
`exportManifest.test.ts:81-90` asserts `[...NEVER_EXPORT_COLUMNS].sort()` equals an **exact
five-element literal**, and a sixth entry turns it red. Revision 3's test 173 ("runs unchanged") and
test 174 ("must contain the new column") were mutually contradictory.

Choosing `skip` resolves both at once and is the better answer on the merits: `own` would have put the
club's account number, IBAN, IČO and registered address into the **treasurer's personal** export, and
none of that is data *about* the treasurer — the only tie is "who last pressed Save". With `skip`,
**no column of `bank_sync_config` is ever exported**, which is strictly stronger than redacting one.
Consequence, stated plainly: `NEVER_EXPORT_COLUMNS` does **not** gain the token column (`skip` has no
`redact` parameter), and the five-element literal in the existing test stays **untouched**. Test 174
is replaced by a disposition guard (test 174', §7.2) asserting `bank_sync_config`'s disposition is
`exclude`, so a future flip to `export` has to be deliberate and must add the redaction in the same
edit.

Rules:
- `bank_transactions` is `{kind:'exclude'}` and its `raw` JSONB is never exported under any
  disposition.
- `payments.bank_transaction_id` / `payments.matched_by` add no FK into a person, so `payments`'
  existing entry is unchanged — but **verify** by running the test.
- `team_members.variable_symbol` is a new column on a subject table, not a new FK. Check whether the
  `team_members` export projection enumerates columns explicitly; if it does, add it (it is the
  member's own identifier and belongs in their export).

**This lands in T5's definition of done, with the manifest test in the same commit.**

### D13 — **[R2 — B10]** The export must be able to prove it is complete

Revision 1 exported whatever happened to be ingested. If the 90-day wall plus a failed unlock meant
Jan–Jun 2026 was never fetched, the January 2027 "this year" export would render authoritative-looking
totals under the club's legal name that are simply wrong — handed to a municipality as grant evidence.
Neither document had a coverage check. The fix was half-built and unused: `fioColumns.ts` already
decodes `openingBalance`/`closingBalance` and revision 1 never mentioned them again.

**(a) Record every fetched period.**

```sql
CREATE TABLE bank_statement_periods (
  team_id               UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  date_start            DATE NOT NULL,
  date_end              DATE NOT NULL,
  opening_balance_minor BIGINT NOT NULL,
  closing_balance_minor BIGINT NOT NULL,
  currency              CHAR(3) NOT NULL,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, date_start, date_end)
);
```

Upserted on every successful fetch (`ON CONFLICT … DO UPDATE`). ~365 rows per team per year.

**(b) Assert continuity — [R4 — blocker 2: revision 3's check was structurally vacuous.]**
Revision 3 asserted `closing(n) == opening(n+1)` "where the ranges abut". D1 fixes the window at
`(today−14 … today)` recorded **daily**, so the recorded periods are `(d−14,d)`, `(d−13,d+1)`, … —
they **overlap and never abut**, and the check matched **zero pairs in production**. Test 73 passed
only because its fixtures were synthetic and abutting. Backfill's 60-day chunks do not abut the
rolling windows either.

Replace it with a **per-period arithmetic check that works under overlap**. For every recorded period
whose `date_end < today`:

```sql
opening_balance_minor
  + COALESCE((SELECT SUM(bt.amount_minor) FROM bank_transactions bt
               WHERE bt.team_id = p.team_id
                 AND bt.booked_on BETWEEN p.date_start AND p.date_end), 0)
  = closing_balance_minor
```

This fires on **every** period rather than none, and it detects the thing that actually matters: a
movement inside a window we fetched but failed to ingest. Periods ending **today** are excluded — a
period ending on the current day has a provisional closing balance that will still move. A violation
sets `coverage_warning` with the offending period.

**(c) Gate the export.** `coverageFor(teamId, from, to)` merges the recorded intervals and returns the
uncovered sub-ranges.
- **PDF.** The opening balance for an arbitrary `from` is **derived, not looked up** — recorded
  `date_start`s are up to 60 days apart across a backfilled era, so an arbitrary `from` has no
  matching row. Anchor on the nearest recorded balance at or before `from` and walk the ingested
  movements forward: `balance(from−1) = anchor.opening + SUM(amount_minor WHERE booked_on BETWEEN
  anchor.date_start AND from−1)`. Print opening and closing for the requested range — an auditor
  reconciles against the real bank statement, and without this the PDF is not usable as evidence —
  plus a red **`NEÚPLNÝ VÝPIS`** band listing the missing ranges when coverage is incomplete.
- **CSV.** Fails with a typed 409 `ExportCoverageIncomplete` carrying the gap list. With
  `?acknowledgeGaps=true` it returns **200 with an `X-Export-Coverage-Gaps` response header**
  (`from/to;from/to` pairs) and the on-screen warning.
  **[R4 — blocker 3] The gap list must NOT be a comment block above the header row** — revision 3
  specified that and the design correctly forbids it: a UTF-8 BOM followed by a free-text line makes
  Excel treat that line as the header, destroying the double-clickable file D8 exists to produce. If a
  belt-and-braces in-file record is wanted, append the gaps as trailing rows after one blank row,
  never before the header.
- **[R4 — blocker 3, second half]** Coverage is modelled as `coverageGaps: [{from,to}]`, **not** a
  single `earliestIngestedOn` scalar. An interior three-day poller outage must not render
  „✅ Celé období je načtené". *(The designer is adopting this shape.)*

### D14 — **[R2 — should-fix]** `payments.paid_at` is `booked_on` at **12:00 in the team's timezone**

`payments.paid_at` is `TIMESTAMPTZ NOT NULL`; the only source is `booked_on`, a `DATE`.
`applications/server/AGENTS.md:1068-1082` is an entire section on this bug class — it "fails silently
and only west of UTC".

```typescript
DateTime.makeZoned(`${bookedOn}T12:00:00`, { timeZone, adjustForTimeZone: true })
```

Noon dodges every DST edge (no zone has a 12-hour shift) and keeps the payment on the right calendar
day in the team's own timezone on every report. **Never** anchor at `` `${date}T00:00:00Z` `` and then
`setParts` — midnight UTC is the previous day in every negative-offset zone and the result lands a
*month* late for the 1st of a short month. `timeZone` comes from `team_settings.timezone`, which is
free-form `TEXT` — fall back to `'Europe/Prague'` for an unknown zone, never throw.

### D15 — **[R2 — B5]** One `BankTransactionMatchReason` union, defined in the domain

The two documents shared **zero** literals, and the design renders them through a **closed**
`Record<Union, …>` that would not have compiled. **Ruled: the union is domain, not web.** It is defined
once in `packages/domain/src/models/BankTransaction.ts`, the DB `CHECK` enumerates it, and both
documents import it.

**[R3]** These are the **exact nine literals the designer now renders**. The union is the single
source for the web `Record`, the server engine and the DB `CHECK` — all three must list these nine and
nothing else.

```typescript
export const BankTransactionMatchReason = Schema.Literals([
  'no_vs',                    // the movement carries no VS at all
  'no_member_for_vs',         // VS present, no member in this team owns it
  'ambiguous_member',         // >1 member resolved for one VS — defensive only (see below)
  'amount_mismatch_under',    // one open assignment, amount < outstanding
  'overpayment',              // one open assignment, amount > outstanding
  'ambiguous_multiple_exact', // >=2 open assignments, more than one matches exactly
  'ambiguous_multiple_open',  // >=2 open assignments, none matching exactly
  'no_open_assignment',       // member resolved, nothing open to pay
  'currency_mismatch',        // member has open assignments, none in this currency
]);
```

**[R3] `possible_duplicate` is NOT a literal.** It is demoted to a *hint* carried alongside
`no_open_assignment` (§4 step 2.5) — agreed with the designer. Nothing in this plan may emit it as a
`match_reason`, it is absent from the DB `CHECK`, and the queue renders it as supporting text on the
`no_open_assignment` badge rather than as a tenth badge.

**[R3] `ambiguous_member` is back**, against revision 2's reasoning. The unique index does make >1
member per VS impossible, so this branch is defensive — but the designer renders copy for it, and a
literal with copy is strictly better than revision 2's "log a warning and lie about which reason it
was". If it ever fires, the row is queued with an honest label instead of being mislabelled
`no_member_for_vs`.

**Dropped from the design's original set:** `non_member_payment` (see §9.1 — the engine cannot
*observe* "not a member"; it is a resolution, not a reason) and `refund_or_reversal` (B-cut-2 —
outgoing rows never enter the queue).

### D15b — **[R3 — F3 RULING]** A new `assigned` `PaymentReminderKind`

Riding the existing reminder pipeline delays the QR to **T−3 days**, because the kinds are
`due_in_3d` / `due_today` / `overdue_3d` / `overdue_10d` / `overdue_21d`
(`packages/domain/src/models/PaymentReminder.ts`). A fee created six weeks ahead means six weeks of
silence and then a three-day scramble — and a player who pays early (very common) pays **without a
VS**, which is the precise failure this feature exists to prevent.

Add **one** kind, `assigned`, fired when the assignment is created:

```typescript
export const PaymentReminderKind = Schema.Literals([
  'assigned',        // [R3] fired once, at assignment creation — carries the QR
  'due_in_3d', 'due_today', 'overdue_3d', 'overdue_10d', 'overdue_21d',
]);
```

**It reuses the entire existing pipeline** — `payment_reminder_sync_events` outbox,
`PaymentRemindersSentRepository`, `Finance/MarkReminderSent`, `handlePaymentReminderReady`,
`buildPaymentReminderEmbed`. **One DM per assignment per kind, not two**: the bot-ack dedupe in
`FeeAssignmentsRepository.findReminderCandidates` (the two `NOT EXISTS` guards against
`payment_reminders_sent` and the unprocessed outbox) already enforces that, keyed on
`(assignment_id, kind)`.

**No migration is required — I checked.** Both constraints are generic over `kind`:
`payment_reminders_sent` is `PRIMARY KEY (assignment_id, kind)` with `kind varchar(32)` and **no CHECK**
(`1785000000_payment_reminders.ts`), and `uq_payment_reminder_sync_events_pending` is
`UNIQUE (assignment_id, kind) WHERE processed_at IS NULL` (`1785000001`). A new literal needs no DDL.

**[R4 — defect b] Revision 3's producer had three defects. Read
`applications/server/src/repositories/FeeAssignmentsRepository.ts:284-353` before implementing.**

1. **It would not have been immediate.** The whole `candidates` CTE is gated on
   `(now AT TIME ZONE tz)::time BETWEEN ts.rsvp_reminder_time AND +5 min` (L320-325), so "fires when
   the assignment is created" and "self-healing to the next minute" were both false — the real delay
   would have been **up to 24 hours**, and test 187 would have failed. It also **cannot** be a new
   `CASE` arm: the CTE yields exactly one `kind` per assignment, so an assignment that is both
   never-`assigned` and `due_in_3d` today would emit only one of the two.
   **The `assigned` arm must be a `UNION ALL` branch outside the time gate**, with its own
   `NOT EXISTS(sent)` / `NOT EXISTS(pending outbox)` guards on `(assignment_id, 'assigned')`.
2. **Fees without a due date would get no QR, silently.** L319 has
   `AND v.effective_due_at IS NOT NULL`, and `payment_reminder_sync_events.effective_due_at` is
   `timestamptz NOT NULL`, so a date-less fee cannot reach the outbox at all — yet `assigned` is
   explicitly not date-gated. **Decision: make the outbox column nullable** in `1792000003`
   (`ALTER TABLE payment_reminder_sync_events ALTER COLUMN effective_due_at DROP NOT NULL`) and drop
   the `IS NOT NULL` predicate on the `assigned` branch only. A fee with no due date is a perfectly
   ordinary "pay when you can" fee and is exactly the case where an early QR helps most. The bot's
   embed must then render the due-date field conditionally.
3. **Every existing team would start getting a new DM family.** Nothing gated `assigned` on the team
   having a Fio connection, and `handlePaymentReminderReady` deliberately falls back to sending
   without the QR — so a club that never asked for bank sync would get a "Nový předpis" DM per
   assignment on deploy day. The seed migration stops the *backlog*, not the ongoing behaviour.
   **Gate the branch on
   `EXISTS (SELECT 1 FROM bank_sync_config bsc WHERE bsc.team_id = tm.team_id AND bsc.enabled)`.**
   The kind exists to deliver a QR; with no bank connection there is no QR and no reason to DM.

**Backfill:** on first deploy every pre-existing assignment in a Fio-enabled team would still be an
`assigned` candidate, so `1792000003` MUST also seed `payment_reminders_sent` for every existing
`fee_assignments` row with `kind = 'assigned'` — the documented "Backfill `*_sent_at` Idempotency
Markers on Add" rule (`packages/migrations/AGENTS.md`).

### D16 — **[R2]** `match_state` values and the four resolve modes

**[R3]** Revision 2 introduced a separate `other_income` state. That is **cut** — one mechanism, not
two. The actual defect the designer identified is a **copy** defect (rendering „Ignorováno" next to a
120 000 Kč municipal grant in an audit export), so it is fixed with a discriminator on the existing
state, not with a second state and a second endpoint.

```
BankTransactionMatchState =
  'unmatched' | 'partially_matched' | 'matched' | 'ignored' | 'not_applicable'

BankTransactionResolutionKind =            -- nullable; only meaningful when match_state = 'ignored'
  'other_income' | 'not_relevant'
```

**[R4 — blocker 7] `'duplicate'` is dropped.** Revision 3 made `resolution_kind` NOT NULL whenever
`match_state='ignored'` and enumerated three values, but the design has no third mode: two modes in
§3.6, two row-menu items, two bulk actions, two filter tabs, and no „Duplikát" label anywhere — yet
test 172b asserted the export prints it. A NOT-NULL enum value with no producer, no copy and no UI is
a guaranteed runtime hole. The duplicate hint's one-click action becomes `not_relevant` with a
**pre-filled reason** („Duplikát platby z {datum}"), which needs no new mode, key, chip or summary
count.

- `not_applicable` — every `direction='outgoing'` row. Outgoing movements are club **expenses**,
  recorded separately in the `expenses` table; they are ingested for the ledger and the export but
  **never enter the queue**. This is what B-cut-2 buys: no `reversal_pending`, no order-id index, no
  pin-to-top UI. A treasurer who wants to annotate one can still `ignore` it with a reason from the
  ledger.
- `ignored` — requires `ignored_reason`, `ignored_by_user_id` and `resolution_kind` (all
  CHECK-enforced together). Reversible. Ignored rows stay in the queue's `Ignorováno` filter and in the
  export — closing the design's Q4 as "yes".
- **[R3/R4] `resolution_kind` is what the export reads to pick a word.** `'other_income'` renders
  „Jiný příjem klubu"; `'not_relevant'` renders „Ignorováno". One state, one endpoint, one trigger
  guard, two labels. **No `expenses` row is written** for
  `other_income` — `expenses.amount_minor` has `CHECK > 0` with a `spent_at` constraint and models
  outgoings only, and `ExpenseApi.BalanceSummary.incomeMinor` derives from `payments`. The bank
  movement *is* the income record. Widening `balanceSummary` is explicit follow-up work.

The resolve dialog's modes map to:

| Mode (design §3.6) | Write |
|---|---|
| Přiřadit členovi | `payments.insert` × 1 |
| ↳ "Přeplatek — ponechat" | `payments.insert` with `amountMinor > outstanding`; `fee_assignments.paid_minor` has no upper CHECK, so this is legal and the transaction leaves the queue (see Q4) |
| ↳ **[R3]** "Beru jako vyrovnané v plné výši" | **Not implemented in this dialog.** It hands off to the existing `WaiveAssignmentDialog` (`web/src/components/organisms/WaiveAssignmentDialog.tsx`, already wired to `FinanceApi.updateAssignment`). Revision 2 planned a waiver sub-mode; the write path already exists and duplicating it in a second dialog is how two waiver UIs drift. |
| Rozdělit mezi víc předpisů | `payments.insert` × N; the assignments are locked by the SQL `… WHERE id = ANY($1) ORDER BY id FOR UPDATE`, which is the lock-order enforcement point (D10c point 3) — **no JS-side sort** |
| Jiný příjem klubu | **[R3]** the `ignore` endpoint with `kind: 'other_income'` + description — not a separate endpoint |
| Ignorovat | the `ignore` endpoint with `kind: 'not_relevant'` + reason (pre-filled „Duplikát platby z {datum}" when the duplicate hint is present) |

**[R3] Bulk ignore stays.** The first backfill can import a year of movements; resolving 200 rows one
dialog at a time is how a feature gets abandoned in week one. `POST …/bulk` applies one shared
`{ kind, reason }` to a selected set. Bulk *assign-to-member* remains absent, per the design — that is
a per-row judgement about a specific person's specific fee.

### D10c — **[R2 — B3]** Canonical lock order, stated as an invariant

`recompute_paid_minor` does `FOR UPDATE` on `fee_assignments` (`1783000000_create_finance.ts:79`) per
inserted `payments` row, so a multi-allocation `/match` takes assignment locks in **allocation array
order**. Two concurrent splits over `[A,B]` and `[B,A]` deadlock; Postgres kills one with `40P01`,
which `catchSqlErrors` surfaces as an untyped `SqlError` **on a money operation**.

**[R4 — defect a] Revision 3's invariant omitted `payments`, and that was a live deadlock.**
`api/finance.ts`'s `voidPayment` locks the **`payments` row first** (`UPDATE payments SET voided_at…`),
then `bank_transactions` (the new trigger), then `fee_assignments` (the existing recompute).
`/unmatch` both voids payments **and** sets `auto_match_suppressed` on `bank_transactions`; on the
natural reading — flag first, then void — the order is inverted. Counterexample: connection 1
`/unmatch` locks BT(T) and blocks on payment P; connection 2 `voidPayment(P)` locks P and blocks on
BT(T) → `40P01` on a money operation, surfacing through `catchSqlErrors` as an untyped `SqlError`.

**Invariant, to be repeated as a comment at every write site:**

> **Lock order is `payments` (by id ASC) → `bank_transactions` (by id) → `fee_assignments` (by id ASC).
> Always.**

Enforced by:
1. `/unmatch` **voids every payment first**, and only then updates `bank_transactions`
   (`auto_match_suppressed`, `match_reason`) — in one transaction. The flag write must not precede the
   voids. This is the fix for defect (a) and is restated in §4.
2. Auto-match and manual `/match` lock the `bank_transactions` row before any assignment
   (§4 step 4) — they create payments rather than locking existing ones, so `payments` is not
   contended there.
3. Every allocation list is ordered by `assignmentId` ascending. **[R4 — defect h]** The actual
   enforcement point is the SQL `SELECT … WHERE id = ANY($1) ORDER BY id FOR UPDATE` — Postgres places
   `LockRows` above `Sort`, so rows are locked in sorted order regardless of the array's order. The
   JS-side `allocations.sort()` is therefore **redundant and is dropped**; keeping it implied a
   guarantee it did not provide, and it would have sorted UUIDs as JS strings, which only coincides
   with Postgres byte order for lowercase canonical UUIDs. The `ORDER BY id` in the SQL is the
   invariant; annotate it as such.
4. The single trigger in D7b, whose `PERFORM` order puts `bank_transactions` before `fee_assignments`
   explicitly.

---

## 2. Complete migration SQL

Pick ids at **merge time**: `ls -1 packages/migrations/src/before/ | sort | tail -1`. Highest at
writing is `1791700000_add_series_times_team_local_flag.ts`, so these use `1792000000/1/2/3`.
Everything is idempotent so a renumber is safe. (A duplicate id surfaces as `No test files found,
exiting with code 1` from the integration `globalSetup`, naming nothing.)

**[R3]** A fourth file, `1792000003_assigned_reminder_kind.ts`, seeds
`payment_reminders_sent (assignment_id, 'assigned')` for every pre-existing `fee_assignments` row, so
the new `assigned` reminder kind (D15b) does not blast every existing assignment on first deploy —
the documented "Backfill `*_sent_at` Idempotency Markers on Add" rule:

```sql
INSERT INTO payment_reminders_sent (assignment_id, kind)
SELECT fa.id, 'assigned' FROM fee_assignments fa
ON CONFLICT (assignment_id, kind) DO NOTHING
```

The `assigned` literal itself needs **no** DDL: `payment_reminders_sent.kind` is `varchar(32)` with no
CHECK, and `uq_payment_reminder_sync_events_pending` is generic over `kind`. Verified in
`1785000000_payment_reminders.ts` and `1785000001_payment_reminders_unique_pending.ts`.
`1792000003` also drops `NOT NULL` from `payment_reminder_sync_events.effective_due_at` (D15b defect 2).

**[R4 — blocker 6] A fifth file, `1792000004_create_bank_token_expiry_events.ts`.** T10b ships
`BankTokenExpiringEvent` + `BankTokenExpiryCron` with an outbox ack, and §3.2 adds the read/ack RPCs —
but **every outbox in this repo is a dedicated table** (`payment_reminder_sync_events`,
`role_sync_events`, `achievement_sync_events`, `channel_sync_events`, …); there is no generic one, and
`payment_reminder_sync_events` cannot be reused (it is FK'd to `fee_assignments` with `fee_name`,
`currency`, `amount_minor`, `paid_minor` all `NOT NULL`). Revision 3 assumed a table that does not
exist. Mirror the reference implementation:

```sql
CREATE TABLE IF NOT EXISTS bank_token_expiry_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  guild_id        text NOT NULL,
  user_discord_id text NOT NULL,
  threshold_days  integer NOT NULL,          -- 14 | 7 | 1
  token_expires_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  error           text
);
CREATE INDEX IF NOT EXISTS idx_bank_token_expiry_events_unprocessed
  ON bank_token_expiry_events (created_at) WHERE processed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_token_expiry_events_pending
  ON bank_token_expiry_events (team_id, threshold_days) WHERE processed_at IS NULL;

-- Delivery log: T-14 / T-7 / T-1 must each fire exactly once per token generation.
CREATE TABLE IF NOT EXISTS bank_token_expiry_sent (
  team_id         uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  token_created_at timestamptz NOT NULL,     -- scopes the log to THIS token, so a new token re-arms
  threshold_days  integer NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, token_created_at, threshold_days)
);
```

`bank_token_expiry_sent` is written **only** by the bot's mark-sent RPC after Discord accepts, per
`applications/server/AGENTS.md` → "Bot-Ack Idempotency for Discord-Side-Effect Crons", and the cron's
candidate query carries the two `NOT EXISTS` guards on `(team_id, token_created_at, threshold_days)`.
Keying the sent-log on `token_created_at` is what makes a **replacement** token re-arm all three
thresholds without a manual reset.

### `1792000000_add_team_member_variable_symbol.ts`

```typescript
import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE team_members ADD COLUMN IF NOT EXISTS variable_symbol TEXT`),
    Effect.tap(
      () => sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'team_members_variable_symbol_format') THEN
            ALTER TABLE team_members ADD CONSTRAINT team_members_variable_symbol_format
              CHECK (variable_symbol IS NULL OR variable_symbol ~ '^[0-9]{1,10}$');
          END IF;
        END $$
      `,
    ),
    // Unique per team on the leading-zero-stripped form; multiple NULLs stay legal.
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_team_members_team_variable_symbol
          ON team_members (team_id, (NULLIF(ltrim(variable_symbol, '0'), '')))
          WHERE variable_symbol IS NOT NULL
      `,
    ),
  ),
);
```

### `1792000001_create_bank_sync_config.ts`

```typescript
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_sync_config (
          team_id                   UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
          provider                  TEXT NOT NULL DEFAULT 'fio' CHECK (provider IN ('fio')),
          enabled                   BOOLEAN NOT NULL DEFAULT false,
          auto_match_enabled        BOOLEAN NOT NULL DEFAULT true,

          -- Account identity (feeds the pure CZ IBAN builder -> SPAYD ACC)
          account_prefix            TEXT CHECK (account_prefix IS NULL OR account_prefix ~ '^[0-9]{1,6}$'),
          account_number            TEXT CHECK (account_number IS NULL OR account_number ~ '^[0-9]{2,10}$'),
          bank_code                 TEXT CHECK (bank_code IS NULL OR bank_code ~ '^[0-9]{4}$'),
          iban                      TEXT,        -- cached from Fio info.iban, cross-check only
          currency                  CHAR(3) NOT NULL DEFAULT 'CZK',

          -- Organisation identity, printed on the PDF (D13 / design 7.4)
          -- [R3] recipient_name is required once enabled: SPAYD RN needs it AND the PDF header
          -- prints it. registered_id / registered_address are the designer's names.
          recipient_name            TEXT,
          registered_id             TEXT CHECK (registered_id IS NULL OR registered_id ~ '^[0-9]{8}$'),
          registered_address        TEXT,
          bank_name                 TEXT,

          -- Secret (AES-256-GCM, v1.<iv>.<tag>.<ct> base64url). Plain TEXT column.
          fio_token_encrypted       TEXT,
          fio_token_created_at      TIMESTAMPTZ,

          -- Backfill walk (bounded loop writes the cursor after each chunk)
          backfill_from             DATE,
          backfill_cursor           DATE,
          -- [R4 — blocker 1] the forked backfill fiber's progress, polled by the client
          backfill_status           TEXT CHECK (backfill_status IS NULL OR backfill_status IN
                                      ('running','complete','history_locked','budget','failed')),
          backfill_run_id           UUID,

          -- Status / backoff bookkeeping
          last_synced_at            TIMESTAMPTZ,
          last_success_at           TIMESTAMPTZ,
          last_error_code           TEXT,
          last_error_at             TIMESTAMPTZ,
          consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at           TIMESTAMPTZ,
          coverage_warning          TEXT,

          -- Distributed poll lease (D10b)
          poll_leased_until         TIMESTAMPTZ,
          poll_leased_by            TEXT,

          configured_by_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

          -- An enabled config must be complete enough to poll, to build an IBAN, and to emit
          -- a SPAYD payload (RN) and a PDF header. [R3] recipient_name joins the gate.
          CHECK (NOT enabled OR (account_number IS NOT NULL
                             AND bank_code IS NOT NULL
                             AND recipient_name IS NOT NULL))
        )
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE INDEX IF NOT EXISTS idx_bank_sync_config_pollable
          ON bank_sync_config (team_id)
          WHERE enabled = true AND fio_token_encrypted IS NOT NULL
      `,
    ),
    // Per-token 30 s throttle, shared across replicas (D10b(a)).
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS fio_token_throttle (
          token_fingerprint    TEXT PRIMARY KEY,
          next_call_allowed_at TIMESTAMPTZ NOT NULL
        )
      `,
    ),
    // Coverage evidence for the export (D13).
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_statement_periods (
          team_id               UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          date_start            DATE NOT NULL,
          date_end              DATE NOT NULL,
          opening_balance_minor BIGINT NOT NULL,
          closing_balance_minor BIGINT NOT NULL,
          currency              CHAR(3) NOT NULL,
          fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (team_id, date_start, date_end)
        )
      `,
    ),
  ),
);
```

### `1792000002_create_bank_transactions.ts`

```typescript
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE TABLE IF NOT EXISTS bank_transactions (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          team_id                UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          provider               TEXT NOT NULL DEFAULT 'fio' CHECK (provider IN ('fio')),

          fio_movement_id        BIGINT NOT NULL,   -- column22, up to 11 digits, never int4
          fio_order_id           TEXT,              -- column17, NOT unique, never reconciled on

          booked_on              DATE NOT NULL,     -- column0, first 10 chars
          amount_minor           BIGINT NOT NULL CHECK (amount_minor <> 0),  -- signed
          direction              TEXT GENERATED ALWAYS AS
                                   (CASE WHEN amount_minor < 0 THEN 'outgoing' ELSE 'incoming' END) STORED,
          currency               CHAR(3) NOT NULL,  -- column14

          variable_symbol        TEXT,   -- column5
          constant_symbol        TEXT,   -- column4
          specific_symbol        TEXT,   -- column6

          counterparty_account   TEXT,   -- column2
          counterparty_bank_code TEXT,   -- column3
          counterparty_name      TEXT,   -- column10
          counterparty_bank_name TEXT,   -- column12
          counterparty_bic       TEXT,   -- column26
          payer_reference        TEXT,   -- column27

          message_for_recipient  TEXT,   -- column16
          user_identification    TEXT,   -- column7
          tx_type                TEXT,   -- column8
          entered_by             TEXT,   -- column9
          specification          TEXT,   -- column18
          comment                TEXT,   -- column25

          match_state            TEXT NOT NULL DEFAULT 'unmatched'
                                   CHECK (match_state IN ('unmatched','partially_matched','matched',
                                                          'ignored','not_applicable')),
          -- [R3] exactly the nine literals of BankTransactionMatchReason. possible_duplicate is a
          -- hint, not a reason, and is deliberately absent.
          match_reason           TEXT
                                   CHECK (match_reason IS NULL OR match_reason IN
                                     ('no_vs','no_member_for_vs','ambiguous_member','amount_mismatch_under',
                                      'overpayment','ambiguous_multiple_exact','ambiguous_multiple_open',
                                      'no_open_assignment','currency_mismatch')),
          match_evidence         JSONB,   -- what the engine considered and why (D5, B6)
          auto_match_suppressed  BOOLEAN NOT NULL DEFAULT false,  -- set by /unmatch, cleared by a manual match

          ignored_reason         TEXT,
          ignored_by_user_id     UUID REFERENCES users(id) ON DELETE RESTRICT,
          -- [R3] discriminates the three flavours of `ignored` so the audit export can print
          -- "Jiný příjem klubu" instead of "Ignorováno" next to a 120 000 Kč municipal grant.
          resolution_kind        TEXT CHECK (resolution_kind IS NULL OR resolution_kind IN
                                   ('other_income','not_relevant')),

          raw                    JSONB NOT NULL,
          ingested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

          CHECK (match_state <> 'ignored'
                 OR (ignored_reason IS NOT NULL AND ignored_by_user_id IS NOT NULL
                     AND resolution_kind IS NOT NULL)),
          CHECK (match_state = 'ignored' OR resolution_kind IS NULL),
          UNIQUE (team_id, provider, fio_movement_id)
        )
      `,
    ),
    Effect.tap(() => sql`
      CREATE INDEX IF NOT EXISTS idx_bank_transactions_team_booked
        ON bank_transactions (team_id, booked_on DESC, id DESC)`),
    Effect.tap(() => sql`
      CREATE INDEX IF NOT EXISTS idx_bank_transactions_queue
        ON bank_transactions (team_id, booked_on DESC)
        WHERE match_state IN ('unmatched','partially_matched')`),
    // duplicate-hint lookup (S4 step 2.5)
    Effect.tap(() => sql`
      CREATE INDEX IF NOT EXISTS idx_bank_transactions_dup
        ON bank_transactions (team_id, variable_symbol, amount_minor, booked_on)
        WHERE direction = 'incoming'`),

    // ---- D7: one payment -> one bank transaction ---------------------------
    Effect.tap(() => sql`
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS bank_transaction_id UUID
        REFERENCES bank_transactions(id) ON DELETE RESTRICT`),
    Effect.tap(() => sql`
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS matched_by TEXT`),
    Effect.tap(() => sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_matched_by_values') THEN
          ALTER TABLE payments ADD CONSTRAINT payments_matched_by_values
            CHECK (matched_by IS NULL OR matched_by IN ('auto','manual'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_bank_match_pair') THEN
          ALTER TABLE payments ADD CONSTRAINT payments_bank_match_pair
            CHECK ((bank_transaction_id IS NULL AND matched_by IS NULL)
                OR (bank_transaction_id IS NOT NULL AND matched_by IS NOT NULL));
        END IF;
      END $$`),
    Effect.tap(() => sql`
      CREATE INDEX IF NOT EXISTS idx_payments_bank_transaction
        ON payments (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL`),

    // ---- D7b: match_state is trigger-maintained ----------------------------
    // (functions + trigger exactly as printed in D7b; the trigger NAME is load-bearing)
    Effect.tap(() => sql`CREATE OR REPLACE FUNCTION recompute_bank_match_state(...) ...`),
    Effect.tap(() => sql`CREATE OR REPLACE FUNCTION payments_bank_match_trigger() ...`),
    Effect.tap(() => sql`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payments_recompute_bank_match_state') THEN
          CREATE TRIGGER payments_recompute_bank_match_state
            AFTER INSERT OR UPDATE OR DELETE ON payments
            FOR EACH ROW EXECUTE FUNCTION payments_bank_match_trigger();
        END IF;
      END $$`),
  ),
);
```

**Read-path notes:**
- `booked_on` / `date_start` / `date_end` are `DATE`; node-pg parses type 1082 into a JS `Date`. Select
  as `booked_on::text AS booked_on` and decode with `Schema.String` (same treatment as
  `u.birth_date::text`). **Not** `to_char` — that rule is for `timestamptz`.
- `amount_minor`, `fio_movement_id`, `*_balance_minor` are `BIGINT` → strings from node-pg. Use the
  number-or-numeric-string union (D4).
- **`updated_at` is set explicitly in every UPDATE statement.** There is no generic touch trigger in
  this repo, so a `DEFAULT now()` column with nothing maintaining it is a lie.

---

## 3. File-by-file changes

### 3.1 `packages/domain`

| Path | Contents |
|---|---|
| `src/models/CzIban.ts` *(new)* | Pure. `buildCzIban({ prefix, accountNumber, bankCode })`, **plus `isValidCzAccountNumber` — the Czech bank-account modulo-11 weight check**. |
| `src/models/CzIco.ts` *(new)* | **[R4 — defect j]** Pure. `isValidIco(s: string): boolean`. The design requires an IČO checksum for the PDF header's `registered_id` and revision 3 tasked it nowhere — `1792000001` had only a `^[0-9]{8}$` shape check, and it is a **different** algorithm from the account check (different weights, different modulus handling), so it cannot live in `CzIban.ts`. |
| `src/models/Spayd.ts` *(new)* | Pure. `buildSpayd(input)`, `toSpaydMessage(text, maxLen)`, `transliterateToSpaydAscii(s)`, `formatAmountMajor(minor: bigint)`, limit constants. |
| `src/models/BankSyncConfig.ts` *(new)* | `BankSyncProvider`, **`BankSyncStatusCode`** (D11), `BankSyncBackfillStatus`, `BankSyncConfig` `Model.Class`. |
| `src/models/BankTransaction.ts` *(new)* | `BankTransactionId`, `BankTransactionDirection`, **`BankTransactionMatchState`** (D16), **`BankTransactionMatchReason`** (D15 — the single source for web, server and DB CHECK), `SignedAmountMinor`, `VariableSymbol`, `BankTransaction` `Model.Class`. |
| `src/api/BankSyncApi.ts` *(new)* | HTTP contract (§3.1.3). |
| `test/CzIban.test.ts`, `test/Spayd.test.ts` *(new)* | Required in the same PR (`packages/domain/AGENTS.md` pure-algorithm rule 4). |
| `src/models/TeamMember.ts` | `+ variable_symbol: Model.FieldExcept(['insert'])(Schema.OptionFromNullOr(Schema.String))` — mirror `jersey_number`. |
| `src/api/Roster.ts` | `RosterPlayer` + `UpdatePlayerRequest` gain `variableSymbol: Schema.OptionFromNullOr(Schema.String)`. `VariableSymbolTaken` error (409) carrying `holderMemberId` + `holderName` so the client can render "Tento symbol už má Petra Svobodová". |
| `src/rpc/finance/FinanceRpcGroup.ts` | `+ Rpc.make('GetPaymentQr', { payload: { assignment_id }, success: PaymentQrResult, error: FinanceQrUnavailable })`. |
| `src/rpc/finance/FinanceRpcModels.ts` | `+ PaymentQrResult { spayd, png_base64, filename }`, `+ FinanceQrUnavailable`. |
| `src/rpc/finance/FinanceRpcEvents.ts` | **[R2]** `+ BankTokenExpiringEvent` (`team_id`, `guild_id`, `user_discord_id`, `days_until_expiry`) — the T−14 Discord DM (ruled: ship it). |
| `src/models/PaymentReminder.ts` | **[R3 — F3]** `+ 'assigned'` to `PaymentReminderKind` (D15b). No DB constraint change; a seeding migration is still required. |
| `src/index.ts` | Regenerated by `pnpm codegen`. |

#### `CzIban.ts`

```
BBAN  = bankCode(4, zero-padded) + prefix(6, zero-padded) + accountNumber(10, zero-padded)
check = 98 - ( BigInt(BBAN + "1235" + "00") % 97n )   // "CZ" -> C=12, Z=35
IBAN  = "CZ" + String(check).padStart(2, "0") + BBAN  // length 24
```

**Bank code FIRST, then prefix, then account** — prefix-first is the classic bug and needs an explicit
test. `BigInt` is mandatory (26 digits overflows `Number`).

Verified vectors: `19-2000145399/0800` → `CZ6508000000192000145399`; `1265098001/5500` →
`CZ5855000000001265098001`; `76327632/0300` → `CZ7603000000000076327632`; **our account**
`2703474850/2010` → `CZ7120100000002703474850`; `123456-2703474850/2010` → `CZ6920101234562703474850`.

⚠️ The IBANs in Fio's PDF and the `fiobank` fixture **fail mod-97** (anonymised data with un-recomputed
check digits). Never use them as vectors. Fio's live `info.iban` is a correct cross-check; log a
warning on mismatch, never silently prefer one.

**[R2] `isValidCzAccountNumber(prefix, accountNumber)` — Czech bank-account modulo-11.** Weights
`[10,5,8,4,2,1,6,3,7,9,10,5,8,4,2,1]` applied right-to-left to prefix (6) and account (10) separately;
each weighted sum must be `≡ 0 (mod 11)`.

**[R4 — defect j] `isValidIco(s)` — the IČO checksum, a DIFFERENT algorithm.** In `CzIco.ts`:

```
digits d1..d8; sum = 8*d1 + 7*d2 + 6*d3 + 5*d4 + 4*d5 + 3*d6 + 2*d7
r = sum mod 11
check = (11 - r) mod 10      // must equal d8
```

**Write the check digit as that single expression, not a branch ladder.** It is already correct for
every edge case — `r=0 → 1`, `r=1 → 0`, `r=10 → 1` — and a hand-written `IF r = 0 THEN 1 ELSIF …`
ladder is exactly where this gets typed wrong. Verified vectors: `61858374` (sum 183, r 7, c 4),
`45244782` (sum 152, r 9, c 2), `45274649` (sum 156, r 2, c 9). Without it a mistyped account number produces the same
bodyless 500 as a bad token, and the treasurer spends an evening replacing a good token. It also stops
`buildCzIban` zero-padding a 2-digit typo into a valid-looking IBAN for a nonexistent account.

#### `Spayd.ts`

`SPD*1.0*KEY:value*KEY:value*`. Only `ACC` is mandatory; keys uppercase; no whitespace around values.

Guaranteed-supported: `ACC`, `AM`, `CC`, `DT`, `MSG`, `X-VS`, `X-SS`, `X-KS`. **`RN` is NOT
guaranteed** — emit for readability, never rely on it. **Reconcile on `X-VS`.**

| Key | Limit |
|---|---|
| `ACC` | 46 (`IBAN` or `IBAN+BIC`) |
| `AM` | 10 chars, max 2 dp, `.` separator, max `9999999.99`; always both decimals (`500.00`) |
| `CC` | exactly 3 |
| `DT` | exactly 8, `YYYYMMDD` |
| `MSG` | **60** |
| `X-VS` / `X-SS` / `X-KS` | **10** integer chars |

- Over-length values are **silently truncated from the left by the reader**, so we enforce limits
  ourselves.
- **[R2 — ruled: design wins] `MSG` is budgeted and truncated, never rejected.** Revision 1 asserted
  rejection, which would have made a 62-character fee name produce `FinanceQrUnavailable` for every
  player — causing exactly the "paid without a VS" failure this feature exists to prevent.
  `toSpaydMessage(text, 60)` transliterates, then truncates on a word boundary with a single-character
  ellipsis budget, and runs **in front of** `buildSpayd`'s validation. `buildSpayd` still rejects an
  over-length `MSG` — that path is now unreachable from our own callers and exists to catch a future
  caller that forgets `toSpaydMessage`.
- `X-VS` over 10 chars is still a **hard reject** — a truncated VS is a mis-credited payment, which is
  strictly worse than no QR. (The `CHECK` on `team_members.variable_symbol` makes it unreachable.)
- Escaping is **percent-encoding**; `*` is the only forbidden character in a value → `%2A`; `:` is
  explicitly allowed unescaped.
- **Omit `CRC32`** — rarely emitted, widely ignored, and a mis-canonicalised one is worse than none.
- Amount: **never** round-trip through a float —
  `` `${n / 100n}.${String(n % 100n).padStart(2, '0')}` `` with `BigInt`.

**Transliteration (the diacritics performance cliff).** Any lowercase letter or diacritic drops the QR
out of alphanumeric mode into byte mode: a 117-char payload is version 5 (37×37) alphanumeric but
version 7 (45×45) byte, and `á` → `%C3%A1` turns 1 char into 6. Pipeline: NFD-decompose → strip
`\p{Diacritic}` → uppercase → explicitly map non-decomposables (`–`/`—` → `-`, `„ " " ' '`, `…` →
`...`) → strip anything outside `[0-9A-Z $%*+\-./:]` → collapse spaces → trim → enforce the cap. Czech
treasurers expect unaccented payment messages; this is the norm, not a defect. Accented text stays in
the PDF/email body, where we control the font.

**QR rendering** (in `QrRenderer.ts`): error correction level **M** (spec-mandated, node-qrcode's
default); **do not set `margin: 0`** — the 4-module quiet zone is the #1 cause of "won't scan"; ≥ 25 mm
printed / ≥ 200 px on screen with **explicit width and height** (SVG `viewBox` scaling is ignored by
email clients).

#### `src/api/BankSyncApi.ts`

```
GET    /teams/:teamId/bank-sync                        -> BankSyncConfigView      finance:record_payments
PUT    /teams/:teamId/bank-sync                        -> BankSyncConfigView      finance:manage_fees
POST   /teams/:teamId/bank-sync/test                   -> BankSyncTestResult      finance:manage_fees
POST   /teams/:teamId/bank-sync/backfill               -> 202 { backfillRunId }    finance:manage_fees
        [R4] returns immediately; the loop runs in Effect.forkDaemon (§5). Poll GET /bank-sync
        for backfillCursor / backfillStatus / backfillRunId.
GET    /teams/:teamId/bank-sync/summary                -> BankSyncSummaryView     finance:record_payments
GET    /teams/:teamId/bank-transactions                -> [BankTransactionView]   finance:record_payments
        query: from, to, state, direction, reason, q  (all Schema.OptionFromOptional)
GET    /teams/:teamId/bank-transactions/:txId          -> BankTransactionDetailView
POST   /teams/:teamId/bank-transactions/:txId/match    -> BankTransactionDetailView
POST   /teams/:teamId/bank-transactions/:txId/unmatch  -> BankTransactionDetailView
POST   /teams/:teamId/bank-transactions/:txId/ignore   -> BankTransactionDetailView
        payload: { kind: 'other_income'|'not_relevant', reason: NonEmptyString }
POST   /teams/:teamId/bank-transactions/bulk           -> BulkResolveResult
        payload: { txIds: [...], kind, reason }   -- [R3] bulk ignore only; never bulk assign
POST   /teams/:teamId/bank-transactions/rematch        -> RematchResult
GET    /teams/:teamId/bank-transactions/export.csv     -> Schema.Void (raw)      finance:record_payments
        query: from, to, acknowledgeGaps
GET    /teams/:teamId/bank-transactions/export.pdf     -> Schema.Void (raw)
        query: from, to, docLabel
GET    /teams/:teamId/members/variable-symbols/suggest -> [VariableSymbolSuggestion]  member:edit
POST   /teams/:teamId/members/variable-symbols/assign  -> [RosterPlayer]              member:edit
GET    /teams/:teamId/fees/:feeId/assignments/:assignmentId/qr.png -> Schema.Void (raw)
```

**[R2 — ruled: design wins] The ledger is gated on `finance:record_payments`, not `finance:view`.**
`packages/domain/src/models/Role.ts:77` gives Captains `finance:view` but not `finance:record_payments`;
gating the ledger on `finance:view` would show every Captain the names, account numbers and payment
messages of non-members who paid the club. `finance:view` still covers aggregate KPIs elsewhere.
This closes revision 1's Q7.

**Write-only token** (mirrors `EmailForwardingApi`'s `imap_secret` / `imapSecretSet`):

```typescript
export const UpsertBankSyncConfigRequest = Schema.Struct({
  enabled: Schema.Boolean,
  auto_match_enabled: Schema.Boolean,
  account_prefix: Schema.OptionFromNullOr(Schema.String),
  account_number: Schema.String,
  bank_code: Schema.String,
  currency: CurrencyCode,
  recipient_name: Schema.OptionFromNullOr(Schema.String),   // required when enabled — filter-checked
  registered_id: Schema.OptionFromNullOr(Schema.String),
  registered_address: Schema.OptionFromNullOr(Schema.String),
  bank_name: Schema.OptionFromNullOr(Schema.String),
  // absent => keep the stored token. Redacted so it cannot be stringified by accident (D10).
  fio_token: Schema.OptionFromOptional(Schema.RedactedFromValue(Schema.NonEmptyString)),
  fio_token_created_at: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
});
```

`BankSyncConfigView` exposes **`fioTokenSet: Boolean`** and never the token, plus
`status: BankSyncStatusCode`, `backfillStatus`, `tokenCreatedAt`, `tokenExpiresAt`, `lastSuccessAt`,
`lastAttemptAt`, `lastAttemptFailed`, `computedIban`, `coverageWarning`.

**[R2] `BankSyncSummaryView`** (the design's queue KPIs have nothing to render without it):
`importedCount`, `pendingCount`, `matchedCount`, `ignoredCount`, `otherIncomeCount`,
`autoMatchedLast30d`, `manuallyMatchedLast30d`, `membersWithoutVsCount`, `oldestPendingBookedOn`,
`periodIncomeMinor`, `periodExpensesMinor`, `periodNetMinor`, `coverageGaps: [{from,to}]`.

Errors: `BankSyncForbidden` (403), `BankSyncNotConfigured` (404), `BankTransactionNotFound` (404),
`BankTransactionAlreadyMatched` (409), `BankSyncBusy` (409), `InvalidBankAccount` (400),
`ExportCoverageIncomplete` (409, carries the gap list), `AssignmentNotFound` (404),
`VariableSymbolTaken` (409).

### 3.2 `applications/server`

#### New files

| Path | Purpose |
|---|---|
| `src/services/secretBox.ts` | Pure AES-256-GCM primitives extracted from `EmailSecretCrypto`, parameterised by error constructors. |
| `src/services/FioSecretCrypto.ts` | `FioSecretKeyMissing` / `FioSecretDecryptError`, `FIO_TOKEN_ENCRYPTION_KEY`, `makeWithKey(Option<string>)` seam. `decrypt` returns `Redacted.Redacted<string>`. |
| `src/services/fioColumns.ts` | **Pure.** Schema + sanitisers. Every column optional AND nullable. |
| `src/services/FioApiClient.ts` | `HttpClient` via `Effect.serviceOption`; `SqlClient` for the throttle reservation. `fetchPeriod` only (D1 drops `set-last-*`). All four D10 defences. |
| `src/services/bankSyncStatus.ts` | **Pure.** D11 ladder. |
| `src/services/matchDecision.ts` | **Pure.** §4 decision table as a total function. |
| `src/services/BankTransactionMatcher.ts` | Effect service: locking, DB reads/writes, one transaction. |
| `src/services/BankSyncPoller.ts` | Hourly cron. Exports `bankSyncPollerEffect` + `BankSyncPoller`. |
| `src/services/BankSyncBackfill.ts` | The bounded synchronous loop (D-B9). |
| `src/services/BankTokenExpiryCron.ts` | Daily. Emits `bank_token_expiring` at T−14 / T−7 / T−1, bot-ack-idempotent. |
| `src/repositories/BankTokenExpiryEventsRepository.ts` | **[R4 — blocker 6]** Its own outbox table (`1792000004`), modelled on `PaymentReminderSyncEventsRepository`: `emit`, `findUnprocessed`, `markProcessed`, `markFailed`, `markSent`. |
| `src/services/QrRenderer.ts` | `qrcode` wrapper. |
| `src/services/BankStatementPdf.ts` | `pdfkit` + vendored TTF. |
| `src/services/bankCoverage.ts` | **Pure.** Interval merge + gap computation + continuity assertion (D13). |
| `src/utils/csv.ts` | **Pure.** D8. |
| `src/repositories/BankSyncConfigRepository.ts` | Incl. lease claim/release and throttle reservation. |
| `src/repositories/BankTransactionsRepository.ts` | |
| `src/api/bank-sync.ts` | `BankSyncApiLive`. |
| `src/assets/fonts/NotoSans-{Regular,Bold}.ttf`, `LICENSE-OFL.txt` | D9. |
| `scripts/copy-assets.mjs`, `scripts/assert-dist.mjs` | Build asset copy + postbuild assertion. |

#### Modified files

| Path | Change |
|---|---|
| `src/env.ts` | `+ FIO_TOKEN_ENCRYPTION_KEY` (exact shape of `EMAIL_IMAP_ENCRYPTION_KEY`, `env.ts:59`). |
| `src/services/EmailSecretCrypto.ts` | Delegate to `secretBox.ts`. **Surface, tags and `makeWithKey` unchanged**; its tests must pass untouched. |
| `src/gdpr/exportManifest.ts` | **[R2]** D12's two entries + `fio_token_encrypted` redaction. |
| `src/repositories/TeamMembersRepository.ts` | `variable_symbol` in `RosterEntry` + both roster SELECTs; `setVariableSymbol` (mirror `setJerseyNumber`, L326-340 / L529-535) with `SqlErrors.catchUniqueViolation(() => new VariableSymbolTaken())`; `findByTeamAndVariableSymbol`; `findMembersWithoutVariableSymbol`; `assignVariableSymbols` (batch). |
| `src/api/roster.ts` | `toRosterPlayer` (~L65) `+ variableSymbol`; `updatePlayer` (~L330-385) calls `setVariableSymbol`; the two VS endpoints. |
| `src/api/api.ts`, `src/api/index.ts`, `src/AppLive.ts`, `src/run.ts` | Wire the group, the repositories, `FioSecretCrypto`, `QrRenderer`, `BankStatementPdf`, `BankTransactionMatcher`, and the two crons. `FetchHttpClient.layer` is already provided at the bottom of `AppLive`. |
| `src/rpc/finance/*` | `Finance/GetPaymentQr` + the `bank_token_expiring` outbox read/ack RPCs. |
| `src/repositories/FeeAssignmentsRepository.ts` + `src/services/PaymentReminderCron.ts` | **[R3 — F3]** `findReminderCandidates` gains the non-date-gated `assigned` arm (D15b). |
| `package.json` | `+ qrcode@1.5.4`, `+ pdfkit@0.20.2`; dev `+ @types/qrcode`, `+ @types/pdfkit`. `build` gains the asset copy; `+ postbuild`. |
| `monitoring/dashboards/cron-jobs.json` | **[R2]** A `bank-sync-poller` panel and a **"no successful cycle for team X in 6 h"** alert. The defining failure mode of this feature is *silence*; this is cheaper than the T−14 token UI and catches strictly more. |
| **~40 test files** | R1 — `grep -rl ApiLive applications/server/test`. |

#### `FioApiClient` shape

```typescript
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';   // NOT '@effect/platform'

const make = Effect.Do.pipe(
  Effect.bind('httpClientOpt', () => Effect.serviceOption(HttpClient.HttpClient)),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),   // throttle reservation (D10b)
  Effect.tap(({ httpClientOpt }) =>
    Option.isNone(httpClientOpt)
      ? Effect.logWarning('FioApiClient: no HttpClient in layer context — using unavailable stub')
      : Effect.void),
  Effect.map(({ httpClientOpt, sql }) =>
    Option.isNone(httpClientOpt) ? makeStub() : makeReal(httpClientOpt.value, sql)),
);
```

`makeReal` is **exported** so tests construct it directly with a mock `HttpClient`
(`applications/server/AGENTS.md` → "Config-Gated External Service Provider", rule 4). The layer sets
`HttpClient.TracerDisabledWhen` for `fioapi.fio.cz` (D10.1).

#### Fio response schema (`fioColumns.ts`) — every trap

```
accountStatement.info: { accountId, bankId, currency, iban, bic, openingBalance, closingBalance,
                         dateStart, dateEnd, yearList, idList, idFrom, idTo, idLastDownload }
```
- `idFrom` / `idTo` / `idLastDownload` are **frequently `null`** — never assume `idTo` is present.
- **`openingBalance` / `closingBalance` / `dateStart` / `dateEnd` are consumed**, not decoded and
  discarded — they populate `bank_statement_periods` (D13).
- `transactionList` may be **`null`** rather than `{transaction: []}`, and `transactionList.transaction`
  is **independently nullable**. Model both.
- Each present column is `{ value, name, id }`; an **absent** column maps to JSON `null` and some keys
  are **omitted entirely** — model every column as optional AND nullable.
- **Trim**: the API returns whitespace-only strings like `" "`.
  `sanitize(v) = typeof v === 'string' ? (v.trim() || null) : v`. Without it a padded `" 12345 "` VS
  fails every match.
- `column0` is a **string** `"YYYY-MM-DD+ZZZZ"` — the offset has **no colon**, so `new Date()` chokes.
  `slice(0, 10)`.
- `column1` is a JSON float with variable decimals (`-130.0`). **[R2]** `Math.round(v * 100)` is itself
  a float round-trip, which `Spayd.ts` forbids. It is safe for 2-decimal CZK and unsafe for an
  FX-converted value, so assert rather than comment:
  `if (Math.abs(v * 100 - rounded) > 0.001) return decodeError('non-2dp amount')`.
- `column22` up to 11 digits — string/BigInt, never a float.
- **The PDF's inline JSON examples are stale (2012) and show epoch-millis dates. Ignore them** — the
  decoder must *reject* that shape, not coerce it.

| Key | Column | | Key | Column |
|---|---|---|---|---|
| `column22` | movement id (**the key**) | | `column5` | **variable symbol** |
| `column0` | booking date | | `column4`/`column6` | constant / specific symbol |
| `column1` | amount (signed) | | `column7` | user identification |
| `column14` | currency | | `column16` | **message for recipient** |
| `column2`/`3`/`10`/`12`/`26` | counterparty acct / bank code / name / bank name / BIC | | `column8`/`9`/`18`/`25`/`27` | type / entered-by / specification / comment / payer ref |
| `column17` | order id (**not unique — never reconcile on it**) | | | |

### 3.3 `applications/bot`

| Path | Change |
|---|---|
| `src/rcp/finance/handlePaymentReminderReady.ts` | After building the embed, call `rpc['Finance/GetPaymentQr']({ assignment_id })`; attach the PNG via `rest.withFiles([file])(post)` with the embed's `image.url` = `attachment://<filename>` — copy `clipAttachment`/`filesField` from `src/rest/rules/clips.ts` and the wrapping order from `handleQuizDue.ts:88-92` (**`withFiles` wraps the *retried* effect**, `FormData` is single-read). On failure, send the embed **without** the QR: never fail a reminder because of a QR. |
| `src/rcp/finance/buildPaymentReminderEmbed.ts` | Optional `qrAttachmentUrl` → `image.url` + a "Naskenuj QR" line. |
| `src/rcp/finance/handleBankTokenExpiring.ts` *(new)* | **[R2]** T−14 DM to the treasurer. |
| `src/rcp/finance/buildPaymentReminderEmbed.ts` (copy) | **[R3 — F3]** `copyForKind` gains an `assigned` arm: a neutral "Nový předpis — zaplať QR kódem" title, `COLOR_BLUE`, no urgency. It is the *first* message about a fee, not a nag. |
| `src/rcp/finance/ProcessorService.ts` | `Match.tag('bank_token_expiring', handleBankTokenExpiring)`. |

### 3.4 `applications/web`

| Path | Change |
|---|---|
| `organisms/team-settings/FioBankCard.tsx` + `fioBankForm.ts` + `.test.ts` *(new)* | Structure copied from `EmailForwardingCard.tsx`: `useCardForm`, per-field errors, write-only token 3-state (`fioTokenPayload`). Status block rendered **from the server literal**, never re-derived. |
| `pages/TeamSettingsPage.tsx`, `routes/…/settings.tsx` | Mount the card; loader fetches the config with `warnAndCatchAll`. |
| `routes/(authenticated)/teams/$teamId/finances_.bank.tsx` *(new)* | `ssr: false`, `validateSearch` for `?tab=`. |
| `pages/BankTransactionsPage.tsx`, `organisms/MatchTransactionDialog.tsx`, `lib/finance/matchReasons.ts` *(new)* | Queue, four-mode resolve dialog, closed `Record` keyed off the **imported** `BankTransactionMatchReason`. |
| `pages/RosterDetailPage.tsx` / member edit form | `variableSymbol` field; 409 → field-level error naming the current holder; the "Přidělit symboly automaticky" preview dialog. |
| `lib/finance/useQrObjectUrl.ts` *(new)* | **[R3 — F1]** `useQrObjectUrl(teamId, feeId, assignmentId)` — authenticated `fetch` with the `Authorization` header from `lib/token.ts`, `response.blob()`, `URL.createObjectURL`, and **`URL.revokeObjectURL` in the effect's cleanup**. Returns `{ url, state: 'loading'\|'ready'\|'error' }` so the row can render a skeleton and a retry. |
| `routes/…/my-payments.tsx` | QR `<img>` fed from `useQrObjectUrl`, ≥ 200 px with explicit `width`/`height`. **Never `src` pointed straight at the endpoint** — the token lives in localStorage, so that 401s (F1). |
| `packages/i18n/{cs,en}.json` | New keys; `pnpm codegen`. |

Export download reuses `EmailDetailPage.tsx:185-225` (authenticated fetch → `blob()` →
`createObjectURL` → `<a download>` → `revokeObjectURL`).

---

## 4. The matching engine

**Principle: when in doubt, queue. A wrong `payments` row corrupts the grant audit trail; a queued row
costs the treasurer ten seconds.**

### Step 0 — eligibility
Row must be `direction='incoming'`, `match_state='unmatched'`, `auto_match_suppressed = false`, and the
team's `auto_match_enabled = true`. Outgoing rows are `not_applicable` at ingest and never reach here.

### Step 1 — resolve member by VS
`vsNorm = NULLIF(ltrim(trim(tx.variable_symbol), '0'), '')`. Match `team_members` in the same team on
`NULLIF(ltrim(variable_symbol,'0'),'')`. Do **not** filter on `active` — a departing member may still
be settling a debt.

**[R2 — should-fix] VS recycling guard.** `team_members.user_id` is `ON DELETE CASCADE`, so a deleted
member frees their VS and `/rematch` over 180 days could credit an old transaction to the new holder.
Require `tx.booked_on >= (tm.joined_at AT TIME ZONE tz)::date - 30` (30 days of grace for someone who
pays before being added).

- `vsNorm IS NULL` → queue `no_vs`.
- 0 rows → queue `no_member_for_vs`.
- \>1 rows → impossible (unique index); `Effect.logWarning` + queue **`ambiguous_member`** — an honest
  defensive label, not a mislabel as `no_member_for_vs`.

### Step 2 — candidate assignments
From `fee_assignment_status_v` joined to `fees`: `team_member_id = member`,
`status IN ('pending','partial','overdue')`, `fees.archived_at IS NULL`.
**[R2] No currency filter here** — filtering made `currency_mismatch` unreachable and degraded the
message to `no_open_assignment`. Instead: if every candidate's currency differs from `tx.currency`,
queue `currency_mismatch`; otherwise drop the foreign-currency candidates and continue.

Deterministic order: `effective_due_at ASC NULLS LAST, assignment_id ASC`.

### Step 2.5 — **[R2]** duplicate pre-check (before any decision)
Another **incoming** row in the same team with the same `vsNorm`, the same `amount_minor`,
`booked_on` within ±7 days, and `match_state = 'matched'` ⇒ **queue `no_open_assignment` carrying a
`duplicateOfTransactionId` hint**, and take precedence over every case below.

**[R3] This is a hint, not a `match_reason` literal** (agreed with the designer). The queue renders
„Nejspíš duplikát — stejná částka i VS jako platba z {datum}" as supporting text on the
`no_open_assignment` badge with a *[Zobrazit původní]* link. The behaviour is unchanged — the row is
queued, never auto-matched — but the closed copy `Record` stays at nine keys. Together with step 4's
locking this is what actually protects against double-crediting; revision 1's claim that the duplicate
case was "structurally impossible" was wrong and is deleted.

### Step 3 — decide

| # | Condition | Action | Reason |
|---|---|---|---|
| **A** | exactly one candidate AND `amount == outstanding` | **AUTO-MATCH** in full → `paid` | — |
| **B** | ≥ 2 candidates AND exactly one has `outstanding == amount` | **AUTO-MATCH** to that one (exact amount beats due-date order). **[R2]** Record every rejected candidate in `match_evidence` so the audit view can answer *why B and not A* — B can credit the wrong fee when the member meant to chip at a different one, and total debt is unchanged so nobody notices. | — |
| **C** | ≥ 2 candidates match exactly | **QUEUE** | `ambiguous_multiple_exact` |
| **D** | exactly one candidate, `amount < outstanding` | **[R2 — ruled: design wins] QUEUE.** Revision 1 auto-matched a partial. The real risk is not overpayment but **misattribution**: a member who owes 1500 for membership and sends 300 for a tournament fee that has not been created yet would have had it silently booked against membership — and the grant evidence would then show membership income that was not. This plan's own governing principle argues against case D. | `amount_mismatch_under` |
| **E** | exactly one candidate, `amount > outstanding` | **QUEUE** | `overpayment` |
| **F** | ≥ 2 candidates, none exact | **QUEUE** | `ambiguous_multiple_open` |
| **G** | zero candidates | **QUEUE** | `no_open_assignment` |
| **H** | VS matches no member | **QUEUE** with non-binding hints | `no_member_for_vs` |

**No 90 % carve-out for case D.** The reviewer left it open; I decline it. The scenario it would serve
(a bank fee shaving a few crowns off a domestic CZK transfer between Czech banks) essentially does not
occur, and it would add a second threshold the treasurer has to be taught. Queue it.

**[R2 — B-cut-3] Hints are exact accent-folded name equality only** — `fold(counterparty_name) ===
fold(memberDisplayName)`, ~5 lines. Four fuzzy comparisons were not worth it when the treasurer knows
all 30 members by name. Hints are **never** sufficient to write a payment: `decision._tag` stays
`'Queue'` even when `suggestions.length > 0`.

### Step 4 — **[R2 — B2/B3] write, under the right locks**

Revision 1's `FOR UPDATE` was on the `bank_transactions` row, which is the **wrong row**: two different
transactions are two different rows and do not lock each other, and the candidate read came from
`fee_assignment_status_v` outside any lock on `fee_assignments`. Three counterexamples, all real:
(a) two transfers in one cycle both read `outstanding = 1500`, both hit case A, both insert 1500 →
`paid_minor = 3000` against a 1500 assignment — phantom income in a grant ledger;
(b) a double-clicked `/rematch` reproduces (a) team-wide;
(c) **no concurrency at all**: a 1500 assignment, a 500 arrives → partial, outstanding 1000; an
identical second 500 → case D again. Revision 1's "the assignment stops being a candidate" only held
when the first payment closed it exactly. (c) is now moot because case D queues, but (a) and (b) are
not, and the locking is required regardless.

```
sql.withTransaction(
  -- 1. LOCK ORDER STEP 1: the transaction row
  SELECT * FROM bank_transactions
   WHERE id = $1 AND match_state = 'unmatched' AND auto_match_suppressed = false
   FOR UPDATE
     -> no row ? skip (already handled)

  -- 2. LOCK ORDER STEP 2: every candidate assignment, ASCENDING BY ID
  SELECT id, amount_minor, paid_minor, stored_status FROM fee_assignments
   WHERE id = ANY($2) ORDER BY id FOR UPDATE

  -- 3. Re-read outstanding FROM THE LOCKED ROWS, not from the view, and
  --    re-run step 3's decision. Re-validate amount <= outstanding.
  --    If the decision changed under the lock, queue instead of writing.

  -- 4. paymentsRepo.insert({ ..., method: 'bank_transfer',
  --                          paidAt: noonInTeamTz(booked_on),          -- D14
  --                          note: Some(`Fio #${fio_movement_id}`),
  --                          recordedByUserId: config.configured_by_user_id,
  --                          bankTransactionId: tx.id, matchedBy: 'auto' })
  --    The payments trigger then recomputes BOTH paid_minor AND match_state.

  -- 5. UPDATE bank_transactions SET match_evidence = $3, match_reason = NULL, updated_at = now()
)
```

**`match_state` is never written by application code** (D7b) and **`paid_minor` is never written by
application code** (the pre-existing trigger). Step 4 writes `match_evidence` and `match_reason` only.

**Manual `/match`** takes the same locks in the same order (D10c), `matchedBy: 'manual'`,
`recordedByUserId: currentUser.id`, and clears `auto_match_suppressed`.

**[R4 — defect g] Manual `/match` uses a DIFFERENT row guard from auto-match.** Revision 3 said
"identical locks", which was read as an identical `WHERE`, and the auto-match guard
(`match_state = 'unmatched' AND auto_match_suppressed = false`) makes it **impossible to complete a
`partially_matched` row** — directly contradicting test 147. Stated explicitly:

| Caller | Row guard |
|---|---|
| auto-match (engine) | `match_state = 'unmatched' AND auto_match_suppressed = false` |
| manual `/match` | `match_state IN ('unmatched','partially_matched')` — **no** `auto_match_suppressed` predicate; a manual match clears the flag by design, so honouring it here would lock the treasurer out of the row they just un-matched |

The allocation list is **not** sorted in JS (D10c point 3) — the SQL `ORDER BY id FOR UPDATE` is the
enforcement point and must be annotated as such.

**`/unmatch`** (`reason` required, min 3 chars):
**[R4 — defect a] order matters.** In one transaction, and in this order:
1. lock and void **every** active payment (`payments` id ASC) with `PaymentsRepository.void_` —
   **never hard-delete**; the `payments` CHECK requires all three void columns together and
   `hardDeleteForTest` is a test helper;
2. **then** update `bank_transactions` (`auto_match_suppressed = true`, `match_reason`).

Writing the flag first inverts the global lock order and deadlocks against a concurrent
`voidPayment`, which locks the payment row first. The triggers recompute `paid_minor` down and return
`match_state` to `unmatched`. `auto_match_suppressed` stops the next poll or `/rematch` silently
re-applying what the treasurer just undid; a manual match clears it.

**`/rematch`** re-runs the engine over `unmatched AND NOT auto_match_suppressed` rows in the team,
bounded to 180 days, holding a **60-second** lease (D10b(c)) and returning 409 `BankSyncBusy` when it
cannot claim one — after first checking the config row exists, so a missing config gives
`BankSyncNotConfigured` (404) rather than an indistinguishable 409.

---

## 5. Backfill — a bounded loop in a **detached fiber**, polled by the client

Revision 1 walked one chunk per hourly cycle. That cannot work: Fio's history unlock window closes
after **10 minutes**, so chunk 2 onward would return 422 and the walk would stop permanently — a
one-year backfill would have taken 7 hours against a 10-minute permission.

**[R4 — blocker 1: revision 2/3 ran the loop inside the HTTP request, and that is known-broken, not
merely untested.]** `applications/proxy/nginx.conf` `location /api/` (L47-55) sets **no
`proxy_read_timeout`**, so nginx's **60-second default** applies — 60 s between successive reads from
upstream. The loop sleeps ~30 s per chunk writing nothing to the socket, so the first chunk that
exceeds 60 s of silence returns **504 to the treasurer** while the server keeps burning the 10-minute
unlock window. Revision 3 read the absence of configuration backwards ("untested rather than
known-safe"); the absence *is* the 60-second default.

`POST /teams/:teamId/bank-sync/backfill { from, to }` therefore **returns `202 Accepted` immediately**
with `{ backfillRunId }` and forks the loop with `Effect.forkDaemon`. The client polls
`GET /teams/:teamId/bank-sync` for `backfillCursor` / `backfillStatus` / `backfillRunId` — fields that
already exist on `BankSyncConfigView`. No proxy change, no long-lived request, same loop, same budget,
and the 10-minute unlock window is respected because the fiber runs continuously rather than once per
hour.

The forked loop, unchanged from revision 3 except for where it runs:

```
chunk = 60 days, walking backwards from `to`
after each chunk: upsert bank_statement_periods, upsert bank_transactions,
                  write backfill_cursor (so a crash resumes), commit
stop on: cursor < from | BACKFILL_MAX_REQUESTS (12) | BACKFILL_MAX_DURATION (8 min) | 422
422  -> last_error_code = 'history_locked', LEAVE the cursor in place, return partial progress
413  -> halve the chunk (60 -> 30 -> 15 -> 7 -> 3 -> 1), retry; a 1-day 413 is surfaced
```

12 requests × 30 s ≈ 6 minutes, comfortably inside the 10-minute window, covering ~2 years at 60-day
chunks. Terminal state is written to `backfill_status ∈ 'running'|'complete'|'history_locked'|'budget'|
'failed'` on `bank_sync_config`; a `budget` stop just means the treasurer clicks again (the cursor
resumes). The fiber holds the team's poll lease for its duration (refreshed per chunk) so the hourly
poller does not run concurrently with it.

**[R4] The same reasoning applies to a multi-year PDF export.** A single-year export is a sub-second
render and stays synchronous, but the endpoint must be bounded: reject a range wider than
`EXPORT_MAX_DAYS` (730) with a typed 400 rather than risk the same 60-second wall. The design's §7.3
already specifies an async "Soubor je připravený" card, so promoting the export to the same
fork-and-poll shape later costs no redesign.

---

## 6. Sequenced task breakdown

Each task is independently verifiable (`pnpm build:packages && pnpm codegen && pnpm check && pnpm test`,
plus `pnpm test:integration` where noted).

### T1 — Pure SPAYD / IBAN / IČO modules *(no deps)*
`packages/domain/src/models/{CzIban,CzIco,Spayd}.ts` + paired tests. **Done when** every §3.1 vector,
both modulo-11 checks (account **and** IČO — different algorithms), and the `toSpaydMessage` budget
cases pass. Then `pnpm build` (apps type-check against `dist`).

### T2 — `variable_symbol` end to end *(unblocks T8)*
Migration `1792000000`; `TeamMember`; `TeamMembersRepository.setVariableSymbol` +
`findByTeamAndVariableSymbol` + `findMembersWithoutVariableSymbol`; `Roster` DTOs incl.
`VariableSymbolTaken` with the holder's name; `api/roster.ts`; the member-edit field.
**Done when** the migration integration tests (multiple NULLs; `012345`/`12345` collide in a team; same
VS across teams; CHECK rejects `abc` and 11 digits) pass.

### T2b — VS auto-assign preview-then-apply *(deps T2)* — **[R3] KEPT IN SCOPE, decision recorded**

`GET /members/variable-symbols/suggest` (`{year}{seq3}`, skipping taken values, deterministic order,
**no writes**) and `POST .../assign` (writes only the members named in the payload, 409 on any
collision, all-or-nothing in one transaction). Roster banner + preview `AlertDialog` showing the
proposed pairs **before** anything is written.

**Why this is not cut.** Until members have variable symbols, **nothing auto-matches** — every case in
§4 step 1 exits at `no_vs`/`no_member_for_vs`. A club onboarding 30 members would get *zero* value from
the ingest engine, the matcher, the QR codes and the reminders until somebody opened 30 member pages by
hand, and the realistic outcome of that is that they open six and abandon it. This is the cheapest task
in the plan (two endpoints, one `AlertDialog`, one deterministic generator) and it is the precondition
for every other task paying off, so on value-per-line it is the highest-leverage item remaining.

It is also the **safest** bulk write in the feature: it only ever fills `NULL`s, never overwrites an
existing symbol, shows the exact proposed assignment before applying, and is individually editable
afterwards. That is why the preview is mandatory and why `suggest` is a pure read.

*(If it were ever cut, the roster banner would still have to deep-link member-by-member and show a
remaining count — but I am not proposing that.)*

### T3 — `secretBox` + `FioSecretCrypto` *(unblocks T7)*
Extract without changing `EmailSecretCrypto`'s surface. `FIO_TOKEN_ENCRYPTION_KEY` in `env.ts` and
`.env.example`. **Done when** the pre-existing `EmailSecretCrypto` tests pass unmodified and the
cross-key isolation test passes.

### T4 — `fioColumns` + `FioApiClient` *(unblocks T7)*
Pure decoder first (every trap incl. the float assertion), then the client: `TracerDisabledWhen`,
`Effect.withTracerEnabled(false)`, platform-error containment, `Redacted` end-to-end, the DB throttle
reservation, the 409 ladder outside the reservation, never-retry-500, the 413 halving.
**Done when** the §7.1 mock-`HttpClient` suite is green — including "exactly one request on 500" and
**the token-leak tests**.

### T5 — Repositories + GDPR manifest *(unblocks T6-T11)*
Migrations `1792000001`/`1792000002` (incl. the `payments` columns and the `match_state` trigger);
`BankSyncConfigRepository` (lease, throttle, failure bookkeeping, period upsert);
`BankTransactionsRepository`; `bankCoverage.ts`. `catchSqlErrors` at every public boundary.
**Done when** the repository integration tests pass **and `pnpm test:integration` for
`gdpr/exportManifest.test.ts` is green with D12's two `skip(...)` entries in place** — that test
hard-fails until they are, so it is part of this task, not a follow-up. **[R4]** Note that the
five-element `NEVER_EXPORT_COLUMNS` literal at `exportManifest.test.ts:81-90` is **not** edited: D12
chose `skip` over `own`+`redact` precisely so it stays untouched.

### T6 — Config API + settings UI *(deps T3, T5)*
`BankSyncApi`; `api/bank-sync.ts` (config GET/PUT/test/summary); `bankSyncStatus.ts`; `FioBankCard` +
`fioBankForm`. Wire `api.ts`, `api/index.ts`, `AppLive.ts`.
**Done when** the token never appears in any response, `fioTokenSet` flips, a PUT omitting the token
preserves it, and every `ApiLive`-composing test file has the new mocks (R1).

### T7 — Poller cron + backfill *(deps T3, T4, T5)*
**[R4]** Backfill is a `202` + `Effect.forkDaemon` + client polling, **not** a synchronous request —
nginx's default `proxy_read_timeout` of 60 s (no override in `applications/proxy/nginx.conf` for
`location /api/`) would 504 the treasurer mid-run while the 10-minute unlock window burned (§5).
`BankSyncPoller.ts` (derived window, lease, `Effect.exit` isolation at `{concurrency: 2}`,
`withCronMetrics('bank-sync-poller')`, `Schedule.cron('0 * * * *')`, period recording, backoff) and
`BankSyncBackfill.ts` (§5). Note in a comment that `Effect.repeat(Schedule.cron(...))` **fires once
immediately at startup** — desirable here since the window is idempotent
(`InviteAcceptanceSweepCron.ts:11`).

### T8 — Matching engine *(deps T2, T5, T7)*
`matchDecision.ts` then `BankTransactionMatcher.ts` with §4 step 4's locking.
**Done when** every case A–H plus the duplicate pre-check has a passing test at both levels, and the
**two-connection concurrency test** (§7.2) proves no double-credit.

### T9 — Queue API + resolve modes + web page *(deps T5, T8)*
**[R3]** The remaining endpoints: `match` / `unmatch` / `ignore` (with `kind`) / `bulk` / `rematch` —
**no separate `other-income` endpoint**. `BankTransactionsPage`, `MatchTransactionDialog`,
`matchReasons.ts` (closed `Record` over the **nine** imported literals).
The "beru jako vyrovnané v plné výši" mode **links out to the existing `WaiveAssignmentDialog`** rather
than implementing a waiver sub-mode — the write path already exists and a second waiver UI would drift.
Bulk ignore is in scope; bulk assign-to-member is not.

### T10 — QR generation and delivery *(deps T1, T5, T6)*
`QrRenderer`; `qr.png` endpoint with **all three containment checks**; `Finance/GetPaymentQr`; bot
attachment.
**[R3 — F1]** Web consumption goes through `lib/finance/useQrObjectUrl.ts` (authenticated fetch → blob
→ object URL → **revoke on unmount**), **never** a plain `<img src>` — the token lives in localStorage,
so a browser-issued image request carries no `Authorization` header and 401s for every player.

### T10c — **[R3 — F3]** `assigned` reminder kind *(deps T10)*
`PaymentReminderKind` gains `'assigned'`; `FeeAssignmentsRepository.findReminderCandidates` gains the
non-date-gated arm; `buildPaymentReminderEmbed.copyForKind` gains a neutral first-contact arm; the
seeding migration `1792000003` ships in the same commit.
**Done when** tests 184–189 pass — in particular 189, the backfill guard, which fails loudly if the
seed is missing rather than notifying the whole club.

### T10b — **[R2]** T−14 token-expiry Discord DM *(deps T6)*
**[R4 — blocker 6]** Ships its own outbox: migration `1792000004_create_bank_token_expiry_events.ts`
(`bank_token_expiry_events` + `bank_token_expiry_sent`) — there is no generic outbox in this repo and
`payment_reminder_sync_events` cannot be reused (FK'd to `fee_assignments`, four `NOT NULL` fee
columns). Then `BankTokenExpiringEvent`, `BankTokenExpiryCron` (daily, T−14/T−7/T−1), the read/ack
RPCs, the bot handler, and bot-ack idempotency via the documented `<resource>_sent` pattern. Keying
`bank_token_expiry_sent` on `token_created_at` re-arms all three thresholds when the token is replaced.
Fires off `expiringSoon`/`tokenExpiresAt`, not off `status` (D11). A settings banner nobody opens is
not a warning.

### T11 — Export (CSV + PDF) *(deps T5)*
`utils/csv.ts`; `BankStatementPdf` + vendored fonts + asset copy + postbuild assertion; the two
endpoints with `from`/`to`/`docLabel`/`acknowledgeGaps`; coverage gating (D13); the web buttons.
**[R4]** The export endpoint rejects a range wider than `EXPORT_MAX_DAYS` (730) with a typed 400 —
the same 60-second nginx wall that forced §5's fork applies to a multi-year PDF render.
**Done when** the diacritics regression passes **and** the built `build/esm` contains the fonts.

### T12 — Docs, i18n, monitoring, AGENTS.md *(deps all)*
`applications/docs` treasurer page (creating the Fio token, the 180-day expiry, the 90-day unlock, the
Excel-import instruction for leading zeros); cs/en keys; **the monitoring panel + the 6-hour
no-successful-cycle alert**; new `applications/server/AGENTS.md` sections ("Fio Ingestion Is
Window-Based, Not Cursor-Based", "The Fio Token Must Never Reach A Span", "Bank Matching Lock Order",
"PDF Fonts Must Be Vendored") and a `packages/domain/AGENTS.md` line for the two pure modules.

---

## 7. Test specification (write these FIRST — TDD)

### 7.1 Unit — pure functions and the client (no DB)

**`packages/domain/test/CzIban.test.ts`**
1. Each of the five verified vectors → exact IBAN string.
2. Prefix-first regression: assert the **exact** expected value (a prefix-first implementation also
   passes mod-97, so "passes mod-97" is not an assertion).
3. A 26-digit rearranged string produces correct check digits (a `Number` implementation drifts).
4. No prefix → padded to `000000`. 5. Length always 24. 6. Rejects non-numeric, >10-digit account,
   non-4-digit bank code.
7. **[R2] Account modulo-11**: `2703474850` valid; a single-digit typo invalid; a prefix with a bad
   checksum invalid; `19` (valid prefix) accepted.
8. Commented note: the Fio-PDF / `fiobank` IBANs fail mod-97 and must never be used as vectors.

**[R4 — defect j] `packages/domain/test/CzIco.test.ts`**
8b. Verified vectors accept: `61858374` (sum 183, r 7, c 4), `45244782` (sum 152, r 9, c 2),
    `45274649` (sum 156, r 2, c 9).
8c. **A mutated digit at each of the eight positions is rejected** — eight assertions, not one. A
    checksum test with a single negative case passes against a `return true` stub.
8d. Edge cases of the modulus arithmetic, asserted through the public function rather than by
    inspecting internals: an IČO whose `r = 0` (check digit 1) and one whose `r = 10` (check digit 1)
    are both accepted. These are the two cases a hand-written branch ladder gets wrong, which is why
    the implementation must be the single expression `(11 - r) mod 10`.
8e. Shape rejects: 7 digits, 9 digits, non-numeric, empty.

**`packages/domain/test/Spayd.test.ts`**
9. Minimal `ACC`-only payload. 10. Full key order + trailing `*`.
11. `formatAmountMajor`: `50000n→'500.00'`, `1n→'0.01'`, `999999999n→'9999999.99'`; `1000000000n`
    rejected; a value a float `/100` would render as `0.30000000000000004` renders exactly.
12. `*`→`%2A`; `:` unescaped; `%`→`%25`.
13. **[R2] `toSpaydMessage`**: a 62-char Czech fee name is **truncated on a word boundary, not
    rejected**, and the result is ≤ 60; `buildSpayd` then accepts it. A direct `buildSpayd` call with a
    61-char `MSG` still rejects (the guard for a caller who skips the budget step).
14. `X-VS` > 10 chars is a **hard reject** (never truncated).
15. `DT` exactly 8; `CC` exactly 3. 16. **No `CRC32` key is ever emitted.**
17. Transliteration: `'Příspěvek za podzim — Novák'` → `'PRISPEVEK ZA PODZIM - NOVAK'`;
    `'Žluťoučký kůň, Ďáblice, Ťuhýk'` → all-ASCII uppercase; `'„citace" …'` → mapped quotes + `...`;
    emoji/Cyrillic stripped; result matches `/^[0-9A-Z $%*+\-.\/:]*$/`.
18. `RN` emitted when provided, omitted when absent.

**`applications/server/test/fioColumns.test.ts`**
19. Happy path decodes every mapped column. 20. `transactionList: null` → zero movements.
21. `transactionList.transaction: null` → zero movements. 22. Absent column key → `Option.none()`.
23. `value: null` → `Option.none()`. 24. **Whitespace-only `" "` → `Option.none()`.**
25. **`column5 = " 12345 "` → `'12345'`.** 26. `column0 = "2024-03-01+0100"` → `'2024-03-01'`, plus a
    separate assertion that `new Date('2024-03-01+0100')` is `Invalid Date`.
27. `column1`: `-130.0`→`-13000`, `13.5`→`1350`, `0.07`→`7`.
28. **[R2] `column1 = 1.005` (3 dp, an FX artefact) → decode error**, not a silent round.
29. `column22 = 12345678901` survives exactly. 30. Stale-2012 epoch-millis `column0` → decode error.
31. `info.idTo`/`idFrom` null decode cleanly. 32. `info.iban` decodes.
33. **[R2] `openingBalance`/`closingBalance`/`dateStart`/`dateEnd` decode and are exposed** (D13).

**`applications/server/test/matchDecision.test.ts`**
34-41. One named case per row **A–H**.
42. **[R2] Case D queues** with `amount_mismatch_under` — the explicit reversal of revision 1.
43. **[R2] The duplicate pre-check fires** and takes precedence over case A.
44. **[R2] `currency_mismatch` is reachable**: a CZK transfer against a member whose only open
    assignment is in EUR yields `currency_mismatch`, **not** `no_open_assignment`.
45. A member with one EUR and one CZK open assignment, paid in CZK → the EUR candidate is dropped and
    the CZK one is evaluated normally.
46. Deterministic ordering: equal `effective_due_at` resolves by `assignmentId ASC`, stably.
47. Case E boundary: `outstanding + 1` → `overpayment`; `outstanding` → case A.
48. Hints: `decision._tag === 'Queue'` even when `suggestions.length > 0`.
49. **[R2] Case B records rejected candidates** in the evidence payload.
50. Waived and archived-fee assignments are never candidates.
50b. **[R3] Union completeness guard** — assert
     `new Set(BankTransactionMatchReason.literals)` has exactly the nine members of D15, and that every
     `match_reason` the engine can emit is in it. This is the only thing that stops the DB `CHECK`, the
     server engine and the web's closed `Record` drifting apart again, which is what B5 caught.
50c. **[R3]** `'possible_duplicate'` is **not** in the union — assert it explicitly, so a future
     re-promotion has to be a deliberate edit to this test.

**`applications/server/test/csv.test.ts`**
51. Delimiter `;`. 52. BOM present **exactly once**, at index 0. 53. `\r\n` throughout.
54. **Quoting tests `;`**: a value with `,` is not quoted; with `;` is. 55. Embedded `"` doubled.
56. Formula injection on text columns: `=cmd|'/c calc'!A1`, `+`, `-`, `@`, TAB, CR → `'` prefixed.
57. **A numeric column starting with `-` is NOT prefixed.** 58. Decimal separator `,`.
59. A value containing `\r\n` is quoted and preserved.

**`applications/server/test/bankSyncStatus.test.ts`**
60. The full D11 six-rank ladder. 61. **[R2] One 500 does NOT yield `invalid`** —
    `consecutive_failure_count = 1` → **`sync_failing`**. 62. **3 failures but only 2 h since last
    success → `sync_failing`**, not `invalid`.
63. 3 failures and 7 h → `invalid`. 64. `FioSecretKeyMissing` → **`misconfigured`**, never `invalid`.
65. No token → `not_connected` regardless of every other field.
66. **[R4] Expiry is additive, not a status.** `expiringSoon` is `true` at exactly 14 d and `false` at
    14 d + 1 min, **and `BankSyncStatusCode` never takes the value `'expiring_soon'`** — assert the
    union does not contain it.
66b. **[R4 — blocker 4, the point of the change]** A token that is **both** expiring (13 d) **and**
    failing (3 failures, 7 h) reports `status = 'invalid'` **and** `expiringSoon = true`. Revision 3's
    exclusive ladder reported `expiring_soon` and silently dropped the failure; this test fails against
    it.
67. `activating` boundary: 4 min 59 s → `activating`; 5 min 1 s + 1 failure → `sync_failing`.
68. `rate_limited` / `too_many_movements` never surface. 69. `history_locked` is reported as
    `backfillStatus`, never as `status`.

**`applications/server/test/bankCoverage.test.ts`**
70. Adjacent periods merge. 71. A one-day hole is reported as a gap. 72. Overlapping periods merge.
73. **[R4 — blocker 2] Per-period arithmetic continuity, under overlap.** Fixtures must be the
    **production shape**: daily rolling windows `(d−14,d)`, `(d−13,d+1)`, … which **overlap and never
    abut**. Revision 3's abutment check matched zero pairs in production and its test only passed
    because the fixtures were synthetic. Assert: (a) a period whose ingested movements sum to
    `closing − opening` is clean; (b) deleting one ingested movement inside a period makes **that
    period** violate; (c) the violation is detected on overlapping windows, i.e. the check fires at
    all — the regression revision 3 would have failed.
73b. **[R4]** A period with `date_end = today` is **excluded** from the check (provisional closing
    balance) and does not produce a spurious violation.
73c. **[R4]** Balance derivation for an arbitrary `from` with no matching `date_start`: anchor on the
    nearest recorded period at or before `from` and walk movements forward; assert the derived
    `balance(from−1)` matches a hand-computed value across a 60-day backfill chunk.
74. A request range entirely before the earliest period → one gap covering the whole range.

**`applications/server/test/FioApiClient.test.ts`** (mock `HttpClient`, `TestClock`)
75. 200 → decoded movements. 76. 409 then 200 → 2 requests, ≥ 30 s apart under `TestClock`.
77. 409 forever → `FioRateLimited` after the bounded retries.
78. **`500` → `FioServerError` after EXACTLY ONE request** (the anti-hammer test).
79. 422 → `FioHistoryLocked`; 404 → `FioBadRequest`; each one request.
80. **[R2] 413 halves the chunk** (60→30→15…) and a 1-day 413 surfaces.
81. Every error path: body is empty and the client **never calls `response.json`** (spy that throws).
82. **[R2/R4 — B1] Token containment, four assertions:**
    (a) `isFioUrl` returns `true` for a `https://fioapi.fio.cz/...` request and `false` for any other
    host — asserted on the exported predicate. **[R4]** Also assert it returns `false` (does not
    throw) for a relative URL such as `/api/x`: `new URL(relative)` throws, and that throw would be a
    defect raised inside `Effect.withFiber`.
    (a2) **[R4 — defect d] Wiring, not just the predicate.** Run a full `fetchPeriod` under a
    **recording `Tracer`** and assert that **no emitted span carries a `url.full` (or any) attribute
    containing the token**. Revision 3's assertion (a) tested the predicate in isolation and could not
    catch the real bug, which was that a `Layer.provide`-d `TracerDisabledWhen` never reaches the
    executing fiber. This test fails against the revision-3 wiring and passes against
    `HttpClient.transform` + `Effect.provideService`.
    (b) a simulated transport failure — the mock fails with
    `new HttpClientError({ reason: new TransportError({ request, cause }) })`, whose `.message`
    resolves through `reason.methodAndUrl` to the tokenised URL — produces a `Fio*` tagged error whose
    `Cause.pretty(...)` **does not contain the token substring**. **[R4 — defect c]** Assert the
    containment is on tag `'HttpClientError'` **plus** `Effect.catchCause`; a handler written for a
    `'TransportError'` tag catches nothing, because that class is a `reason`, not an error-channel tag.
    (b2) **[R4 — defect c]** The same assertion for a **body-decode** failure: a 200 response whose
    JSON does not match the schema produces a `DecodeError`-backed `HttpClientError` that also carries
    `methodAndUrl`. Decoding must happen **inside** the containment boundary.
    (c) every log line captured during a full failing cycle is asserted not to contain the token.
83. Throttle: two calls with the same token are ≥ 30 s apart; two calls with **different** tokens are
    **not** delayed relative to each other.
84. `makeStub()` (no `HttpClient`) fails `FioNotConfigured` on every method.

**`applications/server/test/FioSecretCrypto.test.ts`**
85. Round-trip. 86. Format is `v1.<iv>.<tag>.<ct>`, 4 parts. 87. Two encryptions differ (random IV).
88. Missing key → `FioSecretKeyMissing`; wrong length → same, with the byte count.
89. Tampered ciphertext/tag → `FioSecretDecryptError`.
90. **Cross-key isolation**: a blob made with the email key does not decrypt with the Fio key.
91. **[R2]** `decrypt` returns `Redacted`; `String(result)` does not contain the plaintext.

**`applications/web/.../fioBankForm.test.ts`**
92. Token 3-state (unset / kept / replacing). 93. `fioTokenSet: true` + empty input → the request omits
`fio_token` entirely (key absent, not `null`).
94. Validation: prefix ≤ 6 digits, account 2–10 digits **+ modulo-11**, bank code exactly 4.
95. **[R2]** Per `AGENTS.md`'s mandated invariant test: for every key of a `BASE` object typed
`FioBankFormValues`, editing it flips `isFormDirty` **and** changes the JSON of `fioBankRequestFrom`.

### 7.2 Integration — testcontainers

**`repositories/BankSyncConfigRepository.test.ts`**
96. **Full-column round-trip** — the only mechanism that catches the hand-written-INSERT column-list
    silent-drop bug.
97. Upsert without the token **preserves** it (`COALESCE(${new}, bank_sync_config.fio_token_encrypted)`
    — copy the `imap_secret_encrypted` line in `EmailForwardingConfigRepository.upsertQuery`).
98. `configured_by_user_id` updates on every upsert. 99. Saving resets `consecutive_failure_count` and
    `next_attempt_at`. 100. `findPollable` excludes disabled / token-less / future `next_attempt_at`.
101. **[R2] Lease**: claiming twice in a row returns `Option.none()` the second time; after
    `poll_leased_until` passes it is claimable again; release makes it immediately claimable.
102. **[R2/R4] Throttle**: two reservations for the same fingerprint return `wait` **durations** whose
    scheduled slots are ≥ 30 s apart (assert on the returned interval, not on a DB timestamp — defect
    e(i)); two different fingerprints do not interfere. Assert the upsert is a **single statement**.
102b. **[R4 — defect e(ii)] Autocommit invariant.** Connection 2 holds an **open transaction** that has
    touched an unrelated `fio_token_throttle` row; connection 1's reservation for its own fingerprint
    still returns promptly. Then the inverse: assert that wrapping a reservation in
    `sql.withTransaction` and sleeping **does** block a second connection on the same fingerprint —
    the negative control proving why the invariant exists.
102c. **[R4 — defect f] Guarded lease release.** Replica A claims the lease; the lease expires; replica
    B claims it; replica A's `Effect.ensuring` release then runs and **must not** clear B's lease
    (`AND poll_leased_by = $2`). Assert B still holds it.
103. **[R2] Period upsert** + continuity read-back.
104. **[R2/R3]** The enabled-completeness CHECK rejects an enabled config missing `account_number`,
    `bank_code` **or** `recipient_name` (the last is required because SPAYD `RN` and the PDF header
    both need it). Three separate assertions.

**`repositories/BankTransactionsRepository.test.ts`**
105. `upsertMany` twice → one row; `ingested_at` unchanged the second time.
106. Re-import with a changed payload updates `raw` but **never resets `match_state`** or clears links.
107. Same `fio_movement_id` under two teams → two rows.
108. Signed amount → generated `direction`; `0` rejected. 109. BIGINT-as-string decode.
110. `booked_on` round-trips as `'YYYY-MM-DD'`. 111. `raw` JSONB round-trips.
112. **[R3]** `ignore` without a reason, without a `resolution_kind`, or without
     `ignored_by_user_id` violates the CHECK; a `resolution_kind` on a non-`ignored` row likewise.
113. A multi-row `upsertMany` with ≥ 2 rows exercises `sql.join(',', false)` (a single row hides the
     `addParens` bug).
114. **[R2]** `match_reason` CHECK rejects a literal outside `BankTransactionMatchReason`.
115. **[R2]** Outgoing rows are ingested as `not_applicable` and are absent from the queue query.

**`services/BankSyncPoller.test.ts`** (mock `HttpClient` + real DB)
116. Two cycles over the same window → no duplicates.
117. **Crash safety**: a cycle failing after the fetch and before the commit loses nothing.
118. **Back-dating**: a movement earlier than the highest ingested date is still ingested.
119. **Per-team isolation**: team A 500s, team B succeeds; A's failure count is 1 with `next_attempt_at`
     set. 120. A future `next_attempt_at` team issues **zero** HTTP requests.
121. Success clears the bookkeeping. 122. `Effect.exit` isolation survives a defect.
123. `withCronMetrics` records success and failure.
124. **[R2] Derived window**: with `last_success_at` 40 days ago the window is 41 days, not 14; with it
     120 days ago the window clamps to 89 **and** `coverage_gap` is set.
125. **[R2] Lease across replicas**: two poller cycles started concurrently on **two separate
     `TestPgClient` connections** result in exactly one set of HTTP requests.
126. **[R2] Backfill** (§5): the bounded loop walks backwards, writes `backfill_cursor` after each
     chunk, stops at `from`; a 422 on chunk 2 sets `history_locked` and **leaves the cursor**; the
     budget stop is resumable.

**`services/BankTransactionMatcher.test.ts`** (seeded DB)
127-134. One test per case **A–H** against the real view and the real triggers.
135. Case A: `paid_minor` correct, status `paid` — **and no UPDATE was issued against `paid_minor`**.
136. **[R2] Case D queues**; `paid_minor` is unchanged.
137. **[R2/R3] Duplicate pre-check**: a second identical transfer against a closed assignment queues as
     **`no_open_assignment` carrying a `duplicateOfTransactionId` hint** — and `paid_minor` does not
     double. Assert `match_reason !== 'possible_duplicate'`; it is a hint, not a literal.
138. **Re-entrancy**: running the matcher twice over one row creates exactly one payment.
139. **[R2/R4 — B2] Concurrency, the important one.** Two matchers on **two separate `TestPgClient`
     connections** racing two 1500 transfers against a single 1500 assignment → `paid_minor == 1500`,
     one auto-match, one queued. **[R4 — defect h] It must be deterministic, not a race.** Revision 3
     relied on the two connections happening to interleave, which is reliable exactly when the code is
     already right — the failure mode this test exists to catch. Add a test-only seam:
     `BankTransactionMatcher.make({ afterCandidateRead = Effect.void })`. Matcher 1 awaits a
     `Deferred` at that point while matcher 2 runs to completion; then matcher 1 proceeds. Both the
     pass and the would-be-failure become deterministic.
140. **[R2/R4 — B3] Deadlock**: two concurrent splits over `[A,B]` and `[B,A]` (submitted in opposite
     order) both complete; no `40P01`. Use the same `Deferred` seam so the interleaving is forced.
     **[R4 — defect h]** Note that this test passes even with no JS-side sort, because
     `SELECT … ORDER BY id FOR UPDATE` locks in sorted order in the database (`LockRows` above
     `Sort`). That is why D10c point 3 **drops the JS sort as redundant** and names the SQL `ORDER BY`
     as the enforcement point; assert the `ORDER BY id` is present in the emitted SQL rather than
     asserting on an array order that does not matter.
140b. **[R4 — defect a] Lock-order deadlock across `/unmatch` and `voidPayment`.** Connection 1 runs
     `/unmatch` on transaction T; connection 2 runs `api/finance.ts`'s `voidPayment` on one of T's
     payments. Forced to interleave via the seam, both complete and neither raises `40P01`. Written to
     FAIL against a `/unmatch` that writes `auto_match_suppressed` before voiding — which is the
     natural implementation and the reason the ordering is stated as an invariant.
141. VS normalisation: `"0012345"` and `" 12345 "` both match a stored `"12345"`.
142. **[R2] VS recycling**: a transaction booked before the current holder's `joined_at − 30d` is not
     credited to them.
143. `auto_match_enabled = false` → everything queues.
144. The created payment has `method='bank_transfer'`, `matched_by='auto'`,
     `recorded_by_user_id = configured_by_user_id`, `bank_transaction_id` set, and a note with the
     movement id.
145. **[R2 — D14] `paid_at` is noon team-local**: with `team_settings.timezone = 'America/New_York'`
     and `booked_on = '2026-02-01'`, `paid_at` renders as 2026-02-01 in that zone — **not** 2026-01-31,
     and **not** 2026-03-01. Include a non-whole-hour zone (`Asia/Kathmandu`).

**`services/BankTransactionMatchState.test.ts`** — **[R2 — B4], the trigger**
146. Voiding a bank-created payment **through `api/finance.ts`'s `voidPayment`** returns the
     transaction to the queue (`match_state = 'unmatched'`) and drops `paid_minor`. This is the exact
     back door revision 1 left open.
147. A partial manual match yields `partially_matched`; completing it yields `matched`.
148. `ignored` / `not_applicable` are **not** overwritten by payment activity.
149. Deleting a payment row (test helper) recomputes correctly.
150. A payment with `bank_transaction_id IS NULL` (a cash payment) does not touch any transaction.
151. The `payments_bank_match_pair` CHECK rejects one column without the other.
151b. **[R4 — residual, stronger option taken] Trigger consolidation.** Assert
     `SELECT tgname FROM pg_trigger WHERE tgrelid='payments'::regclass AND NOT tgisinternal` yields
     **exactly one** row, `payments_finance_recompute`, and that `payments_recompute_paid_minor` is
     gone. Revision 3 depended on two triggers sorting a particular way by name; nothing tested it and
     a rename would have changed only deadlock probability, not any asserted outcome. One trigger with
     an explicit `PERFORM` order removes the fragility.
151c. **[R4]** Behaviour parity after consolidation: an INSERT, an UPDATE that re-points
     `fee_assignment_id`, and a DELETE each recompute `paid_minor` exactly as before — the branches of
     the old `payments_recompute_trigger()` must all survive in `payments_finance_recompute()`.
151d. **[R4 — defect m]** Re-pointing a payment from transaction X to Y and, concurrently, another
     from Y to X, both complete without `40P01` (the `LEAST`/`GREATEST` ordering). Latent today — no
     endpoint re-points — so mark it `it.skip`-able only with a comment, not deleted.

**`services/BankTransactionUnmatch.test.ts`**
152. Unmatch **voids** — the row still exists with all three void columns set.
153. `paid_minor` recomputed down; `match_state` back to `unmatched`.
154. **[R2]** `auto_match_suppressed` is set, and a subsequent `/rematch` does **not** re-apply the
     match; a manual match clears the flag.
155. A split unmatch voids every linked payment. 156. Unmatch without a reason is rejected before any
     write.

**`api/bankSync.test.ts`**
157. Non-member → 403. 158. **[R2]** A Captain (has `finance:view`, lacks `finance:record_payments`)
     gets **403** on the ledger, the queue and the export — the ruled authorization change.
159. `PUT` requires `finance:manage_fees`. 160. **The token never appears in any response body**, on
     any endpoint, including error paths. 161. `fioTokenSet` flips; a PUT omitting the token preserves
     it. 162. `export.csv` → `text/csv; charset=utf-8` + a `content-disposition` filename with
     CR/LF/`"`/`;`/`,` stripped (mirror `downloadEmailAttachment`'s `safeFilename`).
163. `export.pdf` → `application/pdf`, body starts `%PDF-`.
164. **[R2/R4]** `export.csv` over a range with a coverage gap → **409 `ExportCoverageIncomplete`**;
     with `?acknowledgeGaps=true` → **200 with an `X-Export-Coverage-Gaps` response header**.
     **Assert the body's first line is the column header row** and that no comment line precedes it —
     a BOM followed by free text makes Excel treat that line as the header (blocker 3).
165. **[R2]** `/rematch` twice concurrently → the second gets 409 `BankSyncBusy`.
166. **[R2] `qr.png` containment — all three checks**: assignment ∈ fee, fee ∈ team,
     `assignment.team_member.user = caller` (or `finance:record_payments`). Test the **cross-fee** case
     explicitly — a member requesting another member's assignment id under a fee they can see must 403,
     because the QR embeds the other member's VS and is enough to deliberately mis-credit a payment to
     them.

**`services/BankStatementPdf.test.ts`** — the diacritics regression
167. Render `"Příspěvek za podzim — Novák, Řehoř, Ďáblice, Ťuhýk, Žluťoučký kůň"` and assert **both**:
     (a) no `/Helvetica` (or any base-14 name) as the text font, and an embedded TrueType subset
     (`/FontFile2` + an `ABCDEF+NotoSans`-style tag) is present; (b) extracted text round-trips.
     **A test that only asserts "did not throw" is forbidden** — the WinAnsi desync throws nothing.
168. `ě` (U+011B) specifically survives — a smoke test using only `á/é/í` passes against the broken path.
169. The font resolves at the runtime path under both `src` (tsx) and `build/esm`.
170. `scripts/assert-dist.mjs` fails when the `.ttf` is missing from `build/esm/assets/fonts/`.
171. **[R2]** The PDF prints opening and closing balance for the range, and the `NEÚPLNÝ VÝPIS` band
     when coverage is incomplete (D13).
172. **[R2/R3]** The PDF header prints `recipient_name`, `registered_id`, `registered_address`, the
     account number and `docLabel` — the design's §7.4 header could not be rendered from revision 1's
     schema at all.
172b. **[R3]** An `ignored` row with `resolution_kind='other_income'` renders „Jiný příjem klubu" in
     **both** the PDF and the CSV `Stav přiřazení` column — never „Ignorováno". This is the defect the
     discriminator exists to fix: a 120 000 Kč municipal grant labelled "ignored" in an audit export.
172c. **[R4]** `BankTransactionResolutionKind` has exactly two members; assert `'duplicate'` is absent,
     so re-introducing it has to be a deliberate edit that also supplies a mode, a label and a chip.

**`gdpr/exportManifest.test.ts`** — **[R2]** existing test, must stay green
173. **[R4]** Passes after the migrations, with `bank_sync_config` and `bank_transactions` entries
     present. *(Revision 3 said "runs unchanged" while test 174 demanded a sixth
     `NEVER_EXPORT_COLUMNS` entry — mutually contradictory, and the sixth entry would have turned the
     exact five-element literal at `exportManifest.test.ts:81-90` red. Resolved by D12's `skip`
     decision: the literal is genuinely untouched.)*
174'. **[R4]** Disposition guard, replacing revision 3's test 174: assert
     `EXPORT_MANIFEST.find(e => e.table === 'bank_sync_config').disposition.kind === 'exclude'`, and
     likewise for `bank_transactions`. A future flip to `{kind:'export'}` then fails here and forces
     the redaction to be added in the same edit.
175. A real export for a treasurer contains **no** `fio_token_encrypted` value and **no**
     `bank_transactions` rows.

**`migrations/variableSymbol.test.ts`**
176. Multiple NULLs allowed. 177. `'012345'` vs `'12345'` collide in a team. 178. Same VS in two teams
     allowed. 179. `'abc'` and 11 digits rejected by the CHECK.

**[R3 — F1] `web/src/lib/finance/useQrObjectUrl.test.ts`**
180. The request carries an `Authorization: Bearer …` header read from `lib/token.ts` — a plain `<img
     src>` would not, which is the whole bug.
181. On unmount, `URL.revokeObjectURL` is called with the exact URL that `createObjectURL` returned.
     Render 5 rows, unmount, assert 5 revokes — a per-row leak is real at ~30 members × several fees.
182. A 401/403 response yields `state: 'error'` and renders a retry affordance, never a broken image
     icon.
183. Re-rendering with the same assignment id does not re-fetch (no object-URL churn).

**[R3 — F3] `applications/server/test/PaymentReminderAssigned.test.ts`**
184. A newly created `fee_assignment` produces exactly **one** `assigned` outbox row.
185. Running the cron twice produces **no** second row (the unprocessed-outbox `NOT EXISTS` guard).
186. After the bot acks via `Finance/MarkReminderSent`, a third cycle still produces no row (the
     `payment_reminders_sent` guard). **One DM per assignment per kind.**
187. `assigned` is **not** date-gated: an assignment due in six weeks still fires immediately.
188. A `due_in_3d` reminder for the same assignment is unaffected — the two kinds are independent
     rows keyed `(assignment_id, kind)`.
189. **Backfill guard**: after `1792000003_seed_assigned_reminder_sent.ts`, a pre-existing assignment
     produces **zero** `assigned` rows on the first cycle. Without the seed this test fails with a
     notification blast, which is exactly what it exists to catch.

### 7.3 Required layers / mocks
- `FioApiClient` unit tests build the layer from the exported `makeReal` with a mock `HttpClient` and
  `TestPgClient` (it needs `SqlClient` for the throttle) — the sanctioned pattern, independent of env
  selection.
- `matchDecision`, `bankSyncStatus`, `bankCoverage`, `csv`, `CzIban`, `Spayd` are pure: no layers.
- Integration: `TestPgClient` + `cleanDatabase` in `beforeEach`. **Tests 125, 139 and 140 need two
  independent connections** — add a `secondTestPgClient` helper to `test/integration/helpers.ts`.
- **[R3]** Tests 180–183 are web tests: mock `fetch` and stub `URL.createObjectURL` /
  `URL.revokeObjectURL` so the revoke assertion is observable.
- **New `test/mocks/bankSyncMocks.ts`** with `MockBankSyncConfigRepositoryLayer` and
  `MockBankTransactionsRepositoryLayer` in the canonical noop shape (`Effect.succeed(Option.none())` /
  `Effect.succeed([])` / `Effect.void`; `Effect.die(...)` for non-trivial writes; object cast
  `as never`). Every file from `grep -rl ApiLive applications/server/test` must provide them.

---

## 8. Cross-document reconciliation

### 8.1 Design features now covered

| Design feature | Where |
|---|---|
| Connection states, server-computed | **[R4]** D11 — six-rank `BankSyncStatusCode` (`sync_failing`, not `failing`) **plus** an additive `expiringSoon` boolean on the DTO; expiry is no longer a ladder rank, so it cannot mask a concurrent failure |
| Queue KPIs, 30-day stats, `membersWithoutVsCount`, `tokenCreatedAt` | `BankSyncSummaryView` (§3.1.3) |
| `Jiný příjem klubu` resolve mode | **[R3]** D16 — the `ignore` endpoint with `kind: 'other_income'`. One mechanism, one state, three labels. |
| "Beru jako vyrovnané v plné výši" | **[R3]** Hands off to the existing `WaiveAssignmentDialog`; no new write path and no sub-mode in the resolve dialog. |
| Bulk ignore (incl. `other_income`) | **[R3] Stays in scope** — `POST …/bulk` (T9). The first backfill can import a year of movements, and 200 rows resolved one dialog at a time is how a feature gets abandoned in week one. Bulk assign-to-member stays absent, per the design. |
| Auto-assign VS preview-then-apply, `{year}{seq3}` | T2b |
| `possible_duplicate` | **[R3]** §4 step 2.5 — demoted to a **hint** on `no_open_assignment`, not a tenth literal. Behaviour unchanged. |
| `assigned` reminder kind + QR at assignment time | **[R3 — F3]** D15b + T10c |
| Czech account modulo-11 | `CzIban.isValidCzAccountNumber` (T1) |
| Czech IČO checksum | **[R4]** `CzIco.isValidIco` (T1) — a different algorithm from the account check; revision 3 tasked it nowhere |
| Export `from` / `to` / `docLabel` | §3.1.3 query params (T11) |
| PDF header IČO / sídlo / bank name | **[R3]** `bank_sync_config.recipient_name` / `registered_id` / `registered_address` / `bank_name` (§2). `recipient_name` is **required once enabled** — SPAYD `RN` needs it too. |
| T−14 Discord DM | T10b |
| Ignored rows stay visible (design Q4) | D16 — yes, soft and reversible |
| Overpayment semantics (design Q5) | D16 — `paid_minor > amount_minor` on the assignment; copy should read "ponechat na tomto předpisu" |
| Design Q6 — where `Jiný příjem` lands | D16 — on the transaction row; **not** an `expenses` row (that table is outgoings-only, `CHECK > 0` + `spent_at`). Widening `balanceSummary` is follow-up. |
| Design Q8 — QR lifetime | Rendered per request, not stored. ~30 members × a few fees; caching buys nothing and a stored PNG goes stale when the account changes. |

### 8.2 Design features deliberately cut

| Feature | Why |
|---|---|
| `refund_or_reversal` reason + `reversal_pending` + order-id index + pin-to-top UI | B-cut-2. Roughly never happens at this scale. Outgoing rows are `not_applicable`; an `ignore`-with-reason from the ledger covers the case. `fio_order_id` is kept (free). |
| `non_member_payment` as a match **reason** | §9.1 — it is a *resolution*, not an observation. |
| Four-way fuzzy suggestion engine | B-cut-3 — exact accent-folded name equality only. |
| Design Q1 sidebar count badge | Design's own default: ship the dot. |

---

## 9. Push-back and residual risk

### 9.1 Two rulings I am implementing but want on the record

**(a) Dropping `non_member_payment` as a match reason.** The ruling said "your names win" and named
`amount_mismatch_under` from the design's set, so I have merged both. But I dropped
`non_member_payment` deliberately, and that is a change to the design's §3.5 table. My reasoning: the
engine cannot *observe* "this is not a member" — it observes "there is no VS" or "this VS belongs to
nobody". "Not a member" is a conclusion the **treasurer** reaches, and it is already offered as the
`Jiný příjem` resolution mode. Keeping it as a reason would mean inventing a heuristic (counterparty
name not in the roster?) that would mislabel every member paying from a parent's or spouse's account —
common in a club with juniors. **The designer must fold its `non_member_payment` row into
`no_vs` / `no_member_for_vs`, both of which default to the `Jiný příjem` resolution.** *(Upheld by the
coordinator in revision 3.)*

**(b) No 90 % carve-out on case D.** Declined, with reasoning in §4. *(Upheld by the coordinator in
revision 4.)*

### 9.1b — **[R4]** Residual decisions taken

| Item | Decision | Why |
|---|---|---|
| `bank_sync_config` GDPR disposition | **`skip(...)`**, not `own(...)` with `redact` | The club's account number, IBAN, IČO and registered address are not personal data *about* the treasurer — the only tie is who last pressed Save. `skip` exports **no** column, strictly stronger than redacting one, and it leaves the existing five-element `NEVER_EXPORT_COLUMNS` literal untouched (blocker 5 dissolves). Cost: the token column is not in `NEVER_EXPORT_COLUMNS`; mitigated by disposition guard test 174'. |
| Trigger ordering | **Collapse to one trigger** (`payments_finance_recompute`) | The stronger of the two options offered. Name-order dependence was real Postgres behaviour but untested and invisible to any assertion; one function with an explicit `PERFORM` order is self-documenting and also gives defect (m) a natural home. Costs one `DROP TRIGGER` in `1792000002`. |
| `/rematch` lease | **60 s, existence-checked first** | A 5-minute lease would 409 a treasurer for up to four minutes after an unrelated poll, and a zero-row lease claim could not distinguish "busy" from "no config" — now `BankSyncNotConfigured` (404) vs `BankSyncBusy` (409). |
| `fio_token_throttle` cleanup | **`DELETE … < now() - 7 days` once per poller cycle** | Irrelevant at this scale, costs nothing, prevents an unbounded table. |

### 9.2 Residual risks

**R1 — `AppLive` service cascade (certain).** Adding services to `AppLive.ts` / `api/index.ts` silently
breaks **every** `ApiLive`-composing test file (43 files for the AI-assistant branch, 34 for
global-admin). After T5/T6 run `grep -rl ApiLive applications/server/test` and update every file it
lists. Do **not** use `grep 'Layer.provide(ApiLive)'` — zero matches in this tree.

**R2 — Migration id collision.** Ids collide only *after* both branches merge; the failure is
`No test files found, exiting with code 1` naming nothing. Take the next id at **merge time**; keep
every statement idempotent.

**R3 — Domain rebuild.** Apps type-check against `packages/domain/dist`. After T1/T2 run
`pnpm build:packages && pnpm codegen && pnpm check`.

**R4 — Two new runtime dependencies.** `qrcode@1.5.4` drags CLI-only `yargs` (~1 MB image size,
correctness-neutral). `pdfkit@0.20.2` bundles `fontkit`. Neither reaches the web bundle.

**R5 — Vendored fonts add ~900 kB.** The alternative (`apt-get install fonts-dejavu-core`) shrinks the
repo but makes local `tsx` and the container disagree about font paths — the exact bug class D9 exists
to prevent.

**R6 — `ON DELETE RESTRICT` on `configured_by_user_id`.** The configuring treasurer's `users` row
cannot be deleted once a payment references the config. Correct for audit; D12's `{kind:'keep'}`
erasure disposition records the decision, and erasure anonymises in place rather than deleting.

**R7 — Two teams sharing one Fio token.** Allowed. The per-token DB throttle keeps the 30 s limit safe
across both teams and both replicas; each team ingests into its own rows. A club with an A-team and a
B-team on one account is a real case, so this is not blocked.

**R8 — Self-reported token creation date.** We cannot read the real expiry from Fio. A 3-month-old
token pasted today gets its T−14 warning 3 months late. Mitigated by the optional "token created on"
field (D11).

**R9 — Backfill runs in a detached fiber.** Resolved in §5 (`202` + polling). The residual risk is
that a `forkDaemon` fiber dies with the process on deploy; `backfill_cursor` makes that resumable and
`backfill_status` shows it stopped. The lease prevents the hourly poller running concurrently with it.

**R10 — The `/periods` decision contradicts the literal story text.** Argued in D1. If challenged, the
fallback is `/last` **plus** a daily `/periods` reconciliation over the last 14 days to catch what the
cursor dropped — i.e. we run `/periods` anyway, with extra state and an extra request.

### 9.3 Decisions taken by the user (2026-09-15) — RESOLVED, implement as stated

All four were answered in favour of the plan's own recommendation. They are no longer open; the
body of this document already reflects them.

**Q1 — CSV leading zeros → DOCUMENT IT. The PDF is the authoritative audit artefact.**
No XLSX, no `exceljs` dependency. A VS of `0123456789` will render as `123456789` when the CSV is
opened in Excel; this is documented in the export UI and in `applications/docs/`. The PDF is what the
municipality receives and it renders the variable symbol correctly. **Do not add a leading apostrophe
to the VS column** — it renders literally on CSV import and corrupts the value for every other reader.

**Q2 — CSV decimal separator → COMMA (cs-CZ).**
Emit `1234,50`. The only two readers are a Czech treasurer and a Czech auditor, and the file must be
double-clickable with a working `SUM()`. This is consistent with the `;` field delimiter (a `,`
decimal is unambiguous when the delimiter is `;`). Machine consumers are explicitly not a target.

**Q3 — `recorded_by_user_id` for an auto-matched payment → THE CONFIGURING TREASURER.**
`bank_sync_config.configured_by_user_id`, with `matched_by = 'auto'` recording that a machine
performed the match. No schema change, valid FK, an accountable human on the audit trail. The
nullable-FK alternative is rejected.

**Q4 — Overpayment → ALLOW IT, WITH THE OVERAGE IN THE PAYMENT NOTE.**
On **explicit opt-in in the resolve dialog** (never automatically), write a payment for the full
transaction amount so `paid_minor > amount_minor` on that assignment — the `fee_assignments` CHECK
permits it — and record the overage in the payment note. The transaction then reaches `matched` and
leaves the queue. No `residue` state. The resolve dialog must state the consequence in plain Czech
before the treasurer confirms (see the design spec's §3.6.1).

