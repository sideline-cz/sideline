import type { MembershipPlan, MembershipPlanApi, Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// A non-empty string, because Radix `Select` throws on `value=""` for an item. Shared with
// `MembershipPlansPage`, which uses the same sentinel in its per-row selects.
export const DEFAULT_SENTINEL = '__default__';

type PlanKey = MembershipPlan.MembershipPlanId | typeof DEFAULT_SENTINEL;

interface MoveOption {
  readonly key: PlanKey;
  readonly label: string;
}

interface MoveMembersDialogProps {
  readonly teamId: Team.TeamId;
  /** ACTIVE plans only — an archived plan is a legal SOURCE but never a target (plan §B.7). */
  readonly plans: ReadonlyArray<MembershipPlanApi.MembershipPlanInfo>;
  readonly assignments: ReadonlyArray<MembershipPlanApi.MembershipPlanAssignment>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMoved: () => void;
}

// Mirrors the server's `IS NOT DISTINCT FROM`: a member who never picked is bucketed under the
// sentinel, NOT under the default plan's own id. Those are two different populations that move
// two different sets of people, which is why both are offered as separate sources below.
const keyOf = (assignment: MembershipPlanApi.MembershipPlanAssignment): PlanKey =>
  Option.getOrElse(assignment.membershipPlanId, () => DEFAULT_SENTINEL);

/**
 * Bulk "move everyone from plan A to plan B" (plan §B.5). One atomic server-side UPDATE, never
 * a client loop — a blip halfway through a loop would leave a half-moved team and a dialog that
 * lied about the count.
 */
export function MoveMembersDialog({
  teamId,
  plans,
  assignments,
  open,
  onOpenChange,
  onMoved,
}: MoveMembersDialogProps) {
  const run = useRun();

  const [source, setSource] = React.useState<PlanKey>(DEFAULT_SENTINEL);
  const [target, setTarget] = React.useState<PlanKey>(DEFAULT_SENTINEL);
  const [moving, setMoving] = React.useState(false);

  // This component stays MOUNTED across open/close, so without this the highest-value use —
  // sweeping an archived plan — leaves `source` holding an id that is no longer in
  // `sourceOptions` (nobody is on it any more), and reopening shows a blank trigger.
  React.useEffect(() => {
    if (open) {
      setSource(DEFAULT_SENTINEL);
      setTarget(DEFAULT_SENTINEL);
    }
  }, [open]);

  const countOf = React.useCallback(
    (key: PlanKey) => assignments.filter((a) => keyOf(a) === key).length,
    [assignments],
  );

  // Every option carries its member count, because "Team default" (never picked) and the
  // default plan's OWN id sit next to each other in this list and read almost the same. The
  // counts are what stops a treasurer picking one, moving half the team, and being confirmed
  // the wrong number. Plan options also carry their currency — it appears nowhere else on this
  // screen, and a cross-currency move is the expensive mistake here (plan §A.1).
  const withCount = React.useCallback(
    (name: string, key: PlanKey): string =>
      tr('membershipPlan_bulk_optionWithCount', { name, count: countOf(key) }),
    [countOf],
  );

  // The currency every member with no ACTIVE plan of their own is billed at — the never-picked
  // crowd and anyone left on an archived plan both fall back to the team default
  // (`1793200000_training_period_fees.ts:113-130`).
  const defaultCurrency = plans.find((p) => p.isDefault)?.currency;

  const targetOptions: ReadonlyArray<MoveOption> = React.useMemo(
    () => [
      {
        key: DEFAULT_SENTINEL,
        // Suffixed like the plan options: without it this is the one entry in the list whose
        // currency is invisible, and it is the most-picked source there is.
        label: withCount(
          defaultCurrency === undefined
            ? tr('membershipPlan_bulk_defaultOption')
            : `${tr('membershipPlan_bulk_defaultOption')} · ${defaultCurrency}`,
          DEFAULT_SENTINEL,
        ),
      },
      ...plans.map((plan) => ({
        key: plan.membershipPlanId,
        label: withCount(
          `${Option.getOrElse(plan.name, () => tr('membershipPlan_defaultName'))} · ${plan.currency}`,
          plan.membershipPlanId,
        ),
      })),
    ],
    [defaultCurrency, plans, withCount],
  );

  // `plans` holds active rows only, so a member sitting on an archived plan is invisible to the
  // list above — their FK is the archived id, not NULL, so the "team default" source would never
  // match them either. Deriving one synthetic source entry per orphan id is what makes the
  // archived-plan sweep — the single most valuable bulk case — reachable at all. Source only:
  // an archived plan stays refused as a TARGET (plan §B.7).
  const sourceOptions: ReadonlyArray<MoveOption> = React.useMemo(() => {
    const orphanIds = [
      ...new Set(
        assignments.flatMap((a) =>
          Option.match(a.membershipPlanId, {
            onNone: () => [],
            onSome: (id) => (plans.some((p) => p.membershipPlanId === id) ? [] : [id]),
          }),
        ),
      ),
    ];
    return [
      ...targetOptions,
      // The archived plan's NAME is not on the wire — `findMembershipPlansByTeamId` filters
      // `archived_at IS NULL` — so two archived plans would otherwise render as two identical
      // "Archived plan" rows. The id prefix is the only disambiguator available here.
      ...orphanIds.map((id) => ({
        key: id,
        label: withCount(`${tr('membershipPlan_bulk_archivedSource')} ${id.slice(0, 8)}`, id),
      })),
    ];
  }, [assignments, plans, targetOptions, withCount]);

  // Mirrors the server UPDATE exactly: `keyOf(a) === source` is its `IS NOT DISTINCT FROM`,
  // `keyOf(a) !== target` its `IS DISTINCT FROM`. Source == target therefore yields 0 and
  // disables Confirm through the ordinary count rule — there is no separate equality check.
  const affected = assignments.filter((a) => keyOf(a) === source && keyOf(a) !== target).length;

  // `plans` holds ACTIVE rows only, so a direct lookup misses for the sentinel AND for an
  // archived orphan id — and those are the three shapes that matter: never-picked → plan,
  // archived → plan, plan → clear-to-default. All three genuinely change currency, because
  // the charge query bills both populations at the TEAM DEFAULT plan's currency
  // (`1793200000_training_period_fees.ts:113-130`). A direct-lookup-only check is therefore
  // silent for the single most likely use of this dialog.
  const currencyOf = (key: PlanKey): string | undefined =>
    plans.find((p) => p.membershipPlanId === key)?.currency ?? defaultCurrency;
  const sourceCurrency = currencyOf(source);
  const targetCurrency = currencyOf(target);
  const crossesCurrency =
    sourceCurrency !== undefined &&
    targetCurrency !== undefined &&
    sourceCurrency !== targetCurrency;
  // Deliberately NOT routed through `currencyOf`'s default fallback: only an ACTIVE plan as
  // source means "these people picked this themselves". The sentinel is the never-picked
  // crowd, and an archived source is a plan they can no longer see.
  const overwritesChoices = plans.some((p) => p.membershipPlanId === source) && affected > 0;

  const pick = (options: ReadonlyArray<MoveOption>, value: string): PlanKey =>
    options.find((o) => o.key === value)?.key ?? DEFAULT_SENTINEL;

  const handleConfirm = async () => {
    setMoving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.membershipPlan.reassignMembershipPlan({
          params: { teamId },
          payload: {
            fromMembershipPlanId: source === DEFAULT_SENTINEL ? Option.none() : Option.some(source),
            toMembershipPlanId: target === DEFAULT_SENTINEL ? Option.none() : Option.some(target),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('membershipPlan_bulk_failed'))),
      run({}),
    );
    setMoving(false);
    if (Option.isSome(result)) {
      // The SERVER's count, never `affected` — a concurrent single-row assign between render
      // and submit changes the set, so the prediction is advisory (plan §B.8). It is only known
      // after the call returns, which is why it cannot ride on `run({ success })`.
      toast.success(tr('membershipPlan_bulk_moved', { count: result.value.movedCount }));
      onOpenChange(false);
      onMoved();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr('membershipPlan_bulk_title')}</DialogTitle>
          <DialogDescription>{tr('membershipPlan_bulk_billingNotice')}</DialogDescription>
        </DialogHeader>

        <div className='flex flex-col gap-3'>
          {/* Visible labels, not just `aria-label` — two unlabelled dropdowns stacked in a
              dialog body read as one control to a sighted user, and picking the wrong one here
              moves the wrong people. */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-bulk-source'>{tr('membershipPlan_bulk_fromLabel')}</Label>
            <Select value={source} onValueChange={(v) => setSource(pick(sourceOptions, v))}>
              <SelectTrigger
                id='membership-bulk-source'
                aria-label={tr('membershipPlan_bulk_fromLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-bulk-target'>{tr('membershipPlan_bulk_toLabel')}</Label>
            <Select value={target} onValueChange={(v) => setTarget(pick(targetOptions, v))}>
              <SelectTrigger
                id='membership-bulk-target'
                aria-label={tr('membershipPlan_bulk_toLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className='text-sm font-medium'>
            {tr('membershipPlan_bulk_affected', { count: affected })}
          </p>
          {overwritesChoices && (
            <p className='text-sm text-muted-foreground'>
              {tr('membershipPlan_bulk_overwritesChoices', { count: affected })}
            </p>
          )}
          {crossesCurrency && (
            <p className='text-sm text-destructive'>{tr('membershipPlan_bulk_currencyWarning')}</p>
          )}
        </div>

        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
            {tr('common_cancel')}
          </Button>
          <Button type='button' disabled={moving || affected === 0} onClick={handleConfirm}>
            {tr('membershipPlan_bulk_confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
