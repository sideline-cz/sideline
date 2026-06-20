# Balanced Training Team Generator — Algorithm Design

This document describes the algorithm behind the Balanced Training Team Generator feature (Epic 6.3). It covers the problem formalization, the two-phase algorithm, the normalized cost function, edge-case handling, and complexity analysis. All descriptions are derived directly from the implementation at `packages/domain/src/models/TeamGenerator.ts` and the test suite at `packages/domain/test/TeamGenerator.test.ts`.

---

## 1. Problem Formalization

Given a set of players `P = {p₁, p₂, …, pₙ}` and a desired team count `k ≥ 1` (clamped to 1 if a smaller value is supplied), the generator solves a constrained multi-way partition problem: distribute every player into `k` disjoint subsets `T₁, T₂, …, Tₖ` such that `T₁ ∪ T₂ ∪ … ∪ Tₖ = P` and `Tᵢ ∩ Tⱼ = ∅` for all `i ≠ j`. In the non-degenerate case (`n ≥ k`) every subset is non-empty; in the degenerate case (`n < k`) the surplus subsets are empty rather than rejected, and the generator emits a warning rather than failing (see Section 4).

Each player `pᵢ` carries three attributes:

- `rating`: a numeric Elo rating reflecting current skill level.
- `gender`: a categorical value in `{male, female, other, unknown}`.
- `teamMemberId`: a stable, unique string identifier.

The objective is to minimize a weighted cost function that penalizes three kinds of imbalance simultaneously:

```text
cost(T₁…Tₖ) = wElo   * f_elo(T₁…Tₖ)
             + wSize  * f_size(T₁…Tₖ)
             + wGender * f_gender(T₁…Tₖ)
```

where `wElo`, `wSize`, and `wGender` are non-negative weights supplied by the caller, and each `f_*` term is normalized to `[0, 1]` (described in Section 3).

The hard constraint is the partition property: every player must appear in exactly one team. No player may be dropped. Team sizes must differ by at most one (structural balance enforced by the seed, not a soft penalty in the current implementation).

This is a variant of the multi-way balanced number partitioning problem, which is NP-hard in general. The practical instance is small (typically 10–30 players at a training session), which makes heuristic approaches viable without resorting to exact methods.

---

## 2. The Two-Phase Algorithm

Generation proceeds in two sequential phases: a snake-draft seed (Phase 1) that builds a structurally balanced starting partition, followed by a hill-climbing local search (Phase 2) that refines the assignment by reducing the cost function.

### 2.1 Phase 1 — Snake-Draft Seeding

**Sorting.** Players are sorted by `rating` descending. Ties are broken by `teamMemberId` ascending (lexicographic string comparison). This produces a fully deterministic total order without requiring any randomness.

**Distribution.** Players are assigned to teams in a snake-draft pattern. The pick order for a draft with `k` teams is:

```text
Round 0 (forward):  team 0, team 1, …, team k-1
Round 1 (backward): team k-1, …, team 1, team 0
Round 2 (forward):  team 0, team 1, …, team k-1
…
```

For player at position `i` (zero-indexed) in the sorted array:

```text
round = floor(i / k)
pos   = i mod k
teamIndex = (round mod 2 == 0) ? pos : (k - 1 - pos)
```

**Why snake-draft is a strong start.** The snake pattern is the classical approach to multi-team drafts because it counteracts the cumulative advantage of picking first. By reversing direction on each round, each team receives players from symmetric positions in the rating-ordered list. For an arithmetic sequence of ratings — the idealized case — snake-draft achieves a maxRatingSpread of exactly zero with two teams of equal size. More generally, it guarantees that team sizes differ by at most one regardless of player count, because each round assigns exactly one player to each team (except possibly the last incomplete round).

**Size guarantee.** If `n mod k ≠ 0`, some teams receive `ceil(n/k)` players and others receive `floor(n/k)` players. The snake pattern ensures the larger teams are the ones that pick earliest in the final incomplete round, spreading the extra slots evenly rather than concentrating them. The maximum size difference between any two teams is therefore always at most 1.

**Determinism.** Because both the sort order and the assignment formula are deterministic functions of the input, `snakeDraftOnly` is a pure function: the same input always produces the same output. The exported `snakeDraftOnly` function is available independently for testing purposes.

### 2.2 Phase 2 — Hill-Climbing Local Search

Starting from the snake-draft seed, the generator applies a best-improvement hill-climbing search over the neighbourhood defined by single cross-team swaps.

**Move set.** A move swaps one player from team `Tᵢ` with one player from team `Tⱼ` (where `i ≠ j`). This is a 1-for-1 exchange that preserves each team's size exactly. All ordered pairs `(Tᵢ, Tⱼ)` with `i < j` are considered, and for each pair all `|Tᵢ| × |Tⱼ|` candidate swaps are evaluated.

**Evaluation.** Each candidate swap is evaluated by tentatively applying it to the mutable team state, computing the full cost, and then reverting. The revert is always performed before the next candidate is considered, so the search explores moves relative to the current (not a modified) state.

**Stopping criteria.** The search terminates when either of two conditions holds:

1. No swap reduces the cost by more than `Number.EPSILON` (a local optimum has been reached).
2. The number of completed iterations reaches `maxIterations` (a budget limit supplied by the caller).

Setting `maxIterations = 0` returns the Phase 1 result unchanged with `iterationsUsed = 0`.

**Best-improvement selection.** Within each iteration, all candidate swaps are evaluated before any swap is applied. The swap that achieves the lowest cost is selected (best-improvement, not first-improvement). If multiple swaps achieve the same lowest cost, ties are broken deterministically by the lexicographically smallest `(min(idI, idJ), max(idI, idJ))` pair, where `idI` and `idJ` are the member ids of the two players involved in the swap. The ids are captured at the moment the candidate is evaluated, never re-read from the mutable array after a revert.

**Determinism.** The tie-breaking rule over string ids is a stable total order on pairs of swaps. Because the sort in Phase 1 is also deterministic, the entire algorithm is a pure function: identical inputs produce identical outputs, including the exact member ordering within each team. The test suite verifies this property directly.

### 2.3 Public API

The module exports two functions:

```typescript
export const generateTeams = (
  players: ReadonlyArray<GeneratablePlayer>,
  constraints: GenerationConstraints,
): GenerationResult

export const snakeDraftOnly = (
  players: ReadonlyArray<GeneratablePlayer>,
  teamCount: number,
): ReadonlyArray<ReadonlyArray<string>>
```

`GeneratablePlayer` carries `teamMemberId: string`, `rating: number`, and `gender: GenderValue`. `GenerationConstraints` carries `teamCount`, `weightElo`, `weightSize`, `weightGender`, and `maxIterations`. `GenerationResult` carries the assigned `teams`, the `maxRatingSpread` between team averages, `iterationsUsed`, and an array of `warnings`.

`generateTeams` never throws. All edge cases surface as warnings (see Section 4).

---

## 3. The Normalized Cost Function

### 3.1 Formula

```text
cost = wElo    * clamp(ratingSpread / SCALE_ELO, 0, 1)
     + wSize   * sizeImbalanceTerm
     + wGender * (genderImbalance / totalLabeled)
```

where:

- `ratingSpread = max(avgRating(Tᵢ)) − min(avgRating(Tᵢ))` over all teams.
- `SCALE_ELO = 400` (exported constant).
- `sizeImbalanceTerm = max(|Tᵢ|) − min(|Tᵢ|)`, divided by a denominator clamped to 1 (so the term is at most 1 after snake-draft establishes at-most-1 size difference).
- `genderImbalance = max(labeledCount(Tᵢ)) − min(labeledCount(Tᵢ))` where `labeledCount` counts only players with gender `male`, `female`, or `other`.
- `totalLabeled` is the total number of labeled players across all teams. If `totalLabeled = 0`, the gender term is 0.

Each term is normalized to `[0, 1]`.

### 3.2 Elo Term

`ratingSpread / SCALE_ELO` expresses the average-rating spread as a fraction of the reference scale `SCALE_ELO = 400`. In the Elo system a difference of 400 points corresponds to a win probability of approximately 91% for the stronger side — a gap large enough to make competition meaningless. Normalizing by this value means a spread of 400 points maps to a term of 1.0, and the term is clamped so no spread (however large) pushes it above 1. This prevents Elo outliers from rendering the weights of the other terms insignificant.

### 3.3 Size Term

After snake-draft, teams differ by at most 1 player. The denominator is therefore clamped to 1, so the size term is either 0 (all teams equal size) or 1 (sizes differ by 1). Because the local search only performs equal-size 1-for-1 swaps, team sizes never change during Phase 2. **The size term is therefore a constant during the local search and `weightSize` does not influence swap selection in the current implementation.** The weight is accepted by the API and is reserved for future move operations — such as player insertions or removals — that would alter team sizes and require the size term to act as a real penalty.

### 3.4 Gender Term

`genderImbalance / totalLabeled` normalizes the spread in labeled-player counts by the total number of labeled players. The maximum possible imbalance is `totalLabeled` (all labeled players on one team), giving a normalized value of 1. Players with `gender = 'unknown'` are counted toward team size but excluded from the gender penalty computation, because their gender cannot inform the distribution.

### 3.5 Why Normalization Matters

Without normalization the three terms operate on incompatible scales. Elo ratings are typically in the hundreds (a spread of 50 is small but meaningful), while team-size and labeled-player-count differences are small integers (0, 1, or 2 in practice). Combining raw values would make the Elo term dominate by several orders of magnitude regardless of the weights chosen by the user. Normalization ensures that `wElo = wGender = 1` genuinely balances the two objectives equally, and that the weights can be interpreted as relative importance rather than as unit-conversion factors.

---

## 4. Edge-Case Handling

All edge cases produce warnings rather than errors. The generator always returns a valid partition covering all input players.

### 4.1 Uneven Team Sizes (`UnevenTeamSizes`)

Emitted when `players.length % teamCount ≠ 0`. The snake-draft distributes players as evenly as possible (sizes `ceil(n/k)` and `floor(n/k)`), so no player is dropped. The warning informs the caller that the resulting teams will not all be the same size.

### 4.2 Elo Outliers (`EloOutlier`)

Emitted per player whose rating deviates from the mean by more than `OUTLIER_SIGMA = 2` standard deviations. Population mean and variance are computed across all input players. Players with `stddev = 0` (all ratings identical) do not trigger outlier detection. The player is still included in the partition; the warning exists to inform a coach that one player's skill level is so atypical that balancing will be structurally difficult regardless of the algorithm.

### 4.3 Insufficient Gender Mix (`InsufficientGenderMix`)

Emitted when fewer than 50% of players have a labeled gender (`male`, `female`, or `other`). The threshold is `MIN_LABELED_GENDER_FRACTION = 0.5`. Below this threshold the gender penalty is still computed (using whatever labeled data is available), but the warning signals to the caller that the gender balance result may not be meaningful because most players' genders are unknown.

### 4.4 Too Few Players or Degenerate Team Counts

When `teamCount ≥ players.length`, some teams will be empty or contain a single player. The generator handles this correctly: the snake-draft assigns at most one player to each team in the first round and leaves remaining teams empty. `computeCost` returns 0 for a single team (`teams.length ≤ 1`). No warning is emitted for this case, as the docstring documents it as intentional degenerate-but-valid behavior.

---

## 5. Complexity Analysis

### 5.1 Phase 1 — Snake-Draft

Sorting `n` players is `O(n log n)`. The distribution loop is `O(n)`. The overall complexity of Phase 1 is `O(n log n)`.

### 5.2 Phase 2 — Hill-Climbing Local Search

Each iteration considers all ordered pairs of teams and all pairs of members within those teams. For `k` teams each of size approximately `n/k`, the number of candidate swaps per iteration is:

```text
C(k, 2) × (n/k)² = (k(k-1)/2) × (n²/k²) = n²(k-1) / (2k)
```

For `k = 2` this simplifies to `n²/4`. For larger `k` the quadratic growth in `n` dominates.

Each candidate swap requires recomputing the average rating and gender counts for two teams, which is `O(n/k)`. The cost evaluation itself is `O(k)`. The total work per iteration is therefore `O(n² / k × (n/k + k)) = O(n³/k²)` in general, though for typical values of `k` (2 or 3) and `n` (10–30) the constant factors are small and the algorithm completes in milliseconds.

The search is bounded by `maxIterations`, so the worst-case total number of swap evaluations is `maxIterations × O(n²)`. In practice the search converges in far fewer iterations than the budget because the snake-draft seed is already near-optimal for typical rating distributions.

---

## 6. Type Reference

The module exports the following types alongside the two functions described in Section 2.3:

```typescript
type GenderValue = 'male' | 'female' | 'other' | 'unknown';

interface GeneratablePlayer {
  readonly teamMemberId: string;
  readonly rating: number;
  readonly gender: GenderValue;
}

interface GenerationConstraints {
  readonly teamCount: number;
  readonly weightElo: number;
  readonly weightSize: number;
  readonly weightGender: number;
  readonly maxIterations: number;
}

interface GeneratedTeam {
  readonly index: number;
  readonly members: ReadonlyArray<string>;
  readonly averageRating: number;
  readonly genderCounts: GenderCounts;
}

interface GenerationResult {
  readonly teams: ReadonlyArray<GeneratedTeam>;
  readonly maxRatingSpread: number;
  readonly iterationsUsed: number;
  readonly warnings: ReadonlyArray<GenerationWarning>;
}

type GenerationWarning =
  | { readonly _tag: 'UnevenTeamSizes' }
  | { readonly _tag: 'InsufficientGenderMix' }
  | { readonly _tag: 'EloOutlier'; readonly teamMemberId: string };
```

`genderCounts` tracks the four gender categories per team. `maxRatingSpread` is the difference between the highest and lowest team average ratings in the final assignment. `iterationsUsed` reflects the number of hill-climbing iterations that were actually executed, which may be less than `maxIterations` if the algorithm converged early.
