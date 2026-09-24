import { Auth, Fee, FinanceApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Option, Schema } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission, requireReadAccess } from '~/api/permissions.js';
import {
  type AssignmentViewRow,
  FeeAssignmentsRepository,
} from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository, type FeeWithCountsRow } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import {
  type MemberCreditDepositRow,
  MemberCreditsRepository,
  type SettleResult,
} from '~/repositories/MemberCreditsRepository.js';
import { PaymentsRepository, type PaymentViewRow } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new FinanceApi.FinanceForbidden();
const feeNotFound = new FinanceApi.FeeNotFound();
const assignmentNotFound = new FinanceApi.AssignmentNotFound();
const paymentNotFound = new FinanceApi.PaymentNotFound();
const invalidAmount = new FinanceApi.InvalidAmount();
const feeArchived = new FinanceApi.FeeArchived();

// ---------------------------------------------------------------------------
// Helpers: build view DTOs from repo rows
// ---------------------------------------------------------------------------

const toFeeView = (row: FeeWithCountsRow): FinanceApi.FeeView =>
  new FinanceApi.FeeView({
    feeId: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    amountMinor: row.amount_minor,
    currency: row.currency,
    dueAt: row.due_at,
    targetScope: row.target_scope,
    archivedAt: row.archived_at,
    assignmentCount: row.assignment_count,
    paidCount: row.paid_count,
    pendingCount: row.pending_count,
    overdueCount: row.overdue_count,
  });

const toFeeViewWithZeroCounts = (row: {
  id: FeeWithCountsRow['id'];
  team_id: FeeWithCountsRow['team_id'];
  name: FeeWithCountsRow['name'];
  description: FeeWithCountsRow['description'];
  amount_minor: FeeWithCountsRow['amount_minor'];
  currency: FeeWithCountsRow['currency'];
  due_at: FeeWithCountsRow['due_at'];
  target_scope: FeeWithCountsRow['target_scope'];
  archived_at: FeeWithCountsRow['archived_at'];
}): FinanceApi.FeeView =>
  new FinanceApi.FeeView({
    feeId: row.id,
    teamId: row.team_id,
    name: row.name,
    description: row.description,
    amountMinor: row.amount_minor,
    currency: row.currency,
    dueAt: row.due_at,
    targetScope: row.target_scope,
    archivedAt: row.archived_at,
    assignmentCount: 0,
    paidCount: 0,
    pendingCount: 0,
    overdueCount: 0,
  });

const toAssignmentView = (row: AssignmentViewRow): FinanceApi.FeeAssignmentView =>
  new FinanceApi.FeeAssignmentView({
    assignmentId: row.id,
    feeId: row.fee_id,
    teamMemberId: row.team_member_id,
    memberName: row.member_name,
    feeName: row.fee_name,
    currency: row.currency,
    dueMinor: row.due_minor,
    paidMinor: row.paid_minor,
    status: row.computed_status,
    effectiveDueAt: row.effective_due_at,
    waivedReason: row.waived_reason,
  });

const toPaymentView = (
  row: Pick<
    PaymentViewRow,
    | 'id'
    | 'fee_assignment_id'
    | 'team_member_id'
    | 'member_name'
    | 'amount_minor'
    | 'method'
    | 'paid_at'
    | 'note'
    | 'recorder_name'
    | 'voided_at'
    | 'void_reason'
  > & { paid_at: DateTime.Utc | Date },
): FinanceApi.PaymentView =>
  new FinanceApi.PaymentView({
    paymentId: row.id,
    feeAssignmentId: row.fee_assignment_id,
    teamMemberId: row.team_member_id,
    memberName: row.member_name,
    amountMinor: row.amount_minor,
    method: row.method,
    paidAt: row.paid_at instanceof Date ? DateTime.fromDateUnsafe(row.paid_at) : row.paid_at,
    note: row.note,
    recorderName: row.recorder_name,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  });

const decodeAmountMinor = Schema.decodeSync(Fee.AmountMinor);

const toSettlementResult = (result: SettleResult): FinanceApi.SettlementResult =>
  new FinanceApi.SettlementResult({
    currency: result.currency,
    creditAppliedMinor: decodeAmountMinor(result.creditAppliedMinor),
    paidMinor: decodeAmountMinor(result.paidMinor),
    creditAddedMinor: decodeAmountMinor(result.creditAddedMinor),
    creditBalanceAfterMinor: decodeAmountMinor(result.creditBalanceAfterMinor),
    allocations: result.allocations.map(
      (allocation) =>
        new FinanceApi.SettlementAllocation({
          assignmentId: allocation.assignmentId,
          feeId: allocation.feeId,
          feeName: allocation.feeName,
          amountMinor: decodeAmountMinor(allocation.amountMinor),
          source: allocation.source,
          statusAfter: allocation.statusAfter,
          paymentId: allocation.paymentId,
        }),
    ),
  });

const toMemberCreditDepositView = (
  row: MemberCreditDepositRow,
): FinanceApi.MemberCreditDepositView =>
  new FinanceApi.MemberCreditDepositView({
    depositId: row.id,
    teamMemberId: row.team_member_id,
    currency: row.currency,
    amountMinor: row.amount_minor,
    method: row.method,
    paidAt: row.paid_at,
    note: row.note,
    recorderName: row.recorder_name,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
  });

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const FinanceApiLive = HttpApiBuilder.group(Api, 'finance', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('fees', () => FeesRepository.asEffect()),
    Effect.bind('assignments', () => FeeAssignmentsRepository.asEffect()),
    Effect.bind('payments', () => PaymentsRepository.asEffect()),
    Effect.bind('overview', () => FinanceOverviewRepository.asEffect()),
    Effect.bind('credits', () => MemberCreditsRepository.asEffect()),
    Effect.map(({ members, fees, assignments, payments, overview, credits }) =>
      handlers
        // ------------------------------------------------------------------
        // listFees
        // ------------------------------------------------------------------
        .handle('listFees', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('list', () => fees.listByTeam(teamId)),
            Effect.map(({ list }) => Array.map(list, toFeeView)),
          ),
        )
        // ------------------------------------------------------------------
        // createFee
        // ------------------------------------------------------------------
        .handle('createFee', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            Effect.tap(() =>
              payload.amountMinor === 0 ? Effect.fail(invalidAmount) : Effect.void,
            ),
            Effect.bind('fee', () =>
              fees.insert({
                team_id: teamId,
                name: payload.name,
                description: payload.description,
                amount_minor: payload.amountMinor,
                currency: payload.currency,
                due_at: payload.dueAt,
                target_scope: payload.targetScope,
              }),
            ),
            Effect.tap(({ fee }) =>
              payload.targetScope === 'all_members'
                ? Effect.Do.pipe(
                    Effect.bind('teamMembers', () => members.findByTeam(teamId)),
                    Effect.tap(({ teamMembers }) =>
                      teamMembers.length > 0
                        ? assignments.bulkInsert({
                            feeId: fee.id,
                            memberIds: teamMembers.map((m) => m.id),
                            amountMinorOverride: Option.none(),
                            dueAtOverride: Option.none(),
                          })
                        : Effect.void,
                    ),
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
            Effect.map(({ fee }) => toFeeViewWithZeroCounts(fee)),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Fee insert returned no row'),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // getFee
        // ------------------------------------------------------------------
        .handle('getFee', ({ params: { teamId, feeId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('fee', () =>
              fees.findWithCountsById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ fee }) =>
              fee.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.map(({ fee }) => toFeeView(fee)),
          ),
        )
        // ------------------------------------------------------------------
        // updateFee
        // ------------------------------------------------------------------
        .handle('updateFee', ({ params: { teamId, feeId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            // Use findByIdAny to distinguish "fee is archived" from "fee doesn't exist"
            Effect.bind('existing', () =>
              fees.findByIdAny(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              Option.isSome(existing.archived_at) ? Effect.fail(feeArchived) : Effect.void,
            ),
            Effect.tap(() => {
              if (Option.isSome(payload.amountMinor) && payload.amountMinor.value === 0) {
                return Effect.fail(invalidAmount);
              }
              return Effect.void;
            }),
            Effect.tap(() =>
              fees.update(feeId, {
                name: payload.name,
                description: payload.description,
                amount_minor: payload.amountMinor,
                currency: payload.currency,
                due_at: payload.dueAt,
                target_scope: payload.targetScope,
              }),
            ),
            Effect.bind('updated', () =>
              fees.findWithCountsById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.map(({ updated }) => toFeeView(updated)),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Fee update returned no row'),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // archiveFee — idempotent
        // ------------------------------------------------------------------
        .handle('archiveFee', ({ params: { teamId, feeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            // findById returns None for archived fees — that's idempotent (204)
            // We still need to verify team ownership for non-archived fees
            Effect.bind('existingOpt', () => fees.findById(feeId)),
            Effect.tap(({ existingOpt }) =>
              Option.isSome(existingOpt) && existingOpt.value.team_id !== teamId
                ? Effect.fail(feeNotFound)
                : Effect.void,
            ),
            Effect.tap(() =>
              // archive is idempotent: WHERE archived_at IS NULL
              fees.archive(feeId),
            ),
            Effect.asVoid,
          ),
        )
        // ------------------------------------------------------------------
        // listAssignments
        // ------------------------------------------------------------------
        .handle('listAssignments', ({ params: { teamId, feeId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('fee', () =>
              fees.findById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ fee }) =>
              fee.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.bind('list', () => assignments.findByFee(feeId)),
            Effect.map(({ list }) => Array.map(list, toAssignmentView)),
          ),
        )
        // ------------------------------------------------------------------
        // assignFee
        // ------------------------------------------------------------------
        .handle('assignFee', ({ params: { teamId, feeId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            Effect.bind('fee', () =>
              fees.findById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ fee }) =>
              fee.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.tap(({ fee }) =>
              Option.isSome(fee.archived_at) ? Effect.fail(feeArchived) : Effect.void,
            ),
            Effect.tap(() => {
              if (
                Option.isSome(payload.amountMinorOverride) &&
                payload.amountMinorOverride.value === 0
              ) {
                return Effect.fail(invalidAmount);
              }
              return Effect.void;
            }),
            Effect.bind('inserted', () =>
              assignments.bulkInsert({
                feeId,
                memberIds: payload.memberIds,
                amountMinorOverride: payload.amountMinorOverride,
                dueAtOverride: payload.dueAtOverride,
              }),
            ),
            Effect.map(({ inserted }) => Array.map(inserted, toAssignmentView)),
          ),
        )
        // ------------------------------------------------------------------
        // updateAssignment
        // ------------------------------------------------------------------
        .handle('updateAssignment', ({ params: { teamId, feeId, assignmentId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            Effect.bind('fee', () =>
              fees.findById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ fee }) =>
              fee.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.tap(({ fee }) =>
              Option.isSome(fee.archived_at) ? Effect.fail(feeArchived) : Effect.void,
            ),
            Effect.bind('assignment', () =>
              assignments.findById(assignmentId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(assignmentNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ assignment }) =>
              assignment.fee_id !== feeId ? Effect.fail(assignmentNotFound) : Effect.void,
            ),
            Effect.tap(() => {
              if (Option.isSome(payload.amountMinor) && payload.amountMinor.value === 0) {
                return Effect.fail(invalidAmount);
              }
              return Effect.void;
            }),
            Effect.tap(() =>
              assignments.update(assignmentId, {
                amountMinor: payload.amountMinor,
                dueAt: payload.dueAt,
                waived: payload.waived,
                waivedReason: payload.waivedReason,
              }),
            ),
            // Fetch view-shaped updated assignment
            Effect.bind('updatedView', ({ assignment }) =>
              assignments.findByFeeAndMember(feeId, assignment.team_member_id).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(assignmentNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.map(({ updatedView }) => toAssignmentView(updatedView)),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Assignment update returned no row'),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // listAssignments (by member)
        // ------------------------------------------------------------------
        .handle('listMemberAssignments', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            // Verify the requested member belongs to this team; return empty if not
            Effect.bind('targetMember', () => members.findById(memberId)),
            Effect.bind('list', ({ targetMember }) => {
              if (Option.isNone(targetMember) || targetMember.value.team_id !== teamId) {
                return Effect.succeed([]);
              }
              return assignments.findByTeamMember(memberId);
            }),
            Effect.map(({ list }) => Array.map(list, toAssignmentView)),
          ),
        )
        // ------------------------------------------------------------------
        // listPayments
        // ------------------------------------------------------------------
        .handle('listPayments', ({ params: { teamId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('list', () =>
              payments.listByTeam(teamId, {
                memberId: query.memberId,
                feeId: query.feeId,
                from: query.from,
                to: query.to,
                includeVoided: Option.getOrElse(query.includeVoided, () => false),
              }),
            ),
            Effect.map(({ list }) => Array.map(list, toPaymentView)),
          ),
        )
        // ------------------------------------------------------------------
        // recordPayment
        // ------------------------------------------------------------------
        .handle('recordPayment', ({ params: { teamId, feeId, assignmentId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:record_payments', forbidden),
            ),
            Effect.bind('fee', () =>
              fees.findById(feeId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(feeNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ fee }) =>
              fee.team_id !== teamId ? Effect.fail(feeNotFound) : Effect.void,
            ),
            Effect.tap(({ fee }) =>
              Option.isSome(fee.archived_at) ? Effect.fail(feeArchived) : Effect.void,
            ),
            Effect.bind('assignment', () =>
              assignments.findById(assignmentId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(assignmentNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ assignment }) =>
              assignment.fee_id !== feeId ? Effect.fail(assignmentNotFound) : Effect.void,
            ),
            Effect.tap(() =>
              payload.amountMinor === 0 ? Effect.fail(invalidAmount) : Effect.void,
            ),
            Effect.bind('payment', ({ currentUser, assignment }) =>
              payments.insert({
                feeAssignmentId: assignmentId,
                teamMemberId: assignment.team_member_id,
                amountMinor: payload.amountMinor,
                method: payload.method,
                paidAt: payload.paidAt,
                note: payload.note,
                recordedByUserId: currentUser.id,
              }),
            ),
            Effect.map(({ payment }) =>
              toPaymentView({
                ...payment,
                member_name: Option.none(),
                recorder_name: Option.none(),
              }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed recording payment — no row returned'),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // voidPayment
        // ------------------------------------------------------------------
        .handle('voidPayment', ({ params: { teamId, paymentId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:record_payments', forbidden),
            ),
            Effect.bind('_payment', () =>
              payments.findActiveByIdAndTeam(paymentId, teamId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(paymentNotFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ currentUser }) =>
              payments.void_(paymentId, {
                voidedByUserId: currentUser.id,
                voidReason: payload.reason,
                voidedAt: DateTime.nowUnsafe(),
              }),
            ),
            Effect.asVoid,
          ),
        )
        // ------------------------------------------------------------------
        // overview
        // ------------------------------------------------------------------
        .handle('overview', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('rows', () => overview.overviewByTeam(teamId)),
            Effect.map(({ rows }) =>
              Array.map(
                rows,
                (row) =>
                  new FinanceApi.FinanceOverviewMemberRow({
                    teamMemberId: row.teamMemberId,
                    memberName: row.memberName,
                    currency: row.currency,
                    totalDueMinor: row.totalDueMinor,
                    totalPaidMinor: row.totalPaidMinor,
                    overdueCount: row.overdueCount,
                    pendingCount: row.pendingCount,
                    paidCount: row.paidCount,
                    creditMinor: row.creditMinor,
                  }),
              ),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // myStatus
        // ------------------------------------------------------------------
        .handle('myStatus', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('memberAssignments', ({ membership }) =>
              assignments.findByTeamMember(membership.id),
            ),
            Effect.bind('creditAccounts', ({ membership }) =>
              credits.listAccountsByMember(membership.id),
            ),
            Effect.map(({ memberAssignments, creditAccounts }) => {
              // Group assignments by currency
              const byCurrency = new Map<
                FinanceApi.MyFinanceStatus['currency'],
                {
                  currency: FinanceApi.MyFinanceStatus['currency'];
                  assignmentViews: FinanceApi.FeeAssignmentView[];
                  outstanding: number;
                  creditMinor: number;
                }
              >();

              for (const a of memberAssignments) {
                const existing = byCurrency.get(a.currency);
                const view = toAssignmentView(a);
                const outstanding =
                  a.computed_status !== 'waived' && a.computed_status !== 'paid'
                    ? Math.max(0, a.due_minor - a.paid_minor)
                    : 0;
                if (existing) {
                  existing.assignmentViews.push(view);
                  existing.outstanding += outstanding;
                } else {
                  byCurrency.set(a.currency, {
                    currency: a.currency,
                    assignmentViews: [view],
                    outstanding,
                    creditMinor: 0,
                  });
                }
              }

              // Merged in AFTER the assignment loop — a currency the member holds credit in but
              // has no assignments for still gets a group (`assignments: []`,
              // `totalOutstandingMinor: 0`), otherwise a member who paid in advance before any
              // fee exists sees nothing at all.
              for (const account of creditAccounts) {
                const existing = byCurrency.get(account.currency);
                if (existing) {
                  existing.creditMinor = account.balanceMinor;
                } else {
                  byCurrency.set(account.currency, {
                    currency: account.currency,
                    assignmentViews: [],
                    outstanding: 0,
                    creditMinor: account.balanceMinor,
                  });
                }
              }

              return Array.fromIterable(byCurrency.values()).map(
                (entry) =>
                  new FinanceApi.MyFinanceStatus({
                    currency: entry.currency,
                    assignments: entry.assignmentViews,
                    totalOutstandingMinor: entry.outstanding,
                    creditMinor: entry.creditMinor,
                  }),
              );
            }),
          ),
        )
        // ------------------------------------------------------------------
        // myPaymentHistory
        // ------------------------------------------------------------------
        .handle('myPaymentHistory', ({ params: { teamId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('list', ({ membership }) =>
              payments.listByTeam(teamId, {
                memberId: Option.some(membership.id),
                feeId: query.feeId,
                from: Option.none(),
                to: Option.none(),
                includeVoided: true,
              }),
            ),
            Effect.map(({ list }) => Array.map(list, toPaymentView)),
          ),
        )
        // ------------------------------------------------------------------
        // createSettlement
        // ------------------------------------------------------------------
        .handle('createSettlement', ({ params: { teamId, memberId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            // 'finance:record_payments' — a settlement creates payments rows; same trust
            // boundary as recordPayment, so no new permission literal.
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:record_payments', forbidden),
            ),
            Effect.bind('result', ({ currentUser }) =>
              credits.settle({
                teamId,
                teamMemberId: memberId,
                currency: payload.currency,
                amountMinor: payload.amountMinor,
                method: payload.method,
                paidAt: payload.paidAt,
                note: payload.note,
                expectedOutstandingMinor: payload.expectedOutstandingMinor,
                expectedCreditMinor: payload.expectedCreditMinor,
                recordedByUserId: currentUser.id,
              }),
            ),
            Effect.map(({ result }) => toSettlementResult(result)),
          ),
        )
        // ------------------------------------------------------------------
        // listMemberCreditDeposits
        // ------------------------------------------------------------------
        .handle('listMemberCreditDeposits', ({ params: { teamId, memberId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('membership', () => requireReadAccess(members, teamId, forbidden)),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            // Verify the requested member belongs to this team; return empty if not — same
            // pattern as listMemberAssignments (don't leak existence of a foreign member).
            Effect.bind('targetMember', () => members.findById(memberId)),
            Effect.bind('list', ({ targetMember }) => {
              if (Option.isNone(targetMember) || targetMember.value.team_id !== teamId) {
                return Effect.succeed([]);
              }
              return credits.listDepositsByMember({
                teamId,
                teamMemberId: memberId,
                currency: query.currency,
                includeVoided: Option.getOrElse(query.includeVoided, () => false),
              });
            }),
            Effect.map(({ list }) => Array.map(list, toMemberCreditDepositView)),
          ),
        )
        // ------------------------------------------------------------------
        // voidCreditDeposit
        // ------------------------------------------------------------------
        .handle('voidCreditDeposit', ({ params: { teamId, memberId, depositId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:record_payments', forbidden),
            ),
            Effect.tap(({ currentUser }) =>
              credits.voidDeposit({
                teamId,
                memberId,
                depositId,
                voidedByUserId: currentUser.id,
                reason: payload.reason,
              }),
            ),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
