import { useFormatDate } from '~/hooks/useFormatDate.js';

interface DateRangeLabelProps {
  startDate: string;
  endDate: string;
  className?: string;
}

/**
 * Formats a date range (ISO strings or YYYY-MM-DD) as "10.3. – 16.3."
 * (locale-aware day + month, no year).
 */
export function DateRangeLabel({ startDate, endDate, className }: DateRangeLabelProps) {
  const { formatDayMonth } = useFormatDate();

  const start = new Date(startDate);
  const end = new Date(endDate);

  return (
    <span className={className}>
      {formatDayMonth(start)} – {formatDayMonth(end)}
    </span>
  );
}
