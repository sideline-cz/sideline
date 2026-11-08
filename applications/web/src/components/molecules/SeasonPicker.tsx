import type { ActivityLogApi } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { Option } from 'effect';
import { Info } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { tr } from '~/lib/translations.js';

type Seasons = ReadonlyArray<ActivityLogApi.ActivitySeason>;

// Radix Select cannot hold '' — the default option (no `season` param) uses this sentinel.
const DEFAULT_VALUE = '__current__';

// Seasons start at Prague midnight; format there so a UTC browser does not show the month before.
const monthYear = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), {
    month: 'short',
    year: 'numeric',
    timeZone: 'Europe/Prague',
  }).format(new Date(iso));

const fullDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeZone: 'Europe/Prague' }).format(
    new Date(iso),
  );

/** True when the selection is a past season or Earlier (not the default view). */
export const isNonCurrentSelection = (seasons: Seasons, value: string | undefined): boolean =>
  value !== undefined && !seasons.some((s) => s.id === value && s.isCurrent);

/** The range label of the selected period, or `undefined` for the "No active season" view. */
export const seasonRangeLabel = (
  seasons: Seasons,
  value: string | undefined,
): string | undefined => {
  if (value === 'earlier') return tr('activitySeason_optionEarlier');
  const season = isNonCurrentSelection(seasons, value)
    ? seasons.find((s) => s.id === value)
    : seasons.find((s) => s.isCurrent);
  if (season === undefined) return undefined;
  if (season.isCurrent)
    return tr('activitySeason_rangeOpen', { start: monthYear(season.startsAt) });
  return Option.match(season.endsAt, {
    onNone: () => tr('activitySeason_rangeOpen', { start: monthYear(season.startsAt) }),
    onSome: (end) =>
      tr('activitySeason_range', { start: monthYear(season.startsAt), end: monthYear(end) }),
  });
};

interface SeasonPickerProps {
  seasons: Seasons;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  className?: string;
}

export function SeasonPicker({ seasons, value, onChange, className }: SeasonPickerProps) {
  const current = seasons.find((s) => s.isCurrent);
  const past = seasons.filter((s) => !s.isCurrent);
  const selected = isNonCurrentSelection(seasons, value) ? value : DEFAULT_VALUE;

  return (
    <Select value={selected} onValueChange={(v) => onChange(v === DEFAULT_VALUE ? undefined : v)}>
      <SelectTrigger
        size='sm'
        aria-label={tr('activitySeason_pickerLabel')}
        className={className ?? 'w-full sm:w-auto'}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VALUE}>
          {current
            ? tr('activitySeason_optionCurrent', {
                range: tr('activitySeason_rangeOpen', { start: monthYear(current.startsAt) }),
              })
            : tr('activitySeason_optionNoActive')}
        </SelectItem>
        {past.map((s) => (
          <SelectItem key={s.id} value={s.id}>
            {seasonRangeLabel(seasons, s.id)}
          </SelectItem>
        ))}
        <SelectItem value='earlier'>{tr('activitySeason_optionEarlier')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

interface SeasonInfoLineProps {
  seasons: Seasons;
  value: string | undefined;
}

export function SeasonInfoLine({ seasons, value }: SeasonInfoLineProps) {
  let text: string | null = null;
  if (value === 'earlier') {
    text = tr('activitySeason_earlier_hint');
  } else if (!isNonCurrentSelection(seasons, value) && !seasons.some((s) => s.isCurrent)) {
    // seasons[0] = the latest season that started; its end is when the gap began.
    const end = seasons[0]?.endsAt ?? Option.none();
    if (Option.isSome(end)) {
      text = tr('activitySeason_noActive_since', { date: fullDate(end.value) });
    }
  }
  if (text === null) return null;
  return (
    <p className='flex items-center gap-2 text-sm text-muted-foreground'>
      <Info className='size-4 shrink-0' aria-hidden='true' />
      {text}
    </p>
  );
}
