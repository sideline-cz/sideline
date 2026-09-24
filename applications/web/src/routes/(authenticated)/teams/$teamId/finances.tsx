import { Fee, FeeAssignment, type FinanceApi, Team, TeamMember } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import type { FeeAssignmentView } from '~/components/organisms/AssignmentsTab.js';
import { AssignmentsTab } from '~/components/organisms/AssignmentsTab.js';
import { RecordPaymentDialog } from '~/components/organisms/RecordPaymentDialog.js';
import type { SettleAssignmentCandidate } from '~/components/organisms/SettleMemberDialog.js';
import { SettleMemberDialog } from '~/components/organisms/SettleMemberDialog.js';
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
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { ApiClient, ClientError, NotFound, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Settle error → toast copy
// ---------------------------------------------------------------------------

function settleErrorMessage(err: { readonly _tag: string }, memberLabel: string): string {
  switch (err._tag) {
    case 'SettlementStale':
      return tr('finance_settle_stale', { member: memberLabel });
    case 'InsufficientCredit':
      return tr('finance_settle_insufficientCredit');
    default:
      return tr('finance_settle_error');
  }
}

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
      creditMinor: r.creditMinor,
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
  const [settleRow, setSettleRow] = React.useState<MemberOverviewRow | null>(null);
  const [settling, setSettling] = React.useState(false);

  // Always-mounted dialog: freeze the last-known row identity so the content doesn't blank
  // during the close animation (AGENTS.md "Dialogs Must Be Always-Mounted, Driven By `open`").
  // The identity is frozen, not the data: re-derive from the current `rows` so a
  // `router.invalidate()` (e.g. on the SettlementStale retry, §3.5) refreshes `creditMinor`
  // along with the breakdown — a frozen `creditMinor` would go stale against fresh assignments.
  const settleRowRef = React.useRef<MemberOverviewRow | null>(null);
  if (settleRow !== null) settleRowRef.current = settleRow;
  const frozenSettleRow = settleRow ?? settleRowRef.current;
  const activeSettleRow = frozenSettleRow
    ? (rows.find(
        (r) =>
          r.teamMemberId === frozenSettleRow.teamMemberId &&
          r.currency === frozenSettleRow.currency,
      ) ?? frozenSettleRow)
    : null;

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const decodeAssignmentIds = (a: FeeAssignmentView) => ({
    feeId: Schema.decodeSync(Fee.FeeId)(a.feeId),
    assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(a.assignmentId),
  });

  // Outstanding (pending | partial | overdue) assignments for the row's (member, currency) —
  // the same candidate set `MemberCreditsRepository.settle` locks server-side. Waived/paid
  // assignments in other currencies are excluded by construction (every row is scoped to one).
  const settleCandidates: ReadonlyArray<SettleAssignmentCandidate> = React.useMemo(() => {
    if (!activeSettleRow) return [];
    return assignments
      .filter(
        (a) =>
          a.teamMemberId === activeSettleRow.teamMemberId &&
          a.currency === activeSettleRow.currency &&
          (a.status === 'pending' || a.status === 'partial' || a.status === 'overdue'),
      )
      .map((a) => ({
        assignmentId: a.assignmentId,
        feeId: a.feeId,
        feeName: a.feeName,
        dueMinor: a.dueMinor,
        paidMinor: a.paidMinor,
        effectiveDueAt: a.effectiveDueAt,
      }));
  }, [assignments, activeSettleRow]);

  const handleSettleSubmit = async (req: FinanceApi.CreateSettlementRequest) => {
    if (!activeSettleRow) return;
    const memberIdBranded = Schema.decodeSync(TeamMember.TeamMemberId)(
      activeSettleRow.teamMemberId,
    );
    const memberLabel = activeSettleRow.memberName ?? '—';
    setSettling(true);
    let stale = false;
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.createSettlement({
          params: { teamId: teamIdBranded, memberId: memberIdBranded },
          payload: req,
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          if (err._tag === 'SettlementStale') stale = true;
        }),
      ),
      Effect.mapError((err) => ClientError.make(settleErrorMessage(err, memberLabel))),
      run({}),
    );
    setSettling(false);
    if (Option.isSome(result)) {
      const settlement = result.value;
      setSettleRow(null);
      router.invalidate();
      // The success toast is built from the SERVER's SettlementResult, never the client
      // preview (UX spec §3.5) — the preview is a preview, the response is what happened.
      const settledMinor = settlement.paidMinor + settlement.creditAppliedMinor;
      const feeCount = new Set(settlement.allocations.map((a) => a.assignmentId)).size;
      if (settlement.creditAddedMinor > 0) {
        toast.success(
          tr('finance_settle_successCredit', {
            amount: formatMoney(settledMinor, settlement.currency, 'en'),
            credit: formatMoney(settlement.creditAddedMinor, settlement.currency, 'en'),
          }),
        );
      } else {
        toast.success(
          tr('finance_settle_success', {
            amount: formatMoney(settledMinor, settlement.currency, 'en'),
            count: feeCount,
          }),
        );
      }
    } else if (stale) {
      // Dialog stays open (§3.5) — reload the fees the breakdown is built from so the
      // treasurer re-checks the amount against current data, not what they saw a moment ago.
      router.invalidate();
    }
  };

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
        canRecordPayments={canRecordPayments}
        onSettleRow={(row) => setSettleRow(row)}
        onCreditVoided={() => router.invalidate()}
      />
      <SettleMemberDialog
        open={settleRow !== null}
        memberName={activeSettleRow?.memberName ?? undefined}
        // Always-mounted (AGENTS.md), so this renders — and computes `formatMoney` calls
        // internally — before any row is ever selected. `''` isn't a valid Intl currency code
        // and crashes `Intl.NumberFormat`; 'CZK' matches this codebase's existing no-data
        // fallback (see `pickMostFrequentCurrency` in FinancesOverviewPage.tsx). The dialog is
        // closed at that point, so the value is never actually shown.
        currency={activeSettleRow?.currency ?? 'CZK'}
        creditMinor={activeSettleRow?.creditMinor ?? 0}
        assignments={settleCandidates}
        submitting={settling}
        onSubmit={handleSettleSubmit}
        onCancel={() => setSettleRow(null)}
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
