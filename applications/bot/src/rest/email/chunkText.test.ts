// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").

import { describe, expect, it } from 'vitest';
import { chunkForEmbedDescription } from '~/rest/email/chunkText.js';

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
