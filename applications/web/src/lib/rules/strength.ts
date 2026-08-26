/**
 * The one place mastery strength becomes a percentage.
 *
 * `strength` is `0..1` by contract (`packages/rules/src/engine/mastery.ts`),
 * and two surfaces render it — the personal progress panel and the team
 * leaderboard. They were briefly computing it independently with the same
 * expression, which is precisely how the same player ends up shown as 79% in
 * one place and 80% in the other after somebody "tidies" one of the two.
 *
 * The clamp is not defensive noise: `strength` arrives over the wire, and a
 * value outside `0..1` would otherwise render a bar wider than its track or a
 * negative width. Clamping keeps a malformed payload a wrong number rather
 * than a broken layout.
 */
export function strengthPercent(strength: number): number {
  if (!Number.isFinite(strength)) return 0;
  return Math.max(0, Math.min(100, Math.round(strength * 100)));
}
