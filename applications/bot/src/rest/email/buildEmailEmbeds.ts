import type { EmailRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';

const APPROVAL_COLOR = 0xfee75c; // amber / yellow
const SUMMARY_COLOR = 0x57f287; // green
const ORIGINAL_COLOR = 0x99aab5; // grey

const BODY_TRUNCATE_LIMIT = 3500;

const toDiscordTimestamp = (dt: DateTime.Utc, style: 'R' | 'f' = 'R'): string =>
  `<t:${Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000)}:${style}>`;

const truncateBody = (text: string, truncatedMarker: string): string =>
  text.length > BODY_TRUNCATE_LIMIT
    ? `${text.slice(0, BODY_TRUNCATE_LIMIT)}${truncatedMarker}`
    : text;

export const buildEmailDeepLink = (
  webUrl: Option.Option<string>,
  teamId: string,
  emailId: string,
): Option.Option<string> =>
  Option.map(webUrl, (url) => `${url.replace(/\/$/, '')}/teams/${teamId}/emails/${emailId}`);

export const buildApprovalEmbed = (
  event: EmailRpcEvents.EmailPostEvent,
  locale: Locale,
): Discord.RichEmbed => {
  const summary = Option.getOrElse(event.summary, () => event.body);
  const summaryText =
    summary.length > BODY_TRUNCATE_LIMIT ? `${summary.slice(0, BODY_TRUNCATE_LIMIT)}…` : summary;

  return {
    color: APPROVAL_COLOR,
    title: m.bot_email_approval_title({}, { locale }),
    description: summaryText,
    fields: [
      {
        name: m.bot_email_approval_field_from({}, { locale }),
        value: event.from_address,
        inline: true,
      },
      {
        name: m.bot_email_approval_field_subject({}, { locale }),
        value: event.subject.length > 0 ? event.subject : '(no subject)',
        inline: true,
      },
      {
        name: m.bot_email_approval_field_received({}, { locale }),
        value: toDiscordTimestamp(event.received_at, 'R'),
        inline: true,
      },
    ],
    footer: { text: m.bot_email_approval_footer({}, { locale }) },
  };
};

export const buildApprovalComponents = (
  teamId: string,
  emailId: string,
  deepLink: Option.Option<string>,
  locale: Locale,
): Array<Discord.ActionRowComponentForMessageRequest> => {
  const buttons: Array<Discord.ButtonComponentForMessageRequest> = [
    {
      type: 2,
      style: 3,
      label: m.bot_email_btn_approve({}, { locale }),
      custom_id: `email-approve:${teamId}:${emailId}`,
    },
    {
      type: 2,
      style: 4,
      label: m.bot_email_btn_reject({}, { locale }),
      custom_id: `email-reject:${teamId}:${emailId}`,
    },
    ...Option.match(deepLink, {
      onNone: () => [] as Array<Discord.ButtonComponentForMessageRequest>,
      onSome: (url): Array<Discord.ButtonComponentForMessageRequest> => [
        {
          type: 2,
          style: 5,
          label: m.bot_email_btn_review({}, { locale }),
          url,
        },
      ],
    }),
  ];

  return [{ type: 1, components: buttons }];
};

export const buildSummaryEmbed = (
  event: EmailRpcEvents.EmailPostEvent,
  locale: Locale,
): Discord.RichEmbed => {
  const title =
    event.subject.length > 0
      ? m.bot_email_summary_title({ subject: event.subject }, { locale })
      : m.bot_email_summary_title_fallback({}, { locale });

  const description = Option.getOrElse(event.summary, () => event.body);

  return {
    color: SUMMARY_COLOR,
    title,
    description,
    fields: [
      {
        name: m.bot_email_summary_field_from({}, { locale }),
        value: event.from_address,
        inline: true,
      },
      {
        name: m.bot_email_summary_field_received({}, { locale }),
        value: toDiscordTimestamp(event.received_at, 'R'),
        inline: true,
      },
    ],
    footer: { text: m.bot_email_summary_footer({}, { locale }) },
  };
};

export const buildOriginalEmbed = (
  event: EmailRpcEvents.EmailPostEvent,
  locale: Locale,
): Discord.RichEmbed => {
  const title =
    event.subject.length > 0
      ? m.bot_email_original_title({ subject: event.subject }, { locale })
      : m.bot_email_original_title_fallback({}, { locale });

  const truncatedMarker = m.bot_email_original_truncated({}, { locale });
  const description = truncateBody(event.body, truncatedMarker);

  return {
    color: ORIGINAL_COLOR,
    title,
    description,
    fields: [
      {
        name: m.bot_email_original_field_from({}, { locale }),
        value: event.from_address,
        inline: true,
      },
      {
        name: m.bot_email_original_field_received({}, { locale }),
        value: toDiscordTimestamp(event.received_at, 'R'),
        inline: true,
      },
    ],
    footer: { text: m.bot_email_original_footer({}, { locale }) },
  };
};

export const buildTeamPostComponents = (
  deepLink: Option.Option<string>,
  locale: Locale,
): Array<Discord.ActionRowComponentForMessageRequest> =>
  Option.match(deepLink, {
    onNone: () => [],
    onSome: (url) => [
      {
        type: 1 as const,
        components: [
          {
            type: 2 as const,
            style: 5 as const,
            label: m.bot_email_btn_view_original({}, { locale }),
            url,
          },
        ],
      },
    ],
  });
