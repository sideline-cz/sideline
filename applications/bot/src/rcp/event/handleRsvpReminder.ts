import type { Discord, EventRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array, DateTime, Effect, Option, pipe, Schema } from 'effect';
import { guildLocale } from '~/locale.js';
import { discordDateInstant, toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatEventWhen } from '~/rest/events/eventWhen.js';
import { DfxGuild } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

const REMINDER_COLOR = 0xfee75c; // yellow

export const handleRsvpReminder = (event: EventRpcEvents.RsvpReminderEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    // The reminder-channel summary post is gone (Task 2); only `nonResponders` is consumed now.
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
      const locale = guildLocale({ guild_locale: guild.preferred_locale });

      // `RsvpReminderEvent` has no `end_at` field, so `endAt: Option.none()` is required here.
      // ⚠ the all-day branch takes DATES, not instants. `event.start_date` is the team-local
      // calendar date projected by the server; fall back to the UTC date of `start_at` when an
      // older server hasn't shipped the field yet (rolling-deploy skew, §17.1 row 3).
      const startDate = Option.getOrElse(event.start_date, () =>
        DateTime.formatIsoDateUtc(event.start_at),
      );
      const whenText = `${formatEventWhen({
        startAt: event.start_at,
        startDate,
        endAt: Option.none(),
        endDate: Option.none(),
        allDay: event.all_day,
        locale,
      })} (${toDiscordTimestamp(event.start_at, 'R')})`;

      // The DM uses a full sentence, not the "field" composition — the all-day sentence key
      // (`bot_rsvp_reminder_dm_all_day`) is grammatically correct with a bare date + relative
      // suffix and must NOT carry the " · All day" marker that `whenText` adds for the embed
      // field (A1b). The display instant is reconstructed from the derived date (§11.4) — a raw
      // read of `event.start_at` would render the previous day for any viewer west of the team.
      const whenSentence = event.all_day
        ? `${toDiscordTimestamp(discordDateInstant(startDate, event.start_at), 'D')} (${toDiscordTimestamp(event.start_at, 'R')})`
        : whenText;

      // Fall back to the reminder-channel link, and finally to the guild's channel list, for
      // members without a personal channel and when no reminder channel is resolvable.
      const personalChannelByDiscordId = new Map(
        personalChannels.map((member) => [member.discord_id, member.personal_channel_id]),
      );
      const linkFor = (discordId: Discord.Snowflake) => {
        const personalChannelId = personalChannelByDiscordId.get(discordId);
        if (personalChannelId !== undefined) {
          return `https://discord.com/channels/${event.guild_id}/${personalChannelId}`;
        }
        if (channelId !== undefined) {
          return `https://discord.com/channels/${event.guild_id}/${channelId}`;
        }
        return `https://discord.com/channels/${event.guild_id}`;
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

      return Array.isReadonlyArrayEmpty(dmNonResponders)
        ? Effect.void
        : Effect.all(dmNonResponders, { concurrency: 5 }).pipe(Effect.asVoid);
    }),
  );
