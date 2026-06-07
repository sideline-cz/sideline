import { Discord, type EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildClaimMessage } from '~/rest/events/buildClaimMessage.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);
const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

/** Max length for a Discord thread name */
const MAX_THREAD_NAME_LENGTH = 100;

/** Thread auto-archive: 7 days in minutes */
const THREAD_AUTO_ARCHIVE_DURATION = 10080;

const buildThreadName = (title: string, startAt: DateTime.Utc): string => {
  // Format a stable ISO date suffix: "YYYY-MM-DD" (10 chars + 3 for " · " separator = 13)
  const dateSuffix = ` · ${DateTime.formatIso(startAt).slice(0, 10)}`;
  const maxTitleLength = MAX_THREAD_NAME_LENGTH - dateSuffix.length;
  const truncatedTitle = title.length > maxTitleLength ? title.slice(0, maxTitleLength) : title;
  return `${truncatedTitle}${dateSuffix}`;
};

export const handleTrainingClaimRequest = (event: EventRpcEvents.TrainingClaimRequestEvent) =>
  Option.match(event.discord_target_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleTrainingClaimRequest: no owner channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rpc', () => SyncRpc.asEffect()),
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rpc, rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });
          const payload = buildClaimMessage({
            title: event.title,
            startAt: event.start_at,
            endAt: event.end_at,
            location: event.location,
            locationUrl: event.location_url,
            description: event.description,
            claimedBy: Option.none(),
            eventStatus: 'active',
            teamId: event.team_id,
            eventId: event.event_id,
            locale,
          });

          // Step 1: post the starter claim message
          return rest
            .createMessage(channelId, {
              embeds: payload.embeds,
              components: payload.components,
            })
            .pipe(
              // Step 2: persist the claim message ID
              Effect.tap((msg) =>
                rpc['Event/SaveClaimDiscordMessageId']({
                  event_id: event.event_id,
                  channel_id: channelId,
                  message_id: decodeSnowflake(msg.id),
                }),
              ),
              Effect.tap((msg) =>
                Effect.logInfo(
                  `Posted claim message for "${event.title}" to channel ${channelId}, message ${msg.id}`,
                ),
              ),
              // Step 3: best-effort thread creation (failure must NOT fail the handler)
              Effect.tap((msg) =>
                Effect.Do.pipe(
                  // Step 3a: idempotency guard — skip if thread already exists
                  Effect.bind('claimInfo', () =>
                    rpc['Event/GetClaimInfo']({ event_id: event.event_id }),
                  ),
                  Effect.flatMap(({ claimInfo }) => {
                    const alreadyHasThread = Option.flatMap(
                      claimInfo,
                      (info) => info.claim_thread_id,
                    );
                    if (Option.isSome(alreadyHasThread)) {
                      return Effect.logDebug(
                        `Thread already exists for event ${event.event_id}, skipping creation`,
                      );
                    }

                    // Step 3b: create thread from the starter message
                    const threadName = buildThreadName(event.title, event.start_at);
                    return rest
                      .createThreadFromMessage(channelId, msg.id, {
                        name: threadName,
                        auto_archive_duration: THREAD_AUTO_ARCHIVE_DURATION,
                      })
                      .pipe(
                        Effect.tap((thread) =>
                          rpc['Event/SaveClaimThreadId']({
                            event_id: event.event_id,
                            thread_id: decodeSnowflake(thread.id),
                          }),
                        ),
                        Effect.tap((thread) =>
                          Effect.logInfo(`Created claim thread for "${event.title}": ${thread.id}`),
                        ),
                        Effect.asVoid,
                      );
                  }),
                  // Thread errors are best-effort: log + swallow
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `handleTrainingClaimRequest: failed to create thread for event ${event.event_id}`,
                      cause,
                    ),
                  ),
                ),
              ),
              Effect.asVoid,
              Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (err) =>
                Effect.logWarning(
                  `handleTrainingClaimRequest: failed to post claim message for event ${event.event_id}`,
                  err,
                ),
              ),
            );
        }),
      ),
  });
