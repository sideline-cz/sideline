import { Event, type EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type { DiscordRestService } from 'dfx/DiscordREST';
import * as DiscordTypes from 'dfx/types';
import { Duration, Effect, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { YES_EMBED_LIMIT } from './buildEventEmbed.js';
import { buildUpcomingEventEmbed } from './buildUpcomingEventEmbed.js';

const STALE_DELAY = Duration.minutes(10);

/**
 * Sends one ephemeral follow-up message per event using the interaction webhook.
 * If there are more events beyond the provided list, appends a "...and X more" note.
 * After 10 minutes, marks all messages as stale (removes buttons, adds warning).
 */
export const sendUpcomingEventFollowups = (params: {
  rest: DiscordRestService;
  applicationId: string;
  interactionToken: string;
  events: ReadonlyArray<EventRpcModels.UpcomingEventForUserEntry>;
  total: number;
  locale: Locale;
}) => {
  const { rest, applicationId, interactionToken, events, total, locale } = params;

  const sendMessages = Effect.forEach(
    events,
    (entry) =>
      SyncRpc.asEffect().pipe(
        Effect.flatMap((rpc) =>
          rpc['Event/GetYesAttendeesForEmbed']({
            event_id: Event.EventId.makeUnsafe(entry.event_id),
            limit: YES_EMBED_LIMIT,
            member_group_id: Option.none(),
          }),
        ),
        Effect.flatMap((yesAttendees) => {
          const { embeds, components } = buildUpcomingEventEmbed({ entry, yesAttendees, locale });
          return rest
            .executeWebhook(applicationId, interactionToken, {
              payload: {
                embeds,
                components,
                flags: DiscordTypes.MessageFlags.Ephemeral,
              },
            })
            .pipe(Effect.map((response) => response.id));
        }),
      ),
    { concurrency: 1 },
  );

  const sendExtra = (extraCount: number) =>
    rest
      .executeWebhook(applicationId, interactionToken, {
        payload: {
          content: m.bot_upcoming_more_events({ count: String(extraCount) }, { locale }),
          flags: DiscordTypes.MessageFlags.Ephemeral,
        },
      })
      .pipe(Effect.asVoid);

  const markStale = (messageIds: ReadonlyArray<string>) =>
    Effect.sleep(STALE_DELAY).pipe(
      Effect.flatMap(() =>
        Effect.forEach(
          messageIds,
          (messageId) =>
            rest
              .updateWebhookMessage(applicationId, interactionToken, messageId, {
                payload: {
                  content: m.bot_upcoming_stale({}, { locale }),
                  components: [],
                },
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logDebug('Failed to mark ephemeral message as stale', error),
                ),
              ),
          { concurrency: 'inherit', discard: true },
        ),
      ),
    );

  const extraCount = total - events.length;

  return sendMessages.pipe(
    Effect.tap((messageIds) => Effect.forkDetach(markStale(messageIds))),
    Effect.tap(() => (extraCount > 0 ? sendExtra(extraCount) : Effect.void)),
    Effect.asVoid,
  );
};
