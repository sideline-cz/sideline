/**
 * The Discord face of the in-app AI assistant (`AiChatApi`). The bot never runs a second
 * assistant: it relays a thread's history to the same `ChatAgent` turn the web calls, acting as
 * the Discord user's linked Sideline account. Proposals are the web's own `AiChatApi.Proposal`,
 * confirmed or rejected through the same server-side path.
 */
import { Schema } from 'effect';
import * as AiChatApi from '~/api/AiChatApi.js';
import * as Discord from '~/models/Discord.js';
import { Locale } from '~/models/User.js';

/** The Discord account is not linked to any Sideline user (never logged in to the web). */
export class AssistantNotLinked extends Schema.TaggedErrorClass<AssistantNotLinked>()(
  'AssistantNotLinked',
  {},
) {}

/** The guild has no team, or the linked user is not an active member of it. */
export class AssistantNotMember extends Schema.TaggedErrorClass<AssistantNotMember>()(
  'AssistantNotMember',
  {},
) {}

/** The channel is not an assistant thread, or the author is not the person who opened it. */
export class AssistantThreadNotFound extends Schema.TaggedErrorClass<AssistantThreadNotFound>()(
  'AssistantThreadNotFound',
  {},
) {}

/**
 * One assistant turn, flattened for Discord: `answer` already has its `[[ref:xxxx]]` markers
 * replaced by the cited entity's name, because Discord has no card to render them into.
 * `NullOr`, not `OptionFromNullOr`, on purpose — an Option over a Schema.Class in an RPC success
 * tips `SyncRpcs`' type inference over (see the server's `run.ts` R = unknown failure mode).
 */
export const AssistantTurn = Schema.Struct({
  answer: Schema.String,
  degraded_reason: Schema.NullOr(AiChatApi.DegradedReason),
  proposal: Schema.NullOr(AiChatApi.Proposal),
});
export type AssistantTurn = typeof AssistantTurn.Type;

/** What a confirmed proposal did: created a row, queued a Discord change, or changed a row. */
export const AssistantConfirmOutcome = Schema.Literals(['created', 'queued', 'applied']);
export type AssistantConfirmOutcome = typeof AssistantConfirmOutcome.Type;

/** Who opened an assistant thread, and the language bot text in it is written in. */
export const AssistantThreadOwner = Schema.Struct({
  owner_discord_id: Discord.Snowflake,
  locale: Locale,
});
export type AssistantThreadOwner = typeof AssistantThreadOwner.Type;
