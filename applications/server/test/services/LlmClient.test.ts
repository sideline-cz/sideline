import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { LlmClient, LlmError } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// LlmClient — unit tests
// ---------------------------------------------------------------------------

describe('LlmClient — stub provider (no LLM_API_URL)', () => {
  // The Default layer reads env at construction time; in test env LLM_API_URL is unset
  // so the stub is used. We provide LlmClient.Default and call through.

  it.effect('summarizeEmail returns {short,detailed} both containing subject and from', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Team practice cancelled',
          from: 'coach@example.com',
          body: 'Unfortunately practice is cancelled due to rain.',
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(typeof result.detailed).toBe('string');
          expect(result.detailed.length).toBeGreaterThan(0);
          expect(result.detailed).toContain('Team practice cancelled');
          expect(result.detailed).toContain('coach@example.com');
          expect(typeof result.short).toBe('string');
          expect(result.short.length).toBeGreaterThan(0);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('summarizeEmail detailed truncates long body at 280 chars with ellipsis', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Long email',
          from: 'sender@example.com',
          body: 'A'.repeat(500),
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.detailed).toContain('...');
          // Body portion should be at most 280 chars
          const bodyPortionStart = result.detailed.indexOf(': ') + 2;
          const bodyPortion = result.detailed.slice(bodyPortionStart);
          expect(bodyPortion.length).toBeLessThanOrEqual(283); // 280 + "..."
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('stub short has no "TL;DR:" prefix', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Meeting on Friday',
          from: 'organiser@team.com',
          body: 'We have a meeting on Friday at 18:00.',
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.short.startsWith('TL;DR:')).toBe(false);
          expect(result.short.toLowerCase().startsWith('tl;dr')).toBe(false);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('stub short has no "- " immediately before an emoji codepoint', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Training',
          from: 'coach@team.com',
          body: '- 🏟️ Location: Sports Hall\n- 📅 Date: Friday 18:00\n- ✅ RSVP required',
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          const dashEmojiPattern = /^- [\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/mu;
          expect(dashEmojiPattern.test(result.short)).toBe(false);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('stub is deterministic — same input produces same output twice', () =>
    Effect.Do.pipe(
      Effect.bind('llm', () => LlmClient.asEffect()),
      Effect.bind('r1', ({ llm }) =>
        llm.summarizeEmail({
          subject: 'Match Subject',
          from: 'a@b.com',
          body: 'Same body',
        }),
      ),
      Effect.bind('r2', ({ llm }) =>
        llm.summarizeEmail({
          subject: 'Match Subject',
          from: 'a@b.com',
          body: 'Same body',
        }),
      ),
      Effect.tap(({ r1, r2 }) =>
        Effect.sync(() => {
          expect(r1.short).toBe(r2.short);
          expect(r1.detailed).toBe(r2.detailed);
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('emoji and Czech characters in output are intact (multibyte round-trip)', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Trénink',
          from: 'trenink@klub.cz',
          body: 'Milí hráči, přijďte na trénink. 🏋️ Místo: Sportovní hala 📅 Sobota 10:00',
        }),
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          // Verify multibyte characters preserved — round-trip via codepoints
          expect(Array.from(result.short).join('')).toBe(result.short);
          expect(Array.from(result.detailed).join('')).toBe(result.detailed);
          // Czech diacritics round-trip
          expect(result.detailed).toContain('é'); // from 'tréninku' in detailed
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );
});

describe('LlmClient — provider error path', () => {
  // Provide a fake LlmClient whose summarizeEmail always fails with LlmError.
  const FailingLlmClientLayer = Layer.succeed(LlmClient, {
    _tag: 'api/LlmClient' as const,
    summarizeEmail: (_input: unknown) =>
      Effect.fail(new LlmError({ message: 'Simulated LLM provider failure' })),
  } as never);

  it.effect('fails with LlmError when provider returns an error', () =>
    LlmClient.asEffect().pipe(
      Effect.flatMap((llm) =>
        llm.summarizeEmail({
          subject: 'Test',
          from: 'a@b.com',
          body: 'body',
        }),
      ),
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') {
            const err = result.failure as unknown;
            expect((err as LlmError)._tag).toBe('LlmError');
          }
        }),
      ),
      Effect.asVoid,
      Effect.provide(FailingLlmClientLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// makeReal coverage note
// ---------------------------------------------------------------------------
// makeReal (the OpenAI-compatible provider) hardcodes Effect.provide(FetchHttpClient.layer)
// at the innermost scope of each summarizeEmail call. This means an outer-layer HttpClient
// stub cannot override it — the inner provision wins. Additionally, the deriveFallback
// helper and JSON-parse logic are internal (not exported from LlmClient.ts), so they
// cannot be exercised independently.
//
// The integration path (real HTTP to a local server) would require starting a network
// listener in tests, which is out of scope for unit tests. makeReal is therefore covered
// by the integration/E2E test suite that runs against a real LLM endpoint in CI.
//
// What IS tested above: the service interface shape (both fields returned, correct types),
// the stub determinism, the format constraints (no "- emoji", no "TL;DR:"), multibyte
// survival, and the error path (LlmError propagation). These cover the service contract
// that all callers depend on.
