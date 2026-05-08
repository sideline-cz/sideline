import { Option } from 'effect';

/**
 * Compare a before-snapshot of invite usage counts against a fresh list from
 * the Discord API and return the single invite code that was used, or None if
 * the winner is ambiguous (0 or >1 candidates) or if no baseline exists yet.
 */
export const inviteDiff = (
  before: ReadonlyMap<string, number>,
  after: ReadonlyArray<{ readonly code: string; readonly uses: number }>,
): Option.Option<string> => {
  // Lazy-seed: no baseline means we cannot determine which invite was used.
  if (before.size === 0) return Option.none();

  const candidates: string[] = [];

  // Check each entry in `after` that was known before — if its uses count
  // increased vs the snapshot, it is a candidate.
  for (const { code, uses } of after) {
    const prev = before.get(code);
    // Only consider codes we had in baseline; ignore brand-new codes in `after`.
    if (prev !== undefined && uses > prev) {
      candidates.push(code);
    }
  }

  return candidates.length === 1 ? Option.some(candidates[0]) : Option.none();
};
