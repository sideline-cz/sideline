import { Fee, FeeAssignment, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import React from 'react';
import type { FeeAssignmentView } from '~/components/organisms/AssignmentsTab.js';
import { AssignmentsTab } from '~/components/organisms/AssignmentsTab.js';
import { RecordPaymentDialog } from '~/components/organisms/RecordPaymentDialog.js';
import { WaiveAssignmentDialog } from '~/components/organisms/WaiveAssignmentDialog.js';
import type { MemberOverviewRow } from '~/components/pages/FinancesOverviewPage.js';
import { FinancesOverviewPage } from '~/components/pages/FinancesOverviewPage.js';
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

type FinancesTab = 'overview' | 'by-member' | 'by-assignment';

const isFinancesTab = (value: unknown): value is FinancesTab =>
  value === 'overview' || value === 'by-member' || value === 'by-assignment';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { tab?: FinancesTab } =>
    isFinancesTab(search.tab) ? { tab: search.tab } : {},
  component: FinancesRoute,
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canManageFees = permissions.includes('finance:manage_fees');
    const canRecordPayments = permissions.includes('finance:record_payments');

    const [domainRows, fees, balanceSummaries] = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all([
          api.finance.overview({ params: { teamId } }),
          api.finance.listFees({ params: { teamId } }),
          api.expenses.balanceSummary({
            params: { teamId },
            query: { from: Option.none(), to: Option.none() },
          }),
        ]),
      ),
      warnAndCatchAll,
      context.run,
    );

    // Fetch assignments for all active (non-archived) fees
    const feeIds = fees.filter((f) => Option.isNone(f.archivedAt)).map((f) => f.feeId);

    const assignments = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.forEach(feeIds, (feeId) =>
          api.finance.listAssignments({ params: { teamId, feeId } }).pipe(
            Effect.tapError((e) =>
              Effect.logWarning('Failed to load assignments for fee', feeId, e),
            ),
            Effect.catch(() => Effect.succeed([] as readonly FinanceApi.FeeAssignmentView[])),
          ),
        ),
      ),
      Effect.map((nested) => nested.flat()),
      warnAndCatchAll,
      context.run,
    );

    const rows: ReadonlyArray<MemberOverviewRow> = domainRows.map((r) => ({
      teamMemberId: r.teamMemberId,
      memberName: Option.getOrNull(r.memberName),
      currency: r.currency,
      totalDueMinor: r.totalDueMinor,
      totalPaidMinor: r.totalPaidMinor,
      overdueCount: r.overdueCount,
      pendingCount: r.pendingCount,
      paidCount: r.paidCount,
    }));

    return { rows, fees, assignments, canManageFees, canRecordPayments, teamId, balanceSummaries };
  },
});

function FinancesRoute() {
  const { teamId } = Route.useParams();
  const { rows, fees, assignments, canManageFees, canRecordPayments, balanceSummaries } =
    Route.useLoaderData();
  const { user } = Route.useRouteContext();
  const router = useRouter();
  const run = useRun();
  const { tab: searchTab } = useSearch({ from: Route.id });
  const navigate = useNavigate({ from: Route.fullPath });

  const hasOverviewTab = balanceSummaries !== undefined;
  const defaultTab: FinancesTab = hasOverviewTab ? 'overview' : 'by-member';
  const activeTab: FinancesTab =
    searchTab === 'overview' && !hasOverviewTab ? 'by-member' : (searchTab ?? defaultTab);

  const handleTabChange = (tab: FinancesTab) => {
    navigate({ search: { tab } });
  };

  const [logPaymentAssignment, setLogPaymentAssignment] = React.useState<FeeAssignmentView | null>(
    null,
  );
  const [waiveAssignment, setWaiveAssignment] = React.useState<FeeAssignmentView | null>(null);
  const [unwaiveAssignment, setUnwaiveAssignment] = React.useState<FeeAssignmentView | null>(null);

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const decodeAssignmentIds = (a: FeeAssignmentView) => ({
    feeId: Schema.decodeSync(Fee.FeeId)(a.feeId),
    assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(a.assignmentId),
  });

  const handleLogPaymentSubmit = async (req: FinanceApi.RecordPaymentRequest) => {
    if (!logPaymentAssignment) return;
    const { feeId, assignmentId } = decodeAssignmentIds(logPaymentAssignment);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.recordPayment({
          params: { teamId: teamIdBranded, feeId, assignmentId },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to record payment')),
      run({ success: 'Payment recorded' }),
    );
    if (Option.isSome(result)) {
      setLogPaymentAssignment(null);
      router.invalidate();
    }
  };

  const handleWaiveSubmit = async (req: FinanceApi.UpdateAssignmentRequest) => {
    if (!waiveAssignment) return;
    const { feeId, assignmentId } = decodeAssignmentIds(waiveAssignment);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.updateAssignment({
          params: { teamId: teamIdBranded, feeId, assignmentId },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to waive assignment')),
      run({ success: 'Assignment waived' }),
    );
    if (Option.isSome(result)) {
      setWaiveAssignment(null);
      router.invalidate();
    }
  };

  const handleUnwaiveConfirm = async () => {
    if (!unwaiveAssignment) return;
    const { feeId, assignmentId } = decodeAssignmentIds(unwaiveAssignment);
    const req: FinanceApi.UpdateAssignmentRequest = {
      waived: Option.some(false),
      waivedReason: Option.some(Option.none()),
      amountMinor: Option.none(),
      dueAt: Option.none(),
    };
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.updateAssignment({
          params: { teamId: teamIdBranded, feeId, assignmentId },
          payload: req,
        }),
      ),
      Effect.mapError(() => ClientError.make('Failed to un-waive assignment')),
      run({ success: 'Waiver removed' }),
    );
    setUnwaiveAssignment(null);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  // Build unique member list from assignments for filter dropdowns
  const membersMap = new Map<string, string | null>();
  for (const a of assignments) {
    if (!membersMap.has(a.teamMemberId)) {
      membersMap.set(a.teamMemberId, Option.getOrNull(a.memberName));
    }
  }
  const members = [...membersMap.entries()].map(([teamMemberId, memberName]) => ({
    teamMemberId,
    memberName,
  }));

  const feeOptions = (fees as ReadonlyArray<FinanceApi.FeeView>).map((f) => ({
    feeId: f.feeId,
    name: f.name,
  }));

  const assignmentsTabContent = (
    <AssignmentsTab
      assignments={assignments as ReadonlyArray<FeeAssignmentView>}
      fees={feeOptions}
      members={members}
      canRecordPayments={canRecordPayments}
      canManageFees={canManageFees}
      onLogPayment={(a) => setLogPaymentAssignment(a)}
      onWaive={(a) => setWaiveAssignment(a)}
      onUnwaive={(a) => setUnwaiveAssignment(a)}
    />
  );

  return (
    <>
      <FinancesOverviewPage
        rows={rows}
        teamId={teamId}
        userId={user.id}
        assignmentsTabContent={assignmentsTabContent}
        createFeeHref={`/teams/${teamId}/finances/fees`}
        balanceSummaries={balanceSummaries}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />
      {logPaymentAssignment !== null && (
        <RecordPaymentDialog
          open={true}
          assignmentId={logPaymentAssignment.assignmentId}
          feeId={logPaymentAssignment.feeId}
          teamId={teamId}
          memberName={Option.getOrUndefined(logPaymentAssignment.memberName)}
          dueMinor={logPaymentAssignment.dueMinor}
          currency={logPaymentAssignment.currency}
          onSubmit={handleLogPaymentSubmit}
          onCancel={() => setLogPaymentAssignment(null)}
        />
      )}
      {waiveAssignment !== null && (
        <WaiveAssignmentDialog
          open={true}
          assignmentId={waiveAssignment.assignmentId}
          feeId={waiveAssignment.feeId}
          teamId={teamId}
          memberName={Option.getOrUndefined(waiveAssignment.memberName)}
          feeName={waiveAssignment.feeName}
          onSubmit={handleWaiveSubmit}
          onCancel={() => setWaiveAssignment(null)}
        />
      )}
      {/* Un-waive confirmation dialog */}
      <Dialog
        open={unwaiveAssignment !== null}
        onOpenChange={(v) => {
          if (!v) setUnwaiveAssignment(null);
        }}
      >
        <DialogContent aria-describedby='unwaive-dialog-description'>
          <DialogHeader>
            <DialogTitle>{tr('unwaive_confirm_title')}</DialogTitle>
            <DialogDescription id='unwaive-dialog-description'>
              {tr('unwaive_confirm_description')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setUnwaiveAssignment(null)}>
              {tr('unwaive_confirm_cancel')}
            </Button>
            <Button type='button' onClick={handleUnwaiveConfirm}>
              {tr('unwaive_confirm_action')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
