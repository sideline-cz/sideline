import { useFormatDate } from '~/hooks/useFormatDate.js';

interface WeekRangeLabelProps {
  weekStartDate: string;
  className?: string;
}

/**
 * Formats a week start date (ISO string or YYYY-MM-DD) as "10.3. – 16.3."
 * (locale-aware day + month, no year).
 */
export function WeekRangeLabel({ weekStartDate, className }: WeekRangeLabelProps) {
  const { formatDayMonth } = useFormatDate();

  const start = new Date(weekStartDate);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  return (
    <span className={className}>
      {formatDayMonth(start)} – {formatDayMonth(end)}
    </span>
  );
}
