import { Fee, MembershipPlan, type MembershipPlanApi, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { dateOnlyToUtcNoon, formatLocalDate } from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { formatMinorToMajor, parseAmount } from '~/lib/finance/parseAmount.js';
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Same anchoring approach as FeeFormDialog's parseDueAtField — noon UTC avoids
// timezone-drift issues (UTC±12 coverage). Empty string means "no expiry".
function parseExpiresAtField(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return Option.none();
  return Option.some(dateOnlyToUtcNoon(trimmed));
}

// `plan.name` is None only for the seeded default plan — render the translated label
// at every site that shows it (row, badge, and the edit form's seed value).
const planDisplayName = (plan: MembershipPlanApi.MembershipPlanInfo): string =>
  Option.getOrElse(plan.name, () => tr('membershipPlan_defaultName'));

// ---------------------------------------------------------------------------
// Form dialog
// ---------------------------------------------------------------------------

interface MembershipPlanFormDialogProps {
  teamId: Team.TeamId;
  open: boolean;
  mode: 'create' | 'edit';
  plan?: MembershipPlanApi.MembershipPlanInfo;
  onSaved: () => void;
  onClose: () => void;
}

function MembershipPlanFormDialog({
  teamId,
  open,
  mode,
  plan,
  onSaved,
  onClose,
}: MembershipPlanFormDialogProps) {
  const run = useRun();
  const isEdit = mode === 'edit';

  // Seeded from the raw Option, NOT `planDisplayName` — the seeded default plan's `name` is
  // None, and seeding the translated built-in label here would let an edit save that literal
  // string as the plan's permanent name (see MembershipPlanRequest's own comment). Rendering
  // list rows still goes through `planDisplayName`; only the form seed differs.
  const [name, setName] = React.useState(
    isEdit && plan ? Option.getOrElse(plan.name, () => '') : '',
  );
  const [priceStr, setPriceStr] = React.useState(
    isEdit && plan ? formatMinorToMajor(plan.priceMinor, plan.currency) : '',
  );
  const [currency, setCurrency] = React.useState(isEdit && plan ? plan.currency : 'CZK');
  const [pricePerTrainingStr, setPricePerTrainingStr] = React.useState(
    isEdit && plan ? formatMinorToMajor(plan.pricePerTrainingMinor, plan.currency) : '',
  );
  const [expiresAt, setExpiresAt] = React.useState(
    isEdit && plan && Option.isSome(plan.expiresAt) ? formatLocalDate(plan.expiresAt.value) : '',
  );
  const [nameError, setNameError] = React.useState('');
  const [priceError, setPriceError] = React.useState('');
  const [pricePerTrainingError, setPricePerTrainingError] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Reset when dialog opens/closes, mode changes, or the target plan changes.
  React.useEffect(() => {
    if (open) {
      setName(isEdit && plan ? Option.getOrElse(plan.name, () => '') : '');
      setPriceStr(isEdit && plan ? formatMinorToMajor(plan.priceMinor, plan.currency) : '');
      setCurrency(isEdit && plan ? plan.currency : 'CZK');
      setPricePerTrainingStr(
        isEdit && plan ? formatMinorToMajor(plan.pricePerTrainingMinor, plan.currency) : '',
      );
      setExpiresAt(
        isEdit && plan && Option.isSome(plan.expiresAt)
          ? formatLocalDate(plan.expiresAt.value)
          : '',
      );
      setNameError('');
      setPriceError('');
      setPricePerTrainingError('');
      setIsSubmitting(false);
    }
  }, [open, isEdit, plan]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let hasError = false;

    // A blank name is only invalid on CREATE — a new plan needs a name. On EDIT, blank is
    // legitimate and means "use the built-in translated label" (None on the wire).
    const trimmedName = name.trim();
    if (!isEdit && !trimmedName) {
      setNameError(tr('validation_required'));
      hasError = true;
    } else {
      setNameError('');
    }

    // A blank amount means "not entered" here, not "invalid" — both fields default to 0
    // (the price field's own placeholder is '0.00', and the per-training field is documented
    // as optional), so `parseAmount` must not see the empty string at all.
    let priceMinor = 0;
    try {
      priceMinor =
        priceStr.trim() === '' ? 0 : parseAmount(priceStr, currency, { allowZero: true });
      setPriceError('');
    } catch {
      setPriceError(tr('membershipPlan_priceInvalid'));
      hasError = true;
    }

    let pricePerTrainingMinor = 0;
    try {
      pricePerTrainingMinor =
        pricePerTrainingStr.trim() === ''
          ? 0
          : parseAmount(pricePerTrainingStr, currency, { allowZero: true });
      setPricePerTrainingError('');
    } catch {
      setPricePerTrainingError(tr('membershipPlan_priceInvalid'));
      hasError = true;
    }

    if (hasError) return;

    const payload: MembershipPlanApi.MembershipPlanRequest = {
      name: trimmedName
        ? Option.some(Schema.decodeSync(MembershipPlan.MembershipPlanName)(trimmedName))
        : Option.none(),
      priceMinor: Schema.decodeSync(Fee.AmountMinor)(priceMinor),
      currency: Schema.decodeSync(Fee.CurrencyCode)(currency),
      pricePerTrainingMinor: Schema.decodeSync(Fee.AmountMinor)(pricePerTrainingMinor),
      expiresAt: parseExpiresAtField(expiresAt),
    };

    setIsSubmitting(true);
    const result =
      isEdit && plan
        ? await ApiClient.asEffect().pipe(
            Effect.flatMap((api) =>
              api.membershipPlan.updateMembershipPlan({
                params: { teamId, membershipPlanId: plan.membershipPlanId },
                payload,
              }),
            ),
            Effect.catch((error): Effect.Effect<never, ClientError | SilentClientError> => {
              if (error._tag === 'MembershipPlanNameAlreadyTaken') {
                setNameError(tr('membershipPlan_nameAlreadyTaken'));
                return Effect.fail(new SilentClientError({ message: error._tag }));
              }
              return Effect.fail(ClientError.make(tr('membershipPlan_updateFailed')));
            }),
            run({ success: tr('membershipPlan_updated') }),
          )
        : await ApiClient.asEffect().pipe(
            Effect.flatMap((api) =>
              api.membershipPlan.createMembershipPlan({ params: { teamId }, payload }),
            ),
            Effect.catch((error): Effect.Effect<never, ClientError | SilentClientError> => {
              if (error._tag === 'MembershipPlanNameAlreadyTaken') {
                setNameError(tr('membershipPlan_nameAlreadyTaken'));
                return Effect.fail(new SilentClientError({ message: error._tag }));
              }
              return Effect.fail(ClientError.make(tr('membershipPlan_createFailed')));
            }),
            run({ success: tr('membershipPlan_created') }),
          );
    setIsSubmitting(false);

    if (Option.isSome(result)) {
      onSaved();
      onClose();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? tr('membershipPlan_editTitle') : tr('membershipPlan_createTitle')}
          </DialogTitle>
          <DialogDescription>{tr('membershipPlan_dialogDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Name */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-name'>{tr('membershipPlan_name')}</Label>
            <Input
              id='membership-plan-name'
              value={name}
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('membershipPlan_namePlaceholder')}
            />
            {isEdit && (
              <p className='text-xs text-muted-foreground'>{tr('membershipPlan_nameEditHint')}</p>
            )}
            {nameError && <p className='text-sm text-destructive'>{nameError}</p>}
          </div>

          {/* Price */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-price'>{tr('membershipPlan_price')}</Label>
            <Input
              id='membership-plan-price'
              type='number'
              step='0.01'
              min='0'
              inputMode='decimal'
              value={priceStr}
              onChange={(e) => setPriceStr(e.target.value)}
              placeholder='0.00'
            />
            <p className='text-xs text-muted-foreground'>{tr('membershipPlan_priceHint')}</p>
            {priceError && <p className='text-sm text-destructive'>{priceError}</p>}
          </div>

          {/* Currency — mandatory here even in the edit form: the update payload is a full
              replace, so omitting it would silently rewrite the plan's currency. */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-currency'>{tr('membershipPlan_currency')}</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id='membership-plan-currency'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='CZK'>CZK</SelectItem>
                <SelectItem value='EUR'>EUR</SelectItem>
                <SelectItem value='USD'>USD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Price per training */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-price-per-training'>
              {tr('membershipPlan_pricePerTraining')}
            </Label>
            <Input
              id='membership-plan-price-per-training'
              type='number'
              step='0.01'
              min='0'
              inputMode='decimal'
              value={pricePerTrainingStr}
              onChange={(e) => setPricePerTrainingStr(e.target.value)}
              placeholder='0.00'
            />
            <p className='text-xs text-muted-foreground'>
              {tr('membershipPlan_pricePerTrainingHint')}
            </p>
            {pricePerTrainingError && (
              <p className='text-sm text-destructive'>{pricePerTrainingError}</p>
            )}
          </div>

          {/* Expires on */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-expiresAt'>{tr('membershipPlan_expiresOnField')}</Label>
            <Input
              id='membership-plan-expiresAt'
              type='date'
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className='text-xs text-muted-foreground'>{tr('membershipPlan_expiresOnHint')}</p>
          </div>

          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              {tr('common_cancel')}
            </Button>
            <Button type='submit' disabled={isSubmitting}>
              {isSubmitting
                ? isEdit
                  ? tr('membershipPlan_saving')
                  : tr('membershipPlan_creating')
                : isEdit
                  ? tr('membershipPlan_save')
                  : tr('membershipPlan_create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface MembershipPlansPageProps {
  teamId: string;
  canManage: boolean;
  plans: ReadonlyArray<MembershipPlanApi.MembershipPlanInfo>;
}

export function MembershipPlansPage({ teamId, canManage, plans }: MembershipPlansPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<MembershipPlanApi.MembershipPlanInfo | null>(
    null,
  );

  const editTargetRef = React.useRef<MembershipPlanApi.MembershipPlanInfo | null>(null);
  if (editTarget !== null) editTargetRef.current = editTarget;

  const handleSaved = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  const handleMakeDefault = React.useCallback(
    async (plan: MembershipPlanApi.MembershipPlanInfo) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.membershipPlan.setDefaultMembershipPlan({
            params: { teamId: teamIdBranded, membershipPlanId: plan.membershipPlanId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('membershipPlan_defaultChangeFailed'))),
        run({ success: tr('membershipPlan_defaultChanged') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  const handleArchive = React.useCallback(
    async (plan: MembershipPlanApi.MembershipPlanInfo) => {
      const name = planDisplayName(plan);
      if (!window.confirm(tr('membershipPlan_archiveConfirm', { name }))) {
        return;
      }

      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.membershipPlan.deleteMembershipPlan({
            params: { teamId: teamIdBranded, membershipPlanId: plan.membershipPlanId },
          }),
        ),
        Effect.mapError((e) =>
          e._tag === 'MembershipPlanIsDefault'
            ? ClientError.make(tr('membershipPlan_cantArchiveDefault'))
            : ClientError.make(tr('membershipPlan_archiveFailed')),
        ),
        run({ success: tr('membershipPlan_archived') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('membershipPlan_title')}</h1>
        <p className='text-muted-foreground mt-1'>{tr('membershipPlan_subtitle')}</p>
      </header>

      {canManage && (
        <div className='flex justify-end mb-4'>
          <Button onClick={() => setCreateOpen(true)}>+ {tr('membershipPlan_add')}</Button>
        </div>
      )}

      {plans.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <p className='font-medium'>{tr('membershipPlan_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('membershipPlan_empty_subtitle')}</p>
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>{tr('membershipPlan_add')}</Button>
          )}
        </div>
      ) : (
        <div className='flex flex-col gap-2'>
          {plans.map((plan) => {
            const name = planDisplayName(plan);
            const priceLabel =
              plan.priceMinor === 0
                ? tr('membershipPlan_priceFree')
                : formatMoney(plan.priceMinor, plan.currency, 'en');
            const perTrainingLabel = tr('membershipPlan_perTraining', {
              amount: formatMoney(plan.pricePerTrainingMinor, plan.currency, 'en'),
            });
            const expiresLabel = Option.isSome(plan.expiresAt)
              ? tr('membershipPlan_expiresOn', { date: formatLocalDate(plan.expiresAt.value) })
              : tr('membershipPlan_noExpiry');

            return (
              <div
                key={plan.membershipPlanId}
                className='flex flex-wrap items-center gap-3 rounded-lg border p-3'
              >
                <div className='min-w-0 flex-1 basis-40'>
                  <div className='flex items-center gap-2 font-medium truncate'>
                    <span className='truncate'>{name}</span>
                    {plan.isDefault && (
                      <Badge variant='secondary'>{tr('membershipPlan_defaultBadge')}</Badge>
                    )}
                  </div>
                  <div className='text-xs text-muted-foreground'>
                    {priceLabel} · {perTrainingLabel} · {expiresLabel}
                  </div>
                </div>
                {canManage && (
                  <div className='ml-auto flex flex-wrap items-center gap-1'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={plan.isDefault}
                      aria-label={tr('membershipPlan_makeDefaultAria', { name })}
                      onClick={() => handleMakeDefault(plan)}
                    >
                      {tr('membershipPlan_makeDefault')}
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      aria-label={tr('membershipPlan_editAria', { name })}
                      onClick={() => setEditTarget(plan)}
                    >
                      {tr('membershipPlan_edit')}
                    </Button>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      aria-label={tr('membershipPlan_archiveAria', { name })}
                      onClick={() => handleArchive(plan)}
                    >
                      {tr('membershipPlan_archiveAction')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Create dialog */}
      <MembershipPlanFormDialog
        teamId={teamIdBranded}
        mode='create'
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={handleSaved}
      />

      {/* Edit dialog */}
      <MembershipPlanFormDialog
        teamId={teamIdBranded}
        mode='edit'
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        onSaved={handleSaved}
        plan={editTarget ?? editTargetRef.current ?? undefined}
      />
    </div>
  );
}
