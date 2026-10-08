// TDD — written BEFORE §6c/§6d wire the upload loop (plan §7f cases 1-3).
//
// Case 1 is the only thing standing between the plan and a silent data-loss bug: `handleSubmit`
// in `finances_.expenses.$expenseId.tsx` takes ONE parameter today, and a one-parameter function
// stays assignable to a two-parameter prop type — so skipping §6d type-checks clean and throws
// every picked file away without an error anywhere. A type error cannot catch that; only this can.
//
// Shape follows `financesRoute.test.tsx`: mock `createFileRoute` down to controllable
// `useParams`/`useLoaderData`/`useRouteContext`, mock `~/lib/runtime`, render
// `Route.options.component` directly.

import { act, render } from '@testing-library/react';
import { Effect } from 'effect';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// ---------------------------------------------------------------------------
// Runtime mock — records every ClientError message the route hands to `run`.
// ---------------------------------------------------------------------------

const { createExpenseImpl, updateExpenseImpl, runErrors } = vi.hoisted(() => ({
  createExpenseImpl: vi.fn(),
  updateExpenseImpl: vi.fn(),
  runErrors: [] as Array<string>,
}));

vi.mock('~/lib/runtime', async () => {
  const { Effect: RealEffect } = await import('effect');
  class MockClientError {
    readonly _tag = 'ClientError';
    readonly message: string;
    constructor(props: { message: string }) {
      this.message = props.message;
    }
    static make(message: string) {
      return new MockClientError({ message });
    }
  }
  return {
    ApiClient: {
      asEffect: () =>
        RealEffect.succeed({
          expenses: {
            createExpense: (args: unknown) => createExpenseImpl(args),
            updateExpense: (args: unknown) => updateExpenseImpl(args),
            deleteExpenseAttachment: () => RealEffect.void,
          },
        }),
    },
    ClientError: MockClientError,
    NotFound: { make: (e: unknown) => e },
    warnAndCatchAll: (effect: Effect.Effect<unknown, unknown>) => effect,
    useRun: () => () => (effect: Effect.Effect<unknown, { message?: string }, never>) =>
      RealEffect.runPromise(
        RealEffect.option(
          effect.pipe(
            RealEffect.tapError((e) => {
              runErrors.push(String(e?.message ?? JSON.stringify(e)));
              return RealEffect.void;
            }),
          ),
        ),
      ),
  };
});

// ---------------------------------------------------------------------------
// The shared upload helper (§6c-bis) — mocked so these tests pin ORDERING and
// WIRING, not base64 encoding.
// ---------------------------------------------------------------------------

const { uploadExpenseAttachment } = vi.hoisted(() => ({
  uploadExpenseAttachment: vi.fn(),
}));

vi.mock('~/lib/expenseAttachments.js', () => ({
  uploadExpenseAttachment,
  toBase64: vi.fn(),
  buildExpenseAttachmentUrl: (
    serverUrl: string,
    teamId: string,
    expenseId: string,
    attachmentId: string,
  ) => `${serverUrl}/teams/${teamId}/expenses/${expenseId}/attachments/${attachmentId}`,
}));

vi.mock('~/lib/downloadAttachment.js', () => ({
  downloadAttachment: vi.fn(() => Effect.void),
  AttachmentDownloadFailed: class AttachmentDownloadFailed {
    readonly _tag = 'AttachmentDownloadFailed';
  },
}));

// ---------------------------------------------------------------------------
// Component mocks
// ---------------------------------------------------------------------------

const { mockExpenseFormDialog, mockExpensesListPage } = vi.hoisted(() => ({
  mockExpenseFormDialog: vi.fn(),
  mockExpensesListPage: vi.fn(),
}));

interface DialogProps {
  mode: 'create' | 'edit';
  onSubmit: (req: unknown, files: ReadonlyArray<File>) => void | Promise<void>;
  onDownloadAttachment?: (attachmentId: string, filename: string) => void;
  onDeleteAttachment?: (attachmentId: string) => void;
}

vi.mock('~/components/organisms/ExpenseFormDialog.js', () => ({
  ExpenseFormDialog: (props: DialogProps) => {
    mockExpenseFormDialog(props);
    return null;
  },
}));

vi.mock('~/components/pages/ExpensesListPage.js', () => ({
  ExpensesListPage: (props: unknown) => {
    mockExpensesListPage(props);
    return null;
  },
}));

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------

const { mockUseParams, mockUseLoaderData, mockUseRouteContext, mockInvalidate, mockNavigate } =
  vi.hoisted(() => ({
    mockUseParams: vi.fn(),
    mockUseLoaderData: vi.fn(),
    mockUseRouteContext: vi.fn(),
    mockInvalidate: vi.fn(),
    mockNavigate: vi.fn(),
  }));

interface FileRouteOptions {
  readonly component: React.ComponentType;
}

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (_path: string) => (options: FileRouteOptions) => ({
    id: 'expenses-route',
    options,
    useParams: mockUseParams,
    useLoaderData: mockUseLoaderData,
    useRouteContext: mockUseRouteContext,
  }),
  redirect: (opts: unknown) => opts,
  useNavigate: () => mockNavigate,
  useRouter: () => ({ invalidate: mockInvalidate, navigate: mockNavigate }),
  Link: (props: React.ComponentProps<'a'>) => <a {...props} />,
}));

const { Route: DetailRoute } = await import(
  '~/routes/(authenticated)/teams/$teamId/finances_.expenses.$expenseId.tsx'
);
const { Route: ListRoute } = await import(
  '~/routes/(authenticated)/teams/$teamId/finances_.expenses.tsx'
);

function componentOf(route: { options: { component?: React.ComponentType } }) {
  const component = route.options.component;
  if (!component) throw new Error('route must define a component');
  return component;
}

const DetailComponent = componentOf(DetailRoute as never);
const ListComponent = componentOf(ListRoute as never);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const EXPENSE_ID = '33333333-3333-4333-8333-333333333333';

const EXPENSE = {
  expenseId: EXPENSE_ID,
  teamId: TEAM_ID,
  amountMinor: 25_000,
  currency: 'CZK',
  spentAt: '2025-05-01T12:00:00.000Z',
  category: 'fields',
  description: 'Pitch rent',
  createdByUserId: '22222222-2222-4222-8222-222222222222',
  updatedByUserId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2025-05-01T12:00:00.000Z',
  updatedAt: '2025-05-01T12:00:00.000Z',
  attachments: [],
};

const FILE = new File(['x'], 'invoice.pdf', { type: 'application/pdf' });

function dialogProps(mode: 'create' | 'edit'): DialogProps {
  const call = mockExpenseFormDialog.mock.calls
    .map((c) => c[0] as DialogProps)
    .reverse()
    .find((p) => p.mode === mode);
  if (!call) throw new Error(`ExpenseFormDialog never rendered in ${mode} mode`);
  return call;
}

beforeEach(() => {
  mockUseParams.mockReturnValue({ teamId: TEAM_ID, expenseId: EXPENSE_ID });
  mockUseRouteContext.mockReturnValue({ user: { id: 'user-1' } });
  mockInvalidate.mockReset();
  mockNavigate.mockReset();
  mockExpenseFormDialog.mockReset();
  mockExpensesListPage.mockReset();
  createExpenseImpl.mockReset();
  updateExpenseImpl.mockReset();
  uploadExpenseAttachment.mockReset();
  runErrors.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('expense edit route — staged files', () => {
  it('should forward staged files to the upload call', async () => {
    mockUseLoaderData.mockReturnValue({ expense: EXPENSE, teamId: TEAM_ID });
    updateExpenseImpl.mockReturnValue(Effect.succeed(EXPENSE));
    uploadExpenseAttachment.mockReturnValue(Effect.succeed({ attachmentId: 'att-1' }));

    render(<DetailComponent />);

    await act(async () => {
      await dialogProps('edit').onSubmit({ description: 'Pitch rent' }, [FILE]);
    });

    expect(uploadExpenseAttachment).toHaveBeenCalledOnce();
    expect(uploadExpenseAttachment.mock.calls[0]).toContain(FILE);
  });
});

describe('expense list route — create then upload ordering', () => {
  const loaderData = {
    expenses: [],
    canManageExpenses: true,
    teamId: TEAM_ID,
  };

  it('should invalidate before the uploads run and again after the loop', async () => {
    // Deferring the first invalidate means the success toast fires and the dialog closes while
    // the list still shows nothing — tens of seconds of "it didn't save" on hotel wifi.
    mockUseLoaderData.mockReturnValue(loaderData);
    createExpenseImpl.mockReturnValue(Effect.succeed({ expenseId: EXPENSE_ID }));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    uploadExpenseAttachment.mockReturnValue(
      Effect.promise(() => gate).pipe(Effect.as({ attachmentId: 'att-1' })),
    );

    render(<ListComponent />);

    let submitted!: Promise<unknown>;
    await act(async () => {
      submitted = Promise.resolve(dialogProps('create').onSubmit({}, [FILE]));
      // Let createExpense settle and the first invalidate fire, but keep the upload parked.
      await Promise.resolve();
    });

    expect(uploadExpenseAttachment).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledOnce();

    await act(async () => {
      release();
      await submitted;
    });

    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it('should surface the too-large copy when an upload fails', async () => {
    // A badge-shaped nudge makes a silent failure indistinguishable from "I forgot to attach it".
    mockUseLoaderData.mockReturnValue(loaderData);
    createExpenseImpl.mockReturnValue(Effect.succeed({ expenseId: EXPENSE_ID }));
    uploadExpenseAttachment.mockReturnValue(
      Effect.fail({ _tag: 'ExpenseAttachmentTooLarge' as const }),
    );

    render(<ListComponent />);

    await act(async () => {
      await dialogProps('create').onSubmit({}, [FILE]);
    });

    expect(runErrors).toContain('expense_attachments_upload_tooLarge');
  });

  it('should attempt every staged file when one of them fails', async () => {
    // One bad file must not swallow the rest: before the `Effect.tryPromise` fix a read failure was
    // a defect, the `await` threw, and files after it were never attempted — with no toast.
    mockUseLoaderData.mockReturnValue(loaderData);
    createExpenseImpl.mockReturnValue(Effect.succeed({ expenseId: EXPENSE_ID }));
    const files = [
      FILE,
      new File(['y'], 'receipt.png', { type: 'image/png' }),
      new File(['z'], 'scan.pdf', { type: 'application/pdf' }),
    ];
    uploadExpenseAttachment
      .mockReturnValueOnce(Effect.succeed({ attachmentId: 'att-1' }))
      .mockReturnValueOnce(Effect.fail({ _tag: 'ExpenseAttachmentTypeNotAllowed' as const }))
      .mockReturnValueOnce(Effect.succeed({ attachmentId: 'att-3' }));

    render(<ListComponent />);

    await act(async () => {
      await dialogProps('create').onSubmit({}, files);
    });

    expect(uploadExpenseAttachment).toHaveBeenCalledTimes(3);
    expect(runErrors).toEqual(['expense_attachments_upload_badType']);
  });
});
