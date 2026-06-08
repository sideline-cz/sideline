import { describe, expect, it } from '@effect/vitest';
import type { EmailForwarding } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import { emailSummarizerEffect } from '~/services/EmailSummarizer.js';
import { LlmClient, LlmError } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const EMAIL_ID_1 = '11111111-1111-1111-1111-111111111111' as EmailForwarding.EmailMessageId;
const EMAIL_ID_2 = '22222222-2222-2222-2222-222222222222' as EmailForwarding.EmailMessageId;
const TEAM_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

type EmailRecord = {
  id: EmailForwarding.EmailMessageId;
  team_id: string;
  status: EmailForwarding.EmailStatus;
  from_address: string;
  subject: string;
  body: string;
  summary: Option.Option<string>;
  summarize_attempts: number;
  last_error: Option.Option<string>;
  approval_request_message_id: Option.Option<string>;
  approved_by: Option.Option<string>;
  rejected_by: Option.Option<string>;
  posted_channel_id: Option.Option<string>;
  received_at: DateTime.Utc;
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

let emailStore: Map<EmailForwarding.EmailMessageId, EmailRecord>;
let enqueuedEvents: Array<{ emailId: EmailForwarding.EmailMessageId; kind: string }>;

const now = DateTime.makeUnsafe('2024-01-01T00:00:00Z');

const makeEmailRecord = (
  id: EmailForwarding.EmailMessageId,
  overrides: Partial<EmailRecord> = {},
): EmailRecord => ({
  id,
  team_id: TEAM_ID,
  status: 'received',
  from_address: 'sender@example.com',
  subject: 'Team Update',
  body: 'Please read the latest news from the team.',
  summary: Option.none(),
  summarize_attempts: 0,
  last_error: Option.none(),
  approval_request_message_id: Option.none(),
  approved_by: Option.none(),
  rejected_by: Option.none(),
  posted_channel_id: Option.none(),
  received_at: now,
  created_at: now,
  updated_at: now,
  ...overrides,
});

const resetStores = () => {
  emailStore = new Map();
  enqueuedEvents = [];
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeMockEmailMessagesRepository = () =>
  Layer.succeed(EmailMessagesRepository, {
    _tag: 'api/EmailMessagesRepository' as const,
    insertReceived: () => Effect.die(new Error('not implemented')),
    findById: (id: EmailForwarding.EmailMessageId) => {
      const row = emailStore.get(id);
      return Effect.succeed(row ? Option.some(row) : Option.none());
    },
    findReceivedBatch: (limit: number) => {
      const received = Array.from(emailStore.values())
        .filter((r) => r.status === 'received')
        .slice(0, limit)
        .map((r) => r.id);
      return Effect.succeed(received);
    },
    claimForSummarizing: (id: EmailForwarding.EmailMessageId) => {
      const row = emailStore.get(id);
      if (row?.status !== 'received') return Effect.succeed(Option.none());
      emailStore.set(id, { ...row, status: 'summarizing' });
      return Effect.succeed(Option.some(id));
    },
    setSummaryPendingApproval: (id: EmailForwarding.EmailMessageId, summary: string) => {
      const row = emailStore.get(id);
      if (row) {
        emailStore.set(id, { ...row, status: 'pending_approval', summary: Option.some(summary) });
      }
      return Effect.void;
    },
    updateSummary: () => Effect.succeed(Option.none()),
    incrementAttemptsAndMaybeFail: (
      id: EmailForwarding.EmailMessageId,
      maxAttempts: number,
      error: string,
    ) => {
      const row = emailStore.get(id);
      if (row) {
        const newAttempts = row.summarize_attempts + 1;
        const newStatus: EmailForwarding.EmailStatus =
          newAttempts >= maxAttempts ? 'failed' : 'received';
        emailStore.set(id, {
          ...row,
          summarize_attempts: newAttempts,
          status: newStatus,
          last_error: Option.some(error),
        });
      }
      return Effect.void;
    },
    approve: () => Effect.succeed(Option.none()),
    reject: () => Effect.succeed(Option.none()),
    setPosted: () => Effect.void,
  } as never);

const makeMockEmailPostSyncEventsRepository = () =>
  Layer.succeed(EmailPostSyncEventsRepository, {
    _tag: 'api/EmailPostSyncEventsRepository' as const,
    enqueue: (emailId: EmailForwarding.EmailMessageId, _teamId: string, kind: string) => {
      enqueuedEvents.push({ emailId, kind });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as never);

const makeFakeLlmClientLayer = (result: 'success' | 'fail') =>
  Layer.succeed(LlmClient, {
    _tag: 'api/LlmClient' as const,
    summarizeEmail: (_input: unknown) => {
      if (result === 'fail') {
        return Effect.fail(new LlmError({ message: 'LLM failed' }));
      }
      return Effect.succeed('FAKE SUMMARY');
    },
  } as never);

const buildLayer = (llmResult: 'success' | 'fail' = 'success') =>
  Layer.mergeAll(
    makeMockEmailMessagesRepository(),
    makeMockEmailPostSyncEventsRepository(),
    makeFakeLlmClientLayer(llmResult),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailSummarizer — received email summarized successfully', () => {
  it.effect('sets status to pending_approval, saves summary, enqueues approval_request', () => {
    resetStores();
    emailStore.set(EMAIL_ID_1, makeEmailRecord(EMAIL_ID_1, { status: 'received' }));

    return emailSummarizerEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const row = emailStore.get(EMAIL_ID_1);
          expect(row).toBeDefined();
          expect(row?.status).toBe('pending_approval');
          expect(Option.isSome(row?.summary ?? Option.none())).toBe(true);
          expect((row?.summary as Option.Some<string>).value).toBe('FAKE SUMMARY');

          const approval = enqueuedEvents.filter(
            (e) => e.emailId === EMAIL_ID_1 && e.kind === 'approval_request',
          );
          expect(approval).toHaveLength(1);
        }),
      ),
      Effect.asVoid,
      Effect.provide(buildLayer('success')),
    );
  });
});

describe('EmailSummarizer — LlmClient fails 3 times → status failed', () => {
  it.effect('3rd attempt transitions email to failed status with last_error set', () => {
    resetStores();
    // Start with 2 attempts already, so on the next cycle it hits the cap of 3
    emailStore.set(
      EMAIL_ID_1,
      makeEmailRecord(EMAIL_ID_1, { status: 'received', summarize_attempts: 2 }),
    );

    return emailSummarizerEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const row = emailStore.get(EMAIL_ID_1);
          expect(row?.status).toBe('failed');
          expect(Option.isSome(row?.last_error ?? Option.none())).toBe(true);
          // No approval_request should have been enqueued
          expect(enqueuedEvents.filter((e) => e.kind === 'approval_request')).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
      Effect.provide(buildLayer('fail')),
    );
  });

  it.effect('attempts 1 and 2 keep status as received (not failed)', () => {
    resetStores();
    emailStore.set(
      EMAIL_ID_1,
      makeEmailRecord(EMAIL_ID_1, { status: 'received', summarize_attempts: 0 }),
    );

    return emailSummarizerEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const row = emailStore.get(EMAIL_ID_1);
          // At attempt 1 (0+1), should still be received
          expect(row?.status).toBe('received');
          expect(row?.summarize_attempts).toBe(1);
        }),
      ),
      Effect.asVoid,
      Effect.provide(buildLayer('fail')),
    );
  });
});

describe('EmailSummarizer — already-claimed email is skipped', () => {
  it.effect('email already in summarizing status is not processed again', () => {
    resetStores();
    // Status is already 'summarizing' — claimForSummarizing will return None
    emailStore.set(EMAIL_ID_1, makeEmailRecord(EMAIL_ID_1, { status: 'summarizing' }));

    return emailSummarizerEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // No changes should have been made — still summarizing, no events enqueued
          const row = emailStore.get(EMAIL_ID_1);
          expect(row?.status).toBe('summarizing');
          expect(enqueuedEvents).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
      Effect.provide(buildLayer('success')),
    );
  });
});

describe('EmailSummarizer — multiple emails in batch', () => {
  it.effect('processes all received emails in the batch', () => {
    resetStores();
    emailStore.set(EMAIL_ID_1, makeEmailRecord(EMAIL_ID_1, { status: 'received' }));
    emailStore.set(EMAIL_ID_2, makeEmailRecord(EMAIL_ID_2, { status: 'received' }));

    return emailSummarizerEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emailStore.get(EMAIL_ID_1)?.status).toBe('pending_approval');
          expect(emailStore.get(EMAIL_ID_2)?.status).toBe('pending_approval');
          const approvals = enqueuedEvents.filter((e) => e.kind === 'approval_request');
          expect(approvals).toHaveLength(2);
        }),
      ),
      Effect.asVoid,
      Effect.provide(buildLayer('success')),
    );
  });
});
