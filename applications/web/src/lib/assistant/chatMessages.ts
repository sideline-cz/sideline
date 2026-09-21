import { AiChatApi } from '@sideline/domain';

/**
 * Builds the `messages` payload for `POST /teams/:teamId/ai/chat`.
 *
 * `AiChatApi.ChatMessage` is a `Schema.Class`, and class membership is checked **nominally**, not
 * structurally: a plain `{ role, content }` object that matches every field still fails to encode
 * with `Expected AiChatMessage`. Because that failure happens while encoding the request body, no
 * HTTP request is ever made — the turn fails with the generic error and nothing reaches the server
 * logs, which makes it unusually expensive to diagnose from the outside. This shipped once; the
 * co-located test pins it so it cannot ship again.
 */
export const toChatMessages = (
  turns: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>,
): ReadonlyArray<AiChatApi.ChatMessage> =>
  turns.map(({ role, content }) => new AiChatApi.ChatMessage({ role, content }));
