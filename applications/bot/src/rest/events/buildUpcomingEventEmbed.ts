import type { EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import * as Discord from 'dfx/types';
import { Array, DateTime, Option, pipe } from 'effect';
import type { Locale } from '~/locale.js';
import { formatName } from '../utils.js';
import { locationDisplay } from './locationDisplay.js';

const EVENT_TYPE_COLORS: Record<string, number> = {
  training: 0x57f287,
  match: 0xed4245,
  tournament: 0xfee75c,
  meeting: 0x5865f2,
  social: 0xeb459e,
  other: 0x99aab5,
};

const DEFAULT_COLOR = 0x99aab5;

const toDiscordTimestamp = (
  dt: DateTime.Utc,
  style: 'D' | 'F' | 'R' | 'd' | 'f' | 't' = 'f',
): string => {
  const unix = Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000);
  return `<t:${unix}:${style}>`;
};

const isSameDay = (a: DateTime.Utc, b: DateTime.Utc): boolean => {
  const pa = DateTime.toParts(a);
  const pb = DateTime.toParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
};

const buildYourRsvpValue = (
  myResponse: Option.Option<'yes' | 'no' | 'maybe'>,
  myMessage: Option.Option<string>,
  locale: Locale,
): string => {
  const status = Option.match(myResponse, {
    onNone: () => m.bot_your_rsvp_none({}, { locale }),
    onSome: (r) => {
      switch (r) {
        case 'yes':
          return m.bot_your_rsvp_yes({}, { locale });
        case 'no':
          return m.bot_your_rsvp_no({}, { locale });
        case 'maybe':
          return m.bot_your_rsvp_maybe({}, { locale });
      }
    },
  });

  return Option.match(myMessage, {
    onNone: () => status,
    onSome: (message) => m.bot_your_rsvp_with_message({ status, message }, { locale }),
  });
};

export const buildUpcomingEventEmbed = (params: {
  entry: EventRpcModels.UpcomingEventForUserEntry;
  yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>;
  locale: Locale;
}): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const { entry, yesAttendees, locale } = params;

  const descParts: string[] = [];
  if (Option.isSome(entry.description)) {
    descParts.push(entry.description.value);
  }
  descParts.push(toDiscordTimestamp(entry.start_at, 'R'));

  const fields: Array<Discord.RichEmbedField> = [];

  const when = entry.all_day
    ? Option.match(entry.end_at, {
        onNone: () => toDiscordTimestamp(entry.start_at, 'D'),
        onSome: (endAt) =>
          isSameDay(entry.start_at, endAt)
            ? toDiscordTimestamp(entry.start_at, 'D')
            : `${toDiscordTimestamp(entry.start_at, 'D')} — ${toDiscordTimestamp(endAt, 'D')}`,
      })
    : Option.match(entry.end_at, {
        onNone: () => toDiscordTimestamp(entry.start_at, 'f'),
        onSome: (endAt) => {
          const endStyle = isSameDay(entry.start_at, endAt) ? 't' : 'f';
          return `${toDiscordTimestamp(entry.start_at, 'f')} — ${toDiscordTimestamp(endAt, endStyle)}`;
        },
      });
  fields.push({ name: m.bot_embed_when({}, { locale }), value: when, inline: false });

  Option.match(locationDisplay(entry.location, entry.location_url), {
    onNone: () => undefined,
    onSome: (value) =>
      fields.push({ name: m.bot_embed_where({}, { locale }), value, inline: false }),
  });

  fields.push({
    name: m.bot_embed_rsvps({}, { locale }),
    value: m.bot_embed_rsvp_summary(
      {
        yes: String(entry.yes_count),
        no: String(entry.no_count),
        maybe: String(entry.maybe_count),
      },
      { locale },
    ),
  });

  if (yesAttendees.length > 0) {
    const names = pipe(yesAttendees, Array.map(formatName), Array.join(', '));
    const extra =
      entry.yes_count > yesAttendees.length
        ? ` +${entry.yes_count - yesAttendees.length} more`
        : '';
    fields.push({
      name: m.bot_embed_going({}, { locale }),
      value: names + extra,
      inline: false,
    });
  }

  fields.push({
    name: m.bot_embed_your_rsvp({}, { locale }),
    value: buildYourRsvpValue(entry.my_response, entry.my_message, locale),
    inline: false,
  });

  const color = EVENT_TYPE_COLORS[entry.event_type] ?? DEFAULT_COLOR;

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: entry.title,
      description: descParts.join('\n'),
      color,
      fields,
      ...(Option.isSome(entry.image_url) ? { thumbnail: { url: entry.image_url.value } } : {}),
    },
  ];

  const myResponse = entry.my_response;

  // Row 1: RSVP buttons
  // Styles: 1=Primary(blurple), 2=Secondary(grey), 3=Success(green), 4=Danger(red)
  const yesStyle =
    Option.isSome(myResponse) && myResponse.value === 'yes'
      ? Discord.ButtonStyleTypes.SUCCESS
      : Discord.ButtonStyleTypes.SECONDARY;
  const noStyle =
    Option.isSome(myResponse) && myResponse.value === 'no'
      ? Discord.ButtonStyleTypes.DANGER
      : Discord.ButtonStyleTypes.SECONDARY;
  const maybeStyle =
    Option.isSome(myResponse) && myResponse.value === 'maybe'
      ? Discord.ButtonStyleTypes.PRIMARY
      : Discord.ButtonStyleTypes.SECONDARY;

  // custom_id: upcoming-rsvp:<event_id>:<team_id>:<response>
  const rsvpRow: Discord.ActionRowComponentForMessageRequest = {
    type: 1,
    components: [
      {
        type: 2,
        style: yesStyle,
        label: m.bot_btn_yes({}, { locale }),
        custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:yes`,
      },
      {
        type: 2,
        style: noStyle,
        label: m.bot_btn_no({}, { locale }),
        custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:no`,
      },
      {
        type: 2,
        style: maybeStyle,
        label: m.bot_btn_maybe({}, { locale }),
        custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:maybe`,
      },
      {
        type: 2,
        style: Discord.ButtonStyleTypes.SECONDARY,
        label: m.bot_btn_attendees({}, { locale }),
        custom_id: `attendees:${entry.team_id}:${entry.event_id}:0`,
      },
    ],
  };

  // Row 2 (only when user has responded): add/edit/clear message buttons
  const messageRow: Discord.ActionRowComponentForMessageRequest | undefined = Option.match(
    myResponse,
    {
      onNone: () => undefined,
      onSome: (response) => {
        const hasMessage = Option.isSome(entry.my_message);
        return {
          type: 1 as const,
          components: hasMessage
            ? [
                {
                  type: 2 as const,
                  style: Discord.ButtonStyleTypes.SECONDARY,
                  label: m.bot_rsvp_edit_message({}, { locale }),
                  custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:${response}`,
                },
                {
                  type: 2 as const,
                  style: Discord.ButtonStyleTypes.DANGER,
                  label: m.bot_rsvp_clear_message({}, { locale }),
                  custom_id: `u-clear-msg:${entry.team_id}:${entry.event_id}:${response}`,
                },
              ]
            : [
                {
                  type: 2 as const,
                  style: Discord.ButtonStyleTypes.SECONDARY,
                  label: m.bot_rsvp_add_message({}, { locale }),
                  custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:${response}`,
                },
              ],
        };
      },
    },
  );

  const components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest> =
    messageRow !== undefined ? [rsvpRow, messageRow] : [rsvpRow];

  return {
    embeds,
    components,
  };
};
