// Covers the missing-invoice nudge (plan §7e) now that it rides on the shared list toolbar:
// the standalone toggle became a filter chip in `EXPENSE_FILTERS`, while the "No invoice" row
// badge stayed — the two read the same condition and these tests pin them together.
//
// Shape follows `BankTransactionsPage.test.tsx`: plain `@testing-library/react` over the page
// component, with `tr` mocked to echo its key (so assertions pin the KEY, not the English copy).

import { ExpenseApi } from '@sideline/domain';
import { fireEvent, render, screen } from '@testing-library/react';
import { Schema } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    if (!params) return key;
    return key.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

const { ExpensesListPage } = await import('~/components/pages/ExpensesListPage.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ATTACHMENT = {
  attachmentId: '55555555-5555-4555-8555-555555555555',
  filename: 'invoice.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
};

const makeExpense = (overrides: {
  expenseId: string;
  description: string;
  attachments?: ReadonlyArray<unknown>;
  spentAt?: string;
  amountMinor?: number;
}): ExpenseApi.ExpenseView =>
  Schema.decodeUnknownSync(ExpenseApi.ExpenseView)({
    expenseId: overrides.expenseId,
    teamId: '11111111-1111-4111-8111-111111111111',
    amountMinor: overrides.amountMinor ?? 25_000,
    currency: 'CZK',
    spentAt: overrides.spentAt ?? '2025-05-01T12:00:00.000Z',
    category: 'fields',
    description: overrides.description,
    bankTransactionId: null,
    createdByUserId: '22222222-2222-4222-8222-222222222222',
    createdByName: null,
    updatedByUserId: '22222222-2222-4222-8222-222222222222',
    updatedByName: null,
    createdAt: overrides.spentAt ?? '2025-05-01T12:00:00.000Z',
    updatedAt: '2025-05-01T12:00:00.000Z',
    attachments: overrides.attachments ?? [],
  });

const WITHOUT = makeExpense({ expenseId: 'exp-without', description: 'Pitch rent' });
const WITH = makeExpense({
  expenseId: 'exp-with',
  description: 'Tournament fee',
  attachments: [ATTACHMENT],
});

type Props = Parameters<typeof ExpensesListPage>[0];

function renderPage(overrides: Partial<Props> = {}) {
  const props = {
    expenses: [WITHOUT, WITH],
    canManageExpenses: true,
    fromFilter: '',
    toFilter: '',
    categoryFilter: [],
    onFromFilterChange: vi.fn(),
    onToFilterChange: vi.fn(),
    onCategoryFilterChange: vi.fn(),
    onClearFilters: vi.fn(),
    ...overrides,
  } as Props;
  return { props, ...render(<ExpensesListPage {...props} />) };
}

const chip = () => screen.getByRole('button', { name: 'expenses_filter_missingInvoice' });
// `slice(1)` drops the header row.
const bodyRowText = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent ?? '');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExpensesListPage — missing-invoice nudge', () => {
  it('should badge only the rows with no attachments', () => {
    renderPage();

    const badges = screen.getAllByText('expenses_badge_noInvoice');
    expect(badges).toHaveLength(1);
    expect(badges[0].closest('tr')?.textContent).toContain('Pitch rent');
  });

  it('should show no badge on a row that already has an attachment', () => {
    renderPage({ expenses: [WITH] });

    expect(screen.queryByText('expenses_badge_noInvoice')).toBeNull();
  });

  it('should keep every row the missing-invoice chip matches badged', () => {
    renderPage();

    expect(chip().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-pressed')).toBe('true');

    // Only the un-invoiced row survives, and it is the badged one.
    expect(screen.getByText('Pitch rent')).not.toBeNull();
    expect(screen.queryByText('Tournament fee')).toBeNull();
    expect(screen.getAllByText('expenses_badge_noInvoice')).toHaveLength(1);
  });

  it('should count the chip as a filter so Clear filters is offered', () => {
    // Without this the chip can be left on with no visible way to clear it.
    renderPage();
    expect(screen.queryByText('expenses_clearFilters')).toBeNull();

    fireEvent.click(chip());
    expect(screen.queryByText('expenses_clearFilters')).not.toBeNull();
  });

  it('should say nothing matched rather than offering to log a first expense', () => {
    renderPage({ expenses: [WITH] });

    fireEvent.click(chip());

    expect(screen.getByText('list_noMatches')).not.toBeNull();
    expect(screen.queryByText('expenses_empty_title')).toBeNull();
  });
});

describe('ExpensesListPage — toolbar', () => {
  it('should default to newest-spent-first, matching the server ordering', () => {
    const older = makeExpense({
      expenseId: 'exp-older',
      description: 'Older expense',
      spentAt: '2025-01-01T00:00:00.000Z',
    });
    const newer = makeExpense({
      expenseId: 'exp-newer',
      description: 'Newer expense',
      spentAt: '2025-09-01T00:00:00.000Z',
    });
    // Deliberately handed over out of order: the default sort has to restore it.
    renderPage({ expenses: [older, newer] });

    const body = bodyRowText();
    expect(body[0]).toContain('Newer expense');
    expect(body[1]).toContain('Older expense');
  });

  it('should narrow the list by search and report no matches for a miss', () => {
    renderPage();

    const search = screen.getByPlaceholderText('expenses_searchPlaceholder');
    fireEvent.change(search, { target: { value: 'tournament' } });
    expect(screen.queryByText('Pitch rent')).toBeNull();
    expect(screen.getByText('Tournament fee')).not.toBeNull();

    fireEvent.change(search, { target: { value: 'nothing here' } });
    expect(screen.getByText('list_noMatches')).not.toBeNull();
  });

  it('should show the first-expense empty state only when nothing is filtered', () => {
    renderPage({ expenses: [] });

    expect(screen.getByText('expenses_empty_title')).not.toBeNull();
    expect(screen.queryByText('list_noMatches')).toBeNull();
  });
});
