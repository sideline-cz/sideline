import { describe, expect, it } from '@effect/vitest';
import {
  type GeneratablePlayer,
  type GenerationConstraints,
  generateTeams,
  SCALE_ELO,
  snakeDraftOnly,
} from '~/models/TeamGenerator.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const makePlayer = (
  id: string,
  rating: number,
  gender: GeneratablePlayer['gender'] = 'unknown',
): GeneratablePlayer => ({ teamMemberId: id, rating, gender });

/** Default constraints used when the specific test does not care about them. */
const defaultConstraints = (overrides?: Partial<GenerationConstraints>): GenerationConstraints => ({
  teamCount: 2,
  weightElo: 1,
  weightSize: 1,
  weightGender: 0,
  maxIterations: 100,
  ...overrides,
});

/** Collect every member id from a GenerationResult, returning a sorted array. */
const allMemberIds = (result: ReturnType<typeof generateTeams>): string[] =>
  result.teams.flatMap((t) => [...t.members]).sort();

/**
 * Brute-force oracle: enumerate ALL ways to split `players` into 2 teams
 * (sizes floor(n/2) and ceil(n/2)) and return the minimum achievable maxRatingSpread.
 *
 * Only suitable for n <= 10 due to exponential enumeration.
 */
const bruteForceMinSpread = (players: ReadonlyArray<GeneratablePlayer>): number => {
  const n = players.length;
  const k = Math.floor(n / 2); // size of team 0; team 1 gets n-k players

  const ratings = players.map((p) => p.rating);
  const indices = Array.from({ length: n }, (_, i) => i);

  /** Enumerate all k-subsets of arr. */
  function combos(arr: number[], size: number): number[][] {
    if (size === 0) return [[]];
    if (arr.length < size) return [];
    const first = arr[0];
    if (first === undefined) return [];
    const rest = arr.slice(1);
    return [...combos(rest, size - 1).map((c) => [first, ...c]), ...combos(rest, size)];
  }

  let best = Infinity;
  for (const t0idx of combos(indices, k)) {
    const t1idx = indices.filter((i) => !t0idx.includes(i));
    const avg0 = t0idx.reduce((s, i) => s + (ratings[i] ?? 0), 0) / t0idx.length;
    const avg1 = t1idx.reduce((s, i) => s + (ratings[i] ?? 0), 0) / t1idx.length;
    const spread = Math.abs(avg0 - avg1);
    if (spread < best) best = spread;
  }
  return best;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('TeamGenerator — constants', () => {
  it('SCALE_ELO is 400', () => {
    expect(SCALE_ELO).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 1. Even split, equal ratings — 8 players all 1200 → two teams of 4, maxRatingSpread === 0
// ---------------------------------------------------------------------------

describe('TeamGenerator — even split equal ratings', () => {
  const players = [
    makePlayer('p1', 1200),
    makePlayer('p2', 1200),
    makePlayer('p3', 1200),
    makePlayer('p4', 1200),
    makePlayer('p5', 1200),
    makePlayer('p6', 1200),
    makePlayer('p7', 1200),
    makePlayer('p8', 1200),
  ];
  const result = generateTeams(players, defaultConstraints());

  it('produces exactly 2 teams', () => {
    expect(result.teams).toHaveLength(2);
  });

  it('each team has exactly 4 members', () => {
    for (const team of result.teams) {
      expect(team.members).toHaveLength(4);
    }
  });

  it('maxRatingSpread is 0', () => {
    expect(result.maxRatingSpread).toBe(0);
  });

  it('each team averageRating is exactly 1200', () => {
    for (const team of result.teams) {
      expect(team.averageRating).toBe(1200);
    }
  });

  it('no EloOutlier or UnevenTeamSizes warnings emitted', () => {
    // All ratings equal → no outlier; 8 players / 2 teams → no uneven sizes.
    // All players have gender=unknown → InsufficientGenderMix MAY be present (0/8 labeled < 0.5),
    // but no other warnings should appear.
    const unexpectedWarnings = result.warnings.filter((w) => w._tag !== 'InsufficientGenderMix');
    expect(unexpectedWarnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Snake-draft balance — spread ratings, 2 teams of 4 each
// ---------------------------------------------------------------------------

describe('TeamGenerator — snake-draft balance', () => {
  // Descending ratings so snake-draft distributes them evenly
  const players = [
    makePlayer('p1', 1600),
    makePlayer('p2', 1500),
    makePlayer('p3', 1400),
    makePlayer('p4', 1300),
    makePlayer('p5', 1200),
    makePlayer('p6', 1100),
    makePlayer('p7', 1000),
    makePlayer('p8', 900),
  ];
  const result = generateTeams(players, defaultConstraints());

  it('produces exactly 2 teams', () => {
    expect(result.teams).toHaveLength(2);
  });

  it('each team has exactly 4 members', () => {
    for (const team of result.teams) {
      expect(team.members).toHaveLength(4);
    }
  });

  it('maxRatingSpread is within a tight bound (< 50)', () => {
    // Snake-draft + hill climbing should bring this very close to 0
    // Arithmetic: snake gives [1600,1300,1200,900] avg=1250 and [1500,1400,1100,1000] avg=1250
    // → spread is 0 after snake-draft alone
    expect(result.maxRatingSpread).toBeLessThan(50);
  });

  it('no UnevenTeamSizes warning', () => {
    const hasOdd = result.warnings.some((w) => w._tag === 'UnevenTeamSizes');
    expect(hasOdd).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Local search beats baseline — brute-force oracle + strict improvement tests
// ---------------------------------------------------------------------------

describe('TeamGenerator — local search matches brute-force optimal (6-player case)', () => {
  // Case: [400,200,200,200,100,100] 2 teams of 3
  // Snake sort (rating desc, id asc): pa(400), pb(200), pc(200), pd(200), pe(100), pf(100)
  //   i=0→t0←pa; i=1→t1←pb; i=2→t1←pc; i=3→t0←pd; i=4→t0←pe; i=5→t1←pf
  //   t0=[pa(400),pd(200),pe(100)] avg=233.3  t1=[pb(200),pc(200),pf(100)] avg=166.7  spread=66.7
  // Brute-force optimal spread: 0  (e.g. [200,200,200] vs [400,100,100])
  // Local search must find the improving swap pd(200)<->pf(100) → spread=0
  const players = [
    makePlayer('pa', 400),
    makePlayer('pb', 200),
    makePlayer('pc', 200),
    makePlayer('pd', 200),
    makePlayer('pe', 100),
    makePlayer('pf', 100),
  ];
  const constraints = defaultConstraints({ teamCount: 2, maxIterations: 200 });

  const snakeTeams = snakeDraftOnly(players, 2);
  const playerMap = new Map(players.map((p) => [p.teamMemberId, p]));
  const snakeAvgs = snakeTeams.map((members) => {
    const total = members.reduce((s, id) => s + (playerMap.get(id)?.rating ?? 0), 0);
    return members.length === 0 ? 0 : total / members.length;
  });
  const snakeSpread = Math.max(...snakeAvgs) - Math.min(...snakeAvgs);

  const optimalSpread = bruteForceMinSpread(players);
  const result = generateTeams(players, constraints);

  it('brute-force oracle confirms snake-draft spread is strictly positive (snake is suboptimal)', () => {
    // Validates the fixture: snake must leave a gap that the optimizer can close
    expect(snakeSpread).toBeGreaterThan(0);
    expect(optimalSpread).toBeLessThan(snakeSpread);
  });

  it('generateTeams maxRatingSpread matches brute-force optimal', () => {
    expect(result.maxRatingSpread).toBeCloseTo(optimalSpread, 5);
  });

  it('generateTeams maxRatingSpread is strictly less than snakeDraftOnly spread', () => {
    expect(result.maxRatingSpread).toBeLessThan(snakeSpread);
  });

  it('snakeDraftOnly returns 2 teams', () => {
    expect(snakeTeams).toHaveLength(2);
  });
});

describe('TeamGenerator — local search matches brute-force optimal (8-player case)', () => {
  // [1800,1600,1400,1200,1000,800,600,400] 2 teams of 4
  // All arithmetic: snake-draft already gives spread=0 (this tests oracle reports 0 correctly)
  const players = Array.from({ length: 8 }, (_, i) => makePlayer(`q${i}`, 1800 - i * 200));
  const optimalSpread = bruteForceMinSpread(players);
  const result = generateTeams(players, defaultConstraints());

  it('brute-force oracle reports optimal spread of 0 for arithmetic sequence', () => {
    expect(optimalSpread).toBe(0);
  });

  it('generateTeams also achieves spread 0', () => {
    expect(result.maxRatingSpread).toBeCloseTo(0, 5);
  });
});

describe('TeamGenerator — local search strictly improves a known suboptimal snake-draft case', () => {
  // 7 players [2000,1800,1600,1400,1200,1000,800] 2 teams (4+3 split)
  // Snake: t0=[p1(2000),p4(1400),p5(1200)] avg=1533.3  t1=[p2(1800),p3(1600),p6(1000),p7(800)] avg=1300
  // spread=233.3  (strictly positive)
  // Three swaps all give spread=0: (p1,p3), (p4,p6), (p5,p7) — see tie-break tests below
  // Brute-force optimal: 0 (e.g. t0=[2000,1800,1000,800] t1=[1600,1400,1200])
  const players = [
    makePlayer('p1', 2000),
    makePlayer('p2', 1800),
    makePlayer('p3', 1600),
    makePlayer('p4', 1400),
    makePlayer('p5', 1200),
    makePlayer('p6', 1000),
    makePlayer('p7', 800),
  ];
  const constraints = defaultConstraints({ teamCount: 2, maxIterations: 200 });

  const snakeTeams = snakeDraftOnly(players, 2);
  const playerMap7 = new Map(players.map((p) => [p.teamMemberId, p]));
  const snakeAvg7 = snakeTeams.map((members) => {
    const total = members.reduce((s, id) => s + (playerMap7.get(id)?.rating ?? 0), 0);
    return members.length === 0 ? 0 : total / members.length;
  });
  const snakeSpread7 = Math.max(...snakeAvg7) - Math.min(...snakeAvg7);

  const optimalSpread7 = bruteForceMinSpread(players);
  const result7 = generateTeams(players, constraints);

  it('snake-draft spread is strictly positive for this fixture (snake is suboptimal)', () => {
    expect(snakeSpread7).toBeGreaterThan(0);
  });

  it('brute-force oracle reports optimal spread of 0', () => {
    expect(optimalSpread7).toBe(0);
  });

  it('generateTeams maxRatingSpread is strictly less than snakeDraftOnly spread', () => {
    // Local search MUST improve over the snake seed for this deliberately-suboptimal fixture
    expect(result7.maxRatingSpread).toBeLessThan(snakeSpread7);
  });

  it('generateTeams matches brute-force optimal (spread near 0)', () => {
    expect(result7.maxRatingSpread).toBeCloseTo(optimalSpread7, 5);
  });
});

// ---------------------------------------------------------------------------
// 4. Determinism — same input → identical results, including unsorted member order
// ---------------------------------------------------------------------------

describe('TeamGenerator — determinism', () => {
  const players = [
    makePlayer('alpha', 1600),
    makePlayer('beta', 1400),
    makePlayer('gamma', 1200),
    makePlayer('delta', 1000),
    makePlayer('epsilon', 1550),
    makePlayer('zeta', 1350),
    makePlayer('eta', 1150),
    makePlayer('theta', 950),
  ];
  const constraints = defaultConstraints();

  const result1 = generateTeams(players, constraints);
  const result2 = generateTeams(players, constraints);

  it('both calls return the same number of teams', () => {
    expect(result1.teams).toHaveLength(result2.teams.length);
  });

  it('team member lists are identical across two calls, including member order (full structural equality)', () => {
    // Compare the full unsorted member arrays — a pure function must return identical ordering.
    // Sorting before comparing would mask any non-determinism in member ordering.
    for (let i = 0; i < result1.teams.length; i++) {
      expect([...(result1.teams[i]?.members ?? [])]).toEqual([
        ...(result2.teams[i]?.members ?? []),
      ]);
    }
  });

  it('maxRatingSpread is identical across two calls', () => {
    expect(result1.maxRatingSpread).toBe(result2.maxRatingSpread);
  });

  it('iterationsUsed is identical across two calls', () => {
    expect(result1.iterationsUsed).toBe(result2.iterationsUsed);
  });
});

describe('TeamGenerator — determinism with rating ties: Phase 1 teamMemberId-ascending tie-break', () => {
  // All 6 players have identical rating 1200; IDs are given in reverse-alphabetical order.
  // Phase 1 (snake) sorts by (rating desc, teamMemberId asc) → alphabetical order: a,b,c,d,e,f.
  // Snake 2 teams of 3 (tc=2):
  //   i=0→t0←'a'; i=1→t1←'b'; i=2→t1←'c' (round 1, reversed); i=3→t0←'d';
  //   i=4→t0←'e'; i=5→t1←'f'
  //   t0=['a','d','e']  t1=['b','c','f']
  // With all-equal ratings, Phase 2 finds no improving swap (spread is 0 throughout).
  // Exact output is therefore fully determined by the id-ascending tie-break in Phase 1.
  // If tie-breaking used insertion order instead of id-asc, the result would differ.
  const players = [
    makePlayer('f', 1200),
    makePlayer('e', 1200),
    makePlayer('d', 1200),
    makePlayer('c', 1200),
    makePlayer('b', 1200),
    makePlayer('a', 1200),
  ];
  const result = generateTeams(players, defaultConstraints({ teamCount: 2, maxIterations: 100 }));

  it('maxRatingSpread is 0 (all equal ratings, no imbalance possible)', () => {
    expect(result.maxRatingSpread).toBe(0);
  });

  it('team 0 contains exactly the members placed there by id-ascending snake order', () => {
    // Snake: sorted ids are a,b,c,d,e,f → t0 gets positions 0,3,4 → ['a','d','e']
    expect([...(result.teams[0]?.members ?? [])].sort()).toEqual(['a', 'd', 'e']);
  });

  it('team 1 contains exactly the members placed there by id-ascending snake order', () => {
    // Snake: sorted ids are a,b,c,d,e,f → t1 gets positions 1,2,5 → ['b','c','f']
    expect([...(result.teams[1]?.members ?? [])].sort()).toEqual(['b', 'c', 'f']);
  });

  it('a second call returns the identical unsorted member arrays (pure function)', () => {
    const result2 = generateTeams(
      players,
      defaultConstraints({ teamCount: 2, maxIterations: 100 }),
    );
    for (let i = 0; i < result.teams.length; i++) {
      expect([...(result.teams[i]?.members ?? [])]).toEqual([...(result2.teams[i]?.members ?? [])]);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Partition invariant — union of all members === input set, no duplicates
// ---------------------------------------------------------------------------

describe('TeamGenerator — partition invariant', () => {
  const runPartitionCheck = (players: GeneratablePlayer[], constraints: GenerationConstraints) => {
    const result = generateTeams(players, constraints);
    const inputIds = players.map((p) => p.teamMemberId).sort();
    const outputIds = allMemberIds(result);
    expect(outputIds).toEqual(inputIds);

    // No duplicates: if sorted arrays are equal and lengths match, there are no dups
    const uniqueOutput = [...new Set(outputIds)].sort();
    expect(uniqueOutput).toEqual(outputIds);
  };

  it('8-player 2-team partition is exact', () => {
    const players = Array.from({ length: 8 }, (_, i) => makePlayer(`m${i}`, 1200 + i * 50));
    runPartitionCheck(players, defaultConstraints());
  });

  it('8-player 2-team partition is exact (variant player ids)', () => {
    const players = Array.from({ length: 8 }, (_, i) => makePlayer(`n${i}`, 1200 + i * 50));
    runPartitionCheck(players, defaultConstraints());
  });

  it('10-player 2-team partition is exact', () => {
    const players = Array.from({ length: 10 }, (_, i) => makePlayer(`q${i}`, 1000 + i * 100));
    runPartitionCheck(players, defaultConstraints());
  });

  it('12-player 3-team partition is exact', () => {
    const players = Array.from({ length: 12 }, (_, i) => makePlayer(`r${i}`, 900 + i * 80));
    runPartitionCheck(players, defaultConstraints({ teamCount: 3 }));
  });

  it('15-player 3-team partition is exact', () => {
    const players = Array.from({ length: 15 }, (_, i) => makePlayer(`s${i}`, 800 + i * 60));
    runPartitionCheck(players, defaultConstraints({ teamCount: 3 }));
  });

  it('all team indices match position in array', () => {
    const players = Array.from({ length: 8 }, (_, i) => makePlayer(`x${i}`, 1200 + i * 50));
    const result = generateTeams(players, defaultConstraints());
    for (let i = 0; i < result.teams.length; i++) {
      expect(result.teams[i]?.index).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Uneven team sizes — 7 players, 2 teams → sizes {4,3}, UnevenTeamSizes warning
// ---------------------------------------------------------------------------

describe('TeamGenerator — uneven team sizes', () => {
  const players = Array.from({ length: 7 }, (_, i) => makePlayer(`p${i}`, 1200 + i * 100));
  const result = generateTeams(players, defaultConstraints({ teamCount: 2 }));

  it('UnevenTeamSizes warning is present', () => {
    const hasWarning = result.warnings.some((w) => w._tag === 'UnevenTeamSizes');
    expect(hasWarning).toBe(true);
  });

  it('produces exactly 2 teams', () => {
    expect(result.teams).toHaveLength(2);
  });

  it('team sizes are {4, 3} (no player dropped)', () => {
    const sizes = result.teams.map((t) => t.members.length).sort((a, b) => a - b);
    expect(sizes).toEqual([3, 4]);
  });

  it('all 7 players are present in the result', () => {
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(7);
    for (const p of players) {
      expect(outputIds).toContain(p.teamMemberId);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Elo outlier — one player at 2400 among 1200s → EloOutlier warning
// ---------------------------------------------------------------------------

describe('TeamGenerator — Elo outlier warning', () => {
  const outlierPlayer = makePlayer('outlier', 2400, 'male');
  const players = [
    outlierPlayer,
    ...Array.from({ length: 7 }, (_, i) => makePlayer(`n${i}`, 1200, 'male')),
  ];
  const result = generateTeams(players, defaultConstraints());

  it('EloOutlier warning is emitted for the outlier player', () => {
    const outlierWarnings = result.warnings.filter((w) => w._tag === 'EloOutlier');
    expect(outlierWarnings.length).toBeGreaterThan(0);
    const outlierIds = outlierWarnings.map((w) => (w._tag === 'EloOutlier' ? w.teamMemberId : ''));
    expect(outlierIds).toContain('outlier');
  });

  it('result is a valid partition (no player dropped)', () => {
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(players.length);
    for (const p of players) {
      expect(outputIds).toContain(p.teamMemberId);
    }
  });

  it('returns exactly 2 teams', () => {
    expect(result.teams).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Insufficient gender mix — warning suppression vs. firing
// ---------------------------------------------------------------------------

describe('TeamGenerator — sufficient gender mix: warning suppressed (12 labeled players)', () => {
  // 11 male + 1 female = all labeled → labeledCount/total = 12/12 = 1.0 > 0.5
  // InsufficientGenderMix warning must NOT fire.
  const players = [
    makePlayer('f1', 1200, 'female'),
    ...Array.from({ length: 11 }, (_, i) => makePlayer(`m${i}`, 1200, 'male')),
  ];
  const result = generateTeams(players, defaultConstraints({ teamCount: 2 }));

  it('InsufficientGenderMix warning is NOT emitted when labeled fraction >= 0.5', () => {
    const hasGenderWarning = result.warnings.some((w) => w._tag === 'InsufficientGenderMix');
    expect(hasGenderWarning).toBe(false);
  });

  it('produces a valid partition with all 12 players', () => {
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(12);
    for (const p of players) {
      expect(outputIds).toContain(p.teamMemberId);
    }
  });

  it('produces exactly 2 teams', () => {
    expect(result.teams).toHaveLength(2);
  });

  it('genderCounts on each team sum to team size', () => {
    for (const team of result.teams) {
      const countSum =
        team.genderCounts.male +
        team.genderCounts.female +
        team.genderCounts.other +
        team.genderCounts.unknown;
      expect(countSum).toBe(team.members.length);
    }
  });
});

describe('TeamGenerator — InsufficientGenderMix fires when majority are unknown', () => {
  // 8 players — 3 labeled (male/female/other), 5 unknown → fraction 3/8 = 0.375 < 0.5
  const players = [
    makePlayer('m1', 1200, 'male'),
    makePlayer('m2', 1200, 'male'),
    makePlayer('f1', 1200, 'female'),
    ...Array.from({ length: 5 }, (_, i) => makePlayer(`u${i}`, 1200, 'unknown')),
  ];
  const result = generateTeams(players, defaultConstraints());

  it('InsufficientGenderMix warning is present when labeled fraction < 0.5', () => {
    const hasGenderWarning = result.warnings.some((w) => w._tag === 'InsufficientGenderMix');
    expect(hasGenderWarning).toBe(true);
  });

  it('still produces a valid partition', () => {
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(players.length);
  });
});

// ---------------------------------------------------------------------------
// 9. Gender weighting effect — optimizer must genuinely work
// ---------------------------------------------------------------------------

describe('TeamGenerator — gender weighting effect', () => {
  // Fixture designed so snake-draft clusters BOTH females onto the same team.
  // The females (f1, f2) have the 2nd and 3rd highest ratings (1500 and 1400), landing at
  // sorted positions 1 and 2. In an 8-player 2-team snake, positions 1 and 2 both go to t1
  // (round 0: pos1→t1; round 1: pos0→t1 reversed). All remaining players are 'unknown' gender.
  //
  // Snake (tc=2, 8 players):
  //   sorted: u1(1600,unk), f1(1500,fem), f2(1400,fem), u2(1300,unk), u3(1200,unk),
  //           u4(1100,unk), u5(1000,unk), u6(900,unk)
  //   i=0→t0←u1; i=1→t1←f1; i=2→t1←f2 (round1 reversed); i=3→t0←u2;
  //   i=4→t0←u3; i=5→t1←u4; i=6→t1←u5 (round3 reversed); i=7→t0←u6
  //   t0=[u1(1600),u2(1300),u3(1200),u6(900)]  female=0, labeled=0, avg=1250
  //   t1=[f1(1500),f2(1400),u4(1100),u5(1000)]  female=2, labeled=2, avg=1250
  //
  // The gender cost term penalises imbalance in LABELED (male+female+other) count per team.
  // With all males removed, 'labeled count' equals 'female count', so female imbalance === labeled imbalance.
  //
  // With weightGender=0:
  //   Initial cost = wElo*0 + wGender*0 = 0. Any swap raises the Elo term → optimizer stops.
  //   Females stay at (0, 2) — imbalance=2.
  //
  // With weightGender=10:
  //   Initial cost = 0 + 10*(2/2) = 10. Moving one female to t0 gives labeled=(1,1) → genderTerm=0.
  //   Best swap: u1(t0)↔f1(t1) → spread=50, cost=1*(50/400)+10*0=0.125 << 10 → MUST swap.
  //   After one more swap (u6↔u5) Elo cost reaches 0 too.
  //   Females end at (1, 1) — imbalance=0.
  const players = [
    makePlayer('u1', 1600, 'unknown'),
    makePlayer('f1', 1500, 'female'),
    makePlayer('f2', 1400, 'female'),
    makePlayer('u2', 1300, 'unknown'),
    makePlayer('u3', 1200, 'unknown'),
    makePlayer('u4', 1100, 'unknown'),
    makePlayer('u5', 1000, 'unknown'),
    makePlayer('u6', 900, 'unknown'),
  ];

  const resultNoGender = generateTeams(
    players,
    defaultConstraints({ weightGender: 0, weightElo: 1, weightSize: 1, maxIterations: 200 }),
  );
  const resultWithGender = generateTeams(
    players,
    defaultConstraints({ weightGender: 10, weightElo: 1, weightSize: 1, maxIterations: 200 }),
  );

  it('both results are valid partitions containing all 8 players', () => {
    expect(allMemberIds(resultNoGender)).toHaveLength(players.length);
    expect(allMemberIds(resultWithGender)).toHaveLength(players.length);
  });

  it('snake-draft clusters both females on the same team (pre-condition for the fixture)', () => {
    // Verify the fixture actually creates a female-imbalanced starting point.
    const snakeTeams = snakeDraftOnly(players, 2);
    const femaleCounts = snakeTeams.map(
      (members) => members.filter((id) => id === 'f1' || id === 'f2').length,
    );
    expect(Math.max(...femaleCounts)).toBe(2); // both females land on the same team
  });

  it('with weightGender=10, female counts are balanced 1-per-team after optimization', () => {
    // Optimizer must move one female to t0 — gender term makes it strictly cost-reducing.
    const femaleCounts = resultWithGender.teams.map((t) => t.genderCounts.female);
    const femaleImbalance = Math.max(...femaleCounts) - Math.min(...femaleCounts);
    expect(femaleImbalance).toBe(0); // optimizer achieves perfect balance
  });

  it('with weightGender=0, female counts remain imbalanced (optimizer ignores gender)', () => {
    // With no gender weight, the snake seed has Elo cost=0 (equal averages).
    // Any gender-balancing swap would introduce a non-zero Elo term → cost strictly rises.
    // The optimizer cannot improve and the imbalance is preserved.
    const femaleCounts = resultNoGender.teams.map((t) => t.genderCounts.female);
    const femaleImbalance = Math.max(...femaleCounts) - Math.min(...femaleCounts);
    expect(femaleImbalance).toBe(2); // both females remain on one team
  });

  it('gender weight strictly changes the assignment (with vs without gender weight differ)', () => {
    // The two runs produce different team compositions: weightGender=10 triggers a female swap.
    const noGenderMembers = resultNoGender.teams.map((t) => [...t.members].sort().join(','));
    const withGenderMembers = resultWithGender.teams.map((t) => [...t.members].sort().join(','));
    // At least one team must differ between the two runs.
    const assignmentsDiffer = noGenderMembers.some((m, i) => m !== withGenderMembers[i]);
    expect(assignmentsDiffer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Phase-2 tie-break determinism — equal-cost swaps resolved by (min(idI,idJ), max(idI,idJ))
// ---------------------------------------------------------------------------

describe('TeamGenerator — Phase 2 tie-break: lexicographically smallest swap id pair wins', () => {
  // 7 players [2000,1800,1600,1400,1200,1000,800] 2 teams (4+3 split).
  // Snake: t0=[p1(2000),p4(1400),p5(1200)]  t1=[p2(1800),p3(1600),p6(1000),p7(800)]
  //        avgs: t0=1533.3, t1=1300,  spread=233.3
  //
  // In iteration 1, THREE swaps all reduce the cost to 0 (spread=0):
  //   swap p1(t0) <-> p3(t1): (min,max) = (p1,p3)
  //   swap p4(t0) <-> p6(t1): (min,max) = (p4,p6)
  //   swap p5(t0) <-> p7(t1): (min,max) = (p5,p7)
  //
  // Lexicographic comparison: 'p1' < 'p4' < 'p5', so (p1,p3) wins.
  // The engine MUST apply swap p1<->p3, resulting in:
  //   t0=[p3(1600),p4(1400),p5(1200)]  avg=1400
  //   t1=[p2(1800),p1(2000),p6(1000),p7(800)]  avg=1400
  //   spread=0 → no further improvement possible.
  //
  // If tie-breaking were by any other criterion (e.g. first-found or max(idI,idJ)),
  // the resulting team membership would differ.
  const players = [
    makePlayer('p1', 2000),
    makePlayer('p2', 1800),
    makePlayer('p3', 1600),
    makePlayer('p4', 1400),
    makePlayer('p5', 1200),
    makePlayer('p6', 1000),
    makePlayer('p7', 800),
  ];
  const constraints = defaultConstraints({ teamCount: 2, maxIterations: 200 });
  const result = generateTeams(players, constraints);

  it('result achieves spread=0 (all three tied swaps lead to optimal)', () => {
    expect(result.maxRatingSpread).toBeCloseTo(0, 5);
  });

  it('team 0 contains exactly p3, p4, p5 — as determined by lex-smallest swap (p1,p3)', () => {
    // The tie-break selects swap p1<->p3 (smallest min-id p1), placing p3 into t0.
    // If tie-break were different (e.g., last-found wins), t0 would contain p5,p6,p7 or similar.
    expect([...(result.teams[0]?.members ?? [])].sort()).toEqual(['p3', 'p4', 'p5']);
  });

  it('team 1 contains exactly p1, p2, p6, p7 — the complement after applying swap (p1,p3)', () => {
    expect([...(result.teams[1]?.members ?? [])].sort()).toEqual(['p1', 'p2', 'p6', 'p7']);
  });

  it('result is deterministic: a second call produces identical unsorted member arrays', () => {
    const result2 = generateTeams(players, constraints);
    for (let i = 0; i < result.teams.length; i++) {
      expect([...(result.teams[i]?.members ?? [])]).toEqual([...(result2.teams[i]?.members ?? [])]);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. maxIterations === 0 — returns snake-draft seed unchanged
// ---------------------------------------------------------------------------

describe('TeamGenerator — maxIterations=0 returns snake-draft unchanged', () => {
  const players = [
    makePlayer('p1', 1600),
    makePlayer('p2', 1500),
    makePlayer('p3', 1400),
    makePlayer('p4', 1300),
    makePlayer('p5', 1200),
    makePlayer('p6', 1100),
    makePlayer('p7', 1000),
    makePlayer('p8', 900),
  ];
  const constraints = defaultConstraints({ maxIterations: 0 });
  const result = generateTeams(players, constraints);
  const snakeTeams = snakeDraftOnly(players, 2);

  it('iterationsUsed is 0', () => {
    expect(result.iterationsUsed).toBe(0);
  });

  it('team member sets match snakeDraftOnly exactly', () => {
    for (let i = 0; i < snakeTeams.length; i++) {
      expect([...(result.teams[i]?.members ?? [])].sort()).toEqual(
        [...(snakeTeams[i] ?? [])].sort(),
      );
    }
  });

  it('result is a valid partition', () => {
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(players.length);
  });
});

// ---------------------------------------------------------------------------
// 12. Finite invariants — averageRating is finite, maxRatingSpread >= 0, iterationsUsed <= maxIterations
// ---------------------------------------------------------------------------

describe('TeamGenerator — finite invariants', () => {
  const players = [
    makePlayer('a', 1800, 'male'),
    makePlayer('b', 1600, 'female'),
    makePlayer('c', 1400, 'male'),
    makePlayer('d', 1200, 'female'),
    makePlayer('e', 1000, 'unknown'),
    makePlayer('f', 800, 'male'),
  ];
  const constraints = defaultConstraints({ teamCount: 2, maxIterations: 50 });
  const result = generateTeams(players, constraints);

  it('every team averageRating is a finite number', () => {
    for (const team of result.teams) {
      expect(Number.isFinite(team.averageRating)).toBe(true);
    }
  });

  it('maxRatingSpread is non-negative', () => {
    expect(result.maxRatingSpread).toBeGreaterThanOrEqual(0);
  });

  it('iterationsUsed is <= maxIterations', () => {
    expect(result.iterationsUsed).toBeLessThanOrEqual(constraints.maxIterations);
  });

  it('iterationsUsed is a non-negative integer', () => {
    expect(result.iterationsUsed).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.iterationsUsed)).toBe(true);
  });

  it('no NaN in averageRating across all teams', () => {
    for (const team of result.teams) {
      expect(Number.isNaN(team.averageRating)).toBe(false);
    }
  });

  it('genderCounts are all non-negative integers on every team', () => {
    for (const team of result.teams) {
      expect(team.genderCounts.male).toBeGreaterThanOrEqual(0);
      expect(team.genderCounts.female).toBeGreaterThanOrEqual(0);
      expect(team.genderCounts.other).toBeGreaterThanOrEqual(0);
      expect(team.genderCounts.unknown).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 13. teamCount edge cases — documented behavior for teamCount >= players.length
// ---------------------------------------------------------------------------

describe('TeamGenerator — teamCount >= players.length (degenerate but valid)', () => {
  // The docstring says: "teamCount >= players.length → degenerate but valid (most teams will be empty or 1-player)"
  const players = [makePlayer('a', 1200), makePlayer('b', 1000), makePlayer('c', 800)];

  it('teamCount === players.length → one player per team, no drops', () => {
    const result = generateTeams(players, defaultConstraints({ teamCount: 3 }));
    expect(result.teams).toHaveLength(3);
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(3);
    for (const p of players) {
      expect(outputIds).toContain(p.teamMemberId);
    }
  });

  it('teamCount > players.length → some teams are empty, all players assigned', () => {
    const result = generateTeams(players, defaultConstraints({ teamCount: 5 }));
    expect(result.teams).toHaveLength(5);
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(3);
    for (const p of players) {
      expect(outputIds).toContain(p.teamMemberId);
    }
  });

  it('teamCount === players.length → averageRating of each non-empty team equals that player rating', () => {
    const result = generateTeams(players, defaultConstraints({ teamCount: 3 }));
    for (const team of result.teams) {
      if (team.members.length === 1) {
        const player = players.find((p) => p.teamMemberId === team.members[0]);
        expect(team.averageRating).toBe(player?.rating);
      }
    }
  });
});

describe('TeamGenerator — teamCount === 1 (single team, all players in one)', () => {
  // The doc says "degenerate but valid"; teamCount=1 puts every player into team 0
  const players = Array.from({ length: 6 }, (_, i) => makePlayer(`p${i}`, 1200 + i * 100));

  it('returns exactly 1 team containing all players', () => {
    const result = generateTeams(players, defaultConstraints({ teamCount: 1 }));
    expect(result.teams).toHaveLength(1);
    const outputIds = allMemberIds(result);
    expect(outputIds).toHaveLength(players.length);
  });

  it('maxRatingSpread is 0 for a single team', () => {
    const result = generateTeams(players, defaultConstraints({ teamCount: 1 }));
    expect(result.maxRatingSpread).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 14. snakeDraftOnly — direct tests of the exported helper
// ---------------------------------------------------------------------------

describe('snakeDraftOnly — basic structure', () => {
  it('returns the correct number of teams', () => {
    const players = Array.from({ length: 8 }, (_, i) => makePlayer(`p${i}`, 1200 - i * 50));
    const teams = snakeDraftOnly(players, 2);
    expect(teams).toHaveLength(2);
  });

  it('distributes all players with no drops', () => {
    const players = Array.from({ length: 8 }, (_, i) => makePlayer(`p${i}`, 1200 - i * 50));
    const teams = snakeDraftOnly(players, 2);
    const allIds = teams.flatMap((t) => [...t]).sort();
    const expected = players.map((p) => p.teamMemberId).sort();
    expect(allIds).toEqual(expected);
  });

  it('snake-draft order: first round fills teams 0→N, second round fills N-1→0', () => {
    // 4 players sorted desc: p0(1600), p1(1400), p2(1200), p3(1000) → 2 teams
    // round0: t0=p0, t1=p1; round1: t1=p2, t0=p3
    const players = [
      makePlayer('p0', 1600),
      makePlayer('p1', 1400),
      makePlayer('p2', 1200),
      makePlayer('p3', 1000),
    ];
    const teams = snakeDraftOnly(players, 2);
    expect(teams[0]).toContain('p0');
    expect(teams[0]).toContain('p3');
    expect(teams[1]).toContain('p1');
    expect(teams[1]).toContain('p2');
  });

  it('is deterministic — two calls give the same result', () => {
    const players = Array.from({ length: 10 }, (_, i) => makePlayer(`x${i}`, 1000 + i * 80));
    const result1 = snakeDraftOnly(players, 2);
    const result2 = snakeDraftOnly(players, 2);
    expect(result1).toEqual(result2);
  });

  it('tie-breaking by teamMemberId ascending ensures determinism', () => {
    // Two players with identical ratings — 'a' < 'b' alphabetically so 'a' goes to team 0, 'b' to team 1
    const players = [makePlayer('b', 1200), makePlayer('a', 1200)];
    const teams = snakeDraftOnly(players, 2);
    expect(teams[0]).toContain('a');
    expect(teams[1]).toContain('b');
  });
});
