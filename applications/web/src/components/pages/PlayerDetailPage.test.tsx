// TDD mode — tests written for the "Improve member detail webpage" rework of
// PlayerDetailPage.tsx. Several behaviours below DO NOT exist in the current
// implementation yet (AlertDialog confirm on role removal, dirty/validation-gated
// Save button, MemberSummaryHeader composition, achievements/activity empty-state
// props). Those are marked with `// TDD:` and are EXPECTED to fail (red) until the
// developer implements them.
//
// Heavy child organisms are mocked as identifiable stubs so this file tests
// composition/gating only, not their internals.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      members_backToMembers: 'Back to members',
      members_saving: 'Saving…',
      members_saveChanges: 'Save changes',
      members_joinedLabel: 'Joined {date}',
      members_editProfile: 'Edit',
      members_discardTitle: 'Discard changes?',
      members_discardDescription:
        'You have unsaved changes. Are you sure you want to discard them?',
      members_discardConfirm: 'Discard',
      members_discardCancel: 'Keep editing',
      members_fieldEmpty: '—',
      members_membershipsTitle: 'Memberships',
      members_groupsTitle: 'Groups',
      members_rostersTitle: 'Rosters',
      groups_noneForMember: 'Not a member of any group.',
      rosters_noneForMember: 'Not a member of any roster.',
      members_addToGroup: 'Add to group',
      members_addToRoster: 'Add to roster',
      members_removeFromGroupAria: 'Remove from {group}',
      members_removeFromRosterAria: 'Remove from {roster}',
      members_removeFromGroupConfirmTitle: 'Remove from group?',
      members_removeFromGroupConfirmDescription:
        'Are you sure you want to remove this member from {group}?',
      members_removeFromGroupConfirmConfirm: 'Remove',
      members_removeFromRosterConfirmTitle: 'Remove from roster?',
      members_removeFromRosterConfirmDescription:
        'Are you sure you want to remove this member from {roster}?',
      members_removeFromRosterConfirmConfirm: 'Remove',
      members_inactiveBannerTitle: 'Inactive member',
      members_inactiveBannerDescription:
        'This member has been deactivated and no longer has access to the team.',
      members_inactiveBadge: 'Inactive',
      members_dangerZoneTitle: 'Danger zone',
      members_deactivateAction: 'Deactivate member',
      members_deactivateDescription:
        "Deactivating removes this member's access to the team. This can be undone later.",
      members_deactivateConfirmTitle: 'Deactivate this member?',
      members_deactivateConfirmDescription:
        'They will lose access to the team immediately. You can reactivate them later.',
      members_deactivateConfirmConfirm: 'Deactivate',
      members_reactivateAction: 'Reactivate member',
      members_reactivateConfirmTitle: 'Reactivate this member?',
      members_reactivateConfirmDescription: 'They will regain access to the team.',
      members_reactivateConfirmConfirm: 'Reactivate',
      common_cancel: 'Cancel',
      profile_complete_displayName: 'Display name',
      profile_complete_birthDate: 'Birth date',
      profile_complete_birthDatePlaceholder: 'Select date',
      profile_complete_gender: 'Gender',
      profile_complete_genderPlaceholder: 'Select gender',
      profile_complete_genderMale: 'Male',
      profile_complete_genderFemale: 'Female',
      profile_complete_genderOther: 'Other',
      profile_complete_jerseyNumber: 'Jersey number',
      profile_complete_jerseyNumberPlaceholder: 'e.g. 7',
      validation_jerseyNumber: 'Jersey number must be between 0 and 99',
      validation_required: 'This field is required.',
      validation_displayNameTooLong: 'Display name is too long',
      roles_currentRoles: 'Current roles',
      roles_noRoles: 'No roles assigned',
      roles_addRole: 'Add role',
      roles_removeRole: 'Remove role',
      roles_removeRoleConfirmTitle: 'Remove role?',
      roles_removeRoleConfirmDescription: 'Are you sure you want to remove this role?',
      roles_removeRoleConfirm: 'Remove',
      roles_removeRoleCancel: 'Cancel',
      members_unsavedChanges: 'Unsaved changes',
      stats_activityEmptyCta: 'Log your first activity',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_: string, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    ...rest
  }: React.PropsWithChildren<{ to?: string; params?: Record<string, string> }>) => {
    const href = to
      ? to.replace(/\$(\w+)/g, (_: string, key: string) => params?.[key] ?? key)
      : '#';
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

// Mock heavy child organisms with identifiable stubs.
vi.mock('~/components/organisms/MemberRatingCard.js', () => ({
  MemberRatingCard: (props: Record<string, unknown>) => (
    <div data-testid='member-rating-card-stub' data-props={JSON.stringify(Object.keys(props))} />
  ),
}));

vi.mock('~/components/organisms/ActivityStatsCard', () => ({
  ActivityStatsCard: ({
    stats,
    isOwnProfile,
  }: {
    stats: { totalActivities: number };
    isOwnProfile?: boolean;
  }) => (
    <div data-testid='activity-stats-card-stub'>
      <span data-testid='activity-stats-total'>{stats.totalActivities}</span>
      {stats.totalActivities === 0 && isOwnProfile ? (
        <button type='button' data-testid='activity-empty-cta'>
          Log your first activity
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('~/components/organisms/ActivityLogList', () => ({
  ActivityLogList: () => <div data-testid='activity-log-list-stub' />,
}));

vi.mock('~/components/organisms/AchievementsGrid.js', () => ({
  AchievementsGridI18n: (props: { emptyTitle?: string; emptyDescription?: string }) => (
    <div
      data-testid='achievements-grid-stub'
      data-empty-title={props.emptyTitle ?? ''}
      data-empty-description={props.emptyDescription ?? ''}
    />
  ),
}));

vi.mock('~/components/organisms/MemberSummaryHeader.js', () => ({
  MemberSummaryHeader: () => <div data-testid='member-summary-header-stub' />,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { PlayerDetailPage } = await import('~/components/pages/PlayerDetailPage.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePlayer(overrides: Record<string, unknown> = {}) {
  return {
    memberId: 'member-1',
    userId: 'user-1',
    discordId: '1234567890',
    roleNames: ['Captain'],
    permissions: ['member:view'],
    name: Option.some('Alice Doe'),
    birthDate: Option.none(),
    gender: Option.none(),
    jerseyNumber: Option.none(),
    username: 'alicedoe',
    avatar: Option.none(),
    displayName: 'Alice Doe',
    joinedAt: '2024-03-15T00:00:00Z',
    active: true,
    ...overrides,
  };
}

function makeActivityStats(overrides: Record<string, unknown> = {}) {
  return {
    currentStreak: 0,
    longestStreak: 0,
    totalActivities: 0,
    totalDurationMinutes: 0,
    counts: [],
    achievements: [],
    ...overrides,
  };
}

function makeActivityLogs(): { logs: ReadonlyArray<unknown> } {
  return { logs: [] };
}

function makeRoles(): ReadonlyArray<{
  roleId: string;
  teamId: string;
  name: string;
  isBuiltIn: boolean;
  permissionCount: number;
}> {
  return [
    {
      roleId: 'role-captain',
      teamId: 'team-1',
      name: 'Captain',
      isBuiltIn: false,
      permissionCount: 3,
    },
    {
      roleId: 'role-striker',
      teamId: 'team-1',
      name: 'Striker',
      isBuiltIn: false,
      permissionCount: 1,
    },
  ];
}

function makeGroups(): ReadonlyArray<{ groupId: string; name: string }> {
  return [
    { groupId: 'group-1', name: 'Attackers' },
    { groupId: 'group-2', name: 'Defenders' },
  ];
}

function makeRosters(): ReadonlyArray<{ rosterId: string; name: string }> {
  return [
    { rosterId: 'roster-1', name: 'Main Roster' },
    { rosterId: 'roster-2', name: 'B Team' },
  ];
}

const TEAM_ID = 'team-1';

const baseProps = {
  teamId: TEAM_ID,
  availableRoles: makeRoles(),
  memberRosters: [] as ReadonlyArray<{ rosterId: string; name: string }>,
  assignableRosters: makeRosters(),
  memberGroups: [] as ReadonlyArray<{ groupId: string; name: string }>,
  assignableGroups: makeGroups(),
  canManageRosters: false,
  canManageGroups: false,
  canRemoveMember: false,
  achievements: [] as ReadonlyArray<{ slug: string; earned_at: string }>,
  activityLogs: makeActivityLogs(),
  activityTypes: [],
  onSave: vi.fn().mockResolvedValue(undefined),
  onAssignRole: vi.fn().mockResolvedValue(undefined),
  onUnassignRole: vi.fn().mockResolvedValue(undefined),
  onAddToRoster: vi.fn().mockResolvedValue(undefined),
  onRemoveFromRoster: vi.fn().mockResolvedValue(undefined),
  onAddToGroup: vi.fn().mockResolvedValue(undefined),
  onRemoveFromGroup: vi.fn().mockResolvedValue(undefined),
  onDeactivate: vi.fn().mockResolvedValue(true),
  onReactivate: vi.fn().mockResolvedValue(true),
  onCreateLog: vi.fn().mockResolvedValue(undefined),
  onUpdateLog: vi.fn().mockResolvedValue(undefined),
  onDeleteLog: vi.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayerDetailPage — view/edit split (item 1)', () => {
  it('canEdit=true → form is hidden until Edit is clicked; read-only view rendered first', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(screen.queryByText('Save changes')).toBeNull();
    expect(screen.getByRole('button', { name: /edit/i })).not.toBeNull();
  });

  it('canEdit=true → clicking Edit reveals the dirty-state form', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    expect(screen.getByLabelText('Display name')).not.toBeNull();
    expect(screen.getByText('Save changes')).not.toBeNull();
  });

  it('canEdit=false → read-only details rendered, no editable inputs, no Edit button', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByLabelText('Display name')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('canEdit=true → successful save exits edit mode back to the read-only view', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
        onSave={onSave}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    const saveButton = await screen.findByText('Save changes');
    await waitFor(() => {
      expect(saveButton.closest('button')?.hasAttribute('disabled')).toBe(false);
    });

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Display name')).toBeNull();
    });
    expect(screen.getByRole('button', { name: /edit/i })).not.toBeNull();
  });

  it('canEdit=true → cancel while dirty opens a discard-confirm dialog; confirming discards and exits edit mode', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });
    expect(screen.getByText('Discard changes?')).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    });

    await waitFor(() => {
      expect(screen.queryByLabelText('Display name')).toBeNull();
    });
  });

  it('canEdit=true → cancel while pristine exits edit mode immediately without a confirm dialog', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByLabelText('Display name')).toBeNull();
  });
});

describe('PlayerDetailPage — rating card gating (unchanged)', () => {
  it('canEdit=true and rating provided → rating card stub renders', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
        rating={{ memberId: 'member-1', rating: 1200, gamesPlayed: 5 } as any}
      />,
    );

    expect(screen.queryByTestId('member-rating-card-stub')).not.toBeNull();
  });

  it('canEdit=false → rating card stub does NOT render, even with rating provided', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        rating={{ memberId: 'member-1', rating: 1200, gamesPlayed: 5 } as any}
      />,
    );

    expect(screen.queryByTestId('member-rating-card-stub')).toBeNull();
  });

  it('canEdit=true but no rating provided → rating card stub does NOT render', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByTestId('member-rating-card-stub')).toBeNull();
  });
});

describe('PlayerDetailPage — achievements empty state', () => {
  it('no achievements → empty-state title/description are forwarded to the grid stub', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        achievements={[]}
        activityStats={makeActivityStats() as any}
      />,
    );

    const stub = screen.getByTestId('achievements-grid-stub');
    expect(stub.getAttribute('data-empty-title')).not.toBe('');
    expect(stub.getAttribute('data-empty-description')).not.toBe('');
  });
});

describe('PlayerDetailPage — activity empty-state CTA', () => {
  it('totalActivities=0 and isOwnProfile=true → activity empty-state CTA rendered', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats({ totalActivities: 0 }) as any}
      />,
    );

    expect(screen.queryByTestId('activity-empty-cta')).not.toBeNull();
  });

  it('totalActivities=0 and isOwnProfile=false → no activity empty-state CTA', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        isOwnProfile={false}
        activityStats={makeActivityStats({ totalActivities: 0 }) as any}
      />,
    );

    expect(screen.queryByTestId('activity-empty-cta')).toBeNull();
  });
});

describe('PlayerDetailPage — role removal confirmation', () => {
  it('canManageRoles=true → clicking remove opens a confirm dialog; confirming calls onUnassignRole with the roleId', async () => {
    const onUnassignRole = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ roleNames: ['Captain'] }) as any}
        canEdit={false}
        canManageRoles={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        onUnassignRole={onUnassignRole}
      />,
    );

    const removeButton = screen.getByRole('button', { name: /remove/i });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });

    expect(onUnassignRole).not.toHaveBeenCalled();

    const confirmButton = screen.getByRole('button', { name: /^remove$/i });
    await act(async () => {
      fireEvent.click(confirmButton);
    });

    await waitFor(() => {
      expect(onUnassignRole).toHaveBeenCalledWith('role-captain');
    });
  });

  it('canManageRoles=true → cancelling the confirm dialog does NOT call onUnassignRole', async () => {
    const onUnassignRole = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ roleNames: ['Captain'] }) as any}
        canEdit={false}
        canManageRoles={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        onUnassignRole={onUnassignRole}
      />,
    );

    const removeButton = screen.getByRole('button', { name: /remove/i });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(onUnassignRole).not.toHaveBeenCalled();
  });

  it('canManageRoles=false → no remove control is rendered', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ roleNames: ['Captain'] }) as any}
        canEdit={false}
        canManageRoles={false}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });
});

describe('PlayerDetailPage — form dirty/validation gating', () => {
  it('pristine form → Save button is disabled', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(true);
  });

  it('invalid jersey number change → validation error shown and Save stays disabled', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '150' } });
      fireEvent.blur(jerseyInput);
    });

    await waitFor(() => {
      expect(screen.getByText('Jersey number must be between 0 and 99')).not.toBeNull();
    });

    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(true);
  });

  it('valid field change → dirty indicator appears and Save becomes enabled', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    await waitFor(() => {
      expect(screen.getByText('Unsaved changes')).not.toBeNull();
    });

    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(false);
  });

  it('submitting a valid change calls onSave', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
        onSave={onSave}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    const saveButton = await screen.findByText('Save changes');
    await waitFor(() => {
      expect(saveButton.closest('button')?.hasAttribute('disabled')).toBe(false);
    });

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });
  });

  it('failed save keeps the dirty indicator, unsaved-changes footer, and edit mode visible', async () => {
    const onSave = vi.fn().mockResolvedValue(false);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
        onSave={onSave}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    const saveButton = await screen.findByText('Save changes');
    await waitFor(() => {
      expect(saveButton.closest('button')?.hasAttribute('disabled')).toBe(false);
    });

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });

    expect(screen.getByText('Unsaved changes')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /edit/i })).toBeNull();
  });

  it('blank display name ("") → validation error shown and Save stays disabled', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const nameInput = screen.getByLabelText('Display name');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '' } });
      fireEvent.blur(nameInput);
    });

    await waitFor(() => {
      expect(screen.getByText('This field is required.')).not.toBeNull();
    });

    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(true);
  });

  it('valid display name ("A") → accepted, Save becomes enabled', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    });

    const nameInput = screen.getByLabelText('Display name');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: 'A' } });
      fireEvent.blur(nameInput);
    });

    await waitFor(() => {
      const saveButton = screen.getByText('Save changes').closest('button');
      expect(saveButton?.hasAttribute('disabled')).toBe(false);
    });
  });
});

describe('PlayerDetailPage — memberships (item 2)', () => {
  it('canManageGroups=true → picker + Add calls onAddToGroup with the selected id', async () => {
    const onAddToGroup = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        canManageGroups={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        memberGroups={[]}
        assignableGroups={makeGroups()}
        onAddToGroup={onAddToGroup}
      />,
    );

    const combos = screen.getAllByRole('combobox');
    const groupCombo = combos[combos.length - 1];
    await act(async () => {
      fireEvent.click(groupCombo);
    });

    const option = await screen.findByText('Attackers');
    await act(async () => {
      fireEvent.click(option);
    });

    const addButtons = screen.getAllByRole('button', { name: 'Add to group' });
    const enabledAddButton = addButtons.find((btn) => !btn.hasAttribute('disabled'));
    expect(enabledAddButton).not.toBeUndefined();

    await act(async () => {
      fireEvent.click(enabledAddButton as HTMLElement);
    });

    await waitFor(() => {
      expect(onAddToGroup).toHaveBeenCalledWith('group-1');
    });
  });

  it('canManageRosters=true → remove confirm calls onRemoveFromRoster; cancel does not', async () => {
    const onRemoveFromRoster = vi.fn().mockResolvedValue(undefined);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        canManageRosters={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        memberRosters={makeRosters()}
        assignableRosters={[]}
        onRemoveFromRoster={onRemoveFromRoster}
      />,
    );

    const removeButton = screen.getByRole('button', { name: 'Remove from Main Roster' });
    await act(async () => {
      fireEvent.click(removeButton);
    });

    await waitFor(() => {
      expect(screen.getByText('Remove from roster?')).not.toBeNull();
    });

    const cancelButton = screen.getByRole('button', { name: /^cancel$/i });
    await act(async () => {
      fireEvent.click(cancelButton);
    });

    expect(onRemoveFromRoster).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove from Main Roster' }));
    });
    await waitFor(() => {
      expect(screen.getByText('Remove from roster?')).not.toBeNull();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });

    await waitFor(() => {
      expect(onRemoveFromRoster).toHaveBeenCalledWith('roster-1');
    });
  });

  it('canManageGroups=false and canManageRosters=false → chips render but no add/remove controls', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        canManageGroups={false}
        canManageRosters={false}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        memberGroups={makeGroups()}
        memberRosters={makeRosters()}
      />,
    );

    expect(screen.getByText('Attackers')).not.toBeNull();
    expect(screen.getByText('Main Roster')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /remove from/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to roster' })).toBeNull();
  });

  it('no assignable groups/rosters → picker is hidden even when manager', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer() as any}
        canEdit={false}
        canManageRoles={false}
        canManageGroups={true}
        canManageRosters={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        memberGroups={[]}
        assignableGroups={[]}
        memberRosters={[]}
        assignableRosters={[]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Add to group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to roster' })).toBeNull();
  });

  it('player inactive → membership add/remove controls are disabled even for managers', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ active: false }) as any}
        canEdit={false}
        canManageRoles={true}
        canManageGroups={true}
        canManageRosters={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        memberGroups={makeGroups()}
        memberRosters={makeRosters()}
      />,
    );

    expect(screen.queryByRole('button', { name: /remove from/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to group' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to roster' })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });
});

describe('PlayerDetailPage — deactivate/reactivate (item 3)', () => {
  it('player inactive → banner and badge render, and danger zone shows Reactivate', async () => {
    const onReactivate = vi.fn().mockResolvedValue(true);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ active: false }) as any}
        canEdit={false}
        canManageRoles={false}
        canRemoveMember={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        onReactivate={onReactivate}
      />,
    );

    expect(screen.getByText('Inactive member')).not.toBeNull();
    expect(screen.getByText('Danger zone')).not.toBeNull();
    const reactivateButton = screen.getByRole('button', { name: 'Reactivate member' });
    await act(async () => {
      fireEvent.click(reactivateButton);
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    });

    await waitFor(() => {
      expect(onReactivate).toHaveBeenCalled();
    });
  });

  it('player active, canRemoveMember=true, not own profile → danger zone shows Deactivate behind confirm', async () => {
    const onDeactivate = vi.fn().mockResolvedValue(true);
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ active: true }) as any}
        canEdit={false}
        canManageRoles={false}
        canRemoveMember={true}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
        onDeactivate={onDeactivate}
      />,
    );

    expect(screen.queryByText('Inactive member')).toBeNull();
    const deactivateButton = screen.getByRole('button', { name: 'Deactivate member' });
    await act(async () => {
      fireEvent.click(deactivateButton);
    });

    await waitFor(() => {
      expect(screen.getByRole('alertdialog')).not.toBeNull();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    });

    await waitFor(() => {
      expect(onDeactivate).toHaveBeenCalled();
    });
  });

  it('canRemoveMember=false → no danger zone rendered', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ active: true }) as any}
        canEdit={false}
        canManageRoles={false}
        canRemoveMember={false}
        isOwnProfile={false}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  it('isOwnProfile=true → no danger zone rendered even when canRemoveMember=true', () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ active: true }) as any}
        canEdit={true}
        canManageRoles={false}
        canRemoveMember={true}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    expect(screen.queryByText('Danger zone')).toBeNull();
  });
});
