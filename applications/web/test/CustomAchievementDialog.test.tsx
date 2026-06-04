// TDD mode — tests written BEFORE CustomAchievementDialog is exported.
// These tests WILL FAIL until the developer adds `export` to CustomAchievementDialog
// in applications/web/src/components/pages/AchievementsAdminPage.tsx.

import { render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      achievement_admin_table_name: 'Name',
      achievement_admin_table_description: 'Description',
      achievement_admin_table_emoji: 'Emoji',
      achievement_admin_table_rule: 'Rule',
      achievement_admin_table_role: 'Discord Role',
      achievement_admin_thresholdOverride_label: 'Threshold',
      achievement_admin_rule_total_activities: 'Total activities',
      achievement_admin_rule_longest_streak: 'Longest streak',
      achievement_admin_rule_total_duration: 'Total duration',
      achievement_admin_rule_activity_type_count: 'Activity type count',
      achievement_admin_roleMapping_none: 'No role',
      achievement_admin_roleMapping_existing: 'Use existing role',
      achievement_admin_roleMapping_autoCreate: 'Auto-create role',
      achievement_admin_custom_edit: 'Edit',
      achievement_admin_custom_create: 'Create achievement',
      achievement_admin_custom_nameTaken: 'Name already taken',
      achievement_admin_cancel: 'Cancel',
      achievement_admin_save: 'Save',
      validation_required: 'Required',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/runtime', () => ({
  ApiClient: {
    asEffect: vi.fn(() => ({
      pipe: vi.fn(),
    })),
  },
  ClientError: { make: (msg: string) => ({ _tag: 'ClientError', message: msg }) },
  useRun: vi.fn(() => vi.fn(() => new Promise(() => {}))),
}));

vi.mock('~/lib/form', () => ({
  withFieldErrors: vi.fn(() => (effect: unknown) => effect),
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: vi.fn() }),
  Link: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...props}>{children}</a>
  ),
}));

// Dynamic import AFTER mocks — will fail until CustomAchievementDialog is exported
const { CustomAchievementDialog } = await import('~/components/pages/AchievementsAdminPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;

function makeEditing(name: string, effectiveThreshold: number, description = 'A description') {
  return {
    keyOrId: 'custom-abc-123',
    name,
    description,
    titleKey: Option.none() as any,
    descriptionKey: Option.none() as any,
    kind: 'custom' as const,
    ruleKind: 'total_activities' as const,
    effectiveThreshold,
    defaultThreshold: Option.none() as any,
    discordRoleId: Option.none() as any,
    isBuiltIn: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomAchievementDialog', () => {
  describe('Test 1 — editing prop pre-populates name and threshold fields', () => {
    it('renders name "Marathon" and threshold "5" when editing achievement A', () => {
      const editingA = makeEditing('Marathon', 5, 'Run a marathon');

      render(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingA}
        />,
      );

      // Name field
      const nameInput = screen.getByDisplayValue('Marathon') as HTMLInputElement;
      expect(nameInput).not.toBeNull();
      expect(nameInput.value).toBe('Marathon');

      // Threshold field
      const thresholdInput = screen.getByDisplayValue('5') as HTMLInputElement;
      expect(thresholdInput).not.toBeNull();
      expect(thresholdInput.value).toBe('5');
    });
  });

  describe('Test 2 — STALE-FORM REGRESSION GUARD: form updates when editing changes', () => {
    it('updates name and threshold when editing changes from A to B through close/reopen', async () => {
      const editingA = makeEditing('Marathon', 5);
      const editingB = makeEditing('Sprint', 10);

      const { rerender } = render(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingA}
        />,
      );

      // Verify initial state
      await waitFor(() => {
        expect((screen.getByDisplayValue('Marathon') as HTMLInputElement).value).toBe('Marathon');
      });

      // Close
      rerender(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingA}
        />,
      );

      // Re-open with editing B — stale state regression guard
      rerender(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingB}
        />,
      );

      await waitFor(() => {
        const nameInput = document.body.querySelector(
          'input[name="name"]',
        ) as HTMLInputElement | null;
        expect(nameInput).not.toBeNull();
        expect(nameInput?.value).toBe('Sprint');
      });

      await waitFor(() => {
        const thresholdInput = document.body.querySelector(
          'input[name="threshold"]',
        ) as HTMLInputElement | null;
        expect(thresholdInput).not.toBeNull();
        expect(thresholdInput?.value).toBe('10');
      });
    });
  });

  describe('Test 3 — create mode: name empty, threshold defaults to 1', () => {
    it('renders empty name and threshold of 1 when editing is undefined', () => {
      render(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={undefined}
        />,
      );

      const nameInput = document.body.querySelector(
        'input[name="name"]',
      ) as HTMLInputElement | null;
      expect(nameInput).not.toBeNull();
      expect(nameInput?.value).toBe('');

      const thresholdInput = document.body.querySelector(
        'input[name="threshold"]',
      ) as HTMLInputElement | null;
      expect(thresholdInput).not.toBeNull();
      expect(thresholdInput?.value).toBe('1');
    });
  });

  describe('Test 4 — OVERLAY TEARDOWN: dialog-overlay removed when closed', () => {
    it('overlay is present when open=true and removed when open=false', async () => {
      const { rerender } = render(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={makeEditing('Marathon', 5)}
        />,
      );

      expect(document.body.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();

      rerender(
        <CustomAchievementDialog
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={makeEditing('Marathon', 5)}
        />,
      );

      await waitFor(() => {
        expect(document.body.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      });
    });
  });
});
