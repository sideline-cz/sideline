# Injectable instant for `eventStartCronEffect`

Bug — severity Medium, area Server. Branch `fix/event-start-cron-injectable-clock`.

Plan reviewed by two adversarial critique rounds; all arithmetic independently
verified with `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' })`.

---

## 1. Root cause: two **instants**, not two clocks

The ticket says "two clocks (JS vs Postgres)". That is a red herring — under the
default `Clock`, `Clock.currentTimeMillis` *is* `Date.now()`. The real defect:

> The test fixture samples the wall clock at `T0`, the cron samples it again at
> `T1`, and a date/time boundary can fall between the two samples.

That holds no matter where `T1` comes from. Two `new Date()` calls in
`EventStartCron.ts` (`:159`, `:204`) are **independent samples**, so the two
deferred sweeps can already disagree with each other inside one cycle.

### Where each instant is sampled

| Path | Source |
|---|---|
| `findEventsToStart` → `findStartable` (`start_at <= NOW()`) | Postgres |
| `startEvent` (`SET … = now()`, the arming stamps) | Postgres |
| `claimMissedRsvpCount` / `claimStartedPost` (`SET … = now()`) | Postgres |
| `markStalePersonalMessagesDirty` | Postgres |
| **deferred missed-RSVP sweep predicate** | **JS `new Date()` #1** (`EventStartCron.ts:159`) |
| **deferred "Dnes" post sweep predicate** | **JS `new Date()` #2** (`EventStartCron.ts:204`) |
| Integration fixtures (`localMidnight`, `localTimeOffsetClampedToDay`) | Postgres |

### The midnight straddle, concretely

`findAllDayEventsNeedingStartedPostStmt` (`EventsRepository.ts:414-421`) is
internally consistent *for one sample*:

```sql
AND ((${nowParam}::timestamptz) AT TIME ZONE tz)::date = (e.start_at AT TIME ZONE tz)::date
AND ((${nowParam}::timestamptz) AT TIME ZONE tz)::time >= COALESCE(ts.all_day_post_time, TIME '08:00')
```

The break is *between* samples: the fixture calls `localMidnight(tz, 0)` at
`T0 = 23:59:59.7` local → `start_at` = local midnight of day **D**; the cron
calls `new Date()` at `T1 = 00:00:00.4` local, day **D+1**; `(D+1) = D` is false.
Case 4 asserts `emitted === 1`, gets `0`.

### The DST fall-back, concretely

Prague fall-back runs the local wall clock `02:59:59 CEST → 02:00:00 CET`.
`::date` is fold-insensitive (the fold sits inside one calendar day); `::time`
**moves backwards one hour**. A fixture computing `now_local − 30 min = 02:20` at
02:50 CEST, followed by a cron sample at 02:00 CET, reads `02:00 < 02:20` →
"future" → case 4 red.

### ⚠ This changes ZERO production behaviour

The production wrapper still reads `new Date()` at exactly the point the current
code does. The only production delta: a cycle takes **one** sample instead of
two, so the two sweeps can no longer disagree with each other. Production skew
was already harmless — app↔DB skew is NTP-bounded, every affected predicate is
open-ended, and both sweeps are idempotent via their claim guards.

**This is a test-determinism refactor plus a small tidy-up, not a production bug
fix.** The commit message, PR description and AGENTS.md rewrite must say so.

---

## 2. Mechanism: explicit `now: Date` parameter

```ts
export const makeEventStartCronEffect = (now: Date) => Effect.Do.pipe(/* body, using `now` */);

export const eventStartCronEffect = Effect.suspend(() => makeEventStartCronEffect(new Date()));
```

`Effect.suspend: <A,E,R>(effect: LazyArg<Effect<A,E,R>>) => Effect<A,E,R>`
(`effect/dist/Effect.d.ts:1513`) preserves the type exactly, and
`Effect<A,E,R>` declares `asEffect()` (`:170`), so `EventStartCron` (`:282`) and
`run.ts:165` (`EventStartCron.asEffect()`) compile **unchanged**. Repository
signatures already take `Date` (`EventsRepository.ts:1286`, `:1292`) — no
repository change at all.

### Why not Effect `Clock` + `TestClock`

1. `@effect/vitest`'s `it.effect` auto-provides `TestClock.layer()` starting at
   **epoch 0**. A `Clock`-based cron would read `1970-01-01` in every existing
   `it.effect`, forcing the source change and the whole test rewrite into one
   indivisible commit.
2. **This repo has a twice-reproduced, documented `TestClock` × `@effect/sql`
   deadlock** — `test/integration/services/BankSyncPoller.test.ts:536-546` ("a
   `SqlSchema` call chained ahead of the later `Effect.sleep`, all inside ONE
   forked fiber, leaves that sleep permanently unresolved no matter how far the
   virtual clock is pushed forward") and `FioApiClient.test.ts:312-326`. Both
   escape via `TestClock.withLive`. `TestClock.setTime` is not inert — it forks a
   fiber and awaits it. Putting that around real pg I/O walks into a hazard this
   codebase has already paid for twice.
3. The `Clock` precedent that exists (`WeeklySummaryCron`, `RulesQuizCron`,
   `TrainingClaimEmitter`) does not cover this case: `grep -rn TestClock
   applications/server/test/services/` returns nothing — none of those crons has
   a real-DB integration suite exercising its `now`.

### Why not `Context.Tag` clock, or `COALESCE(${nowParam}, now())`

A `Context.Tag` is a hand-rolled re-implementation of `Clock`, needing a layer at
every consumer, with no benefit over a plain parameter.

`COALESCE(${nowParam}::timestamptz, now())` (cron reads the DB clock) unifies the
clock *source* but leaves the `T0`→`T1` straddle window **identical**, and makes
the instant non-injectable — the one thing we actually need. Mention as
considered-and-rejected in the PR; do not implement.

### What this fixes, and what it does not

**Fixes:** one instant per cycle, *structurally* — the signature makes a second
sample site impossible; the instant becomes injectable; Task 1 lands
independently of the test rewrite; no virtual clock anywhere near pg I/O.

**Does NOT fix alone:** it does not unify the injected instant with Postgres
`now()`. **Task 2 is therefore mandatory** — the integration test must stop
calling `SELECT now()` in fixtures and derive every timestamp from the same
literal it passes to `makeEventStartCronEffect`.

**Deliberately unchanged — the flip path.** `findEventsToStart`'s
`start_at <= NOW()` and `startEvent`'s `SET … = now()` arming stamps are both
Postgres and already agree with each other inside one statement. Do **not** make
`findEventsToStart` injectable — splitting that pair across two instants would be
a real regression.

---

## 3. Task list

### Task 1 — Parameterise the instant *(independently landable)*

`applications/server/src/services/EventStartCron.ts`

1. Rename the export at `:8`, wrap the body in an arrow taking `now: Date`.
2. `:159` — `findAllDayEventsPastLastLocalDay(new Date())` → `(now)`.
3. `:204` — `findAllDayEventsNeedingStartedPost(new Date())` → `(now)`.
4. Keep `withCronMetrics('event-start')` as the last element **inside** the
   factory, so both entry points stay instrumented. (It is a plain effect
   transformer reading a module-level metric — rebuilding it per cycle is free.)
5. Add the wrapper. `Effect.suspend` is **load-bearing**: without it the instant
   freezes at module-load time.
6. `:282` and `run.ts:165` unchanged.

Docblock must record: `now` drives **only** the two deferred sweeps; the flip
path deliberately stays on the Postgres clock; taking `now` as a parameter makes
"one instant per cycle" structural; and it keeps `TestClock` out of the
integration suite (cross-reference the two deadlock comments).

Constraints: `Effect.Do.pipe` only, no `Effect.gen` (`AGENTS.md:230-234`); no
cast, no `any` (`AGENTS.md:238`).

### Task 2 — One pinned instant in the integration test

`applications/server/test/integration/services/EventStartCron.deferred.test.ts`

1. Import `makeEventStartCronEffect`. **No `TestClock` import.**
2. Module constant + header block:

```ts
const FIXED_NOW = new Date('2025-10-15T10:00:00.000Z'); // = 2025-10-15 12:00 Prague (CEST)
```

   Permanently past, so it cannot rot; far from Prague's 2025 fall-back (26 Oct).
   The header must list **what still reads the REAL database clock** —
   `findEventsToStart`/`findStartable`, `startEvent`, `claimMissedRsvpCount`,
   `claimStartedPost`, `markStalePersonalMessagesDirty` — and state that mixing a
   2025 `FIXED_NOW` with a real 2026+ DB clock is sound **only because
   `findStartable` has no lower bound** (`WHERE status='active' AND start_at <=
   NOW()`, `EventsRepository.ts:330-337`). That is load-bearing and currently
   undocumented: if a lower bound is ever added, every case here breaks.
   Also: claim stamps land at real time, so never assert a stamp's **value** —
   only NULL / not-NULL, as the existing cases do.

3. Replace `runCron` (`:245`), dropping the inner `Effect.provide(TestLayer)` —
   all 14 call sites sit inside `Effect.tap` within a pipeline that already ends
   in `Effect.provide(TestLayer)`, so the inner provide only rebuilt a second
   `TestPgClient` pool per run:

```ts
const runCronAt = (now: Date) => makeEventStartCronEffect(now);
const runCron = () => runCronAt(FIXED_NOW);
```

4. **Delete `localTimeOffsetClampedToDay` (`:255-289`) and its ~25-line
   docblock** (`:246-270`) — it documents the two-instant problem being removed.
5. **Rewrite `localMidnight` (`:291-300`)** to bind `FIXED_NOW.toISOString()` via
   the `sql` tagged template instead of `SELECT now()` (`AGENTS.md:1561`: pass
   the ISO string, cast in SQL). Comment that the local→UTC direction
   (`<date> AT TIME ZONE tz`) is ambiguous in general — a wall-clock value inside
   a DST fold maps to two instants, one inside a gap to none — and is safe here
   only because Prague transitions at 02:00/03:00 local, never midnight.
6. **Rule:** never let a boundary case fall through to
   `COALESCE(ts.all_day_post_time, TIME '08:00')`. Every case asserting anything
   about the "Dnes" post sets the column explicitly — *except* cases 8/8b, whose
   entire purpose is the no-`team_settings` fallback. Related trap to document on
   `setAllDayPostTime` (`:135`): it is a bare `UPDATE team_settings … WHERE
   team_id = …`, so it silently affects **zero rows** unless `setTeamTimezone`
   created the row first — a forgotten `setTeamTimezone` does not fail, it
   silently reverts the case to the 08:00 fallback.

#### Per-case edits

`localTimeOffsetClampedToDay` has **4 live call sites**, not 1. With `FIXED_NOW`
local `12:00:00`, and all three survivors anchored on `localMidnight(tz, 0)` =
`2025-10-14T22:00:00Z` → local date `10-15`, matching `FIXED_NOW`'s local date:

| Case | Line | Change |
|---|---|---|
| 1 (timed flip) | `:306` | `new Date(Date.now() - 60_000)` → `DateTime.makeUnsafe('2025-10-15T09:00:00Z')` |
| 2 (midnight flip, quiet) | `:374` | `localTimeOffsetClampedToDay(tz, 60)` → `'23:00:00'` (future) |
| §7.12 3 (future post time) | `:621` | `localTimeOffsetClampedToDay(tz, 30)` → `'23:00:00'` (future) |
| §7.12 4 (past post time) | `:656` | `localTimeOffsetClampedToDay(tz, -30)` → `'01:00:00'` (past) |
| **8b (no settings, fallback fires)** | `:779` | **delete** the `nowLocal` bind and the whole `if (nowLocal >= '08:00:05') … else if (nowLocal < '07:59:55')` guard (`:797-807`) → plain `expect(emitted).toBe(1)`. 12:00 Prague is unconditionally past the 08:00 fallback. Delete the guard-band comment. |
| 3/4, 5, 6, 7, 8, 9, 11 | — | no change beyond the `localMidnight` rewrite |

Case 9's `2020-01-01` is still outside `FIXED_NOW − 7 days` — leave it.

7. Update the file header (`:24-34`): keep the "KNOWN GAP" paragraph; the
   two-instant caveat previously embedded in the deleted helper's docblock is
   replaced by the `FIXED_NOW` block.

### Task 3 — Unit coverage

`applications/server/test/services/EventStartCron.test.ts` — new `describe`.

Add capture arrays to `resetStores()` (`:79-88`) and record `now` in the two
stubs (`:112`, `:114`). Adding a `now: Date` param does **not** break the 11
existing `() => Effect.succeed([])` overrides — `() => X` is assignable to
`(now: Date) => X`.

| # | Style | Test | Assertion | Differential value |
|---|---|---|---|---|
| **U1** | `it.effect` | `makeEventStartCronEffect passes its argument verbatim to both deferred sweeps, as ONE instant` | both arrays `[0].toISOString() === '2025-10-15T10:00:00.000Z'`, **and `expect(nowA).toBe(nowB)` — reference identity** | Guards against reintroducing `new Date()` in the body. The identity half is **the honest pre/post differential**: `Effect.suspend` evaluates `new Date()` exactly once, so both sweeps get the *same object*; two separate `new Date()` calls produce two distinct objects even at the same millisecond → deterministically red before the fix. No fake timers needed. |
| **U2** | plain `it` + `vi.useFakeTimers({ toFake: ['Date'] })` | `each run re-samples: the instant is not frozen at module load` | `setSystemTime(T1)`, run, `setSystemTime(T2)`, run → captured `[0]` is `T1`, `[1]` is `T2` | Deterministically red against `export const eventStartCronEffect = makeEventStartCronEffect(new Date())`. This is what `Effect.suspend` buys. **Requires `afterEach(() => vi.useRealTimers())`** — a leaked fake `Date` into a subsequent `it.effect` is a nasty cross-test failure. |

**Dropped from earlier drafts.** A separate "both sweeps get the same instant
under fake timers" test is *worthless*: with time frozen and nothing yielding to
the timer queue between the sweeps, two independent `new Date()` calls return the
identical millisecond, so it passes before and after. Its intent is fully served
by U1's reference-identity assertion. Likewise a "flipped this cycle isn't swept
by the same cycle" unit test is **tautological** in this harness — the sweep mocks
are all `() => Effect.succeed([])`, so it would assert only that the test handed
them `[]`. That invariant is SQL-enforced (`… IS NULL` + the claim guards) and is
already covered by integration case 11.

### Task 4 — `eventAllDayAnchor.test.ts` case 9: one line

`applications/server/test/api/eventAllDayAnchor.test.ts:520`

```diff
-      createPayload({ title: 'Tournament', startAt: '2026-09-16T12:00:00Z' }),
+      createPayload({ title: 'Tournament', startAt: '2030-09-16T12:00:00Z' }),
```

**Pure date rot, unrelated to the cron clock** — the two items happened to go red
in the same CI run. `createPayload` defaults `allDay: true` → `anchorAllDay`
stores `2026-09-15T22:00:00Z`; the PATCH handler gates on
`!eventAcceptsRsvp(existing, existing.timezone, DateTime.nowUnsafe())`
(`src/api/event.ts:437-439`), requiring `now < 2026-09-16T22:00:00Z`. Today is
2026-09-17, so every PATCH 400s. Reproduced: 12 pass, 1 fails with
`expected undefined to be '2026-09-15T22:00:00.000Z'`.

Case 9 reads `created.startAt` rather than hard-coding the literal, so no expected
value changes. **Do not add a `vi.useFakeTimers` harness** — `2026-09-16` is the
lone outlier (every other PATCH-driving case already uses `2030-*`:
`:460, :487, :537, :551, :566`), and a 5-line harness for a one-character rot
would add a tripwire via `expires_at: DateTime.nowUnsafe()` at `:149`.

### Task 5 — Documentation

`applications/server/AGENTS.md`

Rewrite **"Clock-Derived Time-Of-Day Fixtures Must Be Clamped Into The Local
Day"** (`:2106-2119`) — retitle to something like *"A Cron's Test Fixtures And
The Cron Must Share ONE Instant"*:

- **Rules 1-2** (the clamp, `'24:00:00'` saturation, sign-only) describe a helper
  that no longer exists → replace with: pass the instant into the cron as a
  parameter; pin one permanently-past literal; derive every fixture timestamp
  from it as a bind parameter; never `SELECT now()` in a fixture for a cron whose
  instant is injectable.
- **Rule 3** ("two clocks… keep offsets ≥ 1 minute… ≥ 5-second guard band") is
  now false → replace with the "two **instants**, not two clocks" framing, plus
  the explicit **no production behaviour change** statement.
- **Rule 4** (*never write a one-sided `if (x >= boundary) expect(…)` guard* — it
  silently asserts nothing over the complementary window) — **KEEP VERBATIM.**
  Mechanism-independent; it is the rule that produced case 8b's guard band, and
  it is now trivially satisfiable rather than merely aspirational.
- **Rule 5** ("closing that gap requires an injectable instant… which does not
  exist today") is now false → point at `makeEventStartCronEffect` and
  `FIXED_NOW`'s header block.
- **New rule:** never let a boundary case fall through to a
  `COALESCE(<column>, <literal>)` default; set the column explicitly, and
  remember a bare `UPDATE … WHERE team_id = …` silently affects zero rows if the
  settings row does not exist.
- **New rule:** do not reach for `effect/testing/TestClock` in a DB-backed
  integration test — cross-reference the two reproduced deadlocks.

Cron table entry for `EventStartCron` (`:1124`): the deferred sweeps take an
**injected instant**; the flip reads Postgres `NOW()`; `findStartable`'s missing
lower bound is load-bearing for the integration fixtures.

### Ordering

Task 1 is **independently landable** — the existing integration test keeps
calling `eventStartCronEffect`, which behaves byte-identically. Tasks 2 and 3
depend on Task 1. Tasks 4 and 5 are independent. No forced single commit.

---

## 4. Regression test spec

### Verified local-date arithmetic

Computed with `Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' })`
(matches Postgres `AT TIME ZONE 'Europe/Prague'`), independently confirmed twice.
Prague is CEST (UTC+2) through `2025-10-26T01:00:00Z`, then CET (UTC+1).

```
FIXED_NOW                                  2025-10-15T10:00:00Z -> 2025-10-15 12:00:00
A/B fixture start (local midnight 26 Oct)  2025-10-25T22:00:00Z -> 2025-10-26 00:00:00
I1 probe                                   2025-10-25T21:59:59Z -> 2025-10-25 23:59:59
I2/I3 probe                                2025-10-25T22:00:00Z -> 2025-10-26 00:00:00
I4 probe (pre-fold)                        2025-10-26T00:30:00Z -> 2025-10-26 02:30:00
I5 probe (post-fold)                       2025-10-26T01:30:00Z -> 2025-10-26 02:30:00
I6 probe                                   2025-10-25T23:30:00Z -> 2025-10-26 01:30:00
C fixture start (local midnight 24 Oct)    2025-10-23T22:00:00Z -> 2025-10-24 00:00:00
I7 probe                                   2025-10-24T21:59:59Z -> 2025-10-24 23:59:59
I8/I9 probe                                2025-10-24T22:00:00Z -> 2025-10-25 00:00:00
```

I4 and I5 land on **the same local wall clock, 02:30 on 26 Oct** — the repeated
hour, which is the whole point of Group B.

The two sweeps' boundaries are **a full day apart**: for a single-day all-day
event starting at local midnight of day D, the "Dnes" post fires *during* D,
while the missed-RSVP sweep fires from midnight at the start of D+1. That is why
Groups A and C use different fixtures rather than sharing one.

### Framing — these are NOT "red before the fix" proofs

Before the fix the cron reads the real wall clock, so a 2025 fixture can never
match: every case expecting ≥ 1 is red for a trivial, uninformative reason, and
every case expecting 0 is green for the wrong reason. **These are post-fix
boundary pairs**, newly expressible because one instant now drives both the
fixture and the cron. The honest pre/post differential lives in U1 (reference
identity) and U2 (`Effect.suspend`).

All fixtures are permanently past, so they never rot. Every one is force-set
`status='started'` before the run, so `findEventsToStart` ignores it regardless of
the real DB clock. Every one sets `all_day_post_time` explicitly.

#### Group A — team-local-midnight boundary, "Dnes" post sweep

Fixture: all-day, `start_at = 2025-10-25T22:00:00Z` (local date **10-26**), tz
`Europe/Prague`, **`all_day_post_time = '00:00:00'`** (explicit — the 08:00
default would make I2 fail for an unrelated reason), `status='started'`,
`all_day_post_sent_at = NULL`.

| # | Name | Probe | Local | Date half | Time half | Expect |
|---|---|---|---|---|---|---|
| I1 | one second before team-local midnight → no post | `2025-10-25T21:59:59Z` | `10-25 23:59:59` | `10-25 ≠ 10-26` ✗ | — | `0` |
| I2 | exactly at team-local midnight → exactly one post | `2025-10-25T22:00:00Z` | `10-26 00:00:00` | ✓ | `00:00:00 >= 00:00:00` ✓ | `1`, stamp not null |
| I3 | re-run at the same instant does not duplicate | I2's probe ×2 | — | — | — | stays `1` (`claimStartedPost`) |

#### Group B — DST fall-back fold, "Dnes" post sweep

Same fixture, **`all_day_post_time = '02:20:00'`**. Transition
`2025-10-26T01:00:00Z`.

| # | Name | Probe | Local | Time half | Expect |
|---|---|---|---|---|---|
| I4 | 02:30 CEST, before the fold → posts once | `2025-10-26T00:30:00Z` | `10-26 02:30` | `>= 02:20` ✓ | `1` |
| I5 | 02:30 CET, the repeated hour → posts once, identically | `2025-10-26T01:30:00Z`, **fresh fixture** | `10-26 02:30` | `>= 02:20` ✓ | `1` — the local wall clock ran *backwards* an hour since I4, yet the predicate still holds: `::date` is fold-insensitive |
| I6 | 01:30 CEST, before the post time → no post | `2025-10-25T23:30:00Z` | `10-26 01:30` | `>= 02:20` ✗ | `0` — the negative half, satisfying AGENTS.md rule 4 |

#### Group C — team-local-midnight boundary, missed-RSVP sweep

Fixture: all-day, `start_at = 2025-10-23T22:00:00Z` (local date **10-24**), no
`end_at`, `status='started'`, `missed_rsvp_counted_at = NULL`, plus one member
holding the built-in `Player` role who has not RSVP'd (reuse `assignPlayerRole`,
`:220-240`). Predicate `(COALESCE(end_at, start_at) AT TZ)::date < (now AT TZ)::date`.
The 7-day bound holds at both probes (`I8`: `now − 7d = 2025-10-17T22:00Z` <
fixture `10-23T22:00Z`).

| # | Name | Probe | Local date | `10-24 < now_date`? | Expect |
|---|---|---|---|---|---|
| I7 | one second before team-local midnight → not yet swept | `2025-10-24T21:59:59Z` | `10-24` | false | `0`, stamp NULL |
| I8 | exactly at team-local midnight → swept once | `2025-10-24T22:00:00Z` | `10-25` | true | `1`, stamp not null |
| I9 | re-run at the same instant does not double-count | I8's probe ×2 | — | — | stays `1` (`claimMissedRsvpCount`) |
| I10 | the DST fold does not move the date boundary | fixture local date `10-25`; probes `2025-10-26T00:30:00Z` and (fresh fixture) `2025-10-26T01:30:00Z`, both local date `10-26` | — | true both | `1` each — asserts the date-only comparison is fold-insensitive; currently uncovered |

#### Group D — the ten existing cases

Assertions unchanged; only fixture *sources* change. All ten hand-checked against
`FIXED_NOW` (local `2025-10-15 12:00`, `localMidnight(d)` = local midnight of
`2025-10-(15+d)`, all CEST, all clear of the 26 Oct fold): every one still asserts
what it asserted before. Case 8b strengthens from a two-sided conditional to an
unconditional `expect(emitted).toBe(1)`.

**Case 8b consistency check:** `localMidnight('Europe/Prague', 0)` under
`FIXED_NOW` → `start_at = 2025-10-14T22:00:00Z` → local date `10-15`;
`findAllDayEventsNeedingStartedPostStmt` COALESCEs to `'Europe/Prague'` **and**
`TIME '08:00'`; `12:00:00 >= 08:00` and `10-15 = 10-15` → `toBe(1)` sound with no
`team_settings` row. `localMidnight`'s hardcoded `'Europe/Prague'` matching the
COALESCE default is exactly what makes it work. Case 8's `-2` →
`2025-10-12T22:00Z` → local date `10-13 ≠ 10-15` → `toBe(0)` still holds.

**Layers:** existing `TestLayer` (`:53-62`), `TestPgClient`, `cleanDatabase` in
`beforeEach` (`:64`). No new layer, no `TestClock`.

---

## 5. Sibling-test rot audit

### 🔴🔴 SILENT FALSE-GREEN on 2026-12-01 — `test/integration/api/teamSettingsReanchor.test.ts`

Three **negative** cases assert "the reanchor UPDATE left this row alone", each
with fixture `startAtIso: '2026-12-01T17:00:00Z'`:

| Line | Guard it exists to prove |
|---|---|
| `:735` / `:744` | `NOT e.series_modified` — a hand-edited occurrence is never clobbered |
| `:767` / `:776` | `e.status = 'active'` — a cancelled occurrence is never clobbered |
| `:838` / `:852` | `es.times_are_team_local` — a UTC-dialect series is a no-op |

On 2026-12-01 these fixtures fall into the past and `AND e.start_at >= now()`
(`src/api/team-settings.ts:380`) blocks the UPDATE on its own. All three keep
passing **for the wrong reason**, having silently stopped testing their guard.
Worse than a red test: deleting `NOT e.series_modified` from production would go
unnoticed. ~2.5 months of runway. → move to the sentinel year below.

### 🔴 GOES RED on 2026-12-01 — same file, `:697` / `:711`

The **positive** case, asserting `expect(after).toBe('2026-12-01T09:00:00.000Z')`.
Same guard; the UPDATE stops matching and the assertion flips red. → move to
`2099-12-01T17:00:00Z` (matching the far-future sentinel at
`test/EventRsvp.test.ts:247`) and **recompute** the two expected literals against
Postgres 17 — do not derive them mentally; it is a DST-sensitive double
`AT TIME ZONE` round trip. The comment at `:709-710` records the exact expression.
The "leaves a PAST occurrence untouched" case at `:799` correctly uses
`2020-01-01` — leave it.

### 🟡 INVERTS in June 2027 — `test/integration/repositories/EventsRepository.stale-personal-dirty.test.ts:217, 244, 270, 297, 322`

`createEvent(…, '2027-06-0N T14:00:00Z')` stands in for "upcoming" against
`markStalePersonalMessagesDirty`'s `status <> 'active' OR start_at < now()`. The
correct pattern is one line away at `:166` — `UPDATE events SET start_at = now() +
interval '${interval}'`. Convert the five literals to it.

### 🟢 Correct today — leave alone, cite as precedent

| File | Pattern |
|---|---|
| `test/Event.test.ts:278` | `daysFromNow(days)` + `localMidnight(offset)`, reason spelled out at `:271-277`. **Canonical relative-date precedent.** |
| `test/EventRsvp.test.ts:247, 269, 313, 1713` | `2099-12-31` sentinel. **Canonical far-future precedent.** |
| `test/EventRsvp.test.ts:1500-1631, 2708-2800` | `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`. **Canonical pinned-clock precedent for non-`it.effect` tests** — what U2 adopts. |
| `test/integration/repositories/EventsRepository.endedTrainings.test.ts` | Already drives the injectable `findEndedTrainingsForAutoLogAt(now)` (`EventsRepository.ts:1056`). **The shape Task 1 extends to the two sweeps.** |
| `test/services/EventStartCron.test.ts:25-26` | `2026-04-09` against a fully mocked repo — no `now` predicate. Harmless. |
| `test/rpc/EventGetEventEmbedInfo.test.ts:101` | `2027-08-01`; the file asserts no `canRsvp`/`canEdit`, so `eventAcceptsRsvp` is never evaluated. Harmless — add a one-line comment so the next auditor need not re-derive it. |
| `test/RecurrenceService.test.ts`, `test/utils/seriesOccurrence.test.ts`, `test/EventSeries.test.ts`, `test/ICalFeed.test.ts`, `…/EventsRepository.allDayDate.test.ts`, `…/allDayAnchored.test.ts`, `test/integration/migrations/*` | Pure functions / pure SQL projections. No `now` predicate. No rot. |

---

## 6. Edge cases

1. **`findStartable` has no lower bound** — this is what lets a permanently-past
   `FIXED_NOW` coexist with a real 2026+ DB clock. Documented in Task 2 and Task 5.
2. **Claim stamps use Postgres `now()`**, not `FIXED_NOW` — assert
   `.toBeNull()` / `.not.toBeNull()` only, never a stamp's value.
3. **The flip path stays on the DB clock.** A fixture that must *not* flip has to
   be future-dated relative to the **real** DB clock. No case needs this: every
   all-day fixture is force-set `status='started'`, and `findStartable`'s
   `status='active'` filter then excludes it regardless of either instant.
4. **Never rely on `COALESCE(ts.all_day_post_time, TIME '08:00')` in a boundary
   case** — set it explicitly (except cases 8/8b). `setAllDayPostTime` silently
   no-ops without a prior `setTeamTimezone`.
5. **`Effect.suspend` is load-bearing.** `export const eventStartCronEffect =
   makeEventStartCronEffect(new Date())` would freeze the instant at module load.
   U2 catches exactly this.
6. **No `TestClock` anywhere.** `it.effect` still provides one; it is simply
   inert, because nothing in the cron path reads a Clock any more. That inertness
   is the goal.
7. **`vi.setSystemTime` and `TestClock` are disjoint** — `vi.setSystemTime` fakes
   global `Date` (reaching `new Date()`), not `TestClock`; `TestClock` intercepts
   `Clock.currentTimeMillis`, not global `Date`. U2 uses a **plain `it`**.
   `toFake: ['Date']` leaves `setTimeout` real, so the Effect runtime is
   unaffected — the technique `test/EventRsvp.test.ts:1500-1506` already uses.
   **Must restore with `afterEach(() => vi.useRealTimers())`.**
8. **One instant per cycle is a semantic choice.** A long cycle means the deferred
   sweeps evaluate against the cycle-*start* instant; worst case a sweep slips one
   60-second cycle. Strictly better than today's two independent samples.
9. **`Effect.Do.pipe` only** (`AGENTS.md:230-234`). No `Effect.gen`.
10. **A backtick inside a `sql` template comment terminates the template** and
    fabricates a flood of unrelated type errors — keep prose comments outside.
11. **Integration suite is serial** (`fileParallelism: false`, `pool: 'forks'`).
    Never overlap runs.

---

## 7. Build notes

- No `packages/domain/` change → no rebuild needed. No migration, no schema
  change — the SQL text of both sweep statements is untouched; only the origin of
  the bound `nowParam` changes. No public API / wire-format change.
- `eventStartCronEffect` has exactly three consumers: `src/run.ts:165`
  (unchanged), `test/services/EventStartCron.test.ts`,
  `test/integration/services/EventStartCron.deferred.test.ts`.
  `makeEventStartCronEffect` is a new export consumed only by tests.
- Verify: `pnpm --filter @sideline/server check`, then
  `pnpm --filter @sideline/server exec vitest run test/services/EventStartCron.test.ts test/api/eventAllDayAnchor.test.ts`,
  then the integration suite **serially**.
