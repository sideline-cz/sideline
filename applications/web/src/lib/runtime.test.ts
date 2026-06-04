// Tests for the `resolveServerExit` contract exported from runtime.ts.
//
// resolveServerExit<A>(
//   exit: Exit.Exit<Result.Result<A, Redirect | NotFound>>,
//   aborted: boolean,
// ): Promise<A>
//
// - SUCCESS exit, Result.succeed(v) → resolves to v
// - SUCCESS exit, Result.fail(Redirect) → rejects by invoking redirect.redirect() (which throws)
// - SUCCESS exit, Result.fail(NotFound) → rejects with notFound() result
// - FAILURE exit, interrupt-only cause → NEVER settles (regardless of aborted flag)
// - FAILURE exit, aborted=true → NEVER settles (navigation superseded)
// - FAILURE exit, defect cause, aborted=false → rejects with a real Error (never bare undefined)

import { Cause, Exit, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — declared before any import that transitively uses them
// ---------------------------------------------------------------------------

// Mock client to avoid browser/env-dependent initialization at module load time
vi.mock('~/lib/client', () => ({
  client: {},
  ClientConfig: {
    asEffect: () => ({ pipe: () => ({}) }),
  },
}));

// Mock @tanstack/react-router so redirect/notFound are pure value factories
vi.mock('@tanstack/react-router', () => ({
  redirect: (options: unknown) => ({ _tag: 'TanstackRedirect', options }),
  notFound: () => ({ _tag: 'TanstackNotFound' }),
  // Types-only exports referenced in runtime.ts — provide stubs so the import succeeds
}));

// Mock sonner (toast) pulled in by runtime.ts
vi.mock('sonner', () => ({
  toast: {
    loading: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    dismiss: vi.fn(),
  },
}));

// Mock React (for RunContext/RunProvider/useRun) so the module doesn't fail in jsdom
vi.mock('react', async () => {
  const actual = await import('react');
  return { ...actual };
});

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are declared)
// ---------------------------------------------------------------------------

const { resolveServerExit, Redirect, NotFound } = await import('~/lib/runtime.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SENTINEL = Symbol('sentinel');
const timeout = (ms: number) =>
  new Promise<typeof SENTINEL>((resolve) => setTimeout(() => resolve(SENTINEL), ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveServerExit', () => {
  it('resolves with the success value when exit is Success(Result.succeed(v))', async () => {
    const exit = Exit.succeed(Result.succeed(42));
    const result = await resolveServerExit(exit, false);
    expect(result).toBe(42);
  });

  it('rejects by throwing the tanstack redirect when exit is Success(Result.fail(Redirect))', async () => {
    const redirectInstance = Redirect.make({
      to: '/teams/$teamId',
      params: { teamId: 't1' },
    } as any);
    const exit = Exit.succeed(Result.fail(redirectInstance));
    // Redirect.make stores a function that throws redirect(options)
    // The mocked redirect() returns { _tag: 'TanstackRedirect', options }
    await expect(resolveServerExit(exit, false)).rejects.toMatchObject({
      _tag: 'TanstackRedirect',
    });
  });

  it('rejects with the notFound() result when exit is Success(Result.fail(NotFound))', async () => {
    const exit = Exit.succeed(Result.fail(NotFound.make()));
    await expect(resolveServerExit(exit, false)).rejects.toMatchObject({
      _tag: 'TanstackNotFound',
    });
  });

  it('NEVER settles when the exit is an interrupted Failure and aborted=true', async () => {
    const exit = Exit.interrupt();
    const promise = resolveServerExit(exit, true);
    // If the promise never settles, race resolves with SENTINEL before it
    const winner = await Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      timeout(50),
    ]);
    expect(winner).toBe(SENTINEL);
  });

  it('NEVER settles when the exit is a die(undefined) Failure and aborted=true (regression: no bare undefined rejection)', async () => {
    const exit = Exit.die(undefined);
    const promise = resolveServerExit(exit, true);
    const winner = await Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      timeout(50),
    ]);
    expect(winner).toBe(SENTINEL);
  });

  it('rejects with a real Error when the exit is a die(Error) Failure and aborted=false', async () => {
    const boom = new Error('boom');
    const exit = Exit.die(boom);
    await expect(resolveServerExit(exit, false)).rejects.toBeInstanceOf(Error);
    await expect(resolveServerExit(exit, false)).rejects.toHaveProperty('message', 'boom');
  });

  it('rejects with a real Error (not undefined) when exit is die(undefined) and aborted=false — core regression guard', async () => {
    const exit = Exit.die(undefined);
    // Use rejects assertion so vitest handles the promise; also assert the type
    await expect(resolveServerExit(exit, false)).rejects.toBeInstanceOf(Error);
    // Run again to verify it never rejects with bare undefined
    await expect(resolveServerExit(exit, false)).rejects.not.toBeUndefined();
  });

  it('NEVER settles when the exit has an interrupt-only Cause and aborted=false', async () => {
    const exit = Exit.failCause(Cause.interrupt());
    const promise = resolveServerExit(exit, false);
    const winner = await Promise.race([
      promise.then(
        () => 'resolved',
        () => 'rejected',
      ),
      timeout(50),
    ]);
    expect(winner).toBe(SENTINEL);
  });
});
