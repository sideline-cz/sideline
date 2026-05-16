// Tests for AssignFeeDialog.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      assign_fee_dialog_title: 'Assign members to fee',
      assign_fee_dialog_submit: 'Assign',
      assign_fee_dialog_cancel: 'Cancel',
      assign_fee_dialog_noMembers: 'No members available',
      assign_fee_dialog_searchPlaceholder: 'Search members...',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

const { AssignFeeDialog } = await import('~/components/organisms/AssignFeeDialog.js');

type FeeView = {
  feeId: string;
  teamId: string;
  name: string;
  description: any;
  amountMinor: number;
  currency: string;
  dueAt: any;
  targetScope: string;
  archivedAt: any;
  assignmentCount: number;
  paidCount: number;
  pendingCount: number;
  overdueCount: number;
};

const SAMPLE_FEE: FeeView = {
  feeId: 'fee-1',
  teamId: 'team-1',
  name: 'Annual Fee',
  description: Option.none(),
  amountMinor: 5000,
  currency: 'CZK',
  dueAt: Option.none(),
  targetScope: 'custom',
  archivedAt: Option.none(),
  assignmentCount: 0,
  paidCount: 0,
  pendingCount: 0,
  overdueCount: 0,
};

const SAMPLE_MEMBERS = [
  { teamMemberId: 'member-1', name: 'Alice Smith' },
  { teamMemberId: 'member-2', name: 'Bob Jones' },
];

function renderDialog(
  props: Partial<Parameters<typeof AssignFeeDialog>[0]> = {},
  onSubmit = vi.fn(),
  onCancel = vi.fn(),
) {
  render(
    <AssignFeeDialog
      open={true}
      fee={SAMPLE_FEE}
      members={SAMPLE_MEMBERS}
      onSubmit={onSubmit}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onSubmit, onCancel };
}

describe('AssignFeeDialog', () => {
  it('renders with member list', () => {
    renderDialog();
    expect(screen.getByText('Alice Smith')).not.toBeNull();
    expect(screen.getByText('Bob Jones')).not.toBeNull();
  });

  it('shows fee name in dialog title', () => {
    renderDialog();
    expect(screen.getByText(/Annual Fee/i)).not.toBeNull();
  });

  it('Submit is disabled when no members selected', () => {
    renderDialog();
    const submit = screen.getByRole('button', { name: /Assign/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
  });

  it('Submit enabled after selecting a member', () => {
    renderDialog();
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    const submit = screen.getByRole('button', { name: /Assign/i });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it('Submit calls onSubmit with selected member IDs', async () => {
    const { onSubmit } = renderDialog();
    const checkboxes = screen.getAllByRole('checkbox');
    // Select first member
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole('button', { name: /Assign/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
      const req = onSubmit.mock.calls[0][0];
      expect(req.memberIds).toHaveLength(1);
      expect(req.memberIds[0]).toBe('member-1');
      expect(Option.isNone(req.amountMinorOverride)).toBe(true);
      expect(Option.isNone(req.dueAtOverride)).toBe(true);
    });
  });

  it('Submit calls onSubmit with multiple selected member IDs', async () => {
    const { onSubmit } = renderDialog();
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(screen.getByRole('button', { name: /Assign/i }));
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
      const req = onSubmit.mock.calls[0][0];
      expect(req.memberIds).toHaveLength(2);
    });
  });

  it('Cancel button calls onCancel and does not call onSubmit', () => {
    const { onSubmit, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows no-members message when member list is empty', () => {
    renderDialog({ members: [] });
    expect(screen.getByText('No members available')).not.toBeNull();
  });

  it('filters members by search', () => {
    renderDialog();
    const searchInput = screen.getByPlaceholderText('Search members...');
    fireEvent.change(searchInput, { target: { value: 'Alice' } });
    expect(screen.getByText('Alice Smith')).not.toBeNull();
    expect(screen.queryByText('Bob Jones')).toBeNull();
  });
});
