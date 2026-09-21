# IBAN cross-check: valid token but wrong club account

Branch `fix/iban-cross-check` · Notion `3e293506-0818-81ab-b4b5-e423e433b471` · Medium · Production · Server

## Problem

`POST /teams/:teamId/bank-sync/test` returns Fio's own `info.iban` and the UI displays it, but
nothing compares it against the configured account. A token that authenticates against a different
account than the one entered is the most likely silent misconfiguration after a dead token.

**And the harm is not in the probe.** `BankSyncPoller.ts` has zero references to `iban`:
`fetchAndIngest` (`BankSyncPoller.ts:117-172`) hands `statement.movements` straight to
`txRepo.upsertMany`, then `runTeamCycle` calls `recordSuccess` and `matchIngested` — hourly. A
wrong-account token means someone else's movements are ingested and auto-matched against this
club's fee assignments, every hour, silently. The probe verdict is the diagnosis; the poller guard
is the fix.

## Decisions (made by the user, not open)

1. A hard `account_mismatch` member on the closed `BankSyncTestStatus` union. `ok: false`. Not a
   warning flag.
2. The poller **halts ingestion** on a mismatch — no `upsertMany`, no `upsertStatementPeriod`, no
   `matchIngested` — logs, and records the condition.
3. Accepted risk: a false mismatch stops a working club's imports. Therefore the state must be
   **loudly visible**, which drives the ladder rank below.
4. `clearPollBackoff` on the probe is **gated on `!mismatch`**.

## Where the mismatch verdict is recorded, and why the ladder changes

`recordSuccess` is out: it clears `last_error_code`, and `bankSyncStatus.ts:70` returns `'ok'` off
that alone — the card would say "everything is fine" while nothing is imported. That is the
accepted risk materialising as a silent halt.

`recordFailure` is the right *mechanism*: `last_error_code` is free-text `TEXT` with no CHECK
(migration `1792000001:41`), `consecutive_failure_count + 1`, and
`next_attempt_at = now() + LEAST(2^(n+1), 24) h`, which `findPollableQuery` filters on. Backoff is
correct here: nothing can change until a human edits the config, so hourly re-fetching a statement
we refuse to ingest is pure waste. No new error-code union is needed — `'account_mismatch'` is just
another free-text code, and `isFioError` (exact `code === 'fio_error'`) stays false, so the D11
`invalid` escalation is untouched.

**But the resulting rank would be wrong.** With an unrecognised code the ladder falls through to
rank 5 `sync_failing`, whose copy is `fio_status_syncFailingBody` = *"We keep retrying by
ourselves… There's nothing to do yet — if it's still failing in a few hours, we'll tell you."* For
a mismatch that is a lie in three ways: we are not retrying usefully, it will never resolve itself,
and there is exactly one thing to do. And `BankSyncConfigView.coverageWarning` is rendered
**nowhere in `applications/web/src`** (verified by grep), so the warning text alone buys the
treasurer nothing. Given the user's accepted risk is explicitly conditioned on visibility, the
ladder gets a seventh rank `'account_mismatch'` with its own copy and its own remedy. The two
unions still do not merge: `BankSyncTestStatus` answers "what did this one click find",
`BankSyncStatusCode` answers "what is the state of automatic importing"; they now share a literal
*name* and nothing else — no import, no derivation, no mapping function between them.

**The `bank_sync_config.iban` column stays unused.** Caching Fio's IBAN there would add a write on
every successful poll for a column nothing reads, and a stale cache is strictly worse than the live
`statement.info.iban` both call sites already hold. Not added, not removed. `docs/database.md:1970`'s
note gets one clause saying the cross-check is live, never cached.

**Shared comparison home:** a new pure server module
`applications/server/src/services/bankSyncAccount.ts` — both consumers are server-side, and the
rule that must never drift is not "normalise a string" but "either side absent => no verdict",
which needs the `BankSyncConfig` row; putting the string half in domain `CzIban` would split one
rule across two packages for no consumer.

## Consumer audit (corrected)

No `switch` on `BankSyncTestStatus` exists anywhere; nothing in `applications/bot/` reads either
union; no web hook/mutation reads `result.ok`. Exhaustive `Record`s that fail the build by design:
`TEST_RESULT_META` (test union) and `FioStatusBadge.STATUS_META` (ladder union).
**`FioStatusBlock.tsx`'s `switch` has `default: statusAlert = null`** — a new rank renders *nothing*
there with no compile error. That case must be added deliberately.

| Site | Change |
|---|---|
| `packages/domain/src/api/BankSyncApi.ts:105` | `BankSyncTestStatus` literal + `accountIban` doc |
| `packages/domain/src/models/BankSyncConfig.ts:17` | `BankSyncStatusCode` literal (7th rank) + comment |
| `applications/server/src/services/bankSyncAccount.ts` | **new** — `configuredIbanOf`, `isAccountMismatch` |
| `applications/server/src/services/bankSyncStatus.ts` | rule 2.5 |
| `applications/server/src/services/BankSyncPoller.ts` | the ingestion guard |
| `applications/server/src/repositories/BankSyncConfigRepository.ts` | `recordAccountMismatch` |
| `applications/server/src/api/bank-sync.ts:126/192/655/890` | verdict + gated tap + reuse helper |
| `applications/web/src/lib/finance/bankTestStatus.ts:28` | new `Record` entry |
| `applications/web/src/components/molecules/FioStatusBadge.tsx:24` | new `Record` entry |
| `applications/web/src/components/organisms/bank/FioStatusBlock.tsx:88` | new `case` |
| `applications/web/src/components/organisms/bank/FioTestResultAlert.tsx` | new branch, new prop, two stale comments |
| `applications/web/src/components/organisms/team-settings/FioBankCard.tsx` | new prop, dirty-account gate |
| `applications/web/src/components/organisms/team-settings/fioBankForm.ts` | `fioAccountChanged` |
| tests / i18n / docs | sections 9-11 |

## 1. Domain

**`packages/domain/src/api/BankSyncApi.ts`**
- Add `'account_mismatch'` to `BankSyncTestStatus`, after `'ok'`.
- Extend the block comment: a SUCCESSFUL Fio call whose `info.iban` does not match the IBAN computed
  from the configured account; `ok: false` because the poller refuses to ingest under this
  condition. Note it shares a name with the `BankSyncStatusCode` rank but nothing else — the probe
  union is still a single-attempt verdict.
- `accountIban` doc (125-127): "`Some` when `status` is `'ok'` or `'account_mismatch'` and Fio
  supplied it. Compared server-side against the configured account (`CzIban.buildCzIban`); the
  `account_mismatch` verdict IS that comparison."

**`packages/domain/src/models/BankSyncConfig.ts:17`**
- Add `'account_mismatch'` to `BankSyncStatusCode`, between `'misconfigured'` and `'invalid'`
  (declaration order mirrors ladder order).
- Comment: seven ranks now; `account_mismatch` outranks `invalid` because the token is demonstrably
  alive — the account is wrong. Set by the poller via `last_error_code = 'account_mismatch'`,
  terminal until a human edits the config.

## 2. Server — `applications/server/src/services/bankSyncAccount.ts` (new)

```ts
/**
 * The one definition of "this token reads someone else's account", shared by the read-only probe
 * (`api/bank-sync.ts`) and the hourly poller (`services/BankSyncPoller.ts`). Pure, no Effect —
 * same shape as `services/bankSyncStatus.ts`.
 */
import type { BankSyncConfig } from '@sideline/domain';
import { CzIban } from '@sideline/domain';
import { Option } from 'effect';

/** The IBAN the club typed, as `toConfigView` already computes it (`api/bank-sync.ts:192`). */
export const configuredIbanOf = (
  config: BankSyncConfig.BankSyncConfig,
): Option.Option<string> =>
  Option.flatMap(config.account_number, (accountNumber) =>
    Option.flatMap(config.bank_code, (bankCode) =>
      CzIban.buildCzIban({
        prefix: Option.getOrUndefined(config.account_prefix),
        accountNumber,
        bankCode,
      }),
    ),
  );

// Fio's `info.iban` is free text off the wire (`fioColumns.ts:294`) and may arrive spaced or
// lower-cased; ours never is.
const normalise = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase();

/**
 * `true` ONLY when both IBANs are present and differ. Either side absent (account not configured,
 * `buildCzIban` declined, Fio sent no iban) means no comparison is possible — and an unanswerable
 * question must never become an accusation, because this verdict halts ingestion.
 */
export const isAccountMismatch = (
  config: BankSyncConfig.BankSyncConfig,
  fioIban: Option.Option<string>,
): boolean =>
  Option.getOrElse(
    Option.zipWith(configuredIbanOf(config), fioIban, (a, b) => normalise(a) !== normalise(b)),
    () => false,
  );
```

`Option.zipWith` precedent: `repositories/TeamMembersRepository.ts:631`. It is data-first only in
`effect@4.0.0-beta.40` — the call shape above is the only one that compiles.

## 3. Server — ladder `applications/server/src/services/bankSyncStatus.ts`

Insert as rule 2.5, immediately after the `misconfigured` rule and before
`if (Option.isNone(input.lastErrorCode)) return 'ok'`:

```ts
// 2.5 — account_mismatch: the poller halted ingestion because Fio's `info.iban` does not match
// the IBAN computed from the configured account. Outranks `invalid`: the token demonstrably
// works, it just reads the wrong account, and telling the treasurer to replace it is the wrong
// instruction. Terminal — no retry count and no elapsed time can clear it, only a config edit.
if (Option.contains(input.lastErrorCode, 'account_mismatch')) return 'account_mismatch';
```

`Option.contains` precedent: `api/bank-sync.ts:206`. No new field on `BankSyncStatusInput` — the
existing `lastErrorCode` carries it. Header comment "Six-rank ladder" -> seven.

## 4. Server — repository `BankSyncConfigRepository.ts`

New query + method beside `recordCoverageGapQuery` (:249), which is the precedent for "a failure
kind that also writes its own warning text":

```ts
// A mismatch is a Fio SUCCESS we refuse to ingest. `recordSuccess` is therefore wrong (it clears
// `last_error_code`, which alone ranks the card `ok` — a silently halted import), and plain
// `recordFailure` loses the human-readable reason support needs. One UPDATE, so the error code
// and the warning can never disagree. Backoff is deliberate: nothing changes until a human edits
// the config, and a successful `/bank-sync/test` afterwards clears it (`clearPollBackoff`).
const recordAccountMismatchQuery = SqlSchema.void({
  Request: Schema.Struct({ team_id: Team.TeamId, warning: Schema.String }),
  execute: (input) => sql`
    UPDATE bank_sync_config
    SET last_synced_at = now(), last_error_code = 'account_mismatch', last_error_at = now(),
        coverage_warning = ${input.warning},
        consecutive_failure_count = consecutive_failure_count + 1,
        next_attempt_at = now()
          + (LEAST(POWER(2, consecutive_failure_count + 1), 24)::text || ' hours')::interval,
        updated_at = now()
    WHERE team_id = ${input.team_id}
  `,
});
```

Export `recordAccountMismatch(teamId, warning)` alongside `recordFailure`. Never `recordSuccess`.
The warning carries both IBANs (club banking identifiers, printed on every QR code — not secrets);
**never** the token or a URL (D10).

## 5. Server — the poller guard `services/BankSyncPoller.ts`

`fetchAndIngest` computes the verdict once and gates both writes:

```ts
Effect.bind('statement', ({ client }) => client.fetchPeriod({ ... })),
// One computation, one source of truth for the whole cycle.
Effect.let('mismatch', ({ statement }) => isAccountMismatch(config, statement.info.iban)),
Effect.tap(({ statement, mismatch }) =>
  mismatch ? Effect.void : deps.txRepo.upsertMany(config.team_id, statement.movements.map(...)),
),
Effect.tap(({ statement, mismatch }) =>
  mismatch ? Effect.void : deps.configRepo.upsertStatementPeriod({ ... }),
),
Effect.map(({ statement, mismatch }) => ({ statement, mismatch })),
```

`upsertStatementPeriod` is gated too: a period row from a foreign account poisons
`deriveBalanceBefore` and the D13 continuity check with balances no ingested movement can ever
explain.

`runTeamCycle`'s success arm branches once, leaving every `catchTag` below untouched:

```ts
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
            Effect.tap(() => (window.coverageGap ? deps.configRepo.recordCoverageGap(...) : Effect.void)),
            Effect.tap(() => matchIngested(config, deps, statement.movements.map((m) => m.fioMovementId))),
          ),
    ),
    Effect.asVoid,
    // …every existing catchTag unchanged…
  ),
```

The coverage-gap tap moves inside the non-mismatch branch on purpose — it writes
`last_error_code = 'coverage_gap'` and would otherwise clobber the mismatch code and its warning in
the same cycle.

Module-local warning builder (keeps the SQL call readable, one place to audit for D10):

```ts
const accountMismatchWarning = (config, statement): string =>
  `Fio's token reads ${Option.getOrElse(statement.info.iban, () => '?')} but this team is configured as ${Option.getOrElse(configuredIbanOf(config), () => '?')}. Ingestion halted; fix the account number or the token.`;
```

(Both `Option`s are `Some` whenever `isAccountMismatch` is true; the `'?'` fallbacks exist only so
the builder is total.)

## 6. Server — the probe `api/bank-sync.ts`

- Delete the inlined IBAN expression in `toConfigView` (192-200):
  `const computedIban = configuredIbanOf(config);`. The identical copies at 1393 (PDF) and 1563
  (SPAYD) are left alone — out of scope, keeps the diff reviewable.
- `probeFio` (655) gains a third parameter `config: BankSyncConfig.BankSyncConfig` (not the
  pre-computed Option — `isAccountMismatch` takes the row). One call site, line 890:
  `onSuccess: (token) => probeFio(teamId, token, config)`.
- Gate the backoff tap and produce the verdict:

```ts
// `clearPollBackoff` un-sticks the exponential poll backoff. On a MISMATCH the backoff is the
// poller's deliberate state (it halted ingestion and set it), so clearing it here would send the
// poller straight back to a config it is going to refuse again in an hour — and would erase the
// evidence. Cleared only when the probe is genuinely green, which is also the remedy loop: fix
// the account number, press Test, get `ok`, backoff cleared, next hourly poll ingests.
Effect.tap((statement) =>
  isAccountMismatch(config, statement.info.iban)
    ? Effect.void
    : configRepo.clearPollBackoff(teamId).pipe(
        Effect.tap(() =>
          Effect.logInfo('bank-sync/test: cleared poll backoff after a probe success').pipe(
            Effect.annotateLogs({ teamId }),
          ),
        ),
      ),
),
Effect.map((statement) =>
  testResult(
    isAccountMismatch(config, statement.info.iban) ? 'account_mismatch' : 'ok',
    statement.info.iban,
  ),
),
```

`isAccountMismatch` is pure and called twice with the same arguments — cheaper than threading a
tuple through the pipe. Everything else in `probeFio` is untouched: no `recordSuccess`, no
`recordFailure`, no other write, and D10 holds (only Fio's own `info.iban`, already on the wire
today, enters the response).

## 7. Web

**`src/lib/finance/bankTestStatus.ts`** — new entry (doc comment "seven outcomes" -> eight):

```ts
account_mismatch: {
  Icon: ShieldAlert,
  variant: 'destructive',
  title: () => tr('fio_test_accountMismatchTitle'),
  body: () => tr('fio_test_accountMismatchBody'),
},
```

`ShieldAlert` import goes **after** `ServerCrash` (alphabetical). Reusing `AlertTriangle` would make
two distinct destructive verdicts look identical at a glance.

**`src/components/molecules/FioStatusBadge.tsx`** —
`account_mismatch: { Icon: ShieldAlert, labelKey: 'fio_status_accountMismatchTitle', variant: 'destructive' }`.

**`src/components/organisms/bank/FioStatusBlock.tsx`** — new `case 'account_mismatch'` before
`case 'invalid'`. `variant='destructive'`, `data-bank-sync-status='account_mismatch'`,
`ShieldAlert`, title `fio_status_accountMismatchTitle`, body `fio_status_accountMismatchBody`, and —
matching the `invalid` case's shape — a `<Button onClick={onReplaceToken}>{tr('fio_token_replace')}</Button>`.
**Do not leave this to the `default: null` arm**; the rank would render an empty block.

**`src/components/organisms/bank/FioTestResultAlert.tsx`**
- Prop: `readonly configuredIban: string;` — required, no null arm. The server cannot emit
  `account_mismatch` without a configured IBAN, and the Test button is disabled when
  `config === null` (`FioBankCard.tsx:229`).
- Doc comment (13-16): delete "no IBAN comparison (that is a follow-up ticket)". The comparison is
  the server's; this component renders both IBANs so the treasurer can see which is which,
  `configuredIban` coming from `BankSyncConfigView.computedIban`, never a second wire field.
- **Fix the stale a11y claim in the same comment (19-20):** the parent is NOT `role='status'`.
  `FioBankCard.tsx:253-260` deliberately uses a bare `aria-live='polite' aria-atomic='true'` div — a
  second `role='status'` on the settings page made `page.getByRole('status')` ambiguous and broke
  two specs in `e2e/tests/onboarding-settings.spec.ts`. Say that, since it is the reason
  `role='presentation'` here is load-bearing.
- New block after the `status === 'ok'` IBAN line:

```tsx
{result.status === 'account_mismatch' && Option.isSome(result.accountIban) && (
  <p className='tabular-nums'>
    {tr('fio_test_accountMismatchAccounts', {
      fioIban: result.accountIban.value,
      configuredIban,
    })}
  </p>
)}
```

No `text-muted-foreground` (the `destructive` variant already sets the description colour);
`tabular-nums` so the two IBANs align digit-for-digit; IBANs print raw, as everywhere else in the
app.
- Extend the existing "Replace token" CTA condition from `status === 'invalid'` to
  `status === 'invalid' || status === 'account_mismatch'`. Do NOT add the `ib.fio.cz` link on the
  new status — the token is valid, creating another one is not the headline fix.

**`src/components/organisms/team-settings/FioBankCard.tsx`**
- `Option` is already imported (line **3**).
- Hoist the baseline that `useCardForm` already receives, so the dirty-account check costs nothing:
  `const savedValues = fioBankFormFrom(config); const form = useCardForm(savedValues);`
  `const accountChanged = fioAccountChanged(savedValues, form.values);`
- **Test-button dead end (the remedy must actually work).** `handleRetryNow` (143-157) probes the
  *saved* config, and the button is disabled only on `tokenChanged` (:229). So today: fix the
  account field -> press Test -> `account_mismatch` again -> the treasurer concludes the fix didn't
  take. Add `accountChanged` to the disabled condition and render the hint on
  `tokenChanged || accountChanged`, exactly as the card already does for the token.
- Alert render (:263):

```tsx
{testResult && config && Option.isSome(config.computedIban) && (
  <FioTestResultAlert
    result={testResult}
    configuredIban={config.computedIban.value}
    onReplaceToken={handleReplaceToken}
  />
)}
```

(The `computedIban` guard is what makes the required prop honest; the button is already disabled
when `config === null`.)

**`src/components/organisms/team-settings/fioBankForm.ts`** — one pure export, co-located test
already exists (`fioBankForm.test.ts`):

```ts
/** The Test button probes the SAVED config, so an edited-but-unsaved account makes the verdict a
 * lie. Same reason `tokenChanged` already disables it. */
export const fioAccountChanged = (
  saved: FioBankFormValues,
  values: FioBankFormValues,
): boolean =>
  saved.accountPrefix !== values.accountPrefix || saved.accountNumber !== values.accountNumber;
```

## 8. i18n — `packages/i18n/messages/{en,cs}.json`

New, after `fio_test_okAccount`. **The prefix is the realistic false-mismatch surface** — Fio drops
it (`accountId: '2000145399'` for account `19-2000145399`, fixture `bankSync.test.ts:148`), so a
club that typed the account number with an empty prefix field gets a permanent mismatch, which now
halts imports. The copy names the prefix explicitly.

en:
- `fio_test_accountMismatchTitle`: `"The token belongs to a different account."`
- `fio_test_accountMismatchBody`: `"Fio accepted the token, but it reads a different account than the one saved here — so we've stopped importing rather than pull in someone else's payments. Check the account prefix and number below (Fio doesn't send the prefix back, so a missing one is the usual cause), or paste a token issued for the account you have saved."`
- `fio_test_accountMismatchAccounts`: `"Fio answered for {fioIban}; your settings say {configuredIban}."`
- `fio_status_accountMismatchTitle`: `"Importing is stopped — the token reads a different account."`
- `fio_status_accountMismatchBody`: `"Nothing is being imported and this won't fix itself. Check the account prefix and number in this card, or paste a token issued for the account you have saved, then test the connection."`

cs (vykání; "Fio" neuter, matching `fio_test_okTitle`):
- `fio_test_accountMismatchTitle`: `"Token patří k jinému účtu."`
- `fio_test_accountMismatchBody`: `"Fio token přijalo, ale čte jiný účet, než jaký je tu uložený — načítání jsme proto zastavili, ať do klubu netaháme cizí platby. Zkontrolujte níž předčíslí a číslo účtu (Fio předčíslí neposílá zpátky, takže chybějící předčíslí bývá nejčastější příčinou), nebo vložte token vydaný k uloženému účtu."`
- `fio_test_accountMismatchAccounts`: `"Fio odpovědělo za účet {fioIban}, v nastavení je {configuredIban}."`
- `fio_status_accountMismatchTitle`: `"Načítání je zastavené — token čte jiný účet."`
- `fio_status_accountMismatchBody`: `"Nic se nenačítá a samo se to nespraví. Zkontrolujte v této kartě předčíslí a číslo účtu, nebo vložte token vydaný k uloženému účtu, a pak otestujte spojení."`

Replace `fio_test_unsavedTokenHint` with `fio_test_unsavedHint` (one call site, so no net key
growth, and the name stops lying now that it covers the account too):
- en: `"Save the settings first — the test checks the saved account and token."`
- cs: `"Nejdřív uložte nastavení — test ověřuje uložený účet a token."`

## 9. Tests

### A. Pure unit — `applications/server/test/bankSyncAccount.test.ts` (new)

Plain `vitest`, no DB (sibling of `bankSyncStatus.test.ts`, `fioColumns.test.ts`).

1. match -> `false` (`2703474850/2010` vs `CZ7120100000002703474850`).
2. mismatch -> `true` (`1265098001/5500` vs `CZ7120100000002703474850`).
3. whitespace + lower case -> `false` (`'cz71 2010 0000 0027 0347 4850'`).
4. Fio iban `None` -> `false`.
5. `account_number`/`bank_code` `None` -> `false`.
6. **prefix-sensitivity**, the false-positive case the copy is written for: configured
   `2000145399/0800` with NO prefix vs Fio's `CZ6508000000192000145399` -> `true`. Documents that a
   missing prefix is a real mismatch, not a bug.
7. `configuredIbanOf` returns the same string `toConfigView` sends as `computedIban` for a prefixed
   account (`19` + `2000145399` + `0800` -> `CZ6508000000192000145399`).

### B. Ladder — `applications/server/test/bankSyncStatus.test.ts`

- New case: `lastErrorCode: Some('account_mismatch')` with `hasToken: true` -> `'account_mismatch'`,
  and it beats the `invalid` gate (same input with `consecutiveFailureCount: 5`, a 7-hour silence
  and `lastErrorCode: Some('account_mismatch')` still returns `'account_mismatch'`, not `'invalid'`).
- `lastErrorIsKeyMissing: true` still wins over it (rule 2 first).
- Update the "six ranks" comments at :20/:27/:35/:60/:63.

### C. Poller integration — `applications/server/test/integration/services/BankSyncPoller.test.ts`

**Precondition fix, same trap as the API suite:** `validStatement` (:72-92) carries
`iban: 'CZ6508000000192000145399'` while `seedTeam` (:121-129) uses `enableBankSync`'s default
account `2703474850/2010` -> `CZ7120100000002703474850`. With the guard live, **every** poller test
would halt ingestion. Change `validStatement.info` to `accountId: '2703474850'`, `bankId: '2010'`,
`iban: 'CZ7120100000002703474850'`, with a comment that the fixture statement must agree with
`enableBankSync`'s default account.

New tests:

1. **Mismatch halts ingestion.** Seed with `{ accountNumber: '1265098001', bankCode: '5500' }`,
   respond with `validStatement([oneTransaction])`. Assert:
   `SELECT count(*) FROM bank_transactions` is `0`; `SELECT count(*) FROM bank_statement_periods` is
   `0`; `last_error_code = 'account_mismatch'`; `coverage_warning` contains both IBANs and does NOT
   contain the token; `consecutive_failure_count = 1`; `next_attempt_at IS NOT NULL`;
   `last_success_at IS NULL`.
2. **Mismatch does not auto-match.** Same seed plus a member with a VS and an open assignment
   matching the movement's VS/amount: assert `payments` is empty. This is the ticket's actual harm.
3. **Matching account still ingests** (guard not inverted): default seed, one transaction, assert
   the row lands and `last_error_code IS NULL`. If an existing test already asserts exactly this
   after the fixture fix, extend it with a one-line comment instead of adding a case.
4. **No configured account -> ingests.** `{ enabled: false }` seed then
   `UPDATE bank_sync_config SET account_number = NULL, bank_code = NULL`; note `findPollable` must
   still pick the team up (check the query's `enabled` filter when writing it — if `findPollable`
   requires `enabled = true`, seed the row enabled and null the columns afterwards, or drive
   `fetchAndIngest` directly).

### D. API integration — `applications/server/test/integration/api/bankSync.test.ts`

**Precondition fix.** `validRawStatement` (:145) has the same divergence. Change `info` to
`accountId: '2703474850'`, `bankId: '2010'`, `iban: 'CZ7120100000002703474850'`, and **rewrite the
comment at :143-144** ("copied from `FioApiClient.test.ts`") to record the deliberate divergence:
this copy must agree with `enableBankSync`'s default account or every probe test becomes a mismatch
test; `FioApiClient.test.ts` and `fioColumns.test.ts` keep the `CZ65…` vector because no comparison
runs there.

**Exactly three existing assertions are exposed** (verified): T8 `:818`, T18 `:1001`, T21 `:1174`.
`T20_CASES` (:1086-1123) has no ok case. `T22_CASES`' `'ok (200)'` (:1252-1259) asserts only
`fioCalls === 1` and token/URL absence. T19 `:1034` runs `validRawStatement` through the probe but
asserts only `changedKeys`. T26's `'ok (T8 setup)'` would pass vacuously. Update T8's expected
`accountIban` to the new value.

**Do NOT touch** `applications/bot/test/rcp/finance/buildPaymentReminderEmbed.test.ts` or
`handlePaymentReminderReady.test.ts` — their `CZ6508000000192000145399` occurrences are independent
SPAYD strings with no relation to this fixture. Likewise `FioApiClient.test.ts`,
`BankSyncPoller.test.ts`'s *other* IBAN literals, and `fioColumns.test.ts`.

New cases in the `status mapping (T8-T14)` block:

1. **T8b — mismatch.** Seed `{ accountNumber: '1265098001', bankCode: '5500', fioTokenEncrypted }`;
   responder `validRawStatement`. Body exactly
   `{ ok: false, status: 'account_mismatch', message: null, accountIban: 'CZ7120100000002703474850' }`,
   `fioCalls === 1`.
2. **T8c — case/whitespace-insensitive.** Default seed;
   `info.iban = 'cz71 2010 0000 0027 0347 4850'` -> `status: 'ok'` (`optionalInfoString`, no shape
   validation).
3. **T8d — no configured account -> `ok`.** `{ enabled: false, fioTokenEncrypted }` (migration
   `1792000001:57` forbids `enabled = true` with a null account), then
   `UPDATE … SET account_number = NULL, bank_code = NULL`. Expect
   `{ status: 'ok', ok: true, accountIban: 'CZ7120100000002703474850' }`.
4. **T8e — Fio sent no iban -> `ok`.** Default seed, `info.iban` removed. Expect
   `{ ok: true, status: 'ok', message: null, accountIban: null }`.
5. **T8f — the probe writes NOTHING on a mismatch.** Modelled on T19, which diffs the whole row:
   mismatched seed,
   `UPDATE … SET last_error_code = 'too_many_movements', consecutive_failure_count = 2, next_attempt_at = now() + interval '2 hours', coverage_warning = 'x'`,
   snapshot `SELECT *`, probe, snapshot again. Assert `status: 'account_mismatch'` and `changedKeys`
   (excluding `updated_at`) is `[]` — in particular `next_attempt_at` is UNCHANGED, still ~`+2 h`.
   This is the test that fails if someone un-gates `clearPollBackoff`. Add the matching
   mismatched-seed sibling to T19's neighbourhood so the two read as a pair (green probe ->
   `['next_attempt_at']`, mismatch -> `[]`).

**T26**: add an `'account_mismatch (T8b setup)'` case **and** strengthen the shared body with
`expect(parsed.status).toBe(expectedStatus)` per case (the current body only checks
`ok === (status === 'ok')`, under which the new case would pass vacuously). If threading an expected
status through `T26_CASES` bloats the diff, drop the case instead — T8b already asserts the exact
body.

### E. Web — `applications/web/test/FioTestResultAlert.test.tsx`

1. `buildResult` default `accountIban`:
   `status === 'ok' || status === 'account_mismatch' ? Some(...) : None`. Every render now needs
   `configuredIban` (required prop) — give the helper a default.
2. `'omits the IBAN line for every non-ok status even when accountIban is (incorrectly) Some'`
   (:89-97): add `&& s !== 'account_mismatch'` with a one-line comment, **and** add a dedicated
   render asserting the IBAN line is absent for `account_mismatch` with `accountIban: None` —
   otherwise the filter silently deletes coverage.
3. `'renders a pairwise-distinct title for each of the seven status literals'` -> eight.
4. Rename `'does not call onReplaceToken for a status other than invalid (no CTA rendered)'` (:68) —
   it renders `'ok'` so it still passes, but the name becomes false once `account_mismatch` also
   shows the CTA.
5. **New:** both IBANs render on `account_mismatch` —
   `result={buildResult('account_mismatch', Option.some('CZ6508000000192000145399'))}`,
   `configuredIban='CZ7120100000002703474850'`; text contains both.
6. **New:** the "Replace token" CTA renders on `account_mismatch`, and the `ib.fio.cz` link does not.

### F. Web — `applications/web/src/components/organisms/team-settings/fioBankForm.test.ts`

`fioAccountChanged`: false for identical values; true when `accountNumber` differs; true when
`accountPrefix` differs (including `'' -> '19'`, the prefix case); false when only an unrelated
field (`recipientName`) differs.

`src/lib/staticTrKeys.test.ts` picks up the seven new keys and the deleted
`fio_test_unsavedTokenHint` automatically once the catalogue is rebuilt.

**No `FioStatusBlock`/`FioBankCard` render test** — neither has one today and adding jsdom
scaffolding for a `switch` arm is not worth it; the badge `Record` is compile-enforced and the
block's new `case` is covered by review + the `data-bank-sync-status` hook E2E already uses.

## 10. Docs

- `docs/api.md:6959,6970` — `BankSyncStatusCode` is now seven ranks; add `account_mismatch` with its
  meaning (poller halted ingestion, `last_error_code = 'account_mismatch'`, terminal until a config
  edit, outranks `invalid`).
- `docs/api.md:7051` — `accountIban` is `Some` when `status` is `'ok'` OR `'account_mismatch'`.
- `docs/api.md:7053` — add `'account_mismatch'` to the `BankSyncTestStatus` list: a successful probe
  whose `info.iban` differs (whitespace/case-insensitively) from the IBAN computed from
  `account_prefix`/`account_number`/`bank_code`; `ok` is `false`; no comparison and therefore `'ok'`
  when either IBAN is absent; note the probe does NOT clear the poll backoff on this verdict.
- `docs/database.md:1970` — the `iban` column is still never written; add that the cross-check is
  computed live from each statement, never cached, and that `last_error_code` can now be
  `'account_mismatch'`.
- Root `AGENTS.md` "Bank Sync (Fio)" invariant 3 — the probe is still read-only, but
  `clearPollBackoff` is now conditional: it fires on a green probe only, because a mismatch backoff
  belongs to the poller. Add a short fourth invariant (or a paragraph under 3) for the poller guard:
  a statement whose `info.iban` disagrees with the configured account is **not ingested at all**, and
  the condition is recorded via `recordAccountMismatch` (never `recordSuccess`) so the D11 ladder can
  show it. Note the known gap: `BankSyncBackfill.ts` is NOT guarded.
- Root `AGENTS.md` — append a new "Last Updated" entry for `fix/iban-cross-check` in the existing
  one-per-branch style (`AGENTS.md:885,887,889,893`).

## 11. Risks

- **Silent halt of a working club's imports** (accepted by the user). Mitigated by: the terminal
  `account_mismatch` rank with its own copy and CTA on the card; `Effect.logError` per affected team
  per cycle; the IBAN-bearing `coverage_warning` for support; and the "either side absent => no
  verdict" rule that makes an unanswerable comparison a no-op.
- **The prefix is the realistic false-mismatch surface.** `buildCzIban` returning `None` is
  effectively unreachable — `upsertBankSyncConfig` rejects non-building payloads
  (`bank-sync.ts:797-806`), the DB CHECKs are `account_number ~ '^[0-9]{2,10}$'` /
  `bank_code ~ '^[0-9]{4}$'` (migration `1792000001:15-17`), and the web form hardcodes
  `FIO_BANK_CODE` (`FioBankCard.tsx:117,194`). The one real trap is a club whose account has a
  prefix that was never typed into the prefix field: Fio does not return the prefix in `accountId`,
  our computed IBAN encodes it, and they will not match. Named explicitly in both copy keys and
  covered by unit test A.6.
- **Recovery latency.** A mismatch sets backoff up to 24 h and the probe no longer clears it. The
  intended loop is: fix the account -> the Test button (now enabled only once saved) -> `ok` ->
  backoff cleared -> next hourly poll ingests. If field reports show treasurers fixing the config
  without pressing Test, the follow-up is to clear `next_attempt_at` inside `upsertBankSyncConfig`
  when account fields change — deliberately not done here.
- **Backfill is NOT guarded.** `BankSyncBackfill.ts` ingests over a historic range and would still
  import a foreign account's movements if a treasurer starts one. Out of scope by the user's framing
  (the hourly poller is the harm); noted in the AGENTS entry as a known gap.
- **Old in-flight web bundle** decoding either new literal fails the success-schema decode: the card
  shows `fio_test_error` for the probe and the config load fails for the ladder rank. Fail-closed,
  never a false "fine".
- **`FioStatusBlock`'s `default: null`** will silently render nothing for the new rank if the `case`
  is forgotten.
- **Fixture divergence** in two suites (`bankSync.test.ts`, `BankSyncPoller.test.ts`) must land in
  the same commit or both suites go red for the wrong reason.

## 12. Build order

1. `packages/domain` changed -> `pnpm build` BEFORE server/web typecheck, or neither exhaustive
   `Record` error appears.
2. `packages/i18n/messages/*.json` changed -> `pnpm codegen` + `pnpm build` so
   `messagesByKey`/`messageKeys` pick up the seven new keys and drop `fio_test_unsavedTokenHint`;
   `staticTrKeys.test.ts` fails otherwise.
3. `pnpm install` before `pnpm format`/`pnpm lint` if anything was pulled.
4. Server integration suites run **serially** — overlapping runs deadlock and mimic real failures.
5. Root `AGENTS.md` "Last Updated" entry goes in the final commit of the branch.

## Deliberately skipped

Caching Fio's IBAN in the unused `bank_sync_config.iban` column; guarding `BankSyncBackfill`;
clearing the backoff on config save; a `FioStatusBlock` render test; collapsing the duplicate IBAN
expressions at `bank-sync.ts:1393`/`:1563`. Add the first when a second consumer needs the cached
value, the rest when field reports justify them.
