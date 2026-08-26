import { describe, expect, it } from '@effect/vitest';
import { rankRulesLeaderboard } from '~/models/RulesLeaderboard.js';
import type { TeamMemberId } from '~/models/TeamMember.js';
import type { UserId } from '~/models/User.js';

describe('rankRulesLeaderboard', () => {
  it('returns empty array for empty input', () => {
    expect(rankRulesLeaderboard([])).toEqual([]);
  });

  it('ranks members by strength descending', () => {
    const entries = [
      {
        teamMemberId: 'member-1' as TeamMemberId,
        userId: 'user-1' as UserId,
        username: 'alice',
        strength: 0.4,
        masteredCount: 1,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-2' as TeamMemberId,
        userId: 'user-2' as UserId,
        username: 'bob',
        strength: 0.9,
        masteredCount: 5,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-3' as TeamMemberId,
        userId: 'user-3' as UserId,
        username: 'carol',
        strength: 0.6,
        masteredCount: 2,
        totalScenarios: 20,
      },
    ];

    const result = rankRulesLeaderboard(entries);

    expect(result.map((e) => e.username)).toEqual(['bob', 'carol', 'alice']);
    expect(result.map((e) => e.rank)).toEqual([1, 2, 3]);
  });

  it('breaks strength ties by masteredCount descending', () => {
    const entries = [
      {
        teamMemberId: 'member-1' as TeamMemberId,
        userId: 'user-1' as UserId,
        username: 'alice',
        strength: 0.5,
        masteredCount: 1,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-2' as TeamMemberId,
        userId: 'user-2' as UserId,
        username: 'bob',
        strength: 0.5,
        masteredCount: 3,
        totalScenarios: 20,
      },
    ];

    const result = rankRulesLeaderboard(entries);

    expect(result[0]?.username).toBe('bob');
    expect(result[0]?.rank).toBe(1);
    expect(result[1]?.username).toBe('alice');
    expect(result[1]?.rank).toBe(2);
  });

  it('breaks strength+masteredCount ties by teamMemberId ascending — deterministic total order', () => {
    const entries = [
      {
        teamMemberId: 'member-b' as TeamMemberId,
        userId: 'user-b' as UserId,
        username: 'bob',
        strength: 0,
        masteredCount: 0,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-a' as TeamMemberId,
        userId: 'user-a' as UserId,
        username: 'alice',
        strength: 0,
        masteredCount: 0,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-c' as TeamMemberId,
        userId: 'user-c' as UserId,
        username: 'carol',
        strength: 0,
        masteredCount: 0,
        totalScenarios: 20,
      },
    ];

    // Fed in a different (reversed) order — the tiebreaker must produce the
    // SAME result regardless of input order, proving it is a true total
    // order and not merely a stable-sort artifact of insertion order.
    const forward = rankRulesLeaderboard(entries);
    const reversed = rankRulesLeaderboard([...entries].reverse());

    expect(forward.map((e) => e.teamMemberId)).toEqual(['member-a', 'member-b', 'member-c']);
    expect(forward.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(reversed.map((e) => e.teamMemberId)).toEqual(['member-a', 'member-b', 'member-c']);
  });

  it('assigns distinct sequential ranks even when every entry ties', () => {
    const entries = [
      {
        teamMemberId: 'member-1' as TeamMemberId,
        userId: 'user-1' as UserId,
        username: 'alice',
        strength: 0.8,
        masteredCount: 4,
        totalScenarios: 20,
      },
      {
        teamMemberId: 'member-2' as TeamMemberId,
        userId: 'user-2' as UserId,
        username: 'bob',
        strength: 0.8,
        masteredCount: 4,
        totalScenarios: 20,
      },
    ];

    const result = rankRulesLeaderboard(entries);

    expect(result.map((e) => e.rank)).toEqual([1, 2]);
    // ties never share a rank — id tiebreaker always produces a strict order.
    expect(new Set(result.map((e) => e.rank)).size).toBe(2);
  });
});
