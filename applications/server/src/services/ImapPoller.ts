import type { EmailForwarding } from '@sideline/domain';
import { Data, DateTime, Effect, Exit, Option, Schedule, type ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { withCronMetrics } from '~/metrics.js';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import {
  EmailForwardingConfigRepository,
  type EmailForwardingConfigRow,
} from '~/repositories/EmailForwardingConfigRepository.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailSecretCrypto } from '~/services/EmailSecretCrypto.js';
import { validateAttachmentSizes } from '~/services/emailAttachmentLimits.js';
import { ImapClient, type ImapFetchedMessage } from '~/services/ImapClient.js';

// ---------------------------------------------------------------------------
// SkipTeam error (module-local)
// ---------------------------------------------------------------------------

class SkipTeam extends Data.TaggedError('SkipTeam')<{}> {}

// ---------------------------------------------------------------------------
// Ingestion accumulator — highest committed uid + whether the cycle stopped
// ---------------------------------------------------------------------------

interface IngestState {
  readonly committed: number;
  readonly stopped: boolean;
}

// ---------------------------------------------------------------------------
// Sender filter (mirrors email-webhook.ts logic)
// ---------------------------------------------------------------------------

const senderAllowed = (from: string, monitoredAddresses: readonly string[]): boolean => {
  if (monitoredAddresses.length === 0) return true;
  const fromLower = from.toLowerCase();
  return monitoredAddresses.some((addr) => fromLower.includes(addr.toLowerCase()));
};

// ---------------------------------------------------------------------------
// Process a single team
// ---------------------------------------------------------------------------

const processTeam = (
  config: EmailForwardingConfigRow,
  crypto: ServiceMap.Service.Shape<typeof EmailSecretCrypto>,
  imap: ServiceMap.Service.Shape<typeof ImapClient>,
  messagesRepo: ServiceMap.Service.Shape<typeof EmailMessagesRepository>,
  attachmentsRepo: ServiceMap.Service.Shape<typeof EmailAttachmentsRepository>,
  configRepo: ServiceMap.Service.Shape<typeof EmailForwardingConfigRepository>,
  sql: SqlClient.SqlClient,
): Effect.Effect<void, never> => {
  const teamId = config.team_id;

  // Step 1: resolve required IMAP config fields
  const host = Option.getOrNull(config.imap_host);
  const port = Option.getOrElse(config.imap_port, () => 993);
  const username = Option.getOrNull(config.imap_username);
  const folder = Option.getOrElse(config.imap_folder, () => 'INBOX');
  const secretEncrypted = Option.getOrNull(config.imap_secret_encrypted);

  if (!host || !username || !secretEncrypted) {
    return Effect.logWarning(`ImapPoller: team ${teamId} missing required IMAP config fields`);
  }

  return Effect.Do.pipe(
    // Step 2: decrypt secret — skip team on error
    Effect.bind('secret', () =>
      crypto.decrypt(secretEncrypted).pipe(
        Effect.tapError((e) =>
          Effect.logWarning(`ImapPoller: decrypt failed for team ${teamId}`, e),
        ),
        Effect.catchTag('EmailSecretDecryptError', () => Effect.fail(new SkipTeam())),
        Effect.catchTag('EmailSecretKeyMissing', () => Effect.fail(new SkipTeam())),
      ),
    ),

    // Step 3: fetch messages since last seen uid
    Effect.bind('fetchResult', ({ secret }) =>
      imap
        .fetchSince({
          host,
          port,
          username,
          secret,
          useTls: config.imap_use_tls,
          folder,
          sinceUid: config.imap_last_seen_uid,
        })
        .pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`ImapPoller: IMAP fetch failed for team ${teamId}`, e),
          ),
          Effect.catchTag('ImapConnectionError', () => Effect.fail(new SkipTeam())),
        ),
    ),

    // Step 4-5: UIDVALIDITY check / cold start / per-message ingestion
    Effect.flatMap(({ fetchResult }) => {
      const { uidValidity, uidNext, messages } = fetchResult;
      const storedValidity = config.imap_uid_validity;

      // Cold start: uid=0 AND no stored validity → baseline and skip ingestion
      const isColdStart = config.imap_last_seen_uid === 0 && Option.isNone(storedValidity);

      // UIDVALIDITY reset: stored validity exists and doesn't match
      const isValidityReset = Option.isSome(storedValidity) && storedValidity.value !== uidValidity;

      if (isColdStart || isValidityReset) {
        const newUid = uidNext - 1;
        if (isValidityReset) {
          return Effect.logWarning(
            `ImapPoller: UIDVALIDITY reset for team ${teamId}, re-baselining to uid=${String(newUid)}`,
          ).pipe(
            Effect.flatMap(() =>
              configRepo.updateImapSync(teamId, newUid, uidValidity, DateTime.nowUnsafe()),
            ),
          );
        }
        // Cold start
        return Effect.logInfo(
          `ImapPoller: cold start for team ${teamId}, baselining to uid=${String(newUid)}`,
        ).pipe(
          Effect.flatMap(() =>
            configRepo.updateImapSync(teamId, newUid, uidValidity, DateTime.nowUnsafe()),
          ),
        );
      }

      // Normal ingestion — process messages in ascending UID order.
      //
      // The accumulator carries the highest committed uid and a stop flag.
      // committed advances only for messages that are successfully processed:
      //   - sender filtered (intentional skip)
      //   - attachment over-limit (intentional skip)
      //   - successfully inserted
      //   - dedup no-op (Option.none() from insertReceivedDedup)
      //
      // On a genuine insert failure (defect or transient error) we set stopped
      // so the remaining messages are no-ops and the watermark never advances
      // past the failed uid. The failed message is retried on the next cycle.
      const processMessage = (
        acc: IngestState,
        msg: ImapFetchedMessage,
      ): Effect.Effect<IngestState, never> => {
        // Sender filter — intentionally filtered → advance committed
        if (!senderAllowed(msg.payload.from, config.monitored_addresses)) {
          return Effect.succeed({ committed: msg.uid, stopped: false });
        }

        // Attachment size check — intentionally skipped → advance committed
        const attachmentList = Option.getOrElse(
          msg.payload.attachments,
          (): ReadonlyArray<EmailForwarding.EmailAttachmentPayload> => [],
        );
        const sizeCheck = validateAttachmentSizes(attachmentList);
        if (!sizeCheck.ok) {
          return Effect.logInfo(
            `ImapPoller: skipping message uid=${String(msg.uid)} for team ${teamId}: ${sizeCheck.reason}`,
          ).pipe(Effect.as({ committed: msg.uid, stopped: false }));
        }

        // Insert with dedup — capture as Exit so a defect stops the cycle.
        const receivedAt = Option.getOrElse(msg.payload.received_at, () => DateTime.nowUnsafe());

        return sql
          .withTransaction(
            messagesRepo
              .insertReceivedDedup({
                team_id: config.team_id,
                from_address: msg.payload.from,
                subject: msg.payload.subject,
                body: msg.payload.text,
                message_id: Option.getOrUndefined(msg.messageId),
                received_at: receivedAt,
              })
              .pipe(
                Effect.flatMap(
                  Option.match({
                    // Already ingested (dedup conflict) → no-op, counts as processed
                    onNone: () => Effect.void,
                    onSome: (emailId) =>
                      attachmentsRepo.insertMany(
                        emailId,
                        attachmentList.map((a) => ({
                          filename: a.filename,
                          content_type: a.content_type,
                          size_bytes: a.size,
                          content_base64: a.content_base64,
                        })),
                      ),
                  }),
                ),
              ),
          )
          .pipe(
            Effect.exit,
            Effect.flatMap(
              (exit): Effect.Effect<IngestState, never> =>
                Exit.isSuccess(exit)
                  ? Effect.succeed({ committed: msg.uid, stopped: false })
                  : // Failure or defect — log, keep last good committed, stop the cycle
                    Effect.logWarning(
                      `ImapPoller: insert failed for uid=${String(msg.uid)} team=${teamId} — stopping cycle`,
                      exit.cause,
                    ).pipe(Effect.as({ committed: acc.committed, stopped: true })),
            ),
          );
      };

      // Left-fold the messages into a single chained effect, threading the
      // accumulator. Once stopped, remaining messages are no-ops.
      const initial: Effect.Effect<IngestState, never> = Effect.succeed({
        committed: config.imap_last_seen_uid,
        stopped: false,
      });
      const folded = messages.reduce<Effect.Effect<IngestState, never>>(
        (accEffect, msg) =>
          accEffect.pipe(
            Effect.flatMap((acc) => (acc.stopped ? Effect.succeed(acc) : processMessage(acc, msg))),
          ),
        initial,
      );

      return folded.pipe(
        Effect.flatMap(({ committed }) =>
          configRepo.updateImapSync(teamId, committed, uidValidity, DateTime.nowUnsafe()),
        ),
      );
    }),

    Effect.catchTag('SkipTeam', () => Effect.void),
    Effect.asVoid,
  );
};

// ---------------------------------------------------------------------------
// Single-cycle effect
// ---------------------------------------------------------------------------

export const imapPollerEffect: Effect.Effect<
  void,
  never,
  | EmailForwardingConfigRepository
  | EmailMessagesRepository
  | EmailAttachmentsRepository
  | ImapClient
  | EmailSecretCrypto
  | SqlClient.SqlClient
> = Effect.Do.pipe(
  Effect.bind('configRepo', () => EmailForwardingConfigRepository.asEffect()),
  Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
  Effect.bind('attachmentsRepo', () => EmailAttachmentsRepository.asEffect()),
  Effect.bind('imap', () => ImapClient.asEffect()),
  Effect.bind('crypto', () => EmailSecretCrypto.asEffect()),
  Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
  Effect.tap(() => Effect.logInfo('ImapPoller: starting cycle')),
  Effect.bind('configs', ({ configRepo }) => configRepo.findImapEnabled()),
  Effect.tap(({ configs, configRepo, messagesRepo, attachmentsRepo, imap, crypto, sql }) =>
    Effect.all(
      configs.map((config) =>
        processTeam(config, crypto, imap, messagesRepo, attachmentsRepo, configRepo, sql).pipe(
          Effect.tapError((e) =>
            Effect.logWarning(`ImapPoller: unexpected error for team ${config.team_id}`, e),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 2 },
    ),
  ),
  Effect.tap(({ configs }) =>
    Effect.logInfo(`ImapPoller: cycle complete, ${String(configs.length)} team(s)`),
  ),
  Effect.asVoid,
  withCronMetrics('imap-poller'),
);

// ---------------------------------------------------------------------------
// Repeating cron
// ---------------------------------------------------------------------------

export const ImapPoller = imapPollerEffect.pipe(
  Effect.repeat(Schedule.cron('*/5 * * * *')),
  Effect.asVoid,
);
