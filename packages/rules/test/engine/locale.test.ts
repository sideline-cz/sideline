/**
 * `text` — the localized-content accessor. Its own doc comment in
 * `engine/locale.ts` explains at length that `''` is a legitimate authored
 * value, so the fallback must be `!== undefined`, not `??`/`||` — nothing
 * enforced that at the test level before this file existed, which is
 * exactly the kind of thing a well-meaning "simplify this" pass would break.
 */
import { describe, expect, it } from 'vitest';

const { text } = await import('~/engine/locale.js');

describe('text', () => {
  it('returns the requested language when present', () => {
    expect(text({ en: 'hello', cs: 'ahoj' }, 'cs')).toBe('ahoj');
    expect(text({ en: 'hello', cs: 'ahoj' }, 'en')).toBe('hello');
  });

  it('an authored empty string is a legitimate value, not a fallback trigger', () => {
    expect(text({ en: 'a', cs: '' }, 'cs')).toBe('');
  });

  it('falls back to en when the requested language key is genuinely missing', () => {
    const partial = { en: 'only english' } as unknown as Record<'en' | 'cs', string>;
    expect(text(partial, 'cs')).toBe('only english');
  });
});
