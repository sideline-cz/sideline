// TDD mode — tests written BEFORE EditBuiltInSheet is exported.
// These tests WILL FAIL until the developer adds `export` to EditBuiltInSheet
// in applications/web/src/components/pages/AchievementsAdminPage.tsx.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      achievement_admin_thresholdOverride_label: 'Threshold',
      achievement_admin_table_role: 'Discord Role',
      achievement_admin_roleMapping_none: 'No role',
      achievement_admin_roleMapping_existing: 'Use existing role',
      achievement_admin_roleMapping_autoCreate: 'Auto-create role',
      achievement_admin_roleMapping_botMissingPermission: 'Bot missing permission',
      achievement_admin_thresholdOverride_destructiveConfirm:
        'I understand {count} players will lose this achievement',
      achievement_admin_qualifyingCount: '{count} members qualify',
      achievement_admin_cancel: 'Cancel',
      achievement_admin_save: 'Save',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: vi.fn(() => ({
      pipe: vi.fn(() => ({
        // biome-ignore lint/suspicious/noThenProperty: intentional thenable mock standing in for an Effect pipe result
        then: vi.fn(),
        catch: vi.fn(),
      })),
    })),
  },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: vi.fn(() => vi.fn(() => new Promise(() => {}))),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// Dynamic import AFTER mocks — will fail until EditBuiltInSheet is exported
const { EditBuiltInSheet } = await import('~/components/pages/AchievementsAdminPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;

function makeAchievement(effectiveThreshold: number, name = 'First Goal') {
  return {
    keyOrId: 'first_activity' as any,
    name,
    description: 'Log your first activity',
    titleKey: Option.none() as any,
    descriptionKey: Option.none() as any,
    kind: 'built_in' as const,
    ruleKind: 'total_activities' as const,
    effectiveThreshold,
    defaultThreshold: Option.some(1) as any,
    discordRoleId: Option.none() as any,
    isBuiltIn: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EditBuiltInSheet', () => {
  describe('Test 1 — threshold input shows effectiveThreshold from achievement', () => {
    it('renders threshold input with value 5 from achievement A', () => {
      render(
        <EditBuiltInSheet
          achievement={makeAchievement(5)}
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      const thresholdInput = document.body.querySelector(
        '#threshold-input',
      ) as HTMLInputElement | null;
      expect(thresholdInput).not.toBeNull();
      expect(thresholdInput?.value).toBe('5');
    });
  });

  describe('Test 2 — STALE-STATE REGRESSION GUARD: threshold updates when achievement changes while open', () => {
    it('updates threshold input when achievement changes from A (5) to B (10) while re-opened', async () => {
      const achievementA = makeAchievement(5, 'First Goal');
      const achievementB = makeAchievement(10, 'Second Goal');

      const { rerender } = render(
        <EditBuiltInSheet
          achievement={achievementA}
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      // Verify initial value
      const inputAfterA = document.body.querySelector(
        '#threshold-input',
      ) as HTMLInputElement | null;
      expect(inputAfterA).not.toBeNull();
      expect(inputAfterA?.value).toBe('5');

      // Close the sheet
      rerender(
        <EditBuiltInSheet
          achievement={achievementA}
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      // Re-open with achievement B — stale state regression guard
      rerender(
        <EditBuiltInSheet
          achievement={achievementB}
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      await waitFor(() => {
        const inputAfterB = document.body.querySelector(
          '#threshold-input',
        ) as HTMLInputElement | null;
        expect(inputAfterB).not.toBeNull();
        expect(inputAfterB?.value).toBe('10');
      });
    });
  });

  describe('Test 3 — OVERLAY TEARDOWN: sheet-overlay removed when closed', () => {
    it('sheet overlay is present when open=true and removed when open=false', async () => {
      const { rerender } = render(
        <EditBuiltInSheet
          achievement={makeAchievement(5)}
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      expect(document.body.querySelector("[data-slot='sheet-overlay']")).not.toBeNull();

      rerender(
        <EditBuiltInSheet
          achievement={makeAchievement(5)}
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(document.body.querySelector("[data-slot='sheet-overlay']")).toBeNull();
      });
    });
  });

  describe('Test 4 — cancel button calls onClose', () => {
    it('clicking Cancel calls onClose exactly once', () => {
      const onClose = vi.fn();
      render(
        <EditBuiltInSheet
          achievement={makeAchievement(5)}
          teamId={TEAM_ID}
          open={true}
          onClose={onClose}
          onSaved={vi.fn()}
        />,
      );

      const cancelButton = screen.getByRole('button', { name: /^Cancel$/i });
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
