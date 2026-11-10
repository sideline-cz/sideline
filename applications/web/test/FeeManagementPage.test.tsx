// TDD mode — tests written BEFORE the FeeManagementPage component exists.
// These tests WILL FAIL until the developer implements:
//   - applications/web/src/components/pages/FeeManagementPage.tsx
//
// Assumed component contract:
//   FeeManagementPage({
//     fees: FeeView[],
//     canManageFees: boolean,
//     onCreateFee?: () => void,
//     onEditFee?: (fee: FeeView) => void,
//     onArchiveFee?: (feeId: string) => void,
//   })
//
// FeeView shape (mirroring domain):
//   { feeId, teamId, name, amountMinor, currency, dueAt, targetScope,
//     archivedAt, assignmentCount, paidCount, pendingCount, overdueCount }
//
// The page should:
//  - show a list of fees with name, formatted amount, due date, and assignment progress
//  - show empty state copy and optionally a "Create fee" CTA based on canManageFees
//  - show Edit + Archive actions per row only when canManageFees=true
//  - NOT show archived fees (filter applied by caller/loader or component itself)

import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => {
    const map: Record<string, string> = {
      fee_management_title: 'Fees',
      fee_management_empty: 'No fees yet',
      fee_management_createFee: 'Create fee',
      fee_management_editFee: 'Edit',
      fee_management_archiveFee: 'Archive',
      fee_management_colName: 'Name',
      fee_management_colAmount: 'Amount',
      fee_management_colDue: 'Due',
      fee_management_colProgress: 'Progress',
      fee_management_actions: 'Actions',
      fee_import_button: 'Import CSV',
    };
    return map[key] ?? key;
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

// Dynamic import — will fail until the component exists
const { FeeManagementPage } = await import('~/components/pages/FeeManagementPage.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEE_ANNUAL: FeeView = {
  feeId: 'fee-1',
  teamId: 'team-1',
  name: 'Annual Fee',
  description: Option.none(),
  amountMinor: 100000,
  currency: 'CZK',
  dueAt: Option.none(),
  targetScope: 'all_members',
  archivedAt: Option.none(),
  assignmentCount: 10,
  paidCount: 7,
  pendingCount: 3,
  overdueCount: 0,
};

const FEE_EQUIPMENT: FeeView = {
  feeId: 'fee-2',
  teamId: 'team-1',
  name: 'Equipment Fee',
  description: Option.none(),
  amountMinor: 50000,
  currency: 'CZK',
  dueAt: Option.none(),
  targetScope: 'all_members',
  archivedAt: Option.none(),
  assignmentCount: 5,
  paidCount: 2,
  pendingCount: 3,
  overdueCount: 0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeManagementPage', () => {
  describe('empty state', () => {
    it('shows "No fees yet" when fees=[] and canManageFees=false (no Create button)', () => {
      render(<FeeManagementPage fees={[]} canManageFees={false} />);
      expect(screen.getByText(/No fees yet/i)).not.toBeNull();
      expect(screen.queryByText(/Create fee/i)).toBeNull();
    });

    it('shows "Create fee" button when fees=[] and canManageFees=true', () => {
      const onCreateFee = vi.fn();
      render(<FeeManagementPage fees={[]} canManageFees={true} onCreateFee={onCreateFee} />);
      expect(screen.getByText(/No fees yet/i)).not.toBeNull();
      const btn = screen.getByText(/Create fee/i);
      expect(btn).not.toBeNull();
    });

    it('clicking "Create fee" in empty state calls onCreateFee', async () => {
      const onCreateFee = vi.fn();
      render(<FeeManagementPage fees={[]} canManageFees={true} onCreateFee={onCreateFee} />);
      const btn = screen.getByText(/Create fee/i);
      fireEvent.click(btn);
      expect(onCreateFee).toHaveBeenCalledOnce();
    });
  });

  describe('import button', () => {
    it.each([[[]], [[FEE_ANNUAL]]])(
      'shows "Import CSV" only when canManageFees (fees=%j)',
      (fees) => {
        const onImportFees = vi.fn();
        const { unmount } = render(<FeeManagementPage fees={fees} canManageFees={false} />);
        expect(screen.queryByRole('button', { name: 'Import CSV' })).toBeNull();
        unmount();

        render(<FeeManagementPage fees={fees} canManageFees={true} onImportFees={onImportFees} />);
        fireEvent.click(screen.getByRole('button', { name: 'Import CSV' }));
        expect(onImportFees).toHaveBeenCalledOnce();
      },
    );
  });

  describe('fee list rendering', () => {
    it('renders one row per fee with name and formatted amount', () => {
      render(<FeeManagementPage fees={[FEE_ANNUAL, FEE_EQUIPMENT]} canManageFees={false} />);
      expect(screen.getByText('Annual Fee')).not.toBeNull();
      expect(screen.getByText('Equipment Fee')).not.toBeNull();
      // formatMoney mock: 100000 / 100 = 1000 CZK, 50000 / 100 = 500 CZK
      expect(screen.getByText(/1000 CZK/)).not.toBeNull();
      expect(screen.getByText(/500 CZK/)).not.toBeNull();
    });

    it('renders assignment progress as "paidCount / assignmentCount"', () => {
      render(<FeeManagementPage fees={[FEE_ANNUAL]} canManageFees={false} />);
      // 7 paid of 10 assigned → should show "7 / 10" or "7/10" somewhere
      const progress = document.body.textContent;
      expect(progress).toMatch(/7\s*\/\s*10/);
    });

    it('shows Edit and Archive actions when canManageFees=true', () => {
      render(<FeeManagementPage fees={[FEE_ANNUAL]} canManageFees={true} />);
      expect(screen.getAllByText(/Edit/i).length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Archive/i).length).toBeGreaterThan(0);
    });

    it('does NOT show Edit or Archive when canManageFees=false', () => {
      render(<FeeManagementPage fees={[FEE_ANNUAL, FEE_EQUIPMENT]} canManageFees={false} />);
      expect(screen.queryByText(/Edit/i)).toBeNull();
      expect(screen.queryByText(/Archive/i)).toBeNull();
    });

    it('clicking Edit calls onEditFee with the fee', async () => {
      const onEditFee = vi.fn();
      render(<FeeManagementPage fees={[FEE_ANNUAL]} canManageFees={true} onEditFee={onEditFee} />);
      const editBtns = screen.getAllByText(/Edit/i);
      fireEvent.click(editBtns[0]);
      expect(onEditFee).toHaveBeenCalledWith(FEE_ANNUAL);
    });

    it('clicking Archive calls onArchiveFee with the feeId', async () => {
      const onArchiveFee = vi.fn();
      render(
        <FeeManagementPage fees={[FEE_ANNUAL]} canManageFees={true} onArchiveFee={onArchiveFee} />,
      );
      const archiveBtns = screen.getAllByText(/Archive/i);
      fireEvent.click(archiveBtns[0]);
      expect(onArchiveFee).toHaveBeenCalledWith(FEE_ANNUAL.feeId);
    });

    it('does NOT render archived fees (archivedAt is Some)', () => {
      const archivedFee: FeeView = {
        ...FEE_ANNUAL,
        feeId: 'fee-archived',
        name: 'Should Not Show',
        archivedAt: Option.some(new Date()),
      };
      render(<FeeManagementPage fees={[archivedFee]} canManageFees={false} />);
      expect(screen.queryByText('Should Not Show')).toBeNull();
    });
  });
});
