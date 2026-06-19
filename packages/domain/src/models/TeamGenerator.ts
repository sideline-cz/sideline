/**
 * Balanced Training Team Generator — pure algorithm module (no Effect).
 *
 * Phase 1 — seed: players are sorted by rating descending (ties broken by teamMemberId
 * ascending) and distributed via snake-draft into N teams: round 0 goes 0→N-1, round 1
 * goes N-1→0, alternating. This guarantees the max size difference between any two teams
 * is at most 1 when player count is not divisible by teamCount. The ordering is fully
 * deterministic because ties are broken by teamMemberId ascending — a stable, explicit
 * total order that requires no randomness.
 *
 * Phase 2 — hill-climbing local search: all single cross-team swaps are evaluated; the
 * best cost-reducing swap is applied; the process repeats until no improvement is found
 * or maxIterations is reached. Ties in cost are broken deterministically: first by the
 * smaller of the two member ids (min(idI, idJ) ascending), then by the larger
 * (max(idI, idJ) ascending). The ids used for tie-breaking are captured at the moment the
 * candidate swap is evaluated — never re-read from mutable array state.
 *
 * Cost function (fully normalized so weights are comparable):
 *   cost = wElo * clamp(ratingSpread / SCALE_ELO, 0, 1)
 *        + wSize * sizeImbalanceTerm   [constant under equal-size swaps — see note below]
 *        + wGender * (genderImbalance / maxGenderImbalance)
 *
 * Size-term note: snake-draft guarantees team sizes differ by at most 1. Because the local
 * search only performs equal-size 1-for-1 swaps the size imbalance never changes during
 * Phase 2, so weightSize does not influence swap selection in the current implementation
 * (reserved for future move operations that change team sizes).
 *
 * Unknown gender is counted for size balance but excluded from the gender penalty.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GenderValue = 'male' | 'female' | 'other' | 'unknown';

export interface GeneratablePlayer {
  readonly teamMemberId: string;
  readonly rating: number;
  readonly gender: GenderValue;
}

export interface GenerationConstraints {
  readonly teamCount: number;
  readonly weightElo: number;
  readonly weightSize: number;
  readonly weightGender: number;
  readonly maxIterations: number;
}

export interface GenderCounts {
  readonly male: number;
  readonly female: number;
  readonly other: number;
  readonly unknown: number;
}

export interface GeneratedTeam {
  readonly index: number;
  readonly members: ReadonlyArray<string>;
  readonly averageRating: number;
  readonly genderCounts: GenderCounts;
}

export interface GenerationResult {
  readonly teams: ReadonlyArray<GeneratedTeam>;
  readonly maxRatingSpread: number;
  readonly iterationsUsed: number;
  readonly warnings: ReadonlyArray<GenerationWarning>;
}

export type GenerationWarning =
  | { readonly _tag: 'UnevenTeamSizes' }
  | { readonly _tag: 'InsufficientGenderMix' }
  | { readonly _tag: 'EloOutlier'; readonly teamMemberId: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Reference scale for the Elo-spread normalization term.
 * A spread of SCALE_ELO (≈ one strong K-factor swing) maps to a normalized value of 1.
 * Spreads larger than SCALE_ELO are clamped so the Elo term never exceeds 1.
 */
export const SCALE_ELO = 400;

/**
 * Minimum fraction of players whose gender is labeled (male/female/other) before the
 * generator emits an InsufficientGenderMix warning. Below this threshold the gender
 * penalty is still computed but the warning flags it as unreliable.
 */
const MIN_LABELED_GENDER_FRACTION = 0.5;

/**
 * Outlier threshold in standard deviations from the mean rating.
 * Players beyond this distance trigger an EloOutlier warning.
 */
const OUTLIER_SIGMA = 2;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute the cost of a team assignment. */
const computeCost = (
  teams: ReadonlyArray<{
    members: ReadonlyArray<string>;
    averageRating: number;
    genderCounts: GenderCounts;
  }>,
  wElo: number,
  wSize: number,
  wGender: number,
): number => {
  if (teams.length <= 1) return 0;

  // --- Elo term ---
  const ratings = teams.map((t) => t.averageRating);
  const maxRating = Math.max(...ratings);
  const minRating = Math.min(...ratings);
  const ratingSpread = maxRating - minRating;
  const eloTerm = Math.min(ratingSpread / SCALE_ELO, 1);

  // --- Size term ---
  // Snake-draft guarantees sizes differ by at most 1 (max imbalance = 1 for any N>1).
  // 1-for-1 swaps never change team sizes, so this term is constant during local search.
  // Denominator is clamped to 1 to keep the term in [0,1].
  const sizes = teams.map((t) => t.members.length);
  const maxSize = Math.max(...sizes);
  const minSize = Math.min(...sizes);
  const sizeImbalance = maxSize - minSize;
  // maxPossibleSizeImbalance after snake-draft is at most 1; clamp denominator to 1.
  const sizeTerm = teams.length <= 1 ? 0 : sizeImbalance / 1;

  // --- Gender term (labeled players only: male + female + other) ---
  const labeledByTeam = teams.map(
    (t) => t.genderCounts.male + t.genderCounts.female + t.genderCounts.other,
  );
  const totalLabeled = labeledByTeam.reduce((s, n) => s + n, 0);
  let genderTerm = 0;
  if (totalLabeled > 0) {
    const maxLabeled = Math.max(...labeledByTeam);
    const minLabeled = Math.min(...labeledByTeam);
    const genderImbalance = maxLabeled - minLabeled;
    // maxPossibleGenderImbalance = totalLabeled (all labeled players on one team)
    genderTerm = genderImbalance / totalLabeled;
  }

  return wElo * eloTerm + wSize * sizeTerm + wGender * genderTerm;
};

/** Build a GenderCounts object from the mutable intermediate object. */
const buildGenderCounts = (counts: Record<GenderValue, number>): GenderCounts => ({
  male: counts.male,
  female: counts.female,
  other: counts.other,
  unknown: counts.unknown,
});

/** Recompute mutable team state after a swap of two members between two teams. */
interface MutableTeam {
  members: string[];
  averageRating: number;
  genderCounts: Record<GenderValue, number>;
}

const recomputeTeam = (
  team: MutableTeam,
  playerMap: ReadonlyMap<string, GeneratablePlayer>,
): void => {
  // Invariant: every member id in `team.members` was inserted via playerMap, so the lookup
  // is always defined. We still guard the `undefined` case explicitly (rather than with a
  // non-null assertion, which the formatter strips) to stay type-safe and skip any stray id.
  const total = team.members.reduce((s, id) => {
    const player = playerMap.get(id);
    return player === undefined ? s : s + player.rating;
  }, 0);
  team.averageRating = team.members.length === 0 ? 0 : total / team.members.length;
  team.genderCounts = { male: 0, female: 0, other: 0, unknown: 0 };
  for (const id of team.members) {
    const player = playerMap.get(id);
    if (player !== undefined) {
      team.genderCounts[player.gender]++;
    }
  }
};

// ---------------------------------------------------------------------------
// Phase 1 — Snake-draft seed
// ---------------------------------------------------------------------------

/**
 * Deterministic total order over players: rating descending, then teamMemberId ascending.
 * Returns 0 only when both keys are equal, satisfying the comparator contract.
 */
const comparePlayers = (a: GeneratablePlayer, b: GeneratablePlayer): number => {
  if (b.rating !== a.rating) return b.rating - a.rating;
  if (a.teamMemberId < b.teamMemberId) return -1;
  if (a.teamMemberId > b.teamMemberId) return 1;
  return 0;
};

/**
 * Snake-draft only (Phase 1). Exported for testing: proves Phase 2 improves balance.
 *
 * Players are sorted by rating descending; ties are broken by teamMemberId ascending so
 * the ordering is fully deterministic without requiring randomness.
 */
export const snakeDraftOnly = (
  players: ReadonlyArray<GeneratablePlayer>,
  teamCount: number,
): ReadonlyArray<ReadonlyArray<string>> => {
  // Defensive: a teamCount < 1 would make the modulo math below divide by zero.
  const safeTeamCount = teamCount < 1 ? 1 : teamCount;
  const sorted = [...players].sort(comparePlayers);

  const teams: string[][] = Array.from({ length: safeTeamCount }, () => []);

  for (let i = 0; i < sorted.length; i++) {
    const round = Math.floor(i / safeTeamCount);
    const pos = i % safeTeamCount;
    const teamIndex = round % 2 === 0 ? pos : safeTeamCount - 1 - pos;
    const player = sorted[i];
    const team = teams[teamIndex];
    // Loop invariants guarantee teamIndex is in [0, teamCount-1] and sorted[i] is defined;
    // the explicit guards keep the access type-safe without non-null assertions.
    if (player !== undefined && team !== undefined) {
      team.push(player.teamMemberId);
    }
  }

  return teams;
};

// ---------------------------------------------------------------------------
// Edge-case detection
// ---------------------------------------------------------------------------

const detectWarnings = (
  players: ReadonlyArray<GeneratablePlayer>,
): ReadonlyArray<GenerationWarning> => {
  const warnings: GenerationWarning[] = [];

  if (players.length === 0) return warnings;

  // Elo outlier detection: mean ± OUTLIER_SIGMA * stddev
  const ratings = players.map((p) => p.rating);
  const mean = ratings.reduce((s, r) => s + r, 0) / ratings.length;
  let variance = 0;
  for (const r of ratings) variance += (r - mean) ** 2;
  variance /= ratings.length;
  const stddev = Math.sqrt(variance);

  if (stddev > 0) {
    for (const p of players) {
      if (Math.abs(p.rating - mean) > OUTLIER_SIGMA * stddev) {
        warnings.push({ _tag: 'EloOutlier', teamMemberId: p.teamMemberId });
      }
    }
  }

  // Insufficient gender mix: fewer than MIN_LABELED_GENDER_FRACTION have a labeled gender
  const labeledCount = players.filter((p) => p.gender !== 'unknown').length;
  if (labeledCount / players.length < MIN_LABELED_GENDER_FRACTION) {
    warnings.push({ _tag: 'InsufficientGenderMix' });
  }

  return warnings;
};

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate balanced teams from a list of players.
 *
 * Returns a GenerationResult with warnings but never throws. Edge cases:
 * - teamCount >= players.length → degenerate but valid (most teams will be empty or 1-player).
 * - players.length % teamCount !== 0 → UnevenTeamSizes warning.
 * - Elo outlier detected → EloOutlier warning per outlier.
 * - maxIterations === 0 → returns Phase 1 snake-draft result unchanged.
 */
export const generateTeams = (
  players: ReadonlyArray<GeneratablePlayer>,
  constraints: GenerationConstraints,
): GenerationResult => {
  const { teamCount, maxIterations } = constraints;
  // Guard against teamCount < 1, which would make the modulo/snake-draft math divide by zero.
  const safeTeamCount = teamCount < 1 ? 1 : teamCount;

  // Clamp negative weights to 0 so the optimizer cannot chase worse balance.
  const weightElo = Math.max(0, constraints.weightElo);
  const weightSize = Math.max(0, constraints.weightSize);
  const weightGender = Math.max(0, constraints.weightGender);

  // Build player lookup map
  const playerMap = new Map<string, GeneratablePlayer>();
  for (const p of players) playerMap.set(p.teamMemberId, p);

  // Collect warnings
  const warnings: GenerationWarning[] = [...detectWarnings(players)];
  // Emit UnevenTeamSizes whenever players.length % teamCount !== 0.
  if (players.length % safeTeamCount !== 0) {
    warnings.unshift({ _tag: 'UnevenTeamSizes' });
  }

  // Phase 1: snake-draft seed
  const seededMemberArrays = snakeDraftOnly(players, safeTeamCount);

  // Build mutable team state
  const mutableTeams: MutableTeam[] = seededMemberArrays.map((members) => {
    const t: MutableTeam = {
      members: [...members],
      averageRating: 0,
      genderCounts: { male: 0, female: 0, other: 0, unknown: 0 },
    };
    recomputeTeam(t, playerMap);
    return t;
  });

  // If maxIterations === 0, return the seed unchanged
  if (maxIterations === 0) {
    const teams = mutableTeams.map((t, idx) => ({
      index: idx,
      members: t.members,
      averageRating: t.averageRating,
      genderCounts: buildGenderCounts(t.genderCounts),
    }));
    return {
      teams,
      maxRatingSpread: computeMaxRatingSpread(teams),
      iterationsUsed: 0,
      warnings,
    };
  }

  // Phase 2: hill-climbing local search
  let iterationsUsed = 0;
  let improved = true;

  while (improved && iterationsUsed < maxIterations) {
    improved = false;
    const currentCost = computeCost(mutableTeams, weightElo, weightSize, weightGender);

    let bestCost = currentCost;
    // Store idI/idJ alongside the position indices so tie-breaking never re-reads
    // mutable array state (which may have been reverted since the candidate was chosen).
    let bestSwap: {
      ti: number;
      tj: number;
      mi: number;
      mj: number;
      idI: string;
      idJ: string;
    } | null = null;

    // Evaluate all single cross-team swaps
    for (let ti = 0; ti < mutableTeams.length; ti++) {
      for (let tj = ti + 1; tj < mutableTeams.length; tj++) {
        const teamI = mutableTeams[ti];
        const teamJ = mutableTeams[tj];
        // ti and tj are loop-bounded, so both teams are always defined; guard explicitly
        // (rather than with `!`) to stay type-safe and survive formatter normalization.
        if (teamI === undefined || teamJ === undefined) continue;

        for (let mi = 0; mi < teamI.members.length; mi++) {
          for (let mj = 0; mj < teamJ.members.length; mj++) {
            // Tentatively apply swap
            const idI = teamI.members[mi];
            const idJ = teamJ.members[mj];
            if (idI === undefined || idJ === undefined) continue;

            teamI.members[mi] = idJ;
            teamJ.members[mj] = idI;
            recomputeTeam(teamI, playerMap);
            recomputeTeam(teamJ, playerMap);

            const swapCost = computeCost(mutableTeams, weightElo, weightSize, weightGender);

            // Revert
            teamI.members[mi] = idI;
            teamJ.members[mj] = idJ;
            recomputeTeam(teamI, playerMap);
            recomputeTeam(teamJ, playerMap);

            if (swapCost < bestCost - Number.EPSILON) {
              bestCost = swapCost;
              bestSwap = { ti, tj, mi, mj, idI, idJ };
            } else if (Math.abs(swapCost - bestCost) <= Number.EPSILON && bestSwap !== null) {
              // Tie-break contract: prefer the swap whose (min(idI,idJ), max(idI,idJ)) pair
              // is lexicographically smaller. Ids are captured at evaluation time, never
              // re-read from the (potentially reverted) mutable arrays.
              const bestMin = bestSwap.idI < bestSwap.idJ ? bestSwap.idI : bestSwap.idJ;
              const bestMax = bestSwap.idI < bestSwap.idJ ? bestSwap.idJ : bestSwap.idI;
              const newMin = idI < idJ ? idI : idJ;
              const newMax = idI < idJ ? idJ : idI;
              if (newMin < bestMin || (newMin === bestMin && newMax < bestMax)) {
                bestSwap = { ti, tj, mi, mj, idI, idJ };
              }
            }
          }
        }
      }
    }

    if (bestSwap !== null && bestCost < currentCost - Number.EPSILON) {
      const { ti, tj, mi, mj } = bestSwap;
      // Invariant: ti/tj/mi/mj were valid indices when the swap was recorded; guard
      // explicitly to stay type-safe without non-null assertions.
      const teamI = mutableTeams[ti];
      const teamJ = mutableTeams[tj];
      const idI = teamI?.members[mi];
      const idJ = teamJ?.members[mj];
      if (teamI !== undefined && teamJ !== undefined && idI !== undefined && idJ !== undefined) {
        teamI.members[mi] = idJ;
        teamJ.members[mj] = idI;
        recomputeTeam(teamI, playerMap);
        recomputeTeam(teamJ, playerMap);
        improved = true;
      }
    }

    iterationsUsed++;
  }

  const teams = mutableTeams.map((t, idx) => ({
    index: idx,
    members: t.members,
    averageRating: t.averageRating,
    genderCounts: buildGenderCounts(t.genderCounts),
  }));

  return {
    teams,
    maxRatingSpread: computeMaxRatingSpread(teams),
    iterationsUsed,
    warnings,
  };
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

const computeMaxRatingSpread = (teams: ReadonlyArray<{ averageRating: number }>): number => {
  if (teams.length === 0) return 0;
  const ratings = teams.map((t) => t.averageRating);
  return Math.max(...ratings) - Math.min(...ratings);
};
