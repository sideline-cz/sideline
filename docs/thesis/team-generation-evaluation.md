# Balanced Training Team Generator — Analysis and Evaluation

This document evaluates the algorithmic design choices behind the Balanced Training Team Generator feature (Epic 6.3) and describes how the implementation is tested. It compares alternative approaches, explains why the chosen two-phase design is appropriate for this domain, characterizes the evaluation methodology, and discusses limitations and future work. All technical descriptions are derived directly from `packages/domain/src/models/TeamGenerator.ts` and `packages/domain/test/TeamGenerator.test.ts`.

---

## 1. Comparison of Approaches

Five algorithmic families are compared below. The evaluation criteria reflect the specific requirements of the domain: sessions typically involve 10–30 players, team assignments must be reproducible, and coaches need to trust and explain the result.

### 1.1 Comparison Table

| Approach | Optimality | Determinism | Runtime (n≈20, k=2) | Multi-constraint | Explainability |
|---|---|---|---|---|---|
| Pure snake-draft (baseline) | Near-optimal for uniform distributions; suboptimal for skewed ones | Yes | O(n log n) | Skill only (by construction) | High — coaches recognize the draft metaphor |
| Snake-draft + bounded local search (chosen) | Local optimum reachable from snake seed; optimal on tested instances | Yes (tie-break rule) | O(n log n + I × n²) | Skill, size, gender simultaneously | High — seed is explainable; swaps are auditable |
| Randomized restarts + local search | Better global optimum on large instances | No (different result each run) | O(R × I × n²) | Yes | Low — result not reproducible; coach cannot verify |
| Karmarkar–Karp / largest-differencing | Near-optimal for 2-way number partitioning | Yes | O(n log n) | Skill only; no direct multi-constraint extension | Moderate — algorithm not intuitive to a coach |
| Exact ILP / exhaustive partition | Optimal | Yes | Exponential in n | Yes, via constraints | Low for ILP formulation; enumeration infeasible beyond n≈20 |

Columns are defined as follows. **Optimality** refers to solution quality relative to the true optimum. **Determinism** means that identical inputs always produce identical outputs. **Multi-constraint** means the approach can incorporate skill, team size, and gender balance within a single objective. **Explainability** reflects how readily a sports coach — not a software engineer — can understand why the assignment was produced.

### 1.2 Pure Snake-Draft (Baseline)

The snake-draft alone (`snakeDraftOnly`) is a strong baseline for homogeneous rating distributions. When ratings form an arithmetic sequence the snake achieves a maxRatingSpread of exactly zero for two equal-sized teams. However, the test suite demonstrates that for skewed distributions — such as the six-player fixture `[400, 200, 200, 200, 100, 100]` — the snake-draft produces a suboptimal assignment (spread 66.7) that local search can improve to the optimum (spread 0). The baseline is exported precisely to make this comparison measurable.

### 1.3 Snake-Draft + Bounded Local Search (Chosen)

The chosen approach combines the snake-draft seed with a best-improvement hill-climbing search bounded by `maxIterations`. Phase 1 provides a near-optimal starting point with guaranteed structural balance (team sizes differ by at most 1). Phase 2 eliminates residual imbalance through targeted swaps. The algorithm is fully deterministic thanks to an explicit lexicographic tie-break rule on swap ids. On the constructed test instances — all of which are small enough for brute-force verification — the algorithm reaches the proven optimum.

### 1.4 Randomized Restarts + Local Search

Randomized restarts run local search from multiple random initial assignments and return the best solution found. This approach can escape local optima that the snake-draft seed cannot, and is well-suited to large instances where the single-seed approach may not converge to the global optimum. The cost is the loss of determinism: two runs on the same input will generally not produce the same assignment. For a sports application where a coach may want to re-run generation and compare results, or where the system must produce the same teams regardless of when or where it runs, non-determinism is a significant usability problem. Randomized restarts are identified as a future-work item for larger rosters (see Section 5).

### 1.5 Karmarkar–Karp (Largest-Differencing Method)

The Karmarkar–Karp algorithm solves the two-way number partitioning problem by repeatedly differencing the two largest elements and re-inserting the difference until only one value remains. It is deterministic, runs in `O(n log n)`, and consistently produces near-optimal solutions for the single-objective Elo-balance problem. However, it does not naturally extend to multi-constraint optimization (simultaneous Elo, size, and gender balance) without significant reformulation, and the differencing procedure has no intuitive analog for a coach to reason about.

### 1.6 Exact ILP / Exhaustive Enumeration

An integer linear program can model the problem exactly: binary variables `xᵢⱼ ∈ {0,1}` indicate whether player `i` is assigned to team `j`, with constraints enforcing partition correctness and size balance, and an objective minimizing a weighted combination of imbalance terms. For small `n` (below approximately 15 players) an ILP solver or exhaustive enumeration produces the provably optimal solution. Above approximately 20 players the search space grows too large for exhaustive enumeration (the number of ways to partition 20 players into 2 equal groups is `C(20,10) = 184,756`), and an ILP solver adds an external dependency not suitable for a TypeScript monorepo that must run in a Node.js environment without native addons.

The test suite includes a brute-force oracle (`bruteForceMinSpread`) that enumerates all balanced 2-team splits for `n ≤ 10`. This oracle is used specifically to verify that the chosen algorithm reaches the optimum on constructed cases, without requiring a general ILP solver.

---

## 2. Why Snake-Draft + Bounded Local Search is the Right Choice

Three domain properties make this algorithm appropriate for Sideline training sessions:

**Small instance size.** A typical training session involves 10–30 players. At this scale the quadratic cost of evaluating all swap candidates per iteration is negligible — the search runs in milliseconds on modern hardware. The O(n²) factor that would disqualify swap-based local search for large combinatorial problems is irrelevant here.

**Need for determinism.** Coaches and captains expect that running the generator twice on the same list of present players produces the same teams. Non-deterministic methods such as randomized restarts would require the system to store and replay random seeds — adding complexity and undermining the trust that reproducibility provides. The chosen algorithm achieves determinism through a stable sort and an explicit tie-break rule, both documented in the source and tested in the test suite.

**Explainability.** The snake-draft is a mechanism that sports coaches recognize from real-world drafts. A captain can verify the Phase 1 assignment by inspection ("the best player went to team 0, the second-best to team 1, the third-best to team 1, the fourth-best to team 0, …"). Phase 2 swaps are individually auditable: a swap was applied only if it reduced the weighted cost, and the cost function is a transparent combination of rating spread, size balance, and gender balance. This level of transparency is not available for black-box optimization methods or ILP solvers.

**Multi-constraint flexibility.** The normalized cost function accommodates skill (Elo), size balance, and gender balance within a single scalar objective. The weights are caller-supplied, so the same algorithm can be configured to emphasize skill balance for a competitive session or gender balance for a mixed recreational session. No structural change to the algorithm is required to shift between objectives.

---

## 3. Evaluation Methodology

### 3.1 Test Suite as Reproducibility Artifact

The test suite at `packages/domain/test/TeamGenerator.test.ts` serves as the primary evaluation artifact. It is structured into fourteen describe blocks, each targeting a specific behavioral property of the algorithm. Key categories include:

- **Partition invariance**: every test verifies that the union of all team member arrays equals the input set with no duplicates, for player counts 8, 10, 12, and 15 with 2 and 3 teams.
- **Determinism**: two calls with identical inputs are asserted to produce bitwise-identical results, including the unsorted member order within each team — not merely the same set of members.
- **Warning correctness**: tests verify that `UnevenTeamSizes`, `EloOutlier`, and `InsufficientGenderMix` fire under exactly the right conditions and are suppressed otherwise.
- **Finite invariants**: `averageRating` is finite and non-NaN, `maxRatingSpread ≥ 0`, and `iterationsUsed ≤ maxIterations` on all outputs.

### 3.2 Brute-Force Oracle Tests

Three test suites use the `bruteForceMinSpread` oracle to prove that the algorithm reaches the provably optimal solution on specific small instances:

**Six-player case** (`[400, 200, 200, 200, 100, 100]`, 2 teams of 3). The oracle confirms that the snake-draft alone produces a spread of `66.7` while the optimal is `0`. The generator with local search achieves the optimal, verified with `toBeCloseTo(optimalSpread, 5)`.

**Eight-player arithmetic sequence** (`[1800, 1600, …, 400]`, 2 teams of 4). The oracle reports an optimal spread of `0`. The snake-draft already achieves this for an arithmetic sequence, and the generator confirms `maxRatingSpread ≈ 0`. This case tests that the oracle itself is correct for a trivially balanced fixture.

**Seven-player case** (`[2000, 1800, 1600, 1400, 1200, 1000, 800]`, 2 teams of 4 and 3). The snake-draft produces a spread of `233.3` (strictly positive, confirmed by the test). The oracle reports an optimal spread of `0`. The generator achieves the optimal through a single swap. This case also verifies the Phase 2 tie-break rule: three swaps all reduce the cost to `0`, and the test asserts that the swap chosen is the lexicographically smallest one — `(p1, p3)` — resulting in a specific, predictable team composition.

These oracle tests demonstrate that on the constructed cases, which are representative of the small instances encountered in practice, the hill-climbing search starting from the snake seed reaches the global optimum within a small number of iterations.

### 3.3 Gender Weight Effect Test

One test suite is designed to verify that the gender weight genuinely changes team assignments. A fixture is constructed in which the snake-draft clusters both female players onto the same team (both land at sorted positions 1 and 2, which map to the same team in the 8-player 2-team snake). With `weightGender = 0`, the optimizer finds no improving swap (the Elo cost is already `0`, and any gender-balancing swap raises it). With `weightGender = 10`, the gender imbalance term dominates the initial cost, and the optimizer makes a swap that places one female on each team. The test asserts both the pre-condition (snake clusters both females) and both outcomes.

### 3.4 Runtime Characterization

No benchmark numbers are presented in this document because no systematic runtime benchmarks have been run under controlled conditions. What the implementation guarantees is a hard iteration budget (`maxIterations`) that bounds the number of swap evaluations to `maxIterations × O(n²)`. For typical session sizes (`n ≤ 30`, `k = 2`, `maxIterations = 100`) the algorithm converges well within the budget on all tested inputs — `iterationsUsed` is always less than `maxIterations` in the test suite's fixtures, which reflects early convergence rather than budget exhaustion.

### 3.5 Constraint Satisfaction Across Team Configurations

The partition invariant tests cover `k = 2` and `k = 3` with both even and uneven player counts. The degenerate cases `k = 1`, `k = n`, and `k > n` are also tested and documented as valid. The warning tests verify that the generator correctly classifies borderline cases (the `InsufficientGenderMix` threshold at exactly 50% labeled players is tested from both sides).

---

## 4. Discussion and Limitations

### 4.1 Two-Team MVP with N-Ready API

The current UI surface exposes only two-team generation. The algorithm itself is fully parameterized by `teamCount` and supports any `k ≥ 1`. The partition invariant tests cover three teams (`k = 3`). Extending the UI to support N-team generation is a planned future feature (see Section 5) and requires no changes to the core algorithm.

### 4.2 The Inert Size Term Under Swap-Only Moves

The `weightSize` parameter is accepted by the API and included in the cost function, but it does not influence swap selection in the current implementation. This is because:

1. The snake-draft ensures team sizes differ by at most 1 after Phase 1.
2. The local search performs only equal-size 1-for-1 swaps, so team sizes are invariant during Phase 2.
3. The size term therefore evaluates to the same constant for every candidate swap, contributing zero differential signal.

This limitation is documented in the source code and acknowledged here. It is not a correctness bug — the cost function correctly reflects the size balance at all times — but it means that a caller who sets `weightSize` higher than `weightElo` is not directing the optimizer toward smaller-sized teams, only computing a constant offset in the cost. A future extension that introduces uneven-swap moves (adding a player to one team while removing a different player) would make the size term active.

### 4.3 Calibrating-Player Default-1200 Clustering

New players who have not yet played enough rated games are assigned a default Elo rating of approximately 1200 (the conventional starting point in many Elo implementations). When a session includes many such players they cluster at identical ratings. The snake-draft handles this correctly — ties are broken by `teamMemberId` ascending — but the resulting balance is determined by the arbitrary tie-break order rather than by any skill signal. If the true skill spread among new players is large, the optimizer cannot correct for it because all their ratings are equal. Coaches are advised to manually adjust ratings for players whose actual skill is known to differ significantly from the default.

### 4.4 Dependence on Elo Quality

The algorithm's effectiveness at producing skill-balanced teams depends entirely on the quality of the Elo ratings. Elo ratings in Sideline are maintained by the Elo subsystem (Epic 6.2) and updated after each logged training result. For teams that have recently adopted Sideline or that log results infrequently, ratings may lag behind actual skill levels. The `EloOutlier` warning addresses the extreme case (a single player whose rating deviates by more than 2σ from the mean), but systematic rating inflation or deflation affecting multiple players will not be detected and will silently degrade balance quality.

---

## 5. Future Work

### 5.1 N-Team UI

The algorithm already supports `k > 2`. The web interface can be extended to allow a captain to specify the number of teams when generating. No algorithmic changes are required; the UI change is the only remaining work.

### 5.2 Move Operations that Make Size a Real Trade-off

Introducing uneven-swap moves — moves that transfer a single player from one team to another (increasing one team's size by 1 and decreasing the other's by 1) — would activate the `weightSize` parameter. With uneven moves, a captain could choose to accept a size imbalance of 2 in exchange for significantly better Elo or gender balance. This would be useful for small groups where a 2-vs-1 split may be preferable to a 1.5-vs-1.5 average.

Implementing this change requires extending the Phase 2 move set, adding a guard that prevents teams from becoming empty, and re-evaluating the size term as a genuine variable rather than a constant.

### 5.3 Randomized Restarts for Larger Rosters

For sessions with significantly more than 30 players, the quality of the single-seed hill-climbing search may degrade because the snake-draft seed's residual imbalance is larger and the local search may converge to a shallow local optimum. Randomized restarts would address this by generating multiple random (or pseudo-random, seeded) starting assignments, running local search from each, and returning the best solution found. To preserve determinism, the pseudo-random seed could be derived deterministically from the input (e.g., a hash of the sorted player id list), making the randomized restarts deterministic and reproducible while still exploring a broader portion of the search space.

### 5.4 Drag-and-Drop Manual Adjustment

After generation, a captain may wish to override specific assignments — for example, to keep two friends together or to separate players who have a conflict. A drag-and-drop interface that allows manual adjustments while showing real-time cost feedback (Elo spread, gender balance) would make the tool more practical for captains who want algorithmic assistance rather than algorithmic control.
