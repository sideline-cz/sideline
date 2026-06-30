import { createHash } from 'node:crypto';
import type { Discord as DiscordSchemas, EventRpcModels } from '@sideline/domain';
import type * as DiscordTypes from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';
import { buildUpcomingEventEmbed } from './buildUpcomingEventEmbed.js';

type MessageBody = {
  readonly content: string;
  readonly embeds: ReadonlyArray<DiscordTypes.RichEmbed>;
  readonly components: ReadonlyArray<DiscordTypes.ActionRowComponentForMessageRequest>;
  readonly allowed_mentions: { readonly parse: []; readonly users?: ReadonlyArray<string> };
};

/**
 * A rendered personal event message, split into the payloads needed to post it
 * without ever pinging the member while still highlighting unanswered events.
 *
 * Discord only paints the yellow "you were mentioned" highlight when the message
 * actually registers a mention of you — which `allowed_mentions: { parse: [] }`
 * suppresses. And a *create* that registers your mention pings you. So for an
 * unanswered event we post a mention-free message first (`createPayload`) and
 * then add the mention via an edit (`editPayload`, which allows the member's id):
 * edits never notify, but the mention registers, so the message highlights
 * without a ping. Once the member responds the mention is edited back out.
 */
export type PersonalMessageRender = {
  /** Mention-free body — safe to use on createMessage (never pings). */
  readonly createPayload: MessageBody;
  /** Desired final body — used on edits; registers the member's mention when unanswered. */
  readonly editPayload: MessageBody;
  /** True when the member has not responded → a mention edit is needed after create. */
  readonly needsMentionEdit: boolean;
  /** Stable hash of the final (edit) state — drives hash-diff skips. */
  readonly hash: string;
};

export const buildPersonalMessage = (params: {
  entry: EventRpcModels.UpcomingEventForUserEntry;
  yesAttendees: ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>;
  discordId: DiscordSchemas.Snowflake;
  locale: Locale;
}): PersonalMessageRender => {
  const { entry, yesAttendees, discordId, locale } = params;
  const rendered = buildUpcomingEventEmbed({ entry, yesAttendees, locale });
  const unanswered = Option.isNone(entry.my_response);

  const createPayload: MessageBody = {
    content: '',
    embeds: rendered.embeds,
    components: rendered.components,
    allowed_mentions: { parse: [] },
  };

  // Final state: when unanswered, mention the member AND allow that one id so the
  // mention registers (→ highlight). Applied via edit, so it never pings.
  const editPayload: MessageBody = unanswered
    ? {
        content: `<@${discordId}>`,
        embeds: rendered.embeds,
        components: rendered.components,
        allowed_mentions: { parse: [], users: [discordId] },
      }
    : createPayload;

  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        content: editPayload.content,
        embeds: editPayload.embeds,
        components: editPayload.components,
      }),
    )
    .digest('hex');

  return { createPayload, editPayload, needsMentionEdit: unanswered, hash };
};
