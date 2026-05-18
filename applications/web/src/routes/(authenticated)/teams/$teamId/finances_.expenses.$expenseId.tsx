import { Expense, type ExpenseApi, Team } from '@sideline/domain';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import { ExpenseFormDialog } from '~/components/organisms/ExpenseFormDialog.js';
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute(
  '/(authenticated)/teams/$teamId/finances_/expenses/$expenseId',
)({
  ssr: false,
  beforeLoad: ({ context, params }) => {
    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    if (!permissions.includes('finance:manage_fees')) {
      throw redirect({ to: '/teams/$teamId/finances/expenses', params: { teamId: params.teamId } });
    }
  },
  component: ExpenseEditRoute,
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );
    const expenseId = await Schema.decodeEffect(Expense.ExpenseId)(params.expenseId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const expense = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.expenses.getExpense({ params: { teamId, expenseId } })),
      warnAndCatchAll,
      context.run,
    );

    return { expense, teamId };
  },
});

function ExpenseEditRoute() {
  const { expense, teamId } = Route.useLoaderData();
  const { teamId: teamIdParam } = Route.useParams();
  const router = useRouter();
  const run = useRun();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const expenseIdBranded = Schema.decodeSync(Expense.ExpenseId)(expense.expenseId);

  const handleClose = () => {
    router.navigate({ to: '/teams/$teamId/finances/expenses', params: { teamId: teamIdParam } });
  };

  const handleSubmit = async (req: ExpenseApi.UpdateExpenseRequest) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.updateExpense({
          params: { teamId: teamIdBranded, expenseId: expenseIdBranded },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('expense_update_failed'))),
      run({ success: tr('expense_update_success') }),
    );
    if (Option.isSome(result)) {
      router.invalidate();
      handleClose();
    }
  };

  return (
    <ExpenseFormDialog
      open={true}
      mode='edit'
      expense={expense}
      teamId={teamIdParam}
      onSubmit={handleSubmit}
      onCancel={handleClose}
    />
  );
}
