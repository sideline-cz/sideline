import { createHmac } from 'node:crypto';
import type { EmailForwarding } from '@sideline/domain';
import { Discord } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailWebhookLive } from '~/api/email-webhook.js';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import type { EmailForwardingConfigRow } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';

// ---------------------------------------------------------------------------
// Constants — mirror the server's test signing secret from vitest.config.ts
// ---------------------------------------------------------------------------

const SIGNING_SECRET = 'test-signing-secret-for-vitest';
const VALID_TOKEN = 'valid-inbound-token-abc123';
const DISABLED_TOKEN = 'disabled-inbound-token-xyz';
const UNKNOWN_TOKEN = 'not-found-token';
const TEAM_ID = '00000000-0000-0000-0000-000000000001';
// monitored_addresses is an allow-list of SENDERS; must match the payload `from`.
const MONITORED_ADDRESS = 'sender@external.com';

// ---------------------------------------------------------------------------
// HMAC helper
// ---------------------------------------------------------------------------

const signBody = (body: string): string =>
  createHmac('sha256', SIGNING_SECRET).update(Buffer.from(body)).digest('hex');

// ---------------------------------------------------------------------------
// Valid payload builder
// ---------------------------------------------------------------------------

const makePayload = (overrides: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    from: 'sender@external.com',
    to: [MONITORED_ADDRESS],
    subject: 'Test email',
    text: 'Hello team',
    html: null,
    received_at: '2024-01-01T12:00:00Z',
    attachments: null,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

let insertedMessages: Array<{
  team_id: string;
  from_address: string;
  subject: string;
  body: string;
}>;
let insertedAttachments: Array<{
  messageId: EmailForwarding.EmailMessageId;
  filename: string;
  content: Uint8Array;
}>;
let nextMessageId = 1;

const makeNextMessageId = () =>
  `${String(nextMessageId++).padStart(8, '0')}-0000-0000-0000-000000000000` as EmailForwarding.EmailMessageId;

const resetStores = () => {
  insertedMessages = [];
  insertedAttachments = [];
  nextMessageId = 1;
};

// ---------------------------------------------------------------------------
// Mock config (returns config based on token)
// ---------------------------------------------------------------------------

const makeConfig = (
  token: string,
  enabled: boolean,
  monitoredAddresses: readonly string[],
): EmailForwardingConfigRow => ({
  team_id: TEAM_ID as any,
  enabled,
  target_channel_id: Schema.decodeSync(Discord.Snowflake)('111111111111111111'),
  coach_channel_id: Schema.decodeSync(Discord.Snowflake)('222222222222222222'),
  monitored_addresses: monitoredAddresses as any,
  inbound_token: token,
  imap_enabled: false,
  imap_host: Option.none(),
  imap_port: Option.none(),
  imap_username: Option.none(),
  imap_secret_encrypted: Option.none(),
  imap_use_tls: true,
  imap_folder: Option.none(),
  imap_last_seen_uid: 0,
  imap_uid_validity: Option.none(),
  imap_last_synced_at: Option.none(),
  created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
  updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
});

const MockConfigRepositoryLayer = Layer.succeed(EmailForwardingConfigRepository, {
  _tag: 'api/EmailForwardingConfigRepository' as const,
  findByTeam: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('not implemented')),
  findByInboundToken: (token: string) => {
    if (token === VALID_TOKEN) {
      return Effect.succeed(Option.some(makeConfig(VALID_TOKEN, true, [MONITORED_ADDRESS])));
    }
    if (token === DISABLED_TOKEN) {
      return Effect.succeed(Option.some(makeConfig(DISABLED_TOKEN, false, [MONITORED_ADDRESS])));
    }
    return Effect.succeed(Option.none());
  },
  regenerateToken: () => Effect.die(new Error('not implemented')),
} as never);

const MockMessagesRepositoryLayer = Layer.succeed(EmailMessagesRepository, {
  _tag: 'api/EmailMessagesRepository' as const,
  insertReceived: (input: {
    team_id: unknown;
    from_address: string;
    subject: string;
    body: string;
    received_at: unknown;
  }) => {
    const id = makeNextMessageId();
    insertedMessages.push({
      team_id: String(input.team_id),
      from_address: input.from_address,
      subject: input.subject,
      body: input.body,
    });
    return Effect.succeed(id);
  },
  findById: () => Effect.succeed(Option.none()),
  findReceivedBatch: () => Effect.succeed([]),
  claimForSummarizing: () => Effect.succeed(Option.none()),
  setSummaryPendingApproval: () => Effect.void,
  updateSummary: () => Effect.succeed(Option.none()),
  incrementAttemptsAndMaybeFail: () => Effect.void,
  approve: () => Effect.succeed(Option.none()),
  reject: () => Effect.succeed(Option.none()),
  setPosted: () => Effect.void,
} as never);

const MockAttachmentsRepositoryLayer = Layer.succeed(EmailAttachmentsRepository, {
  _tag: 'api/EmailAttachmentsRepository' as const,
  insertMany: (
    messageId: EmailForwarding.EmailMessageId,
    attachments: ReadonlyArray<{
      filename: string;
      content_type: string;
      size_bytes: number;
      content_base64: string;
    }>,
  ) => {
    for (const att of attachments) {
      insertedAttachments.push({
        messageId,
        filename: att.filename,
        content: Buffer.from(att.content_base64, 'base64'),
      });
    }
    return Effect.void;
  },
  listMetaByEmail: () => Effect.succeed([]),
  findByIdWithBytes: () => Effect.succeed(Option.none()),
} as never);

// ---------------------------------------------------------------------------
// Build test layer for the webhook
// EmailWebhookLive = Layer<never, never, HttpRouter | Repos>
// HttpRouter.layer = Layer<HttpRouter>  (empty router)
//
// We need:
// 1. HttpRouter.layer to provide the router (and be in the output ServiceMap)
// 2. EmailWebhookLive's routes registered on the router (side-effect)
// 3. Repos in the *output* ServiceMap so request fibers can access them
//
// Layer.provideMerge(self, that) satisfies self's requirements from that
// AND merges that's output into the result ServiceMap.
// ---------------------------------------------------------------------------

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([]);
    },
    {
      safe: undefined as never,
      withoutTransforms: function (this: unknown) {
        return this;
      },
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => effect,
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => Effect.succeed([] as never[]),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => Effect.succeed([] as never[]),
      or: (..._args: unknown[]) => Effect.succeed([] as never[]),
    },
  ) as unknown as SqlClient.SqlClient,
);

const WebhookTestLayer = Layer.merge(HttpRouter.layer, EmailWebhookLive).pipe(
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provideMerge(MockConfigRepositoryLayer),
  Layer.provideMerge(MockMessagesRepositoryLayer),
  Layer.provideMerge(MockAttachmentsRepositoryLayer),
  Layer.provideMerge(MockSqlClientLayer),
);

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(WebhookTestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const webhookUrl = (token: string) => `http://localhost/email/inbound/${token}`;

const postWebhook = (
  token: string,
  body: string,
  sig?: string,
  extraHeaders?: Record<string, string>,
) =>
  handler(
    new Request(webhookUrl(token), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signature': sig ?? signBody(body),
        ...extraHeaders,
      },
      body,
    }),
  );

// ---------------------------------------------------------------------------
// Security gates
// ---------------------------------------------------------------------------

describe('Email webhook — security gates', () => {
  it('valid token + valid HMAC + monitored address → 202 + row inserted', async () => {
    const body = makePayload();
    const response = await postWebhook(VALID_TOKEN, body);
    expect(response.status).toBe(202);
    expect(insertedMessages).toHaveLength(1);
    expect(insertedMessages[0].from_address).toBe('sender@external.com');
    expect(insertedMessages[0].subject).toBe('Test email');
  });

  it('bad HMAC → 401, no row inserted', async () => {
    const body = makePayload();
    const response = await postWebhook(VALID_TOKEN, body, 'deadbeefdeadbeef');
    expect(response.status).toBe(401);
    expect(insertedMessages).toHaveLength(0);
  });

  it('unknown token → 404, no row inserted', async () => {
    const body = makePayload();
    const response = await postWebhook(UNKNOWN_TOKEN, body);
    expect(response.status).toBe(404);
    expect(insertedMessages).toHaveLength(0);
  });

  it('disabled token → 404, no row inserted', async () => {
    const body = makePayload();
    // Need valid HMAC for the disabled config path
    const response = await postWebhook(DISABLED_TOKEN, body);
    expect(response.status).toBe(404);
    expect(insertedMessages).toHaveLength(0);
  });

  it('sender not in monitored_addresses → 200 ack, no row inserted', async () => {
    const body = makePayload({ from: 'stranger@other.com' });
    const response = await postWebhook(VALID_TOKEN, body);
    expect(response.status).toBe(200);
    expect(insertedMessages).toHaveLength(0);
  });

  it('single attachment > 10MB → 413, nothing persisted', async () => {
    // Create a base64 string that decodes to > 10MB
    const bigContentBase64 = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    const body = makePayload({
      attachments: [
        {
          filename: 'bigfile.pdf',
          content_type: 'application/pdf',
          size: 11 * 1024 * 1024,
          content_base64: bigContentBase64,
        },
      ],
    });
    const response = await postWebhook(VALID_TOKEN, body);
    expect(response.status).toBe(413);
    expect(insertedMessages).toHaveLength(0);
    expect(insertedAttachments).toHaveLength(0);
  });

  it('attachments within caps → rows in email_attachments, bytes round-trip correctly', async () => {
    const originalBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const base64Content = Buffer.from(originalBytes).toString('base64');
    const body = makePayload({
      attachments: [
        {
          filename: 'logo.png',
          content_type: 'image/png',
          size: originalBytes.length,
          content_base64: base64Content,
        },
      ],
    });
    const response = await postWebhook(VALID_TOKEN, body);
    expect(response.status).toBe(202);
    expect(insertedMessages).toHaveLength(1);
    expect(insertedAttachments).toHaveLength(1);
    expect(insertedAttachments[0].filename).toBe('logo.png');
    // Verify byte-identical round-trip
    expect(insertedAttachments[0].content).toEqual(Buffer.from(originalBytes));
  });

  it('body over size cap → 413, no row inserted', async () => {
    // 36MB + a little
    const oversizedBody = 'x'.repeat(37 * 1024 * 1024);
    const response = await handler(
      new Request(webhookUrl(VALID_TOKEN), {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'x-signature': signBody(oversizedBody),
        },
        body: oversizedBody,
      }),
    );
    expect(response.status).toBe(413);
    expect(insertedMessages).toHaveLength(0);
  });

  it('malformed JSON body → 400, no row inserted', async () => {
    const body = '{ invalid json +++';
    const response = await postWebhook(VALID_TOKEN, body);
    expect(response.status).toBe(400);
    expect(insertedMessages).toHaveLength(0);
  });

  it('empty X-Signature header → 401, no row', async () => {
    const body = makePayload();
    const response = await postWebhook(VALID_TOKEN, body, '');
    expect(response.status).toBe(401);
    expect(insertedMessages).toHaveLength(0);
  });
});
