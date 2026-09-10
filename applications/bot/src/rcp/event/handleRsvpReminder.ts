import type { Discord, EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Option, pipe, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatEventWhen } from '~/rest/events/eventWhen.js';
import { formatNameWithMention, splitIntoFieldChunks } from '~/rest/utils.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

const REMINDER_COLOR = 0xfee75c; // yellow

export const handleRsvpReminder = (event: EventRpcEvents.RsvpReminderEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('summary', ({ rpc }) =>
      rpc['Event/GetRsvpReminderSummary']({ event_id: event.event_id }),
    ),
    Effect.bind('guild', ({ rest }) => rest.getGuild(event.guild_id).pipe(Effect.map(decodeGuild))),
    // Per-member personal channel ids, used to link each non-responder's DM to
    // their own personal events channel instead of the (removed) shared board.
    Effect.bind('personalChannels', ({ rpc }) =>
      rpc['Guild/ListPersonalChannelsForEvent']({ event_id: event.event_id }).pipe(
        Effect.catchTag('RpcClientError', (e) =>
          Effect.logWarning(
            `RPC error listing personal channels for event ${event.event_id}`,
            e,
          ).pipe(Effect.as([])),
        ),
      ),
    ),
    Effect.flatMap(({ rest, summary, guild, personalChannels }) => {
      const channelId = Option.getOrUndefined(
        Option.orElse(event.discord_channel_id, () => guild.system_channel_id),
      );
      if (!channelId) {
        return Effect.logWarning(
          `Guild ${event.guild_id} has no system channel, skipping RSVP reminder`,
        );
      }
      const locale = guildLocale({ guild_locale: guild.preferred_locale });

      const nameFieldChunks = (entries: ReadonlyArray<string>, fieldName: string) =>
        splitIntoFieldChunks(entries).map((value) => ({ name: fieldName, value, inline: false }));

      const yesAttendeeNames = pipe(summary.yesAttendees, Array.map(formatNameWithMention));
      const nonResponderNames = pipe(summary.nonResponders, Array.map(formatNameWithMention));

      // `RsvpReminderEvent` has no `end_at` field, so `endAt: Option.none()` is required here.
      const whenText = `${formatEventWhen({
        startAt: event.start_at,
        // ⚠ the all-day branch takes DATES, not instants. This supplies the UTC date of the
        // (still noon-anchored) instant, which is correct under the current storage anchor; a
        // later change replaces it with the payload's real `start_date`.
        startDate: DateTime.formatIsoDateUtc(event.start_at),
        endAt: Option.none(),
        endDate: Option.none(),
        allDay: event.all_day,
        locale,
      })} (${toDiscordTimestamp(event.start_at, 'R')})`;

      // The DM uses a full sentence, not the "field" composition — the all-day sentence key
      // (`bot_rsvp_reminder_dm_all_day`) is grammatically correct with a bare date + relative
      // suffix and must NOT carry the " · All day" marker that `whenText` adds for the embed
      // field (A1b).
      const whenSentence = event.all_day
        ? `${toDiscordTimestamp(event.start_at, 'D')} (${toDiscordTimestamp(event.start_at, 'R')})`
        : whenText;

      const fields = [
        {
          name: m.bot_embed_when({}, { locale }),
          value: whenText,
          inline: false,
        },
        {
          name: m.bot_embed_rsvps({}, { locale }),
          value: m.bot_embed_rsvp_summary(
            {
              yes: String(summary.yesCount),
              no: String(summary.noCount),
              maybe: String(summary.maybeCount),
            },
            { locale },
          ),
          inline: false,
        },
        ...nameFieldChunks(yesAttendeeNames, m.bot_embed_going({}, { locale })),
        ...nameFieldChunks(nonResponderNames, m.rsvp_nonRespondersTitle({}, { locale })),
      ];

      const postChannel = rest
        .createMessage(channelId, {
          embeds: [
            {
              title: m.bot_rsvp_reminder_title({ title: event.title }, { locale }),
              color: REMINDER_COLOR,
              fields,
            },
          ],
        })
        .pipe(
          Effect.tap((msg) =>
            Effect.logInfo(
              `Posted RSVP reminder for "${event.title}" to channel ${channelId}, message ${msg.id}`,
            ),
          ),
          Effect.asVoid,
        );

      // Fall back to the reminder-channel link for members without a personal channel.
      const personalChannelByDiscordId = new Map(
        personalChannels.map((member) => [member.discord_id, member.personal_channel_id]),
      );
      const linkFor = (discordId: Discord.Snowflake) => {
        const personalChannelId = personalChannelByDiscordId.get(discordId);
        return personalChannelId !== undefined
          ? `https://discord.com/channels/${event.guild_id}/${personalChannelId}`
          : `https://discord.com/channels/${event.guild_id}/${channelId}`;
      };

      const dmNonResponders = pipe(
        summary.nonResponders,
        Array.map((nr) => nr.discord_id),
        Array.getSomes,
        Array.map((discordId) =>
          rest.createDm({ recipient_id: discordId }).pipe(
            Effect.flatMap((dm) =>
              rest.createMessage(dm.id, {
                embeds: [
                  {
                    title: m.bot_rsvp_reminder_title({ title: event.title }, { locale }),
                    description: event.all_day
                      ? m.bot_rsvp_reminder_dm_all_day(
                          { title: event.title, when: whenSentence, link: linkFor(discordId) },
                          { locale },
                        )
                      : m.bot_rsvp_reminder_dm(
                          { title: event.title, when: whenSentence, link: linkFor(discordId) },
                          { locale },
                        ),
                    color: REMINDER_COLOR,
                  },
                ],
              }),
            ),
            Effect.tap(() => Effect.logInfo(`Sent RSVP reminder DM to Discord user ${discordId}`)),
            Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (err) =>
              Effect.logWarning(
                `Failed to send RSVP reminder DM to Discord user ${discordId}: ${err}`,
              ),
            ),
          ),
        ),
      );

      const sendDms = Array.isReadonlyArrayEmpty(dmNonResponders)
        ? Effect.void
        : Effect.all(dmNonResponders, { concurrency: 5 }).pipe(Effect.asVoid);

      return Effect.all([postChannel, sendDms], { concurrency: 'unbounded' }).pipe(Effect.asVoid);
    }),
  );
