import type { Event } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { Settings } from 'lucide-react';
import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { eventTypeLabels } from '~/lib/event-labels.js';
import { tr } from '~/lib/translations.js';
import {
  LOCK_OVERRIDE_OFF,
  lockOverrideField,
  OVERRIDE_EVENT_TYPES,
  type SettingsFormValues,
} from './settingsForm';
import type { CardForm } from './useCardForm';

interface GeneralLimitsCardProps {
  form: CardForm<SettingsFormValues>;
}

// Built once per locale: this is called up to seven times per render of the card.
const dayFormatters = new Map<string, Intl.NumberFormat>();
const dayFormatter = (locale: string): Intl.NumberFormat => {
  const cached = dayFormatters.get(locale);
  if (cached !== undefined) return cached;
  const made = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'day',
    unitDisplay: 'long',
  });
  dayFormatters.set(locale, made);
  return made;
};

/**
 * The stored unit is hours and there is deliberately no per-row unit selector — one would make a
 * stored `5` ambiguous forever. So "5 days before" has to be typed as `120`, and this echoes it
 * back in days for anything at or above a full day. `Intl` does the pluralising, so this costs no
 * translation key.
 */
export const daysEcho = (raw: string): string | undefined => {
  const hours = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(hours) || hours < 24) return undefined;
  return `= ${dayFormatter(getLocale()).format(hours / 24)}`;
};

/**
 * One override row: a tri-state selector plus, in `hours` mode only, the number box.
 *
 * The three states live in ONE flat string field (`''` / digits / `off`) because `useCardForm`
 * compares `Record<string, Primitive>` with `!==` — a nested `{ mode, hours }` object would be a
 * fresh reference every render and read as permanently dirty. So the mode is derived from the
 * value rather than stored next to it, and the single piece of local state below exists only to
 * keep an emptied number box in `hours` mode: without it, clearing the field to retype it would
 * read as `''` = inherit and yank the box out from under the cursor.
 */
function LockOverrideRow({
  eventType,
  value,
  inherited,
  onChange,
}: {
  eventType: Event.EventType;
  value: string;
  /** The team-wide value this row falls back to, shown as the placeholder. */
  inherited: string;
  onChange: (next: string) => void;
}) {
  const [stickyHours, setStickyHours] = useState(false);
  const raw = value.trim();
  const mode =
    raw.toLowerCase() === LOCK_OVERRIDE_OFF
      ? 'off'
      : raw !== '' || stickyHours
        ? 'hours'
        : 'inherit';
  const typeLabel = eventTypeLabels[eventType]();
  const echo = daysEcho(value);

  return (
    <div>
      <label
        htmlFor={`lock-mode-${eventType}`}
        className='text-xs text-muted-foreground mb-1 block'
      >
        {typeLabel}
      </label>
      <div className='flex items-center gap-2'>
        <select
          id={`lock-mode-${eventType}`}
          value={mode}
          onChange={(e) => {
            setStickyHours(e.target.value === 'hours');
            onChange(
              e.target.value === 'off'
                ? LOCK_OVERRIDE_OFF
                : e.target.value === 'hours'
                  ? inherited
                  : '',
            );
          }}
          aria-describedby='rsvp-lock-overrides-help'
          className='h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm shadow-xs transition-colors'
        >
          <option value='inherit'>{tr('teamSettings_lockOverride_inherit')}</option>
          <option value='hours'>{tr('teamSettings_lockOverride_hours')}</option>
          <option value='off'>{tr('teamSettings_lockOverride_off')}</option>
        </select>
        {mode === 'hours' && (
          <Input
            id={`lock-hours-${eventType}`}
            type='number'
            min={0}
            max={336}
            value={value}
            placeholder={inherited}
            aria-label={`${typeLabel} — ${tr('teamSettings_lockOverride_hours')}`}
            // `setStickyHours(true)` here, not only in the `<select>` handler: a row that ARRIVES
            // from the server in hours mode has `stickyHours === false`, so without this, clearing
            // the box to retype reads as `''` = inherit and unmounts the input mid-keystroke — the
            // exact failure the docblock above claims is prevented.
            onChange={(e) => {
              setStickyHours(true);
              onChange(e.target.value);
            }}
            className='w-20'
          />
        )}
      </div>
      {echo !== undefined && <p className='mt-1 text-xs text-muted-foreground'>{echo}</p>}
    </div>
  );
}

export function GeneralLimitsCard({ form: { values, setField } }: GeneralLimitsCardProps) {
  const teamWideEcho = daysEcho(values.rsvpLockHoursBefore);

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <Settings className='size-4 text-muted-foreground' />
          <CardTitle className='text-base'>{tr('teamSettings_generalTitle')}</CardTitle>
        </div>
        <CardDescription>{tr('teamSettings_generalDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          <div>
            <label htmlFor='horizon-days' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_horizonDays')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_horizonDaysHelp')}
            </p>
            <Input
              id='horizon-days'
              type='number'
              min={1}
              max={365}
              value={values.horizonDays}
              onChange={(e) => setField('horizonDays', e.target.value)}
              className='max-w-32'
            />
          </div>
          <Separator />
          <div>
            <label htmlFor='min-players' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_minPlayersThreshold')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_minPlayersThresholdHelp')}
            </p>
            <Input
              id='min-players'
              type='number'
              min={0}
              max={100}
              value={values.minPlayersThreshold}
              onChange={(e) => setField('minPlayersThreshold', e.target.value)}
              className='max-w-32'
            />
          </div>
          <Separator />
          {/* RSVP lock. Blank here means OFF — no deadline at all — which is the OPPOSITE of the
              blank in the override grid below, where blank means "inherit this value". */}
          <div>
            <label htmlFor='rsvp-lock-hours-before' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_rsvpLockHoursBefore')}
            </label>
            <p id='rsvp-lock-hours-before-help' className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_rsvpLockHoursBefore_help')}
            </p>
            <Input
              id='rsvp-lock-hours-before'
              type='number'
              min={0}
              max={336}
              value={values.rsvpLockHoursBefore}
              onChange={(e) => setField('rsvpLockHoursBefore', e.target.value)}
              aria-describedby='rsvp-lock-hours-before-help'
              className='max-w-32'
            />
            {teamWideEcho !== undefined && (
              <p className='mt-1 text-xs text-muted-foreground'>{teamWideEcho}</p>
            )}
          </div>
          {/* Per-type override. `off` is the documented escape hatch for the all-day skew (a
              24h team-wide lock closes a Saturday tournament on Friday midnight), so it has to
              be selectable, not typed — hence a tri-state selector per row rather than a text
              box whose alphabet only `findInvalidSettingsField` knows. */}
          <div>
            <span className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_rsvpLockHoursBeforeOverrides')}
            </span>
            <p id='rsvp-lock-overrides-help' className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_rsvpLockHoursBeforeOverrides_help')}
            </p>
            <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
              {OVERRIDE_EVENT_TYPES.map((eventType) => {
                const field = lockOverrideField(eventType);
                return (
                  <LockOverrideRow
                    key={eventType}
                    eventType={eventType}
                    value={values[field]}
                    inherited={values.rsvpLockHoursBefore}
                    onChange={(next) => setField(field, next)}
                  />
                );
              })}
            </div>
          </div>
          <Separator />
          <div className='flex items-center gap-2'>
            <input
              id='require-complete-profile'
              type='checkbox'
              checked={values.requireCompleteProfile}
              onChange={(e) => setField('requireCompleteProfile', e.target.checked)}
              className='h-4 w-4'
            />
            <label htmlFor='require-complete-profile' className='text-sm font-medium'>
              {tr('teamSettings_requireCompleteProfile')}
            </label>
          </div>
          <p className='text-xs text-muted-foreground'>
            {tr('teamSettings_requireCompleteProfile_help')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
