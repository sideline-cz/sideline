import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DateTime, Option } from 'effect';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Radix UI Select uses scrollIntoView which is not implemented in JSDOM.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Module mocks — before any imports using them
// ---------------------------------------------------------------------------

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      expense_form_title_create: 'Add Expense',
      expense_form_title_edit: 'Edit Expense',
      expense_form_amount: 'Amount',
      expense_form_currency: 'Currency',
      expense_form_date: 'Date',
      expense_form_category: 'Category',
      expense_form_description: 'Description',
      expense_form_submit_create: 'Add Expense',
      expense_form_submit_edit: 'Save Changes',
      expense_form_cancel: 'Cancel',
      expense_form_validation_amountRequired: 'Amount must be positive',
      expense_form_validation_descriptionTooLong: 'Description too long (max 500 chars)',
      expense_form_warning_futureDate: 'Expense date is in the future',
      expense_form_descriptionPlaceholder: 'Optional note about this expense',
      expense_category_fields: 'Fields',
      expense_category_equipment: 'Equipment',
      expense_category_travel: 'Travel',
      expense_category_tournaments: 'Tournaments',
      expense_category_other: 'Other',
      expense_form_saving: 'Saving…',
      expense_attachments_title: 'Invoices',
      expense_attachments_hint: 'PDF, JPEG, PNG or HEIC, up to 5 MB',
      expense_attachments_empty: 'No invoice attached yet',
      expense_attachments_pending: 'Will be attached when you save',
      expense_attachments_download: 'Download',
      expense_attachments_downloadAria: 'Download {filename}',
      expense_attachments_remove: 'Remove',
      expense_attachments_removeAria: 'Remove {filename}',
      expense_attachments_deleteConfirm_title: 'Remove this invoice?',
      expense_attachments_deleteConfirm_description:
        '{filename} will be permanently deleted. This cannot be undone.',
      expense_attachments_deleteConfirm_action: 'Remove invoice',
    };
    const template = map[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  },
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/finance/formatMoney.js', () => ({
  formatMoney: (minor: number, currency: string) => `${minor / 100} ${currency}`,
}));

vi.mock('~/lib/finance/parseAmount.js', () => ({
  parseAmount: (value: string, _currency?: string) => {
    const parsed = Number(value.trim());
    if (Number.isNaN(parsed) || parsed <= 0) throw new Error('Amount must be greater than 0');
    return Math.round(parsed * 100);
  },
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks)
// ---------------------------------------------------------------------------

const { ExpenseFormDialog } = await import('~/components/organisms/ExpenseFormDialog.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type ExpenseCategory = 'fields' | 'equipment' | 'travel' | 'tournaments' | 'other';

type AttachmentMeta = {
  attachmentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

type ExpenseView = {
  expenseId: string;
  teamId: string;
  amountMinor: number;
  currency: string;
  spentAt: DateTime.Utc;
  category: ExpenseCategory;
  description: string;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: DateTime.Utc;
  updatedAt: DateTime.Utc;
  attachments: ReadonlyArray<AttachmentMeta>;
};

type CreateExpenseRequest = {
  amountMinor: number;
  currency: string;
  spentAt: DateTime.Utc;
  category: ExpenseCategory;
  description: string;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SPENT_AT = DateTime.fromDateUnsafe(new Date('2025-05-01T12:00:00Z'));

function makeExpense(overrides: Partial<ExpenseView> = {}): ExpenseView {
  return {
    expenseId: 'exp-1',
    teamId: 'team-1',
    amountMinor: 1050,
    currency: 'CZK',
    spentAt: SPENT_AT,
    category: 'travel',
    description: 'Test expense',
    createdByUserId: 'user-1',
    updatedByUserId: 'user-1',
    createdAt: SPENT_AT,
    updatedAt: SPENT_AT,
    attachments: [],
    ...overrides,
  };
}

const ATTACHMENT: AttachmentMeta = {
  attachmentId: 'att-1',
  filename: 'invoice.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1234,
};

const TEAM_ID = 'team-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCreate(onSubmit = vi.fn(), onCancel = vi.fn()) {
  return render(
    <ExpenseFormDialog
      open={true}
      mode='create'
      teamId={TEAM_ID}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
}

function renderCreateWithPrefill(
  prefill: {
    amountMinor?: number;
    currency?: 'CZK' | 'EUR' | 'USD';
    spentAt?: string;
    description?: string;
    bankTransactionId?: string;
  },
  onSubmit = vi.fn(),
  onCancel = vi.fn(),
) {
  return render(
    <ExpenseFormDialog
      open={true}
      mode='create'
      teamId={TEAM_ID}
      // biome-ignore lint/suspicious/noExplicitAny: the branded BankTransactionId is irrelevant here
      prefill={prefill as any}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
}

function renderEdit(expense: ExpenseView, onSubmit = vi.fn(), onCancel = vi.fn()) {
  return render(
    <ExpenseFormDialog
      open={true}
      mode='edit'
      expense={expense}
      teamId={TEAM_ID}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExpenseFormDialog', () => {
  it('renders all required fields: amount, currency, date, category, description', () => {
    renderCreate();

    // Amount field
    const amountLabel = screen.queryByText('Amount') ?? screen.queryByLabelText(/amount/i);
    expect(amountLabel).not.toBeNull();

    // Currency field
    const currencyLabel = screen.queryByText('Currency') ?? screen.queryByLabelText(/currency/i);
    expect(currencyLabel).not.toBeNull();

    // Date field
    const dateLabel = screen.queryByText('Date') ?? screen.queryByLabelText(/date/i);
    expect(dateLabel).not.toBeNull();

    // Category field
    const categoryLabel = screen.queryByText('Category') ?? screen.queryByLabelText(/category/i);
    expect(categoryLabel).not.toBeNull();

    // Description field
    const descriptionLabel =
      screen.queryByText('Description') ?? screen.queryByLabelText(/description/i);
    expect(descriptionLabel).not.toBeNull();
  });

  it('submitting with amount "10.50" calls onSubmit with amountMinor 1050', async () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);

    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    expect(amountInput).not.toBeNull();
    fireEvent.change(amountInput!, { target: { value: '10.50' } });

    // Also fill in the date so the form schema passes (minLength(1))
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    if (dateInput) {
      fireEvent.change(dateInput, { target: { value: '2025-05-01' } });
    }

    // Submit the form
    const submitBtn = screen.getByText('Add Expense');
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    const arg = onSubmit.mock.calls[0][0] as CreateExpenseRequest;
    expect(arg.amountMinor).toBe(1050);
  });

  it('submitting with amount "0" shows inline validation error; onSubmit NOT called', async () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);

    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    fireEvent.change(amountInput!, { target: { value: '0' } });

    // Fill in the date so spentAt schema validation passes; only amountStr logic validation fails
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    if (dateInput) {
      fireEvent.change(dateInput, { target: { value: '2025-05-01' } });
    }

    // Submit via the form element directly to ensure submit event fires
    const formEl = document.querySelector('form') as HTMLFormElement | null;
    if (formEl) {
      fireEvent.submit(formEl);
    } else {
      const submitBtn = screen.getByText('Add Expense');
      fireEvent.click(submitBtn);
    }

    // Wait for the validation error to appear in the DOM
    await waitFor(() => {
      const pageText = document.body.textContent ?? '';
      expect(pageText).toMatch(/amount must be positive|Amount must be/i);
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submitting with description > 500 chars shows validation error; onSubmit NOT called', async () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);

    const textarea = document.querySelector('textarea');
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea!, { target: { value: 'a'.repeat(501) } });

    // Set a valid amount and date to avoid those errors
    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    fireEvent.change(amountInput!, { target: { value: '10' } });
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    if (dateInput) {
      fireEvent.change(dateInput, { target: { value: '2025-05-01' } });
    }

    const submitBtn = screen.getByText('Add Expense');
    fireEvent.click(submitBtn);

    // Wait for the validation error to appear in the DOM
    await waitFor(() => {
      const pageText = document.body.textContent ?? '';
      expect(pageText).toMatch(/too long|max 500/i);
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('category select shows all 5 expense categories when opened', () => {
    renderCreate();

    // Open the category Shadcn Select by its id attribute.
    // (The label's htmlFor links to the form-item element, not the trigger,
    //  so accessible-name lookup via role+name is unreliable in JSDOM.)
    const categoryTrigger = document.getElementById('expense-category') as HTMLButtonElement | null;
    expect(categoryTrigger).not.toBeNull();
    fireEvent.click(categoryTrigger!);

    // After opening, all options should be rendered in the portal.
    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('Fields');
    expect(pageText).toContain('Equipment');
    expect(pageText).toContain('Travel');
    expect(pageText).toContain('Tournaments');
    expect(pageText).toContain('Other');
  });

  it('in edit mode, fields are pre-populated from the provided expense', () => {
    const expense = makeExpense({
      amountMinor: 2500,
      currency: 'EUR',
      category: 'equipment',
      description: 'Pre-filled description',
    });

    renderEdit(expense);

    // Amount should be pre-filled (2500 minor = 25.00)
    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    expect(amountInput?.value).toBeTruthy();
    // Either raw minor value or formatted decimal — check it's not empty
    const pageText = document.body.textContent ?? '';
    expect(pageText).toContain('Pre-filled description');
    expect(pageText).toContain('EUR');
  });

  it('future-dated spent_at shows a soft warning but submit button stays enabled', () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);

    // Set a future date
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 10);
    const futureDateStr = futureDate.toISOString().split('T')[0]; // YYYY-MM-DD

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    if (dateInput) {
      fireEvent.change(dateInput, { target: { value: futureDateStr } });
    }

    // Submit button should still be enabled / present
    const submitBtn = screen.getByText('Add Expense');
    expect(submitBtn).not.toBeNull();
    expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

    // Warning text should appear in the DOM
    const pageText = document.body.textContent ?? '';
    expect(pageText).toMatch(/future/i);
  });

  it('cancel button calls onCancel without submitting', () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    renderCreate(onSubmit, onCancel);

    const cancelBtn = screen.getByText('Cancel');
    fireEvent.click(cancelBtn);

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Prefill from an outgoing bank movement
// ---------------------------------------------------------------------------

describe('ExpenseFormDialog — prefill from a bank movement', () => {
  const PREFILL = {
    amountMinor: 250_00,
    currency: 'CZK' as const,
    spentAt: '2025-06-03',
    description: 'Pitch Owner s.r.o. — June rent',
    bankTransactionId: 'tx-42',
  };

  it('seeds amount, date and description from the movement', () => {
    renderCreateWithPrefill(PREFILL);

    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    expect(amountInput?.value).toBe('250');

    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    expect(dateInput?.value).toBe('2025-06-03');

    const descriptionInput = document.querySelector('textarea') as HTMLTextAreaElement | null;
    expect(descriptionInput?.value).toBe('Pitch Owner s.r.o. — June rent');
  });

  it('carries bankTransactionId into the create request', async () => {
    const onSubmit = vi.fn();
    renderCreateWithPrefill(PREFILL, onSubmit);

    fireEvent.click(screen.getByText('Add Expense'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    const arg = onSubmit.mock.calls[0][0] as { bankTransactionId: Option.Option<string> };
    expect(Option.getOrNull(arg.bankTransactionId)).toBe('tx-42');
  });

  it('a hand-entered expense sends no bankTransactionId', async () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);

    const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement | null;
    fireEvent.change(amountInput!, { target: { value: '10' } });
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement | null;
    fireEvent.change(dateInput!, { target: { value: '2025-05-01' } });

    fireEvent.click(screen.getByText('Add Expense'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    const arg = onSubmit.mock.calls[0][0] as { bankTransactionId: Option.Option<string> };
    expect(Option.isNone(arg.bankTransactionId)).toBe(true);
  });

  // The category is intentionally NOT seeded from the movement: nothing in a bank transfer
  // implies one, so the treasurer still has to file it.
  it('does not guess a category — it submits the neutral default', async () => {
    const onSubmit = vi.fn();
    renderCreateWithPrefill(PREFILL, onSubmit);

    fireEvent.click(screen.getByText('Add Expense'));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    const arg = onSubmit.mock.calls[0][0] as { category: string };
    expect(arg.category).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Invoice attachments (plan §7d)
// ---------------------------------------------------------------------------

/** jsdom's `input.files` is read-only, so define it rather than letting fireEvent assign it. */
function selectFiles(input: HTMLInputElement, files: ReadonlyArray<File>) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (!input) throw new Error('ExpenseFormDialog must render a file input');
  return input;
}

function submitButton(): HTMLButtonElement {
  const button = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (!button) throw new Error('ExpenseFormDialog must render a submit button');
  return button;
}

function fillRequiredFields() {
  const amountInput = document.querySelector('input[type="number"]') as HTMLInputElement;
  fireEvent.change(amountInput, { target: { value: '10' } });
  const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
  fireEvent.change(dateInput, { target: { value: '2025-05-01' } });
}

function renderEditWithAttachments(
  attachments: ReadonlyArray<AttachmentMeta>,
  handlers: {
    // Deliberately loose: these are vi.fn() spies handed straight to props with
    // differing signatures, and `ReturnType<typeof vi.fn>` is assignable to none of them.
    onSubmit?: (...args: never[]) => unknown;
    onDownloadAttachment?: (...args: never[]) => unknown;
    onDeleteAttachment?: (...args: never[]) => unknown;
  } = {},
) {
  return render(
    <ExpenseFormDialog
      open={true}
      mode='edit'
      expense={makeExpense({ attachments })}
      teamId={TEAM_ID}
      onSubmit={(handlers.onSubmit ?? vi.fn()) as never}
      onCancel={vi.fn()}
      onDownloadAttachment={(handlers.onDownloadAttachment ?? vi.fn()) as never}
      onDeleteAttachment={(handlers.onDeleteAttachment ?? vi.fn()) as never}
    />,
  );
}

describe('ExpenseFormDialog — invoice attachments', () => {
  it('should hand staged files to onSubmit as the second argument', async () => {
    const onSubmit = vi.fn();
    renderCreate(onSubmit);
    fillRequiredFields();

    const file = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });
    selectFiles(fileInput(), [file]);

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });

    const files = onSubmit.mock.calls[0][1] as ReadonlyArray<File>;
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('invoice.pdf');
  });

  it('should call onSubmit with an empty array when no file is staged', async () => {
    // No blocking validation — the nudge is a badge, not a gate.
    const onSubmit = vi.fn();
    renderCreate(onSubmit);
    fillRequiredFields();

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledOnce();
    });
    expect(onSubmit.mock.calls[0][1]).toEqual([]);
  });

  it('should list existing attachments with labelled download and remove controls in edit mode', () => {
    renderEditWithAttachments([ATTACHMENT]);

    expect(screen.queryByText('invoice.pdf')).not.toBeNull();
    // sr-only labels — icon-only controls are forbidden without one.
    expect(screen.getByText('Download invoice.pdf')).not.toBeNull();
    expect(screen.getByText('Remove invoice.pdf')).not.toBeNull();
  });

  it('should call onDownloadAttachment with the id and filename when download is clicked', () => {
    const onDownloadAttachment = vi.fn();
    renderEditWithAttachments([ATTACHMENT], { onDownloadAttachment });

    fireEvent.click(screen.getByText('Download invoice.pdf'));

    expect(onDownloadAttachment).toHaveBeenCalledOnce();
    expect(onDownloadAttachment).toHaveBeenCalledWith('att-1', 'invoice.pdf');
  });

  it('should ask for confirmation before deleting an attachment', async () => {
    // Deleting an accounting document has no undo: this fails if the AlertDialog is ever
    // reverted to a bare onClick.
    const onDeleteAttachment = vi.fn();
    renderEditWithAttachments([ATTACHMENT], { onDeleteAttachment });

    fireEvent.click(screen.getByText('Remove invoice.pdf'));

    expect(onDeleteAttachment).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByText('Remove this invoice?')).not.toBeNull();
    });

    fireEvent.click(screen.getByText('Remove invoice'));

    await waitFor(() => {
      expect(onDeleteAttachment).toHaveBeenCalledOnce();
    });
    expect(onDeleteAttachment).toHaveBeenCalledWith('att-1');
  });

  it('should not delete when the confirmation is cancelled', async () => {
    const onDeleteAttachment = vi.fn();
    renderEditWithAttachments([ATTACHMENT], { onDeleteAttachment });

    fireEvent.click(screen.getByText('Remove invoice.pdf'));
    await waitFor(() => {
      expect(screen.queryByText('Remove this invoice?')).not.toBeNull();
    });

    fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));

    await waitFor(() => {
      expect(screen.queryByText('Remove this invoice?')).toBeNull();
    });
    expect(onDeleteAttachment).not.toHaveBeenCalled();
  });

  it('should show the empty-state copy when the expense has no attachments', () => {
    renderEditWithAttachments([]);

    expect(screen.queryByText('No invoice attached yet')).not.toBeNull();
  });

  it('should disable submit while the submit handler is pending and not fire it twice', async () => {
    // Without this the window between createExpense and the last upload stays clickable, and a
    // double click creates two expenses, each with its own upload loop.
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSubmit = vi.fn(() => pending);

    renderCreate(onSubmit);
    fillRequiredFields();

    fireEvent.click(submitButton());

    await waitFor(() => {
      expect(submitButton().disabled).toBe(true);
    });
    expect(submitButton().textContent).toContain('Saving…');

    fireEvent.click(submitButton());
    expect(onSubmit).toHaveBeenCalledOnce();

    release();

    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
