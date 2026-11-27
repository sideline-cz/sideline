import type { EventRpcEvents, EventRsvp } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option, Schema } from 'effect';
import { guildLocale, type Locale } from '~/locale.js';
import { discordDateInstant, toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { DfxGuild } from '~/schemas.js';

const decodeGuild = Schema.decodeUnknownSync(DfxGuild);

const responseLabel = (response: EventRsvp.RsvpResponse, locale: Locale): string => {
  switch (response) {
    case 'yes':
      return m.bot_your_rsvp_yes({}, { locale });
    case 'no':
      return m.bot_your_rsvp_no({}, { locale });
    case 'maybe':
      return m.bot_your_rsvp_maybe({}, { locale });
    case 'coming_later':
      return m.bot_your_rsvp_coming_later({}, { locale });
  }
};

/** DMs a member that a coach set their RSVP. A member without Discord gets nothing; a failed DM
 *  (DMs closed) is logged, never retried — the RSVP itself is already saved. */
export const handleRsvpSetByCoach = (event: EventRpcEvents.RsvpSetByCoachEvent) =>
  Option.match(event.member_discord_id, {
    onNone: () => Effect.void,
    onSome: (discordId) =>
      Effect.Do.pipe(
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.bind('locale', ({ rest }) =>
          rest
            .getGuild(event.guild_id)
            .pipe(
              Effect.map((g) => guildLocale({ guild_locale: decodeGuild(g).preferred_locale })),
            ),
        ),
        Effect.bind('dm', ({ rest }) => rest.createDm({ recipient_id: discordId })),
        Effect.flatMap(({ rest, locale, dm }) =>
          rest.createMessage(dm.id, {
            embeds: [
              {
                title: m.bot_rsvp_set_by_coach_title({}, { locale }),
                description: m.bot_rsvp_set_by_coach_dm(
                  {
                    coach: event.coach_name,
                    title: event.title,
                    when: event.all_day
                      ? toDiscordTimestamp(
                          discordDateInstant(event.start_date, event.start_at),
                          'D',
                        )
                      : toDiscordTimestamp(event.start_at, 'f'),
                    response: responseLabel(event.response, locale),
                  },
                  { locale },
                ),
              },
            ],
            allowed_mentions: { parse: [] },
          }),
        ),
        Effect.asVoid,
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (err) =>
          Effect.logWarning(
            `Failed to DM Discord user ${discordId} about a coach-set RSVP: ${err}`,
          ),
        ),
      ),
  });
