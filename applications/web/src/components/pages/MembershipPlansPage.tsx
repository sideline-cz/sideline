import { Fee, MembershipPlan, type MembershipPlanApi, Team } from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import React from 'react';
import { DEFAULT_SENTINEL, MoveMembersDialog } from '~/components/organisms/MoveMembersDialog.js';
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
import {
  dateOnlyToLocalEndOfDay,
  dateOnlyToLocalStartOfDay,
  formatLocalDate,
  formatLocalTime,
} from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { formatMinorToMajor, parseAmount } from '~/lib/finance/parseAmount.js';
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// AN EMPTY BOX MEANS `None`, on every season date. There is no Clear button any more: a blank
// box is unambiguous because every box is seeded from its own season's own RAW column (§2.4), so
// a box is blank only when the column is actually NULL. The deleted early return this replaces
// (`if (!trimmed) return;`) made blanking a field a silent no-op behind a success toast.
const parseSeasonDate = (value: string): Option.Option<DateTime.Utc> => {
  const trimmed = value.trim();
  return trimmed ? Option.some(dateOnlyToLocalEndOfDay(trimmed)) : Option.none();
};

/** `yyyy-MM-dd` in the browser's local timezone, for a plain `Date`. */
const localDateString = (d: Date): string => formatLocalDate(DateTime.fromDateUnsafe(d));

const toLocalDate = (dt: DateTime.Utc): Date => new Date(Number(DateTime.toEpochMillis(dt)));

// `<=`, not `<`, so the web agrees with the server (`<= now()`) and the bot
// (`isLessThanOrEqualTo`) on the boundary instant instead of disagreeing for one millisecond.
const hasPassed = (instant: Option.Option<DateTime.Utc>): boolean =>
  Option.isSome(instant) && DateTime.isLessThanOrEqualTo(instant.value, DateTime.nowUnsafe());

// `plan.name` is None only for the seeded default plan — render the translated label
// at every site that shows it (row, badge, and the edit form's seed value).
const planDisplayName = (plan: MembershipPlanApi.MembershipPlanInfo): string =>
  Option.getOrElse(plan.name, () => tr('membershipPlan_defaultName'));

// The member's EFFECTIVE plan: their raw chosen plan IF it's still in this (active-only) list,
// otherwise the team's current default. Falling through to the default covers TWO cases with
// the same line: the member never chose (`selectedPlanId` is `None`), and the member's chosen
// plan was since archived (archived plans aren't in `plans` at all, so the id lookup below just
// misses). Both read as "no real choice on record" and both should show the default, not a
// blank row.
const resolveEffectivePlanId = (
  plans: ReadonlyArray<MembershipPlanApi.MembershipPlanInfo>,
  selectedPlanId: Option.Option<MembershipPlan.MembershipPlanId>,
): string | undefined => {
  const chosenId = Option.getOrUndefined(selectedPlanId);
  const chosenIsActive =
    chosenId !== undefined && plans.some((p) => p.membershipPlanId === chosenId);
  return chosenIsActive ? chosenId : plans.find((p) => p.isDefault)?.membershipPlanId;
};

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
  const [freeTrainingsStr, setFreeTrainingsStr] = React.useState(
    isEdit && plan && plan.freeTrainingsIncluded > 0 ? String(plan.freeTrainingsIncluded) : '',
  );
  const [nameError, setNameError] = React.useState('');
  const [priceError, setPriceError] = React.useState('');
  const [pricePerTrainingError, setPricePerTrainingError] = React.useState('');
  const [freeTrainingsError, setFreeTrainingsError] = React.useState('');
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
      setFreeTrainingsStr(
        isEdit && plan && plan.freeTrainingsIncluded > 0 ? String(plan.freeTrainingsIncluded) : '',
      );
      setNameError('');
      setPriceError('');
      setPricePerTrainingError('');
      setFreeTrainingsError('');
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

    // Blank means "no allowance" (0), same convention as the two amount fields above. The
    // bounds mirror `FreeTrainingsIncluded` so the user sees a field error instead of
    // `decodeSync` throwing past the try/catch below.
    const freeTrainings = Number(freeTrainingsStr.trim() === '' ? '0' : freeTrainingsStr);
    if (!Number.isInteger(freeTrainings) || freeTrainings < 0 || freeTrainings > 999) {
      setFreeTrainingsError(tr('membershipPlan_freeTrainingsInvalid'));
      hasError = true;
    } else {
      setFreeTrainingsError('');
    }

    if (hasError) return;

    const payload: MembershipPlanApi.MembershipPlanRequest = {
      name: trimmedName
        ? Option.some(Schema.decodeSync(MembershipPlan.MembershipPlanName)(trimmedName))
        : Option.none(),
      priceMinor: Schema.decodeSync(Fee.AmountMinor)(priceMinor),
      currency: Schema.decodeSync(Fee.CurrencyCode)(currency),
      pricePerTrainingMinor: Schema.decodeSync(Fee.AmountMinor)(pricePerTrainingMinor),
      // Always `Some` — the key is optional on the wire only so that an OLD bundle, which does
      // not know the field, gets "keep the stored value" instead of a 400. This bundle knows it.
      freeTrainingsIncluded: Option.some(
        Schema.decodeSync(MembershipPlan.FreeTrainingsIncluded)(freeTrainings),
      ),
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

          {/* Free trainings per period */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='membership-plan-free-trainings'>
              {tr('membershipPlan_freeTrainings')}
            </Label>
            <Input
              id='membership-plan-free-trainings'
              type='number'
              step='1'
              min='0'
              max='999'
              inputMode='numeric'
              value={freeTrainingsStr}
              onChange={(e) => setFreeTrainingsStr(e.target.value)}
              placeholder='0'
            />
            <p className='text-xs text-muted-foreground'>
              {tr('membershipPlan_freeTrainingsHint')}
            </p>
            {freeTrainingsError && <p className='text-sm text-destructive'>{freeTrainingsError}</p>}
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
// Season block
// ---------------------------------------------------------------------------

/** One season's three date boxes, as `yyyy-MM-dd` strings. */
interface SeasonForm {
  startsAt: string;
  deadline: string;
  expiresAt: string;
}

const EMPTY_SEASON_FORM: SeasonForm = { startsAt: '', deadline: '', expiresAt: '' };

// THE seeding rule, in one function: every box comes from its own season object's own RAW
// column. Nothing here reads the top-level display-only `selectionDeadline` / `seasonExpiresAt`
// pair, and nothing may — a box seeded from a derived value and then written back is the
// data-destruction loop two review rounds found.
const seedSeasonForm = (season: Option.Option<MembershipPlanApi.SeasonInfo>): SeasonForm =>
  Option.match(season, {
    onNone: () => EMPTY_SEASON_FORM,
    onSome: (s) => ({
      startsAt: formatLocalDate(s.startsAt),
      deadline: Option.match(s.selectionDeadline, { onNone: () => '', onSome: formatLocalDate }),
      expiresAt: Option.match(s.expiresAt, { onNone: () => '', onSome: formatLocalDate }),
    }),
  });

// The ONE blocking validation, and it mirrors the DB CHECK (`expires_at > starts_at`) so it
// invents no rule of its own. `deadline < startsAt` is deliberately NOT flagged: "pick in August
// for the September season" is the normal rollover shape. `deadline > expiresAt` is not flagged
// either — it is inert, not wrong (the expiry closes selection first).
const isSeasonOrderInvalid = (form: SeasonForm): boolean =>
  form.startsAt !== '' && form.expiresAt !== '' && form.expiresAt < form.startsAt;

interface SeasonBlockProps {
  /** `season-*` / `next-season-*`. A duplicate id here means typing next season's deadline
   *  into this one, so the two blocks' controls are disjoint by construction. */
  idPrefix: string;
  heading: string;
  badge?: React.ReactNode;
  form: SeasonForm;
  onChange: (patch: Partial<SeasonForm>) => void;
  /** Current season: the start is history, so it is read-only TEXT (design §2.5). */
  startEditable: boolean;
  /** Clamped past both today and the current season's expiry, so the server's
   *  `SeasonStartNotInFuture` 400 is unreachable from the UI. */
  startMin?: string;
  startRef?: React.RefObject<HTMLInputElement | null>;
  hint: string;
  error: string;
  isSaving: boolean;
  saveDisabled?: boolean;
  savePrimary?: boolean;
  onSave: () => void;
  onCancel?: () => void;
}

function SeasonBlock({
  idPrefix,
  heading,
  badge,
  form,
  onChange,
  startEditable,
  startMin,
  startRef,
  hint,
  error,
  isSaving,
  saveDisabled,
  savePrimary,
  onSave,
  onCancel,
}: SeasonBlockProps) {
  // Both the deadline and the expiry keep the `min` the lone deadline input carried: an
  // `<input type='date'>` accepts a 1-4 digit year, so typing `0026-09-30` decodes as 1926 and
  // instantly locks selection.
  const today = formatLocalDate(DateTime.nowUnsafe());

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        {/* A real `h2`, same level as "Member assignments", so heading navigation exposes the
            current/next split to readers who cannot use the spatial cue. */}
        <h2 className='text-sm font-semibold'>{heading}</h2>
        {badge}
      </div>
      <div className='flex flex-wrap items-end gap-2'>
        <div className='flex min-w-[150px] flex-1 flex-col gap-1.5'>
          {/* `htmlFor` is SPREAD, not passed as `undefined`: Biome strips an `undefined` JSX prop
              on format, and a label pointing at an id that does not exist is worse than no
              association at all. In the read-only branch below there is no control to point at,
              so the label legitimately has none and the value follows it in reading order. */}
          <Label {...(startEditable ? { htmlFor: `${idPrefix}-starts` } : {})}>
            {tr('membershipPlan_season_startsLabel')}
          </Label>
          {startEditable ? (
            <Input
              id={`${idPrefix}-starts`}
              ref={startRef}
              type='date'
              min={startMin}
              aria-invalid={error !== '' || undefined}
              value={form.startsAt}
              onChange={(e) => onChange({ startsAt: e.target.value })}
            />
          ) : (
            // Keeps its `<Label>` and its place in the reading order, but offers no control:
            // moving a running season's start re-anchors an already-invoiced month's free
            // trainings, which is not something to do by tabbing through a date box.
            <p className='py-2 text-sm'>{form.startsAt}</p>
          )}
        </div>
        <div className='flex min-w-[150px] flex-1 flex-col gap-1.5'>
          <Label htmlFor={`${idPrefix}-deadline`}>{tr('membershipPlan_deadlineLabel')}</Label>
          <Input
            id={`${idPrefix}-deadline`}
            type='date'
            min={today}
            value={form.deadline}
            onChange={(e) => onChange({ deadline: e.target.value })}
          />
        </div>
        <div className='flex min-w-[150px] flex-1 flex-col gap-1.5'>
          <Label htmlFor={`${idPrefix}-ends`}>{tr('membershipPlan_season_endsLabel')}</Label>
          <Input
            id={`${idPrefix}-ends`}
            type='date'
            min={today}
            aria-invalid={error !== '' || undefined}
            value={form.expiresAt}
            onChange={(e) => onChange({ expiresAt: e.target.value })}
          />
        </div>
      </div>
      <p className='text-xs text-muted-foreground'>{hint}</p>
      {error !== '' && (
        <p className='text-sm text-destructive' role='alert'>
          {error}
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        {onCancel && (
          <Button type='button' variant='outline' size='sm' disabled={isSaving} onClick={onCancel}>
            {tr('common_cancel')}
          </Button>
        )}
        {/* One Save per block, INSIDE the block: a Save button can only ever write the season
            whose box it sits in. That is the whole anti-confusion mechanism. */}
        <Button
          type='button'
          variant={savePrimary ? 'default' : 'outline'}
          size='sm'
          disabled={isSaving || saveDisabled}
          onClick={onSave}
        >
          {isSaving ? tr('membershipPlan_saving') : tr('membershipPlan_save')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

interface MembershipPlansPageProps {
  teamId: string;
  canManage: boolean;
  plans: ReadonlyArray<MembershipPlanApi.MembershipPlanInfo>;
  selectedPlanId: Option.Option<MembershipPlan.MembershipPlanId>;
  /**
   * DISPLAY ONLY, both of them — the GOVERNING season's raw deadline/expiry, picked server-side.
   * They drive the member's notice and the advisory greying of Choose, and they reach NO request
   * body and NO input. The two-candidate pick lives in exactly one place, SQL; re-deriving it
   * here from the two season objects would run it against the browser clock.
   */
  selectionDeadline: Option.Option<DateTime.Utc>;
  seasonExpiresAt: Option.Option<DateTime.Utc>;
  /** SEEDING. The Current block's boxes come from here and its Save writes back here. */
  currentSeason: Option.Option<MembershipPlanApi.SeasonInfo>;
  /** SEEDING. Same pairing for the Next block — one block, one row, one Save. */
  nextSeason: Option.Option<MembershipPlanApi.SeasonInfo>;
  /** Empty for non-managers by construction — the server only fills this under `finance:manage_fees`. */
  assignments: ReadonlyArray<MembershipPlanApi.MembershipPlanAssignment>;
}

export function MembershipPlansPage({
  teamId,
  canManage,
  plans,
  selectedPlanId,
  selectionDeadline,
  seasonExpiresAt,
  currentSeason,
  nextSeason,
  assignments,
}: MembershipPlansPageProps) {
  const run = useRun();
  const router = useRouter();
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editTarget, setEditTarget] = React.useState<MembershipPlanApi.MembershipPlanInfo | null>(
    null,
  );

  const effectivePlanId = resolveEffectivePlanId(plans, selectedPlanId);

  // Advisory only — clock skew between browser and server means this can be a little wrong in
  // either direction. The server re-checks on the actual PUT (`MembershipSelectionClosed`,
  // handled below); this only decides whether to grey out the Choose buttons up front.
  //
  // THE SAME THREE LINES THE BOT RUNS, on the SAME server-picked pair, and EXPIRY WINS when both
  // have passed: a finished season is the better explanation and needs a different next action
  // than a missed deadline. Both closed states disable Choose identically; only the copy differs.
  const seasonEnded = hasPassed(seasonExpiresAt);
  const isSelectionClosed = seasonEnded || hasPassed(selectionDeadline);

  // Seeded from the loader; a plain `useState` synced on prop change (not react-hook-form —
  // its `reset`/`keepDirtyValues` merges `resetOptions` in a way that can keep edits a discard
  // should throw away). Re-synced via `useEffect` because `router.invalidate()` after a Save
  // re-renders this component with new props, not a fresh mount.
  //
  // ONE useEffect PER BLOCK, each reading only its OWN season object. Nothing here touches the
  // display-only pair above.
  const [currentForm, setCurrentForm] = React.useState(() => seedSeasonForm(currentSeason));
  React.useEffect(() => {
    setCurrentForm(seedSeasonForm(currentSeason));
  }, [currentSeason]);
  const [nextForm, setNextForm] = React.useState(() => seedSeasonForm(nextSeason));
  React.useEffect(() => {
    setNextForm(seedSeasonForm(nextSeason));
  }, [nextSeason]);

  const [currentError, setCurrentError] = React.useState('');
  const [nextError, setNextError] = React.useState('');
  const [isSavingCurrent, setIsSavingCurrent] = React.useState(false);
  const [isSavingNext, setIsSavingNext] = React.useState(false);
  // "Start new season" issues NO request — it is a pure UI reveal; the block's first Save
  // creates the row and every later Save updates it, because the endpoint is keyed on the SLOT.
  const [addingNext, setAddingNext] = React.useState(false);
  const nextStartRef = React.useRef<HTMLInputElement | null>(null);
  const startNewRef = React.useRef<HTMLButtonElement | null>(null);
  const didReveal = React.useRef(false);

  const showNextBlock = Option.isSome(nextSeason) || addingNext;
  const isAddingNew = addingNext && Option.isNone(nextSeason);

  // BOTH the prefill and the `min` are clamped past today AND past the current season's expiry.
  // Unclamped, a season that ended 2027-02-01 and is opened on 2027-03-15 would prefill
  // 2027-03-01 and offer a `min` of 2027-02-02 — both past — and the Save would 400 with
  // `SeasonStartNotInFuture` on the value the UI itself chose. `min`'s job is to make that
  // rejection unreachable, not to let the server catch what the control allowed. TOMORROW and
  // not today, because the server tests `<= now()` and a start anchors to 00:00 local.
  const currentExpiry = Option.flatMap(currentSeason, (s) => s.expiresAt);
  const nextStartDefault = React.useMemo(() => {
    const now = new Date();
    const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return localDateString(
      Option.match(currentExpiry, {
        onNone: () => firstOfNextMonth,
        onSome: (expiry) => {
          const e = toLocalDate(expiry);
          // The 1st of a month, always: a season that starts mid-month resets that whole
          // month's free-training allowance for everyone already invoiced for it.
          const firstAfterExpiry = new Date(e.getFullYear(), e.getMonth() + 1, 1);
          return firstAfterExpiry > firstOfNextMonth ? firstAfterExpiry : firstOfNextMonth;
        },
      }),
    );
  }, [currentExpiry]);
  const nextStartMin = React.useMemo(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return localDateString(
      Option.match(currentExpiry, {
        onNone: () => tomorrow,
        onSome: (expiry) => {
          const dayAfterExpiry = toLocalDate(expiry);
          dayAfterExpiry.setDate(dayAfterExpiry.getDate() + 1);
          return dayAfterExpiry > tomorrow ? dayAfterExpiry : tomorrow;
        },
      }),
    );
  }, [currentExpiry]);

  // In-place reveal needs no focus trap — one more thing a dialog would have cost.
  React.useEffect(() => {
    if (addingNext) {
      didReveal.current = true;
      nextStartRef.current?.focus();
    } else if (didReveal.current) {
      startNewRef.current?.focus();
    }
  }, [addingNext]);

  const [memberSearch, setMemberSearch] = React.useState('');
  const [moveOpen, setMoveOpen] = React.useState(false);
  const [savingMemberId, setSavingMemberId] = React.useState<string | null>(null);

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

  // Mirrors `handleMakeDefault` above exactly, plus one branch: a plan row shown to this
  // caller can go stale for reasons entirely outside their own click — a captain archives it
  // (404), the deadline passes server-side between page load and this click (409
  // `MembershipSelectionClosed`, the client-side `isSelectionClosed` check is only advisory),
  // or the caller loses membership mid-session (403). ALL of those must repaint the page, not
  // just the one tag we happen to have a nicer message for — `tapError`, not `tapErrorTag`, or
  // an archived row's Choose button stays enabled forever and every later click 404s the same
  // way with only a generic toast to show for it.
  const handleChoose = React.useCallback(
    async (plan: MembershipPlanApi.MembershipPlanInfo) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.membershipPlan.selectMembershipPlan({
            params: { teamId: teamIdBranded },
            payload: { membershipPlanId: plan.membershipPlanId },
          }),
        ),
        Effect.tapError(() => Effect.sync(() => router.invalidate())),
        Effect.mapError((e) =>
          e._tag === 'MembershipSelectionClosed'
            ? ClientError.make(tr('membershipPlan_selectionClosed'))
            : ClientError.make(tr('membershipPlan_chooseFailed')),
        ),
        run({ success: tr('membershipPlan_chosen') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamIdBranded, run, router],
  );

  // THE CURRENT SEASON'S SAVE. Reads `currentForm` — seeded from `currentSeason` — and writes
  // the endpoint that owns the current slot. It carries no `startsAt` at all, which is what makes
  // it structurally incapable of moving a running season's start.
  const handleSaveCurrentSeason = React.useCallback(async () => {
    if (isSeasonOrderInvalid(currentForm)) {
      setCurrentError(tr('membershipPlan_season_orderInvalid'));
      return;
    }
    setCurrentError('');

    setIsSavingCurrent(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.membershipPlan.setMembershipSelectionDeadline({
          params: { teamId: teamIdBranded },
          // ANCHORING: end of the LOCAL day, not noon UTC — both of these are ENFORCED
          // server-side, so anchoring "30 Sep" to noon UTC would close selection ~14:00 local
          // in UTC+2, which reads as a bug. Closing a few hours late from clock skew is
          // harmless; closing early is not.
          //
          // `expiresAt` is always `Some(...)` — the OUTER Option is "did this bundle send the
          // key at all", and this bundle always does; the inner one carries the clear.
          payload: {
            deadline: parseSeasonDate(currentForm.deadline),
            expiresAt: Option.some(parseSeasonDate(currentForm.expiresAt)),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('membershipPlan_season_saveFailed'))),
      run({ success: tr('membershipPlan_season_saved') }),
    );
    setIsSavingCurrent(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, run, router, currentForm]);

  // THE NEXT SLOT'S SAVE — create and update are literally the same request, because the server
  // resolves the slot from `now()` and never from the payload. The toast is the only thing that
  // differs, and only on the one occasion the reassurance answers the manager's live question.
  const handleSaveNextSeason = React.useCallback(async () => {
    if (isSeasonOrderInvalid(nextForm)) {
      setNextError(tr('membershipPlan_season_orderInvalid'));
      return;
    }
    setNextError('');

    const isCreate = Option.isNone(nextSeason);
    setIsSavingNext(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.membershipPlan.upsertNextSeason({
          params: { teamId: teamIdBranded },
          payload: {
            // START of the local day — the harmful direction REVERSES for a start date: a
            // deadline anchored late is generous, but a season anchored late opens after the
            // advertised day and widens the rollover gap.
            startsAt: dateOnlyToLocalStartOfDay(nextForm.startsAt),
            deadline: parseSeasonDate(nextForm.deadline),
            expiresAt: parseSeasonDate(nextForm.expiresAt),
          },
        }),
      ),
      // Includes the `SeasonStartNotInFuture` 400 that fires when the queued season's start
      // passes between page load and Save: the invalidate below repaints, and the manager then
      // sees that season sitting in the Current block, which is the truth.
      Effect.mapError(() => ClientError.make(tr('membershipPlan_season_saveFailed'))),
      run({
        success: isCreate ? tr('membershipPlan_season_created') : tr('membershipPlan_season_saved'),
      }),
    );
    setIsSavingNext(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamIdBranded, run, router, nextForm, nextSeason]);

  // The manager-side sibling of `handleChoose`, minus the deadline branch: the selection
  // deadline binds members, not a treasurer fixing stragglers after the lock (plan §B.2), so
  // the endpoint cannot return `MembershipSelectionClosed` at all.
  const handleAssign = React.useCallback(
    async (memberId: MembershipPlanApi.MembershipPlanAssignment['memberId'], value: string) => {
      setSavingMemberId(memberId);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.membershipPlan.assignMembershipPlan({
            params: { teamId: teamIdBranded, memberId },
            // The sentinel and an id that is no longer in `plans` both collapse to `None` —
            // "no real choice on record", which is exactly what the server stores.
            payload: {
              membershipPlanId: Option.fromNullishOr(
                plans.find((p) => p.membershipPlanId === value)?.membershipPlanId,
              ),
            },
          }),
        ),
        Effect.tapError(() => Effect.sync(() => router.invalidate())),
        Effect.mapError(() => ClientError.make(tr('membershipPlan_assign_failed'))),
        run({ success: tr('membershipPlan_assign_saved') }),
      );
      setSavingMemberId(null);
      if (Option.isSome(result)) {
        // Refetch rather than patch local state: `assignments` also feeds `MoveMembersDialog`'s
        // per-option counts, and a local-only patch makes the number the treasurer confirms a
        // bulk move against stale. Same one query every sibling handler on this page pays.
        router.invalidate();
      }
    },
    [teamIdBranded, plans, run, router],
  );

  const visibleAssignments = React.useMemo(() => {
    const needle = memberSearch.trim().toLowerCase();
    return [...assignments]
      .filter((a) => a.displayName.toLowerCase().includes(needle))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [assignments, memberSearch]);

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
        <p className='text-muted-foreground mt-1'>
          {canManage ? tr('membershipPlan_subtitle') : tr('membershipPlan_subtitleMember')}
        </p>
        {/* The ONE member-facing notice, and the thing every disabled Choose is
            `aria-describedby`-linked to, so a screen reader explains the dead control instead of
            just announcing it. */}
        <p id='membership-selection-status' className='text-sm text-muted-foreground mt-2'>
          {seasonEnded && Option.isSome(seasonExpiresAt)
            ? // Date only, no time: a season ending is a day-level fact, and the member's next
              // action ("you keep your plan until a new season starts") does not turn on an hour.
              tr('membershipPlan_seasonEndedNotice', {
                date: formatLocalDate(seasonExpiresAt.value),
              })
            : Option.match(selectionDeadline, {
                onNone: () => tr('membershipPlan_noDeadlineNotice'),
                // WITH the time, not just the date: the deadline is an INSTANT, enforced
                // server-side at that instant, not at local midnight of the date shown — a
                // date-only notice reads as "closes at midnight" to every viewer outside the
                // captain's own timezone, when it actually closes hours earlier or later.
                onSome: (deadline) =>
                  isSelectionClosed
                    ? tr('membershipPlan_selectionClosedNotice', {
                        date: formatLocalDate(deadline),
                        time: formatLocalTime(deadline),
                      })
                    : tr('membershipPlan_deadlineNotice', {
                        date: formatLocalDate(deadline),
                        time: formatLocalTime(deadline),
                      }),
              })}
        </p>
      </header>

      {/* THE ROLLBACK CONTRACT (state M9). `currentSeason` is `None` only when an OLD server is
          answering a NEW bundle — a server rollback — and in that window the endpoints behind
          these boxes do not exist, so every control offered here is a control that fails.
          Rendering nothing degrades it to exactly today's page. Not an empty state, not blank
          boxes, not a badge-less skeleton. */}
      {canManage && Option.isSome(currentSeason) && (
        <div className='mb-4 flex flex-col gap-3 rounded-lg border p-3'>
          <SeasonBlock
            idPrefix='season'
            heading={tr('membershipPlan_season_currentHeading')}
            badge={
              // The badge describes THIS ROW's own columns, not the member gate — in the
              // rollover state (current ended, next open) it truthfully says "Season ended"
              // while the member's notice, driven by the server-picked pair, says selection is
              // open. Both are correct about different things.
              hasPassed(currentSeason.value.expiresAt) ? (
                <Badge variant='outline'>{tr('membershipPlan_season_badgeEnded')}</Badge>
              ) : hasPassed(currentSeason.value.selectionDeadline) ? (
                <Badge variant='outline'>{tr('membershipPlan_season_badgeClosed')}</Badge>
              ) : (
                <Badge variant='secondary'>{tr('membershipPlan_season_badgeOpen')}</Badge>
              )
            }
            form={currentForm}
            onChange={(patch) => setCurrentForm((f) => ({ ...f, ...patch }))}
            startEditable={false}
            hint={tr('membershipPlan_season_hint')}
            error={currentError}
            isSaving={isSavingCurrent}
            onSave={handleSaveCurrentSeason}
          />

          {showNextBlock && (
            <>
              <hr className='border-t' />
              <SeasonBlock
                idPrefix='next-season'
                heading={tr('membershipPlan_season_nextHeading')}
                form={nextForm}
                onChange={(patch) => setNextForm((f) => ({ ...f, ...patch }))}
                startEditable={true}
                startMin={nextStartMin}
                startRef={nextStartRef}
                hint={tr('membershipPlan_season_nextHint')}
                error={nextError}
                isSaving={isSavingNext}
                // `startsAt` is the one required column on the next slot; an empty box has
                // nothing to send and no error string worth inventing.
                saveDisabled={nextForm.startsAt.trim() === ''}
                savePrimary={isAddingNew}
                onSave={handleSaveNextSeason}
                onCancel={
                  isAddingNew
                    ? () => {
                        setAddingNext(false);
                        setNextForm(seedSeasonForm(nextSeason));
                        setNextError('');
                      }
                    : undefined
                }
              />
            </>
          )}

          {/* The trigger disappears when the slot is full: a manager can never be looking at a
              queued season and a "create another" button at the same time. */}
          {!showNextBlock && (
            <>
              <hr className='border-t' />
              <div>
                <Button
                  type='button'
                  ref={startNewRef}
                  // The one state where starting a season is the thing the manager came to do.
                  variant={hasPassed(currentSeason.value.expiresAt) ? 'default' : 'outline'}
                  size='sm'
                  onClick={() => {
                    // Seeded from NOTHING on the current season — a Save here can never clone
                    // the running season's dates onto a new row.
                    setNextForm({ startsAt: nextStartDefault, deadline: '', expiresAt: '' });
                    setNextError('');
                    setAddingNext(true);
                  }}
                >
                  {tr('membershipPlan_season_startNew')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {canManage && (
        <div className='mb-4 flex justify-end'>
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
            // Only shown when there is one — an extra "0 free" on every plan is noise.
            const freeTrainingsLabel =
              plan.freeTrainingsIncluded > 0
                ? ` · ${tr('membershipPlan_freeTrainingsSummary', {
                    count: String(plan.freeTrainingsIncluded),
                  })}`
                : '';
            const isEffectivePlan = plan.membershipPlanId === effectivePlanId;

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
                    {isEffectivePlan && (
                      <Badge variant='secondary'>{tr('membershipPlan_yourPlanBadge')}</Badge>
                    )}
                  </div>
                  <div className='text-xs text-muted-foreground'>
                    {priceLabel} · {perTrainingLabel}
                    {freeTrainingsLabel}
                  </div>
                </div>
                <div className='ml-auto flex flex-wrap items-center gap-1'>
                  {/* Every member picks their own plan, captains included — a captain is also
                      a paying member. */}
                  {!isEffectivePlan && (
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      disabled={isSelectionClosed}
                      aria-describedby='membership-selection-status'
                      aria-label={tr('membershipPlan_chooseAria', { name })}
                      onClick={() => handleChoose(plan)}
                    >
                      {tr('membershipPlan_choose')}
                    </Button>
                  )}
                  {canManage && (
                    <>
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
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Member assignments — gated on `canManage` ALONE, never on `assignments.length > 0`:
          the empty state is what makes a server rollback or a repo regression look broken
          instead of silently absent. `assignments` is `[]` for non-managers by construction. */}
      {canManage && (
        <section className='mt-10'>
          <div className='flex flex-wrap items-center justify-between gap-3 mb-2'>
            <h2 className='text-lg font-semibold'>{tr('membershipPlan_assign_sectionTitle')}</h2>
            <Button type='button' variant='outline' onClick={() => setMoveOpen(true)}>
              {tr('membershipPlan_bulk_button')}
            </Button>
          </div>
          <p className='text-sm text-muted-foreground mb-3'>{tr('membershipPlan_assign_hint')}</p>
          <Input
            className='mb-3'
            value={memberSearch}
            placeholder={tr('membershipPlan_assign_searchPlaceholder')}
            onChange={(e) => setMemberSearch(e.target.value)}
          />

          {assignments.length === 0 ? (
            <p className='text-sm text-muted-foreground'>{tr('membershipPlan_assign_empty')}</p>
          ) : (
            // ponytail: renders one Radix Select per active member, unbounded. Add a "type to
            // search before we render rows" gate above ~200 members if a big club complains.
            <div className='flex flex-col gap-2'>
              {visibleAssignments.map((a) => {
                // An archived plan is not in `plans`, so the stored id would select nothing and
                // the control would render blank. Falling back to the sentinel is also how the
                // member is actually BILLED — `training_period_charges` drops an archived plan
                // back to the team default. "No real choice on record" renders as the default.
                const stored = Option.getOrUndefined(a.membershipPlanId);
                const isOrphan =
                  stored !== undefined && !plans.some((p) => p.membershipPlanId === stored);
                const active = isOrphan || stored === undefined ? DEFAULT_SENTINEL : stored;
                return (
                  <div
                    key={a.memberId}
                    className='flex flex-wrap items-center gap-3 rounded-lg border p-3'
                  >
                    <span className='min-w-0 flex-1 basis-40 truncate'>
                      {a.displayName}
                      {/* The select reads "use team default" for them — that IS how they are
                          billed — but the bulk dialog buckets them under their real orphan id,
                          not under "no plan chosen". Without this marker the two surfaces of
                          this screen silently disagree about the same member. */}
                      {isOrphan && (
                        <span className='ml-2 text-xs text-muted-foreground'>
                          {tr('membershipPlan_bulk_archivedSource')}
                        </span>
                      )}
                    </span>
                    {/* NOT disabled by `isSelectionClosed` — the deadline binds members, not a
                        manager fixing stragglers after the lock (plan §B.2). */}
                    <Select
                      value={active}
                      disabled={savingMemberId === a.memberId}
                      onValueChange={(v) => handleAssign(a.memberId, v)}
                    >
                      <SelectTrigger
                        className='w-56'
                        aria-label={tr('membershipPlan_assign_selectAria', {
                          name: a.displayName,
                        })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_SENTINEL}>
                          {tr('membershipPlan_assign_useDefault')}
                        </SelectItem>
                        {plans.map((plan) => (
                          <SelectItem key={plan.membershipPlanId} value={plan.membershipPlanId}>
                            {planDisplayName(plan)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          )}

          <MoveMembersDialog
            teamId={teamIdBranded}
            plans={plans}
            assignments={assignments}
            open={moveOpen}
            onOpenChange={setMoveOpen}
            onMoved={handleSaved}
          />
        </section>
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
