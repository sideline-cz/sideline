// TDD mode — tests written BEFORE `FioApiClient.ts` (and its `fioColumns.ts` dependency) exist.
//
// Plan `.work-plans/fio-transaction-matching.md` D10 / D10b / §7.1 tests 75-84. The plan's §7.3
// calls this a "unit" suite ("no DB"), but the client's public methods depend on `SqlClient` for
// the per-token throttle reservation (D10b(a)) — the reservation lives INSIDE the client so no
// caller can bypass it. This repo's `vitest.config.ts` (the "unit" runner) never provisions a
// Postgres container; only `vitest.integration.config.ts` does. So — deliberately deviating from
// the plan's literal file path — this lives under `test/integration/services/` and runs via
// `pnpm test:integration`, using a REAL `TestPgClient` for the throttle table alongside a mock
// `HttpClient`. This is a placement fix for this repo's infra, not a change in what is tested.
//
// Contract this file pins down for `applications/server/src/services/FioApiClient.ts`:
//
//   export const isFioUrl: (url: string) => boolean
//     — true only for `https://fioapi.fio.cz/...`; false (never throws) for a relative URL.
//
//   export class FioRateLimited extends Data.TaggedError('FioRateLimited')<{ endpoint: string; teamId: string }> {}
//   export class FioTooManyMovements extends Data.TaggedError('FioTooManyMovements')<{ endpoint: string; teamId: string }> {}
//   export class FioHistoryLocked extends Data.TaggedError('FioHistoryLocked')<{ endpoint: string; teamId: string }> {}
//   export class FioBadRequest extends Data.TaggedError('FioBadRequest')<{ endpoint: string; teamId: string }> {}
//   export class FioServerError extends Data.TaggedError('FioServerError')<{ endpoint: string; teamId: string }> {}
//   export class FioResponseInvalid extends Data.TaggedError('FioResponseInvalid')<{ endpoint: string; teamId: string }> {}
//   export class FioNotConfigured extends Data.TaggedError('FioNotConfigured')<{ endpoint: string }> {}
//     — NONE of these carry the original HttpClientError/DecodeError as `cause` (D10 containment).
//
//   export interface FioApiClientService {
//     readonly fetchPeriod: (input: {
//       readonly token: Redacted.Redacted<string>;
//       readonly from: string;   // 'YYYY-MM-DD'
//       readonly to: string;
//       readonly teamId: string;
//     }) => Effect.Effect<
//       FioColumns.FioDecodedStatement,
//       FioRateLimited | FioTooManyMovements | FioHistoryLocked | FioBadRequest | FioServerError | FioResponseInvalid
//     >;
//   }
//
//   export const makeReal: (httpClient: HttpClient.HttpClient, sql: SqlClient.SqlClient) => FioApiClientService
//   export const makeStub: () => FioApiClientService   // fails FioNotConfigured on every method
//   export class FioApiClient extends ServiceMap.Service<FioApiClient, FioApiClientService>()('api/FioApiClient') {
//     static readonly Default: Layer.Layer<FioApiClient>;  // Effect.serviceOption(HttpClient) driven
//   }
//
// 413 note (test 80): the CHUNK-halving loop is `BankSyncBackfill`'s concern (it owns the date
// range being walked), not the client's — `fetchPeriod` simply reports `FioTooManyMovements` for
// whatever range it was given, once, no retry. The halving LOOP is exercised at
// `services/BankSyncPoller.test.ts` (integration test 126).

import { describe, expect, it } from '@effect/vitest';
import { Cause, Clock, Effect, Exit, Fiber, Layer, Option, Redacted } from 'effect';
import * as Tracer from 'effect/Tracer';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach, beforeEach, vi } from 'vitest';
import { isFioUrl, makeReal, makeStub } from '~/services/FioApiClient.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'a'.repeat(64);
const OTHER_TOKEN = 'b'.repeat(64);
const TEAM_ID = '00000000-0000-0000-0000-0000000000f1';

const fetchInput = (
  overrides: Partial<{ token: string; from: string; to: string; teamId: string }> = {},
) => ({
  token: Redacted.make(overrides.token ?? TEST_TOKEN),
  from: overrides.from ?? '2024-01-01',
  to: overrides.to ?? '2024-01-14',
  teamId: overrides.teamId ?? TEAM_ID,
});

/** A minimal, well-formed Fio statement with zero transactions — enough to satisfy fioColumns. */
const validRawStatement = {
  accountStatement: {
    info: {
      accountId: '2000145399',
      bankId: '0800',
      currency: 'CZK',
      iban: 'CZ6508000000192000145399',
      bic: 'GIBACZPX',
      openingBalance: 1000.0,
      closingBalance: 1000.0,
      dateStart: '2024-01-01+0100',
      dateEnd: '2024-01-14+0100',
      yearList: null,
      idList: null,
      idFrom: null,
      idTo: null,
      idLastDownload: null,
    },
    transactionList: { transaction: [] },
  },
};

// ---------------------------------------------------------------------------
// Mock HttpClient plumbing
// ---------------------------------------------------------------------------

type Responder = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const statusResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response('', { status }));

const jsonResponse = (
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  body: unknown,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(
    request,
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

const makeMockHttpClientLayer = (responder: Responder): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => responder(request)),
  );

/** Builds a `FioApiClientService` from `makeReal` with an injected mock `HttpClient` and the real
 * (test) `SqlClient` — the sanctioned pattern for `makeReal`-based unit tests.
 *
 * IMPORTANT: this only provides the mock `HttpClient` layer. `TestPgClient` must be provided by
 * the CALLER around the whole test body (`.pipe(Effect.provide(TestPgClient))` on the outermost
 * `Effect.gen`), not here — providing it here would build+tear down the connection pool before
 * `client.fetchPeriod(...)` ever runs later in the test, since `Effect.provide(layer)` closes the
 * layer's scope as soon as the effect it's attached to completes. The client instance still holds
 * a *reference* to the `SqlClient` it was built with, so the pool must stay open for as long as
 * that client is used. */
const buildRealClient = (
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
  options?: Parameters<typeof makeReal>[2],
) =>
  Effect.Do.pipe(
    Effect.bind('http', () => HttpClient.HttpClient.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
    Effect.map(({ http, sql }) => makeReal(http, sql, options)),
    Effect.provide(httpLayer),
  );

const getFailureTag = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.findErrorOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

// ---------------------------------------------------------------------------
// 75 — 200 decodes movements
// ---------------------------------------------------------------------------

describe('FioApiClient — success path (75)', () => {
  it.effect('200 -> decoded movements', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(jsonResponse(request, 200, validRawStatement));
        }),
      );
      const result = yield* client.fetchPeriod(fetchInput());
      expect(result.movements).toEqual([]);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 78 — 500 -> FioServerError after EXACTLY ONE request (the anti-hammer test)
// ---------------------------------------------------------------------------

describe('FioApiClient — 500 is NEVER retried (78, the anti-hammer test)', () => {
  it.effect('a dead token produces exactly one request, ever', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(statusResponse(request, 500));
        }),
      );
      const fiber = yield* Effect.forkChild(Effect.exit(client.fetchPeriod(fetchInput())));
      yield* TestClock.adjust('2 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(getFailureTag(exit)).toBe('FioServerError');
      expect(calls).toBe(1);
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 79 — 422 -> FioHistoryLocked; 404 -> FioBadRequest; each one request, no retry
// ---------------------------------------------------------------------------

describe('FioApiClient — 422 / 404 map to typed errors, no retry (79)', () => {
  it.effect('422 -> FioHistoryLocked, one request', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(statusResponse(request, 422));
        }),
      );
      const fiber = yield* Effect.forkChild(Effect.exit(client.fetchPeriod(fetchInput())));
      yield* TestClock.adjust('1 second');
      const exit = yield* Fiber.join(fiber);
      expect(getFailureTag(exit)).toBe('FioHistoryLocked');
      expect(calls).toBe(1);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('404 -> FioBadRequest, one request', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(statusResponse(request, 404));
        }),
      );
      const fiber = yield* Effect.forkChild(Effect.exit(client.fetchPeriod(fetchInput())));
      yield* TestClock.adjust('1 second');
      const exit = yield* Fiber.join(fiber);
      expect(getFailureTag(exit)).toBe('FioBadRequest');
      expect(calls).toBe(1);
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 80 — 413 -> FioTooManyMovements, one request (the chunk-halving LOOP lives in BankSyncBackfill)
// ---------------------------------------------------------------------------

describe('FioApiClient — 413 (80)', () => {
  it.effect(
    '413 -> FioTooManyMovements, one request — the client does not itself halve anything',
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const client = yield* buildRealClient(
          makeMockHttpClientLayer((request) => {
            calls += 1;
            return Effect.succeed(statusResponse(request, 413));
          }),
        );
        const fiber = yield* Effect.forkChild(Effect.exit(client.fetchPeriod(fetchInput())));
        yield* TestClock.adjust('1 second');
        const exit = yield* Fiber.join(fiber);
        expect(getFailureTag(exit)).toBe('FioTooManyMovements');
        expect(calls).toBe(1);
      }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 76 / 77 — 409 retry ladder
// ---------------------------------------------------------------------------

describe('FioApiClient — 409 retry ladder (76, 77)', () => {
  it.effect('409 then 200 -> exactly 2 requests, the second only after real elapsed time', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(
            calls === 1
              ? statusResponse(request, 409)
              : jsonResponse(request, 200, validRawStatement),
          );
        }),
      );
      const startMillis = yield* Clock.currentTimeMillis;
      const fiber = yield* Effect.forkChild(client.fetchPeriod(fetchInput()));

      let elapsedAtSecondCall = -1;
      for (let i = 0; i < 300 && calls < 2; i += 1) {
        yield* TestClock.adjust('1 second');
      }
      if (calls >= 2) {
        const now = yield* Clock.currentTimeMillis;
        elapsedAtSecondCall = now - startMillis;
      }

      const result = yield* Fiber.join(fiber);
      expect(calls).toBe(2);
      // The 409 ladder's first delay is >= 30s (Schedule.exponential('30 seconds', 2)); the
      // throttle reservation for the SAME token adds on top of that, so the true floor is >= 30s.
      expect(elapsedAtSecondCall).toBeGreaterThanOrEqual(30_000);
      expect(result.movements).toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('409 forever -> FioRateLimited after the bounded retries, never infinite', () =>
    // Each retry re-reserves the per-token throttle slot (D10b(a)) on top of the 409 ladder's
    // own backoff (`Schedule.exponential(retryBase, 2)`), and — empirically, reproduced
    // repeatedly in isolation — driving `it.effect`'s virtual `TestClock` through THREE
    // successive real SQL-backed reservations inside one retried fiber is unreliable: the
    // third reservation's `Effect.sleep` sometimes never resolves no matter how far
    // `TestClock.adjust` pushes the virtual clock forward, even though the first two do. This
    // is a `TestClock`/repeated-real-I/O interaction, not a throttle or retry-ladder bug (the
    // single-retry case in the test above resolves virtual time correctly every time).
    // `TestClock.withLive` opts into the real clock, same as before — but `makeReal`'s
    // `throttleSeconds`/`retryBase` (test-only knobs, production defaults 30/'30 seconds') are
    // dialled down to `{ throttleSeconds: 0, retryBase: '10 millis' }` here, so the SAME
    // boundedness property (strictly more than one attempt, never unbounded) is proven in
    // milliseconds rather than the ~180s worst case (30s + 30s + 60s + 60s) the production
    // defaults would take, without weakening what is actually asserted.
    TestClock.withLive(
      Effect.gen(function* () {
        let calls = 0;
        const client = yield* buildRealClient(
          makeMockHttpClientLayer((request) => {
            calls += 1;
            return Effect.succeed(statusResponse(request, 409));
          }),
          { throttleSeconds: 0, retryBase: '10 millis' },
        );
        const exit = yield* Effect.exit(client.fetchPeriod(fetchInput()));
        expect(getFailureTag(exit)).toBe('FioRateLimited');
        // Bounded: strictly more than one attempt (it did retry) but not unbounded.
        expect(calls).toBeGreaterThan(1);
        expect(calls).toBeLessThanOrEqual(6);
      }),
    ).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 81 — every error path: empty body, client NEVER calls response.json
// ---------------------------------------------------------------------------

describe('FioApiClient — dispatch is on status code alone (81)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('never calls response.json on any error status', () =>
    Effect.gen(function* () {
      const jsonSpy = vi.spyOn(Response.prototype, 'json').mockImplementation(() => {
        throw new Error('response.json must never be called on an error path');
      });

      for (const status of [413, 422, 404, 500]) {
        const client = yield* buildRealClient(
          makeMockHttpClientLayer((request) => Effect.succeed(statusResponse(request, status))),
        );
        // A distinct token per iteration — this test asserts dispatch-by-status-code, not
        // throttle behaviour. Reusing TEST_TOKEN across iterations would make every call after
        // the first a real (~30s) per-token throttle wait, which a single 1-second
        // `TestClock.adjust` can never satisfy.
        const fiber = yield* Effect.forkChild(
          Effect.exit(client.fetchPeriod(fetchInput({ token: `token-status-${status}` }))),
        );
        yield* TestClock.adjust('1 second');
        const exit = yield* Fiber.join(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
      }

      expect(jsonSpy).not.toHaveBeenCalled();
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 82 — token containment (the highest-stakes tests in the suite)
// ---------------------------------------------------------------------------

describe('FioApiClient — token containment (82)', () => {
  // (a) the exported predicate
  it('isFioUrl(a) — true for fioapi.fio.cz, false for any other host, false (no throw) for a relative URL', () => {
    expect(
      isFioUrl(
        `https://fioapi.fio.cz/v1/rest/periods/${TEST_TOKEN}/2024-01-01/2024-01-14/transactions.json`,
      ),
    ).toBe(true);
    expect(isFioUrl('https://example.com/anything')).toBe(false);
    expect(() => isFioUrl('/api/x')).not.toThrow();
    expect(isFioUrl('/api/x')).toBe(false);
  });

  // (a2) wiring: a recording Tracer must see no span carrying a url.full (or any) attribute that
  // contains the token — this is the test that actually catches the Layer.provide-vs-wrap bug,
  // because it only asserts on real span output, not on the predicate in isolation.
  it.effect('no emitted span carries any attribute containing the token', () =>
    Effect.gen(function* () {
      const recordedAttributes: Array<[key: string, value: unknown]> = [];
      const recordingTracer: Tracer.Tracer = Tracer.make({
        span: (options) => {
          const attributes = new Map<string, unknown>();
          return {
            _tag: 'Span',
            name: options.name,
            spanId: `span-${String(recordedAttributes.length)}`,
            traceId: 'trace-0',
            parent: options.parent,
            annotations: options.annotations,
            status: { _tag: 'Started', startTime: options.startTime },
            attributes,
            links: options.links,
            sampled: options.sampled,
            kind: options.kind,
            end: () => {},
            attribute: (key: string, value: unknown) => {
              attributes.set(key, value);
              recordedAttributes.push([key, value]);
            },
            event: () => {},
            addLinks: () => {},
          };
        },
      });

      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) =>
          Effect.succeed(jsonResponse(request, 200, validRawStatement)),
        ),
      );
      yield* client
        .fetchPeriod(fetchInput())
        .pipe(Effect.provideService(Tracer.Tracer, recordingTracer));

      for (const [key, value] of recordedAttributes) {
        expect(key).not.toBe('url.full');
        expect(String(value)).not.toContain(TEST_TOKEN);
      }
    }).pipe(Effect.provide(TestPgClient)),
  );

  // (b) transport failure -> typed Fio* error, Cause.pretty never contains the token
  it.effect('a simulated transport failure produces a token-free Cause.pretty', () =>
    Effect.gen(function* () {
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error('ECONNRESET'),
              }),
            }),
          ),
        ),
      );
      const exit = yield* Effect.exit(client.fetchPeriod(fetchInput()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const pretty = Cause.pretty(exit.cause);
        expect(pretty).not.toContain(TEST_TOKEN);
      }
    }).pipe(Effect.provide(TestPgClient)),
  );

  // (b2) a body-decode failure (schema mismatch on a 200) is ALSO contained
  it.effect(
    'a body-decode failure produces a token-free Cause.pretty (decoding happens inside the boundary)',
    () =>
      Effect.gen(function* () {
        const client = yield* buildRealClient(
          makeMockHttpClientLayer((request) =>
            Effect.succeed(jsonResponse(request, 200, { not: 'a valid fio statement' })),
          ),
        );
        const exit = yield* Effect.exit(client.fetchPeriod(fetchInput()));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const pretty = Cause.pretty(exit.cause);
          expect(pretty).not.toContain(TEST_TOKEN);
        }
      }).pipe(Effect.provide(TestPgClient)),
  );

  // (c) every log line captured during a full failing cycle is token-free
  it.effect('every log line produced while handling a failure is token-free', () =>
    Effect.gen(function* () {
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: new Error('boom') }),
            }),
          ),
        ),
      );
      yield* client
        .fetchPeriod(fetchInput())
        .pipe(
          Effect.tapCause((cause) =>
            Effect.logError('fio cycle failed', { cause: Cause.pretty(cause) }),
          ),
        )
        .pipe(Effect.exit);

      const logLines = yield* TestConsole.logLines;
      const errorLines = yield* TestConsole.errorLines;
      for (const line of [...logLines, ...errorLines]) {
        expect(JSON.stringify(line)).not.toContain(TEST_TOKEN);
      }
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 83 — throttle: same token >=30s apart; different tokens NOT delayed relative to each other
// ---------------------------------------------------------------------------

describe('FioApiClient — per-token throttle (83)', () => {
  it.effect('two calls with the SAME token are at least 30s apart', () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) => {
          calls += 1;
          return Effect.succeed(jsonResponse(request, 200, validRawStatement));
        }),
      );
      yield* client.fetchPeriod(fetchInput({ token: TEST_TOKEN }));
      expect(calls).toBe(1);
      const startMillis = yield* Clock.currentTimeMillis;
      const fiber = yield* Effect.forkChild(client.fetchPeriod(fetchInput({ token: TEST_TOKEN })));

      // Drive virtual time forward one second at a time until the second HTTP call actually
      // fires, recording how much virtual time had to pass first.
      let elapsedAtSecondCall = -1;
      for (let i = 0; i < 60 && calls < 2; i += 1) {
        yield* TestClock.adjust('1 second');
        if (calls === 2 && elapsedAtSecondCall === -1) {
          const now = yield* Clock.currentTimeMillis;
          elapsedAtSecondCall = now - startMillis;
        }
      }
      yield* Fiber.join(fiber);
      expect(calls).toBe(2);
      expect(elapsedAtSecondCall).toBeGreaterThanOrEqual(29_000);
    }).pipe(Effect.provide(TestPgClient)),
  );

  it.effect('two calls with DIFFERENT tokens are not delayed relative to each other', () =>
    Effect.gen(function* () {
      const client = yield* buildRealClient(
        makeMockHttpClientLayer((request) =>
          Effect.succeed(jsonResponse(request, 200, validRawStatement)),
        ),
      );
      yield* client.fetchPeriod(fetchInput({ token: TEST_TOKEN }));
      const fiber = yield* Effect.forkChild(client.fetchPeriod(fetchInput({ token: OTHER_TOKEN })));
      // A different token's first-ever call reserves a near-zero wait — it must complete without
      // needing any virtual time to pass.
      yield* TestClock.adjust('1 millis');
      const result = yield* Fiber.join(fiber);
      expect(result.movements).toEqual([]);
    }).pipe(Effect.provide(TestPgClient)),
  );
});

// ---------------------------------------------------------------------------
// 84 — makeStub() fails FioNotConfigured on every method
// ---------------------------------------------------------------------------

describe('FioApiClient — makeStub() (84)', () => {
  it.effect('fetchPeriod fails FioNotConfigured, no HttpClient/SqlClient needed', () =>
    Effect.gen(function* () {
      const stub = makeStub();
      const exit = yield* Effect.exit(stub.fetchPeriod(fetchInput()));
      expect(getFailureTag(exit)).toBe('FioNotConfigured');
    }),
  );
});
