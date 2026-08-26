// Tests for TeamRulesPage — the first caller of `getRulesLeaderboard`
// (Phase 3 step 14 of `docs/plans/rules-trainer.md`). A thin, props-only
// page wrapper (no TanStack Router imports) driven entirely by the
// already-fetched `leaderboard` prop.
import { RulesTrainerApi, TeamMember, User } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Option, Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

vi.mock('@sideline/i18n/runtime', () => ({
  getLocale: () => 'en',
}));

// The trainer organism is mounted by this page (it is the in-app home of the
// trainer, not just a link to it) but is not what these tests are about — it
// loads content packages, reads localStorage and fetches server progress, all
// of which `RulesTrainer.test.tsx` covers directly.
vi.mock('~/components/organisms/RulesTrainer.js', () => ({
  RulesTrainer: () => <div data-testid='rules-trainer' />,
}));

const { TeamRulesPage } = await import('~/components/pages/TeamRulesPage.js');

function makeEntry(
  overrides: Partial<{
    rank: number;
    teamMemberId: string;
    userId: string;
    username: string;
    displayName: string;
    strength: number;
    masteredCount: number;
    totalScenarios: number;
  }> = {},
): RulesTrainerApi.RulesLeaderboardEntry {
  return new RulesTrainerApi.RulesLeaderboardEntry({
    rank: overrides.rank ?? 1,
    teamMemberId: Schema.decodeSync(TeamMember.TeamMemberId)(overrides.teamMemberId ?? 'member-1'),
    userId: Schema.decodeSync(User.UserId)(overrides.userId ?? 'user-1'),
    username: overrides.username ?? 'alice',
    name: Option.none(),
    avatar: Option.none(),
    displayName: overrides.displayName ?? 'Alice',
    strength: overrides.strength ?? 0.5,
    masteredCount: overrides.masteredCount ?? 2,
    totalScenarios: overrides.totalScenarios ?? 40,
  });
}

describe('TeamRulesPage', () => {
  it('renders a row per entry with rank, display name and mastery', () => {
    render(
      <TeamRulesPage
        leaderboard={
          new RulesTrainerApi.RulesLeaderboardResponse({
            scope: 'team',
            entries: [
              makeEntry({ rank: 1, teamMemberId: 'member-1', displayName: 'Alice', strength: 0.9 }),
              makeEntry({ rank: 2, teamMemberId: 'member-2', displayName: 'Bob', strength: 0.25 }),
            ],
          })
        }
      />,
    );

    expect(screen.getByText('Alice')).not.toBeNull();
    expect(screen.getByText('Bob')).not.toBeNull();
    expect(screen.getByText('90%')).not.toBeNull();
    expect(screen.getByText('25%')).not.toBeNull();
    expect(screen.getAllByText('rules_leaderboardRank')).toHaveLength(2);
  });

  it('shows the self-only explanation only when `scope` is `self`', () => {
    const { rerender } = render(
      <TeamRulesPage
        leaderboard={
          new RulesTrainerApi.RulesLeaderboardResponse({
            scope: 'self',
            entries: [makeEntry()],
          })
        }
      />,
    );
    expect(screen.getByText('rules_leaderboardSelfOnly')).not.toBeNull();

    rerender(
      <TeamRulesPage
        leaderboard={
          new RulesTrainerApi.RulesLeaderboardResponse({
            scope: 'team',
            entries: [makeEntry()],
          })
        }
      />,
    );
    expect(screen.queryByText('rules_leaderboardSelfOnly')).toBeNull();
  });

  it('shows the empty state, not a bare table, when there are no entries', () => {
    render(
      <TeamRulesPage
        leaderboard={new RulesTrainerApi.RulesLeaderboardResponse({ scope: 'team', entries: [] })}
      />,
    );
    expect(screen.getByText('rules_leaderboardEmpty')).not.toBeNull();
  });

  it('mounts the trainer itself, rather than linking out to the public route', () => {
    render(
      <TeamRulesPage
        leaderboard={new RulesTrainerApi.RulesLeaderboardResponse({ scope: 'team', entries: [] })}
      />,
    );
    expect(screen.getByTestId('rules-trainer')).not.toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
