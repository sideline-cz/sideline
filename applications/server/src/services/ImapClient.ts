import { EmailForwarding } from '@sideline/domain';
import { Data, DateTime, Effect, Layer, Option, ServiceMap } from 'effect';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ImapConnectionError extends Data.TaggedError('ImapConnectionError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ---------------------------------------------------------------------------
// Params / result types
// ---------------------------------------------------------------------------

export interface ImapFetchParams {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly secret: string;
  readonly useTls: boolean;
  readonly folder: string;
  readonly sinceUid: number;
}

export interface ImapFetchedMessage {
  readonly uid: number;
  readonly payload: EmailForwarding.InboundEmailPayload;
  readonly messageId: Option.Option<string>;
}

export interface ImapFetchResult {
  readonly uidValidity: number;
  readonly uidNext: number;
  readonly messages: ReadonlyArray<ImapFetchedMessage>;
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface ImapClientService {
  readonly fetchSince: (
    params: ImapFetchParams,
  ) => Effect.Effect<ImapFetchResult, ImapConnectionError>;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make: Effect.Effect<ImapClientService> = Effect.succeed({
  fetchSince: (params: ImapFetchParams): Effect.Effect<ImapFetchResult, ImapConnectionError> => {
    const connectEffect = Effect.tryPromise({
      try: () =>
        new Promise<ImapFlow>((resolve, reject) => {
          const client = new ImapFlow({
            host: params.host,
            port: params.port,
            secure: params.useTls,
            auth: {
              user: params.username,
              pass: params.secret,
            },
            logger: false,
            socketTimeout: 20000,
          });
          client
            .connect()
            .then(() => resolve(client))
            .catch(reject);
        }),
      catch: (e) =>
        new ImapConnectionError({ message: `IMAP connect failed: ${String(e)}`, cause: e }),
    });

    const acquireClient = Effect.acquireRelease(connectEffect, (client) =>
      Effect.tryPromise({
        try: () => client.logout(),
        catch: () => new ImapConnectionError({ message: 'IMAP logout failed' }),
      }).pipe(Effect.ignore),
    );

    return Effect.scoped(
      Effect.Do.pipe(
        Effect.bind('client', () => acquireClient),
        Effect.bind('result', ({ client }) =>
          Effect.tryPromise({
            try: async () => {
              const lock = await client.getMailboxLock(params.folder);
              try {
                const mailbox = client.mailbox;
                if (!mailbox) {
                  throw new Error('Mailbox is not open');
                }

                const rawUidValidity = Number(mailbox.uidValidity);
                const rawUidNext = Number(mailbox.uidNext);

                // Guard against non-positive-integer values that would corrupt the
                // INTEGER NOT NULL watermark columns in the database.
                if (!Number.isInteger(rawUidValidity) || rawUidValidity < 1) {
                  throw new ImapConnectionError({
                    message: 'IMAP mailbox returned invalid uidValidity',
                  });
                }
                if (!Number.isInteger(rawUidNext) || rawUidNext < 1) {
                  throw new ImapConnectionError({
                    message: 'IMAP mailbox returned invalid uidNext',
                  });
                }

                const uidValidity = rawUidValidity;
                const uidNext = rawUidNext;

                const fetchStart = params.sinceUid + 1;
                const fetchEnd = params.sinceUid + 50;
                const range = `${String(fetchStart)}:${String(fetchEnd)}`;

                const messages: ImapFetchedMessage[] = [];

                for await (const msg of client.fetch(
                  range,
                  { source: true, uid: true },
                  { uid: true },
                )) {
                  // FIX 2: stop at the first message that cannot be fetched/parsed
                  // and return only the contiguous successfully-parsed prefix.
                  // A missing source or parse failure could silently drop a lower
                  // UID while returning higher ones — instead we break so the
                  // poller's watermark stays below the problematic message and
                  // retries it next cycle.
                  if (!msg.source) {
                    const uid = Number(msg.uid);
                    console.warn(
                      `ImapClient: message uid=${String(uid)} folder=${params.folder} has no source — stopping fetch at this message`,
                    );
                    break;
                  }

                  let parsed: Awaited<ReturnType<typeof simpleParser>>;
                  try {
                    parsed = await simpleParser(msg.source);
                  } catch (parseErr) {
                    const uid = Number(msg.uid);
                    console.warn(
                      `ImapClient: failed to parse message uid=${String(uid)} folder=${params.folder} — stopping fetch at this message`,
                      parseErr,
                    );
                    break;
                  }

                  const attachments = (parsed.attachments ?? []).map(
                    (att) =>
                      new EmailForwarding.EmailAttachmentPayload({
                        filename: (att.filename ?? 'attachment').slice(0, 255),
                        content_type: (att.contentType ?? 'application/octet-stream').slice(0, 255),
                        size: att.size ?? att.content.byteLength,
                        content_base64: att.content.toString('base64'),
                      }),
                  );

                  const receivedAt = parsed.date
                    ? Option.some(DateTime.fromDateUnsafe(parsed.date))
                    : Option.none<DateTime.Utc>();

                  const payload = new EmailForwarding.InboundEmailPayload({
                    from: parsed.from?.text ?? '',
                    to: [
                      ...(parsed.to
                        ? Array.isArray(parsed.to)
                          ? parsed.to.flatMap((a) => a.value.map((v) => v.address ?? ''))
                          : parsed.to.value.map((v) => v.address ?? '')
                        : []),
                    ],
                    subject: parsed.subject ?? '',
                    text: parsed.text ?? '',
                    html: parsed.html ? Option.some(parsed.html) : Option.none<string>(),
                    received_at: receivedAt,
                    attachments: attachments.length > 0 ? Option.some(attachments) : Option.none(),
                  });

                  messages.push({
                    uid: Number(msg.uid),
                    payload,
                    messageId:
                      parsed.messageId != null
                        ? Option.some(parsed.messageId)
                        : Option.none<string>(),
                  });
                }

                return { uidValidity, uidNext, messages } satisfies ImapFetchResult;
              } finally {
                lock.release();
              }
            },
            catch: (e) =>
              e instanceof ImapConnectionError
                ? e
                : new ImapConnectionError({
                    message: `IMAP fetch failed: ${String(e)}`,
                    cause: e,
                  }),
          }),
        ),
        Effect.map(({ result }) => result),
      ),
    );
  },
});

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class ImapClient extends ServiceMap.Service<ImapClient, ImapClientService>()(
  'api/ImapClient',
) {
  static readonly Default = Layer.effect(ImapClient, make);
}
