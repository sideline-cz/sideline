// TDD — written BEFORE `src/lib/downloadAttachment.ts` exists (plan §7f cases 4-5). This file
// is the condition on which §6a's extraction out of the untested `EmailDetailPage` is allowed:
// without it, a working download path gets refactored with nothing watching.
//
// Do NOT `vi.stubGlobal('URL', …)` — it kills Vite's module runner and the whole file fails at
// import. Spy on the real `URL.createObjectURL` / `revokeObjectURL` instead.

import { Effect, Exit, Option } from 'effect';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/token', () => ({
  getToken: Effect.succeed(Option.some('test-token')),
}));

const { AttachmentDownloadFailed, downloadAttachment } = await import(
  '~/lib/downloadAttachment.js'
);

const URL_UNDER_TEST = 'http://server.test/teams/t1/expenses/e1/attachments/a1';

let fetchMock: ReturnType<typeof vi.fn>;
let clicked: { href: string; download: string } | null;

beforeAll(() => {
  // jsdom implements neither; install real (stub) functions so `vi.spyOn` has something to wrap.
  for (const name of ['createObjectURL', 'revokeObjectURL'] as const) {
    if (typeof URL[name] !== 'function') {
      Object.defineProperty(URL, name, {
        value: () => undefined,
        writable: true,
        configurable: true,
      });
    }
  }
});

beforeEach(() => {
  clicked = null;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stub');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = { href: this.href, download: this.download };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('downloadAttachment', () => {
  it('should issue an authenticated GET and click a synthetic anchor', async () => {
    fetchMock.mockResolvedValue(new Response('bytes', { status: 200 }));

    await Effect.runPromise(downloadAttachment(URL_UNDER_TEST, 'invoice.pdf'));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(URL_UNDER_TEST);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(clicked?.download).toBe('invoice.pdf');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:stub');
    // The anchor must not be left behind in the document.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('should fail with AttachmentDownloadFailed on a non-ok response and revoke nothing', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));

    const exit = await Effect.runPromiseExit(downloadAttachment(URL_UNDER_TEST, 'invoice.pdf'));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(Option.getOrNull(Exit.findErrorOption(exit))).toBeInstanceOf(AttachmentDownloadFailed);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(clicked).toBeNull();
  });

  it('should fail with AttachmentDownloadFailed when fetch itself rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));

    const exit = await Effect.runPromiseExit(downloadAttachment(URL_UNDER_TEST, 'invoice.pdf'));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
