import { Schema } from 'effect';

// UUID-checked: a malformed id would otherwise hit the UUID column, raise 22P02, and surface as a
// defect through catchSqlErrors.
export const DiscordReadRequestId = Schema.String.pipe(
  Schema.check(Schema.isUUID()),
  Schema.brand('DiscordReadRequestId'),
);
export type DiscordReadRequestId = typeof DiscordReadRequestId.Type;

// What the bot got from Discord. Every Discord failure is written back as an outcome, so the
// waiting server gets a real answer instead of a timeout.
export const DiscordReadOutcome = Schema.Literals([
  'ok',
  'channel_missing',
  'no_access',
  'discord_error',
]);
export type DiscordReadOutcome = typeof DiscordReadOutcome.Type;

// `author` is a Discord display name, never a user id or a person FK (GDPR decision in the
// 1795100000 migration). `timestamp` is Discord's ISO string, passed through.
export const DiscordReadMessage = Schema.Struct({
  author: Schema.String,
  content: Schema.String,
  timestamp: Schema.String,
});
export type DiscordReadMessage = typeof DiscordReadMessage.Type;

// A Struct, not a Class: it is both an RPC payload field and a jsonb column value.
export const DiscordReadResult = Schema.Struct({
  outcome: DiscordReadOutcome,
  messages: Schema.Array(DiscordReadMessage),
  capped: Schema.Boolean,
});
export type DiscordReadResult = typeof DiscordReadResult.Type;

// Size cap for the messages of one read. The bot applies it before SubmitResult (data
// minimisation: Postgres never holds more member content than the model gets); the server
// re-applies it only as a guard. It sits under ChatAgent's TOOL_RESULT_CHAR_BUDGET (6000), which
// does not apply to a non-items tool result.
export const READ_RESULT_CHAR_BUDGET = 5000;
