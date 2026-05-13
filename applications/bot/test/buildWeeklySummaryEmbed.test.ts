// TDD mode — tests written before implementation exists.
// References buildWeeklySummaryEmbed (does not yet exist in bot/src/rest/).
// These tests WILL FAIL until the developer implements buildWeeklySummaryEmbed.

import type { TeamMember } from '@sideline/domain';
import { DateTime } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildWeeklySummaryEmbed } from '~/rest/weeklySummary/buildWeeklySummaryEmbed.js';

const locale = 'en' as const;

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const MEMBER_A = '00000000-0000-0000-0000-000000000001' as TeamMember.TeamMemberId;
const MEMBER_B = '00000000-0000-0000-0000-000000000002' as TeamMember.TeamMemberId;
const MEMBER_C = '00000000-0000-0000-0000-000000000003' as TeamMember.TeamMemberId;

// Week 2026-W02: Mon 2026-01-05 – Sun 2026-01-11 Prague
const baseWeek = {
  startAt: DateTime.makeUnsafe('2026-01-04T23:00:00.000Z'),
  endAt: DateTime.makeUnsafe('2026-01-11T22:59:59.999Z'),
  isoYear: 2026,
  isoWeek: 2,
};

const baseTeamSummary = {
  totalActivities: 9,
  totalDurationMinutes: 300,
  activeMemberCount: 3,
  totalMemberCount: 5,
  topContributors: [
    {
      teamMemberId: MEMBER_B,
      displayName: 'Bob',
      totalActivities: 5,
      totalDurationMinutes: 180,
    },
    {
      teamMemberId: MEMBER_A,
      displayName: 'Alice',
      totalActivities: 3,
      totalDurationMinutes: 90,
    },
    {
      teamMemberId: MEMBER_C,
      displayName: 'Carol',
      totalActivities: 1,
      totalDurationMinutes: 30,
    },
  ],
  newAchievementsCount: 2,
  previousWeekActivities: 7,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildWeeklySummaryEmbed', () => {
  it('embed title contains the week date range', () => {
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: baseTeamSummary,
      locale,
    });

    expect(embeds).toHaveLength(1);
    const title = embeds[0].title ?? '';
    // Title should mention the week number or date range
    expect(title).toMatch(/2026|W02|Jan/i);
  });

  it('embed renders top contributors as a numbered list', () => {
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: baseTeamSummary,
      locale,
    });

    const fields = embeds[0].fields ?? [];
    // There should be a field for contributors
    const contributorField = fields.find(
      (f: { name: string; value: string; inline?: boolean }) =>
        f.value.includes('Bob') ||
        f.value.includes('Alice') ||
        f.value.includes('1.') ||
        f.value.includes('2.'),
    );
    expect(contributorField).toBeDefined();

    // Bob (most activities) should appear before Alice
    const value = contributorField?.value ?? '';
    const bobIdx = value.indexOf('Bob');
    const aliceIdx = value.indexOf('Alice');
    expect(bobIdx).toBeGreaterThanOrEqual(0);
    expect(aliceIdx).toBeGreaterThanOrEqual(0);
    expect(bobIdx).toBeLessThan(aliceIdx);
  });

  it('embed handles zero active members gracefully with a motivational message', () => {
    const emptyTeam = {
      ...baseTeamSummary,
      totalActivities: 0,
      activeMemberCount: 0,
      topContributors: [],
      newAchievementsCount: 0,
    };

    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: emptyTeam,
      locale,
    });

    const embedText = JSON.stringify(embeds);
    // Should contain a fallback / motivational message (not crash or show empty list)
    expect(embedText.length).toBeGreaterThan(10);
    // The embed should not contain undefined values
    expect(embedText).not.toContain('undefined');
  });

  it('embed truncates contributors list at top 3', () => {
    const teamSummaryWith4 = {
      ...baseTeamSummary,
      topContributors: [
        ...baseTeamSummary.topContributors,
        {
          teamMemberId: '00000000-0000-0000-0000-000000000004' as TeamMember.TeamMemberId,
          displayName: 'Dave',
          totalActivities: 0,
          totalDurationMinutes: 0,
        },
      ],
    };

    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: teamSummaryWith4,
      locale,
    });

    const fields = embeds[0].fields ?? [];
    const embedText = JSON.stringify(fields);
    // Dave (4th) should NOT appear in the embed
    expect(embedText).not.toContain('Dave');
    // But the top 3 should appear
    expect(embedText).toContain('Bob');
    expect(embedText).toContain('Alice');
    expect(embedText).toContain('Carol');
  });

  it('embed shows positive week-over-week delta when this week > last week', () => {
    // This week: 9, last week: 7 → +2
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: { ...baseTeamSummary, previousWeekActivities: 7 },
      locale,
    });

    const embedText = JSON.stringify(embeds);
    // Positive delta: +2 or ↑2 or ▲2
    expect(embedText).toMatch(/\+2|↑2|▲2/);
  });

  it('embed shows negative week-over-week delta when this week < last week', () => {
    // This week: 3, last week: 7 → -4
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: {
        ...baseTeamSummary,
        totalActivities: 3,
        previousWeekActivities: 7,
      },
      locale,
    });

    const embedText = JSON.stringify(embeds);
    // Negative delta: -4 or ↓4 or ▼4
    expect(embedText).toMatch(/-4|↓4|▼4/);
  });

  it('embed shows zero delta when this week equals last week', () => {
    // This week: 7, last week: 7 → 0
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: {
        ...baseTeamSummary,
        totalActivities: 7,
        previousWeekActivities: 7,
      },
      locale,
    });

    const embedText = JSON.stringify(embeds);
    // Zero delta: 0, ±0, or no change marker
    expect(embedText).toMatch(/\+0|0|±0|same|no change/i);
  });

  it('embed has non-empty description or fields', () => {
    const { embeds } = buildWeeklySummaryEmbed({
      week: baseWeek,
      teamSummary: baseTeamSummary,
      locale,
    });

    const embed = embeds[0];
    const hasContent =
      (embed.description !== undefined && embed.description.length > 0) ||
      (embed.fields !== undefined && embed.fields.length > 0);

    expect(hasContent).toBe(true);
  });
});
