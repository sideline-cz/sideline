import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema, SchemaGetter } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { AmountMinor, CurrencyCode, FeeId, FeeRecurrence, FeeTargetScope } from '~/models/Fee.js';
import { FeeAssignmentId, FeeAssignmentStatus } from '~/models/FeeAssignment.js';
import { MemberCreditDepositId } from '~/models/MemberCredit.js';
import { ManualPaymentMethod, PaymentId } from '~/models/Payment.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

// ---------------------------------------------------------------------------
// View types (response DTOs)
// ---------------------------------------------------------------------------

export class FeeView extends Schema.Class<FeeView>('FeeView')({
  feeId: FeeId,
  teamId: TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  dueAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  targetScope: FeeTargetScope,
  archivedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  assignmentCount: Schema.Number,
  paidCount: Schema.Number,
  pendingCount: Schema.Number,
  overdueCount: Schema.Number,
}) {}

export class FeeAssignmentView extends Schema.Class<FeeAssignmentView>('FeeAssignmentView')({
  assignmentId: FeeAssignmentId,
  feeId: FeeId,
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  feeName: Schema.String,
  currency: CurrencyCode,
  dueMinor: AmountMinor,
  paidMinor: AmountMinor,
  status: FeeAssignmentStatus,
  effectiveDueAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  waivedReason: Schema.OptionFromNullOr(Schema.String),
}) {}

export class PaymentView extends Schema.Class<PaymentView>('PaymentView')({
  paymentId: PaymentId,
  feeAssignmentId: FeeAssignmentId,
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  amountMinor: AmountMinor,
  // Tolerant reader: widening a stored enum that appears in a response DTO breaks every
  // already-loaded browser tab (rolling deploy) — an unknown literal must decode, not
  // fail the whole array. The web renders this through a closed Record with a neutral
  // fallback. The write side (RecordPaymentRequest/CreateSettlementRequest) stays closed.
  method: Schema.String,
  paidAt: Schemas.DateTimeFromIsoString,
  note: Schema.OptionFromNullOr(Schema.String),
  recorderName: Schema.OptionFromNullOr(Schema.String),
  voidedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  voidReason: Schema.OptionFromNullOr(Schema.String),
}) {}

export class FinanceOverviewMemberRow extends Schema.Class<FinanceOverviewMemberRow>(
  'FinanceOverviewMemberRow',
)({
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  currency: CurrencyCode,
  totalDueMinor: Schema.Number,
  totalPaidMinor: Schema.Number,
  overdueCount: Schema.Number,
  pendingCount: Schema.Number,
  paidCount: Schema.Number,
  // this row's currency, 0 when none
  creditMinor: Schema.Number,
}) {}

export class MyFinanceStatus extends Schema.Class<MyFinanceStatus>('MyFinanceStatus')({
  currency: CurrencyCode,
  assignments: Schema.Array(FeeAssignmentView),
  totalOutstandingMinor: Schema.Number,
  creditMinor: Schema.Number,
}) {}

export class SettlementAllocation extends Schema.Class<SettlementAllocation>(
  'SettlementAllocation',
)({
  assignmentId: FeeAssignmentId,
  feeId: FeeId,
  feeName: Schema.String,
  amountMinor: AmountMinor,
  source: Schema.Literals(['payment', 'credit']),
  statusAfter: FeeAssignmentStatus,
  // so the client can offer per-allocation undo
  paymentId: PaymentId,
}) {}

export class SettlementResult extends Schema.Class<SettlementResult>('SettlementResult')({
  currency: CurrencyCode,
  creditAppliedMinor: AmountMinor,
  paidMinor: AmountMinor,
  creditAddedMinor: AmountMinor,
  creditBalanceAfterMinor: AmountMinor,
  allocations: Schema.Array(SettlementAllocation),
}) {}

export class MemberCreditDepositView extends Schema.Class<MemberCreditDepositView>(
  'MemberCreditDepositView',
)({
  depositId: MemberCreditDepositId,
  teamMemberId: TeamMemberId,
  currency: CurrencyCode,
  amountMinor: AmountMinor,
  // Closed union, NOT Schema.String. Deposits are only ever written as ManualPaymentMethod
  // and that union is never widened, so tolerance here buys nothing against a value that
  // cannot go stale — it would just be noise.
  method: ManualPaymentMethod,
  paidAt: Schemas.DateTimeFromIsoString,
  note: Schema.OptionFromNullOr(Schema.String),
  recorderName: Schema.OptionFromNullOr(Schema.String),
  voidedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  voidReason: Schema.OptionFromNullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const CreateFeeRequest = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.OptionFromNullOr(Schema.String),
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  dueAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  targetScope: FeeTargetScope,
  recurrence: Schema.OptionFromOptional(FeeRecurrence),
});
export type CreateFeeRequest = Schema.Schema.Type<typeof CreateFeeRequest>;

export const UpdateFeeRequest = Schema.Struct({
  name: Schema.OptionFromOptional(Schema.NonEmptyString),
  description: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
  amountMinor: Schema.OptionFromOptional(AmountMinor),
  currency: Schema.OptionFromOptional(CurrencyCode),
  dueAt: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  targetScope: Schema.OptionFromOptional(FeeTargetScope),
});
export type UpdateFeeRequest = Schema.Schema.Type<typeof UpdateFeeRequest>;

export const AssignFeeRequest = Schema.Struct({
  memberIds: Schema.Array(TeamMemberId),
  amountMinorOverride: Schema.OptionFromNullOr(AmountMinor),
  dueAtOverride: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
});
export type AssignFeeRequest = Schema.Schema.Type<typeof AssignFeeRequest>;

export const UpdateAssignmentRequest = Schema.Struct({
  amountMinor: Schema.OptionFromOptional(AmountMinor),
  dueAt: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  waived: Schema.OptionFromOptional(Schema.Boolean),
  waivedReason: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schema.String)),
});
export type UpdateAssignmentRequest = Schema.Schema.Type<typeof UpdateAssignmentRequest>;

export const RecordPaymentRequest = Schema.Struct({
  amountMinor: AmountMinor,
  method: ManualPaymentMethod,
  paidAt: Schemas.DateTimeFromIsoString,
  note: Schema.OptionFromNullOr(Schema.String),
});
export type RecordPaymentRequest = Schema.Schema.Type<typeof RecordPaymentRequest>;

export const VoidPaymentRequest = Schema.Struct({
  reason: Schema.NonEmptyString,
});
export type VoidPaymentRequest = Schema.Schema.Type<typeof VoidPaymentRequest>;

export const CreateSettlementRequest = Schema.Struct({
  currency: CurrencyCode,
  // 0 is legal: pure credit application, or a no-op
  amountMinor: AmountMinor,
  // ignored when amountMinor === 0; never 'credit'
  method: ManualPaymentMethod,
  paidAt: Schemas.DateTimeFromIsoString,
  note: Schema.OptionFromNullOr(Schema.String),
  expectedOutstandingMinor: AmountMinor,
  // Reconciled alongside expectedOutstandingMinor — a credit balance that moved underneath
  // an open settle dialog (e.g. a concurrent voidDeposit) must 409, even when outstanding
  // alone still matches and the plan would otherwise be a silent no-op.
  expectedCreditMinor: AmountMinor,
});
export type CreateSettlementRequest = Schema.Schema.Type<typeof CreateSettlementRequest>;

export const VoidCreditDepositRequest = Schema.Struct({
  reason: Schema.NonEmptyString,
});
export type VoidCreditDepositRequest = Schema.Schema.Type<typeof VoidCreditDepositRequest>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FeeNotFound extends Schema.TaggedErrorClass<FeeNotFound>()('FeeNotFound', {}) {}

export class AssignmentNotFound extends Schema.TaggedErrorClass<AssignmentNotFound>()(
  'AssignmentNotFound',
  {},
) {}

export class PaymentNotFound extends Schema.TaggedErrorClass<PaymentNotFound>()(
  'PaymentNotFound',
  {},
) {}

export class InvalidAmount extends Schema.TaggedErrorClass<InvalidAmount>()('InvalidAmount', {}) {}

export class FinanceForbidden extends Schema.TaggedErrorClass<FinanceForbidden>()(
  'FinanceForbidden',
  {},
) {}

export class FeeArchived extends Schema.TaggedErrorClass<FeeArchived>()('FeeArchived', {}) {}

export class SettlementStale extends Schema.TaggedErrorClass<SettlementStale>()('SettlementStale', {
  // the server's figure, so the toast can be specific
  outstandingMinor: Schema.Number,
}) {}

export class FinanceMemberNotFound extends Schema.TaggedErrorClass<FinanceMemberNotFound>()(
  'FinanceMemberNotFound',
  {},
) {}

export class InsufficientCredit extends Schema.TaggedErrorClass<InsufficientCredit>()(
  'InsufficientCredit',
  {},
) {}

export class CreditDepositNotFound extends Schema.TaggedErrorClass<CreditDepositNotFound>()(
  'CreditDepositNotFound',
  {},
) {}

export class CreditDepositSpent extends Schema.TaggedErrorClass<CreditDepositSpent>()(
  'CreditDepositSpent',
  {},
) {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BooleanFromString = Schema.Literals(['true', 'false']).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((s: 'true' | 'false') => s === 'true'),
    encode: SchemaGetter.transform((b: boolean) => (b ? 'true' : 'false') as 'true' | 'false'),
  }),
);

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class FinanceApiGroup extends HttpApiGroup.make('finance')
  .add(
    HttpApiEndpoint.get('listFees', '/teams/:teamId/fees', {
      success: Schema.Array(FeeView),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createFee', '/teams/:teamId/fees', {
      success: FeeView.pipe(HttpApiSchema.status(201)),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        InvalidAmount.pipe(HttpApiSchema.status(400)),
      ],
      payload: CreateFeeRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getFee', '/teams/:teamId/fees/:feeId', {
      success: FeeView,
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FeeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, feeId: FeeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateFee', '/teams/:teamId/fees/:feeId', {
      success: FeeView,
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FeeNotFound.pipe(HttpApiSchema.status(404)),
        FeeArchived.pipe(HttpApiSchema.status(409)),
        InvalidAmount.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpdateFeeRequest,
      params: { teamId: TeamId, feeId: FeeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('archiveFee', '/teams/:teamId/fees/:feeId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FeeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, feeId: FeeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listAssignments', '/teams/:teamId/fees/:feeId/assignments', {
      success: Schema.Array(FeeAssignmentView),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FeeNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, feeId: FeeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listMemberAssignments', '/teams/:teamId/members/:memberId/assignments', {
      success: Schema.Array(FeeAssignmentView),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('assignFee', '/teams/:teamId/fees/:feeId/assignments', {
      success: Schema.Array(FeeAssignmentView).pipe(HttpApiSchema.status(201)),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FeeNotFound.pipe(HttpApiSchema.status(404)),
        FeeArchived.pipe(HttpApiSchema.status(409)),
        InvalidAmount.pipe(HttpApiSchema.status(400)),
      ],
      payload: AssignFeeRequest,
      params: { teamId: TeamId, feeId: FeeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch(
      'updateAssignment',
      '/teams/:teamId/fees/:feeId/assignments/:assignmentId',
      {
        success: FeeAssignmentView,
        error: [
          FinanceForbidden.pipe(HttpApiSchema.status(403)),
          FeeNotFound.pipe(HttpApiSchema.status(404)),
          AssignmentNotFound.pipe(HttpApiSchema.status(404)),
          FeeArchived.pipe(HttpApiSchema.status(409)),
          InvalidAmount.pipe(HttpApiSchema.status(400)),
        ],
        payload: UpdateAssignmentRequest,
        params: { teamId: TeamId, feeId: FeeId, assignmentId: FeeAssignmentId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listPayments', '/teams/:teamId/payments', {
      success: Schema.Array(PaymentView),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        memberId: Schema.OptionFromOptional(TeamMemberId),
        feeId: Schema.OptionFromOptional(FeeId),
        from: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
        to: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
        includeVoided: Schema.OptionFromOptional(BooleanFromString),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'recordPayment',
      '/teams/:teamId/fees/:feeId/assignments/:assignmentId/payments',
      {
        success: PaymentView.pipe(HttpApiSchema.status(201)),
        error: [
          FinanceForbidden.pipe(HttpApiSchema.status(403)),
          FeeNotFound.pipe(HttpApiSchema.status(404)),
          AssignmentNotFound.pipe(HttpApiSchema.status(404)),
          FeeArchived.pipe(HttpApiSchema.status(409)),
          InvalidAmount.pipe(HttpApiSchema.status(400)),
        ],
        payload: RecordPaymentRequest,
        params: { teamId: TeamId, feeId: FeeId, assignmentId: FeeAssignmentId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('voidPayment', '/teams/:teamId/payments/:paymentId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        PaymentNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: VoidPaymentRequest,
      params: { teamId: TeamId, paymentId: PaymentId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('overview', '/teams/:teamId/finance/overview', {
      success: Schema.Array(FinanceOverviewMemberRow),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('myStatus', '/teams/:teamId/finance/my-status', {
      success: Schema.Array(MyFinanceStatus),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('myPaymentHistory', '/teams/:teamId/finance/my-payments', {
      success: Schema.Array(PaymentView),
      error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        feeId: Schema.OptionFromOptional(FeeId),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createSettlement', '/teams/:teamId/members/:memberId/settlements', {
      success: SettlementResult.pipe(HttpApiSchema.status(201)),
      error: [
        FinanceForbidden.pipe(HttpApiSchema.status(403)),
        FinanceMemberNotFound.pipe(HttpApiSchema.status(404)),
        SettlementStale.pipe(HttpApiSchema.status(409)),
        InsufficientCredit.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateSettlementRequest,
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'listMemberCreditDeposits',
      '/teams/:teamId/members/:memberId/credits/deposits',
      {
        success: Schema.Array(MemberCreditDepositView),
        error: FinanceForbidden.pipe(HttpApiSchema.status(403)),
        params: { teamId: TeamId, memberId: TeamMemberId },
        // currency is REQUIRED, not optional: the popover is titled per currency, so
        // filtering server-side beats shipping rows the client must discard.
        query: {
          currency: CurrencyCode,
          includeVoided: Schema.OptionFromOptional(BooleanFromString),
        },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'voidCreditDeposit',
      '/teams/:teamId/members/:memberId/credits/deposits/:depositId',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          FinanceForbidden.pipe(HttpApiSchema.status(403)),
          CreditDepositNotFound.pipe(HttpApiSchema.status(404)),
          CreditDepositSpent.pipe(HttpApiSchema.status(409)),
        ],
        payload: VoidCreditDepositRequest,
        params: { teamId: TeamId, memberId: TeamMemberId, depositId: MemberCreditDepositId },
      },
    ).middleware(AuthMiddleware),
  ) {}
