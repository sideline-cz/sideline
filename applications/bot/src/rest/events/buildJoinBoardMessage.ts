import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';

// Join request status type matching domain model
export type JoinRequestStatus = 'pending' | 'accepted' | 'declined';

// Minimal entry type needed for the board message builder
export type JoinRequestEntry = {
  readonly request_id: string;
  readonly event_id: string;
  readonly team_id: string;
  readonly member_display_name: Option.Option<string>;
  readonly member_discord_id: Option.Option<string>;
  readonly status: JoinRequestStatus;
  readonly decided_by_display_name: Option.Option<string>;
};

const PENDING_COLOR = 0xed8936; // orange
const ACCEPTED_COLOR = 0x57f287; // green
const DECLINED_COLOR = 0xed4245; // red
const BOARD_COLOR = 0x5865f2; // blurple

type BoardInput = {
  readonly mode: 'board';
  readonly title: string;
  readonly teamId: string;
  readonly eventId: string;
  readonly acceptedCount?: number;
  readonly locale: Locale;
};

type ReviewInput = {
  readonly mode: 'review';
  readonly entry: JoinRequestEntry;
  readonly teamId: string;
  readonly locale: Locale;
};

type BuildJoinBoardMessageInput = BoardInput | ReviewInput;

export const buildJoinBoardMessage = (
  opts: BuildJoinBoardMessageInput,
): {
  embeds: ReadonlyArray<Discord.RichEmbed>;
  components: ReadonlyArray<Discord.ActionRowComponentForMessageRequest>;
} => {
  const { locale } = opts;

  if (opts.mode === 'board') {
    const acceptedCount = opts.acceptedCount ?? 0;

    const embeds: ReadonlyArray<Discord.RichEmbed> = [
      {
        title: m.bot_join_board_title({ title: opts.title }, { locale }),
        description: m.bot_join_status_accepted_count({ count: String(acceptedCount) }, { locale }),
        color: BOARD_COLOR,
      },
    ];

    const components: Array<Discord.ActionRowComponentForMessageRequest> = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: m.bot_join_request_button({}, { locale }),
            custom_id: `join-request:${opts.teamId}:${opts.eventId}`,
          },
        ],
      },
    ];

    return { embeds, components };
  }

  // Review mode
  const { entry } = opts;
  const color =
    entry.status === 'accepted'
      ? ACCEPTED_COLOR
      : entry.status === 'declined'
        ? DECLINED_COLOR
        : PENDING_COLOR;

  const memberName = Option.getOrElse(entry.member_display_name, () => '?');
  const memberMention = Option.match(entry.member_discord_id, {
    onNone: () => `**${memberName}**`,
    onSome: (id) => `<@${id}>`,
  });

  const fields: Array<Discord.RichEmbedField> = [];

  if (entry.status === 'accepted') {
    const deciderName = Option.getOrElse(entry.decided_by_display_name, () => '?');
    fields.push({
      name: '​',
      value: m.bot_join_accepted_by({ user: `**${deciderName}**` }, { locale }),
      inline: false,
    });
  } else if (entry.status === 'declined') {
    const deciderName = Option.getOrElse(entry.decided_by_display_name, () => '?');
    fields.push({
      name: '​',
      value: m.bot_join_declined_by({ user: `**${deciderName}**` }, { locale }),
      inline: false,
    });
  }

  const embeds: ReadonlyArray<Discord.RichEmbed> = [
    {
      description: m.bot_join_review_pending({ user: memberMention }, { locale }),
      color,
      fields,
    },
  ];

  const components: Array<Discord.ActionRowComponentForMessageRequest> = [];

  if (entry.status === 'pending') {
    components.push({
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: m.bot_join_accept_button({}, { locale }),
          custom_id: `join-accept:${opts.teamId}:${entry.request_id}`,
        },
        {
          type: 2,
          style: 4,
          label: m.bot_join_decline_button({}, { locale }),
          custom_id: `join-decline:${opts.teamId}:${entry.request_id}`,
        },
      ],
    });
  }

  return { embeds, components };
};
