import React from 'react';
import { Calendar } from '~/components/ui/calendar';

export interface MondayPickerProps {
  teamTz: string;
  existingWeekStarts: string[];
  value: Date | undefined;
  onChange: (d: Date) => void;
  disabled?: boolean;
}

/**
 * Returns the current Monday in the given timezone as UTC-midnight Date.
 * Uses Intl.DateTimeFormat to get the local date components.
 */
function getCurrentMondayInTz(tz: string): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? 0);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1) - 1;
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? 1);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';

  // weekday abbreviations: Sun=0, Mon=1, Tue=2, ..., Sat=6
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dow = weekdayMap[weekday] ?? 1;
  // Days since Monday (Mon=0 in our offset)
  const offset = dow === 0 ? 6 : dow - 1;

  const mondayDay = day - offset;
  return new Date(Date.UTC(year, month, mondayDay));
}

function addWeeks(date: Date, weeks: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + weeks * 7);
  return result;
}

function isBefore(a: Date, b: Date): boolean {
  return a.getTime() < b.getTime();
}

function isAfter(a: Date, b: Date): boolean {
  return a.getTime() > b.getTime();
}

/**
 * MondayPicker — wraps shadcn Calendar, only allows selecting Mondays
 * within the current week through +8 weeks window that aren't already taken.
 */
export function MondayPicker({
  teamTz,
  existingWeekStarts,
  value,
  onChange,
  disabled = false,
}: MondayPickerProps) {
  const currentMonday = React.useMemo(() => getCurrentMondayInTz(teamTz), [teamTz]);
  const maxMonday = React.useMemo(() => addWeeks(currentMonday, 8), [currentMonday]);

  const isDisabled = React.useCallback(
    (d: Date) => {
      // Use team timezone to determine the weekday — avoids browser-local TZ bugs
      // (e.g. a captain in LA viewing a Prague team where Mon midnight UTC = Sun evening LA)
      const tzFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: teamTz,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const tzParts = tzFormatter.formatToParts(d);
      const weekday = tzParts.find((p) => p.type === 'weekday')?.value ?? '';
      if (weekday !== 'Mon') return true;

      // Build YYYY-MM-DD in team timezone for range/existing-week comparison
      const year = tzParts.find((p) => p.type === 'year')?.value ?? '';
      const month = tzParts.find((p) => p.type === 'month')?.value ?? '';
      const day = tzParts.find((p) => p.type === 'day')?.value ?? '';
      const formatted = `${year}-${month}-${day}`;

      // Convert team-TZ Monday to a UTC-midnight Date for range comparison
      const [y, m, dd] = formatted.split('-').map(Number) as [number, number, number];
      const utcDate = new Date(Date.UTC(y, m - 1, dd));
      if (isBefore(utcDate, currentMonday)) return true;
      if (isAfter(utcDate, maxMonday)) return true;
      if (existingWeekStarts.includes(formatted)) return true;
      return false;
    },
    [teamTz, currentMonday, maxMonday, existingWeekStarts],
  );

  return (
    <Calendar
      mode='single'
      selected={value}
      onSelect={(d) => {
        if (d && !disabled) onChange(d);
      }}
      disabled={disabled ? true : isDisabled}
      initialFocus
    />
  );
}
