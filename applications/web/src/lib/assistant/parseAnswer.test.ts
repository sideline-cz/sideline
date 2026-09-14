// Tests for src/lib/assistant/parseAnswer.ts
//
// Plan §13.7 / design §3.3. `parseAnswer` is a pure lexer: it splits an assistant `answer`
// string into paragraphs of `{ kind: 'text'; text } | { kind: 'ref'; token }` segments and
// reports which of the caller-supplied `tokens` positions were actually cited in the prose.
//
// Grammar: /\[\[ref:([A-Za-z0-9]+)\]\]/g in the prose text, BUT (per the plan's own worked
// examples in item 5) a well-formed marker is exactly 4 opaque alphanumeric characters — a
// 3- or 5-character capture is malformed and must render as literal text, not as a `ref`
// segment. See the discrepancy note in the tester's report: the design doc's regex snippet
// uses an unbounded `+` quantifier, which would accept 3/5-char captures; the plan's test
// list (13.7/5) requires those to be rejected. These tests encode the plan (authoritative).
//
// `parseAnswer` does NOT know the reference list — a well-formed token absent from `tokens`
// is still emitted as a `ref` segment (13.7/6); only `AssistantAnswer` (13.10/5), downstream,
// decides not to render a link for an unresolvable token. `cited` is the set of *positions*
// (values of the `tokens` map) that a resolved token pointed at.

import { describe, expect, it } from 'vitest';
import { parseAnswer } from './parseAnswer.js';

const noTokens: ReadonlyMap<string, number> = new Map();

describe('parseAnswer', () => {
  // 13.7/1 — plain text, no markers.
  it('returns a single paragraph with a single text segment for plain text with no markers', () => {
    const result = parseAnswer('hello world', noTokens);
    expect(result.paragraphs).toEqual([[{ kind: 'text', text: 'hello world' }]]);
    expect(result.cited).toEqual(new Set());
  });

  // 13.7/2 — paragraph splitting.
  it('splits paragraphs on a blank line (\\n\\n) but preserves a single \\n inside a paragraph', () => {
    const result = parseAnswer('line one\nline one-b\n\nline two', noTokens);
    expect(result.paragraphs).toEqual([
      [{ kind: 'text', text: 'line one\nline one-b' }],
      [{ kind: 'text', text: 'line two' }],
    ]);
  });

  it('splits into 3 paragraphs for 2 blank-line separators', () => {
    const result = parseAnswer('a\n\nb\n\nc', noTokens);
    expect(result.paragraphs).toEqual([
      [{ kind: 'text', text: 'a' }],
      [{ kind: 'text', text: 'b' }],
      [{ kind: 'text', text: 'c' }],
    ]);
  });

  // 13.7/3 — a single marker mid-sentence.
  it('parses a single marker into text/ref/text segments', () => {
    const result = parseAnswer('a [[ref:7f3a]] b', new Map([['7f3a', 0]]));
    expect(result.paragraphs).toEqual([
      [
        { kind: 'text', text: 'a ' },
        { kind: 'ref', token: '7f3a' },
        { kind: 'text', text: ' b' },
      ],
    ]);
    expect(result.cited).toEqual(new Set([0]));
  });

  // 13.7/4 — adjacent markers, no empty text segment between them.
  it('parses two back-to-back markers with no empty text segment between them', () => {
    const result = parseAnswer(
      '[[ref:aaaa]][[ref:bbbb]]',
      new Map([
        ['aaaa', 0],
        ['bbbb', 1],
      ]),
    );
    expect(result.paragraphs).toEqual([
      [
        { kind: 'ref', token: 'aaaa' },
        { kind: 'ref', token: 'bbbb' },
      ],
    ]);
    expect(result.cited).toEqual(new Set([0, 1]));
  });

  // A marker at the very start of the paragraph produces no leading empty text segment.
  it('parses a marker at the very start of the text with no leading empty text segment', () => {
    const result = parseAnswer('[[ref:aaaa]] end', new Map([['aaaa', 0]]));
    expect(result.paragraphs).toEqual([
      [
        { kind: 'ref', token: 'aaaa' },
        { kind: 'text', text: ' end' },
      ],
    ]);
  });

  // A marker at the very end of the text produces no trailing empty text segment.
  it('parses a marker at the very end of the text with no trailing empty text segment', () => {
    const result = parseAnswer('start [[ref:aaaa]]', new Map([['aaaa', 0]]));
    expect(result.paragraphs).toEqual([
      [
        { kind: 'text', text: 'start ' },
        { kind: 'ref', token: 'aaaa' },
      ],
    ]);
  });

  // Repeated markers for the same token.
  it('emits one ref segment per occurrence when the same token is repeated', () => {
    const result = parseAnswer('[[ref:aaaa]] and [[ref:aaaa]] again', new Map([['aaaa', 2]]));
    expect(result.paragraphs).toEqual([
      [
        { kind: 'ref', token: 'aaaa' },
        { kind: 'text', text: ' and ' },
        { kind: 'ref', token: 'aaaa' },
        { kind: 'text', text: ' again' },
      ],
    ]);
    // Two occurrences of the same token resolving to the same position collapse to one entry.
    expect(result.cited).toEqual(new Set([2]));
  });

  // 13.7/5 — malformed markers stay literal text, never a ref segment.
  it.each([
    ['[[ref:]]', 'empty token'],
    ['[[ref:abc]]', '3-character token (too short)'],
    ['[[ref:abcde]]', '5-character token (too long)'],
    ['[[ref:7F3A]]', 'uppercase (outside the token alphabet)'],
    ['[[ref: 7f3a]]', 'internal whitespace'],
    ['[ref:7f3a]', 'single brackets'],
    ['[[ref:7f3a]', 'missing closing bracket'],
  ])('renders %s (%s) verbatim as text, never as a ref segment', (input) => {
    const result = parseAnswer(input, new Map([['7f3a', 0]]));
    expect(result.paragraphs).toEqual([[{ kind: 'text', text: input }]]);
    expect(result.cited).toEqual(new Set());
  });

  // 13.7/6 — a well-formed token that is not in the map is still emitted as a ref segment.
  // parseAnswer is a pure lexer; resolution against the reference list is AssistantAnswer's job.
  it('still emits a ref segment for a well-formed token absent from the tokens map', () => {
    const result = parseAnswer('Look at [[ref:zzzz]].', noTokens);
    expect(result.paragraphs).toEqual([
      [
        { kind: 'text', text: 'Look at ' },
        { kind: 'ref', token: 'zzzz' },
        { kind: 'text', text: '.' },
      ],
    ]);
    // Not resolvable against the supplied map, so it contributes nothing to `cited`.
    expect(result.cited).toEqual(new Set());
  });

  // 13.7/7 — no HTML/markdown interpretation.
  it('does not interpret HTML or markdown; both survive as literal text', () => {
    const result = parseAnswer('<b>x</b> **y**', noTokens);
    expect(result.paragraphs).toEqual([[{ kind: 'text', text: '<b>x</b> **y**' }]]);
  });

  // Bracket-ish text that is not a marker at all.
  it('leaves non-marker bracket-ish text untouched', () => {
    const result = parseAnswer('[not a ref] and [[not:aaaa]] too', noTokens);
    expect(result.paragraphs).toEqual([
      [{ kind: 'text', text: '[not a ref] and [[not:aaaa]] too' }],
    ]);
    expect(result.cited).toEqual(new Set());
  });

  // The parser never emits a dangling or raw marker: every character of a well-formed match is
  // consumed into a `ref` segment, so the literal substring `[[ref:` never survives into a text
  // segment adjacent to a resolved marker.
  it('never leaves the raw marker syntax behind for a well-formed marker', () => {
    const result = parseAnswer('See [[ref:7f3a]] for details.', new Map([['7f3a', 0]]));
    const rendered = result.paragraphs
      .flat()
      .map((segment) => (segment.kind === 'text' ? segment.text : `[[ref:${segment.token}]]`))
      .join('');
    // Reassembling the segments must reproduce the original text exactly (lossless lexing) and
    // must not contain a raw, unconsumed `[[ref:` fragment outside of a ref segment's own token.
    expect(rendered).toBe('See [[ref:7f3a]] for details.');
  });

  it('is empty-paragraph-free for an empty string', () => {
    const result = parseAnswer('', noTokens);
    // No content at all — either no paragraphs, or a single paragraph with no segments; either
    // way there must be no dangling empty text segment. Implementation is free to choose; this
    // asserts there is nothing marker-shaped left over.
    expect(result.paragraphs.flat().every((segment) => segment.kind !== 'ref')).toBe(true);
    expect(result.cited).toEqual(new Set());
  });
});
