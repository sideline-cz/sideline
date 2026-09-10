import type { EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Option, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatEventWhen } from '~/rest/events/eventWhen.js';
import { DfxGuild } from '~/schemas.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

const REMINDER_COLOR = 0xfee75c; // yellow

export const handleUnclaimedTrainingReminder = (
  event: EventRpcEvents.UnclaimedTrainingReminderEvent,
) =>
  Option.match(event.discord_target_channel_id, {
    onNone: () =>
      Effect.logWarning(
        `handleUnclaimedTrainingReminder: no owner channel resolved for event ${event.event_id}, skipping`,
      ),
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('guild', ({ rest }) =>
          rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild)),
        ),
        Effect.flatMap(({ rest, guild }) => {
          const locale = guildLocale({ guild_locale: guild.preferred_locale });

          // `endAt: Option.none()` is intentional — today's render ignores `event.end_at`, and
          // keeping it that way here holds the timed output byte-identical.
          const whenText = `${formatEventWhen({
            startAt: event.start_at,
            // ⚠ the all-day branch takes DATES, not instants. This supplies the UTC date of the
            // (still noon-anchored) instant, which is correct under the current storage anchor;
            // a later change replaces it with the payload's real `start_date`.
            startDate: DateTime.formatIsoDateUtc(event.start_at),
            endAt: Option.none(),
            endDate: Option.none(),
            allDay: event.all_day,
            locale,
          })} (${toDiscordTimestamp(event.start_at, 'R')})`;

          // The description sentence must NOT carry the " · All day" marker that `whenText`
          // bakes in for the (unused-here) field composition — the all-day description key
          // is grammatically correct with a bare date + relative suffix (A1b).
          const whenSentence = event.all_day
            ? `${toDiscordTimestamp(event.start_at, 'D')} (${toDiscordTimestamp(event.start_at, 'R')})`
            : whenText;

          // Optionally append a jump link when we have the claim message IDs
          const jumpLink = Option.flatMap(event.claim_discord_channel_id, (claimChannelId) =>
            Option.map(
              event.claim_discord_message_id,
              (messageId) =>
                `https://discord.com/channels/${event.guild_id}/${claimChannelId}/${messageId}`,
            ),
          );

          const descriptionBase = event.all_day
            ? m.bot_claim_unclaimed_reminder_description_all_day({ when: whenSentence }, { locale })
            : m.bot_claim_unclaimed_reminder_description({ when: whenSentence }, { locale });

          const description = Option.match(jumpLink, {
            onNone: () => descriptionBase,
            onSome: (link) =>
              `${descriptionBase}\n[${m.bot_claim_unclaimed_reminder_jump({}, { locale })}](${link})`,
          });

          const roleMention = Option.match(event.discord_role_id, {
            onNone: () =>
              ({}) as {
                content?: string;
                allowed_mentions?: { parse: []; roles: string[] };
              },
            onSome: (role) => ({
              content: `<@&${role}>`,
              allowed_mentions: { parse: [] as [], roles: [role] },
            }),
          });

          return rest
            .createMessage(channelId, {
              ...roleMention,
              embeds: [
                {
                  title: m.bot_claim_unclaimed_reminder_title({ title: event.title }, { locale }),
                  description,
                  color: REMINDER_COLOR,
                },
              ],
            })
            .pipe(
              Effect.tap((msg) =>
                Effect.logInfo(
                  `Posted unclaimed training reminder for "${event.title}" to channel ${channelId}, message ${msg.id}`,
                ),
              ),
              Effect.asVoid,
            );
        }),
      ),
  });
