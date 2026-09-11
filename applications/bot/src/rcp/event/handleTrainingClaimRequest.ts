import { Discord, type EventRpcEvents, type GroupModel } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { buildClaimMessage } from '~/rest/events/buildClaimMessage.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);
const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);

/** Thread auto-archive: 7 days in minutes (maximum) */
const THREAD_AUTO_ARCHIVE_DURATION = 10080 as const;

export const handleTrainingClaimRequest = (event: EventRpcEvents.TrainingClaimRequestEvent) =>
  Option.match(event.discord_target_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleTrainingClaimRequest: no owner channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (ownerChannelId) =>
      Effect.Do.pipe(
        Effect.bind('rpc', () => SyncRpc.asEffect()),
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rpc, rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          // ⚠ the all-day branch takes DATES, not instants (§11.4 of the plan).
          // `event.start_date`/`end_date` are the team-local calendar dates projected by the
          // server; fall back to the UTC date of the instant when an older server hasn't
          // shipped the field yet (rolling-deploy skew, §17.1 row 3).
          const payload = buildClaimMessage({
            title: event.title,
            startAt: event.start_at,
            startDate: Option.getOrElse(event.start_date, () =>
              DateTime.formatIsoDateUtc(event.start_at),
            ),
            endAt: event.end_at,
            endDate: Option.map(event.end_at, (endAt) =>
              Option.getOrElse(event.end_date, () => DateTime.formatIsoDateUtc(endAt)),
            ),
            location: event.location,
            locationUrl: event.location_url,
            description: event.description,
            claimedBy: Option.none(),
            eventStatus: 'active',
            teamId: event.team_id,
            eventId: event.event_id,
            locale,
            allDay: event.all_day,
          });

          // Create a new claim thread, persist it, and resolve the winning thread id.
          // If another request won the save race, delete the orphan thread we created
          // (best-effort) and use the winner's thread id instead.
          const createAndClaimThread = (ownerGroupId: GroupModel.GroupId) =>
            rest
              .createThread(ownerChannelId, {
                name: m.bot_claim_thread_name({}, { locale }),
                type: 11 as const, // PUBLIC_THREAD
                auto_archive_duration: THREAD_AUTO_ARCHIVE_DURATION,
              })
              .pipe(
                Effect.bindTo('created'),
                Effect.bind('winner', ({ created }) =>
                  rpc['Event/SaveOwnerClaimThread']({
                    team_id: event.team_id,
                    owner_group_id: ownerGroupId,
                    thread_id: decodeSnowflake(created.id),
                  }),
                ),
                Effect.flatMap(({ created, winner }) => {
                  const winnerId = decodeSnowflake(Option.getOrElse(winner, () => created.id));
                  if (winnerId === created.id) return Effect.succeed(winnerId);
                  // Lost the save race — delete the orphan thread we just created (best-effort)
                  return rest.deleteChannel(decodeSnowflake(created.id)).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        'handleTrainingClaimRequest: failed to delete orphan thread',
                        cause,
                      ),
                    ),
                    Effect.as(winnerId),
                  );
                }),
              );

          // Resolve the persistent owners claim thread for this owner group, creating it if absent.
          const resolveThread = Effect.fromOption(event.owner_group_id).pipe(
            Effect.bindTo('ownerGroupId'),
            Effect.bind('existingThread', ({ ownerGroupId }) =>
              rpc['Event/GetOwnerClaimThread']({
                team_id: event.team_id,
                owner_group_id: ownerGroupId,
              }),
            ),
            Effect.flatMap(({ ownerGroupId, existingThread }) =>
              Option.match(existingThread, {
                onSome: Effect.succeed,
                onNone: () => createAndClaimThread(ownerGroupId),
              }),
            ),
          );

          // Post the embed to the thread; handle deleted thread (10003) by recreating.
          // Returns { channelId, messageId } where channelId is the actual thread used.
          const postToThread = (threadId: Discord.Snowflake) =>
            rest
              .createMessage(threadId, {
                embeds: payload.embeds,
                components: payload.components,
              })
              .pipe(
                Effect.map((msg) => ({
                  channelId: threadId,
                  messageId: decodeSnowflake(msg.id),
                })),
                Effect.catchTag('ErrorResponse', (err) => {
                  if (err.data.code !== 10003) return Effect.fail(err);
                  // Thread was deleted — clear, recreate, retry once
                  return Option.match(event.owner_group_id, {
                    onNone: () => Effect.fail(err),
                    onSome: (ownerGroupId) =>
                      rpc['Event/ClearOwnerClaimThread']({
                        team_id: event.team_id,
                        owner_group_id: ownerGroupId,
                      }).pipe(
                        Effect.flatMap(() => createAndClaimThread(ownerGroupId)),
                        Effect.flatMap((finalThreadId) =>
                          rest
                            .createMessage(finalThreadId, {
                              embeds: payload.embeds,
                              components: payload.components,
                            })
                            .pipe(
                              Effect.map((retryMsg) => ({
                                channelId: finalThreadId,
                                messageId: decodeSnowflake(retryMsg.id),
                              })),
                            ),
                        ),
                      ),
                  });
                }),
              );

          return resolveThread.pipe(
            Effect.flatMap(postToThread),
            Effect.flatMap(({ channelId, messageId }) =>
              rpc['Event/SaveClaimDiscordMessageId']({
                event_id: event.event_id,
                channel_id: channelId,
                message_id: messageId,
              }).pipe(
                Effect.tap(() =>
                  Effect.logInfo(
                    `Posted claim message for "${event.title}" to thread ${channelId}`,
                  ),
                ),
              ),
            ),
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `handleTrainingClaimRequest: failed for event ${event.event_id}`,
                cause,
              ),
            ),
          );
        }),
      ),
  });
