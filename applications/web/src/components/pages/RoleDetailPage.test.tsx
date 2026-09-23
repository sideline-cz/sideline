/**
 * T-W2 (`.work-plans/configurable-default-roles.md`, r3) — `RoleDetailPage` reads
 * `RoleApi.RoleDetail.isDefaultForNewMembers` (RESOLVED server-side, fallback included) as a
 * READ-ONLY marker. r3 moved the control and the escalation warning to `RolesListPage`; this
 * page must render neither.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  setTranslationOverrides: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  useNavigate: () => vi.fn(),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () => {
      throw new Error('no request should fire just from rendering this page');
    },
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  useRun: () => () => {
    throw new Error('no request should fire just from rendering this page');
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { RoleDetailPage } = await import('~/components/pages/RoleDetailPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeRole = (overrides?: { isDefaultForNewMembers?: boolean }) => ({
  roleId: 'role-a',
  teamId: 'team-1',
  name: 'Guest',
  isBuiltIn: false,
  permissions: [],
  canManage: true,
  isDefaultForNewMembers: overrides?.isDefaultForNewMembers ?? false,
});

describe('RoleDetailPage — read-only default marker (T-W2, r3)', () => {
  it('renders the default marker when isDefaultForNewMembers, and no control to change it', () => {
    render(
      <RoleDetailPage
        {...({
          teamId: 'team-1',
          role: makeRole({ isDefaultForNewMembers: true }),
          canManage: true,
        } as any)}
      />,
    );

    expect(screen.getByLabelText('role_defaultForNewMembers')).toBeTruthy();
    expect(screen.getByText('role_default')).toBeTruthy();
    // No control was re-introduced here — no select/combobox for the default role.
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('does not render the marker when the role is not the resolved default', () => {
    render(
      <RoleDetailPage
        {...({
          teamId: 'team-1',
          role: makeRole({ isDefaultForNewMembers: false }),
          canManage: true,
        } as any)}
      />,
    );

    expect(screen.queryByText('role_default')).toBeNull();
  });

  it('renders no escalation alert — that warning belongs on the list page now', () => {
    render(
      <RoleDetailPage
        {...({
          teamId: 'team-1',
          role: makeRole({ isDefaultForNewMembers: true }),
          canManage: true,
        } as any)}
      />,
    );

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('role_defaultEscalationWarning')).toBeNull();
    expect(screen.queryByText('role_defaultBrokenWarning')).toBeNull();
  });
});

// F1 — the delete confirmation must warn about the actual fallback (built-in Player), not a
// "no role" state the API cannot produce (`deleteRole` blocks built-in roles, `archiveRoleQuery`
// clears `is_default`, and `findDefaultRoleQuery` then falls back to Player).
describe('RoleDetailPage — delete confirmation warning (F1)', () => {
  it('appends role_defaultDeleteWarning to the confirm message when this role is the resolved default', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <RoleDetailPage
        {...({
          teamId: 'team-1',
          role: makeRole({ isDefaultForNewMembers: true }),
          canManage: true,
        } as any)}
      />,
    );

    fireEvent.click(screen.getByText('role_deleteRole'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const [message] = confirmSpy.mock.calls[0] ?? [];
    expect(message).toContain('role_deleteRoleConfirm');
    expect(message).toContain('role_defaultDeleteWarning');

    confirmSpy.mockRestore();
  });

  it('does not append role_defaultDeleteWarning when this role is not the resolved default', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(
      <RoleDetailPage
        {...({
          teamId: 'team-1',
          role: makeRole({ isDefaultForNewMembers: false }),
          canManage: true,
        } as any)}
      />,
    );

    fireEvent.click(screen.getByText('role_deleteRole'));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const [message] = confirmSpy.mock.calls[0] ?? [];
    expect(message).toContain('role_deleteRoleConfirm');
    expect(message).not.toContain('role_defaultDeleteWarning');

    confirmSpy.mockRestore();
  });
});
