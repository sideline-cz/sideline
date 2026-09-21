// Tests for src/lib/assistant/history.ts
//
// Plan §13.11 / §9, design §2.6. `buildHistory` is the client-side mirror of the server's
// history truncation: it honours BOTH `HISTORY_CHAR_BUDGET` (8000 chars) and
// `HISTORY_MAX_MESSAGES` (20 messages), newest-first accumulation, and drops whole messages
// from the front — never a partial message. It reports `droppedCount` so the UI can render the
// "earlier messages aren't included" divider (design §2.6) instead of silently disagreeing with
// the server about what the model saw.

import { describe, expect, it } from 'vitest';
import { buildHistory, HISTORY_CHAR_BUDGET, HISTORY_MAX_MESSAGES } from './history.js';

type Turn = { readonly role: 'user' | 'assistant'; readonly content: string };

const alternatingTurns = (count: number, contentFor: (i: number) => string): Turn[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' : 'user',
    content: contentFor(i),
  }));

describe('buildHistory constants', () => {
  it('HISTORY_CHAR_BUDGET is 8000 (must equal the server constant)', () => {
    expect(HISTORY_CHAR_BUDGET).toBe(8000);
  });

  it('HISTORY_MAX_MESSAGES is 20 (the wire schema cap)', () => {
    expect(HISTORY_MAX_MESSAGES).toBe(20);
  });
});

describe('buildHistory', () => {
  // 13.11/1 — under both caps.
  it('returns the transcript unchanged when under both caps', () => {
    const turns = alternatingTurns(5, (i) => `message ${i}`);
    const result = buildHistory(turns);
    expect(result.droppedCount).toBe(0);
    expect(result.messages).toEqual(turns.map(({ role, content }) => ({ role, content })));
  });

  it('returns an empty result for an empty transcript', () => {
    const result = buildHistory([]);
    expect(result.messages).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });

  // 13.11/2 — over the message cap, under the char budget.
  it('caps at HISTORY_MAX_MESSAGES and keeps the newest ones when short messages exceed the count cap', () => {
    // 25 messages of 10 chars each: 25 * 10 = 250 chars, nowhere near the 8000 char budget, so
    // only the message-count cap can bind here.
    const turns = alternatingTurns(25, (i) => `msg-${String(i).padStart(3, '0')}`);
    const result = buildHistory(turns);
    expect(result.messages).toHaveLength(HISTORY_MAX_MESSAGES);
    expect(result.droppedCount).toBe(5);
    // The newest 20 are kept, in their original (chronological) order.
    expect(result.messages).toEqual(
      turns.slice(turns.length - HISTORY_MAX_MESSAGES).map(({ role, content }) => ({
        role,
        content,
      })),
    );
  });

  // 13.11/3 — the char budget binds before the message cap.
  it('the char budget binds before the message cap, dropping whole messages only', () => {
    // 6 messages of exactly 2000 chars: only 4 fit inside the 8000 char budget (4 * 2000 = 8000
    // exactly), well under the 20-message cap, so the char budget is what binds.
    const turns = alternatingTurns(6, (i) => `${i}`.repeat(2000));
    const result = buildHistory(turns);
    expect(result.droppedCount).toBe(2);
    expect(result.messages).toHaveLength(4);
    // Every returned message is a COMPLETE original — never sliced/truncated mid-string.
    const originalContents = new Set(turns.map((t) => t.content));
    for (const message of result.messages) {
      expect(message.content.length).toBe(2000);
      expect(originalContents.has(message.content)).toBe(true);
    }
    // The newest 4 are kept.
    expect(result.messages).toEqual(turns.slice(2).map(({ role, content }) => ({ role, content })));
  });

  // Both caps binding at once: the count cap alone would keep 20 messages, but their combined
  // length exceeds the char budget, so the char budget must trim further than the count cap
  // would on its own.
  it('honours the tighter of the two caps when both would otherwise bind', () => {
    // 30 messages of 500 chars each. Count cap alone -> newest 20 (10 000 chars, over budget).
    // Char budget -> floor(8000 / 500) = 16 messages fit exactly (16 * 500 = 8000).
    const turns = alternatingTurns(30, (i) => `${i}`.padStart(500, '0'));
    const result = buildHistory(turns);
    expect(result.messages).toHaveLength(16);
    expect(result.droppedCount).toBe(14);
    const totalChars = result.messages.reduce(
      (sum: number, m: { readonly content: string }) => sum + m.content.length,
      0,
    );
    expect(totalChars).toBeLessThanOrEqual(HISTORY_CHAR_BUDGET);
    expect(result.messages.length).toBeLessThanOrEqual(HISTORY_MAX_MESSAGES);
    expect(result.messages).toEqual(
      turns.slice(14).map(({ role, content }) => ({ role, content })),
    );
  });

  // 13.11/4 — a single message larger than the whole budget: still returned, never dropped, and
  // never sliced. The newest (here: only) message is never dropped by the caps.
  it('still returns a single message larger than the whole char budget, unsliced', () => {
    const hugeContent = 'x'.repeat(HISTORY_CHAR_BUDGET + 500);
    const turns: Turn[] = [{ role: 'user', content: hugeContent }];
    const result = buildHistory(turns);
    expect(result.messages).toEqual([{ role: 'user', content: hugeContent }]);
    expect(result.messages[0]?.content.length).toBe(hugeContent.length);
    expect(result.droppedCount).toBe(0);
  });

  // The same edge case with older messages ahead of it: the oversized newest message is still
  // kept whole, and the older messages ahead of it are dropped (they cannot fit alongside it,
  // and the newest message is never dropped/sliced to make room).
  it('keeps an oversized newest message whole and drops the older messages ahead of it', () => {
    const hugeContent = 'y'.repeat(HISTORY_CHAR_BUDGET + 500);
    const turns: Turn[] = [
      { role: 'user', content: 'older message one' },
      { role: 'assistant', content: 'older message two' },
      { role: 'user', content: hugeContent },
    ];
    const result = buildHistory(turns);
    expect(result.messages).toEqual([{ role: 'user', content: hugeContent }]);
    expect(result.droppedCount).toBe(2);
  });

  // 13.11/5 — droppedCount is exactly turns.length - messages.length, checked across every case
  // above plus a couple more combinations.
  it.each<[Turn[]]>([
    [alternatingTurns(5, (i) => `short ${i}`)],
    [alternatingTurns(25, (i) => `msg-${i}`)],
    [alternatingTurns(6, (i) => `${i}`.repeat(2000))],
    [alternatingTurns(30, (i) => `${i}`.padStart(500, '0'))],
    [[]],
    [[{ role: 'user', content: 'x'.repeat(HISTORY_CHAR_BUDGET + 500) }]],
  ])('droppedCount equals turns.length - messages.length', (turns) => {
    const result = buildHistory(turns);
    expect(result.droppedCount).toBe(turns.length - result.messages.length);
  });

  // Never emits partial messages: no returned content length should be a value that isn't one
  // of the original inputs' lengths.
  it('never slices a message: every returned content string is byte-identical to an original', () => {
    const turns = alternatingTurns(8, (i) => `content-${i}-${'z'.repeat(i * 200)}`);
    const originalContents = new Set(turns.map((t) => t.content));
    const result = buildHistory(turns);
    for (const message of result.messages) {
      expect(originalContents.has(message.content)).toBe(true);
    }
  });
});
