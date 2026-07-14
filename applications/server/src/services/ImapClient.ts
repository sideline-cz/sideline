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

/** Maps a fetched + parsed IMAP message into the domain inbound-email payload. */
const toFetchedMessage = (
  msg: { readonly uid: unknown },
  parsed: Awaited<ReturnType<typeof simpleParser>>,
): ImapFetchedMessage => {
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

  return {
    uid: Number(msg.uid),
    payload,
    messageId: parsed.messageId != null ? Option.some(parsed.messageId) : Option.none<string>(),
  };
};

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

    // acquireRelease finalizers run in reverse order at scope close: the fetch
    // iterator is returned, then the mailbox lock is released, then the client
    // logs out — the correct teardown ordering for imapflow.
    const acquireClient = Effect.acquireRelease(connectEffect, (client) =>
      Effect.tryPromise({
        try: () => client.logout(),
        catch: () => new ImapConnectionError({ message: 'IMAP logout failed' }),
      }).pipe(Effect.ignore),
    );

    const acquireLock = (client: ImapFlow) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => client.getMailboxLock(params.folder),
          catch: (e) =>
            new ImapConnectionError({
              message: `IMAP mailbox lock failed: ${String(e)}`,
              cause: e,
            }),
        }),
        (lock) => Effect.sync(() => lock.release()),
      );

    // Read + validate the mailbox uid watermarks. Guard against non-positive-
    // integer values that would corrupt the INTEGER NOT NULL watermark columns.
    const readUids = (client: ImapFlow) => {
      const mailbox = client.mailbox;
      if (!mailbox) {
        return Effect.fail(new ImapConnectionError({ message: 'IMAP mailbox is not open' }));
      }
      const uidValidity = Number(mailbox.uidValidity);
      const uidNext = Number(mailbox.uidNext);
      if (!Number.isInteger(uidValidity) || uidValidity < 1) {
        return Effect.fail(
          new ImapConnectionError({ message: 'IMAP mailbox returned invalid uidValidity' }),
        );
      }
      if (!Number.isInteger(uidNext) || uidNext < 1) {
        return Effect.fail(
          new ImapConnectionError({ message: 'IMAP mailbox returned invalid uidNext' }),
        );
      }
      return Effect.succeed({ uidValidity, uidNext });
    };

    // Drain the fetch range one message at a time, stopping at the first message
    // that cannot be fetched/parsed and returning only the contiguous
    // successfully-parsed prefix. A missing source or parse failure could
    // silently drop a lower UID while returning higher ones — instead we stop so
    // the poller's watermark stays below the problematic message and retries it
    // next cycle.
    const drainMessages = (client: ImapFlow) => {
      const fetchStart = params.sinceUid + 1;
      const fetchEnd = params.sinceUid + 50;
      const range = `${String(fetchStart)}:${String(fetchEnd)}`;

      return Effect.acquireRelease(
        Effect.sync(() =>
          client.fetch(range, { source: true, uid: true }, { uid: true })[Symbol.asyncIterator](),
        ),
        (iterator) =>
          Effect.tryPromise(async () => {
            await iterator.return?.();
          }).pipe(Effect.ignore),
      ).pipe(
        Effect.flatMap((iterator) => {
          const messages: ImapFetchedMessage[] = [];
          const step: Effect.Effect<
            ReadonlyArray<ImapFetchedMessage>,
            ImapConnectionError
          > = Effect.tryPromise({
            try: () => iterator.next(),
            catch: (e) =>
              new ImapConnectionError({ message: `IMAP fetch failed: ${String(e)}`, cause: e }),
          }).pipe(
            Effect.flatMap((res) => {
              if (res.done) return Effect.succeed(messages);
              const msg = res.value;
              const source = msg.source;
              if (!source) {
                return Effect.logWarning(
                  `ImapClient: message uid=${String(Number(msg.uid))} folder=${params.folder} has no source — stopping fetch at this message`,
                ).pipe(Effect.as(messages));
              }
              return Effect.tryPromise({
                try: () => simpleParser(source),
                catch: (e) => e,
              }).pipe(
                // Scope the parse-failure handler to the parser only; the
                // recursive `step` in onSuccess stays OUTSIDE it so a later
                // mid-stream fetch error still surfaces as ImapConnectionError.
                Effect.matchEffect({
                  onFailure: (parseErr) =>
                    Effect.logWarning(
                      `ImapClient: failed to parse message uid=${String(Number(msg.uid))} folder=${params.folder} — stopping fetch at this message`,
                      parseErr,
                    ).pipe(Effect.as(messages)),
                  onSuccess: (parsed) => {
                    messages.push(toFetchedMessage(msg, parsed));
                    return Effect.suspend(() => step);
                  },
                }),
              );
            }),
          );
          return step;
        }),
      );
    };

    return Effect.scoped(
      Effect.Do.pipe(
        Effect.bind('client', () => acquireClient),
        Effect.tap(({ client }) => acquireLock(client)),
        Effect.bind('uids', ({ client }) => readUids(client)),
        Effect.bind('messages', ({ client }) => drainMessages(client)),
        Effect.map(
          ({ uids, messages }): ImapFetchResult => ({
            uidValidity: uids.uidValidity,
            uidNext: uids.uidNext,
            messages,
          }),
        ),
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
