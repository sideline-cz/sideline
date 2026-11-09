import { Fee, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { AssignFeeDialog } from '~/components/organisms/AssignFeeDialog.js';
import { FeeFormDialog } from '~/components/organisms/FeeFormDialog.js';
import { FeeImportDialog } from '~/components/organisms/FeeImportDialog.js';
import type { FeeView } from '~/components/pages/FeeManagementPage.js';
import { FeeManagementPage } from '~/components/pages/FeeManagementPage.js';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { dateOnlyToUtcNoon } from '~/lib/datetime.js';
import type { ParsedFeeImportRow } from '~/lib/finance/parseFeeImportCsv.js';
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const toPayloadRow = (row: ParsedFeeImportRow): FinanceApi.FeeImportRow => ({
  line: row.line,
  member: row.member,
  feeName: row.feeName,
  amountMinor: Schema.decodeSync(Fee.AmountMinor)(row.amountMinor),
  currency: Schema.decodeSync(Fee.CurrencyCode)(row.currency),
  dueAt: row.dueDate === null ? Option.none() : Option.some(dateOnlyToUtcNoon(row.dueDate)),
});

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances_/fees')({
  ssr: false,
  component: FeesRoute,
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const [fees, members] = await Effect.all(
      [
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.finance.listFees({ params: { teamId } })),
          warnAndCatchAll,
        ),
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.roster.listMembers({ params: { teamId } })),
          warnAndCatchAll,
        ),
      ],
      { concurrency: 'unbounded' },
    ).pipe(context.run);

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canManageFees = permissions.includes('finance:manage_fees');

    const memberList = members.map((m) => ({
      teamMemberId: m.memberId,
      name: m.displayName,
    }));

    return { fees, canManageFees, teamId, members: memberList };
  },
});

function FeesRoute() {
  const { fees, canManageFees, teamId, members } = Route.useLoaderData();
  const router = useRouter();
  const run = useRun();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editFee, setEditFee] = React.useState<FeeView | null>(null);
  const [archiveFeeId, setArchiveFeeId] = React.useState<string | null>(null);
  const [assignFee, setAssignFee] = React.useState<FeeView | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);

  const handleCreateSubmit = async (
    req: FinanceApi.CreateFeeRequest | FinanceApi.UpdateFeeRequest,
  ) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.createFee({
          params: { teamId },
          payload: req as FinanceApi.CreateFeeRequest,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to create fee')),
      run({ success: 'Fee created' }),
    );
    if (Option.isSome(result)) {
      setCreateOpen(false);
      router.invalidate();
    }
  };

  const handleEditSubmit = async (
    req: FinanceApi.CreateFeeRequest | FinanceApi.UpdateFeeRequest,
  ) => {
    if (!editFee) return;
    const feeId = Schema.decodeSync(Fee.FeeId)(editFee.feeId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.updateFee({
          params: { teamId, feeId },
          payload: req as FinanceApi.UpdateFeeRequest,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to update fee')),
      run({ success: 'Fee updated' }),
    );
    if (Option.isSome(result)) {
      setEditFee(null);
      router.invalidate();
    }
  };

  const handleArchiveConfirm = async () => {
    if (!archiveFeeId) return;
    const feeId = Schema.decodeSync(Fee.FeeId)(archiveFeeId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.finance.archiveFee({ params: { teamId, feeId } })),
      Effect.mapError(() => ClientError.make('Failed to archive fee')),
      run({ success: 'Fee archived' }),
    );
    setArchiveFeeId(null);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  const handleAssignSubmit = async (req: FinanceApi.AssignFeeRequest) => {
    if (!assignFee) return;
    const feeId = Schema.decodeSync(Fee.FeeId)(assignFee.feeId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.assignFee({
          params: { teamId, feeId },
          payload: req,
        }),
      ),
      // Every `kind !== 'manual'` fee 409s here (api/finance.ts), and listFees has no kind
      // filter, so the generated shells are on this page and this refusal is permanent — not a
      // transient failure. FeeView carries no `kind`, so the button cannot be hidden; the least
      // the toast can do is name the real lever.
      Effect.catchTag('TrainingFeeImmutable', () =>
        Effect.fail(ClientError.make(tr('fee_management_assignFailedTraining'))),
      ),
      Effect.catchTag('GeneratedFeeImmutable', () =>
        Effect.fail(ClientError.make(tr('fee_management_assignFailedGenerated'))),
      ),
      // Preserve the specific messages mapped above; only fall back for unhandled errors.
      Effect.mapError((e) =>
        e._tag === 'ClientError' ? e : ClientError.make(tr('fee_management_assignFailed')),
      ),
      run({ success: 'Members assigned' }),
    );
    if (Option.isSome(result)) {
      setAssignFee(null);
      router.invalidate();
    }
  };

  const handleImportSubmit = async (
    rows: ParsedFeeImportRow[],
  ): Promise<ReadonlyArray<FinanceApi.FeeImportRowError>> => {
    const noErrors: ReadonlyArray<FinanceApi.FeeImportRowError> = [];
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.importFees({ params: { teamId }, payload: { rows: rows.map(toPayloadRow) } }),
      ),
      Effect.map((ok) => ({ ok: Option.some(ok), errors: noErrors })),
      Effect.catchTag('FeeImportInvalid', (e) =>
        Effect.succeed({ ok: Option.none<FinanceApi.FeeImportResult>(), errors: e.errors }),
      ),
      Effect.mapError(() => ClientError.make(tr('fee_import_failed'))),
      // No `run({ success })`: it would also toast on the FeeImportInvalid branch.
      run(),
    );
    if (Option.isNone(result)) return [];
    const { ok, errors } = result.value;
    if (Option.isSome(ok)) {
      toast.success(
        tr('fee_import_success', {
          feeCount: ok.value.feeCount,
          assignmentCount: ok.value.assignmentCount,
        }),
      );
      setImportOpen(false);
      router.invalidate();
    }
    return errors;
  };

  return (
    <>
      <FeeManagementPage
        fees={fees}
        canManageFees={canManageFees}
        onCreateFee={() => setCreateOpen(true)}
        onImportFees={() => setImportOpen(true)}
        onEditFee={(fee) => setEditFee(fee)}
        onArchiveFee={(feeIdStr) => setArchiveFeeId(feeIdStr)}
        onAssignMembers={(fee) => setAssignFee(fee)}
      />
      <FeeFormDialog
        open={createOpen}
        mode='create'
        teamId={teamId}
        onSubmit={handleCreateSubmit}
        onCancel={() => setCreateOpen(false)}
      />
      <FeeImportDialog
        open={importOpen}
        onSubmit={handleImportSubmit}
        onCancel={() => setImportOpen(false)}
      />
      {editFee !== null && (
        <FeeFormDialog
          open={true}
          mode='edit'
          fee={editFee}
          teamId={teamId}
          onSubmit={handleEditSubmit}
          onCancel={() => setEditFee(null)}
        />
      )}
      {/* Assign members dialog */}
      {assignFee !== null && (
        <AssignFeeDialog
          open={true}
          fee={assignFee}
          members={members}
          onSubmit={handleAssignSubmit}
          onCancel={() => setAssignFee(null)}
        />
      )}
      {/* Archive confirmation dialog */}
      <Dialog
        open={archiveFeeId !== null}
        onOpenChange={(v) => {
          if (!v) setArchiveFeeId(null);
        }}
      >
        <DialogContent aria-describedby='archive-dialog-description'>
          <DialogHeader>
            <DialogTitle>{tr('fee_management_archiveConfirmTitle')}</DialogTitle>
            <DialogDescription id='archive-dialog-description'>
              {tr('fee_management_archiveConfirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setArchiveFeeId(null)}>
              {tr('fee_management_archiveConfirmCancel')}
            </Button>
            <Button type='button' variant='destructive' onClick={handleArchiveConfirm}>
              {tr('fee_management_archiveConfirmAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
