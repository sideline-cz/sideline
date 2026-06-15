import { describe, expect, it } from '@effect/vitest';
import { Elo } from '~/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Elo constants', () => {
  it('DEFAULT_RATING is 1200', () => {
    expect(Elo.DEFAULT_RATING).toBe(1200);
  });

  it('CALIBRATION_GAMES is 10', () => {
    expect(Elo.CALIBRATION_GAMES).toBe(10);
  });

  it('K_CALIBRATION is 40', () => {
    expect(Elo.K_CALIBRATION).toBe(40);
  });

  it('K_ESTABLISHED is 20', () => {
    expect(Elo.K_ESTABLISHED).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// expectedScore
// ---------------------------------------------------------------------------

describe('Elo.expectedScore', () => {
  it('equal ratings → exactly 0.5', () => {
    expect(Elo.expectedScore(1200, 1200)).toBe(0.5);
  });

  it('symmetry: expectedScore(a,b) + expectedScore(b,a) ≈ 1 for pair (1600, 1200)', () => {
    expect(Elo.expectedScore(1600, 1200) + Elo.expectedScore(1200, 1600)).toBeCloseTo(1, 10);
  });

  it('symmetry: expectedScore(a,b) + expectedScore(b,a) ≈ 1 for pair (1000, 1800)', () => {
    expect(Elo.expectedScore(1000, 1800) + Elo.expectedScore(1800, 1000)).toBeCloseTo(1, 10);
  });

  it('symmetry: expectedScore(a,b) + expectedScore(b,a) ≈ 1 for pair (2400, 1000)', () => {
    expect(Elo.expectedScore(2400, 1000) + Elo.expectedScore(1000, 2400)).toBeCloseTo(1, 10);
  });

  it('higher-rated player is favored: expectedScore(1600, 1200) > 0.5', () => {
    expect(Elo.expectedScore(1600, 1200)).toBeGreaterThan(0.5);
  });

  it('higher-rated player score is strictly less than 1: expectedScore(1600, 1200) < 1', () => {
    expect(Elo.expectedScore(1600, 1200)).toBeLessThan(1);
  });

  it('400-point gap → expectedScore(1600, 1200) ≈ 10/11 ≈ 0.9091', () => {
    // 1 / (1 + 10^((1200-1600)/400)) = 1 / (1 + 10^(-1)) = 1 / 1.1 ≈ 0.90909...
    expect(Elo.expectedScore(1600, 1200)).toBeCloseTo(0.9091, 3);
  });

  it('400-point gap at arbitrary base R=1000: expectedScore(1400, 1000) ≈ 10/11', () => {
    expect(Elo.expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 10);
  });

  it('very large gap: expectedScore(3000, 1000) is < 1 but very close to 1', () => {
    const score = Elo.expectedScore(3000, 1000);
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(0.999);
  });

  it('very large gap reversed: expectedScore(1000, 3000) is > 0 but very close to 0', () => {
    const score = Elo.expectedScore(1000, 3000);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// kFactor
// ---------------------------------------------------------------------------

describe('Elo.kFactor', () => {
  it('kFactor(0) === 40 (calibration phase)', () => {
    expect(Elo.kFactor(0)).toBe(40);
  });

  it('kFactor(9) === 40 (still calibrating, boundary-1)', () => {
    expect(Elo.kFactor(9)).toBe(40);
  });

  it('kFactor(10) === 20 (established threshold boundary)', () => {
    expect(Elo.kFactor(10)).toBe(20);
  });

  it('kFactor(100) === 20 (well-established player)', () => {
    expect(Elo.kFactor(100)).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — helper fixtures
// ---------------------------------------------------------------------------

const makePlayer = (
  teamMemberId: string,
  rating: number,
  gamesPlayed: number,
): Elo.PlayerRatingInput => ({ teamMemberId, rating, gamesPlayed });

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — basic outcomes
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — equal teams, teamA wins', () => {
  // All players at 1200, gamesPlayed=0 → K=40, expectedScore=0.5
  // delta = round(40 * (1 - 0.5)) = round(20) = +20 for winners, -20 for losers
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1200, 0), makePlayer('a2', 1200, 0)],
    teamB: [makePlayer('b1', 1200, 0), makePlayer('b2', 1200, 0)],
    outcome: 'teamA',
  });

  it('all team A players gain +20', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(20);
    }
  });

  it('all team B players lose -20', () => {
    for (const update of result.teamB) {
      expect(update.delta).toBe(-20);
    }
  });
});

describe('Elo.computeTeamGameUpdate — equal teams, draw', () => {
  // Equal ratings + draw → actualA = actualB = 0.5, expA = expB = 0.5
  // delta = round(K * (0.5 - 0.5)) = 0 for everyone
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1200, 0), makePlayer('a2', 1200, 0)],
    teamB: [makePlayer('b1', 1200, 0), makePlayer('b2', 1200, 0)],
    outcome: 'draw',
  });

  it('all team A players have delta 0', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(0);
    }
  });

  it('all team B players have delta 0', () => {
    for (const update of result.teamB) {
      expect(update.delta).toBe(0);
    }
  });
});

describe('Elo.computeTeamGameUpdate — equal teams, teamB wins', () => {
  // Mirror of the teamA wins case
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1200, 0), makePlayer('a2', 1200, 0)],
    teamB: [makePlayer('b1', 1200, 0), makePlayer('b2', 1200, 0)],
    outcome: 'teamB',
  });

  it('all team A players lose -20', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(-20);
    }
  });

  it('all team B players gain +20', () => {
    for (const update of result.teamB) {
      expect(update.delta).toBe(20);
    }
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — near zero-sum check (rounding caveat)
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — near zero-sum (established K=20, mixed ratings)', () => {
  // Use ratings that produce integer deltas when possible, but the key property
  // is that sum of all deltas across both teams is ≈ 0 within a small rounding
  // budget (at most ±1 per player due to Math.round).
  // All gamesPlayed >= 10 so K=20 is uniform.
  const teamA = [makePlayer('a1', 1400, 20), makePlayer('a2', 1000, 30)];
  const teamB = [makePlayer('b1', 1300, 15), makePlayer('b2', 1100, 25)];

  const result = Elo.computeTeamGameUpdate({ teamA, teamB, outcome: 'teamA' });

  it('sum of all deltas is within rounding budget of ±playerCount', () => {
    // Per-player K-factor + Math.round means exact zero-sum is NOT guaranteed.
    // The rounding error per player is at most 0.5, so total error ≤ 0.5 * N.
    // With N=4 players, the sum should be within ±4 (generous but correct bound).
    const totalDelta =
      result.teamA.reduce((s, u) => s + u.delta, 0) + result.teamB.reduce((s, u) => s + u.delta, 0);
    const playerCount = teamA.length + teamB.length; // 4
    expect(Math.abs(totalDelta)).toBeLessThanOrEqual(playerCount);
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — per-player calibration K
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — calibrating vs established player same team', () => {
  // Both on team A at same rating 1200, vs team B at 1200.
  // gamesPlayed=0 → K=40; gamesPlayed=50 → K=20.
  // Expected score is 0.5 (equal ratings).
  // Calibrating delta = round(40 * (1-0.5)) = 20
  // Established delta = round(20 * (1-0.5)) = 10
  // So calibrating delta magnitude is exactly double established.
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('calibrating', 1200, 0), makePlayer('established', 1200, 50)],
    teamB: [makePlayer('b1', 1200, 20)],
    outcome: 'teamA',
  });

  const calibrating = result.teamA.find((u) => u.teamMemberId === 'calibrating')!;
  const established = result.teamA.find((u) => u.teamMemberId === 'established')!;

  it('calibrating player kFactor is 40', () => {
    expect(calibrating.kFactor).toBe(40);
  });

  it('established player kFactor is 20', () => {
    expect(established.kFactor).toBe(20);
  });

  it('calibrating player delta magnitude is exactly double established player delta', () => {
    expect(Math.abs(calibrating.delta)).toBe(Math.abs(established.delta) * 2);
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — upset and expected-win magnitudes
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — upset vs expected-win magnitudes', () => {
  // Low-rated team (avg 1000) beats high-rated team (avg 1600): large gain for underdogs.
  const upset = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('low1', 1000, 20), makePlayer('low2', 1000, 20)],
    teamB: [makePlayer('high1', 1600, 20), makePlayer('high2', 1600, 20)],
    outcome: 'teamA',
  });

  // Favored team (avg 1600) beats low-rated team (avg 1000): small gain for favorites.
  const expected = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('high1', 1600, 20), makePlayer('high2', 1600, 20)],
    teamB: [makePlayer('low1', 1000, 20), makePlayer('low2', 1000, 20)],
    outcome: 'teamA',
  });

  it('upset: underdogs gain large positive delta (> 15)', () => {
    for (const update of upset.teamA) {
      expect(update.delta).toBeGreaterThan(15);
    }
  });

  it('upset: favored team loses large negative delta (< -15)', () => {
    for (const update of upset.teamB) {
      expect(update.delta).toBeLessThan(-15);
    }
  });

  it('expected win: favorites gain small positive delta (< 5)', () => {
    for (const update of expected.teamA) {
      expect(update.delta).toBeLessThan(5);
    }
  });

  it('expected win: underdogs lose small negative delta (> -5)', () => {
    for (const update of expected.teamB) {
      expect(update.delta).toBeGreaterThan(-5);
    }
  });

  it('upset gains are strictly larger than expected-win gains', () => {
    const upsetGain = upset.teamA[0].delta;
    const expectedGain = expected.teamA[0].delta;
    expect(upsetGain).toBeGreaterThan(expectedGain);
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — team-average equivalence
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — team-average equivalence (draw)', () => {
  // team [1000,1400] has avg 1200; team [1200,1200] has avg 1200 → equal expected scores
  // With equal averages and draw → all deltas should be 0.
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1000, 20), makePlayer('a2', 1400, 20)],
    teamB: [makePlayer('b1', 1200, 20), makePlayer('b2', 1200, 20)],
    outcome: 'draw',
  });

  it('all team A deltas are 0 (equal avg ratings, draw)', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(0);
    }
  });

  it('all team B deltas are 0 (equal avg ratings, draw)', () => {
    for (const update of result.teamB) {
      expect(update.delta).toBe(0);
    }
  });
});

describe('Elo.computeTeamGameUpdate — team-average win matches single-pair expectation', () => {
  // team [1000,1400] (avg 1200) wins vs team [1200,1200] (avg 1200), K=20 for all
  // expA = 0.5, actualA = 1 → delta per player = round(20*(1-0.5)) = 10
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1000, 20), makePlayer('a2', 1400, 20)],
    teamB: [makePlayer('b1', 1200, 20), makePlayer('b2', 1200, 20)],
    outcome: 'teamA',
  });

  it('team A players each gain +10 (same as 1200-vs-1200 single pair with K=20)', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(10);
    }
  });

  it('team B players each lose -10', () => {
    for (const update of result.teamB) {
      expect(update.delta).toBe(-10);
    }
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — unequal team sizes (2 v 1)
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — unequal sizes (2 v 1)', () => {
  // Team A: two players averaging 1200; Team B: one player at 1200.
  // Averages are equal → expA = expB = 0.5.
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1000, 20), makePlayer('a2', 1400, 20)],
    teamB: [makePlayer('b1', 1200, 20)],
    outcome: 'teamA',
  });

  it('does not crash and returns correct array lengths', () => {
    expect(result.teamA).toHaveLength(2);
    expect(result.teamB).toHaveLength(1);
  });

  it('team A players each gain +10 (avg 1200 vs avg 1200, K=20, win)', () => {
    for (const update of result.teamA) {
      expect(update.delta).toBe(10);
    }
  });

  it('single team B player loses -10', () => {
    expect(result.teamB[0].delta).toBe(-10);
  });

  it('no NaN in any returned field', () => {
    for (const update of [...result.teamA, ...result.teamB]) {
      expect(Number.isNaN(update.oldRating)).toBe(false);
      expect(Number.isNaN(update.newRating)).toBe(false);
      expect(Number.isNaN(update.delta)).toBe(false);
      expect(Number.isNaN(update.kFactor)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — empty teams
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — empty teamA', () => {
  const result = Elo.computeTeamGameUpdate({
    teamA: [],
    teamB: [makePlayer('b1', 1200, 5)],
    outcome: 'teamB',
  });

  it('returns empty teamA array', () => {
    expect(result.teamA).toEqual([]);
  });

  it('returns empty teamB array when teamA is empty', () => {
    expect(result.teamB).toEqual([]);
  });

  it('no NaN in any returned field (teamA empty)', () => {
    for (const update of [...result.teamA, ...result.teamB]) {
      expect(Number.isNaN(update.oldRating)).toBe(false);
      expect(Number.isNaN(update.newRating)).toBe(false);
      expect(Number.isNaN(update.delta)).toBe(false);
      expect(Number.isNaN(update.kFactor)).toBe(false);
    }
  });
});

describe('Elo.computeTeamGameUpdate — empty teamB', () => {
  const result = Elo.computeTeamGameUpdate({
    teamA: [makePlayer('a1', 1200, 5)],
    teamB: [],
    outcome: 'teamA',
  });

  it('returns empty teamA array when teamB is empty', () => {
    expect(result.teamA).toEqual([]);
  });

  it('returns empty teamB array', () => {
    expect(result.teamB).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeTeamGameUpdate — oldRating/delta consistency invariant
// ---------------------------------------------------------------------------

describe('Elo.computeTeamGameUpdate — update field consistency invariant', () => {
  // Use a diverse scenario so we exercise various K-factors and ratings.
  const input: Elo.TeamGameInput = {
    teamA: [
      makePlayer('a1', 1500, 0), // calibrating K=40
      makePlayer('a2', 1100, 15), // established K=20
      makePlayer('a3', 1300, 9), // calibrating K=40 (boundary-1)
    ],
    teamB: [
      makePlayer('b1', 1200, 10), // established K=20 (boundary)
      makePlayer('b2', 1400, 25), // established K=20
    ],
    outcome: 'teamB',
  };

  const result = Elo.computeTeamGameUpdate(input);
  const allUpdates = [...result.teamA, ...result.teamB];

  it('newRating - oldRating === delta for every update', () => {
    for (const update of allUpdates) {
      expect(update.newRating - update.oldRating).toBe(update.delta);
    }
  });

  it('kFactor matches kFactor(player.gamesPlayed) for every team A player', () => {
    for (let i = 0; i < input.teamA.length; i++) {
      expect(result.teamA[i].kFactor).toBe(Elo.kFactor(input.teamA[i].gamesPlayed));
    }
  });

  it('kFactor matches kFactor(player.gamesPlayed) for every team B player', () => {
    for (let i = 0; i < input.teamB.length; i++) {
      expect(result.teamB[i].kFactor).toBe(Elo.kFactor(input.teamB[i].gamesPlayed));
    }
  });

  it('oldRating equals the input player rating for every update', () => {
    for (let i = 0; i < input.teamA.length; i++) {
      expect(result.teamA[i].oldRating).toBe(input.teamA[i].rating);
    }
    for (let i = 0; i < input.teamB.length; i++) {
      expect(result.teamB[i].oldRating).toBe(input.teamB[i].rating);
    }
  });

  it('teamMemberId is preserved for every update', () => {
    for (let i = 0; i < input.teamA.length; i++) {
      expect(result.teamA[i].teamMemberId).toBe(input.teamA[i].teamMemberId);
    }
    for (let i = 0; i < input.teamB.length; i++) {
      expect(result.teamB[i].teamMemberId).toBe(input.teamB[i].teamMemberId);
    }
  });
});
