import { SummarizeRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageResponse } from 'dfx/DiscordREST/Generated';
import * as Ix from 'dfx/Interactions/index';
import { Interaction } from 'dfx/Interactions/index';
import * as DiscordTypes from 'dfx/types';
import { Array, DateTime, Effect, Metric, Option, pipe } from 'effect';
import { userLocale } from '~/locale.js';
import { discordInteractionsTotal } from '~/metrics.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { buildSummaryEmbed } from './buildSummaryEmbed.js';

// ---------------------------------------------------------------------------
// Date range guard
// ---------------------------------------------------------------------------

/** Valid JS Date epoch millisecond range */
const DATE_MS_MIN = -8.64e15;
const DATE_MS_MAX = 8.64e15;

/** Maximum duration to accept (10 years in days) */
const MAX_DURATION_DAYS = 3650;

const isValidDateMs = (ms: number): boolean =>
  Number.isFinite(ms) && ms > DATE_MS_MIN && ms < DATE_MS_MAX;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// parseSince — pure helper
// ---------------------------------------------------------------------------

/**
 * The normalized duration string when the input was a duration (e.g. "24h", "7d").
 * Used for range_relative i18n label. null when the input was an ISO date/datetime.
 */
export type ParsedSinceWindow = string | null;

/**
 * Parse a human-readable duration or ISO date/datetime string into a cutoff
 * DateTime.Utc (relative to `now`).
 *
 * Accepted formats:
 *   - Duration: `24h`, `7d`, `3d12h`, `90m`, `1d2h30m`
 *     Units: d (days), h (hours), m (minutes). Multi-unit is additive.
 *   - ISO date: `2026-06-20`  → start of that UTC day
 *   - ISO datetime: `2026-06-20T10:00:00Z`
 *
 * Returns Option.none() for empty string or any unparseable input, or for inputs
 * that would produce an out-of-range Date.
 *
 * NEVER throws — it is total for all string inputs.
 */
export const parseSince = (
  input: string,
  now: DateTime.Utc,
): Option.Option<{ cutoff: DateTime.Utc; window: ParsedSinceWindow }> => {
  if (input === '') return Option.none();

  // --- Duration pattern: must have at least one group (non-empty guard) ---
  // Pattern: optional Nd, optional Nh, optional Nm, but at least one must exist
  const durationMatch = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(input);
  if (durationMatch !== null) {
    const days = durationMatch[1] !== undefined ? parseInt(durationMatch[1], 10) : 0;
    const hours = durationMatch[2] !== undefined ? parseInt(durationMatch[2], 10) : 0;
    const minutes = durationMatch[3] !== undefined ? parseInt(durationMatch[3], 10) : 0;

    // Must have at least one non-zero unit
    if (days === 0 && hours === 0 && minutes === 0) {
      return Option.none();
    }

    const totalMs = days * 86_400_000 + hours * 3_600_000 + minutes * 60_000;

    // Cap absurd durations (> 10 years total) so we return none instead of crashing.
    // Check the combined duration, not just the days component, so inputs like
    // `3650d100000h` are rejected.
    if (totalMs > MAX_DURATION_DAYS * 86_400_000) {
      return Option.none();
    }

    const cutoffMs = DateTime.toEpochMillis(now) - totalMs;

    // Guard against out-of-range Date values
    if (!isValidDateMs(cutoffMs)) {
      return Option.none();
    }

    // Build the normalized window label (e.g. "7d", "3d12h", "90m")
    const windowParts: string[] = [];
    if (days > 0) windowParts.push(`${days}d`);
    if (hours > 0) windowParts.push(`${hours}h`);
    if (minutes > 0) windowParts.push(`${minutes}m`);
    const window = windowParts.join('');

    return Option.some({ cutoff: DateTime.fromDateUnsafe(new Date(cutoffMs)), window });
  }

  // --- ISO date: YYYY-MM-DD ---
  const isoDateMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(input);
  if (isoDateMatch !== null) {
    const ms = Date.parse(`${isoDateMatch[1]}T00:00:00Z`);
    if (!Number.isNaN(ms) && isValidDateMs(ms)) {
      return Option.some({ cutoff: DateTime.fromDateUnsafe(new Date(ms)), window: null });
    }
  }

  // --- ISO datetime: YYYY-MM-DDTHH:MM:SS... ---
  const isoDatetimeMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.exec(input);
  if (isoDatetimeMatch !== null) {
    const ms = Date.parse(input);
    if (!Number.isNaN(ms) && isValidDateMs(ms)) {
      return Option.some({ cutoff: DateTime.fromDateUnsafe(new Date(ms)), window: null });
    }
  }

  return Option.none();
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ephemeral = (content: string) =>
  Ix.response({
    type: DiscordTypes.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: DiscordTypes.MessageFlags.Ephemeral,
      // Anti-ping guard: some ephemeral replies (invalid-since) echo raw user input.
      allowed_mentions: { parse: [] },
    },
  });

const readOption = (
  options: ReadonlyArray<{ name: string }>,
  name: string,
): Option.Option<string> =>
  pipe(
    options,
    Array.findFirst((o) => o.name === name),
    Option.flatMap((o) =>
      'value' in o && o.value !== null && o.value !== undefined
        ? Option.some(String(o.value))
        : Option.none(),
    ),
  );

const numberProp = (record: Record<string, unknown>, key: string): number | undefined => {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
};

const recordProp = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = record[key];
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
};

/** Detect Discord permission errors (403 / code 50013). Mirrors the shape used
 * by `/summon`: HTTP status on `err.response.status`, Discord error code on
 * `err.data.code`, with top-level fallbacks for wrapped/test fixtures. */
const isDiscordPermissionError = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const response = recordProp(record, 'response');
  const data = recordProp(record, 'data');
  const httpStatus = numberProp(response, 'status') ?? numberProp(record, 'status');
  if (httpStatus === 403) return true;
  const discordCode = numberProp(data, 'code') ?? numberProp(record, 'code');
  return discordCode === 50013;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const summarizeHandler = Interaction.asEffect().pipe(
  Effect.tap(() =>
    Metric.update(
      Metric.withAttributes(discordInteractionsTotal, { interaction_type: 'command' }),
      1,
    ),
  ),
  Effect.flatMap((interaction) =>
    Effect.Do.pipe(
      Effect.bind('now', () => DateTime.now),
      Effect.flatMap(({ now }) => {
        const locale = userLocale(interaction);
        const channelId = interaction.channel_id;

        if (channelId === undefined) {
          return Effect.succeed(ephemeral(m.bot_summarize_no_channel({}, { locale })));
        }

        const data = interaction.data;
        const options = data && 'options' in data ? [...(data.options ?? [])] : [];

        const messagesOption = readOption(options, 'messages');
        const sinceOption = readOption(options, 'since');

        // `private` controls response visibility — default true (ephemeral). The
        // option value arrives as a boolean (stringified by readOption); only an
        // explicit `false` makes the response public.
        const isEphemeral = Option.match(readOption(options, 'private'), {
          onNone: () => true,
          onSome: (value) => value !== 'false',
        });

        // Resolve `since` option if provided — parseSince is total (never throws)
        const maybeParsed = Option.isSome(sinceOption)
          ? parseSince(sinceOption.value, now)
          : Option.none();

        // If `since` was provided but couldn't be parsed → immediate ephemeral error
        if (Option.isSome(sinceOption) && Option.isNone(maybeParsed)) {
          return Effect.succeed(
            ephemeral(m.bot_summarize_invalid_since({ input: sinceOption.value }, { locale })),
          );
        }

        // Extract the cutoff DateTime (if any)
        const maybeCutoff: Option.Option<DateTime.Utc> = pipe(
          maybeParsed,
          Option.map((p) => p.cutoff),
        );

        // Extract the duration window label for range_relative (null for ISO dates)
        const maybeWindow: Option.Option<string> = pipe(
          maybeParsed,
          Option.flatMap((p) => (p.window !== null ? Option.some(p.window) : Option.none())),
        );

        const effectiveLimit = Math.min(
          pipe(
            messagesOption,
            Option.map((s) => parseInt(s, 10)),
            Option.filter((n) => !Number.isNaN(n)),
            Option.getOrElse(() => DEFAULT_MESSAGE_LIMIT),
          ),
          MAX_MESSAGE_LIMIT,
        );

        const channelName = interaction.channel?.name ?? undefined;

        const applicationId = interaction.application_id;
        const token = interaction.token;

        const postContent = (content: string) =>
          DiscordREST.asEffect().pipe(
            Effect.flatMap((rest) =>
              rest.updateOriginalWebhookMessage(applicationId, token, {
                payload: { content, allowed_mentions: { parse: [] } },
              }),
            ),
            Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
              Effect.logError('Failed to update summarize response', error),
            ),
          );

        const work = Effect.Do.pipe(
          Effect.bind('rest', () => DiscordREST.asEffect()),
          Effect.bind('rpc', () => SyncRpc.asEffect()),
          Effect.bind('fetchResult', ({ rest }) => {
            type FetchResult = { messages: Array<MessageResponse>; capped: boolean };

            const fetchPages = (
              accumulated: Array<MessageResponse>,
              before: string | undefined,
              pagesLeft: number,
            ): Effect.Effect<FetchResult, unknown> => {
              if (pagesLeft === 0) {
                // Hit the page cap — if we had a since window and all messages were
                // within it, there might be more beyond the cap
                const capped = Option.isSome(maybeCutoff);
                return Effect.succeed({ messages: accumulated, capped });
              }

              const params: { limit: number; before?: string } = { limit: 100 };
              if (before !== undefined) params.before = before;

              return rest.listMessages(channelId, params).pipe(
                Effect.flatMap((typedPage) => {
                  if (typedPage.length === 0) {
                    return Effect.succeed<FetchResult>({ messages: accumulated, capped: false });
                  }

                  const allNew = [...accumulated, ...typedPage];

                  // If we have a cutoff, check if the oldest message in this page is within window
                  if (Option.isSome(maybeCutoff)) {
                    const cutoff = maybeCutoff.value;
                    const oldestInPage = typedPage[typedPage.length - 1];

                    if (oldestInPage !== undefined) {
                      const oldestTs = Date.parse(oldestInPage.timestamp);
                      const cutoffMs = DateTime.toEpochMillis(cutoff);

                      if (oldestTs < cutoffMs) {
                        // Page crosses the cutoff boundary — no more pages needed
                        return Effect.succeed<FetchResult>({ messages: allNew, capped: false });
                      }
                    }

                    // All messages in this page are within the since window
                    if (typedPage.length < 100) {
                      // Channel exhausted
                      return Effect.succeed<FetchResult>({ messages: allNew, capped: false });
                    }

                    // Need more pages (still within window)
                    const oldestId = typedPage[typedPage.length - 1]?.id;
                    return fetchPages(allNew, oldestId, pagesLeft - 1);
                  } else {
                    // No cutoff — collect up to effectiveLimit
                    if (typedPage.length < 100 || allNew.length >= effectiveLimit) {
                      return Effect.succeed<FetchResult>({ messages: allNew, capped: false });
                    }
                    const oldestId = typedPage[typedPage.length - 1]?.id;
                    return fetchPages(allNew, oldestId, pagesLeft - 1);
                  }
                }),
              );
            };

            return fetchPages([], undefined, 2);
          }),
          Effect.flatMap(({ rest, rpc, fetchResult }) => {
            const { messages: rawMessages, capped: pageCapped } = fetchResult;

            // Track whether all messages (pre-filter) were bots
            const hasAnyRawMessages = rawMessages.length > 0;

            // Filter: drop bot messages and empty content
            const nonBotMessages = rawMessages.filter(
              (msg) => !msg.author.bot && msg.content !== '',
            );

            // Apply since filter (inclusive >=)
            const filteredMessages = Option.isSome(maybeCutoff)
              ? nonBotMessages.filter((msg) => {
                  const ts = Date.parse(msg.timestamp);
                  const cutoffMs = DateTime.toEpochMillis(maybeCutoff.value);
                  return ts >= cutoffMs;
                })
              : nonBotMessages;

            const allBotOrEmpty = hasAnyRawMessages && nonBotMessages.length === 0;

            if (!hasAnyRawMessages || filteredMessages.length === 0) {
              const content = allBotOrEmpty
                ? m.bot_summarize_only_bot_messages({}, { locale })
                : m.bot_summarize_no_messages({}, { locale });

              return rest
                .updateOriginalWebhookMessage(applicationId, token, {
                  payload: { content, allowed_mentions: { parse: [] } },
                })
                .pipe(
                  Effect.catchTag(
                    ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                    (error) =>
                      Effect.logError('Failed to update summarize response (no messages)', error),
                  ),
                );
            }

            // Reverse to chronological (oldest first).
            // For the since path: keep the NEWEST effectiveLimit messages (tail of
            // chronological = most recent). For the no-since path: take the first
            // effectiveLimit (which are already the newest, since they came newest-first
            // from Discord and we've reversed).
            // Keep the NEWEST effectiveLimit messages. reversedToChronological is
            // oldest→newest, so the tail is the most recent — correct for both the
            // since path (filtered set may exceed the limit) and the no-since path
            // (a full page of up to 100 is fetched even when effectiveLimit is smaller,
            // so slicing from the start would drop the most recent discussion).
            const reversedToChronological = [...filteredMessages].reverse();
            const chronological = reversedToChronological.slice(-effectiveLimit);

            // Bot-capped: the page budget ran out (more messages may exist in the window)
            const botCapped = pageCapped && Option.isSome(maybeCutoff);
            // Filter-capped: the filtered set had more than effectiveLimit messages (we dropped some)
            const filterCapped =
              Option.isSome(maybeCutoff) && filteredMessages.length > effectiveLimit;

            // Determine participants (distinct authors) — dedupe by author.id (unique per user),
            // not by display name, to avoid under-counting when two users share a display name.
            const participantsSet = new Set(chronological.map((msg) => msg.author.id));
            const participants = participantsSet.size;

            // Build range string
            // - Duration input (e.g. "24h") → range_relative: "last 24h"
            // - ISO date/datetime input → range_since_date: "since 2026-06-20"
            // - No since → range_last_messages: "last N messages"
            const rangeStr = Option.isSome(maybeParsed)
              ? Option.isSome(maybeWindow)
                ? m.bot_summarize_range_relative({ window: maybeWindow.value }, { locale })
                : m.bot_summarize_range_since_date(
                    { date: Option.getOrElse(sinceOption, () => '') },
                    { locale },
                  )
              : m.bot_summarize_range_last_messages({ count: effectiveLimit }, { locale });

            // Map to TranscriptMessage
            const transcriptMessages = chronological.map((msg) => {
              return new SummarizeRpcModels.TranscriptMessage({
                author: msg.author.global_name ?? msg.author.username,
                content: msg.content,
                timestamp: DateTime.fromDateUnsafe(new Date(msg.timestamp)),
              });
            });

            return rpc['Summarize/SummarizeChannel'](
              new SummarizeRpcModels.SummarizeChannelInput({
                messages: transcriptMessages,
                channelName: Option.fromNullishOr(channelName),
                locale,
              }),
            ).pipe(
              Effect.flatMap((result) => {
                // If the LLM was unavailable (fallback path), show an ephemeral
                // degraded response instead of masquerading as a real summary
                if (!result.generated) {
                  return rest.updateOriginalWebhookMessage(applicationId, token, {
                    payload: {
                      content: m.bot_summarize_llm_unavailable({}, { locale }),
                      allowed_mentions: { parse: [] },
                    },
                  });
                }

                // Server may have truncated transcript to fit char budget —
                // use result.summarizedCount as the true count
                const summarizedCount = result.summarizedCount;
                // Capped if bot dropped messages OR server dropped messages
                const serverTruncated = summarizedCount < chronological.length;
                const isCapped = botCapped || filterCapped || serverTruncated;

                const embed = buildSummaryEmbed({
                  summary: result.summary,
                  count: summarizedCount,
                  participants,
                  range: rangeStr,
                  capped: isCapped,
                  locale,
                });

                return rest.updateOriginalWebhookMessage(applicationId, token, {
                  payload: {
                    embeds: [embed],
                    allowed_mentions: { parse: [] },
                  },
                });
              }),
              Effect.catchCause((cause) =>
                Effect.logError('RPC error during summarize', cause).pipe(
                  Effect.flatMap(() =>
                    rest
                      .updateOriginalWebhookMessage(applicationId, token, {
                        payload: {
                          content: m.bot_summarize_error({}, { locale }),
                          allowed_mentions: { parse: [] },
                        },
                      })
                      .pipe(
                        Effect.catchTag(
                          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'],
                          (e) => Effect.logError('Failed to update summarize error response', e),
                        ),
                      ),
                  ),
                ),
              ),
            );
          }),
          Effect.catchIf(isDiscordPermissionError, (error) =>
            Effect.logWarning('Discord permission error during summarize', error).pipe(
              Effect.flatMap(() => postContent(m.bot_summarize_forbidden({}, { locale }))),
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logError('Unexpected error during summarize', cause).pipe(
              Effect.flatMap(() => postContent(m.bot_summarize_error({}, { locale }))),
            ),
          ),
        );

        // The defer flag is immutable for the rest of the interaction, so the
        // visibility chosen here applies to every follow-up (summary + post-fetch
        // edge messages). Pre-defer input errors above stay ephemeral regardless.
        const deferred: DiscordTypes.CreateMessageInteractionCallbackRequest = {
          type: DiscordTypes.InteractionCallbackTypes.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
          data: isEphemeral ? { flags: DiscordTypes.MessageFlags.Ephemeral } : {},
        };

        return Effect.as(Effect.forkDetach(work), deferred);
      }),
    ),
  ),
  Effect.withSpan('command/summarize'),
);
