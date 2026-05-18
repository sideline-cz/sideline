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
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances_/expenses')({
  ssr: false,
  component: ExpensesRoute,
  loader: async ({ params, context }) => {
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
  const { expenses, canManageExpenses, teamId } = Route.useLoaderData();
  const router = useRouter();
  const run = useRun();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editExpense, setEditExpense] = React.useState<ExpenseView | null>(null);
  const [deleteExpenseId, setDeleteExpenseId] = React.useState<string | null>(null);

  const [fromFilter, setFromFilter] = React.useState('');
  const [toFilter, setToFilter] = React.useState('');
  const [categoryFilter, setCategoryFilter] = React.useState<ReadonlyArray<string>>([]);

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const handleCreateSubmit = async (req: ExpenseApi.CreateExpenseRequest) => {
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
    if (Option.isSome(result)) {
      setCreateOpen(false);
      router.invalidate();
    }
  };

  const handleEditSubmit = async (req: ExpenseApi.UpdateExpenseRequest) => {
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
    if (Option.isSome(result)) {
      setEditExpense(null);
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

  // Filter expenses client-side
  const filteredExpenses: ReadonlyArray<ExpenseView> = expenses.filter((e: ExpenseView) => {
    const spentAtMs = Number(DateTime.toEpochMillis(e.spentAt));
    if (fromFilter && spentAtMs < new Date(`${fromFilter}T00:00:00Z`).getTime()) return false;
    if (toFilter && spentAtMs > new Date(`${toFilter}T23:59:59Z`).getTime()) return false;
    if (categoryFilter.length > 0 && !categoryFilter.includes(e.category)) return false;
    return true;
  });

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
      {editExpense !== null && (
        <ExpenseFormDialog
          open={true}
          mode='edit'
          expense={editExpense}
          teamId={teamId}
          onSubmit={handleEditSubmit}
          onCancel={() => setEditExpense(null)}
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
