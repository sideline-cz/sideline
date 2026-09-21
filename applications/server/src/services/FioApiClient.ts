/**
 * D1 / D10 / D10b / T4 — the Fio REST client. `fetchPeriod` only (D1 drops `set-last-*`). All
 * four D10 token-containment defenses live here, plus the D10b per-token 30 s throttle
 * reservation (SQL-backed, so no caller can bypass it).
 *
 * **Token containment is the highest-stakes part of this module.** The 64-char token sits in the
 * URL *path*. Read every comment below before touching this file.
 */
import { createHash } from 'node:crypto';
import {
  Cause,
  Data,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schedule,
  ServiceMap,
} from 'effect';
import { HttpClient, HttpClientRequest, type HttpClientResponse } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { decodeFioStatement, type FioDecodedStatement } from '~/services/fioColumns.js';

// ---------------------------------------------------------------------------
// Typed errors — NONE carry the original HttpClientError/DecodeError as `cause` (D10 containment):
// `HttpClientError.message` derives from `reason.methodAndUrl`, and its constructor lifts
// `reason.cause` onto itself, so embedding it would render the tokenised URL (twice, via
// `Cause.pretty`).
// ---------------------------------------------------------------------------

export class FioRateLimited extends Data.TaggedError('FioRateLimited')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioTooManyMovements extends Data.TaggedError('FioTooManyMovements')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioHistoryLocked extends Data.TaggedError('FioHistoryLocked')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioBadRequest extends Data.TaggedError('FioBadRequest')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioServerError extends Data.TaggedError('FioServerError')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioResponseInvalid extends Data.TaggedError('FioResponseInvalid')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}
export class FioNotConfigured extends Data.TaggedError('FioNotConfigured')<{
  readonly endpoint: string;
}> {}
/** Transport-layer failure: DNS, connect, TLS, socket reset, or a non-interrupt defect raised by
 * `client.execute`. NEVER produced by a Fio-issued status code. Split out of `FioServerError` so
 * `/bank-sync/test` cannot tell a treasurer their token is dead when our egress blipped. */
export class FioUnreachable extends Data.TaggedError('FioUnreachable')<{
  readonly endpoint: string;
  readonly teamId: string;
}> {}

type FetchPeriodError =
  | FioRateLimited
  | FioTooManyMovements
  | FioHistoryLocked
  | FioBadRequest
  | FioServerError
  | FioResponseInvalid
  | FioUnreachable
  // `makeStub()` (no HttpClient configured) fails every call this way — see test 84.
  | FioNotConfigured;

export interface FetchPeriodInput {
  readonly token: Redacted.Redacted<string>;
  readonly from: string; // 'YYYY-MM-DD'
  readonly to: string;
  readonly teamId: string;
}

export interface FioApiClientService {
  readonly fetchPeriod: (
    input: FetchPeriodInput,
  ) => Effect.Effect<FioDecodedStatement, FetchPeriodError>;
}

// ---------------------------------------------------------------------------
// D10.1 — the client tracer must be disabled for every request to fioapi.fio.cz. String prefix,
// NOT `new URL(...)`: a relative URL makes the URL constructor THROW, and that throw would be a
// defect raised inside `Effect.withFiber`, not a typed failure.
// ---------------------------------------------------------------------------

export const isFioUrl = (url: string): boolean => url.startsWith('https://fioapi.fio.cz/');

const FIO_BASE_URL = 'https://fioapi.fio.cz/v1/rest';

const buildPeriodUrl = (token: string, from: string, to: string): string =>
  `${FIO_BASE_URL}/periods/${token}/${from}/${to}/transactions.json`;

const ENDPOINT_NAME = 'periods';

// ---------------------------------------------------------------------------
// D10b(a) — per-token throttle fingerprint. Never the token itself.
// ---------------------------------------------------------------------------

export const tokenFingerprint = (token: Redacted.Redacted<string>): string =>
  createHash('sha256').update(Redacted.value(token)).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// makeReal
// ---------------------------------------------------------------------------

export interface MakeRealOptions {
  /** The per-token throttle window (D10b(a)). Production default: 30 (seconds). Test-only knob
   * (test 111, `test/integration/services/FioApiClient.test.ts`) — `{ throttleSeconds: 0 }` lets
   * the "bounded retries under permanent 409" test prove the SAME boundedness property in
   * milliseconds rather than burning ~180s of a serial suite. */
  readonly throttleSeconds?: number;
  /** The retry ladder's base delay (`Schedule.exponential(retryBase, 2)`, `Schedule.take(2)`).
   * Production default: `'30 seconds'`. Test-only knob, paired with `throttleSeconds` above. */
  readonly retryBase?: Duration.Input;
  /** When `false`, `fetchPeriod` does NOT enter the 409 retry ladder
   * (`Schedule.exponential('30 seconds', 2)` + `Schedule.take(2)` = up to 30 s + 60 s), which
   * exists for the UNATTENDED hourly poller. A treasurer watching a spinner must not wait 90 s for
   * an answer `'rate_limited'` already conveys. Poller and backfill leave this at `true`. */
  readonly retryRateLimited?: boolean;
  /** When set, a throttle reservation that would require waiting LONGER than this many seconds
   * fails `FioRateLimited` immediately WITHOUT reserving a slot (the UPSERT's `ON CONFLICT DO
   * UPDATE` is guarded so it takes no action on the conflicting row — see `attempt` below). Lets
   * `/bank-sync/test`'s throttle check be atomic with the reservation itself (same row lock),
   * instead of a separate read-then-reserve pair a concurrent caller can race between. Poller and
   * backfill leave this unset — an unattended job should wait out the throttle, never bail. */
  readonly maxThrottleWaitSeconds?: number;
}

export const makeReal = (
  client: HttpClient.HttpClient,
  sql: SqlClient.SqlClient,
  options: MakeRealOptions = {},
): FioApiClientService => {
  const throttleSeconds = options.throttleSeconds ?? 30;
  const retryBase = options.retryBase ?? '30 seconds';
  // `null`, never `undefined`, so it can be bound straight into the SQL below: the guard reads
  // `${maxWaitSeconds} IS NULL` to fall back to "no budget, always reserve" when unset.
  const maxWaitSeconds = options.maxThrottleWaitSeconds ?? null;
  // D10.1 — wrap the client VALUE (not the construction layer): `HttpClient.js` reads
  // `fiber.getRef(TracerDisabledWhen)(request)` at EXECUTE time, inside `Effect.withFiber` — the
  // caller's fiber services, which a construction-time `Layer.provide` is not part of.
  const containedClient = HttpClient.transform(client, (effect) =>
    Effect.provideService(
      effect,
      HttpClient.TracerDisabledWhen,
      (req: HttpClientRequest.HttpClientRequest) => isFioUrl(req.url),
    ).pipe(Effect.withTracerEnabled(false)),
  );

  // D10(2) — never let a platform error escape the client. `TransportError` is nested INSIDE
  // `HttpClientError.reason`, not a top-level tag, so `catchTag('HttpClientError', …)` — never
  // `catchTag('TransportError', …)` — is the only typed failure `client.execute` can produce.
  const executeContained = (
    request: HttpClientRequest.HttpClientRequest,
    teamId: string,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, FioUnreachable> =>
    containedClient.execute(request).pipe(
      Effect.catchTag('HttpClientError', () =>
        Effect.fail(new FioUnreachable({ endpoint: ENDPOINT_NAME, teamId })),
      ),
      // Defensive net for a DEFECT (the tag above already caught the only typed failure `execute`
      // can produce): re-raise a cause that is only interruption untouched (the ChatAgent idiom,
      // `services/ChatAgent.ts`), degrade anything else to the same typed error. Never construct
      // a log/error message from the original defect — it may carry the tokenised request. Neither
      // branch here has parsed a response, so neither can represent a Fio verdict — `FioUnreachable`,
      // not `FioServerError`.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(new FioUnreachable({ endpoint: ENDPOINT_NAME, teamId })),
      ),
    );

  // D10(2), continued — the containment must wrap the BODY DECODE too: `DecodeError` also carries
  // `methodAndUrl`. Dispatch on status code alone (verified by live probing — every error body is
  // empty, `content-length: 0`) and never call `response.json` on an error path.
  const decodeContained = (
    response: HttpClientResponse.HttpClientResponse,
    teamId: string,
  ): Effect.Effect<FioDecodedStatement, FetchPeriodError> => {
    if (response.status === 409)
      return Effect.fail(new FioRateLimited({ endpoint: ENDPOINT_NAME, teamId }));
    if (response.status === 413)
      return Effect.fail(new FioTooManyMovements({ endpoint: ENDPOINT_NAME, teamId }));
    if (response.status === 422)
      return Effect.fail(new FioHistoryLocked({ endpoint: ENDPOINT_NAME, teamId }));
    if (response.status === 404)
      return Effect.fail(new FioBadRequest({ endpoint: ENDPOINT_NAME, teamId }));
    // A non-existent / expired / revoked token returns a BODYLESS 500 with no 401/403 — that is
    // the ONLY documented dead-token signal (root `AGENTS.md`). NEVER retried: a dead token, and a
    // blanket "retry on 5xx" would hammer Fio forever. Every OTHER 5xx/unexpected status (502/503/
    // 504 gateway or maintenance blips, 429 WAF throttling, or a future Fio status we don't know
    // about yet) is transport-layer noise, not a Fio verdict on the token — `FioUnreachable`, same
    // as a connect/DNS failure, so `/bank-sync/test` never tells a treasurer a good token is dead
    // because of a 503 that has nothing to do with the token.
    if (response.status === 500) {
      return Effect.fail(new FioServerError({ endpoint: ENDPOINT_NAME, teamId }));
    }
    if (response.status !== 200) {
      return Effect.fail(new FioUnreachable({ endpoint: ENDPOINT_NAME, teamId }));
    }
    return response.json.pipe(
      Effect.mapError(() => new FioResponseInvalid({ endpoint: ENDPOINT_NAME, teamId })),
      Effect.flatMap((body) =>
        decodeFioStatement(body).pipe(
          Effect.mapError(() => new FioResponseInvalid({ endpoint: ENDPOINT_NAME, teamId })),
        ),
      ),
    );
  };

  // D10b(a) — one attempt: reserve the throttle slot, sleep OUTSIDE any transaction (defect
  // e(ii): the reservation is its own autocommitted statement), issue the request, decode.
  //
  // NOTE — `BankSyncConfigRepository.ts`'s `reserveThrottleSlot` inlines the arithmetically
  // IDENTICAL SQL (including the `maxWaitSeconds` budget guard below). This copy is the one
  // actually wired to a production caller (this function closes over its own captured
  // `SqlClient.SqlClient`, per this file's header comment on token-containment); that one exists
  // only for `test/integration/repositories/BankSyncConfigRepository.test.ts`'s 102/102b, which
  // pin the autocommit invariant against the repository's contract. Keep both copies' `Math.ceil`
  // round-up-never-down fix, AND the budget guard, in sync.
  const attempt = (input: FetchPeriodInput): Effect.Effect<FioDecodedStatement, FetchPeriodError> =>
    Effect.Do.pipe(
      // D10b(a)/e(i)/e(ii) — a SINGLE autocommitted UPSERT statement (no enclosing transaction:
      // "sleeps outside any lock" is only true if the ON CONFLICT row lock is released at
      // statement end). Returns a DURATION to sleep, never a DB timestamp — the caller sleeps on
      // the REPLICA's clock, and comparing against a DB timestamp would be wrong by clock skew.
      //
      // The `WHERE` guard on the conflict UPDATE makes the throttle budget check ATOMIC with the
      // reservation itself (same row lock): when `maxWaitSeconds` is set and honouring the
      // reservation would require waiting longer than that budget, the conflicting row is left
      // untouched and `RETURNING` yields no row — no slot is burned, so a caller that only wants
      // an instant "busy or not" verdict (`/bank-sync/test`) never steals a slot from a real poll.
      // When `maxWaitSeconds` is `null` (unset), `${maxWaitSeconds} IS NULL` is always true, so
      // the guard is a no-op and behaviour is byte-for-byte what it was before this option
      // existed. A first-time INSERT (no conflict) is never subject to the guard at all —
      // Postgres only evaluates a conflict `UPDATE ... WHERE` when there IS a conflict — so a
      // brand-new fingerprint always reserves regardless of budget (nothing to wait for yet).
      Effect.bind('rows', () =>
        sql<{ readonly wait_seconds: number | string }>`
          INSERT INTO fio_token_throttle (token_fingerprint, next_call_allowed_at)
          VALUES (${tokenFingerprint(input.token)}, now() + (${throttleSeconds} * interval '1 second'))
          ON CONFLICT (token_fingerprint) DO UPDATE
            SET next_call_allowed_at = GREATEST(fio_token_throttle.next_call_allowed_at, now())
                                        + (${throttleSeconds} * interval '1 second')
            WHERE ${maxWaitSeconds}::int IS NULL
               OR fio_token_throttle.next_call_allowed_at <= now() + (${maxWaitSeconds}::int * interval '1 second')
          RETURNING GREATEST(
            EXTRACT(EPOCH FROM (
              next_call_allowed_at - (${throttleSeconds} * interval '1 second') - now()
            )), 0
          )::float8 AS wait_seconds
        `.pipe(catchSqlErrors),
      ),
      Effect.bind('wait', ({ rows }) =>
        rows.length === 0
          ? Effect.fail(new FioRateLimited({ endpoint: ENDPOINT_NAME, teamId: input.teamId }))
          : Effect.succeed(
              // `wait_seconds` is a Postgres `EXTRACT(EPOCH ...)` float — microsecond-precision
              // noise, not meaningful sub-millisecond intent. Round to the nearest whole
              // millisecond (never down, so the sleep is never a hair shorter than the reserved
              // slot) so the resulting `Duration` carries a clean integer-millisecond value rather
              // than one requiring nanosecond conversion.
              Duration.millis(Math.max(0, Math.ceil(Number(rows[0]?.wait_seconds ?? 0) * 1000))),
            ),
      ),
      Effect.tap(({ wait }) => Effect.sleep(wait)),
      Effect.bind('response', () =>
        executeContained(
          HttpClientRequest.get(buildPeriodUrl(Redacted.value(input.token), input.from, input.to)),
          input.teamId,
        ),
      ),
      Effect.flatMap(({ response }) => decodeContained(response, input.teamId)),
      Effect.withSpan(`fio/${ENDPOINT_NAME}`, {
        attributes: { 'team.id': input.teamId, 'fio.endpoint': ENDPOINT_NAME },
      }),
    );

  const retryRateLimited = options.retryRateLimited ?? true;
  const fetchPeriod = (
    input: FetchPeriodInput,
  ): Effect.Effect<FioDecodedStatement, FetchPeriodError> =>
    retryRateLimited
      ? attempt(input).pipe(
          Effect.retry({
            schedule: Schedule.exponential(retryBase, 2).pipe(Schedule.take(2)),
            while: (e: FetchPeriodError) => e._tag === 'FioRateLimited',
          }),
        )
      : attempt(input);

  return { fetchPeriod };
};

// ---------------------------------------------------------------------------
// makeStub — fails FioNotConfigured on every method; no HttpClient/SqlClient needed.
// ---------------------------------------------------------------------------

export const makeStub = (): FioApiClientService => ({
  fetchPeriod: () => Effect.fail(new FioNotConfigured({ endpoint: ENDPOINT_NAME })),
});

// ---------------------------------------------------------------------------
// make — Effect.serviceOption(HttpClient) driven (see services/LlmClient.ts ~816-856).
// ---------------------------------------------------------------------------

const make: Effect.Effect<FioApiClientService, never, SqlClient.SqlClient> = Effect.Do.pipe(
  Effect.bind('httpClientOpt', () => Effect.serviceOption(HttpClient.HttpClient)),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.tap(({ httpClientOpt }) =>
    Option.isNone(httpClientOpt)
      ? Effect.logWarning('FioApiClient: no HttpClient in layer context — using unavailable stub')
      : Effect.void,
  ),
  Effect.map(({ httpClientOpt, sql }) =>
    Option.isNone(httpClientOpt) ? makeStub() : makeReal(httpClientOpt.value, sql),
  ),
);

export class FioApiClient extends ServiceMap.Service<FioApiClient, FioApiClientService>()(
  'api/FioApiClient',
) {
  static readonly Default = Layer.effect(FioApiClient, make);
}
