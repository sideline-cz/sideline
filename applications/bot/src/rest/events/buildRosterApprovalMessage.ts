import type { Event, TeamMember } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { formatNameWithMention } from '../utils.js';

const PENDING_COLOR = 0xed8936; // orange
const APPROVED_COLOR = 0x57f287; // green
const DECLINED_COLOR = 0xed4245; // red

const toDiscordTimestamp = (dt: DateTime.Utc): string => {
  const unix = Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000);
  return `<t:${unix}:f>`;
};

export type RosterApprovalStatus = 'pending' | 'approved' | 'declined' | 'cancelled';

export const buildRosterApprovalMessage = (opts: {
  eventId: Event.EventId;
  eventTitle: string;
  startAt: DateTime.Utc;
  memberId: TeamMember.TeamMemberId;
  candidateDiscordId: Option.Option<string>;
  candidateDisplayName: Option.Option<string>;
  rosterName: Option.Option<string>;
  status: RosterApprovalStatus;
  locale: Locale;
}): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const { locale, status, eventId, memberId } = opts;

  const candidateEntry = {
    discord_id: opts.candidateDiscordId,
    name: opts.candidateDisplayName,
    nickname: Option.none(),
    display_name: Option.none(),
    username: Option.none(),
  };
  const candidateFormatted = formatNameWithMention(candidateEntry);

  const color =
    status === 'pending' ? PENDING_COLOR : status === 'approved' ? APPROVED_COLOR : DECLINED_COLOR;

  // Build embed description/footer based on status
  const fields: Array<Discord.RichEmbedField> = [];

  // Event field
  fields.push({
    name: m.bot_roster_approval_field_event({}, { locale }),
    value: `**${opts.eventTitle}** — ${toDiscordTimestamp(opts.startAt)}`,
    inline: false,
  });

  // Candidate field
  fields.push({
    name: m.bot_roster_approval_field_candidate({}, { locale }),
    value: candidateFormatted,
    inline: false,
  });

  // Roster field
  Option.match(opts.rosterName, {
    onNone: () => undefined,
    onSome: (name) =>
      fields.push({
        name: m.bot_roster_approval_field_roster({}, { locale }),
        value: name,
        inline: false,
      }),
  });

  // Status line for decided states
  if (status !== 'pending') {
    const statusText =
      status === 'approved'
        ? m.bot_roster_state_approved({ candidate: candidateFormatted }, { locale })
        : status === 'declined'
          ? m.bot_roster_state_declined({ candidate: candidateFormatted }, { locale })
          : m.bot_roster_state_withdrawn({}, { locale });

    fields.push({
      name: '​',
      value: statusText,
      inline: false,
    });
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      title: m.bot_roster_approval_title({}, { locale }),
      description: status === 'pending' ? m.bot_roster_approval_footer({}, { locale }) : undefined,
      color,
      fields,
    },
  ];

  // Build components
  const components: Array<Discord.ActionRowComponentForMessageRequest> = [];

  if (status === 'pending') {
    components.push(
      UI.row([
        UI.button({
          style: 3, // style 3 = Success
          label: m.bot_roster_btn_approve({}, { locale }),
          custom_id: `rsv-approve:${eventId}:${memberId}`,
        }),
        UI.button({
          style: 4, // style 4 = Danger
          label: m.bot_roster_btn_decline({}, { locale }),
          custom_id: `rsv-decline:${eventId}:${memberId}`,
        }),
      ]),
    );
  } else {
    // Disabled row for decided/withdrawn states
    components.push(
      UI.row([
        UI.button({
          style: 3, // style 3 = Success
          label: m.bot_roster_btn_approve({}, { locale }),
          custom_id: `rsv-approve:${eventId}:${memberId}`,
          disabled: true,
        }),
        UI.button({
          style: 4, // style 4 = Danger
          label: m.bot_roster_btn_decline({}, { locale }),
          custom_id: `rsv-decline:${eventId}:${memberId}`,
          disabled: true,
        }),
      ]),
    );
  }

  return { embeds, components };
};
