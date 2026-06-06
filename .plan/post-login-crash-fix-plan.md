# Bug Fix Plan — Post-Login `Uncaught undefined` Crash

**Bug:** Immediately after Discord login, the web app throws `Uncaught undefined` on the main page. **Pre-existing on `main`** (not caused by PR #344). Severity: High — every user hits it right after logging in.

**Branch:** `fix/post-login-redirect-crash` (off `main`). Web app only; no domain/API/schema changes.

---

## Root cause (verified in source + Effect beta.40)

1. After OAuth, the server redirects to `/?token=…`. In `routes/index.tsx:51`, after `finishLogin(token)` (purely client-side — writes `localStorage`), the `beforeLoad` does `Effect.fail(Redirect.make({ to: '.' }))` to strip the token from the URL.
2. That self-redirect makes TanStack **abort** the in-flight match (`abortController.abort()`), interrupting the running fiber mid-flight (the in-flight `auth.myTeams()` fetch).
3. `runtime.ts` wraps the effect in `Effect.result` — but **`Effect.result` only captures typed `Fail`s**, not `Die`/`Interrupt`. So the abort-teardown cause bypasses `Result.match`, and `Effect.runPromise` rejects via `causeSquash`. A `Die` whose defect is `undefined` (thrown during abort) squashes to **literal `undefined`** → the unhandled rejection surfaces as `Uncaught undefined`.
4. Secondary defect: `Effect.runPromise(effect, abortController)` passes an `AbortController` where Effect wants `{ signal }` — works only by accident.

**Why the self-redirect exists (must keep it):** on the first `/` pass, the root `beforeLoad` runs `auth.me()` *before* `finishLogin` stores the token, so `userOption` is `None`. The `to: '.'` redirect re-runs resolution so `auth.me()` then sees the stored token. Removing it would strand logged-in users on the login page.

---

## Fix A — make the runner abort-safe (primary, `lib/runtime.ts`)

Rewrite `ServerRunner.run` and `runPromiseServer` to use `runPromiseExit` (which **always resolves** with an `Exit`, never rejects), passing the signal correctly. Extract the exit→outcome decision into a small **pure helper** for unit testing.

```ts
// pure, unit-testable
const settleExit = <A>(exit, signalAborted, redirectFns) => { … }
```

Behavior:
- `Exit.isSuccess(exit)` → `Result.match(exit.value, …)` exactly as today: `Redirect` → `throw r.redirect()`, `NotFound` → `throw notFound()`, success → return value. **Redirect/NotFound flows preserved** (they are typed `Fail`s captured by `Effect.result` into the success exit).
- `Exit` is a Failure (interrupt/defect — never a typed Redirect/NotFound):
  - if `abortController?.signal.aborted` → navigation superseded; return a **never-settling promise** (`new Promise<never>(() => {})`). Both root and index `beforeLoad` correctly stop; the promise is GC-eligible once TanStack drops the dead match, and the fiber is already interrupted. **This is the line that kills the `Uncaught undefined`.**
  - else (genuine defect, no abort) → `throw Cause.squash(cause)` coerced to a real `Error` (`… ?? new Error('Unexpected runtime defect')`) — **never a bare `undefined`**.
- Pass `{ signal: abortController?.signal }` (fixes the accidental arg).
- Leave `runPromiseClient` untouched (no signal, uses `Effect.option`; not affected).

## Fix B1 — harden the self-redirect (`routes/index.tsx:51`)

Change to `Redirect.make({ to: '.', search: {}, replace: true })`:
- `search: {}` explicitly strips `?token=` (only fires on the success branch; `error`/`reason` live on the error branch which never self-redirects, so they're unaffected).
- `replace: true` avoids leaving a `?token=` history entry.
- Keep the self-redirect (do **not** remove it). This still triggers an abort race — which Fix A now handles safely.

---

## Tests (TDD) — `applications/web/src/lib/runtime.test.ts` (new)

Unit-test the pure exit-decision helper / runner:
1. Success + value → resolves to the value.
2. Success + `Redirect` failure → throws the TanStack redirect.
3. Success + `NotFound` failure → throws `notFound()`.
4. **Aborted signal + interrupted run → never rejects** (assert it does not settle within a tick; in particular never rejects with `undefined`). Core regression guard.
5. **`Die(undefined)` while aborted → never rejects with `undefined`** (treated as superseded).
6. Genuine `Die(new Error('boom'))`, not aborted → rejects with the real `Error('boom')`.
7. Genuine `Die(undefined)`, not aborted → rejects with a constructed non-undefined `Error` (the `?? new Error(...)` guard).
8. Signal wiring: aborting the controller mid-run actually interrupts (a finalizer/`onInterrupt` fires) — proves `{ signal: controller.signal }` is correct.

Browser-only (manual): full OAuth round-trip — land on `/?token=…`, token stored, URL cleaned, no `Uncaught undefined`, correct single-pass redirect to dashboard / onboarding / no-team / admin.

---

## Risks
- Must not swallow real `Redirect`/`NotFound` (they're in the success exit — unchanged) ✓
- Must not swallow real errors → genuine defects now throw a real `Error` (strictly better than today) ✓
- Never-resolve only triggers when `signal.aborted` (navigation already dead) → no live navigation affected ✓
