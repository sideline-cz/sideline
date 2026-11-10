import type { DiscordREST } from 'dfx/DiscordREST';
import type { MessageResponse } from 'dfx/DiscordREST/Generated';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';

// Shared by `/summarize` and the DiscordRead processor.
export const MESSAGE_PAGE_SIZE = 100;
export const MAX_MESSAGE_PAGES = 2;

export interface FetchedMessages {
  // Newest first, unfiltered (bots and empty content included).
  readonly messages: Array<MessageResponse>;
  // The page cap was hit with a cutoff: more messages may exist inside the window.
  readonly capped: boolean;
  // Paging reached the channel start or crossed the cutoff. False when it stopped on the raw
  // `limit` or the page cap, so older messages may exist.
  readonly exhausted: boolean;
}

/**
 * Page `listMessages` newest first, at most {@link MAX_MESSAGE_PAGES} pages of
 * {@link MESSAGE_PAGE_SIZE}. With a cutoff, page until a page crosses it; without one, stop once
 * `limit` raw messages are in hand. Typed `unknown` on the error channel: callers classify with
 * `Effect.mapError(toDiscordError)`.
 */
export const fetchChannelMessages = (
  rest: ServiceMap.Service.Shape<typeof DiscordREST>,
  channelId: string,
  opts: { readonly cutoff: Option.Option<DateTime.Utc>; readonly limit: number },
): Effect.Effect<FetchedMessages, unknown> => {
  const done = (messages: Array<MessageResponse>, exhausted: boolean) =>
    Effect.succeed<FetchedMessages>({ messages, capped: false, exhausted });

  const fetchPages = (
    accumulated: Array<MessageResponse>,
    before: string | undefined,
    pagesLeft: number,
  ): Effect.Effect<FetchedMessages, unknown> => {
    if (pagesLeft === 0) {
      // Hit the page cap — if we had a since window and all messages were
      // within it, there might be more beyond the cap
      return Effect.succeed({
        messages: accumulated,
        capped: Option.isSome(opts.cutoff),
        exhausted: false,
      });
    }

    const params: { limit: number; before?: string } = { limit: MESSAGE_PAGE_SIZE };
    if (before !== undefined) params.before = before;

    return rest.listMessages(channelId, params).pipe(
      Effect.flatMap((typedPage) => {
        if (typedPage.length === 0) return done(accumulated, true);

        const allNew = [...accumulated, ...typedPage];
        const reachedStart = typedPage.length < MESSAGE_PAGE_SIZE;
        const oldestInPage = typedPage[typedPage.length - 1];

        if (Option.isSome(opts.cutoff)) {
          // Page crosses the cutoff boundary — no more pages needed
          if (
            oldestInPage !== undefined &&
            Date.parse(oldestInPage.timestamp) < DateTime.toEpochMillis(opts.cutoff.value)
          ) {
            return done(allNew, true);
          }
          if (reachedStart) return done(allNew, true);
          // Need more pages (still within window)
          return fetchPages(allNew, oldestInPage?.id, pagesLeft - 1);
        }

        // No cutoff — collect up to `limit` raw messages
        if (reachedStart || allNew.length >= opts.limit) return done(allNew, reachedStart);
        return fetchPages(allNew, oldestInPage?.id, pagesLeft - 1);
      }),
    );
  };

  return fetchPages([], undefined, MAX_MESSAGE_PAGES);
};

/**
 * Pick the window from messages that are newest first and already filtered by the caller:
 * keep those at or after the cutoff, oldest first, and only the newest `limit` of them.
 * `capped` is true when a cutoff is set and more than `limit` messages were in the window.
 */
export const newestInWindow = (
  messages: ReadonlyArray<MessageResponse>,
  cutoff: Option.Option<DateTime.Utc>,
  limit: number,
): { chronological: Array<MessageResponse>; capped: boolean } => {
  const inWindow = Option.match(cutoff, {
    onNone: () => messages,
    onSome: (c) => {
      const cutoffMs = DateTime.toEpochMillis(c);
      return messages.filter((msg) => Date.parse(msg.timestamp) >= cutoffMs);
    },
  });
  return {
    chronological: [...inWindow].reverse().slice(-limit),
    capped: Option.isSome(cutoff) && inWindow.length > limit,
  };
};
