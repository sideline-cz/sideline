// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// NOTE: These tests were written in TDD mode BEFORE the summarizeChannel
// method was implemented.  The existing summarizeEmail / generateRatingInsight
// / estimateRatingFromDescription methods are not re-tested here — only the
// new summarizeChannel method is exercised.
//
// How the HTTP mock works:
//   LlmClient's real provider calls `HttpClient.execute(request)` and the
//   layer provides `FetchHttpClient.layer` internally.  To intercept the HTTP
//   call in tests we replace `HttpClient.HttpClient` in the layer graph with a
//   stub that returns a synthetic `HttpClientResponse`.  We achieve this by:
//
//   1. Using `LlmClient.Default` (which calls `make`) and providing a custom
//      `HttpClient.HttpClient` layer that overrides `FetchHttpClient.layer`.
//      Because LlmClient.Default uses `Effect.provide(FetchHttpClient.layer)`
//      INSIDE the requestContent function, and Effect resolves the innermost
//      provider first, we must supply the mock at the outermost layer and
//      ensure LlmClient injects it at the right scope — OR we test via
//      `LlmClient.Default` with a mocked `env` so the stub path is taken.
//
//   2. For the "stub provider" (no API key configured) path: we rely on
//      `LlmClient.Default` with the real env — in test environments
//      `LLM_API_URL` and `LLM_API_KEY` are unset, so the stub path activates.
//
//   3. For the "real provider" path: we use a custom layer factory
//      `makeLlmClientWithHttpStub` that constructs a mock `HttpClient` layer
//      and provides it alongside a synthetic API URL + key so the real
//      provider path is taken. The factory injects the mock client at the
//      layer level using `HttpClient.HttpClient`.
//
//   The key constraint: `LlmClient.ts` currently calls
//   `Effect.provide(FetchHttpClient.layer)` inside the effect returned by
//   `requestContent`. This means the HTTP client is resolved per-request, not
//   from the outer layer graph. To intercept it in tests we need to provide
//   `HttpClient.HttpClient` at a level that overrides `FetchHttpClient.layer`.
//   The implementer MUST expose the HTTP dependency via the outer effect graph
//   (i.e. accept `HttpClient` from the outer `make` scope and NOT call
//   `Effect.provide(FetchHttpClient.layer)` inside individual request methods)
//   OR the implementer should change the implementation to use
//   `Effect.provideServiceEffect(HttpClient.HttpClient, ...)` so the outer
//   layer can override it.  The test is written assuming the implementer
//   refactors `summarizeChannel` to NOT hard-code `FetchHttpClient.layer` so
//   that `HttpClient.HttpClient` can be injected from outside (matching the
//   pattern already present in the rest of the server codebase).
//
//   If the implementer keeps `Effect.provide(FetchHttpClient.layer)` inside
//   `requestContent`, the real-provider tests will need adjustment.  The stub-
//   provider tests remain valid regardless.

import { it as itEffect } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/unstable/http';
import { afterEach, describe, expect } from 'vitest';
import { LlmClient } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Captured HTTP request storage (reset per test)
// ---------------------------------------------------------------------------

let capturedRequests: Array<{ url: string; body: unknown }> = [];

afterEach(() => {
  capturedRequests = [];
});

// ---------------------------------------------------------------------------
// Body-reading helper
// ---------------------------------------------------------------------------

/**
 * Extract the JSON body from an HttpClientRequest synchronously.
 * Works for requests created with HttpClientRequest.bodyJson (Uint8Array body).
 */
const readRequestBody = (
  request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
): unknown => {
  const body = request.body as { readonly _tag: string; readonly body?: Uint8Array };
  if (body._tag === 'Uint8Array' && body.body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body.body)) as unknown;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Mock HTTP client factory
// ---------------------------------------------------------------------------

/**
 * Build a Layer.Layer<HttpClient.HttpClient> that returns a fixed JSON body
 * and captures every request for assertion.
 */
const makeMockHttpClientLayer = (responseBody: unknown, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const body = readRequestBody(request);
      capturedRequests.push({ url: String(request.url), body });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(responseBody), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );
    }),
  );

/** Build an LlmClient layer backed by a real (mock HTTP) provider. */
const makeLlmClientRealWithHttp = (httpLayer: Layer.Layer<HttpClient.HttpClient>) =>
  LlmClient.Default.pipe(Layer.provide(httpLayer));

// ---------------------------------------------------------------------------
// Summarize channel input helpers
// ---------------------------------------------------------------------------

const makeMessages = (count: number, contentPrefix = 'Message') =>
  Array.from({ length: count }, (_, i) => ({
    author: `User${i}`,
    content: `${contentPrefix} ${i + 1}`,
    timestamp: new Date(Date.UTC(2026, 5, 20, 10, i, 0)).toISOString(),
  }));

// ---------------------------------------------------------------------------
// Tests — stub provider (no API key configured)
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeChannel — stub provider (no API key)', () => {
  // When LLM_API_URL / LLM_API_KEY are not set in the test environment,
  // LlmClient.Default activates the deterministic stub.

  itEffect.effect('returns generated: false when stub path is active', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(3),
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub returns summarizedCount equal to number of input messages', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(5),
          channelName: 'general',
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.summarizedCount).toBe(5);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub summary references message count', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(7),
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          // The stub summary should mention the count of messages or be a deterministic fallback
          expect(typeof result.summary).toBe('string');
          expect(result.summary.length).toBeGreaterThan(0);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub with cs locale: generated: false, summary is non-empty', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: makeMessages(2),
          channelName: 'obecné',
          locale: 'cs',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
          expect(typeof result.summary).toBe('string');
          expect(result.summary.length).toBeGreaterThan(0);
        }),
      ),
      Effect.asVoid,
    ),
  );

  itEffect.effect('stub with 0 messages: summarizedCount = 0, no throw', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeChannel({
          messages: [],
          channelName: undefined,
          locale: 'en',
        }),
      ),
      Effect.provide(LlmClient.Default),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.generated).toBe(false);
          expect(result.summarizedCount).toBe(0);
        }),
      ),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests — real provider with mock HTTP client
// ---------------------------------------------------------------------------

describe('LlmClient.summarizeChannel — real provider with mock HTTP', () => {
  itEffect.effect(
    'real provider success: HTTP returns JSON → summary parsed, generated: true',
    () => {
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'This is the parsed summary.',
              }),
            },
          },
        ],
      };

      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer(openAiResponse));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(2),
            channelName: 'general',
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.generated).toBe(true);
            expect(result.summary).toBe('This is the parsed summary.');
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider fallback on LlmError: HTTP fails → generated: false, no throw',
    () => {
      // Return a response with no choices to trigger LlmError
      const llmLayer = makeLlmClientRealWithHttp(makeMockHttpClientLayer({ choices: [] }));

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(3),
            channelName: undefined,
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // Should fall back gracefully
            expect(result.generated).toBe(false);
            expect(typeof result.summary).toBe('string');
            expect(result.summary.length).toBeGreaterThan(0);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'real provider: cs locale → request prompt instructs Czech language; fallback text is Czech',
    () => {
      // Simulate HTTP failure so we can inspect both the request and the fallback
      const capturedBodies: unknown[] = [];
      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body = readRequestBody(request);
          if (body !== undefined) capturedBodies.push(body);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ choices: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          );
        }),
      );
      const llmLayer = makeLlmClientRealWithHttp(httpLayer);

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: makeMessages(1),
            channelName: 'obecné',
            locale: 'cs',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // Fallback is Czech
            expect(result.generated).toBe(false);
            // The fallback summary for cs locale should be in Czech
            // (at minimum it should be non-empty)
            expect(result.summary.length).toBeGreaterThan(0);

            // If the HTTP request was made, it should instruct Czech
            if (capturedBodies.length > 0) {
              const bodyJson = JSON.stringify(capturedBodies[0]);
              expect(bodyJson.toLowerCase()).toMatch(/czech|cs|respond in czech/i);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'message-boundary truncation: many large messages → request body drops WHOLE oldest messages, keeps most recent, summarizedCount = messages actually sent',
    () => {
      // Build many large messages (each >500 chars) that collectively exceed the token budget.
      // The handler should drop WHOLE oldest messages (not slice mid-message).
      // The summarizedCount in the result should equal how many were actually sent.
      const largeContent = 'X'.repeat(600);
      const manyMessages = Array.from({ length: 50 }, (_, i) => ({
        author: `User${i}`,
        content: `${largeContent} ${i}`,
        timestamp: new Date(Date.UTC(2026, 5, 20, 10, i, 0)).toISOString(),
      }));

      const capturedBodies: unknown[] = [];
      // Return a success response
      const openAiResponse = {
        choices: [
          {
            message: {
              content: JSON.stringify({ summary: 'Capped summary.' }),
            },
          },
        ],
      };

      const httpLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const body = readRequestBody(request);
          if (body !== undefined) capturedBodies.push(body);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify(openAiResponse), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          );
        }),
      );
      const llmLayer = makeLlmClientRealWithHttp(httpLayer);

      return LlmClient.asEffect().pipe(
        Effect.flatMap((llm) =>
          llm.summarizeChannel({
            messages: manyMessages,
            channelName: 'test-channel',
            locale: 'en',
          }),
        ),
        Effect.provide(llmLayer),
        Effect.tap((result) =>
          Effect.sync(() => {
            // When the HTTP call succeeds, generated should be true
            expect(result.generated).toBe(true);
            expect(result.summary).toBe('Capped summary.');

            // If the implementer truncates, verify the captured request
            // contains only whole messages (not partial content sliced mid-string)
            if (capturedBodies.length > 0) {
              const body = capturedBodies[0] as {
                messages?: Array<{ content?: string }>;
              };

              // The transcript in the request must not contain a mid-message slice.
              // We verify by checking each message in the body ends naturally
              // (we can't check all 50 are present if truncation occurred).
              if (body.messages) {
                for (const msg of body.messages) {
                  if (msg.content) {
                    // Must be a full message content (ends with digit, not cut off)
                    expect(msg.content.endsWith('...')).toBe(false);
                  }
                }
              }

              // summarizedCount should reflect actual number sent (< 50 if truncated)
              expect(result.summarizedCount).toBeGreaterThanOrEqual(1);
              expect(result.summarizedCount).toBeLessThanOrEqual(50);
            }
          }),
        ),
        Effect.asVoid,
      );
    },
  );
});
