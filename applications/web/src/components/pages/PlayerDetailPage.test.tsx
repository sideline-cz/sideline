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

const TEAM_ID = 'team-1';

const baseProps = {
  teamId: TEAM_ID,
  availableRoles: makeRoles(),
  achievements: [] as ReadonlyArray<{ slug: string; earned_at: string }>,
  activityLogs: makeActivityLogs(),
  activityTypes: [],
  onSave: vi.fn().mockResolvedValue(undefined),
  onAssignRole: vi.fn().mockResolvedValue(undefined),
  onUnassignRole: vi.fn().mockResolvedValue(undefined),
  onCreateLog: vi.fn().mockResolvedValue(undefined),
  onUpdateLog: vi.fn().mockResolvedValue(undefined),
  onDeleteLog: vi.fn().mockResolvedValue(undefined),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlayerDetailPage — edit gating', () => {
  it('canEdit=true → profile edit form is rendered', () => {
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

    expect(screen.getByLabelText('Display name')).not.toBeNull();
    expect(screen.getByText('Save changes')).not.toBeNull();
  });

  it('canEdit=false → read-only details rendered, no editable inputs', () => {
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
  // TDD: PlayerDetailPage currently calls AchievementsGridI18n without empty-state
  // props; the component is expected to forward empty title/description when
  // there are no earned achievements.
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
  // TDD: ActivityStatsCard currently has no isOwnProfile-aware empty-state CTA;
  // PlayerDetailPage is expected to pass isOwnProfile through so the CTA can render.
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
  // TDD: role removal currently calls onUnassignRole directly on click with no
  // confirmation. The new behaviour requires an AlertDialog confirm step.
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
  // TDD: current implementation only disables Save while `isSubmitting`; the new
  // behaviour requires disabling Save while the form is pristine and while invalid,
  // and showing a dirty indicator once changed.
  it('pristine form → Save button is disabled', () => {
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

  it('successful save clears the dirty indicator and unsaved-changes footer', async () => {
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

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    const saveButton = await screen.findByText('Save changes');
    await waitFor(() => {
      expect(saveButton.closest('button')?.hasAttribute('disabled')).toBe(false);
    });

    expect(screen.getByText('Unsaved changes')).not.toBeNull();

    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.queryByText('Unsaved changes')).toBeNull();
    });

    await waitFor(() => {
      expect(saveButton.closest('button')?.hasAttribute('disabled')).toBe(true);
    });
  });

  it('failed save keeps the dirty indicator and unsaved-changes footer visible', async () => {
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

  it('whitespace-only display name ("   ") → validation error shown and Save stays disabled', async () => {
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

    const nameInput = screen.getByLabelText('Display name');
    await act(async () => {
      fireEvent.change(nameInput, { target: { value: '   ' } });
      fireEvent.blur(nameInput);
    });

    await waitFor(() => {
      expect(screen.getByText('This field is required.')).not.toBeNull();
    });

    const saveButton = screen.getByText('Save changes').closest('button');
    expect(saveButton?.hasAttribute('disabled')).toBe(true);
  });

  it('null display name (no profile name set) → allowed, does not block Save', async () => {
    render(
      <PlayerDetailPage
        {...(baseProps as any)}
        player={makePlayer({ name: Option.none() }) as any}
        canEdit={true}
        canManageRoles={false}
        isOwnProfile={true}
        activityStats={makeActivityStats() as any}
      />,
    );

    const jerseyInput = screen.getByLabelText('Jersey number');
    await act(async () => {
      fireEvent.change(jerseyInput, { target: { value: '9' } });
      fireEvent.blur(jerseyInput);
    });

    await waitFor(() => {
      const saveButton = screen.getByText('Save changes').closest('button');
      expect(saveButton?.hasAttribute('disabled')).toBe(false);
    });
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
