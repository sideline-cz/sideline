import type { EventRpcModels } from '@sideline/domain';
import { EventRsvp } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { Array, DateTime, Option, pipe } from 'effect';
import type { Locale } from '~/locale.js';
import { toDiscordTimestamp } from '~/rest/discordTimestamp.js';
import { formatEventWhen } from '~/rest/events/eventWhen.js';
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

// The style a row-1 RSVP button wears when it IS the member's current response; every other
// button falls back to SECONDARY. Styles: 1=Primary(blurple), 2=Secondary(grey),
// 3=Success(green), 4=Danger(red).
const ACTIVE_BUTTON_STYLE: Record<EventRsvp.RsvpResponse, Discord.ButtonStyleTypes> = {
  yes: Discord.ButtonStyleTypes.SUCCESS,
  coming_later: Discord.ButtonStyleTypes.PRIMARY,
  maybe: Discord.ButtonStyleTypes.PRIMARY,
  no: Discord.ButtonStyleTypes.DANGER,
};

const buildYourRsvpValue = (
  myResponse: Option.Option<EventRsvp.RsvpResponse>,
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
        case 'coming_later':
          return m.bot_your_rsvp_coming_later({}, { locale });
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
  // The "Dnes"/"Today" marker (plan §4.6) is keyed off `entry.status`, NEVER off a clock
  // read: `status` flips exactly once, in the database, when the event actually starts,
  // and `EventStartCron` already dirty-marks the personal message on that flip. A
  // renderer that instead compared `now()` against the event's date would make this
  // function's output — and therefore `buildPersonalEventMessage`'s hash — depend on the
  // wall clock, producing a spurious edit on every reconcile pass near the boundary.
  // A multi-day all-day event stays `'started'` for its whole run, so days 2..n also
  // render "Dnes" — that is intended (the event genuinely is happening today), not a bug.
  descParts.push(
    entry.all_day && entry.status === 'started'
      ? m.bot_embed_today({}, { locale })
      : toDiscordTimestamp(entry.start_at, 'R'),
  );

  const fields: Array<Discord.RichEmbedField> = [];

  const when = formatEventWhen({
    startAt: entry.start_at,
    // ⚠ the all-day branch takes DATES, not instants. `entry.start_date` is the team-local
    // calendar date projected by the server (§11.2/§11.4 of the plan); fall back to the UTC
    // date of `start_at` when an older server hasn't shipped the field yet (rolling-deploy
    // skew, §17.1 row 3). `DateTime.formatIsoDateUtc` is the repo idiom outside the web — do
    // NOT reach for `formatUtcDate`, which lives in applications/web only.
    startDate: Option.getOrElse(entry.start_date, () => DateTime.formatIsoDateUtc(entry.start_at)),
    endAt: entry.end_at,
    // `end_date` is only meaningful when the entry actually has an `end_at` (§11.4: the
    // caller derives the `Option` from `end_at`, not from `end_date`, which the server always
    // sends non-null). Same skew fallback as `startDate` above.
    endDate: Option.map(entry.end_at, (endAt) =>
      Option.getOrElse(entry.end_date, () => DateTime.formatIsoDateUtc(endAt)),
    ),
    allDay: entry.all_day,
    locale,
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
        coming_later: String(entry.coming_later_count),
        maybe: String(entry.maybe_count),
        no: String(entry.no_count),
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

  // The TRUE (unprojected) response, falling back to the legacy projected
  // `my_response` if the server hasn't shipped the new field yet (rolling
  // deploy safety). `my_response` now carries the true stored value against a
  // server that has shipped this release; `my_response_actual` remains for the
  // window where a NEW bot talks to an OLD server that still projects
  // `coming_later -> maybe`. This one variable drives BOTH row 1's style
  // highlight and row 2's Edit/Clear message custom_ids — against a new server
  // the two sources are identical, against an old one only the true value
  // avoids wrongly highlighting the maybe button for a `coming_later` member.
  const myActualResponse: Option.Option<EventRsvp.RsvpResponse> = Option.isSome(
    entry.my_response_actual,
  )
    ? entry.my_response_actual
    : entry.my_response;

  // Row 1: RSVP buttons. The highlight reads `myActualResponse`, NOT `entry.my_response` —
  // see the note above.
  const styleFor = (response: EventRsvp.RsvpResponse): Discord.ButtonStyleTypes =>
    Option.contains(myActualResponse, response)
      ? ACTIVE_BUTTON_STYLE[response]
      : Discord.ButtonStyleTypes.SECONDARY;

  // custom_id: upcoming-rsvp:<event_id>:<team_id>:<response> — except the
  // coming_later and maybe buttons, which both mandate a comment and so always
  // open the required-comment modal instead of instant-submitting
  // (custom_id: u-add-msg:...:{response}:v).
  const rsvpRow: Discord.ActionRowComponentForMessageRequest = UI.row([
    UI.button({
      style: styleFor('yes'),
      label: m.bot_btn_yes({}, { locale }),
      custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:yes`,
    }),
    UI.button({
      style: styleFor('coming_later'),
      label: m.bot_btn_coming_later({}, { locale }),
      // ⚠ The `:v` marker is load-bearing. Once the member's response IS
      // `coming_later`, row 2 below renders an edit-message button whose
      // custom_id is `u-add-msg:{team}:{event}:coming_later` — byte-identical to
      // this one without the marker. Discord rejects a message carrying two
      // components with the same custom_id (50035), so the card became
      // unrenderable the moment someone voted "Coming later": the interaction
      // PATCH 400'd, every reconcile 400'd, and `reorderPersonalChannel` (which
      // deletes before it recreates) made the card vanish outright. Because
      // `coming_later` mandates a comment, that edit button ALWAYS renders, so
      // the collision was guaranteed, not occasional.
      // The marker is inert — `UpcomingAddMessageButton` matches on the
      // `u-add-msg:` prefix and reads parts[1..3] only. Keep it SHORT: with two
      // UUIDs this id is already 98 of Discord's 100-character budget.
      custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:coming_later:v`,
    }),
    UI.button({
      style: styleFor('maybe'),
      label: m.bot_btn_maybe({}, { locale }),
      // `maybe` mandates a comment too, so it opens the modal exactly like
      // coming_later above — and therefore needs its OWN `:v` marker for the
      // same reason: row 2's edit button mints
      // `u-add-msg:{team}:{event}:maybe` verbatim once the member's response
      // IS `maybe`, and two identical custom_ids on one message is a 50035
      // that kills the whole card. 91 chars with two UUIDs, inside the 100
      // budget (the coming_later id above is the longest at 98).
      custom_id: `u-add-msg:${entry.team_id}:${entry.event_id}:maybe:v`,
    }),
    UI.button({
      style: styleFor('no'),
      label: m.bot_btn_no({}, { locale }),
      custom_id: `upcoming-rsvp:${entry.event_id}:${entry.team_id}:no`,
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
              // coming_later and maybe both require a message, so clearing it is
              // illegal — never render the "clear message" button for those
              // responses (mirrors rsvp.ts's buildMessageActionRow).
              ...(EventRsvp.rsvpResponseRequiresMessage(response)
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
