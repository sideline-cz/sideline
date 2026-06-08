import { createHmac, timingSafeEqual } from 'node:crypto';
import { EmailForwarding } from '@sideline/domain';
import { DateTime, Effect, Option, Redacted, Schema } from 'effect';
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { env } from '~/env.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import { EmailForwardingConfigRepository } from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 36 * 1024 * 1024; // 36 MB
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------------------------------------------------------------------------
// HMAC validation
// ---------------------------------------------------------------------------

const verifySignature = (rawBody: Uint8Array, signature: string, secret: string): boolean => {
  try {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Tagged errors for early-exit
// ---------------------------------------------------------------------------

class WebhookEarlyExit {
  readonly _tag = 'WebhookEarlyExit' as const;
  constructor(readonly response: HttpServerResponse.HttpServerResponse) {}
}

const earlyExit = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.fail(new WebhookEarlyExit(response));

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const handleInbound = (
  request: HttpServerRequest.HttpServerRequest,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  | EmailForwardingConfigRepository
  | EmailMessagesRepository
  | EmailAttachmentsRepository
  | SqlClient.SqlClient
> =>
  Effect.Do.pipe(
    Effect.bind('configRepo', () => EmailForwardingConfigRepository.asEffect()),
    Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
    Effect.bind('attachmentsRepo', () => EmailAttachmentsRepository.asEffect()),
    Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),

    // Extract token from path params
    Effect.bind('params', () => HttpRouter.params),
    Effect.bind('token', ({ params }) => {
      const t = params.token;
      return Effect.succeed(t ?? '');
    }),

    // Read raw body with size cap
    Effect.bind('bodyBuf', () => request.arrayBuffer),
    Effect.flatMap(({ token, bodyBuf, configRepo, messagesRepo, attachmentsRepo, sql }) => {
      if (bodyBuf.byteLength > MAX_BODY_BYTES) {
        return Effect.succeed(HttpServerResponse.text('Payload too large', { status: 413 }));
      }
      const rawBody = new Uint8Array(bodyBuf);

      return Effect.Do.pipe(
        // HMAC verification first — avoids DB probe on unsigned requests
        Effect.tap(() => {
          const sig =
            typeof request.headers['x-signature'] === 'string'
              ? request.headers['x-signature']
              : '';
          const signingSecret = Redacted.value(env.EMAIL_WEBHOOK_SIGNING_SECRET);
          return verifySignature(rawBody, sig, signingSecret)
            ? Effect.void
            : earlyExit(HttpServerResponse.text('Unauthorized', { status: 401 }));
        }),

        // Lookup config by token
        Effect.bind('config', () =>
          configRepo.findByInboundToken(token).pipe(
            Effect.flatMap((opt) =>
              Option.match(opt, {
                onNone: () => earlyExit(HttpServerResponse.text('Not found', { status: 404 })),
                onSome: Effect.succeed,
              }),
            ),
          ),
        ),

        // Check enabled
        Effect.tap(({ config }) =>
          !config.enabled
            ? earlyExit(HttpServerResponse.text('Not found', { status: 404 }))
            : Effect.void,
        ),

        // Parse payload
        Effect.bind('payload', () =>
          Effect.try({
            try: () => JSON.parse(new TextDecoder().decode(rawBody)) as unknown,
            catch: () =>
              new WebhookEarlyExit(HttpServerResponse.text('Bad request', { status: 400 })),
          }).pipe(
            Effect.flatMap((parsed) =>
              Schema.decodeUnknownEffect(EmailForwarding.InboundEmailPayload)(parsed).pipe(
                Effect.mapError(
                  () =>
                    new WebhookEarlyExit(HttpServerResponse.text('Bad request', { status: 400 })),
                ),
              ),
            ),
          ),
        ),

        // Check monitored addresses — an allow-list of permitted SENDERS.
        // The UI labels these "allowed senders" ("only emails from these
        // addresses are processed"), so match against the `from` address.
        // Use a substring match so display-name forms ("Name <addr>") match too.
        Effect.tap(({ config, payload }) => {
          const monitored = config.monitored_addresses;
          if (monitored.length === 0) return Effect.void;
          const from = payload.from.toLowerCase();
          const hasMatch = monitored.some((addr) => from.includes(addr.toLowerCase()));
          if (!hasMatch) {
            return earlyExit(HttpServerResponse.text('OK', { status: 200 }));
          }
          return Effect.void;
        }),

        // Validate attachment sizes
        Effect.tap(({ payload }) => {
          const attachments = Option.getOrElse(
            payload.attachments,
            () => [] as ReadonlyArray<EmailForwarding.EmailAttachmentPayload>,
          );
          let totalBytes = 0;
          for (const att of attachments) {
            const decoded = Buffer.from(att.content_base64, 'base64').byteLength;
            if (decoded > MAX_ATTACHMENT_BYTES) {
              return earlyExit(HttpServerResponse.text('Attachment too large', { status: 413 }));
            }
            totalBytes += decoded;
          }
          if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
            return earlyExit(
              HttpServerResponse.text('Total attachments too large', { status: 413 }),
            );
          }
          return Effect.void;
        }),

        // Insert message + attachments atomically
        Effect.tap(({ config, payload }) => {
          const attachments = Option.getOrElse(
            payload.attachments,
            () => [] as ReadonlyArray<EmailForwarding.EmailAttachmentPayload>,
          );
          const receivedAt = Option.getOrElse(payload.received_at, () => DateTime.nowUnsafe());
          return sql
            .withTransaction(
              messagesRepo
                .insertReceived({
                  team_id: config.team_id,
                  from_address: payload.from,
                  subject: payload.subject,
                  body: payload.text,
                  received_at: receivedAt,
                })
                .pipe(
                  Effect.flatMap((messageId) =>
                    attachmentsRepo.insertMany(
                      messageId,
                      attachments.map((a) => ({
                        filename: a.filename,
                        content_type: a.content_type,
                        size_bytes: a.size,
                        content_base64: a.content_base64,
                      })),
                    ),
                  ),
                ),
            )
            .pipe(catchSqlErrors);
        }),

        Effect.as(HttpServerResponse.text('Accepted', { status: 202 })),

        // Absorb early exits as their embedded responses
        Effect.catchTag('WebhookEarlyExit', (e) => Effect.succeed(e.response)),
      );
    }),
  ) as Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    | EmailForwardingConfigRepository
    | EmailMessagesRepository
    | EmailAttachmentsRepository
    | SqlClient.SqlClient
  >;

// ---------------------------------------------------------------------------
// Layer — registers the route on the HttpRouter
// ---------------------------------------------------------------------------

// Mount under the API prefix so the route sits behind the same `/api` path the
// reverse proxy forwards to the server (empty prefix locally → `/email/inbound`,
// `/api/email/inbound` in preview/prod). This matches the inbound URL the web UI
// builds from SERVER_URL, which already includes the prefix.
const inboundPath = `${env.API_PREFIX}/email/inbound/:token` as `/${string}`;

export const EmailWebhookLive = HttpRouter.add('POST', inboundPath, handleInbound);
