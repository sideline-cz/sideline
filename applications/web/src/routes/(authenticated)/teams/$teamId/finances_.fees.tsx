import { Fee, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import React from 'react';
import { FeeFormDialog } from '~/components/organisms/FeeFormDialog.js';
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
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances_/fees')({
  ssr: false,
  component: FeesRoute,
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const fees = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.finance.listFees({ params: { teamId } })),
      warnAndCatchAll,
      context.run,
    );

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canManageFees = permissions.includes('finance:manage_fees');

    return { fees, canManageFees, teamId };
  },
});

function FeesRoute() {
  const { fees, canManageFees, teamId } = Route.useLoaderData();
  const router = useRouter();
  const run = useRun();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editFee, setEditFee] = React.useState<FeeView | null>(null);
  const [archiveFeeId, setArchiveFeeId] = React.useState<string | null>(null);

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

  return (
    <>
      <FeeManagementPage
        fees={fees}
        canManageFees={canManageFees}
        onCreateFee={() => setCreateOpen(true)}
        onEditFee={(fee) => setEditFee(fee)}
        onArchiveFee={(feeIdStr) => setArchiveFeeId(feeIdStr)}
      />
      <FeeFormDialog
        open={createOpen}
        mode='create'
        teamId={teamId}
        onSubmit={handleCreateSubmit}
        onCancel={() => setCreateOpen(false)}
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
