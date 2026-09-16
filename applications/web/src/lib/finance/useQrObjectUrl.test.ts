// TDD mode — tests written BEFORE `useQrObjectUrl.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D6 / §3.4 (F1) / §7.2 tests 180-183. The Fio
// token endpoint requires an `Authorization` header — the API token lives in
// `BrowserKeyValueStore.layerLocalStorage`, not a cookie, so a browser-issued `<img src=...>`
// request would 401 for every player. This hook is the fix: authenticated `fetch` -> `blob()` ->
// `URL.createObjectURL`, with `URL.revokeObjectURL` on unmount (and on every re-fetch).
//
// Contract this file pins down for `applications/web/src/lib/finance/useQrObjectUrl.ts`:
//
//   export type UseQrObjectUrlState = 'loading' | 'ready' | 'error';
//   export interface UseQrObjectUrlResult {
//     readonly url: string | null;
//     readonly state: UseQrObjectUrlState;
//   }
//   export function useQrObjectUrl(teamId: string, feeId: string, assignmentId: string): UseQrObjectUrlResult
//
// It reads the bearer token from `~/lib/token.js`'s `getToken` and the API base from
// `~/lib/translation-overrides-context.js`'s `useServerUrl()` — both mocked below so this test
// exercises only the hook's own fetch/cleanup contract.

import { renderHook } from '@testing-library/react';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SERVER_URL = 'https://api.example.test';
const TEST_TOKEN = 'test-bearer-token';

vi.mock('~/lib/translation-overrides-context.js', () => ({
  useServerUrl: () => SERVER_URL,
}));

vi.mock('~/lib/token.js', async () => {
  const { Effect: EffectNs, Option: OptionNs } = await import('effect');
  return {
    getToken: EffectNs.succeed(OptionNs.some(TEST_TOKEN)),
  };
});

const TEAM_ID = 'team-1';
const FEE_ID = 'fee-1';
const ASSIGNMENT_ID = 'assignment-1';

let fetchMock: ReturnType<typeof vi.fn>;
// Typed to match the real `URL` members so `vi.spyOn(...).mockImplementation(...)` accepts them,
// while staying `Mock<...>` so the `toHaveBeenCalledWith` matchers below still type-check.
let createObjectUrlMock: Mock<(obj: Blob | MediaSource) => string>;
let revokeObjectUrlMock: Mock<(url: string) => void>;
let objectUrlCounter: number;

const pngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });

const okResponse = () =>
  ({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(pngBlob()),
  }) as unknown as Response;

const errorResponse = (status: number) =>
  ({
    ok: false,
    status,
    blob: () => Promise.resolve(pngBlob()),
  }) as unknown as Response;

beforeEach(() => {
  objectUrlCounter = 0;
  fetchMock = vi.fn().mockResolvedValue(okResponse());
  createObjectUrlMock = vi.fn().mockImplementation(() => {
    objectUrlCounter += 1;
    return `blob:mock-url-${String(objectUrlCounter)}`;
  });
  revokeObjectUrlMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Spy on the real `URL` rather than replacing the global with a plain object.
  // `vi.stubGlobal('URL', { ...URL, ... })` yields a non-constructible object, and Vite's
  // module runner calls `new URL(...)` on the global to resolve a dynamically-imported
  // module's file:// path — so every `await import(...)` below would die with
  // "URL is not a constructor" before the hook under test ever ran. Reproduced with a
  // zero-import module, so it is the stubbing pattern, not this hook.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectUrlMock);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectUrlMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 180 — Authorization header carries the bearer token from lib/token.ts
// ---------------------------------------------------------------------------

describe('useQrObjectUrl — authenticated fetch (180)', () => {
  it('the request carries Authorization: Bearer <token>, which a plain <img src> could not', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, unmount } = renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, ASSIGNMENT_ID));

    await vi.waitFor(() => {
      expect(result.current.state).toBe('ready');
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/teams/${TEAM_ID}/fees/${FEE_ID}/assignments/${ASSIGNMENT_ID}/qr.png`);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${TEST_TOKEN}`);

    unmount();
  });

  it('resolves to state "ready" with the created object URL', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, unmount } = renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, ASSIGNMENT_ID));

    expect(result.current.state).toBe('loading');
    await vi.waitFor(() => {
      expect(result.current.state).toBe('ready');
    });
    expect(result.current.url).toBe('blob:mock-url-1');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// 181 — URL.revokeObjectURL called with the exact URL on unmount; 5 rows -> 5 revokes
// ---------------------------------------------------------------------------

describe('useQrObjectUrl — object URL cleanup (181)', () => {
  it('revokes the exact object URL on unmount', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, unmount } = renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, ASSIGNMENT_ID));

    await vi.waitFor(() => {
      expect(result.current.state).toBe('ready');
    });
    const createdUrl = result.current.url;

    unmount();

    expect(revokeObjectUrlMock).toHaveBeenCalledWith(createdUrl);
  });

  it('rendering 5 independent rows and unmounting all produces exactly 5 revokes', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const hooks = Array.from({ length: 5 }, (_, i) =>
      renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, `assignment-${String(i)}`)),
    );

    for (const { result } of hooks) {
      await vi.waitFor(() => {
        expect(result.current.state).toBe('ready');
      });
    }

    for (const { unmount } of hooks) {
      unmount();
    }

    expect(revokeObjectUrlMock).toHaveBeenCalledTimes(5);
  });
});

// ---------------------------------------------------------------------------
// 182 — a 401/403 yields state 'error', never a broken image
// ---------------------------------------------------------------------------

describe('useQrObjectUrl — auth failure (182)', () => {
  it('a 401 response -> state "error", url stays null (never a broken <img>)', async () => {
    fetchMock.mockResolvedValue(errorResponse(401));
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, unmount } = renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, ASSIGNMENT_ID));

    await vi.waitFor(() => {
      expect(result.current.state).toBe('error');
    });
    expect(result.current.url).toBeNull();
    expect(createObjectUrlMock).not.toHaveBeenCalled();

    unmount();
  });

  it('a 403 response -> state "error"', async () => {
    fetchMock.mockResolvedValue(errorResponse(403));
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, unmount } = renderHook(() => useQrObjectUrl(TEAM_ID, FEE_ID, ASSIGNMENT_ID));

    await vi.waitFor(() => {
      expect(result.current.state).toBe('error');
    });

    unmount();
  });
});

// ---------------------------------------------------------------------------
// 183 — re-rendering with the same assignment id does not re-fetch (no object-URL churn)
// ---------------------------------------------------------------------------

describe('useQrObjectUrl — stable identity, no re-fetch churn (183)', () => {
  it('re-rendering with the same (teamId, feeId, assignmentId) does not issue a second fetch', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, rerender, unmount } = renderHook(
      ({ assignmentId }) => useQrObjectUrl(TEAM_ID, FEE_ID, assignmentId),
      { initialProps: { assignmentId: ASSIGNMENT_ID } },
    );

    await vi.waitFor(() => {
      expect(result.current.state).toBe('ready');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);

    rerender({ assignmentId: ASSIGNMENT_ID });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createObjectUrlMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrlMock).not.toHaveBeenCalled();

    unmount();
  });

  it('re-rendering with a DIFFERENT assignment id does fetch again and revokes the old URL', async () => {
    const { useQrObjectUrl } = await import('./useQrObjectUrl.js');
    const { result, rerender, unmount } = renderHook(
      ({ assignmentId }) => useQrObjectUrl(TEAM_ID, FEE_ID, assignmentId),
      { initialProps: { assignmentId: ASSIGNMENT_ID } },
    );
    await vi.waitFor(() => {
      expect(result.current.state).toBe('ready');
    });
    const firstUrl = result.current.url;

    rerender({ assignmentId: 'assignment-2' });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(revokeObjectUrlMock).toHaveBeenCalledWith(firstUrl);

    unmount();
  });
});
