import { describe, expect, it } from 'vitest';

const { strengthPercent } = await import('~/lib/rules/strength.js');

describe('strengthPercent', () => {
  it('maps the 0..1 contract onto 0..100', () => {
    expect(strengthPercent(0)).toBe(0);
    expect(strengthPercent(0.5)).toBe(50);
    expect(strengthPercent(1)).toBe(100);
  });

  it('rounds to a whole percent', () => {
    expect(strengthPercent(0.794)).toBe(79);
    expect(strengthPercent(0.796)).toBe(80);
  });

  it('clamps out-of-contract values so a bad payload cannot break the layout', () => {
    // `strength` arrives over the wire; a value outside 0..1 would otherwise
    // render a bar wider than its track, or a negative width.
    expect(strengthPercent(1.5)).toBe(100);
    expect(strengthPercent(-0.2)).toBe(0);
  });

  it('treats non-finite input as 0 rather than rendering NaN%', () => {
    expect(strengthPercent(Number.NaN)).toBe(0);
    expect(strengthPercent(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
