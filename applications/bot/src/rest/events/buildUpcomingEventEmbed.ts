import type { EventRpcModels, EventRsvp } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
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

  // The TRUE (unprojected) response, falling back to the legacy projected
  // `my_response` if the server hasn't shipped the new field yet (rolling
  // deploy safety). Row 2's Edit/Clear message buttons must encode this true
  // value in their custom_id — the projected `my_response` can't be told
  // apart from a real legacy `maybe`, so building those buttons from it would
  // let "Clear message" silently downgrade a `coming_later` RSVP to `maybe`
  // and bypass the mandatory-comment guard. Row 1's RSVP buttons and the
  // visual highlight logic intentionally keep using the projected
  // `my_response` above — those are confirmed correct as-is.
  const myActualResponse: Option.Option<EventRsvp.RsvpResponse> = Option.isSome(
    entry.my_response_actual,
  )
    ? entry.my_response_actual
    : entry.my_response;

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

  // custom_id: upcoming-rsvp:<event_id>:<team_id>:<response> — except the
  // third (coming_later) button, which always opens the required-comment
  // modal instead of instant-submitting (custom_id: u-add-msg:...).
  const rsvpRow: Discord.ActionRowComponentForMessageRequest = UI.row([
    UI.button({
      style: yesStyle,
      label: m.bot_btn_yes({}, { locale }),
      custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:yes`,
    }),
    UI.button({
      style: noStyle,
      label: m.bot_btn_no({}, { locale }),
      custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:no`,
    }),
    UI.button({
      style: maybeStyle,
      label: m.bot_btn_maybe({}, { locale }),
      custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:coming_later`,
    }),
  ]);

  // Row 2: Attendees button, plus (when user has responded) add/edit/clear message buttons
  const messageButtons: ReadonlyArray<Discord.ButtonComponentForMessageRequest> =
    myActualResponse.pipe(
      Option.map((response) =>
        Option.isSome(entry.my_message)
          ? [
              UI.button({
                style: Discord.ButtonStyleTypes.SECONDARY,
                label: m.bot_rsvp_edit_message({}, { locale }),
                custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:${response}`,
              }),
              // coming_later requires a message, so clearing it is illegal —
              // never render the "clear message" button for that response
              // (mirrors rsvp.ts's buildMessageActionRow).
              ...(response === 'coming_later'
                ? []
                : [
                    UI.button({
                      style: Discord.ButtonStyleTypes.DANGER,
                      label: m.bot_rsvp_clear_message({}, { locale }),
                      custom_id: `u-clear-msg:${entry.team_id}:${entry.event_id}:${response}`,
                    }),
                  ]),
            ]
          : [
              UI.button({
                style: Discord.ButtonStyleTypes.SECONDARY,
                label: m.bot_rsvp_add_message({}, { locale }),
                custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:${response}`,
              }),
            ],
      ),
      Option.getOrElse(() => []),
    );

  const messageRow: Discord.ActionRowComponentForMessageRequest = UI.row([
    UI.button({
      style: Discord.ButtonStyleTypes.SECONDARY,
      label: m.bot_btn_attendees({}, { locale }),
      custom_id: `attendees:${entry.team_id}:${entry.event_id}:0`,
    }),
    ...messageButtons,
  ]);

  const components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest> = [
    rsvpRow,
    messageRow,
  ];

  return {
    embeds,
    components,
  };
};
