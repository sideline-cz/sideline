import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { LlmClient, LlmError } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// LlmClient — unit tests
// ---------------------------------------------------------------------------

describe('LlmClient — stub provider (no LLM_API_URL)', () => {
  // The Default layer reads env at construction time; in test env LLM_API_URL is unset
  // so the stub is used. We provide LlmClient.Default and call through.

  it.effect('summarizeEmail returns non-empty string containing subject and from', () =>
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
          expect(result.length).toBeGreaterThan(0);
          expect(result).toContain('Team practice cancelled');
          expect(result).toContain('coach@example.com');
        }),
      ),
      Effect.asVoid,
      Effect.provide(LlmClient.Default),
    ),
  );

  it.effect('summarizeEmail truncates long body at 280 chars with ellipsis', () =>
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
          expect(result).toContain('...');
          // Body portion should be at most 280 chars
          const bodyPortionStart = result.indexOf(': ') + 2;
          const bodyPortion = result.slice(bodyPortionStart);
          expect(bodyPortion.length).toBeLessThanOrEqual(283); // 280 + "..."
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
