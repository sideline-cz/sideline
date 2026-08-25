// Tests for src/lib/rules/progress.ts
import type { Answer, ScenarioId } from '@sideline/rules';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `test/setup.ts` stubs `localStorage` as `vi.fn(() => null)`, not a real
// store — install a map-backed stub per test, mirroring the idiom in
// `src/lib/resolveStoredTheme.test.ts`.
let store: Record<string, string> = {};

function setupLocalStorage() {
  store = {};
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete store[key];
      }),
      clear: vi.fn(() => {
        store = {};
      }),
    },
    writable: true,
    configurable: true,
  });
}

// No runtime constructor exists for `ScenarioId` (see `packages/rules`'s
// `types.ts`) — this mirrors `packages/rules/test/engine/helpers.ts`'s own
// `sid` fixture helper.
const sid = (s: string): ScenarioId => s as ScenarioId;

function makeAnswer(overrides: Partial<Answer> = {}): Answer {
  return { steps: [{ pick: 0, ok: true }], done: true, ok: true, ...overrides };
}

beforeEach(() => {
  setupLocalStorage();
});

describe('progress', () => {
  it('round-trips a saved payload', async () => {
    const { saveProgress, loadProgress } = await import('~/lib/rules/progress.js');
    const progress = {
      version: 1 as const,
      answers: { [sid('s1')]: makeAnswer() },
      sel: [1, 3] as const,
    };
    saveProgress(progress);
    expect(loadProgress()).toEqual(progress);
  });

  it('returns a fresh empty progress when nothing is stored', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('returns a fresh empty progress on a corrupt (non-JSON) payload', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem('sideline.rules.progress.v1', '{not json');
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('returns a fresh empty progress on a structurally invalid payload', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem('sideline.rules.progress.v1', JSON.stringify({ foo: 'bar' }));
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('returns a fresh empty progress on an older/unknown version', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem(
      'sideline.rules.progress.v1',
      JSON.stringify({ version: 0, answers: {}, sel: [1] }),
    );
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('rejects a level outside 1..9 in `sel`', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem(
      'sideline.rules.progress.v1',
      JSON.stringify({ version: 1, answers: {}, sel: [42] }),
    );
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('rejects an answer with a malformed step', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem(
      'sideline.rules.progress.v1',
      JSON.stringify({
        version: 1,
        answers: { s1: { steps: [{ pick: 'not-a-number', ok: true }], done: true, ok: true } },
        sel: [1],
      }),
    );
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
  });

  it('still loads a payload carrying `importedAt` (additive field, not rejected)', async () => {
    const { loadProgress } = await import('~/lib/rules/progress.js');
    localStorage.setItem(
      'sideline.rules.progress.v1',
      JSON.stringify({
        version: 1,
        answers: { [sid('s1')]: makeAnswer() },
        sel: [1],
        importedAt: 1_700_000_000_000,
      }),
    );
    expect(loadProgress()).toEqual({
      version: 1,
      answers: { [sid('s1')]: makeAnswer() },
      sel: [1],
      importedAt: 1_700_000_000_000,
    });
  });

  it('round-trips `importedAt` through `saveProgress`/`loadProgress`', async () => {
    const { saveProgress, loadProgress } = await import('~/lib/rules/progress.js');
    const progress = {
      version: 1 as const,
      answers: { [sid('s1')]: makeAnswer() },
      sel: [1] as const,
      importedAt: 1_700_000_000_000,
    };
    saveProgress(progress);
    expect(loadProgress()).toEqual(progress);
  });

  it('never throws when localStorage is unavailable', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('SecurityError: localStorage unavailable');
      },
      configurable: true,
    });
    const { loadProgress, saveProgress } = await import('~/lib/rules/progress.js');
    expect(() => loadProgress()).not.toThrow();
    expect(loadProgress()).toEqual({ version: 1, answers: {}, sel: [] });
    expect(() => saveProgress({ version: 1, answers: {}, sel: [1] })).not.toThrow();
  });
});
