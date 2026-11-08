import { type ActivityLog, ActivityLogApi, type ActivityType } from '@sideline/domain';
import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({ tr: (key: string) => key }));

const { ActivityLogList } = await import('~/components/organisms/ActivityLogList.js');

const log = new ActivityLogApi.ActivityLogEntry({
  id: '00000000-0000-0000-0000-000000000001' as ActivityLog.ActivityLogId,
  activityTypeId: '00000000-0000-0000-0000-000000000002' as ActivityType.ActivityTypeId,
  activityTypeName: 'Gym',
  activityTypeEmoji: Option.none(),
  loggedAt: '2026-11-07T12:00:00Z',
  durationMinutes: Option.some(30),
  note: Option.some('private-note'),
  source: 'manual',
});

describe('ActivityLogList', () => {
  // Second wall: the server strips other members' notes, the list must not render one either.
  it('hides note when not own profile', () => {
    render(
      <ActivityLogList
        logs={[log]}
        isOwnProfile={false}
        activityTypes={[]}
        onCreateLog={async () => {}}
        onUpdateLog={async () => {}}
        onDeleteLog={async () => {}}
      />,
    );
    expect(screen.getByText('Gym')).not.toBeNull();
    expect(screen.queryByText('private-note')).toBeNull();
  });
});
