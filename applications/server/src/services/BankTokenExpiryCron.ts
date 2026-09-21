/**
 * T10b — the producer half of the Fio token-expiry warning (design §11). A Fio token lasts at
 * most 180 days from `fio_token_created_at`, and its optional auto-renewal only refreshes when
 * the treasurer actually logs into Internetbanking/Smartbanking — a dormant treasurer's token can
 * die silently, and Fio then answers every call with a bodyless HTTP 500 indistinguishable from
 * an outage. This cron is the only thing that can warn the treasurer before that happens.
 *
 * Scans `bank_sync_config` (via `BankSyncConfigRepository.findExpiringCandidates`) for enabled
 * configs whose token is EXACTLY 14, 7, or 1 calendar day(s) from `token_created_at + 180d`, and
 * emits one `bank_token_expiry_events` outbox row per `(team, threshold)` match
 * (`BankTokenExpiryEventsRepository.emit`). Everything downstream — the RPC read/ack pair and the
 * bot's DM handler — already exists; this file is the piece that used to be missing.
 *
 * `markSent` (writing `bank_token_expiry_sent`) is called HERE, right after a successful emit —
 * not by the bot — because unlike the payment reminder family, the bot never acks a "sent"
 * event for this one (see `handleBankTokenExpiring.ts`'s header: the outbox row itself is that
 * family's idempotency boundary). Without this call, `bank_token_expiry_sent` would stay forever
 * empty and every threshold would be free to re-fire the next time the query's day-diff happens
 * to line up again — which, for a fixed `token_created_at`, only distinguishes THIS cron's own
 * within-cycle repeats from cross-cycle repeats; `findExpiringCandidates`'s own NOT EXISTS against
 * `bank_token_expiry_events` handles the former, `bank_token_expiry_sent` the latter.
 *
 * Per-team `Effect.exit` isolation (mirrors `PaymentReminderCron`/`TrainingClaimRequestCron`): one
 * team's broken row must not take down the whole cycle.
 */
import { Array, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { BankSyncConfigRepository } from '~/repositories/BankSyncConfigRepository.js';
import { BankTokenExpiryEventsRepository } from '~/repositories/BankTokenExpiryEventsRepository.js';

export const bankTokenExpiryCronEffect = Effect.Do.pipe(
  Effect.bind('bankSyncConfigRepo', () => BankSyncConfigRepository.asEffect()),
  Effect.bind('bankTokenExpiryRepo', () => BankTokenExpiryEventsRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('BankTokenExpiryCron: starting expiry-scan cycle')),
  Effect.bind('now', () => Effect.sync(() => new Date())),
  Effect.bind('candidates', ({ bankSyncConfigRepo, now }) =>
    bankSyncConfigRepo.findExpiringCandidates(now),
  ),
  Effect.tap(({ candidates, bankTokenExpiryRepo }) =>
    Effect.all(
      Array.map(candidates, (candidate) =>
        bankTokenExpiryRepo
          .emit({
            teamId: candidate.team_id,
            guildId: candidate.guild_id,
            userDiscordId: candidate.user_discord_id,
            thresholdDays: candidate.threshold_days,
            tokenExpiresAt: candidate.token_expires_at,
          })
          .pipe(
            Effect.flatMap((inserted) =>
              Option.match(inserted, {
                onSome: () =>
                  bankTokenExpiryRepo
                    .markSent(
                      candidate.team_id,
                      candidate.token_created_at.toISOString(),
                      candidate.threshold_days,
                    )
                    .pipe(
                      Effect.tap(() =>
                        Effect.logInfo(
                          `BankTokenExpiryCron: queued T-${String(candidate.threshold_days)} warning for team ${candidate.team_id}`,
                        ),
                      ),
                    ),
                onNone: () =>
                  Effect.logDebug(
                    `BankTokenExpiryCron: skipped team ${candidate.team_id} threshold ${String(candidate.threshold_days)} — pending event already exists`,
                  ),
              }),
            ),
            Effect.tapError((e) =>
              Effect.logWarning(
                `BankTokenExpiryCron: failed for team ${candidate.team_id} threshold ${String(candidate.threshold_days)}`,
                e,
              ),
            ),
            Effect.exit,
          ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ candidates }) =>
    Effect.logInfo(
      `BankTokenExpiryCron: cycle complete, ${String(candidates.length)} candidate(s) processed`,
    ),
  ),
  Effect.asVoid,
  withCronMetrics('bank-token-expiry'),
);

// Day-granularity threshold (T-14/T-7/T-1), not an hourly one — once a day is enough, and
// `Schedule.cron` fires once immediately at startup regardless.
const cronSchedule = Schedule.cron('0 4 * * *');

export const BankTokenExpiryCron = bankTokenExpiryCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
