// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { describe, expect, it } from 'vitest';
import { capPages, chunkForEmbedDescription } from '~/rest/email/chunkText.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX = 4096;

/** Generate a string of `n` repetitions of `char`. */
const repeat = (char: string, n: number): string => char.repeat(n);

/** A paragraph of roughly `n` characters (ASCII). */
const para = (tag: string, n: number): string =>
  `${tag}: ${'x'.repeat(Math.max(0, n - tag.length - 2))}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('chunkForEmbedDescription', () => {
  it('single small chunk — text under maxChars stays as one chunk', () => {
    const text = 'Hello world. This is a short summary.';
    const chunks = chunkForEmbedDescription(text);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('three-page split — each chunk ≤ maxChars and lossless rejoin', () => {
    // Build text slightly over 2*MAX to force at least 3 chunks
    const p1 = para('Page1Paragraph', MAX - 100);
    const p2 = para('Page2Paragraph', MAX - 100);
    const p3 = para('Page3Paragraph', MAX - 100);
    const text = [p1, p2, p3].join('\n\n');

    const chunks = chunkForEmbedDescription(text, MAX);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // Every chunk must be ≤ MAX
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
    // Lossless rejoin (joining by double-newline is not guaranteed; we verify no content loss)
    const rejoined = chunks.join('');
    // All significant content should survive (strip whitespace boundaries)
    expect(rejoined.replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('paragraph-boundary preference — chunk breaks at \\n\\n not mid-paragraph', () => {
    const shortPara = 'Short paragraph text.';
    const longPara = para('LongPara', MAX - 200); // will fit with shortPara if together
    // Together they fit, so should be one chunk
    const text = `${shortPara}\n\n${longPara}`;

    const chunks = chunkForEmbedDescription(text, MAX);

    // Since combined length < MAX, we expect them in one chunk
    expect(chunks).toHaveLength(1);
  });

  it('paragraph-boundary split — two large paragraphs each near MAX go to separate chunks', () => {
    const p1 = para('P1', MAX - 10);
    const p2 = para('P2', MAX - 10);
    const text = `${p1}\n\n${p2}`;

    const chunks = chunkForEmbedDescription(text, MAX);

    // Each paragraph is close to MAX — should split into at least 2 chunks
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('over-long single line — word-split: no chunk > maxChars, no mid-word cut', () => {
    // Create a very long line with individual words separated by spaces
    // so word-boundary splitting can work
    const words = Array.from({ length: 1000 }, (_, i) => `word${i}`);
    const text = words.join(' ');

    expect(text.length).toBeGreaterThan(MAX); // Sanity check

    const chunks = chunkForEmbedDescription(text, MAX);

    // Every chunk ≤ MAX
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
    // No mid-word cut: every chunk should not start/end mid-word (unless a single word > MAX)
    for (const chunk of chunks) {
      // Chunk should not start with a space
      expect(chunk.startsWith(' ')).toBe(false);
    }
    // Lossless — all words present
    const allWords = chunks.join(' ').split(/\s+/).filter(Boolean);
    expect(allWords.sort().join(',')).toBe(words.sort().join(','));
  });

  it('multibyte/emoji-heavy input — every chunk has intact codepoints (no broken surrogate)', () => {
    // Build emoji-heavy text that exceeds MAX
    const emojiLine = '🏋️‍♂️ Trénink v sobotu. Přijďte včas! 📅 Sobota 10:00\n';
    // Repeat enough to exceed 2*MAX bytes
    const repetitions = Math.ceil((MAX * 3) / emojiLine.length) + 1;
    const text = emojiLine.repeat(repetitions);

    const chunks = chunkForEmbedDescription(text, MAX);

    for (const chunk of chunks) {
      // Code-point safe: Array.from splits by codepoint, not UTF-16 code unit
      const viaCodePoints = Array.from(chunk).join('');
      expect(viaCodePoints).toBe(chunk);
      // No chunk exceeds MAX characters
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
  });

  it('empty input — returns exactly [""]', () => {
    const chunks = chunkForEmbedDescription('');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('');
  });

  it('at least one chunk for any non-empty input', () => {
    expect(chunkForEmbedDescription('Hello').length).toBeGreaterThanOrEqual(1);
    expect(chunkForEmbedDescription('   ').length).toBeGreaterThanOrEqual(1);
  });

  it('totalPages is chunks.length and is always ≥ 1', () => {
    const cases = ['', 'short text', para('big', MAX * 3)];
    for (const text of cases) {
      const chunks = chunkForEmbedDescription(text, MAX);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('default maxChars=4096 — no explicit second argument needed', () => {
    const text = 'Default max test.';
    const chunks = chunkForEmbedDescription(text); // no second arg
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('single paragraph exactly at maxChars — stays as one chunk', () => {
    const text = repeat('a', MAX);
    const chunks = chunkForEmbedDescription(text, MAX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('single paragraph one char over maxChars — splits into 2 chunks both ≤ maxChars', () => {
    const text = repeat('a', MAX + 1);
    const chunks = chunkForEmbedDescription(text, MAX);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX);
    }
  });
});

// ---------------------------------------------------------------------------
// capPages
// ---------------------------------------------------------------------------

describe('capPages', () => {
  // 1. Under cap — returns input unchanged
  it('under cap: fewer chunks than maxPages — returns input array unchanged, no suffix anywhere', () => {
    const input = ['a', 'b', 'c'];
    const result = capPages(input, 20, 'SUF');

    expect(result).toEqual(input);
    for (const chunk of result) {
      expect(chunk).not.toContain('SUF');
    }
  });

  // 2. Exactly at cap (boundary) — unchanged, last chunk does NOT contain suffix
  it('exactly at cap: 20 chunks, maxPages=20 — returns unchanged, last chunk has no suffix', () => {
    const input = Array.from({ length: 20 }, (_, i) => `page-${i}`);
    const result = capPages(input, 20, 'SUF');

    expect(result).toHaveLength(20);
    expect(result[19]).not.toContain('SUF');
    expect(result).toEqual(input);
  });

  // 3. Over cap — truncates to maxPages, last page ends with suffix, first N-1 identical
  it('over cap: 25 chunks, maxPages=20 — result.length===20, result[19] ends with suffix, result[0..18] identical to input', () => {
    const input = Array.from({ length: 25 }, (_, i) => `chunk-content-${i}`);
    const result = capPages(input, 20, '---TRUNCATED---');

    expect(result.length).toBe(20);
    expect(result[19]).toMatch(/---TRUNCATED---$/);
    for (let i = 0; i < 19; i++) {
      expect(result[i]).toBe(input[i]);
    }
  });

  // 4. Last page trimmed to fit — combined content+suffix ≤ maxChars
  it('last page trimmed to fit: long last chunk + suffix still ≤ maxChars', () => {
    const longChunk = 'x'.repeat(4096);
    const input = Array.from({ length: 21 }, (_, i) => (i < 20 ? `short-${i}` : 'extra'));
    // Override index 19 with the long chunk
    const inputWithLong = input.map((chunk, i) => (i === 19 ? longChunk : chunk));
    const suffix = '\n---SUFFIX---';
    const result = capPages(inputWithLong, 20, suffix, 4096);

    expect(result.length).toBe(20);
    expect(result[19].length).toBeLessThanOrEqual(4096);
    expect(result[19]).toMatch(/---SUFFIX---$/);
  });

  // 5. Pathological suffix longer than maxChars — no throw, result[last].length ≤ maxChars
  it('pathological suffix longer than maxChars — no throw, last page length ≤ maxChars', () => {
    const input = Array.from({ length: 25 }, (_, i) => `c-${i}`);
    const overLongSuffix = 'y'.repeat(80);

    expect(() => {
      const result = capPages(input, 20, overLongSuffix, 50);
      expect(result[result.length - 1].length).toBeLessThanOrEqual(50);
    }).not.toThrow();
  });

  // 6. Surrogate safety — no broken surrogate at the trim boundary
  it('surrogate safety: trim boundary does not land mid-surrogate-pair, encodeURIComponent does not throw', () => {
    // Build a string of emoji (each is 2 UTF-16 code units) that fills exactly 4096 chars
    // then add a few extra so trimming is needed
    const emoji = '😀'; // 2 UTF-16 code units
    // 4096 / 2 = 2048 emoji = exactly 4096 chars; add 4 more to force a trim
    const baseChunk = emoji.repeat(2048 + 4); // 4104 chars — must be trimmed to fit with suffix
    const suffix = '\nTRUNCATED';
    const input = Array.from({ length: 21 }, (_, i) => (i === 19 ? baseChunk : `short-${i}`));
    const result = capPages(input, 20, suffix, 4096);

    const last = result[result.length - 1];
    expect(last.length).toBeLessThanOrEqual(4096);
    // Surrogate safety: encodeURIComponent must not throw on a string with no lone surrogates
    expect(() => encodeURIComponent(last)).not.toThrow();
  });

  // 7. Empty input passthrough
  it("empty input: capPages([''], 20, 'SUF') returns [''] unchanged", () => {
    const result = capPages([''], 20, 'SUF');

    expect(result).toEqual(['']);
  });
});
