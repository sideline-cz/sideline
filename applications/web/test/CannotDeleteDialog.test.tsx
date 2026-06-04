// TDD mode — tests written BEFORE CannotDeleteDialog is exported.
// These tests WILL FAIL until the developer adds `export` to CannotDeleteDialog
// in applications/web/src/components/pages/ActivityTypesPage.tsx.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      activityType_cannotDelete_title: params?.name
        ? `Cannot delete "${String(params.name)}"`
        : 'Cannot delete',
      activityType_cannotDelete_body:
        params?.count !== undefined ? `Used in ${String(params.count)} activities` : 'In use',
      activityType_cannotDelete_rename: 'Rename instead',
      achievement_admin_cancel: 'Cancel',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

// Dynamic import AFTER mocks — will fail until CannotDeleteDialog is exported
const { CannotDeleteDialog } = await import('~/components/pages/ActivityTypesPage.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CannotDeleteDialog', () => {
  describe('Test 1 — renders name and usageCount', () => {
    it('shows activity type name and usage count when open', () => {
      render(
        <CannotDeleteDialog
          open={true}
          name='Yoga'
          usageCount={3}
          onClose={vi.fn()}
          onRename={vi.fn()}
        />,
      );

      // Should contain name somewhere
      const body = document.body.textContent ?? '';
      expect(body).toContain('Yoga');
      expect(body).toContain('3');
    });
  });

  describe('Test 2 — rename button calls onRename', () => {
    it('clicking the rename button calls onRename exactly once', () => {
      const onRename = vi.fn();
      const onClose = vi.fn();

      render(
        <CannotDeleteDialog
          open={true}
          name='Yoga'
          usageCount={3}
          onClose={onClose}
          onRename={onRename}
        />,
      );

      const renameButton = screen.getByRole('button', { name: /Rename instead/i });
      fireEvent.click(renameButton);

      expect(onRename).toHaveBeenCalledOnce();
    });
  });

  describe('Test 3 — cancel/close button calls onClose', () => {
    it('clicking the Cancel button calls onClose exactly once and not onRename', () => {
      const onRename = vi.fn();
      const onClose = vi.fn();

      render(
        <CannotDeleteDialog
          open={true}
          name='Yoga'
          usageCount={3}
          onClose={onClose}
          onRename={onRename}
        />,
      );

      const cancelButton = screen.getByRole('button', { name: /^Cancel$/i });
      fireEvent.click(cancelButton);

      expect(onClose).toHaveBeenCalledOnce();
      expect(onRename).not.toHaveBeenCalled();
    });
  });

  describe('Test 4 — OVERLAY TEARDOWN: dialog-overlay removed when closed', () => {
    it('overlay is present when open=true and removed when open=false', async () => {
      const { rerender } = render(
        <CannotDeleteDialog
          open={true}
          name='Yoga'
          usageCount={3}
          onClose={vi.fn()}
          onRename={vi.fn()}
        />,
      );

      expect(document.body.querySelector("[data-slot='dialog-overlay']")).not.toBeNull();

      rerender(
        <CannotDeleteDialog
          open={false}
          name='Yoga'
          usageCount={3}
          onClose={vi.fn()}
          onRename={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(document.body.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      });
    });
  });
});
