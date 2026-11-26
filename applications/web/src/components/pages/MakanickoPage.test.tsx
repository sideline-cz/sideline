import { type ActivityLog, ActivityLogApi, type ActivityType } from '@sideline/domain';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: React.PropsWithChildren<{ to?: string }>) => (
    <a href={to ?? '/'}>{children}</a>
  ),
}));

const { MakanickoPage } = await import('~/components/pages/MakanickoPage.js');

const gymId = '00000000-0000-0000-0000-000000000002' as ActivityType.ActivityTypeId;
const pastId = '6f1c2b8e-3d4a-4b5c-9d6e-7f8091a2b3c4' as ActivityLog.ActivitySeasonId;
const pastSeason = new ActivityLogApi.ActivitySeason({
  id: pastId,
  startsAt: '2025-01-01',
  endsAt: Option.some('2025-06-30'),
  isCurrent: false,
});

const renderPage = (props: Partial<React.ComponentProps<typeof MakanickoPage>>) =>
  render(
    <MakanickoPage
      teamId='00000000-0000-0000-0000-0000000000aa'
      leaderboardEntries={[]}
      currentUserId='u1'
      activityStats={{
        totalActivities: 0,
        totalDurationMinutes: 0,
        currentStreak: 0,
        longestStreak: 0,
        counts: [],
        achievements: [],
      }}
      activityLogs={[]}
      seasons={[]}
      season={undefined}
      onSeasonChange={() => {}}
      canViewTeamActivity={false}
      activityTypes={[{ id: gymId, name: 'Gym', emoji: Option.none() }]}
      onCreateLog={async () => true}
      onUpdateLog={async () => {}}
      onDeleteLog={async () => {}}
      {...props}
    />,
  );

const headerLogButton = () =>
  within(screen.getByRole('banner')).queryByRole('button', { name: 'activityLog_logActivity' });

describe('MakanickoPage log activity', () => {
  it('logs from a header sheet and closes it once saved', async () => {
    const onCreateLog = vi.fn(async () => true);
    renderPage({ onCreateLog });
    const open = headerLogButton();
    if (!open) throw new Error('no header log button');
    fireEvent.click(open);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Gym' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'activityLog_logActivity' }));
    await waitFor(() => expect(onCreateLog).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('hides the header button when a past season is selected', () => {
    renderPage({ seasons: [pastSeason], season: pastId });
    expect(headerLogButton()).toBeNull();
  });
});
