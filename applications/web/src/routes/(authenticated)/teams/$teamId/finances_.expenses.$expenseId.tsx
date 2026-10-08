import { Expense, type ExpenseApi, Team } from '@sideline/domain';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import { ExpenseFormDialog } from '~/components/organisms/ExpenseFormDialog.js';
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
interface ExpenseDetailLoaderData {
  readonly expense: ExpenseApi.ExpenseView;
  readonly teamId: Team.TeamId;
}

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
  loader: async ({ params, context }): Promise<ExpenseDetailLoaderData> => {
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
  const { expense, teamId }: ExpenseDetailLoaderData = Route.useLoaderData();
  const { teamId: teamIdParam } = Route.useParams();
  const router = useRouter();
  const run = useRun();
  const serverUrl = useServerUrl();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const expenseIdBranded = Schema.decodeSync(Expense.ExpenseId)(expense.expenseId);

  const handleClose = () => {
    router.navigate({ to: '/teams/$teamId/finances/expenses', params: { teamId: teamIdParam } });
  };

  // The second parameter is load-bearing: a one-parameter function stays assignable to the
  // two-parameter prop type, so dropping `files` would compile clean and silently discard every
  // file the treasurer picked.
  const handleSubmit = async (req: ExpenseApi.UpdateExpenseRequest, files: ReadonlyArray<File>) => {
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
    if (Option.isNone(result)) return;

    // Invalidate before the uploads so the saved expense is visible immediately, and again in a
    // `finally` so the attachment metadata lands even if an iteration throws.
    router.invalidate();
    try {
      for (const file of files) {
        await ApiClient.asEffect().pipe(
          Effect.flatMap((api) =>
            uploadExpenseAttachment(api, teamIdBranded, expenseIdBranded, file),
          ),
          Effect.catchTags({
            ExpenseAttachmentTooLarge: () =>
              Effect.fail(ClientError.make(tr('expense_attachments_upload_tooLarge'))),
            ExpenseAttachmentTypeNotAllowed: () =>
              Effect.fail(ClientError.make(tr('expense_attachments_upload_badType'))),
          }),
          Effect.mapError((e) =>
            e instanceof ClientError
              ? e
              : ClientError.make(tr('expense_attachments_upload_failed')),
          ),
          run({ success: tr('expense_attachments_upload_success') }),
        );
      }
    } finally {
      router.invalidate();
    }
    handleClose();
  };

  const handleDownloadAttachment = async (attachmentId: string, filename: string) => {
    await downloadAttachment(
      buildExpenseAttachmentUrl(serverUrl, teamIdParam, expense.expenseId, attachmentId),
      filename,
    ).pipe(
      Effect.mapError(() => ClientError.make(tr('expense_attachments_download_failed'))),
      run({}),
    );
  };

  const handleDeleteAttachment = async (attachmentId: string) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.expenses.deleteExpenseAttachment({
          params: {
            teamId: teamIdBranded,
            expenseId: expenseIdBranded,
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

  return (
    <ExpenseFormDialog
      open={true}
      mode='edit'
      expense={expense}
      teamId={teamIdParam}
      onSubmit={handleSubmit}
      onCancel={handleClose}
      onDownloadAttachment={handleDownloadAttachment}
      onDeleteAttachment={handleDeleteAttachment}
    />
  );
}
