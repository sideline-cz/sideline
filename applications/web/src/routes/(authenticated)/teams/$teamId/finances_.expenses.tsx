import { Expense, type ExpenseApi, Team } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Array, DateTime, Effect, Option, Schema } from 'effect';
import React from 'react';
import { ExpenseFormDialog } from '~/components/organisms/ExpenseFormDialog.js';
import type { ExpenseView } from '~/components/pages/ExpensesListPage.js';
import { ExpensesListPage } from '~/components/pages/ExpensesListPage.js';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { downloadAttachment } from '~/lib/downloadAttachment.js';
import { buildExpenseAttachmentUrl, uploadExpenseAttachment } from '~/lib/expenseAttachments.js';
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { useServerUrl } from '~/lib/translation-overrides-context.js';
import { tr } from '~/lib/translations.js';

// Pinned explicitly rather than inferred, for the same reason as `finances.tsx:54`:
// `Route.useLoaderData()` resolves through the whole registered router type, and that inference
// collapses to `any` once the generated API client grows past a threshold — which it did when the
// expenses group gained its attachment endpoints. Left inferred, every line of this route is
// unchecked while `pnpm check` stays green.
interface ExpensesLoaderData {
  readonly expenses: ReadonlyArray<ExpenseApi.ExpenseView>;
  readonly canManageExpenses: boolean;
  readonly teamId: Team.TeamId;
}

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances_/expenses')({
  ssr: false,
  component: ExpensesRoute,
  loader: async ({ params, context }): Promise<ExpensesLoaderData> => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canManageExpenses = permissions.includes('finance:manage_fees');

    const expenses = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.listExpenses({
          params: { teamId },
          query: { category: Option.none(), from: Option.none(), to: Option.none() },
        }),
      ),
      warnAndCatchAll,
      context.run,
    );

    return { expenses, canManageExpenses, teamId };
  },
});

function ExpensesRoute() {
  const { expenses, canManageExpenses, teamId }: ExpensesLoaderData = Route.useLoaderData();
  const router = useRouter();
  const run = useRun();
  const serverUrl = useServerUrl();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editExpense, setEditExpense] = React.useState<ExpenseView | null>(null);
  const [deleteExpenseId, setDeleteExpenseId] = React.useState<string | null>(null);

  const [fromFilter, setFromFilter] = React.useState('');
  const [toFilter, setToFilter] = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState<ReadonlyArray<string>>([]);

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  // Sequential, one `run(...)` per file: a ClientError nobody renders would leave the user with
  // "Expense added", a closed dialog and no file — indistinguishable from forgetting to attach it.
  const uploadStagedFiles = async (
    expenseId: Expense.ExpenseId,
    files: ReadonlyArray<File>,
  ): Promise<void> => {
    for (const file of files) {
      await ApiClient.asEffect().pipe(
        Effect.flatMap((api) => uploadExpenseAttachment(api, teamIdBranded, expenseId, file)),
        Effect.catchTags({
          ExpenseAttachmentTooLarge: () =>
            Effect.fail(ClientError.make(tr('expense_attachments_upload_tooLarge'))),
          ExpenseAttachmentTypeNotAllowed: () =>
            Effect.fail(ClientError.make(tr('expense_attachments_upload_badType'))),
        }),
        Effect.mapError((e) =>
          e instanceof ClientError ? e : ClientError.make(tr('expense_attachments_upload_failed')),
        ),
        run({ success: tr('expense_attachments_upload_success') }),
      );
    }
  };

  const handleDownloadAttachment = async (attachmentId: string, filename: string) => {
    if (!editExpense) return;
    await downloadAttachment(
      buildExpenseAttachmentUrl(serverUrl, teamId, editExpense.expenseId, attachmentId),
      filename,
    ).pipe(
      Effect.mapError(() => ClientError.make(tr('expense_attachments_download_failed'))),
      run({}),
    );
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    if (!editExpense) return;
    const expenseId = Schema.decodeSync(Expense.ExpenseId)(editExpense.expenseId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.deleteExpenseAttachment({
          params: {
            teamId: teamIdBranded,
            expenseId,
            attachmentId: Schema.decodeSync(Expense.ExpenseAttachmentId)(attachmentId),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('expense_attachments_delete_failed'))),
      run({ success: tr('expense_attachments_delete_success') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  const handleCreateSubmit = async (
    req: ExpenseApi.CreateExpenseRequest,
    files: ReadonlyArray<File>,
  ) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.createExpense({
          params: { teamId: teamIdBranded },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('expense_create_failed'))),
      run({ success: tr('expense_create_success') }),
    );
    if (Option.isNone(result)) return;

    setCreateOpen(false);
    // Invalidate BEFORE the uploads: the expense exists now, and five 2 MB files on hotel wifi
    // is tens of seconds of "it didn't save" otherwise. The `finally` lands the metadata.
    router.invalidate();
    try {
      await uploadStagedFiles(result.value.expenseId, files);
    } finally {
      router.invalidate();
    }
  };

  const handleEditSubmit = async (
    req: ExpenseApi.UpdateExpenseRequest,
    files: ReadonlyArray<File>,
  ) => {
    if (!editExpense) return;
    const expenseId = Schema.decodeSync(Expense.ExpenseId)(editExpense.expenseId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.updateExpense({
          params: { teamId: teamIdBranded, expenseId },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('expense_update_failed'))),
      run({ success: tr('expense_update_success') }),
    );
    if (Option.isNone(result)) return;

    setEditExpense(null);
    router.invalidate();
    try {
      await uploadStagedFiles(expenseId, files);
    } finally {
      router.invalidate();
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteExpenseId) return;
    const expenseId = Schema.decodeSync(Expense.ExpenseId)(deleteExpenseId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.deleteExpense({ params: { teamId: teamIdBranded, expenseId } }),
      ),
      Effect.mapError(() => ClientError.make(tr('expense_delete_failed'))),
      run({ success: tr('expense_delete_success') }),
    );
    setDeleteExpenseId(null);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  const handleClearFilters = () => {
    setFromFilter('');
    setToFilter('');
    setCategoryFilter([]);
  };

  // Re-derive the edited row from the current loader data (same idiom as `finances.tsx:148`):
  // `editExpense` is a frozen snapshot, so after `onDeleteAttachment` -> `router.invalidate()` the
  // dialog would otherwise keep listing the invoice that was just removed.
  const activeEditExpense = editExpense
    ? (expenses.find((e) => e.expenseId === editExpense.expenseId) ?? editExpense)
    : null;

  // Date range + category are filtered here; search, the missing-invoice chip and sort live in
  // the page's `useListFilter`. Memoised because that hook memoises on the array identity — a
  // fresh array every render would defeat it.
  const filteredExpenses: ReadonlyArray<ExpenseView> = React.useMemo(
    () =>
      expenses.filter((e) => {
        const spentAtMs = Number(DateTime.toEpochMillis(e.spentAt));
        if (fromFilter && spentAtMs < new Date(`${fromFilter}T00:00:00Z`).getTime()) return false;
        if (toFilter && spentAtMs > new Date(`${toFilter}T23:59:59Z`).getTime()) return false;
        if (categoryFilter.length > 0 && !categoryFilter.includes(e.category)) return false;
        return true;
      }),
    [expenses, fromFilter, toFilter, categoryFilter],
  );

  return (
    <>
      <ExpensesListPage
        expenses={filteredExpenses}
        canManageExpenses={canManageExpenses}
        fromFilter={fromFilter}
        toFilter={toFilter}
        categoryFilter={categoryFilter}
        onFromFilterChange={setFromFilter}
        onToFilterChange={setToFilter}
        onCategoryFilterChange={setCategoryFilter}
        onClearFilters={handleClearFilters}
        onCreateExpense={() => setCreateOpen(true)}
        onEditExpense={(expense) => setEditExpense(expense)}
        onDeleteExpense={(expenseId) => setDeleteExpenseId(expenseId)}
      />
      <ExpenseFormDialog
        open={createOpen}
        mode='create'
        teamId={teamId}
        onSubmit={handleCreateSubmit}
        onCancel={() => setCreateOpen(false)}
      />
      {activeEditExpense !== null && (
        <ExpenseFormDialog
          open={true}
          mode='edit'
          expense={activeEditExpense}
          teamId={teamId}
          onSubmit={handleEditSubmit}
          onCancel={() => setEditExpense(null)}
          onDownloadAttachment={handleDownloadAttachment}
          onDeleteAttachment={handleDeleteAttachment}
        />
      )}
      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteExpenseId !== null}
        onOpenChange={(v) => {
          if (!v) setDeleteExpenseId(null);
        }}
      >
        <DialogContent aria-describedby='delete-expense-dialog-description'>
          <DialogHeader>
            <DialogTitle>{tr('expense_delete_confirm_title')}</DialogTitle>
            <DialogDescription id='delete-expense-dialog-description'>
              {tr('expense_delete_confirm_description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setDeleteExpenseId(null)}>
              {tr('expense_delete_confirm_cancel')}
            </Button>
            <Button type='button' variant='destructive' onClick={handleDeleteConfirm}>
              {tr('expense_delete_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
