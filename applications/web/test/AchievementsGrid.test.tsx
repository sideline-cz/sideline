// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference AchievementsGrid at ~/components/organisms/AchievementsGrid.js
// which does NOT yet exist. Tests will FAIL until the developer implements the component.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      achievement_first_activity_title: 'First Activity',
      achievement_ten_activities_title: 'Ten Activities',
      achievement_fifty_activities_title: 'Fifty Activities',
      achievement_hundred_activities_title: 'Hundred Activities',
      achievement_streak_3_title: 'Streak 3',
      achievement_streak_7_title: 'Streak 7',
      achievement_streak_30_title: 'Streak 30',
      achievement_duration_600_title: '600 Minutes',
      achievement_duration_3000_title: '3000 Minutes',
      achievement_gym_25_title: '25 Gym Sessions',
      achievement_running_25_title: '25 Runs',
      achievement_first_activity_description: 'Log your first activity',
      achievement_ten_activities_description: 'Log 10 activities',
      achievement_fifty_activities_description: 'Log 50 activities',
      achievement_hundred_activities_description: 'Log 100 activities',
      achievement_streak_3_description: '3-day streak',
      achievement_streak_7_description: '7-day streak',
      achievement_streak_30_description: '30-day streak',
      achievement_duration_600_description: '600 total minutes',
      achievement_duration_3000_description: '3000 total minutes',
      achievement_gym_25_description: '25 gym sessions',
      achievement_running_25_description: '25 running sessions',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Dynamic import — will fail until the component exists at this path
const { AchievementsGrid } = await import('~/components/organisms/AchievementsGrid.js');

type EarnedAchievement = {
  achievement_slug: string;
  earned_at: Date;
};

function renderGrid(earnedAchievements: EarnedAchievement[] = []) {
  render(<AchievementsGrid earnedAchievements={earnedAchievements} />);
}

describe('AchievementsGrid', () => {
  it('renders all 11 achievement titles', () => {
    renderGrid();
    // All achievement titles should be visible (even if not yet earned)
    expect(screen.getByText('First Activity')).not.toBeNull();
    expect(screen.getByText('Ten Activities')).not.toBeNull();
    expect(screen.getByText('Fifty Activities')).not.toBeNull();
    expect(screen.getByText('Hundred Activities')).not.toBeNull();
    expect(screen.getByText('Streak 3')).not.toBeNull();
    expect(screen.getByText('Streak 7')).not.toBeNull();
    expect(screen.getByText('Streak 30')).not.toBeNull();
    expect(screen.getByText('600 Minutes')).not.toBeNull();
    expect(screen.getByText('3000 Minutes')).not.toBeNull();
    expect(screen.getByText('25 Gym Sessions')).not.toBeNull();
    expect(screen.getByText('25 Runs')).not.toBeNull();
  });

  it('renders earned achievements with a distinct visual state (aria-label or data attribute)', () => {
    const earned: EarnedAchievement[] = [
      { achievement_slug: 'first_activity', earned_at: new Date('2026-01-01') },
    ];
    renderGrid(earned);

    // The earned achievement should be distinguishable — e.g. by aria-label, data-earned, or class
    const earnedElements = document.querySelectorAll(
      '[data-earned="true"], [aria-label*="earned"]',
    );
    expect(earnedElements.length).toBeGreaterThan(0);
  });

  it('renders unearned achievements without the earned indicator', () => {
    // No achievements earned
    renderGrid([]);

    const earnedElements = document.querySelectorAll('[data-earned="true"]');
    expect(earnedElements.length).toBe(0);
  });

  it('shows all 11 achievement cards', () => {
    renderGrid();
    const cards = document.querySelectorAll('[data-achievement]');
    expect(cards.length).toBe(11);
  });
});
