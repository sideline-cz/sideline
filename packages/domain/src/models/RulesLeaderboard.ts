/**
 * Rules Trainer team leaderboard ranking — pure algorithm module (no Effect).
 *
 * Mirrors `models/Leaderboard.ts`'s `rankLeaderboard` shape deliberately, so
 * the web UI (a future slice) can reuse the same table/row components for
 * both boards. It lives in `@sideline/domain`, not `@sideline/rules`,
 * because it ranks domain DTOs (`teamMemberId`, `displayName`-adjacent
 * fields) rather than rules content — `@sideline/rules` stays free of wire
 * concerns (see `packages/rules/AGENTS.md`).
 *
 * Ranks by `strength` (decayed mastery, `@sideline/rules`'s
 * `engine/mastery.ts`) descending, then `masteredCount` descending, then an
 * explicit `teamMemberId` ascending tiebreaker — required by
 * `packages/domain/AGENTS.md`'s Pure Algorithm Module rules so the output is
 * a deterministic total order rather than dependent on input order (two
 * members who have never practised both rank identically on
 * strength/masteredCount, and without the id tiebreaker their relative
 * order would depend on array insertion order, which itself depends on
 * arbitrary SQL row order).
 *
 * Assigns `rank: index + 1` — distinct sequential ranks, matching
 * `rankLeaderboard`; ties in strength/masteredCount do NOT share a rank,
 * the id tiebreaker always produces a strict order.
 */
import type { TeamMemberId } from '~/models/TeamMember.js';
import type { UserId } from '~/models/User.js';

export interface RulesLeaderboardEntryInput {
  readonly teamMemberId: TeamMemberId;
  readonly userId: UserId;
  readonly username: string;
  /** Mean scenario strength in `[0, 1]`, weighted by package size — see `overallMastery`. */
  readonly strength: number;
  readonly masteredCount: number;
  readonly totalScenarios: number;
}

export interface RankedRulesLeaderboardEntry extends RulesLeaderboardEntryInput {
  readonly rank: number;
}

/**
 * Rank rules-leaderboard entries by strength desc, then masteredCount desc,
 * then teamMemberId asc (deterministic tiebreaker).
 */
export const rankRulesLeaderboard = (
  entries: ReadonlyArray<RulesLeaderboardEntryInput>,
): ReadonlyArray<RankedRulesLeaderboardEntry> => {
  const sorted = [...entries].sort((a, b) => {
    if (b.strength !== a.strength) return b.strength - a.strength;
    if (b.masteredCount !== a.masteredCount) return b.masteredCount - a.masteredCount;
    if (a.teamMemberId < b.teamMemberId) return -1;
    if (a.teamMemberId > b.teamMemberId) return 1;
    return 0;
  });

  return sorted.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
};
