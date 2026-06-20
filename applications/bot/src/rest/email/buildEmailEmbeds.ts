import type { EmailForwarding, EmailRpcEvents, Team } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { DateTime, Option } from 'effect';
import type { Locale } from '~/locale.js';

const APPROVAL_COLOR = 0xfee75c; // amber / yellow
const DETAILED_COLOR = 0x5865f2; // blurple
const SUMMARY_COLOR = 0x57f287; // green
const ORIGINAL_COLOR = 0x99aab5; // grey

const BODY_TRUNCATE_LIMIT = 3500;
const DETAILED_TRUNCATE_LIMIT = 3500;

/** Return Some(s) only when s has non-whitespace content, otherwise None. */
const nonBlank = (s: string): Option.Option<string> =>
  s.trim().length > 0 ? Option.some(s) : Option.none();

const toDiscordTimestamp = (dt: DateTime.Utc, style: 'R' | 'f' = 'R'): string =>
  `<t:${Math.floor(Number(DateTime.toEpochMillis(dt)) / 1000)}:${style}>`;

const truncateBody = (text: string, truncatedMarker: string): string =>
  text.length > BODY_TRUNCATE_LIMIT
    ? `${text.slice(0, BODY_TRUNCATE_LIMIT)}${truncatedMarker}`
    : text;

const truncateDetailed = (text: string, truncatedMarker: string): string => {
  if (text.length <= DETAILED_TRUNCATE_LIMIT) return text;
  const truncated = text.slice(0, DETAILED_TRUNCATE_LIMIT);
  return `${truncated}${truncatedMarker}`;
};

export const buildEmailDeepLink = (
  webUrl: Option.Option<string>,
  teamId: string,
  emailId: string,
): Option.Option<string> =>
  Option.map(webUrl, (url) => `${url.replace(/\/$/, '')}/teams/${teamId}/emails/${emailId}`);

export const buildTrainingResultDeepLink = (
  webUrl: Option.Option<string>,
  teamId: string,
  eventId: string,
): Option.Option<string> =>
  Option.map(
    webUrl,
    (url) => `${url.replace(/\/$/, '')}/teams/${teamId}/events/${eventId}#training-result`,
  );

export const buildTrainingGenerateDeepLink = (
  webUrl: Option.Option<string>,
  teamId: string,
  eventId: string,
): Option.Option<string> =>
  Option.map(
    webUrl,
    (url) => `${url.replace(/\/$/, '')}/teams/${teamId}/events/${eventId}#team-generator`,
  );

// ---------------------------------------------------------------------------
// Approval (two-embed)
// ---------------------------------------------------------------------------

/**
 * Build two embeds for the coach approval message:
 * - [0] Amber (0xfee75c): SHORT summary + From/Subject/Received fields + approval footer
 * - [1] Blurple (0x5865f2): DETAILED summary (truncated at ~3500) + approval detailed footer
 */
export const buildApprovalEmbeds = (
  event: EmailRpcEvents.EmailPostEvent,
  locale: Locale,
): ReadonlyArray<Discord.RichEmbed> => {
  // SHORT: short_summary (non-blank) → summary (non-blank) → body
  const shortText = Option.getOrElse(Option.flatMap(event.short_summary, nonBlank), () =>
    Option.getOrElse(Option.flatMap(event.summary, nonBlank), () => event.body),
  );

  // DETAILED: summary → body
  const detailedRaw = Option.getOrElse(event.summary, () => event.body);
  const truncatedMarker = m.bot_email_detailed_truncated({}, { locale });
  const detailedText = truncateDetailed(detailedRaw, truncatedMarker);

  const shortEmbed: Discord.RichEmbed = {
    color: APPROVAL_COLOR,
    description: shortText,
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

  const detailedEmbed: Discord.RichEmbed = {
    color: DETAILED_COLOR,
    title: m.bot_email_approval_detailed_title({}, { locale }),
    description: detailedText,
    footer: { text: m.bot_email_approval_detailed_footer({}, { locale }) },
  };

  return [shortEmbed, detailedEmbed];
};

/**
 * Legacy single-embed approval builder (kept for backwards compatibility
 * in case other code still references it). New callers should use buildApprovalEmbeds.
 */
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

/**
 * Build the approval action row: [Approve][Reject][Edit on Sideline (link, optional)]
 * The "Send original" Discord button has been dropped (web keeps send-original).
 */
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
          label: m.bot_email_btn_edit_sideline({}, { locale }),
          url,
        },
      ],
    }),
  ];

  return [{ type: 1, components: buttons }];
};

// ---------------------------------------------------------------------------
// Team-post (green embed, SHORT summary)
// ---------------------------------------------------------------------------

/**
 * Build the green embed posted to the team channel after approval.
 * Uses SHORT summary (short_summary → summary → body).
 */
export const buildTeamPostEmbed = (
  event: EmailRpcEvents.EmailPostEvent,
  locale: Locale,
): Discord.RichEmbed => {
  const title =
    event.subject.length > 0
      ? m.bot_email_summary_title({ subject: event.subject }, { locale })
      : m.bot_email_summary_title_fallback({}, { locale });

  // SHORT: short_summary (non-blank) → summary (non-blank) → body
  const shortRaw = Option.getOrElse(Option.flatMap(event.short_summary, nonBlank), () =>
    Option.getOrElse(Option.flatMap(event.summary, nonBlank), () => event.body),
  );
  const truncatedMarker = m.bot_email_original_truncated({}, { locale });
  const description = truncateBody(shortRaw, truncatedMarker);

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

/**
 * Legacy alias — kept so existing callers (handleEmailPostEvent) don't break
 * during migration.
 */
export const buildSummaryEmbed = buildTeamPostEmbed;

/**
 * Build the two non-link buttons for the team post message:
 * [📄 Detailed summary] [✉️ Original email]
 */
export const buildTeamPostComponents = (
  teamId: Team.TeamId,
  emailId: EmailForwarding.EmailMessageId,
  locale: Locale,
): Array<Discord.ActionRowComponentForMessageRequest> => [
  {
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        label: m.bot_email_btn_detailed({}, { locale }),
        custom_id: `email-detail:${teamId}:${emailId}`,
      },
      {
        type: 2,
        style: 2,
        label: m.bot_email_btn_original({}, { locale }),
        custom_id: `email-original:${teamId}:${emailId}`,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Original embed (for post_original kind)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ephemeral page builders
// ---------------------------------------------------------------------------

export interface BuildPageEmbedOptions {
  readonly kind: 'detailed' | 'original';
  readonly teamId: Team.TeamId;
  readonly emailId: EmailForwarding.EmailMessageId;
  readonly pageText: string;
  readonly pageIndex: number;
  readonly totalPages: number;
  readonly subject: string;
  readonly locale: Locale;
  readonly truncated?: boolean;
}

/**
 * Build a single ephemeral embed for the detailed or original email preview.
 * - detailed: blurple (0x5865f2), title m.bot_email_detailed_title
 * - original: grey (0x99aab5), title m.bot_email_original_ephemeral_title
 * Footer shows page indicator when totalPages > 1.
 */
export const buildPageEmbed = ({
  kind,
  pageText,
  pageIndex,
  totalPages,
  locale,
  truncated,
}: BuildPageEmbedOptions): Discord.RichEmbed => {
  const color = kind === 'detailed' ? DETAILED_COLOR : ORIGINAL_COLOR;
  const title =
    kind === 'detailed'
      ? m.bot_email_detailed_title({}, { locale })
      : m.bot_email_original_ephemeral_title({}, { locale });

  const footer =
    totalPages > 1
      ? {
          text:
            truncated === true
              ? m.bot_email_page_indicator_capped(
                  { current: pageIndex + 1, total: totalPages },
                  { locale },
                )
              : m.bot_email_page_indicator(
                  { current: pageIndex + 1, total: totalPages },
                  { locale },
                ),
        }
      : undefined;

  return {
    color,
    title,
    description: pageText,
    ...(footer !== undefined ? { footer } : {}),
  };
};

export interface BuildPageComponentsOptions {
  readonly kind: 'detailed' | 'original';
  readonly teamId: Team.TeamId;
  readonly emailId: EmailForwarding.EmailMessageId;
  readonly pageIndex: number;
  readonly totalPages: number;
  readonly locale: Locale;
}

/**
 * Build pagination buttons for the ephemeral preview.
 * Returns [] when totalPages === 1.
 * Otherwise returns one row: [◀ prev (disabled at 0)] [Page x/y (disabled)] [▶ next (disabled at last)]
 */
export const buildPageComponents = ({
  kind,
  teamId,
  emailId,
  pageIndex,
  totalPages,
  locale,
}: BuildPageComponentsOptions): Array<Discord.ActionRowComponentForMessageRequest> => {
  if (totalPages === 1) return [];

  const prefix = kind === 'detailed' ? 'email-detail-page' : 'email-original-page';

  const buttons: Array<Discord.ButtonComponentForMessageRequest> = [
    {
      type: 2,
      style: 2,
      label: '◀',
      custom_id: `${prefix}:${teamId}:${emailId}:${pageIndex - 1}`,
      disabled: pageIndex === 0,
    },
    {
      type: 2,
      style: 2,
      label: m.bot_email_page_indicator({ current: pageIndex + 1, total: totalPages }, { locale }),
      custom_id: `${prefix}-disabled:${teamId}:${emailId}`,
      disabled: true,
    },
    {
      type: 2,
      style: 2,
      label: '▶',
      custom_id: `${prefix}:${teamId}:${emailId}:${pageIndex + 1}`,
      disabled: pageIndex === totalPages - 1,
    },
  ];

  return [{ type: 1, components: buttons }];
};
