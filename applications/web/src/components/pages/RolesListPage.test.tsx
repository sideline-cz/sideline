/**
 * T-W1 (`.work-plans/configurable-default-roles.md`, r3) — the default-role control on
 * `RolesListPage`.
 *
 * `defaultRoleId` is the RESOLVED value `RoleApi.RoleListResponse` sends (see the doc comment on
 * that field in `packages/domain/src/api/RoleApi.ts`) — fallback included. `RoleInfo` deliberately
 * carries no per-row `isDefault` flag, so every fixture below builds `roles` WITHOUT any such
 * field: the badge can only ever come from comparing `role.roleId` against the resolved
 * `defaultRoleId`, never from row data. That is the fallback state pinned by
 * 'badge tracks the resolved id, never a per-row flag' below.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Effect, Option } from 'effect';
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

const { mockInvalidate } = vi.hoisted(() => ({ mockInvalidate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: mockInvalidate }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

const { mockSetDefaultRole } = vi.hoisted(() => ({
  mockSetDefaultRole: vi.fn(),
}));

// A `run` that really executes the piped Effect via `Effect.option`, mirroring
// `InvitePage.test.tsx`, so the component's post-save `router.invalidate()` actually runs.
const mockRun = () => (effect: Effect.Effect<unknown, unknown>) =>
  Effect.runPromise(Effect.option(effect));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: () => Effect.succeed({ role: { setDefaultRole: mockSetDefaultRole } }),
  },
  ClientError: { make: (message: string) => ({ _tag: 'ClientError', message }) },
  useRun: () => mockRun,
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { RolesListPage } = await import('~/components/pages/RolesListPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Deliberately no `isDefault`-shaped field anywhere on these rows — `RoleInfo` has none, and the
// badge must come from `defaultRoleId` alone.
const roleA = {
  roleId: 'role-a',
  teamId: 'team-1',
  name: 'Role A',
  isBuiltIn: true,
  permissionCount: 2,
};
const roleB = {
  roleId: 'role-b',
  teamId: 'team-1',
  name: 'Role B',
  isBuiltIn: false,
  permissionCount: 1,
};

const renderPage = (overrides?: {
  defaultRoleId?: Option.Option<string>;
  defaultRoleGrantsManage?: boolean;
  canManage?: boolean;
}) => {
  render(
    <RolesListPage
      {...({
        teamId: 'team-1',
        roles: [roleA, roleB],
        canManage: overrides?.canManage ?? true,
        defaultRoleId: overrides?.defaultRoleId ?? Option.some('role-b'),
        defaultRoleGrantsManage: overrides?.defaultRoleGrantsManage ?? false,
      } as any)}
    />,
  );
};

const openSelect = () => {
  fireEvent.click(screen.getByRole('combobox'));
};

describe('RolesListPage — default role control (T-W1, r3)', () => {
  it('badge tracks the resolved id, never a per-row flag — lands on the row named by defaultRoleId only', () => {
    renderPage({ defaultRoleId: Option.some('role-b') });

    const table = screen.getByRole('table');
    const rowA = within(table).getByText('Role A').closest('tr');
    const rowB = within(table).getByText('Role B').closest('tr');

    expect(rowA?.textContent).not.toContain('role_default');
    expect(rowB?.textContent).toContain('role_default');
  });

  it('choosing a role calls setDefaultRole with a bare roleId and invalidates the router', async () => {
    mockSetDefaultRole.mockReturnValue(Effect.succeed(undefined));
    renderPage({ defaultRoleId: Option.some('role-a') });

    openSelect();
    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByText('Role B'));

    await waitFor(() => {
      expect(mockSetDefaultRole).toHaveBeenCalledWith({
        params: { teamId: 'team-1' },
        payload: { roleId: 'role-b' },
      });
    });
    await waitFor(() => {
      expect(mockInvalidate).toHaveBeenCalled();
    });
  });

  // F2 — failure path. On success the control keeps showing the optimistic pick until the
  // router refetch lands (asserted above via `mockInvalidate`); on failure it must instead snap
  // back to the still-correct server value, and never invalidate.
  it('reverts the control to the server value and does not invalidate when setDefaultRole fails', async () => {
    mockSetDefaultRole.mockReturnValue(Effect.fail(new Error('boom')));
    renderPage({ defaultRoleId: Option.some('role-a') });

    openSelect();
    const listbox = screen.getByRole('listbox');
    fireEvent.click(within(listbox).getByText('Role B'));

    await waitFor(() => {
      expect(mockSetDefaultRole).toHaveBeenCalledWith({
        params: { teamId: 'team-1' },
        payload: { roleId: 'role-b' },
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox').textContent).toContain('Role A');
    });
    expect(screen.getByRole('combobox').textContent).not.toContain('Role B');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('defaultRoleId: None renders the role_defaultNone placeholder and the destructive alert; "No role" is not a selectable option (F3)', () => {
    renderPage({ defaultRoleId: Option.none() });

    expect(screen.getByRole('combobox').textContent).toContain('role_defaultNone');
    expect(screen.getByText('role_defaultBrokenWarning')).toBeTruthy();
    expect(screen.queryByText('role_defaultEscalationWarning')).toBeNull();

    // The destructive alert is telling the admin to go fix the default — the dropdown must not
    // offer a "No role" entry that looks selectable but silently does nothing. Unconditional
    // assertion (no `if`): this must fail if the option-injection is ever restored.
    openSelect();
    const listbox = screen.getByRole('listbox');
    const noRoleOption = within(listbox)
      .queryAllByText('role_defaultNone')
      .find((el) => el.closest('[role="option"]'));
    expect(noRoleOption).toBeUndefined();
    expect(within(listbox).getAllByRole('option')).toHaveLength(2);
  });

  it('defaultRoleGrantsManage: true renders the warning alert; false renders neither alert', () => {
    const { unmount } = render(
      <RolesListPage
        {...({
          teamId: 'team-1',
          roles: [roleA, roleB],
          canManage: true,
          defaultRoleId: Option.some('role-a'),
          defaultRoleGrantsManage: true,
        } as any)}
      />,
    );
    expect(screen.getByText('role_defaultEscalationWarning')).toBeTruthy();
    expect(screen.queryByText('role_defaultBrokenWarning')).toBeNull();
    unmount();

    renderPage({ defaultRoleId: Option.some('role-a'), defaultRoleGrantsManage: false });
    expect(screen.queryByText('role_defaultEscalationWarning')).toBeNull();
    expect(screen.queryByText('role_defaultBrokenWarning')).toBeNull();
  });

  it('canManage: false disables the SearchableSelect', () => {
    renderPage({ canManage: false });
    const combo = screen.getByRole('combobox');
    expect(combo.hasAttribute('disabled')).toBe(true);
  });

  it('is a SearchableSelect, not a Select — the search input appears on open', () => {
    renderPage();
    openSelect();
    expect(screen.getByPlaceholderText('searchable_select_search')).toBeTruthy();
  });
});
