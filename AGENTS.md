# AGENTS.md

## Project Overview

This is an **Effect-TS monorepo** built with TypeScript, utilizing a modern functional programming approach. The project emphasizes type safety, composable effects, and structured concurrency through the Effect ecosystem.

### Architecture

```
applications/
├── bot/       — Discord bot (dfx, Effect-native)            → see applications/bot/AGENTS.md
├── server/    — HTTP API server (Effect + PostgreSQL)       → see applications/server/AGENTS.md
├── web/       — TanStack Start frontend (React 19, Vite)    → see applications/web/AGENTS.md
├── docs/      — End-user product docs (Astro + Starlight)   → see applications/docs/AGENTS.md
└── proxy/     — Reverse proxy (nginx-like routing)
packages/
├── domain/    — Core domain models and API contracts     → see packages/domain/AGENTS.md
├── effect-lib/— Shared Effect utilities (Bind, Schemas)  → see packages/effect-lib/AGENTS.md
├── i18n/      — Translation system (Paraglide.js)        → see packages/i18n/AGENTS.md
├── migrations/— Database migrations (Effect SQL)         → see packages/migrations/AGENTS.md
├── rules/     — WFDF Rules of Ultimate trainer content + pure engine (no Effect) → see packages/rules/AGENTS.md
└── template-renderer/ — Pure welcome-template rendering (no Effect) → see packages/template-renderer/AGENTS.md
```

Each application follows an **AppLive + run.ts** pattern:
- **`AppLive`** — a composable `Layer` that wires up the application's core services without runtime concerns (config, logging, connection details). This is the unit that can be tested or composed into larger systems.
- **`run.ts`** — the deployment entrypoint that provides environment-specific layers (PgClient, NodeHttpServer, Logger, Config) and calls `NodeRuntime.runMain`.

The **migrations** package exports `MigratorLive` — a layer that only needs a `PgClient` and filesystem. Consumers provide their own `PgClient`, keeping the migration package decoupled from connection config.

### Bank Sync (Fio) — Trigger-Owned Columns, One Lock Order, And A Read-Only Probe

The bank-sync subsystem ingests Fio movements (`applications/server/src/services/BankSyncPoller.ts`, hourly), matches them against `fee_assignments` (`services/BankTransactionMatcher.ts`), and exposes the queue, CSV and PDF at `src/api/bank-sync.ts`. Four invariants span the whole monorepo and are not visible from the call sites that violate them.

**1. `payments_finance_recompute` (migration `packages/migrations/src/before/1792000002_create_bank_transactions.ts`) replaced `payments_recompute_paid_minor` and now owns two derived columns, not one.**

| Column / value | Written by |
|----------------|------------|
| `fee_assignments.paid_minor` | the trigger only — never app code |
| `bank_transactions.match_state` ∈ `unmatched` / `partially_matched` / `matched` | the trigger only, once the row exists. App code sets `match_state` at INSERT (`unmatched` for an incoming movement, `not_applicable` for an outgoing one) and never recomputes it afterwards. |
| `bank_transactions.match_state` ∈ `ignored` / `not_applicable` | app code only — the treasurer's ignore/un-ignore — and every such UPDATE is guarded by `WHERE match_state IN (…)`. `recompute_bank_match_state` returns early on both states, so the trigger never overwrites a human decision; the un-ignore back to `unmatched` is the one app-side write of a trigger-owned value, and it is guarded by `WHERE match_state = 'ignored'`. |

The trigger also stamps `bank_transactions.auto_match_suppressed = true` whenever a payment linked to a transaction transitions `voided_at IS NULL → NOT NULL`. That one rule is what stops the poller from silently re-creating, inside its next rolling window, a payment a treasurer deliberately reversed — including through the pre-existing `voidPayment` endpoint, which knows nothing about the bank tables. Do not move that stamp into an app-side void path; there is more than one.

**2. Canonical lock order for every money write: `payments` (by `id ASC`) → `bank_transactions` → `fee_assignments` (by `id ASC`).** Both `BankTransactionMatcher.matchOne`/`unmatch` and `api/bank-sync.ts`'s manual match honour it. Violating it deadlocks (`40P01`) on a money operation, and Postgres reports it as an untyped `SqlError` — so the symptom is a failed payment, not a message naming a lock.

**3. The user-triggered "test connection" probe (`POST /teams/:teamId/bank-sync/test`) is READ-ONLY with respect to every `bank_sync_config` column the status ladder reads.** The probe asks Fio for a **2-day** window (`PROBE_WINDOW_BACK_DAYS = 1` in `applications/server/src/api/bank-sync.ts`); the hourly poller asks for **14** (`SYNC_WINDOW_DAYS`, `services/BankSyncPoller.ts`), widened further back to `last_success_at - 1 day` for a team that has been failing. A 200 on the probe is therefore **not** evidence that the import works — a high-volume club that fails `FioTooManyMovements` on 14 days passes the 2-day probe every time. The probe's verdict and the card's status may legitimately disagree; the copy owns that, the database does not.

| Repository method | May a UI-triggered probe call it? | Why |
|-------------------|-----------------------------------|-----|
| `BankSyncConfigRepository.recordSuccess` | **Never** | Clears `last_error_code`, and `services/bankSyncStatus.ts` returns `'ok'` off that alone (`if (Option.isNone(input.lastErrorCode)) return 'ok'`, before the `invalid` and `activating` rules run). It also resets `last_success_at` — which is the `silenceBaseline` for the `invalid` rank, so repeated clicks suppress `invalid` forever, and it collapses the poller's catch-up window back to 14 days — and it leaves `coverage_warning` stale. |
| `BankSyncConfigRepository.recordFailure` | **Never** | Increments `consecutive_failure_count`, the input to the `>= 3` gate that promotes a config to `invalid`, and sets `next_attempt_at` to `now() + LEAST(2^(n+1), 24) hours`, which `findPollableQuery` filters on. A treasurer clicking "test" during a Fio outage would both push their own working config toward `invalid` (three failures recorded as `'fio_error'` is the whole gate, once `last_error_at - last_success_at > 6 h`) and suppress the hourly poller for up to a day. |
| `BankSyncConfigRepository.clearPollBackoff` | **Yes, on a GREEN probe only** | `UPDATE … SET next_attempt_at = NULL, updated_at = now()` and nothing else. This is 100% of the useful write — un-sticking the exponential poll backoff — and touches no column the status ladder reads. Gated on the account cross-check (invariant 4): on an `account_mismatch` verdict the probe writes **nothing at all**, because that backoff is the poller's own deliberate state and clearing it would only send the poller back to a config it is going to refuse again in an hour — while erasing the evidence. |

Probe failures travel in the HTTP response (`BankSyncApi.BankSyncTestStatus`, a closed union distinct from `BankSyncConfig.BankSyncStatusCode`) and **never** into the row. Any new user-triggered Fio call — a re-test button, a "verify IBAN" action, a setup wizard step — is bound by the same rule.

**4. A statement whose `info.iban` disagrees with the configured account is NOT INGESTED AT ALL.** The comparison lives in one place, `applications/server/src/services/bankSyncAccount.ts` (`configuredIbanOf` + `isAccountMismatch`), and both Fio callers route through it: the probe turns it into the `account_mismatch` verdict, and `BankSyncPoller.fetchAndIngest` skips `upsertMany` **and** `upsertStatementPeriod` (a period row from a foreign account poisons `deriveBalanceBefore` and the D13 continuity check with balances no ingested movement can explain), then skips `matchIngested` entirely. This is the actual fix for "a valid token against the wrong club account" — the probe only diagnoses it.

`isAccountMismatch` returns `true` **only when both IBANs are present and differ** (whitespace- and case-insensitively). Either side absent — account not configured, `buildCzIban` declined, Fio sent no `info.iban` — means no comparison is possible, and an unanswerable question must never become an accusation, because this verdict halts a club's money import.

The poller records the condition with `BankSyncConfigRepository.recordAccountMismatch`, **never** `recordSuccess`: `recordSuccess` clears `last_error_code`, and `bankSyncStatus.ts` ranks the card `'ok'` off that alone, which would show "everything is fine" while nothing is being imported — a silent halt is the one failure mode this guard must not create. Plain `recordFailure` gets the mechanism right but lands on rank 5 `sync_failing`, whose copy says "we keep retrying, there's nothing to do yet" — a lie three times over here. Hence the seventh ladder rank `'account_mismatch'` (`bankSyncStatus.ts` rule 2.5), which outranks `invalid` because the token demonstrably works, and is terminal: no retry count and no elapsed time clears it, and neither does the config edit itself (`upsertQuery` resets `consecutive_failure_count` and `next_attempt_at` but `last_error_code` survives the save) nor the green probe that follows it (the probe writes `next_attempt_at` only). The ONE thing that clears the rank is the next successful poll's `recordSuccess` — the edit and the probe only un-gate that poll.

The realistic false-positive is the account **prefix**, not exotic banks: `buildCzIban` returning `None` is effectively unreachable (the API rejects non-building payloads, the DB CHECKs are `^[0-9]{2,10}$` / `^[0-9]{4}$`, the web form hardcodes the bank code), but Fio does not return the prefix in `accountId`, so a club whose account is `19-2000145399/0800` and who typed `2000145399` with an empty prefix field gets a permanent, import-halting mismatch. Both copy keys name the prefix explicitly for that reason.

`BankSyncBackfill.ts` is guarded by the SAME predicate, at the top of `ingestChunk` before `upsertMany`/`upsertStatementPeriod`, returning the existing `'failed'` outcome. Do not treat the backfill as out of scope for this rule: it is a UI button reachable exactly when a team is halted, over a window 6× wider than the poller's, and the treasurer pressing it has just been told their token reads the wrong account.

Two bookkeeping rules the recording path must keep. **`recordAccountMismatch` does NOT touch `consecutive_failure_count`** and uses a FLAT `next_attempt_at = now() + interval '6 hours'`, not `recordFailure`'s exponential backoff: that counter feeds the `>= 3` gate that promotes a config to `invalid`, and a mismatch is not evidence about the token — letting it increment means the next genuinely dead token reports `invalid` on its FIRST Fio 500, defeating the gate. Exponential backoff buys nothing anyway on a condition only a human can clear. **`recordSuccess` clears `coverage_warning`**, which is the only thing that does; without it the mismatch warning — an imperative in the present tense — outlives the fix forever and misleads whoever next investigates an unrelated `coverage_gap` on that team.

Two classification splits feed that response and must not be collapsed:

- **`FioServerError` (HTTP 500 only — Fio's one dead-token signal) vs `FioUnreachable` (every non-200 the status map does not name, plus every transport failure).** See `applications/server/AGENTS.md` → "Fio API Client — The Token Is In The URL Path", rule 4, for the full status → tag table.
- **`FioSecretKeyMissing` vs `FioSecretDecryptError`** (`services/FioSecretCrypto.ts`). `FioSecretKeyMissing` is **our** misconfiguration — `FIO_TOKEN_ENCRYPTION_KEY` absent or not 32 bytes — and the user must be told their token is fine and to change nothing (`misconfigured`; the poller records `'key_missing'`, which `bankSyncStatus.ts` ranks `misconfigured` at rule 2). `FioSecretDecryptError` means the stored ciphertext will not decrypt under the current key, and the only remedy is for the treasurer to re-paste the token (`invalid`; the poller records `'fio_error'`). `BankSyncPoller.ts` and `api/bank-sync.ts` both catch the two tags **separately**; never merge them into one `Effect.catchTag([...])` arm on a user-facing path (`BankSyncBackfill.ts` merges them only because a backfill reports neither verdict to anyone).

## Technology Stack

- **TypeScript 5.6+** — Strict mode, NodeNext module resolution, ES2022 target
- **Effect-TS 3.10+** — Functional effect system for composable, type-safe programs
- **pnpm** — Fast, disk-efficient package manager (workspace-aware). Always use bare `pnpm` command, never `npx pnpm@...`
  - **pnpm settings live in `pnpm-workspace.yaml`, never in a `"pnpm"` field in `package.json`.** `overrides`, `patchedDependencies`, `peerDependencyRules` and `ignoredBuiltDependencies` all belong there. pnpm 10.28 stopped reading them from `package.json` and merely *warns* — it does not fail — so a `package.json` copy silently stops applying. That is how the `effect@4.0.0-beta.40` patch and the `typescript` override came to survive only because the lockfile already carried the resolution; a fresh resolve would have dropped both. Note YAML quoting: any value starting with `@` needs quotes (`- '@parcel/watcher'`).
  - CI installs with bare `pnpm install` (`.github/actions/setup`), **not** `--frozen-lockfile`, so lockfile drift is never caught in CI. If `pnpm install` rewrites `pnpm-lock.yaml` on a clean checkout, the committed lockfile was written by a different pnpm than `packageManager` pins — commit the regenerated file rather than reverting it, or the churn reappears in every unrelated PR.
  - **After pulling a dependency bump, run `pnpm install` BEFORE `pnpm format` or `pnpm lint`.** Stale `node_modules` runs the *old* toolchain against the new pin, and biome in particular then reformats files back to its previous style — silently reverting the formatting fix that shipped with the bump, in files your change never touched. It looks like a clean format run; CI installs from the lockfile and fails `Lint & Format`. Observed for real: `pnpm exec biome --version` said 2.5.3 while `package.json` pinned 2.5.10. When a format run touches files unrelated to your change, check the tool version before committing.
- **Vitest 3.2+** — Testing framework with Effect integration (`@effect/vitest`)
- **Biome.js** — Fast linting and formatting
- **MajNet releases** — No Changesets. A release is a set of per-app git tags `@sideline/<app>@vX.Y.Z` (all apps normally tagged together at one shared version); each tag builds that app's `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` image. Releases auto-track into the `stable` class and are promoted to `production` via an admin-gated render PR. Every merge to `main` also publishes `sha-…`/`latest` images to the `testing` class. See `/deploy`.
- **Husky + lint-staged** — Pre-commit hooks (auto-format via biome)

## Effect-TS Patterns

### The Effect Type

```typescript
Effect<Success, Error, Requirements>
```

- `Success (A)` — The value type on success
- `Error (E)` — The error type(s) that can occur
- `Requirements (R)` — Services/dependencies needed to run

**Key Principle**: Effects are **blueprints**, not imperative actions. They describe programs that the runtime executes.

### Dependency Injection

Use **covariant union types** (not intersections) for services:

```typescript
class DatabaseService extends Effect.Tag("DatabaseService")<
  DatabaseService,
  { query: (sql: string) => Effect.Effect<Result> }
>() {}

// Dependencies merge as R = DatabaseService | CacheService
```

### Service Patterns

- Use `Effect.Tag` for service definitions with static method access
- Use `Layer` for service construction and dependency wiring
- Use `ManagedRuntime` for service lifecycle in external frameworks
- Prefer `Effect.provide` over manual dependency passing

### Configuration

```typescript
import { Config } from "effect"
const dbUrl = Config.string("DATABASE_URL")
const port = Config.number("PORT").pipe(Config.withDefault(3000))
const apiKey = Config.redacted("API_KEY")
```

### Error Handling

Typed errors automatically merge into unions. Handle specific errors with `Effect.catchTag`.

#### Rules

1. **`Effect.catchAll` does NOT exist** in the Effect 4 beta used by this repo — the operator is `Effect.catch` (catches every typed failure). Prefer `Effect.catchTag` with explicit error tags. Only fall back to `Effect.catch` when a handler genuinely needs to handle every typed failure uniformly (e.g. the outer `Effect.catch((error) => ...)` wrapper inside `ProcessorService.processEvent` that funnels all per-event failures into a `MarkFailed` RPC):
   ```typescript
   // ✗ Bad — Effect.catchAll is not a real export; this is a TypeError at runtime
   Effect.catchAll(() => Effect.void)

   // ✓ Good — explicit about which errors are handled
   Effect.catchTag('NoSuchElementException', () => Effect.void)
   Effect.catchTag('SqlError', 'ParseError', LogicError.withMessage(
     (e) => `Failed fetching user ${id}: ${e}`
   ))

   // ✓ Acceptable — outer catch-everything inside a per-event processor
   Effect.catch((error) => markEventFailed(eventId, formatError(error)))
   ```

2. **Never use `Effect.orDie` or `Effect.die`** — use `LogicError` from `@sideline/effect-lib` instead:
   ```typescript
   import { LogicError } from '@sideline/effect-lib'

   // ✗ Bad — loses error context, generic defect
   Effect.orDie
   Effect.catchTag('SqlError', Effect.die)

   // ✗ Bad — `HttpServerResponse.json(...).pipe(Effect.orDie)` to silence the encode error
   HttpServerResponse.json(payload).pipe(Effect.orDie)

   // ✓ Good — descriptive defect with cause chain
   Effect.catchTag('SqlError', 'ParseError', LogicError.withMessage(
     (e) => `Failed fetching user ${id}: ${e}`
   ))

   // ✓ Good — standalone defect
   LogicError.die('Training activity type not found')

   // ✓ Good — INSERT ... RETURNING always yields one row; map NoSuchElement to a descriptive defect
   insertChallengeQuery(input).pipe(
     SqlErrors.catchUniqueViolation(() => new WeeklyChallengeAlreadyExistsForWeek()),
     catchSqlErrors,
     Effect.catchTag('NoSuchElementError', () =>
       LogicError.die('Weekly challenge insert returned no row'),
     ),
   )
   ```

   The single sanctioned exception to the `Effect.die` ban is **re-raising a defect you have just captured unchanged**: when a `catchDefect` handler must let some defects through (e.g. retry on a unique-violation defect but propagate every other defect untouched), re-raise the captured value with `Effect.failCause(Cause.die(defect))` — never `Effect.die(defect)`. `Effect.die` is banned because it loses context for *new* defects; `Cause.die(defect)` on an *already-existing* defect preserves the original cause verbatim and there is nothing to wrap. Use `LogicError` only when you are creating a fresh defect, not when forwarding one.
   ```typescript
   // ✓ Good — retry on unique violation, re-raise every other defect verbatim
   Effect.catchDefect((defect) =>
     isUniqueViolation(defect) ? Effect.void : Effect.failCause(Cause.die(defect)),
   )
   ```
   Reference: `applications/server/src/services/TrainingAutoLogCron.ts`.

   The rule applies even when the immediate fix is "silence a never-happens error". When a typed failure is genuinely impossible in production (e.g. `NoSuchElementError` from `INSERT ... RETURNING`, encode error from a `Schema.encodeSync`-ed payload), reach for `Effect.catchTag('<Tag>', () => LogicError.die('<reason>'))` — the descriptive defect preserves cause context that `Effect.orDie` discards. Reference: `applications/server/src/repositories/WeeklyChallengeRepository.ts` `create` for the canonical `INSERT ... RETURNING` shape.

3. **Never swallow errors silently** — always log before catching:
   ```typescript
   // ✗ Bad — error disappears without trace
   Effect.catchTag('NoSuchElementException', () => Effect.void)

   // ✓ Good — error is logged, then caught
   Effect.tapError((e) => Effect.logWarning('Context about what failed', e)),
   Effect.catchTag('NoSuchElementException', () => Effect.void)
   ```

4. **Repository error boundary** — all repositories catch `SqlError` and `ParseError` at the public method level using `catchSqlErrors`:
   ```typescript
   import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

   findByTeamId = (teamId: Team.TeamId) =>
     this.findByTeamQuery(teamId).pipe(catchSqlErrors);
   ```

5. **`Effect.either` is NOT exported** in the Effect 4 beta used by this repo. To convert a per-item failure into a successful `Exit` (e.g. for batch error isolation), use `Effect.exit` — it captures both typed errors and defects.

6. **`Effect.catchAllCause` does NOT exist** in the Effect 4 beta used by this repo. To handle a `Cause` (both typed failures and defects) — typically for "log everything, swallow, don't break the caller" — use `Effect.catchCause((cause) => Effect.logWarning('Context', cause))`. This is the correct pattern for **best-effort side effects** that must never fail their caller (e.g. firing achievement evaluation from an activity-log handler, emitting sync events alongside a primary write). Always log the `cause` before swallowing — never `Effect.catchCause(() => Effect.void)`.

7. **Only `Effect.catchCause` EARNS an `E = never` signature — `Effect.catchTag` does not catch defects.** When a function's declared type is `Effect.Effect<A>` (no error channel) because its caller's contract forbids a 500, `catchTag`/`catch` on the known typed failures is not enough: a throwing `JSON.stringify`, a `RangeError` from `Intl`, or a synchronous throw inside a dependency still escapes as a defect. Wrap the whole body in `Effect.catchCause` and **re-raise an interruption-only cause** instead of degrading it, so a client disconnect stays cancelled:
   ```typescript
   Effect.catchCause((cause) =>
     Cause.hasInterruptsOnly(cause)
       ? Effect.failCause(cause)
       : Effect.logError('Context').pipe(
           Effect.annotateLogs({ cause: Cause.pretty(cause) }),
           Effect.as(fallbackValue),
         ),
   )
   ```
   Reference: `ChatAgent.respond` (`applications/server/src/services/ChatAgent.ts`).

8. **A callee's `E = never` is NOT a promise that it cannot abort your chain — `catchSqlErrors` dies, it does not fail.** Every repository method pipes `catchSqlErrors` (rule 4), which converts `SqlError`/`ParseError` into a DEFECT via `Effect.die`. A helper assembled from repository calls therefore declares `Effect.Effect<A, never, R>` and still aborts on a transient database failure. Reading `never` off its signature and splicing it unguarded into an existing chain (`Effect.tap`, `Effect.flatMap`) lets one failed query short-circuit **everything sequenced after it**. Any effect you add to an existing chain as an AUXILIARY step — a self-heal, a backfill emit, a best-effort notification — MUST be wrapped at the call site:
   ```typescript
   Effect.tap(() =>
     auxiliaryHeal(...).pipe(
       Effect.catchCause((cause) => Effect.logWarning('auxiliaryHeal failed (non-fatal)', cause)),
     ),
   )
   ```
   Never substitute the callee's `never` error channel for this wrap. References: `emitMemberGroupChannelRoles` at its call site in `applications/server/src/rpc/guild/index.ts` (unwrapped, it would have skipped `reconcileMemberDiscordRoles` and the welcome message), `reapplyGroupGrants` at both `applications/server/src/rpc/channel/index.ts` call sites.

### Stateful Loops — `Effect.suspend` Self-Recursion

**`Effect.iterate` and `Effect.loop` do not exist** in `effect@4.0.0-beta.40`, and **`Effect.whileLoop` returns `Effect<void>`** (`node_modules/effect/dist/Effect.d.ts:1249`) — it threads state only through a mutable closure variable, so it cannot carry an accumulator. Write a bounded loop that carries state as a self-recursive `Effect.suspend` over an explicit state record:

```typescript
const step = (state: LoopState): Effect.Effect<Result> =>
  Effect.suspend(() =>
    state.iteration >= MAX_ITERATIONS
      ? Effect.succeed(fallback(state))
      : doWork(state).pipe(Effect.flatMap((next) => step(next))),
  );
```

`flatMap` trampolines, so this is stack-safe. Reference: `ChatAgent.ts`'s tool-calling loop (`applications/server/src/services/ChatAgent.ts`). Verify the combinator exists in `node_modules/effect/dist/Effect.d.ts` before reaching for it — this one has been rediscovered the hard way twice.

### Resource Management

Use `Effect.acquireRelease` for automatic resource cleanup.

## Code Style

- **Avoid `Effect.gen(function* () {`** in regular effect pipelines — use `Effect.Do.pipe(...)` with `Effect.bind` / `Effect.let` / `Effect.tap` instead. Two narrow exceptions where `Effect.gen` is the documented convention:
  1. **`Effect.Service` / `Effect.Tag` constructor bodies** named `const make = Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; ... return { ... }; })` — the entire `applications/server/src/repositories/` directory follows this shape (see `AgeThresholdRepository.ts`, `RolesRepository.ts`, etc.). Keep new repositories/services consistent with this pattern.
  2. **Test bodies** passed to `it.effect(...)` — see the Testing section below.

  Everywhere else (API handlers, cron jobs, helpers, RPC handlers), use `Effect.Do.pipe(...)`.
- **Use `pipe`** for linear transformations and chaining
- **Always use `Effect.asVoid`** instead of `Effect.map(() => undefined)`
- **Never cast types** (`as X`) and **never use `any`**
- **Never use `Schema.optional`** — always use `Schema.OptionFromNullOr(...)`, `Schema.OptionFromOptionalKey(...)`, or `Schema.OptionFromOptional(...)` (`Schema.optionalWith` does **not** exist in the pinned `effect@4.0.0-beta.40`)
- **Use `Schema.OptionFromNullOr`** for nullable API/DB fields; use `Schema.OptionFromOptionalKey` only when the key may be absent from the input and `null` must be rejected; use `Schema.OptionFromOptional` for HTTP query parameters AND for partial PATCH request payload fields (missing key → `Option.none()`, present value → `Option.some(decoded)`). To add a new field with a plain-value default that stays wire-compatible with older producers, use `Schema.<Type>.pipe(Schema.withDecodingDefaultKey(() => <default>))`. See `packages/domain/AGENTS.md`.
- **Use branded types** (e.g. `Discord.Snowflake`, `Team.TeamId`) instead of raw `Schema.String` for IDs
- **Use `Effect.void`** instead of `Effect.succeed(undefined)` or `Effect.unit`
- **Use Effect `Array` module** instead of native JS array methods in Effect pipelines
- **Type narrow errors** — use discriminated unions for error types

### Import Conventions

```typescript
// Use .js extensions in imports (TypeScript + ESM)
import { pipe } from "effect"
import * as Effect from "effect/Effect"

// Workspace imports
import { DomainService } from "@sideline/domain"
```

### Path Aliases

```typescript
@sideline/bot                → ./applications/bot/src
@sideline/domain             → ./packages/domain/src
@sideline/rules              → ./packages/rules/src
@sideline/server             → ./applications/server/src
@sideline/template-renderer  → ./packages/template-renderer/src
```

## Testing

### Test Structure

```typescript
import { Effect, Exit } from "effect"
import { describe, it, expect } from "@effect/vitest"

describe("MyService", () => {
  it.effect("should handle success case", () =>
    Effect.gen(function* () {
      const result = yield* myOperation
      expect(result).toEqual(expected)
    })
  )
})
```

### Test Utilities

- **`it.effect`** — Run Effect programs as tests
- **`it.scoped`** — Tests requiring scope
- **`it.live`** — Tests with live services
- **`TestClock`** — Control time
- **`ConfigProvider.fromMap`** — Mock configuration
- **`Effect.provide`** — Supply test implementations

### Date Fixtures On Now-Gated Paths Expire

A date literal in a fixture that the code under test compares against the real clock has a silent expiry date: the test passes until that date arrives, then fails on every branch at once — and it fails naming whatever field went `undefined`, not the fixture. `applications/server/test/api/eventAllDayAnchor.test.ts` case 9 created an event at `'2026-09-16T12:00:00Z'` and then PATCHed it; on 2026-09-17 the PATCH gate (`eventAcceptsRsvp`) answered 400, the assertion read `expected undefined to be '2026-09-15T22:00:00.000Z'`, and `Check → Test` went red on `main`.

Applies to server, bot and web tests alike:

1. **Before writing a date literal into a fixture, check whether anything on the path under test reads the clock** — `DateTime.nowUnsafe()`, `new Date()`, `Date.now()`, or SQL `now()`. If it does, that literal has an expiry date.
2. **A case that asserts only a relative property derives its date from the clock; a case that asserts a literal instant keeps a fixed date at least three years out** and must be rolled forward before it expires. A clock-derived date can never be pinned to a literal instant, because DST transitions and leap days move it between runs.
3. **Assert the documented success status of every request whose response body a later assertion reads**, so the next expiry fails loudly instead of surfacing as an `undefined` field.

Full rationale, the reference helper, and the list of event surfaces that consult `now`: `applications/server/AGENTS.md` → "A Date Fixture On A Now-Gated Path Has A Silent Expiry Date". The opposite trap — a fixture computed FROM `now` that wraps across a local-midnight or DST boundary — is covered in the same file under "A Cron's Test Fixtures And The Cron Must Share ONE Instant".

### Running Tests

```bash
pnpm test                    # Run all unit tests (no DB needed)
pnpm test:unit               # Alias for pnpm test
pnpm test --watch            # Watch mode
cd packages/domain && pnpm test  # Specific package
```

### Integration Tests

Integration tests live in `applications/server/test/integration/` and use **testcontainers** to spin up a real PostgreSQL 17 database.

```bash
pnpm test:integration        # Run integration tests (needs Docker)
```

**Prerequisites:**
- Docker must be running
- Run `pnpm build` first (migrations package must be compiled)

**Structure:**
```
applications/server/test/integration/
├── globalSetup.ts      — Starts PostgreSQL container, runs migrations, writes connection info to /tmp
├── setupFile.ts        — Reads connection info and sets process.env for each worker
├── helpers.ts          — TestPgClient layer and cleanDatabase effect
├── api/                — HTTP API handler integration tests
├── gdpr/               — GDPR export/erasure integration tests
├── migrations/         — Migration integration tests
├── repositories/       — Repository integration tests
├── rpc/                — RPC handler integration tests (wire the real `*RpcLive` against real repositories)
└── services/           — Service integration tests
```

Put a test here — not in `test/` — whenever the assertion depends on what the SQL actually does (recursive walks, `is_archived` severing, `ON CONFLICT`, `LATERAL` correlation). See `applications/server/AGENTS.md` → "Testing" rule 4.

**Key helpers:**
- `TestPgClient` — a `Layer` that creates PgClient from env vars set by setupFile
- `cleanDatabase` — an Effect that empties every public table holding rows (except `migrations_*`) before each test, in one `TRUNCATE`. It probes with `EXISTS` first and skips already-empty tables: it runs once per test across 617 tests, and truncating all 85 tables one command at a time cost 480ms a clean and was what blew `hookTimeout` under load — blaming whichever test happened to be next. Keep it a single statement over only the dirty tables.

**Writing integration tests:**
```typescript
import { TestPgClient, cleanDatabase } from '../helpers.js'
import { beforeEach } from 'vitest'

const TestLayer = MyRepository.Default.pipe(Layer.provideMerge(TestPgClient))

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise))
```

## E2E Testing

E2E tests live in the `e2e/` directory at the monorepo root and use **Playwright**.

### Structure

```
e2e/
├── playwright.config.ts   — Playwright configuration (baseURL, projects, webServer)
├── tsconfig.json          — Standalone tsconfig for e2e tests
└── tests/
    └── *.spec.ts          — Test files (use .spec.ts extension)
```

### Writing E2E Tests

```typescript
import { expect, test } from '@playwright/test';

test.describe('Feature', () => {
  test('should do something', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Sideline/);
  });
});
```

### Running E2E Tests

```bash
pnpm test:e2e              # Run E2E tests (starts dev server automatically)
pnpm test:e2e:ui           # Open Playwright UI mode for debugging
pnpm exec playwright install chromium  # Install browser (first-time setup)
```

The `webServer` config in `playwright.config.ts` automatically starts `pnpm --filter @sideline/web dev` when running tests locally. In CI, `reuseExistingServer` is disabled so Playwright always manages the server lifecycle.

## Package Structure Conventions

```
packages/{name}/
├── src/
│   ├── index.ts           — Main entry point (must export public API)
│   ├── {Feature}/         — Feature-based organization
│   │   ├── services.ts    — Effect services
│   │   ├── models.ts      — Domain models (Effect Schema)
│   │   ├── effects.ts     — Effect programs
│   │   └── layers.ts      — Layer construction
├── test/
│   └── *.test.ts          — Test files
├── package.json
├── tsconfig.json
├── tsconfig.src.json
├── tsconfig.test.json
└── tsconfig.build.json
```

### Effect-free Packages

Two packages are deliberately **Effect-free** because their exports are called synchronously from React render in `applications/web`:

| Package | Called synchronously from |
|---------|---------------------------|
| `packages/template-renderer` | `applyTemplate` in the team-settings welcome-editor live preview |
| `packages/rules` | the trainer engine (`ipos`, `chainView`, `score`) inside a 60fps `requestAnimationFrame` loop |

Rules for every package in that table:

1. **Never** add `effect` or any `@effect/*` package to `dependencies`, `devDependencies`, or `peerDependencies`.
2. All exports must be pure and synchronous — no I/O, no `Layer`, no `Effect`.
3. Tests use plain `vitest`. **Never** import `@effect/vitest` (`it.effect`, `it.scoped`, `it.live`) in these packages.
4. A new package whose exports are called from React render belongs in this table — add the row here and a `## Constraints` section stating rules 1–3 in that package's `AGENTS.md`.

### Shipping JSON Assets From a Package

Reference implementation: `packages/rules` (nine scenario packages plus `rules.json` and `signals.json` under `src/content/`).

1. **Every JSON import must carry the import attribute** — static and dynamic:
   ```typescript
   import pull from './content/packages/01-pull.json' with { type: 'json' };
   const p = await import('./content/packages/01-pull.json', { with: { type: 'json' } });
   ```
   Omitting it produces **no compile error**; under `module: NodeNext` Node throws `ERR_IMPORT_ATTRIBUTE_MISSING` at runtime — i.e. on app boot, not in `pnpm check` or `pnpm build`. Only a real `node` import of the built output catches it.
2. **Add the JSON glob to the project's `include`.** `resolveJsonModule: true` (already set in `tsconfig.base.json`) is not sufficient under this repo's composite / project-references layout: `tsc -b` fails with `TS6307` unless the imported JSON is also matched by `include`. Use `"include": ["src", "src/**/*.json"]` in `tsconfig.src.json` (reference: `packages/rules/tsconfig.src.json`).
3. **Add a `postbuild` assertion that the assets actually reached `dist/`.** `tsc -b` trusts `.tsbuildinfo` and will not re-copy JSON it believes is unchanged, so `pnpm build` can exit 0 with an empty `dist/content/`. Wire `"postbuild": "node scripts/assert-dist.mjs"` into `package.json`; the script must assert every expected JSON file exists under `dist/` **and** `import()` the built barrel for real (that import is also the only check for rule 1). Reference: `packages/rules/scripts/assert-dist.mjs`.

## Stale Build Artifacts Lie To You

**Every local check in this repo reads a build artifact, not your source.** A
green `pnpm check` proves the artifacts agreed with each other, not that your
code is correct. Four distinct failures in one session traced to this, each
presenting as a bug somewhere innocent:

| Stale thing | How it presents |
|---|---|
| `tsc -b` incremental cache | `pnpm check` passes; CI fails on a real type error |
| `packages/domain/dist` | Type errors in apps you never touched, about RPC fields that exist in source |
| Generated route tree (`tsr generate`) | `Type '"/teams/$teamId/x"' is not assignable to…` for a route that plainly exists |
| `packages/migrations/dist` | A **deleted migration keeps running** — including after a rename, so a duplicate-id collision survives the fix |

Before trusting any local result, and always before pushing:

```bash
pnpm build:packages          # apps type-check against dist/, not src/
pnpm codegen                 # route tree, i18n registry, index barrels
pnpm check                   # only meaningful after the two above
```

Two traps worth naming:

- **`tsc -b` will not re-emit after you delete `build/`** — its `.tsbuildinfo`
  still says everything is current, and the build fails with
  `build/esm does not exist`. Use `pnpm clean`, or delete
  `<package>/.tsbuildinfo` before rebuilding. `tsc -b --force` is the only
  local type-check that cannot be fooled.
- **A renamed or deleted file lingers in `dist/`.** `tsc` emits, it never
  prunes. If a rename is supposed to remove something, verify with
  `find <package>/dist -name '<old-name>*'` rather than assuming.

## Migration IDs Collide Silently

Migration ids are hand-picked timestamps, so two branches opened around the
same time pick the same next number and only collide **after both have
merged** — each PR is individually fine, and review cannot catch it.

The failure is unrecognisable. Effect's `Migrator` aborts with
`MigrationError { kind: 'Duplicates' }`, that abort happens inside the
integration suite's `globalSetup`, and vitest reports:

```
No test files found, exiting with code 1
```

naming neither migrations nor the id. It fails **every** open PR, including
ones touching nothing but frontend files — which is the tell that it is main,
not the branch.

`pnpm lint` now runs `scripts/check-migration-ids.mjs`, which names the
colliding files and the next free id. When adding a migration, take the next
id from the highest that exists **at merge time**, not at branch time, and
write it idempotently (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT
EXISTS`) so a renumber stays safe for any database that already applied it.

A `CREATE OR REPLACE FUNCTION` that **changes the argument count** does not
replace the old function — Postgres treats a different arity as a distinct
overload, so both survive and callers resolve unpredictably. When editing an
unmerged migration to add a parameter, precede it with
`DROP FUNCTION IF EXISTS <name>(<old arg types>)`.

## A Backtick Inside a SQL Template Literal Ends the String

Every `sql\`…\`` query in this repo is a JS template literal, so a backtick
anywhere inside it — **including in a `--` comment** — terminates the string
early. The rest of the query becomes JS, and the file explodes into syntax
errors that point everywhere except the backtick.

This has happened twice. Once it produced **223 type errors across the whole
monorepo**, none of them in the offending file, presenting as "the repository's
service type is `void`" in unrelated tests. Use single quotes when a SQL
comment needs to quote an identifier:

```ts
// ✗ Bad — terminates the template literal
sql`-- the \`assigned\` reminder fires outside the time gate`
// ✓ Good
sql`-- the 'assigned' reminder fires outside the time gate`
```

Nested backticks inside a `${}` interpolation hole are fine — the parser
handles those correctly — but hoisting the value to a `const` above the query
reads better and avoids provoking a false alarm during a grep.

## `vi.stubGlobal('URL', …)` Breaks Vitest's Module Loader

Replacing the global `URL` with a plain object (the usual way to spy on
`createObjectURL` / `revokeObjectURL`) makes every **dynamic `import()` in that
file** fail with `TypeError: URL is not a constructor`. Vite's module runner
calls `new URL(...)` on the *global* to resolve a module's `file://` path, so
the stub breaks the loader before the code under test ever runs. Reproduced
with a zero-import module, so it is the stubbing pattern, not the subject.

Spy on the real object instead — same assertions, no loader breakage:

```ts
// ✗ Bad — every `await import('./x.js')` in this file now throws
vi.stubGlobal('URL', { ...URL, createObjectURL: mk, revokeObjectURL: rv });
// ✓ Good
vi.spyOn(URL, 'createObjectURL').mockImplementation(mk);
vi.spyOn(URL, 'revokeObjectURL').mockImplementation(rv);
```

Type the mocks as `Mock<(obj: Blob | MediaSource) => string>` and
`Mock<(url: string) => void>` so `mockImplementation` accepts them while the
`toHaveBeenCalledWith` matchers still type-check.

## Common Tasks

```bash
pnpm build               # Build all packages
pnpm check               # Type check
pnpm test                # Run tests
pnpm test:e2e            # Run Playwright E2E tests
pnpm test:e2e:ui         # Open Playwright UI mode
pnpm format              # Biome formatting and linting
pnpm codegen             # Regenerate generated code
pnpm clean               # Remove stale artifacts (also clears .tsbuildinfo)
pnpm lint                # Biome + workspace deps + migration ids + rpc encoding
pnpm tsx ./path/to/file.ts   # Execute TypeScript directly
```

## Biome.js

- **Formatter**: 2-space indentation, 100-char line width, single quotes, semicolons, trailing commas
- **Linter**: All recommended rules + TypeScript-specific rules
- **Import Organization**: Automatic import sorting, unused import removal
- **VCS Integration**: Git-aware, respects `.gitignore`
- **Test File Overrides**: `noExplicitAny` disabled in test files
- **`overrides` REPLACE a rule, they do not merge with the base rule.** When an entry in `biome.json` `overrides` re-declares a rule, the base `linter.rules.*` options for that rule stop applying to the matched files entirely. Adding a per-path override therefore silently disables every other option of the same rule there. Consequence for restricted imports: a new banned path for the web app must be added to the **existing** `applications/web/**` `style/noRestrictedImports` override (it currently lists both `@sideline/i18n/messages` and `@sideline/rules/content` for exactly this reason) — never as a second override entry, and never only in the base rule.
- **Never rely on `!` non-null assertions for narrowing** (e.g. `map.get(k)!`, `arr[i]!`). The Biome formatter strips `!` in some positions, so a value the compiler treated as non-`undefined` becomes `T | undefined` after `pnpm format` and `pnpm check` then fails on the now-unguarded use. Always narrow with an explicit `undefined` guard instead — `const v = map.get(k); if (v === undefined) { ... }` — for `Map`/array/optional lookups.

## CI Pipeline

The `check.yml` workflow runs on pushes to `main` and on pull requests:

| Job | Command | Purpose |
|-----|---------|---------|
| **Lint & Format** | `pnpm lint` | Biome formatting and lint rules, plus the workspace-dep, migration-id and RPC-encoding guards |
| **Build** | `pnpm codegen && pnpm build` | Verifies codegen + builds all packages |
| **Types** | `pnpm check` | Type-checks all packages |
| **Test** | `pnpm build && pnpm test` | Builds packages, then runs tests |
| **E2E Tests** | `pnpm build && pnpm test:e2e` | Builds packages, then runs Playwright E2E tests |

> **Why Build is critical:** Workspace packages use `publishConfig.directory: "dist"`, so pnpm symlinks consumers to `packages/*/dist`. Stale `.d.ts` files cause false type errors and cryptic test failures. **Always rebuild `packages/domain` after changing domain source files.**

### Docker / Snapshot Pipeline

`snapshot.yml` runs on PRs: publishes package snapshots via `pkg-pr-new`, builds Docker images for all apps, pushes to `ghcr.io/maxa-ondrej/sideline/<app>`.

### Full Clean Verification

When type errors seem wrong or after large refactors:
```bash
pnpm codegen && pnpm build && find . -name '*.tsbuildinfo' -delete && pnpm check && pnpm test
```

## Branching & PR Strategy

Trunk-based development on `main`:
- **`main`** is the single long-lived branch
- **Feature branches** branch off `main` and merge back via PR
- Branch naming: `feat/rsvp-buttons`, `fix/auth-token-refresh`, `docs/setup-guide`

### Workflow

1. Create a feature branch from `main`
2. Make changes, commit (pre-commit hooks run biome automatically)
3. Open a PR against `main` — CI runs checks + snapshot build
4. After review, squash-merge into `main`
5. No changeset is needed — a release is cut post-merge by pushing per-app `@sideline/<app>@vX.Y.Z` tags (see `/deploy`)

## Development Workflow Skills

The development workflow is split into composable skills:

| Skill | Purpose |
|-------|---------|
| `/work` | Orchestrator: picks up a Notion story → `/implement` → `/ship` → updates Notion |
| `/worktree` | Picks up a Notion ticket → opens it in an isolated herdr worktree (branch + seeded env + `pnpm install`) → launches a Claude agent inside it |
| `/implement` | Full dev loop: research → plan → TDD → verify tests → implement → verify → review → refactor |
| `/ship` | Delivery loop: `/docs` → checks → commit → push → PR → CI → code review → `/revise` |
| `/revise` | Triage review comments with `/architect` → `/implement` fixes → `/ship` |
| `/refactor` | Refactor code with before/after explanation, verified by tests |
| `/complete` | Mark story/bug as done after PR is merged (story → Done, bug → Fixed) |
| `/reconcile` | Sync Notion statuses for merged PRs |

### Composition

- **`/work`** calls `/implement` then `/ship` — use for full story lifecycle with Notion integration
- **`/implement`** is standalone — use when you already have a branch and want the full dev loop
- **`/ship`** is standalone — use when code is ready and you want to commit, push, and handle review
- **`/revise`** is standalone — use when a PR has review comments to address
- **`/complete`** is standalone — use after a PR is merged to finalize Notion statuses
- **`/worktree`** is standalone — runs `scripts/herdr-worktree.sh` to spin up parallel work on a ticket in an isolated herdr worktree; the launched agent then boots into `/work <ticket-page-id>` there

## Releases

There is no Changesets flow and no `pnpm changeset*` command. A release is a set of per-app git tags `@sideline/<app>@vX.Y.Z` — all apps are normally tagged together at one shared version (a plain `vX.Y.Z` tag is a fallback that releases every app at once).

- **Cut a release**: tag `main` with `@sideline/<app>@vX.Y.Z` for each app being released (bump patch for fixes, minor for features, never major without the user asking). `.github/workflows/release.yaml` parses each tag and builds + pushes that app's `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` image (the IMAGE tag is the plain version — what MajNet reads), and MajNet auto-tracks the release into the `stable` class.
- **Promote to production**: promote the chosen `vX.Y.Z` release via MajNet, which opens an admin-gated `env/production` render PR on `sideline-cz/ops`; merging that PR is the production deploy.
- Run the full flow through the `/deploy` skill (authoritative reference: `.claude/skills/deploy/SKILL.md`).

## Git Conventions

- Never add `Co-Authored-By`, `Generated-By`, or any AI attribution footers to commit messages
- Never commit to an old/existing feature branch when working on a new story — always create fresh from `main`
- Before every commit, run `pnpm format` and `pnpm codegen`, stage resulting changes
- After every `git push`, check that CI pipelines pass
- After any structural change (new packages, new patterns, changed conventions), update the relevant section in AGENTS.md as part of the same PR

## Task Management (Notion)

**Always use the `notion` CLI tool to check for tasks, stories, and sprint work.** Notion is the single source of truth.

### Hierarchy

```
Milestone → Epic → Story → Task
```

### Notion Databases

| Database | ID |
|----------|---|
| Tasks | `2e0b6b31-d3bd-4e32-a127-3eedf257f228` |
| Stories | `9ec44d56-966b-4c3e-ba98-637b128c99a8` |
| Epics | `a040ab6d-10bb-4575-8c80-d4e827238b03` |
| Milestones | `089dd440-070c-4cfb-a45d-1a68c299a2f2` |
| Sprints | `a89cc7a7-ab1a-4e3f-945d-d42028c75f00` |
| Bugs | `e6b8eb47-ddcd-4dba-b5fd-c631763ac5bd` |

### Task Properties

- **Status** — `TODO` | `In Progress` | `Done`
- **Type** — Feature | Bug | Design | Test | Docs | DevOps | Refactor
- **Story** — relation to Stories database
- **Version** — `v1` | `v2`

### Task Status Lifecycle

Tasks: `TODO → In Progress → Done`
Stories/epics/milestones: `TODO → In Progress → In Review → In Test → Done`

- When starting work, move **ALL tasks** to `In Progress` immediately
- Also cascade `In Progress` up to story, epic, milestone
- After CI passes, move tasks to `Done`; if all tasks done, story → `In Review`
- After PR merged, story → `In Test`
- **Never** move stories/epics/milestones to `Done` — that's manual

### Notion CLI (`ntn`)

The binary is **`ntn`**, not `notion` — Homebrew cask `notion-cli` (v0.23+), at
`/opt/homebrew/bin/ntn`. A stale `notion` formula symlink may also exist; it is dangling, ignore it.
`/opt/homebrew/bin` is not on the nix devshell PATH, so use the absolute path.

Everything goes through `ntn api` (the public Notion API). `ntn api ls` lists endpoints.
**Queries take a data source id, not a database id** — see `.claude/agents/agile-coach.md` for the
id table and the full command set.

```bash
N=/opt/homebrew/bin/ntn
$N whoami                                                    # auth check
$N api /v1/data_sources/<ds-id>/query -d '{"page_size":100}' # query rows
$N api /v1/pages/<page-id>                                   # read properties
$N api /v1/pages/<page-id>/markdown                          # read page body
$N api /v1/pages/<page-id> -X PATCH \
   -d '{"properties":{"Status":{"status":{"name":"In Progress"}}}}'   # update (status type)
$N api /v1/databases/<database-id>                           # -> .data_sources[].id
```

Always read a page back after writing it, before reporting the write succeeded.

## Preview Database Access

Each PR gets a preview database. Use `bin/psql` to connect:

```bash
psql --pr 108                          # Connect to PR 108's preview database
psql --pr 108 -c "SELECT * FROM teams" # Run a query
psql                                   # Connect to the main preview database
```

Configuration:
- `.env.preview` — connection config (host, port, user, DB name templates) — committed
- `.env.preview.local` — password only — gitignored

Both files are sourced automatically by `bin/psql`. The `bin/` directory is added to `PATH` via `.envrc`.

### Editing migrations after PR creation

Migrations run automatically when a preview environment is deployed. If you edit a migration **after** the PR has already been created (and the preview deployed), the migration runner will skip it because it was already marked as executed. You must apply the new SQL statements manually:

```bash
psql --pr <PR_NUMBER> -c "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ..."
```

Always use `IF NOT EXISTS` / `IF EXISTS` guards so the command is idempotent. Run each new statement from the migration that was added after the initial deploy.

## Logs & Monitoring

Logs, traces, and metrics are exported via OpenTelemetry to **Tempo + Loki** (SigNoz was retired). Read them with the `majnet` CLI rather than a UI — see `/diagnose`. Node apps (server, bot) configure the telemetry layer in each application's `run.ts` using `makeTelemetryLayer` from `@sideline/effect-lib`. The web app uses a **separate browser-side** telemetry layer in `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer`) wired through a `ManagedRuntime` singleton — see `applications/web/AGENTS.md` → "Runtime Singleton & Browser Telemetry".

### Services

| Application | `service.name` | Telemetry layer source |
|-------------|----------------|------------------------|
| Server | `sideline-server` | `applications/server/src/run.ts` (`@sideline/effect-lib` `makeTelemetryLayer`) |
| Bot | `sideline-bot` | `applications/bot/src/run.ts` (`@sideline/effect-lib` `makeTelemetryLayer`) |
| Web | `sideline-web` | `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer`, browser `Otlp.layerJson` + `FetchHttpClient.layer`) |

### Resource Attributes

| Attribute | Source | Example |
|-----------|--------|---------|
| `service.name` | `OTEL_SERVICE_NAME` | `sideline-server` |
| `deployment.environment` | `APP_ENV` | `preview` \| `development` \| `production` |
| `service.origin` | `APP_ORIGIN` | `sideline-preview.majksa.net` |

### Environments

| Environment | `APP_ENV` | Description |
|-------------|-----------|-------------|
| Development | `development` | Local development |
| Preview | `preview` | Per-PR preview deployments |
| Production | `production` | Live production environment |

### Querying Logs

Use the `majnet` CLI. It reads container logs directly and also runs read-only SQL against an app's
managed database, which is usually the faster answer:

```sh
majnet whoami                                       # ALWAYS first — see /diagnose for why
majnet logs sideline bot -c production -n 300        # --follow to tail
majnet sql  sideline server -c production 'SELECT …' # read-only by default
```

**The CLI defaults to `-c stable`.** Pass `-c production` explicitly or you will read the wrong
environment. Severity levels: `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`.

`/diagnose` carries the full routine, including the answers that look like success but are not.

## Troubleshooting

- **"Cannot find module"**: Ensure `.js` extensions in imports, run `pnpm install`
- **Type errors with Effect**: Ensure `@effect/language-service` is loaded, check error types are handled
- **Test failures**: Verify all services provided, use `it.effect` not raw `it`
- **Build failures**: Run `pnpm clean`, check `tsconfig.build.json`, verify project references
- **Stale domain `dist/`**: Run `pnpm build`, delete `.tsbuildinfo` files
- **Build exits 0 but `dist/` is missing JSON assets** (`ERR_MODULE_NOT_FOUND` at runtime): `tsc -b` trusted a stale `.tsbuildinfo` and skipped the copy. Run `find . -name '*.tsbuildinfo' -delete && pnpm build` — see "Shipping JSON Assets From a Package"
- **TanStack Router serialization errors**: Add `ssr: false` to route options

## App Version (`APP_VERSION`)

Every long-running application exposes its own version string as `export const APP_VERSION: string`. Consumers (info commands, `/version` endpoint, web footer) import it from a per-app `version.ts`.

| App | File | Source of truth |
|-----|------|-----------------|
| Server | `applications/server/src/version.ts` | Prefers `process.env.APP_VERSION` (baked from the release tag — see rule 4); otherwise reads `package.json` at runtime via parent-walking from `import.meta.url`, guarded by `parsed.name === '@sideline/server'`. |
| Bot | `applications/bot/src/version.ts` | Prefers `process.env.APP_VERSION` (baked from the release tag — see rule 4); otherwise reads `package.json` at runtime via parent-walking from `import.meta.url`, guarded by `parsed.name === '@sideline/bot'`. |
| Web | `applications/web/src/lib/version.ts` | Reads `import.meta.env.VITE_APP_VERSION`, injected at build time by `vite.config.ts` + `vitest.config.ts` via `define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) }` (both configs must mirror each other). |

### Rules for adding `APP_VERSION` to a new application

1. **Node runtime apps (server, bot, future workers)** — copy `applications/server/src/version.ts` and change only the workspace-name guard to the new package's `name` field. The copied file first prefers `process.env.APP_VERSION` (baked from the release tag — see rule 4) and only falls back to the parent-walk. Walk **at most 5** parent directories from `import.meta.url`, match `package.json` by `name`, and fall back to `'unknown'` on any failure. The parent-walk + name-match is required because the file may live under `src/` (tsx dev) or `build/src/` (compiled) — neither layout is hard-coded.
2. **Vite-bundled apps** — use the `define` injection pattern: read `./package.json` with `import pkg from './package.json' with { type: 'json' }` and inject `import.meta.env.VITE_APP_VERSION`. Mirror the `define` block in both `vite.config.ts` and `vitest.config.ts` — otherwise unit tests read `undefined` and fall back to `'unknown'`.
3. **Never read `process.env.npm_package_version`** — it is only set under `npm/pnpm run` scripts and is absent in the Docker runtime.
4. **Resolution order is env-first, then `package.json`; never hard-code the version string.** At runtime `version.ts` returns `process.env.APP_VERSION` when it is set and non-empty; otherwise it falls back to the `package.json` version (Node apps) or the injected `VITE_APP_VERSION` (Vite apps). Release builds bake the real version into the image: the reusable MajNet `app-release.yaml` (ADR 0020) passes the release tag as the `VERSION` Docker build-arg, and each `Dockerfile` sets `ENV APP_VERSION=$VERSION` (alongside `GIT_COMMIT` and `BUILD_TIME`) in its production stage — so a released container reports the tag while local/dev runs report the frozen `package.json` version. `package.json` versions are frozen (nothing auto-bumps them); the env var — not `package.json` — is the release-accurate source. Never hard-code a version literal.

## Documentation Conventions

Sideline has **three distinct documentation surfaces**. Know which one to update:

| Surface | Audience | Location | Format |
|---------|----------|----------|--------|
| Agent guides | AI agents, developers | `AGENTS.md` files | Markdown |
| Internal tech reference | Developers, operators | `docs/*.md` | Markdown |
| End-user product docs | Players, captains, admins, API integrators | `applications/docs/src/content/docs/**` | Starlight (MDX / Markdown) |

- **Always update the relevant AGENTS.md** when making architecture changes, adding new patterns, or establishing new conventions
- Package-specific docs go in the package's `AGENTS.md`, not here

### Product-user documentation (`applications/docs/`)

The user-facing docs site lives at `applications/docs/` (Astro + Starlight, served at `/docs`). Update it in the same PR when code changes alter end-user behaviour:

| Code change | Required docs update |
|-------------|----------------------|
| New or changed user-facing flow | Matching `guides/*.mdx` |
| New role / changed permission | `quick-start/<role>.mdx` |
| New Discord bot slash command | `guides/discord-integration.mdx` or `faq.md` |
| New API endpoint or changed schema | `api/overview.mdx` (and future per-endpoint pages) |
| New domain term | `introduction/key-concepts.md` |
| User-visible release | Append a plain-language entry to `changelog.md` |

See `applications/docs/AGENTS.md` for content conventions, translation policy (no CZ stubs in v1 — Starlight's fallback banner handles untranslated pages), and local dev workflow.

### Internal technical reference (`docs/`)

The root `docs/` directory contains comprehensive technical documentation for contributors and operators. These must stay in sync with the codebase. Update them as part of the same PR when making relevant changes:

| Document | Update when… |
|----------|-------------|
| `index.md` | Adding or removing documentation files |
| `discord-bot.md` | Adding/removing/renaming bot slash commands, button/modal interactions, gateway handlers, or RPC sync workers |
| `deployment.md` | Changing environment variables, Docker configuration, CI/CD pipelines, cron job schedules, monitoring setup, or local dev prerequisites |
| `api.md` | Adding/removing/renaming API endpoints, changing request/response schemas, adding new error types, or modifying auth requirements |
| `database.md` | Adding/removing/renaming database tables or columns (new migrations), changing constraints, indexes, or seeding behavior |

## Thesis Documentation (`docs/thesis/`)

The `docs/thesis/` directory contains Mermaid diagrams and documentation for the bachelor's thesis. These must stay in sync with the codebase. Update them as part of the same PR when making relevant changes:

| Document | Update when… |
|----------|-------------|
| `er-diagram.md` | Adding/removing/renaming database tables or columns (new migrations) |
| `architecture.md` | Adding new applications, packages, services, cron jobs, or changing the deployment topology (docker-compose, nginx) |
| `use-cases.md` | Adding new API endpoints, RPC methods, bot commands, or changing actor permissions |
| `sequence-diagrams.md` | Changing the flow of any documented interaction (OAuth, event creation, RSVP, role sync, cron generation, team creation, invites) |
| `user-testing-plan.md` | Adding or removing user-facing features that should be covered by test scenarios |
| `competitive-analysis.md` | Adding major new features that change Sideline's competitive positioning |

---

**Last Updated**: 2026-09-21 (Vanishing personal event cards `fix/voting-maybe-message-disappears`. `buildUpcomingEventEmbed` rendered row 1's "Coming later" trigger and row 2's edit-message button with the identical `u-add-msg:{team_id}:{event_id}:coming_later` custom_id, and since `coming_later` mandates a comment the edit button always renders — so every "Coming later" vote produced a message Discord rejected with `50035`, after which every reconcile edit 400'd and `reorderPersonalChannel`'s delete-then-recreate removed the card for good. Row 1 now emits `…:coming_later:v` (inert suffix; the handler reads the `u-add-msg:` prefix and parts[1..3] only). bot AGENTS.md → "Building Message Components" gained rule 8: every `custom_id` inside ONE message must be unique and ≤100 characters, disambiguate with a ≤2-character inert suffix because a `prefix:{uuid}:{uuid}:{response}` id already spends 96 of the budget — this is the one place the rule lives, the upcoming-events section only references it. Two follow-on fixes documented in the same file: `src/interactions/upcoming-rsvp.ts`'s three handlers edit a PERSISTENT personal-channel card (not an ephemeral page), so the not-found branch is now content-only — a Discord PATCH leaves absent fields untouched, whereas `embeds: []` / `components: []` destroys a card the dirty-flag-driven reconcile loop will not necessarily rebuild — and they resolve the member's events through the unpaginated `Guild/GetAllUpcomingEventsForUser` instead of `Event/GetUpcomingEventsForUser`'s `limit: 10`, which made the 11th+ event look deleted. `src/rest/discordErrors.ts` gained `isUnknownMessageError` (code 10008 only): "Classifying a One-Off Discord REST Error" now states the rule both it and `isUnknownRoleError` follow — a predicate whose branch REPLACES a stored id matches the Discord code, never the HTTP status, because a bare 404 also means Unknown Channel and would discard a valid row. `handleReconcile.ts` uses it to recreate a personal message whose stored id returns 10008, relying on `UpsertPersonalEventMessage`'s `ON CONFLICT (event_id, team_member_id) DO UPDATE` to repoint the row and deliberately NOT deleting the row first — deleting first would leave no message and no row if the create then failed, while the tick clears the dirty flag regardless.)

**Last Updated**: 2026-09-21 (`moveGroup` cycle check made atomic `fix/move-group-cycle-toctou`. `api/group.ts`'s `moveGroup` validated the `groups.parent_id` tree and then `UPDATE`d it with no transaction or lock between the two, so two concurrent moves each passed against the pre-move tree and jointly closed a cycle; the validation and the `UPDATE` now share one `sql.withTransaction` serialized per team by `pg_advisory_xact_lock(hashtext(teamId))`. A `WHERE NOT EXISTS (...)` predicate on the `UPDATE` alone would NOT have fixed it — under READ COMMITTED the two statements touch different rows, so they never block each other and both read a pre-move snapshot. The per-team key is only sufficient because the new `requireSameTeamParent` helper runs on BOTH `parent_id` writers — `createGroup`'s insert as well as `moveGroup`'s update: a parent in another team sits under a different lock key, and a cross-team edge planted at creation (previously unvalidated entirely) is one a later ordinary same-team move extends into exactly that cycle. It keeps failing `Forbidden` rather than `GroupNotFound` because `createGroup` does not declare `GroupNotFound`, and `moveGroup` already spends that error on the PATH group. `moveGroup` also now rejects `parentId === groupId`: `getAncestorIds` seeds from `parent_id` so it structurally cannot see a self-parent, and the handler's own follow-up `getMemberCount` call then recursed forever on the cycle it had just written — a one-request hang available to any `group:manage` holder, since no `statement_timeout` is configured anywhere in this repo. server AGENTS.md → "Per-Team Advisory Lock Guarding an Invariant Check" gains `moveGroup` as its second reference case with two lessons the deactivation cascade does not carry: the lock key defines the invariant's scope, so every edge the guarded check walks must stay inside that key (hence guarding both writers, not just the racy one); and an interactive endpoint precedes the lock with `SET LOCAL lock_timeout` (node-pg cannot cancel an in-flight query, so a fiber interrupted while parked on the lock still pins one of the pool's 10 connections until the lock is granted — background sweeps can afford that wait, a request handler cannot). server AGENTS.md → "Recursive `groups.parent_id` Walks Must Carry a `depth < 32` Guard": premise rewritten — no API path builds a cycle any more, but legacy rows and hand-written SQL still can, so the guard rule stands unchanged; `countMembersForGroup` and `findDescendantMembers` moved from the "not yet guarded" list to the guarded one, and rule 1 now notes that the walks the REPAIR path calls need the guard as much as the check itself. Coverage: `test/integration/api/groupRoleDiscordSync.test.ts` section 8 (self-parent, cross-team parent on both writers, descendant-parent regression, and a real two-session advisory-lock contention test) and a `getMemberCount`-terminates-on-a-pre-existing-cycle test in `test/integration/repositories/GroupsRepository.test.ts`.)

**Last Updated**: 2026-09-21 (Dead global-events-board embed builders deleted `fix/remove-dead-embed-builders`. #547 removed the shared events board but left its renderers behind: `applications/bot/src/rest/events/buildEventEmbed.ts` and `buildEventListEmbed.ts` had no production caller, and their three test files (`test/buildEventEmbed.test.ts`, `test/buildEventListEmbed.test.ts`, `test/rest/events/buildEventEmbed.test.ts`) were the only thing keeping them alive. Both builders and all three tests are gone, together with the dead `buildEventEmbed` / `buildCancelledEmbed` / `buildEventListEmbed` / `PAGE_SIZE = 5` exports they carried (`EditOutcome` and `processKeptPrefix` had already gone with `reorderChannelMessages.ts` in #547). `YES_EMBED_LIMIT = 20` moved out of the deleted `buildEventEmbed.ts` into `applications/bot/src/rest/utils.ts`, which now hosts all three shared bot limits (`POLL_BATCH_SIZE`, `EMBED_FIELD_VALUE_LIMIT`, `YES_EMBED_LIMIT`) alongside `retryPolicy` and the `formatName*` family; bot AGENTS.md → "Folder Naming Conventions" gained a `src/rest/utils.ts` row making that the mandatory home for any constant or helper used by more than one feature — never a `build<Name>Embed.ts` or a `handle*.ts`. bot AGENTS.md → "Event Sync" rewritten from the two-surface model to ONE reconciled RSVP surface (the per-member personal channels, off the `events.personal_messages_dirty_at` marker) plus four persistent-but-unreconciled embeds (`buildClaimMessage`, `buildRosterApprovalMessage`, `buildGeneratedTeamsEmbed`, the late-RSVP notice in `src/interactions/rsvp.ts`) and the ephemeral `/event list` reply — "one surface" in that file always means the reconciled RSVP one. `src/rcp/event/reorderChannelMessages.ts` + `recoverDeletedMessages.ts` (and `MAX_CHANNEL_EVENTS = 10`) are documented as replaced by `src/rcp/event/channelReorderPrefix.ts`, whose `longestKeepablePrefix` has exactly one consumer (`src/rcp/personalEvents/reorderPersonalChannel.ts`) while `compareSnowflakes` is used only inside that file and its own test; the personal channel has NO message cap — the practical bound is `team_settings.event_horizon_days` (default 30) and the worst case is a sequential delete+recreate of every stored message under the channel lock. The "Events-Channel Move" section is deleted, `/event refresh` gating loses its `kind === 'global'` branch (the `'global'` literal survives in `GuildRpcGroup.ts` for wire compatibility and now maps to "nothing to refresh"), and attendees pagination documents `ATTENDEES_LIMIT = 15` owned by `src/interactions/attendees.ts` instead of a builder-exported `PAGE_SIZE`. server AGENTS.md: "Two-surface event model" → "Single event surface"; `resolveChannel` documented as deleted, with `src/services/EventChannelResolver.ts`'s exactly-three surviving exports (`resolveOwnerGroupChannel`, `resolveReminderChannel`, `resolveGroupRoleId`) and their consumers tabulated; "Overloaded payload fields (events-channel move)" replaced by a "Dead-but-present global-board code" table covering `emitEventCreated`/`emitEventUpdated`/`emitEventCancelled`/`emitEventChannelMoved`, the four orphaned `Event/*` RPCs and `EventChannelMovedEvent` — with the explicit warning that `test/integration/repositories/EventSyncEventsRepository.payloads.test.ts` calls `emitEventCreated`/`emitEventUpdated` for REAL (a mock stub is not evidence of a live path, but a live integration test's subject must not be deleted either), and that `Event/GetEventEmbedInfo` is the one still-live symbol in that neighbourhood. domain: `IdentifyEventsChannel`'s docblock in `GuildRpcGroup.ts` marks `'global'` a dead literal. i18n: five orphaned keys removed from BOTH locales (`bot_event_list_title`, `bot_event_list_footer`, `bot_event_list_empty`, `bot_event_cancelled`, `bot_event_started`) — en/cs parity verified at 2782 keys each, no code reference remains. No `.claude/` changes — no agent or skill referenced the deleted builders or the old constant location.)

**Last Updated**: 2026-09-21 (IBAN cross-check `fix/iban-cross-check`. A Fio token that authenticates against a DIFFERENT account than the one configured was being ingested and auto-matched hourly, silently — the probe returned Fio's `info.iban` and the UI displayed it, but nothing compared it. New pure `applications/server/src/services/bankSyncAccount.ts` (`configuredIbanOf` + `isAccountMismatch`) is the ONE definition of the comparison, shared by both Fio callers; it lives server-side rather than in domain `CzIban` because the rule that must never drift is not "normalise a string" but "either side absent ⇒ no verdict", which needs the config row. The probe (`api/bank-sync.ts`) gains the `'account_mismatch'` member of `BankSyncApi.BankSyncTestStatus` (`ok: false`), and `BankSyncPoller.fetchAndIngest` now skips `upsertMany` AND `upsertStatementPeriod` and then `matchIngested` entirely — the poller guard is the actual fix, the probe verdict only diagnoses. root AGENTS.md → "Bank Sync (Fio)" gained invariant 4 (the ingestion guard, the "either side absent ⇒ no verdict" rule, why `recordSuccess` is banned on this path, and the prefix false-positive), and invariant 3's `clearPollBackoff` row is now "**Yes, on a GREEN probe only**" — the old justification that the tap's position in the pipe made gating impossible was simply wrong, it is a one-line ternary, and clearing a mismatch's backoff would only send the poller back to a config it will refuse again while erasing the evidence (`bankSync.test.ts` T8f asserts the probe's changed-key set is EMPTY on a mismatch; T19 asserts `['next_attempt_at']` on a green one — the two read as a pair). The recording path needed a SEVENTH ladder rank: `recordSuccess` clears `last_error_code` and `bankSyncStatus.ts` ranks the card `'ok'` off that alone, which would show "everything is fine" during a halt, while plain `recordFailure` lands on rank 5 `sync_failing`, whose copy promises "we keep retrying, there's nothing to do yet" — both lies. So `BankSyncConfig.BankSyncStatusCode` gains `'account_mismatch'` (rule 2.5, above `invalid` because the token demonstrably WORKS — telling the treasurer to replace it is the wrong instruction — and terminal in the sense that no retry count or elapsed time clears it — note a config EDIT does not either, since `last_error_code` survives `upsertQuery`; only the next successful poll's `recordSuccess` does), written by the new narrow `BankSyncConfigRepository.recordAccountMismatch` (one UPDATE so code and warning can never disagree; warning carries both IBANs, never the token — D10). Web: `FioStatusBlock.tsx`'s `switch` has `default: statusAlert = null`, so a new ladder rank renders NOTHING there with no compile error — unlike `TEST_RESULT_META` and `FioStatusBadge.STATUS_META`, which are exhaustive `Record`s and failed the build as designed. `FioTestResultAlert` takes a required `configuredIban` and renders BOTH IBANs (no `text-muted-foreground` on the destructive variant, `tabular-nums`, raw not grouped, because the treasurer is comparing this string against the `fio_account_preview` one in the same card). Also fixed on the way: the Test button probes the SAVED config but was disabled only on `tokenChanged`, so fixing the account field and pressing Test returned `account_mismatch` again and looked like the fix hadn't taken — new pure `fioAccountChanged` extends the gate, and `fio_test_unsavedTokenHint` is renamed `fio_test_unsavedHint`. The realistic false positive is the PREFIX, not exotic banks (`buildCzIban` returning `None` is unreachable — the API rejects non-building payloads, the DB CHECKs are `^[0-9]{2,10}$`/`^[0-9]{4}$`, the form hardcodes the bank code); Fio does not return the prefix in `accountId`, so a club that typed `2000145399` with an empty prefix field gets a permanent import halt — both copy keys name the prefix for that reason. Test fixtures: `validRawStatement` (`bankSync.test.ts`) and `validStatement` (`BankSyncPoller.test.ts`) both carried `CZ6508000000192000145399` while their seed helper creates `2703474850/2010`; with the comparison live EVERY probe/poll test would have become a mismatch test, so both fixtures now agree with `enableBankSync`'s default account — `FioApiClient.test.ts`, `fioColumns.test.ts` and the bot's SPAYD fixtures deliberately keep the `CZ65…` vector, no comparison runs there. Review caught the guard being defeatable through two other doors, both closed here: `BankSyncBackfill.ts` ingested with no cross-check (a button reachable in exactly the halted state, over a 90-day window), and `BankTransactionsPage.tsx`'s alert gate is a hand-written `status` disjunction rather than an exhaustive `Record`, so the new rank rendered NO banner on the one page a treasurer actually opens — the silent halt simply relocated one route over. Grep for hand-rolled `config.status` disjunctions when adding a rank; the type system does not cover them. Also from review: `recordAccountMismatch` must not increment `consecutive_failure_count` (it would defeat the `>= 3` `invalid` gate for the next real failure), `recordSuccess` now clears `coverage_warning`, and `processTeam` uses the config row `claimPollLease` RETURNS rather than the minutes-old `findPollable` snapshot — otherwise an in-flight cycle re-stamps the error after the treasurer's save and the fix looks like it did not take.)

**Last Updated**: 2026-09-21 (Archived-ancestor channel-sync leak `fix/archived-ancestor-walk`. Archiving a group is a single-row `UPDATE groups SET is_archived = true` — descendants are not archived and `age_threshold_rules` is untouched, so paths that walked ancestors archived-blind, or joined `age_threshold_rules` to `groups` with no `is_archived` filter, kept emitting channel-sync `member_added` for archived groups; the bot's `handleMemberAdded.ts` then recreated a Discord role for a deleted group. server AGENTS.md → "Ancestor walks that drive Discord writes must use `getActiveAncestors`" rule updated: `api/group.ts`'s `addGroupMember` and `syncRoleMembers` now use `getActiveAncestors`; `GroupsRepository.ts`'s archived-blind wrapper renamed `getAncestors` → `getAncestorsIncludingArchived` to disarm the autocomplete trap that caused this twice, and is now called only from `deactivateMemberCascade.ts`, which keeps the archived-blind walk on purpose (a full deactivation must revoke everywhere; see that file's call-site comment) — a recorded decision, not a leftover. `AgeThresholdRepository.ts`'s `findByTeamIdQuery` (`:81-92`) gained `AND g.is_archived = false` on its `JOIN groups`, so the NIGHTLY `AgeCheckCron` sweep (`Schedule.cron('0 2 * * *')`, not hourly) stops auto-assigning members into archived groups; that query's other two callers — the `evaluateAgeThresholds` "evaluate now" endpoint and the `listAgeThresholds` GET — inherit the filter, so a rule targeting a deleted group also disappears from the web list, which is intended. server AGENTS.md -> "Effective Roles Are Derived In Exactly One Place" gained rule 5 generalising this: a soft-archive is one `UPDATE groups SET is_archived = true` with no cascade (`ON DELETE CASCADE` never fires on an `UPDATE`), so every PLAIN `JOIN groups` that drives a Discord write, a membership change or a captain-visible list needs the filter too — not just the recursive walks rule 3 covers. `api/roster.ts`'s `emitDiscordCleanupForMember` helper deleted: it was still CALLED on reactivate, but always a no-op, because step 7 of `deactivateMemberAndCascade` hard-deletes every `group_members`/`roster_members` row and `reactivateMember` restores none of them, so both id lookups it fanned out over always returned empty. bot AGENTS.md -> "Channel Archival": `handleGroupArchived` now deletes the group's Discord role, and its move-to-archive fallback passes the REAL `event.discord_role_id` instead of `Option.none()`. The `deleteRole` tap sits at the TOP LEVEL of the `Effect.Do.pipe`, OUTSIDE `Option.match(event.discord_channel_id)` — exactly where `handleDeleted.ts:25` puts its own — because a group mapping is legally `discord_channel_id = None` + `discord_role_id = Some` (captain detached the channel, or the bot's `createRoleOnly` branch minted a role-only mapping), and nested inside the `onSome` those groups kept an orphan Discord role forever; `handleRosterArchived` correctly keeps its tap nested, because `RosterChannelArchivedEvent.discord_channel_id` is a bare `Snowflake` with no channel-less branch. The surviving mapping row's now-dangling `discord_role_id` is inert by design — both `DiscordChannelMappingRepository.findGroupsMissingRole` and `findActiveGroupsWithRole` filter `g.is_archived = false`. bot AGENTS.md -> "Discord REST Retry Pattern" rule 2 widened from `Effect.catchTag` to "every permanent-error catch, `catchTag` OR `catchIf`, comes BEFORE `Effect.retry`": `channelUtils.ts`'s `deleteRole`/`deleteChannelAndRole` and `handleArchived.ts`'s `deletePermissionOverwrite` now carry `Effect.catchIf(isDiscordNotFoundError, () => Effect.void)` INSIDE the retry, because outside it a permanent 404 burns all four attempts (~7 s) and then fails, and `ProcessorService` marks complete work `Channel/MarkEventPermanentlyFailed`; in `deleteChannelAndRole` specifically the role delete runs BEFORE the channel delete, so an already-deleted role used to abort the fallback's one job. `isDiscordNotFoundError` is the canonical predicate for any idempotent Discord DELETE/revoke (hand-rolled `status === 404` misses the code-only `10007`/`10011`/`10013` forms); bot AGENTS.md's classifier section now names the three new `catchIf` call sites alongside the pre-existing `src/interactions/sudo.ts:257`. No `.claude/` changes — no agent or skill referenced the renamed method or the changed handlers.)

**Last Updated**: 2026-09-21 (Nondeterministic `role_name` on team generation `fix/team-generation-limit-orderby`. `TeamGenerationRepository.findYesMembersForEvent`'s correlated `role_name` subquery had `LIMIT 1` with no `ORDER BY`, so a member holding more than one role showed a different role between two runs of the same generation; it now orders `r.is_built_in ASC, r.name ASC, r.id ASC` so a custom position role beats the built-ins every member carries and the order is total. server AGENTS.md → new SQL-patterns subsection "A `LIMIT 1` that picks one row MUST carry a total `ORDER BY`": the last `ORDER BY` key must be unique, a unique-key equality `WHERE` is exempt, and the integration test must insert 2+ candidate rows. Coverage: `applications/server/test/integration/repositories/TeamGenerationRepository.roleName.test.ts`.)

**Last Updated**: 2026-09-17 (Fio "test connection" probe `fix/bank-sync-test-connection-validation`. `POST /teams/:teamId/bank-sync/test` now runs one real Fio `/periods` call and answers with the closed `BankSyncApi.BankSyncTestStatus` union (`ok`/`invalid`/`rate_limited`/`history_locked`/`unreachable`/`misconfigured`/`no_token`); `BankSyncTestResult.message` is deprecated and always `null`, with the copy owned by the web `Record` in `src/lib/finance/bankTestStatus.ts`. root AGENTS.md → "Bank Sync (Fio)" renamed to "Trigger-Owned Columns, One Lock Order, And A Read-Only Probe" and given invariant 3 — a UI-triggered probe is READ-ONLY with respect to every column the D11 status ladder reads: `recordSuccess` is banned (it clears `last_error_code`, which alone ranks the card `ok`, resets the `last_success_at` silence baseline so repeated clicks suppress `invalid` forever, collapses the poller's catch-up window and leaves `coverage_warning` stale — and the probe's 2-day window is not evidence the poller's 14-day window imports, a high-volume club failing `FioTooManyMovements` on 14 days passes the probe), `recordFailure` is banned (it feeds the `>= 3` `invalid` gate and sets `next_attempt_at` up to 24 h out, which `findPollableQuery` filters on, so a Test click can suppress the hourly poller for a day), and the only permitted write is the new narrow `BankSyncConfigRepository.clearPollBackoff` (`next_attempt_at = NULL`) on success; plus the two classification splits that must never be collapsed on a user-facing path — `FioServerError` (HTTP 500 only) vs the new `FioUnreachable`, and `FioSecretKeyMissing` (our misconfiguration, "your token is fine") vs `FioSecretDecryptError` (re-paste the token). server AGENTS.md → "Fio API Client — The Token Is In The URL Path" grew from four constraints to five: rule 4 rewritten for the 500-only dead-token signal (every other non-200 — 502/503/504, 429, anything unknown — is `FioUnreachable`, same as a DNS/TLS/socket failure, and the poller records it as error code `'unreachable'`, not `'fio_error'`, so `isFioError`'s exact `code === 'fio_error'` test keeps it at `sync_failing` instead of escalating to `invalid`), new rule 5 on the `::int` cast the throttle-budget bind parameter needs (`${maxWaitSeconds}` is used only inside `IS NULL` and interval arithmetic, so without the cast every call fails `could not determine data type of parameter $N` at Parse time and `catchSqlErrors` turns it into a defect — 48 tests across poller, backfill and endpoint broke on this), and rule 3 extended with the deliberate divergence between the two copies of the throttle UPSERT (the `maxWaitSeconds` budget guard lives in `FioApiClient` only; do not "fix the drift" by mirroring it into `BankSyncConfigRepository.reserveThrottleSlot`). server AGENTS.md → Postgres Type Conventions: new bullet generalising the Parse-time inference trap to any bind parameter used only in `IS NULL`, interval arithmetic or `||`. web AGENTS.md → Shadcn Components: new "Cancelling a Hardcoded `role` — Use a Real Role, Never `role={undefined}`" — `ui/alert.tsx` hardcodes `role='alert'` before its `{...props}` spread and `biome.json` excludes `components/ui/*.tsx` from lint/format, so the prop override is the only cancel, but `pnpm format` (`biome check --write --unsafe`) deletes `role={undefined}` via `lint/a11y/useValidAriaRole`'s unsafe fix and silently restores the hardcoded role; use `role='presentation'`, and keep the `aria-live` region on the always-mounted parent.)

**Last Updated**: 2026-09-17 (Event-start cron instant made injectable `fix/event-start-cron-injectable-clock`. `applications/server/src/services/EventStartCron.ts` now exports `makeEventStartCronEffect(now: Date)` — ONE instant threaded into BOTH deferred all-day sweeps (`findAllDayEventsPastLastLocalDay(now)`, `findAllDayEventsNeedingStartedPost(now)`), replacing two independent `new Date()` calls — with `eventStartCronEffect = Effect.suspend(() => makeEventStartCronEffect(new Date()))` as the production entry point; the `Effect.suspend` is load-bearing (without it the instant freezes at module load). The flip path (`findEventsToStart`, `startEvent`) deliberately keeps reading the Postgres clock, because `start_at <= NOW()` and the `SET … = now()` arming stamps must agree with EACH OTHER inside one statement. Test-determinism only, ZERO production behaviour change. server AGENTS.md → Testing: "Clock-Derived Time-Of-Day Fixtures Must Be Clamped Into The Local Day" rewritten as "A Cron's Test Fixtures And The Cron Must Share ONE Instant" — the deleted `localTimeOffsetClampedToDay` clamp is replaced by one pinned permanently-past literal (`FIXED_NOW = 2025-10-15T10:00:00.000Z` = 12:00 Europe/Prague) feeding both the cron and every fixture as a SQL bind parameter, never `SELECT now()`; the diagnosis is restated as two INSTANTS, not two clocks (true whatever the second sample's source), so the old "≥ 1 minute offsets / ≥ 5-second guard band" rule is gone; the one-sided-`if`-guard rule is KEPT VERBATIM (now trivially satisfiable — case 8b dropped its guard band); new rules forbid letting a boundary case fall through to a `COALESCE(<column>, <literal>)` default (a bare `UPDATE team_settings … WHERE team_id = …` affects ZERO rows when `setTeamTimezone` never created the row) and forbid `effect/testing/TestClock` in DB-backed integration tests (`SqlSchema`-ahead-of-`Effect.sleep` deadlock, reproduced at `test/integration/services/BankSyncPoller.test.ts:536-546` and `test/integration/services/FioApiClient.test.ts:312-326`; plus `@effect/vitest`'s `it.effect` auto-provides a `TestClock` at epoch 0, which is why injection beat `Clock`). Cron Jobs table: the `EventStartCron` row records the two deliberate clock sources. "Idempotent Counter Increment Folded Into the `active`→`started` Status Flip" gains rule 4: `findStartable` (`src/repositories/EventsRepository.ts:330-337`) has NO lower bound on `start_at`, the only reason a 2025 `FIXED_NOW` can coexist with a real current DB clock — adding one breaks every case in `test/integration/services/EventStartCron.deferred.test.ts`, which also gained regression groups I1-I10: team-local-midnight boundary and Prague DST fall-back fold, for both deferred sweeps.)

**Last Updated**: 2026-09-17 (Expired date fixture in `eventAllDayAnchor.test.ts` case 9 `fix/event-anchor-test-expired-fixture`. root AGENTS.md → Testing: new "Date Fixtures On Now-Gated Paths Expire" — a date literal on a path that reads the clock (`DateTime.nowUnsafe()`, `new Date()`, `Date.now()`, SQL `now()`) has a silent expiry date and fails naming the wrong subsystem; relative-property cases derive the date from the clock, literal-instant cases keep a fixed date at least three years out and roll it forward; assert the documented success status of every request whose body a later assertion reads. server AGENTS.md → Testing: new sibling section "A Date Fixture On A Now-Gated Path Has A Silent Expiry Date", cross-referenced with the existing "Clock-Derived Time-Of-Day Fixtures Must Be Clamped Into The Local Day" — tabulates the six event surfaces that consult `now` (`updateEvent`, `cancelEvent`, `submitRsvp`, `Event/SubmitRsvp`, and the `canEdit`/`canCancel`/`canRsvp` flags on `getEvent`/`getRsvps`/`Event/GetRsvpCounts`), and records that `createEvent` reads NO clock — so the create-only cases 1–5, 7 and 13 keep their past 2026 literals on purpose and must NOT be rolled forward, while the 2030 literals in cases 6, 8, 10, 11 and 12 are deferred expiries that die on 2030-07-16 Europe/Prague.)

**Last Updated**: 2026-09-16 (Fio bank transaction matching `feat/fio-transaction-matching`. New bank-sync subsystem: `bank_transactions` + `bank_sync_config` + `payments.bank_transaction_id`, an hourly `BankSyncPoller`, `BankTransactionMatcher`, CSV/PDF export, SPAYD QR. root AGENTS.md → Architecture: new "Bank Sync (Fio) — Trigger-Owned Columns And One Lock Order" — `payments_finance_recompute` (migration `1792000002`) REPLACED `payments_recompute_paid_minor` and now owns `fee_assignments.paid_minor` AND the payment-derived `bank_transactions.match_state` (app code may only set the human terminal states `ignored`/`not_applicable`, always guarded by `WHERE match_state IN (…)`), and stamps `auto_match_suppressed` on any active→voided payment transition, which is what stops the poller re-creating a deliberately reversed payment — including via the bank-unaware `voidPayment` endpoint; plus the canonical money-write lock order `payments` → `bank_transactions` → `fee_assignments`, each by `id ASC`, whose violation is a `40P01` surfacing as an untyped `SqlError`. root AGENTS.md also gained (authored separately): the `CREATE OR REPLACE FUNCTION` arity-overload trap under Migration IDs, "A Backtick Inside a SQL Template Literal Ends the String", and "`vi.stubGlobal('URL', …)` Breaks Vitest's Module Loader". server AGENTS.md: new "Fio API Client — The Token Is In The URL Path" (`HttpClient.TracerDisabledWhen` must be provided via `HttpClient.transform` on the client VALUE — the ref is read at execute time from the caller's fiber, so a construction-layer `Layer.provide` is silently ignored and the token lands in `url.full`; `TransportError` is nested inside `HttpClientError` so only `catchTag('HttpClientError')` + `catchCause` contains it, and the body decode must sit inside that boundary; the 30 s per-token throttle lives in SQL (`fio_token_throttle`) and returns a duration, never a timestamp, and must never run inside `sql.withTransaction`; a dead token returns a bodyless 500 with no 401/403, so 5xx is NEVER retried) and "PDF Fonts Must Be Vendored — pdfkit Corrupts Czech Silently" (WinAnsi renders `á é í ó ú ý š ž` but emits a malformed token for `č ď ě ň ř ť ů` and desynchronises the rest of the string with no exception, so a smoke test on the first set passes against a garbage document; vendored Noto Sans TTFs + `scripts/copy-assets.mjs` + `scripts/assert-dist.mjs`, because `tsc` does not copy `.ttf` and `node:25-slim` ships no fonts); plus rule 5 under "Consistent `FOR UPDATE` Lock Ordering" — locks a trigger takes on your behalf still count, so order the driving SELECT by the column the trigger will lock on (`unmatch` voids `ORDER BY fee_assignment_id ASC`, not by payment id). domain AGENTS.md → Pure Algorithm Modules: added `CzIban.ts` / `CzIco.ts` / `Spayd.ts` as reference implementations (imported by server, bot and web, which is why no second copy lives in `web/src/lib/finance/`) and rule 6 — checksum/wire-format modules must pin externally verified vectors and record their provenance, because vendor-published sample identifiers are routinely anonymised with un-recomputed check digits and fail their own checksum. web AGENTS.md: closed-union rule 5 — the icon/shape `Record`s keyed off a wire union are governed by the same exhaustiveness rule as the copy `Record` (`src/lib/finance/matchReasons.ts`, three parallel closed maps over the nine `BankTransaction.BankTransactionMatchReason` literals), and a carve-out in "Pure Helpers" rule 2 for closed-union lookup tables. bot AGENTS.md: the Bank Token Expiry section now describes a complete loop — `BankTokenExpiryCron` (daily, `0 4 * * *`) emits into `bank_token_expiry_events` at T-14/T-7/T-1 derived from `fio_token_created_at + 180 days`, writes `bank_token_expiry_sent` itself (the bot has no sent-ack for this family, unlike payment reminders), and an already-expired token stops firing because the day-difference equals a threshold exactly once as time moves forward.)

**Last Updated**: 2026-09-15 (Group Discord channel role on late/manual join `fix/group-channel-discord-join`. root AGENTS.md → Effect-TS Patterns: new rule 8 — a callee's `E = never` is NOT a promise it cannot abort your chain, because `catchSqlErrors` DIES rather than fails; any auxiliary step spliced into an existing chain (self-heal, backfill emit, best-effort notification) MUST be wrapped in `Effect.catchCause` + `logWarning` at the call site. server AGENTS.md → "`Guild/RegisterMember` and Welcome Metadata" rule 6 (added by the implementer) gained three sub-rules: keep the `catchCause` wrap on `emitMemberGroupChannelRoles`; `MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER = 25` is PERMANENTLY lossy (fires once on join, never re-derived) so `findActiveGroupsWithAncestorsForMember`'s `ORDER BY min(depth), name, id` must stay; `boundGroupIds` is now a functional `alreadyEmittedGroupIds` argument (duplicate-row suppression), which rule 2 previously called type-level-only. "Effective Roles Are Derived In Exactly One Place" rule 3: `findActiveGroupsWithAncestorsForMember` is now the FOURTH walk that must sever identically, and a new walk must ship an integration test ASSERTING set-equality with an existing walk, not just a header comment. Accuracy fixes: `teams.guild_id` is `NOT NULL` + `UNIQUE`, so `emitIfGuildLinked`'s `None` branch means the team ROW IS ABSENT, never "team exists but is unlinked" — the three backfill intros (server ×2, bot ×1) that blamed role-less groups/members on "created before the guild was linked" now blame unprocessed/permanently-failed events; and the roster backfill button invokes its endpoint ONCE per click (`RostersListPage.tsx:46-75`), it does not loop while `remainingCount > 0`.)

**Last Updated**: 2026-09-14 (Read-only in-app AI assistant `feat/ai-app-interaction`. domain: new `AiChatApi` contract (`GET/POST /teams/:teamId/ai/*`). root AGENTS.md → Effect-TS Patterns: new "Stateful Loops — `Effect.suspend` Self-Recursion" (`Effect.iterate`/`Effect.loop` do not exist in `effect@4.0.0-beta.40`, and `Effect.whileLoop` returns `Effect<void>` and cannot carry an accumulator — `node_modules/effect/dist/Effect.d.ts:1249`); Error Handling rule 7 — only `Effect.catchCause` EARNS an `E = never` signature (`catchTag` does not catch defects), re-raise an interruption-only cause with `Effect.failCause`. server AGENTS.md: new "Read-Only AI Assistant: `LlmClient` Transport vs `ChatAgent` Loop" — `LlmClient` is the config-gated transport (`chatWithTools`, `configured`, no app imports), `ChatAgent` owns iteration/dispatch/budgets/tokens/degradation, `src/api/ai-chat.ts` owns authz/kill-switch/rate-limit — plus subsections on the `Effect.suspend` loop, deriving tool parameter JSON Schemas (`Schema.toJsonSchemaDocument(schema, { additionalProperties: false })`, `Schema.Number` banned, empty-`Struct` `anyOf` collapse), two-layer permission enforcement (`visibleTools` is UX, each executor re-check is the boundary; a tool's gate must match the equivalent HTTP endpoint's gate), opaque per-turn reference tokens (never positional), and config-gated degradation (200 + `generated: false` + closed `degradedReason`). server AGENTS.md fixes: "HttpApi Mock-Layer Cascade" now says `grep -rl ApiLive applications/server/test` (the previously documented `Layer.provide(ApiLive)` / `Layer.provideMerge(ApiLive)` greps return zero matches); "`Schema.Class` Is Nominal" gained rule 5 — `Schema.Union` member selection is nominal too, so union-typed test fixtures must construct the real class. domain AGENTS.md: new "Degradable Endpoints: 200 + `generated: false` + A Closed `Reason` Union" and "Model-Cited Entities Ship As A Typed `EntityRef` Union". web AGENTS.md fixes/additions: the Forms section mandated `effectTsResolver`, which has ZERO usages in this repo — corrected to `standardSchemaResolver(Schema.toStandardSchemaV1(...))`, the convention at all 22 real call sites; new "Closed-Union Copy Comes From An Explicit `Record`, Never A Computed Key" and "AI Assistant Client Rules — `src/lib/assistant/`".)

**Last Updated**: 2026-09-14 (Group roles never reach Discord `fix/group-roles-never-reach-discord`. `applications/server/AGENTS.md` → "`Guild/RegisterMember` and Welcome Metadata": rewrote step 5 — the group bind now also emits `member_added` channel-sync events for the group and its active ancestors (via the new `applyInviteGroup`), not just a bare `group_members` insert, so the bot grants the group's own Discord role instead of relying on the reconcile diff (which reads `discord_role_mappings`, not `discord_channel_mappings`, so it could never cover a group's own auto-created role). Added five rules: every group-add must write `group_members` AND emit `member_added` for the group and its active ancestors (exactly two exceptions: `setupNewMember`'s mapping-derived add, and `joinViaInvite`'s bind, which targets a user not yet in the guild); every write that changes effective roles must be bound above `reconcile` (`boundGroupIds` destructure makes reordering a compile error); ancestor walks driving Discord writes must use `getActiveAncestors`, never the archived-blind `getAncestors`/`findAncestors` (still owed by `deactivateMemberCascade.ts:156`, `api/group.ts:490`); a liveness check on a group reached from `team_invites` must go through `groups.findGroupById`, not the invite row, since `findByCode` does not join `groups`; and `GuildsRpcLive`'s top-level `Effect.Do.pipe` is already at 19 of the `Pipeable` overloads' 20-argument ceiling, so a newly-needed repository must be resolved inline with `.asEffect()` inside the function that needs it rather than appended as a 20th/21st top-level bind. Also recorded: the role diff is bot-version-gated (`payload.source: None`, i.e. a pre-PR-8 bot, skips `observeGuildMembership` entirely) and nothing in `registerMemberWithReconcile` is transactional — the group insert, the `channel_sync_events` insert, the `role_sync_events` inserts, and `markDiscordJoined` are four independent commits. Also updated, outside that section: "Invite Endpoints" — the `joinViaInvite` row now states the group bind, plus three rules for it (`findGroupById` is the liveness check, never the invite row; emit nothing to Discord because the member is not in the guild yet; no third write in that `Effect.tap` chain without a transaction). Sync Event Pattern rule 4 gained an explicit scope: it covers writes that NARROW Discord state, and must NOT be read as licence to skip an emit because an idempotent `INSERT ... ON CONFLICT DO NOTHING` reported no change — the row existing does not mean the Discord grant happened. "Effective Roles Are Derived In Exactly One Place" rule 3's must-agree set gained `GroupsRepository.findActiveAncestors` (three walks now, not two) and a general rule: a query whose semantics must match another's must name that other query in its own header comment at BOTH sites (`effectiveRoles.ts` ↔ `findDescendantMembersWithDiscordIdQuery` still owe each other that comment). Depth-guard inventory gained `findActiveAncestors` to the guarded list. Testing gained rule 4: a mock for a repository method whose result is defined by production SQL must model ONLY the property under test and never re-implement the query, must comment what it does NOT model and which integration test covers the real semantics (reference: the deliberately flat `groupRoles` map in `test/rpc/RegisterMember.test.ts`); any assertion about a query's real semantics belongs in `test/integration/`. Root AGENTS.md: the integration-test tree listing was stale (claimed `repositories/` only) and now lists all six subdirectories including `rpc/`, with a pointer to that new Testing rule. No bot/domain/migrations changes — the bot's `handleMemberAdded` contract is unchanged; only the rate at which its self-healing `createRoleOnly` branch is reached went up, and the archived-ancestor hazard that creates is documented server-side at the emit site. No `.claude/` changes — the workflow did not change.)

**Last Updated**: 2026-09-13 (Group-inherited role linking `fix/role-linking`. server AGENTS.md: new SQL-pattern section "Effective Roles Are Derived In Exactly One Place (`effectiveRoles.ts`)" — `member_roles` ∪ (`group_members` → recursive `groups.parent_id` ancestor walk → `role_groups`) now lives in one `sql.unsafe`-spliced fragment (`effectiveRolesFrom` / `effectiveRoleNamesAgg` / `effectivePermissionsAgg` / `effectiveRolesAggLateral`), following the `eventVisibility.ts` precedent; covers the `JOIN LATERAL ... ON true` requirement for a correlated derived table, the one-materialization lateral over N scalar subqueries, the deliberate "archiving a group severs inheritance" semantics (filter inside the RECURSIVE TERM, so it agrees with `findDescendantMembersWithDiscordIdByGroupId`), and the `string_agg(DISTINCT x ORDER BY y)` constraint. New section "Recursive `groups.parent_id` Walks Must Carry a `depth < 32` Guard" (no DB acyclicity constraint + TOCTOU `moveGroup` check = constructible cycle) listing which walks are guarded today. "Does member hold permission X" section rewritten to mandate the shared fragment instead of a hand-copied direct+group `EXISTS` pair. New section "Authorization Decisions Must Read a Membership Query, Never a Roster DTO" (the last-admin guard read `permissions` off a group-blind display DTO and silently skipped). Sync Event Pattern gained rules 4 and 5: never emit for a delete that changed nothing the bot mirrors (`unassignRole` re-checks effective roles post-delete), and a post-write re-check must `Effect.catchDefect` so it can't fail the committed write. "Cross-Tenant Resource Lookups" rule 6: payload-referenced ids need the same team check as path ids, with their own `<Resource>NotFound` tag (`GroupApi.RoleNotFound`). web AGENTS.md: new "Interactive Triggers: `Badge` Is a `<span>`, Tooltips Do Not Open On Touch" under Shadcn Components; new "Effective Roles In The UI — `src/lib/roles/`" (`resolveEffectiveRoles` + `sortEffectiveRoles`, inherited roles get a forward-to-group link instead of a remove control, assign-select filtered by `roleId`); `src/lib/` table row for `src/lib/roles/`; Pure-Helpers rule 2 now permits `getLocale()` solely for `Intl`/`localeCompare`; testing section notes the `window.matchMedia` polyfill in `test/setup.ts`.)

**Last Updated**: 2026-09-13 (Training notifications `fix/training-notifications`. server AGENTS.md → "Before/After State Detection in Upsert Handlers" rewritten: the snippet had drifted from production (it showed a separate `Effect.bind('priorRsvp', …)` read, but `upsertRsvp` returns the prior value from a CTE in the same `INSERT … ON CONFLICT` statement — `EventRsvpsRepository.ts`), and it now also documents deriving TWO booleans from one prior-state read when a single flag is serving two consumers with different needs: `isLateRsvp` (wide — drives the ephemeral hint) vs `isLateRsvpChange` (narrow — gates the late-RSVP channel post). Recorded the rollout trade-off behind that split: gating an EXISTING result field (returning `Option.none()` for the channel id) rather than adding a new one to the RPC result lets a behaviour fix take effect on the server deploy alone, with no `Schema.withDecodingDefaultKey` and no window where old bot pods still act on the old rule — worth preferring whenever the narrowing can be expressed as withholding something the client already treats as optional. bot AGENTS.md: `handleStarted.ts` posts nothing and only deletes the training claim message; `event_started` no longer carries post/coach-mention logic; dropped `handleRsvpReminder.ts` from the `formatNameWithMention` consumer list; the `rsvp_reminder` handler now DMs non-responders only (reminder-channel summary embed removed, only `summary.nonResponders` consumed, guild-link fallback when no channel resolves); new "Late-RSVP notice" subsection documents the `!counts.isLateRsvp || Option.isNone(counts.lateRsvpChannelId)` guard and why `isLateRsvp` must stay wide. domain AGENTS.md: new Schema Patterns bullet "Tightening a side-effect rule WITHOUT touching the schema" for the withhold-an-existing-optional-field rollout technique.)

**Last Updated**: 2026-08-25 (Rules Trainer package `feat/rules-trainer`. New workspace package `packages/rules` (`@sideline/rules`) — WFDF Rules of Ultimate trainer content (nine scenario JSON packages, 109 scenarios) plus a pure scoring/animation engine, with three subpath exports (`.`, `./content`, `./reference`). Its own conventions live in `packages/rules/AGENTS.md` and are deliberately NOT duplicated here. root AGENTS.md → Architecture: added the `rules/` row; Path Aliases: added `@sideline/rules`; new "Effect-free Packages" subsection under Package Structure Conventions — `packages/template-renderer` and `packages/rules` are deliberately Effect-free because their exports are called synchronously from React render (no `effect`/`@effect/*` dependency at all, pure synchronous exports, plain `vitest` instead of `@effect/vitest`), and any future package called from React render must be added to that table plus a `## Constraints` section in its own AGENTS.md; new "Shipping JSON Assets From a Package" subsection — (1) every JSON import, static or dynamic, needs `with { type: 'json' }`, with no compile error when it is missing and `ERR_IMPORT_ATTRIBUTE_MISSING` thrown at runtime under `module: NodeNext` (i.e. on app boot, not in CI's `pnpm check`), (2) `resolveJsonModule: true` alone is not enough under this repo's composite/project-references layout — the JSON must also be matched by the project's `include` (`"include": ["src", "src/**/*.json"]`) or `tsc -b` fails with `TS6307`, (3) `tsc -b` trusts `.tsbuildinfo` and will not re-copy JSON it thinks is unchanged, so `pnpm build` can exit 0 with an empty `dist/` — guard it with a `postbuild` script that asserts the files exist AND `import()`s the built barrel for real, ref `packages/rules/scripts/assert-dist.mjs`; Biome.js: recorded that `overrides` REPLACE the matched rule rather than merging with the base rule, so adding a per-path override silently disables the rule's other options there — a new web-only banned import must go into the existing `applications/web/**` `style/noRestrictedImports` override in `biome.json` (now carrying both `@sideline/i18n/messages` and `@sideline/rules/content`), never a second override entry; Troubleshooting: added "Build exits 0 but `dist/` is missing JSON assets". `applications/web/AGENTS.md` → `tr()`-only rule 1: noted that the web-scoped override re-declares both banned paths and why dropping either silently unbans it. `.claude/agents/tester.md`: the `it.effect`/`@effect/vitest` rule now carries an explicit exception for `packages/rules` and `packages/template-renderer` (plain `vitest`). `.claude/agents/meta.md`: added the missing `packages/rules/AGENTS.md` and `packages/template-renderer/AGENTS.md` rows to the AGENTS.md routing table. No skill, and no other agent, referenced trainer content or per-package test commands. Prior entry: RSVP "coming later" `feat/rsvp-coming-later`. Documented the **wire-value projection** pattern for expanding a stored enum with a new value across two releases — the mirror of the existing expand/contract *removal* pattern. `packages/domain/AGENTS.md` → Schema Patterns: added "Introducing a new value into a stored enum that can't yet go on the wire (expand/contract addition — wire-value projection)": keep every wire-facing read DTO pinned to the legacy `Schema.Literals([...])` set (local `const Legacy<Name>`, precedents `EventRsvpApi.ts` `LegacyRsvpResponse`, `UpcomingEventForUserEntry.my_response`) while the stored-model schema (`EventRsvp.RsvpResponse`) carries the full set; server projects the new value down at the read boundary; un-pin + delete projection in Release B — plus the sub-rule to add a NEW additive field decoded with `Schema.OptionFromOptionalKey(<FullEnum>)` when one consumer needs the TRUE value on a shared schema (`UpcomingEventForUserEntry.my_response_actual`, bot-only). `applications/server/AGENTS.md` → new "Wire-value projection & effective-value guards" subsection: (1) route every stored→wire mapping through `src/utils/rsvpWireProjection.ts` `projectRsvpResponseToLegacy` (and mirror it in SQL `CASE WHEN`), fold new-value counts into legacy buckets in SQL, use `src/utils/rsvpAttendance.ts` `isAttendingRsvpResponse` over bare `=== 'yes'`; (2) validate a COALESCE-based partial upsert against the EFFECTIVE post-COALESCE value, not the raw payload — fetch the prior row and pass submitted + prior to `src/utils/rsvpMessageRequired.ts` `isRsvpMessageRequiredAndMissing`. `packages/migrations/AGENTS.md` → Updating CHECK Constraints: added "Rolling-deploy-safe enum widening" — widen the CHECK to a permissive superset (keep legacy + new value) with `DROP CONSTRAINT IF EXISTS`, do NOT rewrite historical rows this release (defer to Release B), ref `1790300016_rename_rsvp_maybe_to_coming_later.ts`. No `.claude/` agent or skill references RSVP behaviour — none needed updating. Prior entry: Remove finished events from personal channels `fix/remove-finished-events-from-personal-channels`. Corrected stale schema guidance: `Schema.optionalWith` does NOT exist in the pinned `effect@4.0.0-beta.40` — removed it from the "Never use `Schema.optional`" rule in root AGENTS.md + `packages/domain/AGENTS.md`, and documented `Schema.<Type>.pipe(Schema.withDecodingDefaultKey(() => <default>))` as the additive, wire-compatible idiom for a new model field with a plain-value default (precedents `EventEmbedInfo.status`, `EventApi.ts:164` `allDay`, `GuildRpcGroup.ts:25`). `applications/bot/AGENTS.md` → Personal Events Sync reconcile step 3: gate the global shared message refresh on `EventEmbedInfo.status === 'active'` — started/cancelled events' global message is owned by `handleStarted`/`handleCancelled`, so reconcile skips it (per-member personal messages in step 1 still refresh). `applications/server/AGENTS.md` → `events.personal_messages_dirty_at` marker: added the `active`→`started` flip as a mark-dirty call site (marks before Discord resolution so a Discord failure can't lose it) and documented the once-per-cycle self-healing `markStalePersonalMessagesDirty()` sweep in `EventStartCron` (re-marks non-active/past events still holding `personal_event_messages` rows; self-terminating). Prior entry: MajNet `/healthz` + `/info` standard endpoints `feat/majnet-healthz-info`. root AGENTS.md → "App Version (`APP_VERSION`)": resolved the prior "version may lag the release tag" follow-up — rewrote rule 4 to describe the actual mechanism (`version.ts` prefers `process.env.APP_VERSION`, baked from the release tag by the reusable MajNet `app-release.yaml` (ADR 0020) via the `VERSION` Docker build-arg → `ENV APP_VERSION=$VERSION` alongside `GIT_COMMIT`/`BUILD_TIME`, and falls back to the frozen `package.json` version for Node apps / injected `VITE_APP_VERSION` for Vite apps; never hard-code); added the env-first prelude note to rule 1 and to the Server/Bot source-of-truth table rows. applications/docs/AGENTS.md → "Docker / deployment": rewrote the healthcheck bullet — nginx now serves `/healthz` + legacy `/health` (`{"status":"ok"}`) and `/info` (`{version,commit,build_time}` from `APP_VERSION`/`GIT_COMMIT`/`BUILD_TIME`) via `nginx.conf.template` (envsubst at container start), documenting the MajNet convention (every app serves `/healthz` + `/info`; `/health` is legacy-compat, never remove). No new sections created; server/bot/web AGENTS.md have no existing health-server/deployment section, so were left untouched. Prior entry: Bot roles carry no global permissions `fix/bot-roles-no-global-permissions`. bot AGENTS.md → "Role Sync": added a rule that every bot-created Discord role MUST pass `permissions: 0` to `rest.createGuildRole` (dfx types `permissions` as a `number`, so pass the numeric literal `0`) — access is granted exclusively via channel permission overwrites, never via global guild-role permissions; enumerated the five call sites (`src/rest/roles/createGuildRole.ts`, `src/rest/channels/createRoleOnly.ts`, `createRoleForChannel.ts`, `createChannelWithRole.ts`, `src/rcp/roleProvision/handleProvisionRole.ts`) and required each `createGuildRole` handler test to assert `restCalls.createGuildRole[0]?.[1]` `toMatchObject({ permissions: 0 })`. No other AGENTS.md affected. Prior entry: Drop Changesets, adopt MajNet releases `chore/drop-changesets-majnet-releases`. root AGENTS.md: replaced the "Changesets" tooling bullet with "MajNet releases" (repo-wide `vX.Y.Z` git tag → `ghcr.io/sideline-cz/sideline/<app>:vX.Y.Z` images for every app; merges to `main` publish `sha-…`/`latest` to the `testing` class, tags auto-track into `stable`, promote to `production` via an admin-gated render PR — see `/deploy`); rewrote workflow step 5 (no changeset — a release is cut post-merge by tagging `main`); dropped the `changeset →` segment from the `/ship` skill-table row to match the rewritten `.claude/skills/ship/SKILL.md` (`/docs → checks → commit → push → PR → CI → code review → /revise`); replaced the "Version Management" section + `pnpm changeset*` commands + "Changeset Bump Rules" with a "Releases" section (tag `vX.Y.Z` → stable, promote → production, authoritative flow in `.claude/skills/deploy/SKILL.md` + `.github/workflows/release.yaml`); rewrote `APP_VERSION` rule 4 — `package.json` versions are now frozen (no auto-bump), so the displayed `APP_VERSION` may lag the release tag until version stamping is wired to the tag (flagged as a known follow-up, no invented mechanism). No other AGENTS.md referenced Changesets. Prior entry: Carpool route-notes `feat/carpool-route-notes`, bot modal-open interactions — bot AGENTS.md → added "A `MODAL` Response Cannot Be Deferred — Prefill Fetches Run Synchronously With an Empty-Modal Fallback": a `MODAL` response cannot be deferred/forked (the 3-Second Ack fork rule does NOT apply to modal-open buttons), so a button that opens a prefilled modal fetches state with ONE lean RPC (`Carpool/GetCarNote` returns just the `Option<string>` note, not the whole view), falls back to an empty modal on failure via `Effect.catchTag('RpcClientError', () => Effect.succeed(Option.none()))`, and spreads the `UI.textInput` `value` only when `Option.isSome`; the paired modal *submit* still uses the deferred-fork-`withBackstop` shape because a submit response CAN be deferred (ref `CarpoolNoteButton`/`CarpoolNoteModal` in `src/interactions/carpool.ts`). Prior increment (`fix/code-quality-bot-casts-effect-errors`), bot Discord-error handling — mapped raw dfx REST errors into semantic tagged Effect errors and eliminated `as Record`/`as number` casts. bot AGENTS.md → "Classifying a One-Off Discord REST Error": prefer mapping dfx transport failures (`DISCORD_REST_ERROR_TAGS`) to tagged `DiscordPermissionError`/`DiscordNotFoundError`/`DiscordPermanentError`/`DiscordTransientError` via `failAsDiscordError` (leaf REST call) or `Effect.mapError(toDiscordError)` (`unknown`/mixed channel), then branch with `Effect.catchTag` — never re-inline the `403`/`50013` check; the boolean predicates (`isDiscordPermissionError`/`isDiscordNotFoundError`/`isPermanentError`) stay for retry `while`/`catchIf` predicates and layered handlers (sudo); all `unknown`-shape probing (`isRecord`/`asRecord`/`numberProp`) lives in `~/rest/recordProbe.ts`, never a hand-rolled `value as Record` cast (refs `src/rest/discordErrors.ts`, `src/rest/recordProbe.ts`, `commands/summon`, `commands/summarize`, `interactions/carpool`, `rcp/channel/ProcessorService.ts`, `Bot.ts`). Prior increment (`fix/code-quality-eliminate-casts-dry-effect-errors`, server-only) — eliminated `as` casts by fixing underlying types. server AGENTS.md → Database & SQL Patterns: added "Branding raw boundary values (`Schema.decodeSync`, never `as`)" — convert a raw `string`/`number` at a repo/RPC-handler boundary to a branded domain type with `Schema.decodeSync(<Brand>)(value)` (validates + throws) instead of an `as <Brand>` cast; hoist a reused decoder to a module-level `const toTeamMemberId = Schema.decodeSync(TeamMember.TeamMemberId)`; prefer branding the row/read `Schema.Class` column directly (`created_by: TeamMember.TeamMemberId`) so no downstream conversion is needed, and let a `NumberFromString`-branch branded schema (`Expense.AmountMinor`) decode a raw BIGINT-as-string column in one step instead of `Number()`-then-cast (refs `ExpensesRepository`, `FeesRepository`, `TeamChallengeRepository`, `src/rpc/guild/index.ts`, `src/rpc/personalEvents/index.ts`). Added "Partial-update patches: `Option<Option<A>>` fields and `nestedOptionToNullable`" — a nullable PATCH field decodes to `Option<Option<A>>` (outer = present-in-patch, inner = value-or-null); bind it in a hand-written `UPDATE ... SET col = CASE WHEN ${Option.isSome(...)} THEN ${nestedOptionToNullable(patch.field)} ELSE col END` using the new shared helper `src/repositories/patchHelpers.ts` (`nestedOptionToNullable` collapses to `A | null`; the `CASE WHEN` guard, not the bind, is what protects the column when the field is absent), refs `FeesRepository.update`, `FeeAssignmentsRepository.update`.)
**Last Updated**: 2026-07-01 (Deactivate member on Discord leave. domain: new `Guild/RemoveMember` RPC (`GuildRpcGroup.ts`, payload `{ guild_id, discord_id }`). server AGENTS.md: added "Member Deactivation Cascade — One Chokepoint" — every deactivation path (roster `deactivateMember` HTTP handler + `Guild/RemoveMember` RPC) MUST go through `deactivateMemberAndCascade` (`src/utils/deactivateMemberCascade.ts`), which runs the ordered cascade in one `sql.withTransaction`: `pg_advisory_xact_lock(hashtext(teamId))` first, re-read (already-inactive → no-op), owner guard (`hasOtherActiveManager`; last `team:manage` holder → `last_admin`, never deactivated), capture roster+group ids, emit `member_removed` events (incl. ancestor groups), deactivate row, HARD-DELETE `group_members` + `roster_members`; result is `{ deactivated } | { deactivated:false, reason:'already_inactive'|'last_admin' }`, callers map `last_admin` to their own error (roster → `Roster.Forbidden`), reactivation does NOT restore group/roster memberships (blank-slate, intentional). Added "Per-Team Advisory Lock Guarding an Invariant Check" — any transaction whose correctness depends on a per-team "count of rows satisfying X" check a concurrent tx could invalidate MUST take `pg_advisory_xact_lock(hashtext(teamId))` before the check. Added "'Does member hold permission X' Checks Must Mirror `findMembershipByIds`" — such queries MUST check BOTH the direct (`member_roles`) AND group-inherited (`group_members` → ancestor groups → `role_groups`) permission paths; a narrower check silently mis-guards (reference `hasOtherActiveManager`). Updated the personal-events de-provision bullets: `_getGuildsNeedingProvisioning` gains a fourth UNION branch (d) for inactive members still holding a channel, and `Guild/GetPersonalChannelsToDeprovision` now ALWAYS runs `getInactiveMembersToDeprovision` (merged+deduped by `team_member_id`) regardless of group config — no more short-circuit-to-`[]` on `Option.none()` group id. Added `Guild/RemoveMember` subsection under RPC Transport. bot AGENTS.md: added "`guildMemberRemove` — Leave Counterpart of `RegisterMember`" (`src/events/index.ts`, calls `Guild/RemoveMember`, skips bots, catches `RpcClientError`) and "Decode Gateway Payloads Inside the Effect, Never in the Dispatch Callback" — a handler that must LOG a decode failure decodes with `Schema.decodeEffect(...)` bound inside `Effect.Do.pipe` + `Effect.catchTag('SchemaError', ...)` (mapped to warning + `Option.none()`), NOT synchronous `Schema.decodeUnknownOption` (which is reserved for silently-skipped payloads like non-syncable channel types). Earlier entry: Admin `/sudo` command. bot AGENTS.md: extended "Admin-Gating" from two to THREE mechanisms — added option C "top-level command gated at RUNTIME via `Guild/CheckTeamAdmin`, NO `default_member_permissions`" for commands that must stay visible to Sideline admins who lack the Discord-native permission (reference `/sudo`, `src/commands/sudo/`, which grants a Discord Administrator role so a native gate would hide it from exactly the admins who need it); added a decision table and rule 3 requiring the authorization decision to live server-side in `Guild/CheckTeamAdmin` (`{ is_admin }`) with the bot only branching on `is_admin`, every deny path replying a localized ephemeral, and BOTH the command and its `sudo-leave:` button (`src/interactions/sudo.ts`) re-checking `Guild/CheckTeamAdmin` before acting (a component interaction mutating admin-only state MUST re-authorize the clicker). Added "Classifying a One-Off Discord REST Error (`~/rest/discordErrors.ts`)" subsection under the REST retry pattern — the shared `isDiscordPermissionError` (HTTP 403 / code 50013) and `isDiscordNotFoundError` (HTTP 404 / code 10011/10013) predicates for classifying a SINGLE `ErrorResponse` in a command/component handler (distinct from the channel-sync `isPermanentError` split); prefer this module over re-inlining the classifier; pre-existing inline copies in `src/commands/summon/handler.ts`, `src/commands/summarize/handler.ts`, `src/interactions/carpool.ts` predate the extraction and should migrate when next touched — never add a fourth inline copy. NOTE: `Guild/CheckTeamAdmin` (new RPC in `packages/domain` + handler in `applications/server`, resolves membership then `permissions.includes('team:manage')`) follows existing RPC patterns exactly (sibling of the `is_admin`-returning `Guild/IdentifyEventsChannel`) — no server/domain AGENTS.md change neededbot AGENTS.md: corrected the `buildUpcomingEventEmbed` "Single-event ephemeral messages (upcoming events)" layout — it now returns TWO always-rendered action rows, not "a single action row"; Row 1 is Yes/No/Maybe RSVP buttons and Row 2 always starts with the Attendees button (`attendees:{team_id}:{event_id}:0`) followed, only when the user has responded, by the add-message (`u-add-msg:…`) or edit+clear-message (`u-add-msg:…` + `u-clear-msg:…`) buttons; the Attendees button moved from Row 1 into Row 2, and Row 2 no longer conditionally renders. Earlier entry: Personal-events PR #449 revision pass. server AGENTS.md: corrected "Channel classification for `/event refresh`" — `Guild/IdentifyEventsChannel` now returns `owner_discord_id: Option<Snowflake>` and classifies a `personal` channel by CHANNEL ID alone via `findPersonalChannelOwner(teamId, channelId)` (NOT the old caller-scoped `findOwnedPersonalChannel`); the server reports the owner + `is_admin` but makes NO own-vs-other decision — that gate moved to the bot. Made the `events.personal_messages_dirty_at` "set it on every change" bullet EXHAUSTIVE: single-event create/update/cancel (`src/api/event.ts`), RSVP submit, event-SERIES create/update/cancel (`src/api/event-series.ts`, marks each fanned-out event id in the `{concurrency:1}` loop — no series-level marker), and RPC-driven event writes (`src/rpc/event/index.ts`); always best-effort. bot AGENTS.md: rewrote "Slash Commands" rule 2 to spell out the PER-SURFACE runtime gate for the everyone-visible `/event refresh` subcommand — own personal channel → anyone; another member's → admins only (acting with the owner's identity from `owner_discord_id`/`team_member_id`); global → admins only; never collapse back to a flat `!is_admin → forbidden`. Corrected Pass 1a rule 4: the personal-channel category-full overflow branch keys on Discord JSON code `30013` ONLY (max channels in category), NOT HTTP 403 — `50013` Missing Access also surfaces as 403 and MUST propagate, so never widen the trigger back to `403`. Earlier entry: Personal-events extension: group restriction, de-provision, per-channel reorder, ping-free mention. server AGENTS.md: under "Personal event tables and reserve-first provisioning" added two subsections — "Group restriction (`team_settings.discord_personal_events_group_id`)" (nullable UUID FK, migration `1790300010`; both `_getMembersNeeding` (`EXISTS`) and `_getMembersToDeprovision` (`NOT EXISTS`) eligibility queries reuse the same `WITH RECURSIVE descendant_groups` CTE; `Guild/GetGuildsNeedingPersonalProvisioning` surfaces a guild when EITHER a member is missing a channel OR a channel-holder fell outside the group; `Guild/GetPersonalChannelsToDeprovision` returns `[]` when no group is set; `deletePersonalChannel` clears `personal_event_messages` BEFORE the channel row) and "Channel-name format (`team_settings.discord_personal_events_channel_format`)" (`TEXT NOT NULL DEFAULT 'events-{discord_id}'`, placeholders `{name}`/`{discord_id}`, applied bot-side by `formatPersonalChannelName` not the server, default constant `DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT`); added that constant to the Discord Name Formatting table. `TeamSettings` model gained `discord_personal_events_group_id`/`discord_personal_events_channel_format`. bot AGENTS.md: split Pass 1 into "Pass 1a — Provision" (now formats the channel name via `formatPersonalChannelName(channel_format, name, discord_id)` instead of hard-coding `events-<discord_id>`) and added "Pass 1b — De-provision" (`Guild/GetPersonalChannelsToDeprovision` → `deprovisionPersonalChannels`, delete Discord channel THEN `Guild/DeletePersonalChannel`, clear DB rows ONLY after the channel is gone (delete OK or `10003`)); reconcile now does FOUR things — `reconcileMemberMessage` builds via `buildPersonalMessagePayload`/`hashPersonalMessagePayload` and returns `Some(member)` only on a NEW create, gating a per-member `reorderPersonalChannel` pass that reuses the exported `longestKeepablePrefix`/`compareSnowflakes` from `reorderChannelMessages.ts` + the shared `ChannelReorderSemaphore` (personal channels sort latest-start-first via their own comparator, same prefix engine; reorder only on create, never on every edit); added "Ping-free mention convention (highlight without notifying)" — `content: <@id>` (only when `Option.isNone(my_response)`) + `allowed_mentions: { parse: [] }` renders a highlighted mention chip with NO ping, and the `payload_hash` MUST include `content`. Earlier entry: Rework Events Overview on Discord — two-surface event model. server AGENTS.md: added "Two-surface event model: global shared channel + per-member personal channels" — (1) GLOBAL: ONE shared events channel per team via `team_settings.discord_events_channel_id`, resolved by the now-simplified `resolveChannel(teamId)` (single-column read; the old `resolveChannel(teamId, eventId)` 4-tier waterfall AND the `events`/`event_series` `discord_target_channel_id` columns are GONE, dropped by migration `1790300009`); `resolveReminderChannel`/`resolveOwnerGroupChannel` retained for reminders/claims/rosters. (2) PERSONAL: private per-member channels in `team_settings.discord_personal_events_category_id` (auto-overflow past 50). Added the `events.personal_messages_dirty_at` reconcile-marker contract — set via `markEventPersonalMessagesDirty` (`date_trunc('milliseconds', now())`) on RSVP + event create/update/cancel; read by `PersonalEvents/GetEventsNeedingReconcile`; cleared by `clearEventPersonalMessagesDirty` with an observed-`dirty_at` guard (`WHERE personal_messages_dirty_at = $2`) to prevent lost updates; NO outbox table. Documented three new tables — `personal_event_channels` (reserve-first `ON CONFLICT DO NOTHING`, nullable `discord_channel_id`), `personal_event_messages` (fan-out keyed `(event_id, team_member_id)`, `payload_hash` hash-diff), `personal_event_overflow_categories` — and the `Guild/*Personal*` + `PersonalEvents/*` RPC groups. Added the NOTE distinguishing the RETAINED-and-overloaded `event_sync_events.discord_target_channel_id` from the now-dropped `events`/`event_series.discord_target_channel_id`. Updated the `TeamsRepository.insertQuery` column list to 15 (dropped `overview_channel_id`, migration `1790300002`; removed `Guild/SetOverviewChannel`). bot AGENTS.md: reworked the "Event Sync" intro to spell out the two surfaces; added "Personal Events Sync (per-member private channels + global refresh)" — the bot-driven `PersonalEventsSyncService.processTick` on `pollLoop`, PASS 1 provisioning (`Guild/GetGuildsNeedingPersonalProvisioning` → `provisionPersonalChannels`, reserve→create→save, 403→overflow-retry-once) and PASS 2 reconcile (`PersonalEvents/GetEventsNeedingReconcile` → `reconcileEvent` → timestamp-guarded `ClearPersonalMessagesDirty`), hash-diff on both surfaces, compensating-delete on a failed message persist; added `personalEvents.processTick` to the `pollLoop` row; removed stale `/event overview` + `overview-show`/`OverviewShowButton`/`overview-channel.ts` references (deleted in the rework) and renamed `buildUpcomingEventPage` → `buildUpcomingEventEmbed`.) (Earlier entry: Roster-role remove-extras reconcile (Phase 2). domain: new `roster_role_reconcile` literal in `ChannelSyncEventType` (`packages/domain/src/models/ChannelSyncEvent.ts`) + `RosterRoleReconcileEvent` `Schema.TaggedClass` added to `UnprocessedChannelEvent` (`ChannelRpcEvents.ts`) + new `Channel/GetExpectedRoleHolders` RPC (`ChannelRpcGroup.ts`, payload `{ team_id, discord_role_id }`, success `Schema.Array(RosterMemberDiscord)`). migration `1790200002_add_roster_role_reconcile_event_type.ts` extends the `channel_sync_events_event_type_check` CHECK. server AGENTS.md: added "Roster-role remove-extras reconcile (the other half of the sync button)" subsection — the same `backfill-role-members` endpoint now also runs `reconcileRosterRoleExtras(teamId)` (`src/utils/reconcileRosterRoleExtras.ts`, advisory lock, `RECONCILE_LIMIT = 50`) summed into `BackfillRosterRolesResult`; the sweep keys on `discord_role_id` (NOT `roster_id`, since `discord_role_id` has NO unique constraint), `GROUP BY discord_role_id` emitting ONE event per distinct role, and `Channel/GetExpectedRoleHolders` returns the UNION of expected holders across EVERY active roster sharing that role id; the server NEVER reads Discord membership — the delete diff lives in the bot. Extended "Adding an `event_sync_events` Event Type" with the `channel_sync_events` FIVE-place variant (extra place: the `constructEvent` `Match.when({ event_type })` decode branch in `src/rpc/channel/events.ts`, which is NOT a compile-time backstop). bot AGENTS.md: added "Roster role remove-extras reconcile (fail-closed)" — `handleRosterRoleReconcile` is the only handler doing a live `listGuildMembers` read to compute a bulk delete diff; FAIL-CLOSED rule: any page-read failure / expected-set failure removes NOBODY (never treat unread members as extras); `listGuildMembers` MUST paginate with a STRING `after` cursor (snowflakes exceed `Number.MAX_SAFE_INTEGER`, dfx mistypes `after` as number, next cursor via `BigInt` max), capped at `MAX_PAGES = 50` treated as a partial read. Earlier entry: Group-channel member backfill. domain: new `Channel/GetGroupMembers` RPC (`packages/domain/src/rpc/channel/ChannelRpcGroup.ts`, payload `{ team_id, group_id }`, success `Schema.Array(GroupMemberDiscord)`) + `GroupMemberDiscord` model (`ChannelRpcModels.ts`). server AGENTS.md: added mechanism 3 "Member backfill source — `Channel/GetGroupMembers`" under "Group-role backfill and grant reapply" — the handler returns `[]` (never an error) on missing group or `team_id` mismatch, filters out members with no `discord_id` via `Array.filterMap`, and MUST resolve members via the new descendant-aware `GroupsRepository.findDescendantMembersWithDiscordIdByGroupId(groupId)` (recursive `parent_id` CTE filtering `is_archived = false` + same `team_id`, `DISTINCT team_member_id`), NOT the direct-only `findMembersWithDiscordIdByGroupId`, because a group's Discord role is held by direct members PLUS all non-archived descendant-subgroup members. bot AGENTS.md: updated `handleCreated` rule 1 — every dispatch branch now resolves a single `roleId` then runs ONE shared member-backfill step (read `Channel/GetGroupMembers`, then the per-member concurrency-1 loop, mirroring `handleRosterChannelCreated` rule 8); the role-only paths are extracted into the `provisionRoleOnly` helper; updated rule 9's parenthetical to list both `handleRosterChannelCreated` and `handleCreated` as per-member-loop users.) (Earlier entry: herdr worktree integration. root AGENTS.md: added the `/worktree` skill to the Development Workflow Skills table (picks up a Notion ticket → opens it in an isolated herdr worktree with branch + seeded gitignored config + `pnpm install` → launches a Claude agent inside it) and a composition note pointing at `scripts/herdr-worktree.sh` and the launched agent booting into `/work <ticket-page-id>`. New `.claude/skills/worktree/SKILL.md` orchestrates `/agile-coach` (ticket select, no `git checkout`/branch in the main checkout, reports branch name + 32-hex page ID) then runs `scripts/herdr-worktree.sh <branch> --label "<title>" --prompt "/work <page-id>"`. New `scripts/herdr-worktree.sh` creates/reuses a herdr worktree, seeds `.env.local`/`.env.preview.local`/`.claude/settings.local.json`, runs `direnv allow` + `pnpm install`, launches the agent (flags `--base`/`--label`/`--prompt`/`--no-install`/`--no-agent`). `.claude/agents/agile-coach.md`: deterministic page-ID/`notion.so`-URL selection path (`notion page props <id>`, no keyword match) and a linked-worktree guard (`.git` is a file → branch already checked out, MUST NOT run `git checkout main`/create branches).) (Earlier entry: On-demand roster-role member backfill. server AGENTS.md: added "Roster-role member backfill (on-demand, admin-triggered)" subsection (after "Group-role backfill and grant reapply") — the roster MEMBER-provisioning analogue of the group-role backfill, but on-demand and team-scoped (HTTP `POST /teams/:teamId/rosters/backfill-role-members`, endpoint `backfillRosterRoles`, gated by `roster:manage`), NOT polled by `slowPollLoop`; `backfillRosterRoleMembers(teamId)` (`src/utils/backfillRosterRoleMembers.ts`, analogue of `emitGroupRoleBackfill.ts`) sweeps up to `BACKFILL_LIMIT = 50` active rosters via `DiscordChannelMappingRepository.countActiveRostersWithRole`/`findActiveRostersWithRole` and re-emits the idempotent `roster_channel_created` event per row (attaches role to the EXISTING channel, never creates one), returning `BackfillRosterRolesResult { processedCount, remainingCount }`; member re-sync is delegated to the idempotent bot `handleRosterChannelCreated` (`GetRosterMembers` re-read + concurrency-1 per-member loop) — the server NEVER diffs Discord membership; the selection `NOT EXISTS` guard checks `processed_at IS NULL` ONLY and intentionally OMITS the `AND error IS NULL` that `findGroupsMissingRole` uses, because a `processed_at IS NULL AND error IS NOT NULL` row is a transient failure the bot re-polls/retries and is therefore still mid-provision. Earlier entry: AI rating insight + ELO-from-description. server AGENTS.md: added "Adding an `LlmClient` Method (Never-Fail Fallback vs `LlmError`)" — two method shapes: fail-with-`LlmError` (`summarizeEmail`, retried by a pending-status worker) vs never-fail with deterministic fallback (`generateRatingInsight`/`estimateRatingFromDescription`, `Effect<Result>` with `never` E, the sanctioned exception to the "Config-Gated External Service Provider" rule-3 `LlmError`-only surface); a never-fail method writes a pure locale-aware `derive…Fallback(input)` the stub returns directly, and `makeReal` pipes through the shared `requestContent` helper then `Effect.tapError(logWarning)` BEFORE `Effect.catchTag('LlmError', () => Effect.succeed(derive…Fallback(input)))`; reuse `requestContent` (don't re-implement the `POST /chat/completions` + `mapError` pipeline per method); the result carries `generated: boolean` (true=live, false=fallback) surfaced to the web. Added "Untrusted Input and Numeric Output Clamping in LLM Prompts" — end the system prompt with the `UNTRUSTED DATA` clause and put the untrusted value in a `user` message, cap free text (`description.slice(0, 2000)`), and clamp any LLM-returned number server-side via the exported `clampRating(n, min, max)` AND again in the handler before persisting (`applySeedRating` re-clamps with `RATING_MIN`/`RATING_MAX`). Added "Seed-Only Guarded Upsert (`PlayerRatingsRepository.seedRating`)" — `INSERT … ON CONFLICT DO UPDATE SET rating = EXCLUDED.rating WHERE games_played = 0` returning `Option<Row>` (`None` → `SeedNotAllowed` 409 when the row already has games), writes NO `player_rating_history` row and keeps counters at 0 so calibration corrects it; reference `test/integration/repositories/PlayerRatingsRepository.test.ts`.) (Earlier entry: Epic 6.3 "balanced training team generator". root AGENTS.md: added a Biome.js bullet — never rely on `!` non-null assertions for narrowing (`map.get(k)!`, `arr[i]!`), the formatter strips `!` in some positions so the value becomes `T | undefined` and `pnpm check` then fails; use an explicit `if (v === undefined)` guard. domain AGENTS.md: added "Pure Algorithm Modules (`src/models/<Algorithm>.ts` + `test/<Algorithm>.test.ts`)" — a multi-step computation several consumers run identically lives as a pure (no Effect/I/O/Schema) module with a paired deterministic-output unit test in the same PR; never `Math.random()`/clock, break ties with an explicit total order captured at decision time, document phases/cost-function/constants in a module doc comment, tunable constants are named exports, the server wraps the pure result into Effect at the call site; reference `Elo.ts`/`TeamGenerator.ts`. server AGENTS.md: added a "RPC direction is bot→server only" note to "RPC Transport" — the server is always the RPC server and the bot always the RPC client (`SyncRpcs`), the server has NO RPC channel back to the bot and cannot call Discord directly, so its only path to Discord is enqueueing a `*_sync_events` outbox row the bot polls; add an outbox event type, never look for a server→bot RPC. Added "JSONB payload column on an outbox event type" — the sanctioned exception to the never-denormalise / JOIN-resolution rule: a computed point-in-time snapshot with no stable source row to re-derive at read time is stored in a nullable JSONB column (one event type populates it, others NULL), schema decodes with `Schema.OptionFromNullOr(Schema.Array(<Element>))` (node-pg auto-parses JSONB — no `Schema.parseJson`), emitter writes `JSON.stringify(...)::jsonb`, snapshot at emit time never re-derive; reference `event_sync_events.teams_payload` (migration `1789900000`) + `emitTeamsGenerated`/`constructEvent`. bot AGENTS.md: added `teams_generated` to the Event Sync event-types list with the `handleTeamsGenerated` (`src/rcp/event/handleTeamsGenerated.ts`) → `buildGeneratedTeamsEmbed` description (posts to `discord_target_channel_id`, no-op+warn on `None`, renders the server-computed `teams_payload`, does not recompute).) (Earlier entry: Epic 6.2 "log training game results". root AGENTS.md: added the single sanctioned exception to the `Effect.die` ban under Error Handling rule 2 — re-raising an *already-captured* defect unchanged via `Effect.failCause(Cause.die(defect))` (never `Effect.die(defect)`); `Effect.die` is banned for losing context on *new* defects, but `Cause.die(defect)` on an existing defect preserves the cause verbatim and there is nothing to wrap; reference `applications/server/src/services/TrainingAutoLogCron.ts` (`catchDefect` retry-on-unique-violation / re-raise-everything-else). server AGENTS.md: added "Composing repository writes atomically across repositories (`…Tx` body split)" under "In-Transaction Read → Compute → Write" — expose a `…Tx` body method that does NOT call `sql.withTransaction` (so it nests as a SAVEPOINT inside a caller's outer transaction) plus a public wrapper that adds `sql.withTransaction` + `catchSqlErrors`; the body keeps per-statement `catchSqlErrors`; all `FOR UPDATE` lock-ordering rules apply across the merged transaction; reference `PlayerRatingsRepository.applyGameUpdatesTx`/`applyGameUpdates` consumed by `TrainingGamesRepository.insertGame`. Added "Best-effort side effect AFTER a committed transaction" — a follow-up side effect that runs after the primary `sql.withTransaction` commits MUST run outside that transaction, be wrapped in `Effect.catchCause((cause) => Effect.logWarning(msg, cause))` (always log the captured cause, never `Effect.ignore`), and be idempotent (`ON CONFLICT DO NOTHING` against the partial unique index); reference the `insertAutoIgnoreConflict` loop in `logTrainingGame` (`src/api/player-rating.ts`).) (Earlier entry: server AGENTS.md: Elo rating system. Added rule 4 to "Consistent `FOR UPDATE` Lock Ordering Within A Transaction" — when the lock targets N sibling rows of the SAME table (not a parent/child pair), the locking SELECT MUST be `ORDER BY <pk>` and the app MUST dedupe + sort the id set in the same order before the `IN` list, so concurrent transactions acquire overlapping row locks in identical order; reference `PlayerRatingsRepository.applyGameUpdates` (`Array.from(new Set([...a, ...b])).sort()` + `... IN ${sql.in(...)} ORDER BY team_member_id FOR UPDATE`). Added "In-Transaction Read → Compute → Write" subsection — a mutation that derives new values from current persisted values MUST read (`FOR UPDATE`), compute (via a pure `packages/domain` calculator like `Elo.computeTeamGameUpdate`), and write all inside one `sql.withTransaction`; compute from locked rows only; a missing-but-expected locked row is `LogicError.die`, not a recoverable error. Added rule 7 to "Global Admin Authorization" — a "manage" gate that admits global admins is the ONLY sanctioned exception to rule 5 and MUST be `requireReadAccess` + an `isGlobalAdmin`-branched `requirePermission` (the synthetic membership carries only `VIEW_PERMISSIONS`, so a global admin would otherwise be rejected by the `member:edit`/`<perm>` check); allowed only for operator-facing features with no Discord-facing or member-self-service mutation; canonical helper `requireManageAccess` in `src/api/player-rating.ts`.) (Earlier entry: server AGENTS.md: added "Injectable Env-Derived Config Service (Testable Allowlist)" section — wrap an env-derived process-wide constant (parsed once at module load) in a thin `ServiceMap.Service` whose `Default` reads the existing module-level constant ONLY when handlers must override it in tests (`Layer.succeed(Service, fake)`, never `vi.stubEnv` on a `@t3-oss/env-core`-snapshotted module); the service is a wrapper not a second source of truth, wrap only the consumers that need injectability (the per-request `toCurrentUser` keeps reading `globalAdminDiscordIds` directly — only `src/api/global-admin.ts` depends on the service), and adding it to `ApiLive` triggers the test-layer cascade; reference `GlobalAdminAllowlist` (`src/services/GlobalAdminAllowlist.ts`). Generalised the "HttpApi Mock-Layer Cascade" section from repositories to **every** service a registered `HttpApiBuilder.group(...)` depends on — non-repository services are provided via their `.Default` (or a `Layer.succeed` override); added the recurring footgun that wiring a new `ServiceMap.Service` into `ApiLive`/`AppLive.ts` silently breaks every `ApiLive`-providing test at once (the global-admins change had to add `Layer.provide(GlobalAdminAllowlist.Default)` to 34 test files), with `Layer.provide(BotInfoStore.Default)` as the grep anchor.) (Earlier entry: domain AGENTS.md: added "Input vs Output Types for Write-Back Nested Arrays" section under Schema Patterns — when a response `Detail` type carries an editable nested array that the client submits back AND the response augments each element with a server-computed field, define two schema classes: an input type with only writable fields (`ChannelAccessGrant`, used by `SetChannelAccessRequest.grants`) and an output `<Input>Detail` type adding the computed field (`ChannelAccessGrantDetail` adds `roleResolvable: boolean`, used by `ChannelDetail.grants`, populated server-side from `findGroupRoleIds`); the request payload element MUST be the input type, never the output type, and the web MUST map output records back to fresh input instances before submitting so the computed field cannot leak into the request — reference `packages/domain/src/api/ChannelApi.ts` + `applications/web/src/components/organisms/ChannelAccessSheet.tsx` (`handleGrantAccess`/`handleChangeLevel`/`handleRemoveAccess`); framed as the nested-write-back counterpart of "Display Names Are Computed Server-Side".) (Earlier entry: Per-team IMAP email-ingestion variant. server AGENTS.md: added `ImapPoller` (`src/services/ImapPoller.ts`, every 5 min) to the Cron table. Added "Email Ingestion Has Two Producers (Webhook + IMAP Poller)" section — `email_messages` `received` rows are written by `EmailWebhookLive` (`insertReceived`, always inserts) and `ImapPoller` (`insertReceivedDedup`, ON CONFLICT); everything downstream of `received` is producer-agnostic; both share the `senderAllowed` allow-list filter, the `validateAttachmentSizes` cap (`src/services/emailAttachmentLimits.ts`), and a single `sql.withTransaction` message+attachments write; `insertReceivedDedup` dedups on `(team_id, message_id)` via `ON CONFLICT (team_id, message_id) WHERE message_id IS NOT NULL DO NOTHING RETURNING id` (partial unique index `uq_email_messages_team_message_id`, migration `1789400006`), returning `Option<EmailMessageId>` (`None` = already-ingested no-op) and falling back to plain `insertReceived` when `message_id` is absent. Added "IMAP Watermark Ingestion (`ImapPoller`)" section — per-team UID watermark on `email_forwarding_config` (`imap_last_seen_uid`/`imap_uid_validity`/`imap_last_synced_at`, advanced via `updateImapSync`); cold start (`imap_last_seen_uid === 0 AND imap_uid_validity IS NONE`) and `UIDVALIDITY` reset both baseline to `uidNext - 1` and ingest nothing; the ascending-UID left-fold threads `{ committed, stopped }` and never advances the watermark past a failed insert (`stopped` halts the rest of the cycle, failed UID retried next cycle); per-team `decrypt`/`ImapConnectionError` failures map to a module-local `SkipTeam` and the per-team loop is `{ concurrency: 2 }` with `Effect.exit` isolation; candidate query `findImapEnabled()` backed by partial index `idx_email_forwarding_imap_enabled (... WHERE imap_enabled = true AND enabled = true AND imap_secret_encrypted IS NOT NULL)` (both `imap_enabled` AND `enabled` required). Added "Optional Secret That Fails On Use, Not On Boot (`EmailSecretCrypto`)" section — AES-256-GCM per-team IMAP credential crypto distinct from the real-vs-stub `LlmClient` provider: the `EMAIL_IMAP_ENCRYPTION_KEY` redacted-optional env var is resolved per call via `resolveKey` (never at layer build), so the layer always builds and `encrypt`/`decrypt` fail with typed `EmailSecretKeyMissing` (key absent or not 32 base64 bytes) / `EmailSecretDecryptError`; ciphertext is the self-describing `v1.<iv>.<tag>.<ct>` base64url string stored in `email_forwarding_config.imap_secret_encrypted`; tests use the `makeWithKey(Option<string>)` seam, never `Default`.) (Earlier entry: server AGENTS.md: added "Overloaded payload fields on event sync events (training vs non-training)" section — `event_started.discord_role_id` carries the OWNERS-group role for trainings but the MEMBER-group role otherwise, and `training_claim_request.owner_group_id` is populated in `constructEvent` from the outbox `member_group_id` column; both producer (`EventStartCron`/`constructEvent`) and consumer branch on `event_type === 'training'` and MUST be kept in sync; `EventStartCron` also passes `event.claimed_by` → `claimed_by_discord_id` only for trainings. Added "Dead claim-thread column and RPC" section flagging `events.claim_thread_id` + `Event/SaveClaimThreadId` as dead/do-not-reuse. Added "Persistent owners claim thread" section — one thread per owners group on `discord_channel_mappings.claim_thread_id` (migration `1789400005`), served by `Event/{Get,Save,Clear}OwnerClaimThread` RPCs; `saveClaimThreadIfAbsent` is the atomic race-safe `UPDATE ... WHERE claim_thread_id IS NULL RETURNING` that returns the winning id and re-reads on `None`; added it to the "Atomic Conditional UPDATE Pattern" used-by list. bot AGENTS.md: updated the `event_started` description — the "Starting now" mention is `event_type`-dependent (training → `<@coach>` user mention via `claimed_by_discord_id` + `allowed_mentions.users`, fallback owners-role mention + `bot_event_started_no_coach_warning`; non-training → member-group role), and the handler best-effort deletes the owners-thread claim message on training start. Replaced "Coach-claim message id round-trip" with "Persistent owners claim thread (one per owners group, NOT per training)" — `handleTrainingClaimRequest` resolves/creates ONE thread per owners group via `Event/GetOwnerClaimThread`/`SaveOwnerClaimThread` (delete-the-loser-on-race), posts the embed into the thread with a code-10003 clear+recreate+retry-once path, then saves the message id; per-message thread creation was removed.) (Earlier entry: server AGENTS.md: added "Consistent `FOR UPDATE` Lock Ordering Within A Transaction" section — when two or more repository methods mutate the same related rows inside `sql.withTransaction(...)` and guard concurrency with explicit `SELECT ... FOR UPDATE`, every method MUST take those locks in the same parent→child order; for `CarpoolsRepository` the order is `carpools` row first then `carpool_cars` row, so `reserveSeat`/`removeCar` begin with `lockCarpoolByCarQuery(input.carId)` before `lockCarQuery`, matching `addCar`; a method touching only one table still takes the parent lock first when it must serialize against a sibling that touches both (why `reserveSeat` locks `carpools`); cross-method guards are mirrored both ways (`addCar`'s `checkOwnerIsPassengerQuery` ↔ `reserveSeat`'s `findOwnedCarQuery`, the latter placed before the capacity check so `CarpoolAlreadyInAnotherCar` wins over `CarpoolFull`); reference `CarpoolsRepository.reserveSeat`/`removeCar`/`addCar`.) (Earlier entry: Email Forwarding & AI Summarization feature. server AGENTS.md: added "Unauthenticated Raw HTTP Routes (`HttpRouter.add`, Outside `AuthMiddleware`)" section codifying that non-session-gated routes (inbound webhooks) are raw `HttpRouter.add` layers merged into `AppLayer` next to `RpcLive`, NOT `ApiLive`; the four-gate self-auth order (body-size cap → HMAC `crypto.timingSafeEqual` constant-time verify BEFORE the DB token lookup → per-team capability token → resource-state filter), the `never` error channel via a `WebhookEarlyExit` tagged error absorbed by `Effect.catchTag(...)`, distinct status mapping that never leaks token existence, and `sql.withTransaction` for the atomic write — reference `EmailWebhookLive` (`src/api/email-webhook.ts`), the first inbound write webhook vs the read-only iCal group. Added "Status-Claim As Per-Row Lock" section — poll-driven status-state-machine workers MUST claim via `UPDATE ... SET status='<inflight>' WHERE id=$1 AND status='<from>' RETURNING id` (`SqlSchema.findOneOption` → skip on `Option.none()`), repeat the precondition in every transition's WHERE, and use `CASE WHEN attempts+1>=max` for in-table capped retry — reference `EmailMessagesRepository.claimForSummarizing` + `EmailSummarizer`. Added "Config-Gated External Service Provider (Real vs Deterministic Stub)" section — one `ServiceMap.Service` whose `Default` picks `makeReal`/`makeStub` from config, identical interface either way, single typed error (`LlmError`), optional-with-default gating env vars, and tests use `Layer.succeed(Service, fake)` not the real `Default` — reference `LlmClient`. Added `EmailSummarizer` to the Cron table. bot AGENTS.md: added "Email Sync (email posts → Discord embeds)" section (the `email_post_sync_events` family: `approval_request`/`post_summary`/`post_original` kinds, `src/rcp/email/`, `src/rest/email/buildEmailEmbeds.ts`); added "`allowed_mentions: { parse: [] }` On Every Message Carrying User- or Email-Derived Content" section generalising the welcome-flow rule to all `createMessage`/`updateMessage` relaying user-authored or external text; added `finance.processTick` + `email.processTick` to the `pollLoop` cadence row.) (Earlier entry: server AGENTS.md: extended the "Global Admin Authorization" section for global-admin read access — added `requireReadAccess(members, teamId, forbidden)` and the `VIEW_PERMISSIONS` (`roster:view`/`member:view`/`role:view`/`finance:view`) component rows to the helper table; reworded rule 5 to scope the "global admin does NOT grant team permissions" rule to WRITE operations only; added rule 6 codifying the read-vs-write helper split — read-only `<resource>:view` handlers use `requireReadAccess` (signature `(members, teamId, forbidden)`, reads `Auth.CurrentUserContext` itself, NO `currentUser.id` arg; returns a synthetic sentinel-id `MembershipWithRole` for a non-member global admin whose `membership.id` MUST NOT scope DB queries), write handlers keep `requireMembership(members, teamId, currentUser.id, forbidden)`, and caller-scoped `my*` reads keep `requireMembership` because they scope by `membership.id`; reference `src/api/permissions.ts` + read handlers `roster.ts`/`role.ts`/`finance.ts`/`activity-stats.ts`/`team.ts`. Updated "Membership Lookups Default To Active-Only" rule 1 to note `requireReadAccess` is an authorization gate whose `Option.none()` branch falls through to synthetic read-only access for global admins.) (Earlier entry: server AGENTS.md: added `TrainingClaimRequestCron` and `CoachingStatusCron` rows to the cron table; added "Self-Healing `*_sent_at` Date-Gated Crons" section under Cron Jobs codifying the per-row `*_sent_at` idempotency marker plus lower-bound (`DATE(start) - days_before <= DATE(now)`) candidate-query gate — distinct from `RsvpReminderCron`'s exact-day-equality + time-of-day BETWEEN window which a cron outage can permanently miss; the marker MUST be set in every terminal branch (success AND each permanent-skip branch), pair it with a matching partial index, and the adding migration MUST backfill existing rows; reference `TrainingClaimRequestCron`/`CoachingStatusCron` + `TeamSettingsRepository`. Added "Adding an `event_sync_events` Event Type — Four Synchronized Places" section under Sync Event Pattern: a new `event_type` value must be added to the DB CHECK constraint `event_sync_events_event_type_check`, the `EventSyncEventType` `Schema.Literals` in `EventSyncEventsRepository.ts`, the `UnprocessedEventSyncEvent` `Schema.Union` (`Schema.TaggedClass`) in `packages/domain/src/rpc/event/EventRpcEvents.ts`, and the bot `Match.type<...>().pipe(...)` dispatcher in `applications/bot/src/rcp/event/ProcessorService.ts` (place 4 is the only compile-time backstop via `Match.exhaustive`; places 1–2 are runtime-only). migrations AGENTS.md: added "Backfill `*_sent_at` Idempotency Markers on Add" section — the same migration that adds a `*_sent_at` cron marker MUST `UPDATE ... SET <marker> = now() WHERE ... AND <marker> IS NULL`, scoped to the cron's target rows, to avoid a first-deploy notification blast; reference `1789300000_improve_coach_assigning.ts`.) (Earlier entry: root AGENTS.md: updated "Logs & Monitoring" → Services table to add the web app (`sideline-web`) and note it uses a separate browser-side telemetry layer in `applications/web/src/lib/telemetry.ts` (`makeTelemetryLayer` with `Otlp.layerJson` + `FetchHttpClient.layer`) wired through a `ManagedRuntime` singleton, distinct from the Node apps' `run.ts` `@sideline/effect-lib` layer. web AGENTS.md: added "Runtime Singleton & Browser Telemetry" section codifying the single module-level `ManagedRuntime` in `lib/runtime.ts`, the one-directional OTEL config flow `fetchEnv → initRuntime → ManagedRuntime → runners`, the idempotent `initRuntime({ serverUrl, telemetryLayer })` called once in root `beforeLoad` (every runner throws if called before it), the four optional OTEL env vars (`OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_SERVICE_NAME`/`APP_ENV`/`APP_ORIGIN`, `makeTelemetryLayer` returns `Layer.empty` when endpoint is unset), the load-bearing `makeAppLayer` constraint that `ClientConfig` must be both provided to `ApiClientLive` AND merged into the runtime output (`ApiClientLive.pipe(Layer.provide(clientConfigLayer))` + `clientConfigLayer` in `Layer.mergeAll`), `runEffect` as the fire-and-forget `runFork` runner for metrics from non-Effect callbacks only, and the `lib/telemetry.ts` Web Vitals (`registerWebVitals`) + React render (`recordReactRender` via `<Profiler>`) metric helpers with all `Metric.histogram` definitions living there and `web-vitals` lazy-imported. Added `runEffect` to the "Runtime — Client vs Server Runners" table and updated the Wiring note for the `<Profiler>` + `initRuntime`/`registerWebVitals` call sites.) (Earlier entry: server AGENTS.md: documented the channel-management iteration in the "Managed Channels" section — the `managed_channel_adopted` event (`event_type='channel_updated'`, `entity_type='managed'`, carries `team_channel_id` + `discord_channel_id` via `existing_channel_id`, emitted by `emitManagedChannelAdopted`); the `adoptDiscordChannel` endpoint (`POST .../discord-channels/:id/adopt`, text-only, idempotent via a pre-check plus `DiscordChannelAlreadyAdoptedError` catch that re-fetches without re-emitting); the `bulkArchiveDiscordChannels` endpoint (`Array.dedupe` payload, `findAllByTeam` once, per-item `Effect.exit` isolation → `{archived, skipped, failed}`); the new partial unique index `uq_team_channels_discord_channel` on `team_channels(team_id, discord_channel_id) WHERE NOT NULL` (migration `1789000002_uq_team_channels_discord_channel.ts`) as the adoption concurrency guard; and the rule that adoption and access are emitted as two separate committed events to avoid an ordering race. bot AGENTS.md: added the `managed_channel_adopted` → `handleManagedAdopted` row and a REPLACE-semantics note — the handler full-REPLACES `permission_overwrites` with a single `@everyone` deny-`ViewChannel`, wiping foreign overwrites; the bot retains access via its guild-level bot role (not a per-channel overwrite); grants arrive separately via `managed_access_granted`; no RPC ack; updated the dispatcher-chain note and corrected the `channel_updated` + `managed` claim. effect-lib AGENTS.md: filled in the "SQL Error Handling" section documenting `isUniqueViolation`, `getConstraintName`, `catchUniqueViolation`, and `catchUniqueViolationOn` — use `catchUniqueViolationOn(constraintName, ...)` when a table has multiple unique constraints, with `TeamChannelsRepository.insertAdopted` as reference.) (Earlier entry: domain AGENTS.md: added "User Display-Name Resolution (`src/models/DisplayName.ts`)" section codifying `DisplayName.pickDisplayName` as the single source of truth for resolving a user's display name — precedence `name → nickname → displayName → username`, first non-blank wins, blank/whitespace slots skipped, returns `Option<string>` with NO terminal fallback; pure module, namespace re-export; forbids inline `Option.getOrElse(name, () => username)` and ad-hoc `Array.make(...).pipe(Array.getSomes, Array.head)` in server/bot/web. server AGENTS.md: added "Display Names Are Computed Server-Side" section — every API response carrying a user identity MUST return a fully-resolved non-`Option` `displayName: string`, computed at the handler/mapper layer via `DisplayName.pickDisplayName` with terminal fallback `() => username` (username always present); repositories still SELECT the raw four slots; reference `toCurrentUser.ts` and `roster.ts` `toRosterPlayer` (also `event-rsvp.ts`, `group.ts`, `leaderboard.ts`). web AGENTS.md: added "User Display Names — Read `displayName`, Never Re-Derive" under Auth Store — web reads the server's `displayName` string directly and MUST NOT re-implement the fallback (`Option.getOrElse(x.name, () => x.username)` is forbidden — skips nickname/global display name); derive initials/avatars from `displayName`; reference `NavUser.tsx`, `PlayerRow.tsx`. bot AGENTS.md: updated "`formatName`" section — `formatName` now delegates its precedence to the shared `DisplayName.pickDisplayName` picker and only layers Discord markdown (`**bold**`, `<@id>`); the entry's `display_name` field maps to the picker's `displayName` slot; `"Unknown"` is the bot's own terminal fallback, the picker invents none.) (Earlier entry: domain AGENTS.md: expanded Permission-catalog rule 1 into an explicit four-file checklist for adding a `Permission` literal — `Permission.literals` + `defaultPermissions`, the backfill migration, the exhaustive `permissionLabels: Record<Role.Permission, …>` map in web `RoleDetailPage.tsx` (omitting a key is a compile error), and a `role_perm_<camelCaseLiteral>` i18n key in BOTH `cs.json` and `en.json`. bot AGENTS.md: added "Rebuild a board message from the stored id, never from `interaction.message`" under the Event Sync message-id section — persistent multi-user board embeds must be rebuilt at the channel/message id carried on the server view (saved at create time via a `Save…DiscordMessageId`-style RPC), not from `interaction.message`/`interaction.channel_id`, because the interaction may originate from a private thread or ephemeral reply; reference `rebuildBoard` in `src/interactions/carpool.ts`.) (Earlier entry: server AGENTS.md: added "Per-User/Team Preferences (`(user_id, team_id)` JSONB Row)" section codifying the composite-key + JSONB body pattern used by `dashboard_layouts` — `PRIMARY KEY (user_id, team_id)`, both FKs `ON DELETE CASCADE`, no synthetic id; read returns `Option<Body>` with the API handler defaulting `None` to a `DEFAULT_*` value (never 404); writes are unconditional `INSERT ... ON CONFLICT (user_id, team_id) DO UPDATE` upserts; JSONB is bound via `JSON.stringify(...)::jsonb`; authorization is `requireMembership` (not `requirePermission`) and `userId` is bound from `Auth.CurrentUserContext`, never from URL/payload. Added "Server-Side Normalization Of Stored Preference Payloads" section codifying the `normalize` pure-function pattern run on BOTH read and write for any JSONB payload whose body references a domain literal set that may grow over time (drop-unknown / dedupe / append-missing-as-visible in canonical order); reference `normalizeWidgets` in `src/api/dashboard-layout.ts`; canonical id order lives as a `const`-tuple in `packages/domain/` (`DASHBOARD_WIDGET_ORDER`); missing entries append as visible by default — never version the payload, the normalizer makes it self-healing.) (Earlier entry: server AGENTS.md: added "Membership Lookups Default To Active-Only" section codifying that `TeamMembersRepository.findMembershipByIds(teamId, userId)` (no options) and `findByUser(userId)` filter `AND tm.active = true` by default; `{ includeInactive: true }` is the explicit opt-in used only by the three reactivation-or-create flows (`invite.joinViaInvite`, `auth.autoJoinTeams`, `rpc/guild.RegisterMember`); `requireMembership` inherits the active-only filter; the deactivation-is-terminal invariant for `auth.autoJoinTeams` — when `findMembershipByIds(..., { includeInactive: true })` returns `Some` (active OR inactive), the handler returns `Option.none()` and never calls `addMember`/`reactivateMember`, so a removed user is never silently auto-rejoined on the next OAuth login; fee/payment queries that JOIN `team_members` filter `AND tm.active = true` in SQL. web AGENTS.md: updated "Current Route Structure" tree to reflect the `(no-team)/` parenthesised group under `(authenticated)/` (now contains `no-team.tsx`, `create-team.tsx`, and `profile/`); added "`(no-team)` Route Group Convention" section codifying that authenticated routes with no `teamId` in the path belong under `(no-team)/`, `teams/$teamId/route.tsx` redirects to `/no-team` (with `?removed=1` when `getLastTeamId()` matches `params.teamId`) on a missing membership, root `/` redirects to `/no-team` (not `/create-team`) on `NoSuchElementError`, and `clearLastTeamId()` must be called before redirecting to `/no-team` to avoid a redirect loop.) (Earlier entry: root AGENTS.md: reinforced "Never use `Effect.orDie`/`Effect.die`" rule with `HttpServerResponse.json(...).pipe(Effect.orDie)` as an additional bad example and the canonical `Effect.catchTag('NoSuchElementError', () => LogicError.die('...'))` pattern for `INSERT ... RETURNING` queries — reference `WeeklyChallengeRepository.create`. server AGENTS.md: added "HttpApi Query Parameters Must Be Consumed Or Removed" section (every `Schema.OptionFromOptional` query field must be destructured by the handler or removed from the schema; reference `weekly-challenge.ts` `listChallenges`); added "HttpApi Mock-Layer Cascade" section under Testing — every test file that provides `ApiLive` must provide a mock layer for every repository registered in `ApiLive` (noop reads return `Option.none()` / `[]` / `Effect.void`; non-trivial writes return `Effect.die(...)`; mock objects MUST build domain models via canonical constructors, never as camelCase string literals — reference `test/mocks/weeklyChallengeMocks.ts`). web AGENTS.md: added "Time-Sensitive Data: Timezone Correctness, Stale-Response Toggles, Focus Refetch" section codifying three rules — (1) server's `currentTeamMondayDateString(teamTz)` is the single source of truth; web client NEVER uses `Date.getDay()`/`getDate()` for "current week"; `MondayPicker` identifies Mondays via `Intl.DateTimeFormat('en-CA', { timeZone: teamTz, weekday: 'short' })`; (2) `window.focus` → `router.invalidate()` for pages with calendar-boundary semantics (reference `WeeklyChallengesPage.tsx`); (3) debounced-optimistic-toggle stale-response pattern using monotonic `inFlightRequestIdRef` + `serverStateRef` for rollback target — reference `ChallengeCompletionCell.tsx`.) (Earlier entry: root AGENTS.md: clarified that `Effect.catchAll` does NOT exist in Effect v4 beta — the operator is `Effect.catch`; documented the legitimate use of `Effect.catch` as the outer per-event funnel inside `ProcessorService.processEvent`. bot AGENTS.md: added "Discord REST Retry Pattern" section codifying `Effect.suspend(() => rest.<call>(...))` as mandatory inside `Effect.retry`, the required `catchTag → retry` ordering (permanent errors short-circuit before burning retries), and pointing at `handleAchievementEarned.ts` + `handleWeeklySummaryReady.ts` as latent-bug references that lack `Effect.suspend` and (for weekly summary) have the wrong catchTag/retry order. Added "Optional Env Var Pattern" (`Schema.OptionFromNullishOr(Schema.NonEmptyString)`, see `WEB_URL` / `LOG_LEVEL` in `src/env.ts`). Added "Mocking `~/env.js` in Tests" rule — `@t3-oss/env-core` snapshots at module load, so `vi.stubEnv` after import is a no-op; use `vi.mock('~/env.js', factory)` with a mutable hoisted ref; reference `applications/bot/test/rcp/weeklyChallenge/ProcessorService.test.ts`. Added "Folder Naming: `rcp` Not `rpc`" callout — the bot sync-processor folder is `applications/bot/src/rcp/` (historical typo, now the established convention). Added "Embed Builder Location" rule — embed builders live under `applications/bot/src/rest/<feature>/build<Name>Embed.ts`, never under `src/rcp/`. i18n AGENTS.md: added "Kind/Category Label Keys Bake In Their Emoji" section — `weeklyChallenge_embed_kind_throwing` resolves to `"🥏 Házecí"` with the emoji already in the value; bot embed builders MUST NOT prefix another emoji.) (Earlier entry: server AGENTS.md: added "Team Provisioning: `provisionNewTeam(...)` Helper" section codifying the single-source-of-truth helper at `applications/server/src/utils/provisionNewTeam.ts` — both `auth.createTeam` (deprecated) and `onboarding.completeOnboarding` delegate to it; documents the optional `markConsumed: (teamId) => Effect<Option<unknown>>` callback for atomic token consumption inside the team-creation transaction (returns `Option.none` to abort with `OnboardingTokenAlreadyConsumed`); pre-flight checks and `SqlErrors.catchUniqueViolation` mapping live at the call site, never in the helper. Added "Token-Hash-At-Rest For Capability URLs" section codifying that single-use URL capability tokens (e.g. `team_onboarding_tokens.token_hash`) are stored as SHA-256 hex of `crypto.randomBytes(32).toString('base64url')` plaintext; the plaintext is returned exactly once at mint time and never persisted; lookups go through `findByHash(hashToken(plaintext))` only; reference `src/utils/onboardingToken.ts`. Domain AGENTS.md: added rule 4 to "HTTP API Error Tag Conventions" — lifecycle-state errors get one resource-prefixed tag per terminal state (`<Resource>TokenExpired` / `Revoked` / `AlreadyConsumed`) with per-state HTTP status mapping (410/410/409), not a single collapsed `<Resource>TokenInvalid`; reference `OnboardingApi.ts`.) (Earlier entry: web AGENTS.md: added `formatEventDateRange` to the `src/lib/datetime.ts` row in the Shared Utility Modules table — canonical helper for rendering event start/end ranges across EventDetailPage, EventsListPage, and EventCalendarView WeekEventCard.) (Earlier entry: server AGENTS.md: extended "Hand-written INSERT / UPDATE Column Lists" footgun section to enumerate `TeamsRepository.insertQuery`'s current state — `welcome_channel_id` and `achievement_channel_id` ARE persisted at INSERT, but `system_log_channel_id`, `rules_channel_id`, `overview_channel_id`, `welcome_message_template`, `onboarding_rules_role_id`, `onboarding_rules_prompt_id` are still silently dropped and can only be set via subsequent `teams.update(...)`. Added "PATCH Payload Merge: `Option.getOrElse` Over `Option.match`" section codifying `Option.getOrElse(payload.x, () => existing.x)` as the required idiom for partial-PATCH "patch-or-keep" merges over the verbose `Option.match({ onNone: () => existing.x, onSome: (v) => v })`; reserve `Option.match` for non-trivial `onSome` branches; use `Effect.let` (not `Effect.bind` + `Effect.succeed`) when no effectful work is needed; reference `applications/server/src/api/team.ts` `updateTeamInfo`.) (Earlier entry: domain AGENTS.md: added "Wire-Format Date-String Helpers (`src/models/<Resource>Date.ts`)" section codifying the pure `parse...`/`format...` pair pattern used by `ActivityLogDate` — DST-safe noon anchoring, ±N-day calendar bounds, `Option<Date>` return, namespace re-export from `index.ts`; both parser and matching `Schema.check(Schema.isPattern(...))` wire schema are required. effect-lib AGENTS.md: documented `Options.toEffect` (`Option<T>` → `Effect<T, E>` lifting) and `Options.extractEffect` (`Option<Effect<T, E>>` → `Effect<Option<T>, E>`) — prefer over inline `Option.match` when `onSome` is a bare `Effect.succeed`. server AGENTS.md: added "Stable Tiebreaker On Timestamp ORDER BY" section requiring `ORDER BY <user-editable timestamp>, id` (matching direction) on user-mutable timestamp columns to keep pagination deterministic; reference `ActivityLogsRepository._listByMember` / `_listRecent`. web AGENTS.md: added "Date Inputs — `DatePicker`" section (use `~/components/ui/date-picker` over `<input type='date'>`, controlled by `YYYY-MM-DD` string not `Date`, `fromYear`/`toYear` ±N pattern, `dirty` flag for edit forms to honour the server's missing-key PATCH contract).) (Earlier entry: bot AGENTS.md: added "Test File Imports — Static Only" section codifying that dynamic `await import('~/...')` inside test helpers re-pays Vitest transform cost per test under repo-root `sequence.concurrent: true` and causes 5s timeouts; TDD-scaffolding dynamic imports must be hoisted once the module under test exists; reference fix `applications/bot/test/rcp/onboarding/ProcessorService.test.ts`; lists known offenders still to hoist.) (Earlier entry: root AGENTS.md: added `Schema.OptionFromOptional` to the optional-schema rule (also used for partial PATCH payload fields, not only HTTP query strings). Domain AGENTS.md: extended the `OptionFromOptional` bullet to cover PATCH request payloads with `ExpenseApi.UpdateExpenseRequest` as reference; added "Permission Reuse Over New Literals" rule under the permission catalog. Server AGENTS.md: added "Application-Set Audit Actor For Hard Deletes" section codifying the `SET LOCAL audit.user_id = ${userId}` inside `sql.withTransaction(...)` pattern (reference `ExpensesRepository.delete`), and "Hard-Delete + Audit Trigger vs Soft-Delete" decision matrix. Migrations AGENTS.md: added "Per-Row Audit Trigger With Application-Set Actor" section documenting the `expenses_audit` trigger + `expense_history` table + `current_setting('audit.user_id', true)` actor-lookup pattern. Web AGENTS.md: added "URL-Synced Tabs Via `validateSearch`" section (reference `finances.tsx`); added "User-Scoped `localStorage` Keys" rule (reference `overviewTabSeenKey`); added `pickDominantCurrency` (by volume) vs `pickMostFrequentCurrency` (by row count) distinction in the finance utilities table.)
