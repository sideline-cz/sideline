import { AiChatApi } from '@sideline/domain';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { toChatMessages } from './chatMessages.js';

const encode = (messages: unknown) =>
  Effect.runPromise(Effect.result(Schema.encodeUnknownEffect(AiChatApi.ChatRequest)({ messages })));

describe('toChatMessages', () => {
  it('produces a payload the real ChatRequest schema accepts', async () => {
    const result = await encode(
      toChatMessages([
        { role: 'user', content: 'What is our next event?' },
        { role: 'assistant', content: 'Training on Thursday at 18:00.' },
      ]),
    );

    expect(result._tag).toBe('Success');
  });

  it('returns real ChatMessage instances, not structural look-alikes', () => {
    const [message] = toChatMessages([{ role: 'user', content: 'hi' }]);

    expect(message).toBeInstanceOf(AiChatApi.ChatMessage);
  });

  // The regression this module exists for. Plain objects match ChatMessage field-for-field, so
  // nothing in the type system or a mocked API client catches them — only a real encode does, and
  // it fails before any request is sent.
  it('plain objects are rejected by the schema, which is why the mapping cannot be inlined', async () => {
    const result = await encode([{ role: 'user', content: 'hi' }]);

    expect(result._tag).toBe('Failure');
    expect(String(result._tag === 'Failure' ? result.failure : '')).toContain('AiChatMessage');
  });

  it('preserves order and content verbatim', () => {
    const messages = toChatMessages([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);

    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'first'],
      ['assistant', 'second'],
      ['user', 'third'],
    ]);
  });
});
