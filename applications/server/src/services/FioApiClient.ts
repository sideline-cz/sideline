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

type FetchPeriodError =
  | FioRateLimited
  | FioTooManyMovements
  | FioHistoryLocked
  | FioBadRequest
  | FioServerError
  | FioResponseInvalid
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

const tokenFingerprint = (token: Redacted.Redacted<string>): string =>
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
}

export const makeReal = (
  client: HttpClient.HttpClient,
  sql: SqlClient.SqlClient,
  options: MakeRealOptions = {},
): FioApiClientService => {
  const throttleSeconds = options.throttleSeconds ?? 30;
  const retryBase = options.retryBase ?? '30 seconds';
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
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, FioServerError> =>
    containedClient.execute(request).pipe(
      Effect.catchTag('HttpClientError', () =>
        Effect.fail(new FioServerError({ endpoint: ENDPOINT_NAME, teamId })),
      ),
      // Defensive net for a DEFECT (the tag above already caught the only typed failure `execute`
      // can produce): re-raise a cause that is only interruption untouched (the ChatAgent idiom,
      // `services/ChatAgent.ts`), degrade anything else to the same typed error. Never construct
      // a log/error message from the original defect — it may carry the tokenised request.
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.fail(new FioServerError({ endpoint: ENDPOINT_NAME, teamId })),
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
    // A non-existent / expired / revoked token returns 500 — NEVER retried (a dead token, and a
    // blanket "retry on 5xx" would hammer Fio forever). Any other unexpected status is treated the
    // same way: our own bug or Fio's, never worth a retry loop.
    if (response.status !== 200) {
      return Effect.fail(new FioServerError({ endpoint: ENDPOINT_NAME, teamId }));
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
  // IDENTICAL SQL. This copy is the one actually wired to a production caller (this function
  // closes over its own captured `SqlClient.SqlClient`, per this file's header comment on
  // token-containment); that one exists only for `test/integration/repositories/
  // BankSyncConfigRepository.test.ts`'s 102/102b, which pin the autocommit invariant against the
  // repository's contract. Keep both copies' `Math.ceil` round-up-never-down fix in sync.
  const attempt = (input: FetchPeriodInput): Effect.Effect<FioDecodedStatement, FetchPeriodError> =>
    Effect.Do.pipe(
      // D10b(a)/e(i)/e(ii) — a SINGLE autocommitted UPSERT statement (no enclosing transaction:
      // "sleeps outside any lock" is only true if the ON CONFLICT row lock is released at
      // statement end). Returns a DURATION to sleep, never a DB timestamp — the caller sleeps on
      // the REPLICA's clock, and comparing against a DB timestamp would be wrong by clock skew.
      Effect.bind('wait', () =>
        sql<{ readonly wait_seconds: number | string }>`
          INSERT INTO fio_token_throttle (token_fingerprint, next_call_allowed_at)
          VALUES (${tokenFingerprint(input.token)}, now() + (${throttleSeconds} * interval '1 second'))
          ON CONFLICT (token_fingerprint) DO UPDATE
            SET next_call_allowed_at = GREATEST(fio_token_throttle.next_call_allowed_at, now())
                                        + (${throttleSeconds} * interval '1 second')
          RETURNING GREATEST(
            EXTRACT(EPOCH FROM (
              next_call_allowed_at - (${throttleSeconds} * interval '1 second') - now()
            )), 0
          )::float8 AS wait_seconds
        `.pipe(
          catchSqlErrors,
          Effect.map((rows) =>
            // `wait_seconds` is a Postgres `EXTRACT(EPOCH ...)` float — microsecond-precision
            // noise, not meaningful sub-millisecond intent. Round to the nearest whole
            // millisecond (never down, so the sleep is never a hair shorter than the reserved
            // slot) so the resulting `Duration` carries a clean integer-millisecond value rather
            // than one requiring nanosecond conversion.
            Duration.millis(Math.max(0, Math.ceil(Number(rows[0]?.wait_seconds ?? 0) * 1000))),
          ),
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

  const fetchPeriod = (
    input: FetchPeriodInput,
  ): Effect.Effect<FioDecodedStatement, FetchPeriodError> =>
    attempt(input).pipe(
      Effect.retry({
        schedule: Schedule.exponential(retryBase, 2).pipe(Schedule.take(2)),
        while: (e: FetchPeriodError) => e._tag === 'FioRateLimited',
      }),
    );

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
