import { ActivityLogApi, LeaderboardApi, type TeamMember } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: React.PropsWithChildren<{ params?: { memberId?: string } }>) => (
    <a href={`/members/${params?.memberId ?? ''}`}>{children}</a>
  ),
}));

const { LeaderboardPage } = await import('~/components/pages/LeaderboardPage.js');
const { WorkoutTeamPage } = await import('~/components/pages/WorkoutTeamPage.js');

const JAN = '00000000-0000-0000-0000-000000000001' as TeamMember.TeamMemberId;
const EVA = '00000000-0000-0000-0000-000000000002' as TeamMember.TeamMemberId;

const entries = [
  new LeaderboardApi.LeaderboardEntry({
    rank: 1,
    teamMemberId: JAN,
    userId: 'u1' as never,
    username: 'jan',
    name: Option.none(),
    avatar: Option.none(),
    totalActivities: 3,
    totalDurationMinutes: 90,
    currentStreak: 2,
    longestStreak: 2,
    displayName: 'Jan Novák',
  }),
];

describe('LeaderboardPage', () => {
  it('links each row to the member page when the viewer has member:view', () => {
    render(<LeaderboardPage teamId='t' entries={entries} currentUserId='u2' canViewMembers />);
    expect(screen.getByRole('link', { name: /Jan Novák/ }).getAttribute('href')).toBe(
      `/members/${JAN}`,
    );
  });

  it('keeps rows plain without member:view', () => {
    render(
      <LeaderboardPage teamId='t' entries={entries} currentUserId='u2' canViewMembers={false} />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Jan Novák')).toBeTruthy();
  });
});

describe('WorkoutTeamPage', () => {
  it('shows only members who logged something in the window', () => {
    const matrix = new ActivityLogApi.ActivityMatrixResponse({
      days: ['2026-11-07', '2026-11-08'],
      groups: [],
      rows: [
        new ActivityLogApi.ActivityMatrixRow({
          memberId: JAN,
          displayName: 'Jan Novák',
          cells: [
            new ActivityLogApi.ActivityMatrixCell({
              date: '2026-11-08',
              entries: [
                new ActivityLogApi.ActivityMatrixEntry({
                  activityTypeName: 'Gym',
                  activityTypeEmoji: Option.none(),
                  totalMinutes: Option.some(30),
                }),
              ],
            }),
          ],
        }),
        new ActivityLogApi.ActivityMatrixRow({
          memberId: EVA,
          displayName: 'Eva Svobodová',
          cells: [],
        }),
      ],
    });
    render(
      <WorkoutTeamPage
        teamId={'t' as never}
        matrix={matrix}
        groupId={undefined}
        onGroupChange={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText('Jan Novák')).toBeTruthy();
    expect(screen.queryByText('Eva Svobodová')).toBeNull();
  });
});
