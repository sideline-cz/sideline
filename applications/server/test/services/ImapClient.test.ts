// Unit tests for the REAL `ImapClient.fetchSince` implementation.
//
// `fetchSince` constructs an `ImapFlow` directly and calls `mailparser`'s
// `simpleParser`, so we mock both modules (via `vi.hoisted` state the tests
// drive per case) to exercise the real fetch loop without a live IMAP server.
//
// These tests PIN the load-bearing behaviour so the planned Effect refactor of
// the fetch loop can't silently regress it:
//   - uidValidity / uidNext validation → ImapConnectionError
//   - contiguous-prefix break: stop at the first message with no source OR that
//     fails to parse, returning only the successfully-parsed prefix (so the
//     poller watermark never advances past a problem message)
//   - payload mapping (from/to/subject/text/html/attachments/received_at/id)
//   - the mailbox lock is always released (success, break, and error paths)
//   - the fetch range is `sinceUid+1 : sinceUid+50`

import { Effect, Exit, Option } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImapClient, ImapConnectionError, type ImapFetchParams } from '~/services/ImapClient.js';

// ---------------------------------------------------------------------------
// Mock state (hoisted so the vi.mock factories below can close over it)
// ---------------------------------------------------------------------------

type FakeMessage = { readonly uid: number; readonly source: Buffer | undefined };

const state = vi.hoisted(() => ({
  mailbox: { uidValidity: 1 as unknown, uidNext: 10 as unknown } as
    | { uidValidity: unknown; uidNext: unknown }
    | false,
  messages: [] as ReadonlyArray<FakeMessage>,
  connectError: null as Error | null,
  parse: null as null | ((source: Buffer) => Promise<unknown>),
  release: vi.fn(),
  logout: vi.fn(() => Promise.resolve()),
  lastRange: null as string | null,
}));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox: unknown = false;
    connect() {
      return state.connectError ? Promise.reject(state.connectError) : Promise.resolve();
    }
    getMailboxLock(_folder: string) {
      // Real imapflow opens the mailbox as part of acquiring the lock.
      this.mailbox = state.mailbox;
      return Promise.resolve({ release: state.release });
    }
    async *fetch(range: string, _opts: unknown, _opts2: unknown) {
      state.lastRange = range;
      for (const msg of state.messages) {
        yield msg;
      }
    }
    logout() {
      return state.logout();
    }
  },
}));

vi.mock('mailparser', () => ({
  simpleParser: (source: Buffer) => (state.parse ? state.parse(source) : Promise.resolve({})),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARAMS: ImapFetchParams = {
  host: 'imap.example.com',
  port: 993,
  username: 'user',
  secret: 'secret',
  useTls: true,
  folder: 'INBOX',
  sinceUid: 100,
};

const run = (params: ImapFetchParams = PARAMS) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const client = yield* ImapClient;
      return yield* client.fetchSince(params);
    }).pipe(Effect.provide(ImapClient.Default)),
  );

/** Runs and expects failure: `Effect.flip` surfaces the error as the success value. */
const runError = (params: ImapFetchParams = PARAMS) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* ImapClient;
      return yield* client.fetchSince(params);
    }).pipe(Effect.provide(ImapClient.Default), Effect.flip),
  );

/** A minimal `ParsedMail`-shaped object for the happy path. */
const parsedOk = (over: Record<string, unknown> = {}) => ({
  from: { text: 'sender@example.com' },
  to: { value: [{ address: 'recipient@example.com' }] },
  subject: 'Subject',
  text: 'Body text',
  html: '<p>Body</p>',
  date: new Date('2024-06-01T08:30:00Z'),
  attachments: [],
  messageId: '<mid-1@example.com>',
  ...over,
});

beforeEach(() => {
  state.mailbox = { uidValidity: 1, uidNext: 10 };
  state.messages = [];
  state.connectError = null;
  state.parse = async () => parsedOk();
  state.release.mockClear();
  state.logout.mockClear();
  state.lastRange = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImapClient.fetchSince', () => {
  it('maps a fetched message into an InboundEmailPayload and returns uid metadata', async () => {
    state.mailbox = { uidValidity: 7, uidNext: 205 };
    state.messages = [{ uid: 101, source: Buffer.from('raw-1') }];
    state.parse = async () =>
      parsedOk({
        attachments: [
          {
            filename: 'report.pdf',
            contentType: 'application/pdf',
            size: 3,
            content: Buffer.from('abc'),
          },
        ],
      });

    const exit = await run();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    const result = exit.value;

    expect(result.uidValidity).toBe(7);
    expect(result.uidNext).toBe(205);
    expect(result.messages).toHaveLength(1);

    const [m] = result.messages;
    expect(m.uid).toBe(101);
    expect(m.messageId).toStrictEqual(Option.some('<mid-1@example.com>'));
    expect(m.payload.from).toBe('sender@example.com');
    expect(m.payload.to).toStrictEqual(['recipient@example.com']);
    expect(m.payload.subject).toBe('Subject');
    expect(m.payload.text).toBe('Body text');
    expect(m.payload.html).toStrictEqual(Option.some('<p>Body</p>'));
    expect(Option.isSome(m.payload.received_at)).toBe(true);
    expect(Option.isSome(m.payload.attachments)).toBe(true);
    const atts = Option.getOrThrow(m.payload.attachments);
    expect(atts).toHaveLength(1);
    expect(atts[0].filename).toBe('report.pdf');
    expect(atts[0].content_type).toBe('application/pdf');
    expect(atts[0].content_base64).toBe(Buffer.from('abc').toString('base64'));

    // Fetch range is sinceUid+1 : sinceUid+50, and the lock was released.
    expect(state.lastRange).toBe('101:150');
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('returns empty messages (with uid metadata) when the range yields nothing', async () => {
    state.messages = [];
    const exit = await run();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.messages).toHaveLength(0);
    expect(exit.value.uidValidity).toBe(1);
    expect(exit.value.uidNext).toBe(10);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('stops at the first message with no source, returning only the contiguous prefix', async () => {
    state.messages = [
      { uid: 101, source: Buffer.from('ok') },
      { uid: 102, source: undefined },
      { uid: 103, source: Buffer.from('would-be-ok') },
    ];
    const exit = await run();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.messages.map((m) => m.uid)).toStrictEqual([101]);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('stops at the first message that fails to parse, returning only the contiguous prefix', async () => {
    state.messages = [
      { uid: 101, source: Buffer.from('ok') },
      { uid: 102, source: Buffer.from('bad') },
      { uid: 103, source: Buffer.from('ok-again') },
    ];
    state.parse = async (source: Buffer) => {
      if (source.toString() === 'bad') throw new Error('parse boom');
      return parsedOk();
    };
    const exit = await run();
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(exit.value.messages.map((m) => m.uid)).toStrictEqual([101]);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('fails with ImapConnectionError on a non-positive uidValidity (and releases the lock)', async () => {
    state.mailbox = { uidValidity: 0, uidNext: 10 };
    const err = await runError();
    expect(err).toBeInstanceOf(ImapConnectionError);
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('fails with ImapConnectionError on a non-integer uidNext', async () => {
    state.mailbox = { uidValidity: 1, uidNext: 3.5 };
    const err = await runError();
    expect(err).toBeInstanceOf(ImapConnectionError);
  });

  it('fails with ImapConnectionError when connect rejects', async () => {
    state.connectError = new Error('ECONNREFUSED');
    const err = await runError();
    expect(err).toBeInstanceOf(ImapConnectionError);
    // Connect failed before the lock was acquired.
    expect(state.release).not.toHaveBeenCalled();
  });
});
