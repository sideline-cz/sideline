// TDD mode — tests written BEFORE ActivityTypeFormDialog is exported.
// These tests WILL FAIL until the developer adds `export` to ActivityTypeFormDialog
// in applications/web/src/components/pages/ActivityTypesPage.tsx.

import { render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      activityType_name: 'Name',
      activityType_namePlaceholder: 'e.g. Running',
      activityType_emoji: 'Emoji',
      activityType_emojiHelp: 'Single emoji character',
      activityType_emojiRequired: 'Emoji is required',
      activityType_description: 'Description',
      activityType_descriptionPlaceholder: 'What is this activity type?',
      activityType_create: 'Create',
      activityType_creating: 'Creating…',
      activityType_created: 'Activity type created',
      activityType_edit: 'Edit',
      activityType_save: 'Save',
      activityType_saving: 'Saving…',
      activityType_saved: 'Activity type saved',
      activityType_nameAlreadyTaken: 'Name already taken',
      achievement_admin_cancel: 'Cancel',
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
  SilentClientError: class {
    constructor(public props: { message: string }) {}
  },
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

// Dynamic import AFTER mocks — will fail until ActivityTypeFormDialog is exported
const { ActivityTypeFormDialog } = await import('~/components/pages/ActivityTypesPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = 'team-1' as any;

function makeEditing(name: string) {
  return {
    id: 'at-1' as any,
    teamId: Option.none() as any,
    name,
    slug: Option.none() as any,
    emoji: Option.none() as any,
    description: Option.none() as any,
    usageCount: 0,
  };
}

function renderDialog(props: Record<string, unknown>) {
  return render(
    <ActivityTypeFormDialog
      teamId={TEAM_ID}
      open={false}
      onClose={vi.fn()}
      onSaved={vi.fn()}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityTypeFormDialog', () => {
  describe('Test 1 — editing prop pre-populates name field', () => {
    it('renders name input with the editing activity type name when open=true', () => {
      renderDialog({ open: true, editing: makeEditing('Yoga') });

      const nameInput = screen.getByDisplayValue('Yoga') as HTMLInputElement;
      expect(nameInput).not.toBeNull();
      expect(nameInput.value).toBe('Yoga');
    });
  });

  describe('Test 2 — RESET-ON-OPEN: name field updates when editing changes while open', () => {
    it('updates name field when editing prop changes from A to B while open', async () => {
      const editingA = makeEditing('Yoga');
      const editingB = makeEditing('Pilates');

      const { rerender } = render(
        <ActivityTypeFormDialog
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingA}
        />,
      );

      // Open with editing A
      rerender(
        <ActivityTypeFormDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingA}
        />,
      );

      await waitFor(() => {
        expect((screen.getByDisplayValue('Yoga') as HTMLInputElement).value).toBe('Yoga');
      });

      // Switch to editing B while open — stale state regression guard
      rerender(
        <ActivityTypeFormDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={editingB}
        />,
      );

      await waitFor(() => {
        const input = document.body.querySelector('input[name="name"]') as HTMLInputElement | null;
        expect(input).not.toBeNull();
        expect(input?.value).toBe('Pilates');
      });
    });
  });

  describe('Test 3 — OVERLAY TEARDOWN: dialog-overlay removed when closed', () => {
    it('overlay is present when open=true and removed when open=false', async () => {
      const { rerender } = render(
        <ActivityTypeFormDialog
          teamId={TEAM_ID}
          open={true}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={makeEditing('Yoga')}
        />,
      );

      // Overlay should be present
      expect(document.body.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();

      rerender(
        <ActivityTypeFormDialog
          teamId={TEAM_ID}
          open={false}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          editing={makeEditing('Yoga')}
        />,
      );

      await waitFor(() => {
        expect(document.body.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      });
    });
  });

  describe('Test 4 — create mode: name field is empty', () => {
    it('renders empty name field when editing is undefined (create mode)', () => {
      renderDialog({ open: true, editing: undefined });

      // The name input should exist and be empty
      const nameInput = document.body.querySelector(
        'input[name="name"]',
      ) as HTMLInputElement | null;
      expect(nameInput).not.toBeNull();
      expect(nameInput?.value).toBe('');
    });
  });
});
