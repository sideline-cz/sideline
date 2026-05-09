import { describe, expect, it } from 'vitest';
import { DISCORD_BLURPLE, sanitizeHexColor } from '../src/color.js';

describe('sanitizeHexColor', () => {
  it('valid #5865f2 → 0x5865f2', () => {
    expect(sanitizeHexColor('#5865f2')).toBe(0x5865f2);
  });

  it('valid uppercase #FF00AA → 0xff00aa', () => {
    expect(sanitizeHexColor('#FF00AA')).toBe(0xff00aa);
  });

  it('invalid 5865f2 (no #) → DISCORD_BLURPLE', () => {
    expect(sanitizeHexColor('5865f2')).toBe(DISCORD_BLURPLE);
  });

  it('invalid #xyz → DISCORD_BLURPLE', () => {
    expect(sanitizeHexColor('#xyz')).toBe(DISCORD_BLURPLE);
  });

  it('null → DISCORD_BLURPLE', () => {
    expect(sanitizeHexColor(null)).toBe(DISCORD_BLURPLE);
  });

  it('undefined → DISCORD_BLURPLE', () => {
    expect(sanitizeHexColor(undefined)).toBe(DISCORD_BLURPLE);
  });

  it('shorthand #fff (3 hex) → DISCORD_BLURPLE (requires 6 hex)', () => {
    expect(sanitizeHexColor('#fff')).toBe(DISCORD_BLURPLE);
  });
});
