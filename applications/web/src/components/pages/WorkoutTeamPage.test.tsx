import { ActivityLogApi, type ActivityType, type Team } from '@sideline/domain';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LogActivityInput } from '~/components/organisms/LogActivityForm.js';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: React.PropsWithChildren<{ to?: string }>) => (
    <a href={to ?? '/'}>{children}</a>
  ),
}));

const { WorkoutTeamPage } = await import('~/components/pages/WorkoutTeamPage.js');

const teamId = '00000000-0000-0000-0000-0000000000aa' as Team.TeamId;
const gymId = '00000000-0000-0000-0000-000000000002' as ActivityType.ActivityTypeId;
const matrix = new ActivityLogApi.ActivityMatrixResponse({
  days: ['2026-11-08'],
  rows: [],
  groups: [],
});

const renderPage = (props: Partial<React.ComponentProps<typeof WorkoutTeamPage>>) =>
  render(
    <WorkoutTeamPage
      teamId={teamId}
      matrix={matrix}
      groupId={undefined}
      onGroupChange={() => {}}
      onRetry={() => {}}
      {...props}
    />,
  );

describe('WorkoutTeamPage log activity', () => {
  it('has no log button when the viewer is not a member', () => {
    renderPage({
      logActivityTypes: [{ id: gymId, name: 'Gym', emoji: Option.none() }],
      onLogActivity: async () => true,
    });
    expect(screen.queryByRole('button', { name: 'activityLog_logActivity' })).toBeNull();
  });

  it('logs for the viewer from a sheet and closes it once saved', async () => {
    const onLogActivity = vi.fn(async (_input: LogActivityInput) => true);
    renderPage({
      currentMemberId: '00000000-0000-0000-0000-000000000001',
      logActivityTypes: [{ id: gymId, name: 'Gym', emoji: Option.none() }],
      onLogActivity,
    });
    fireEvent.click(screen.getByRole('button', { name: 'activityLog_logActivity' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Gym' }));
    const submit = [...dialog.querySelectorAll('button')].find(
      (b) => b.textContent === 'activityLog_logActivity',
    );
    if (!submit) throw new Error('no submit button in the sheet');
    fireEvent.click(submit);
    await waitFor(() => expect(onLogActivity).toHaveBeenCalledOnce());
    expect(onLogActivity.mock.calls[0]?.[0]).toMatchObject({ activityTypeId: gymId });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
