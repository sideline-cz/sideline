interface WeekRangeLabelProps {
  weekStartDate: string;
  className?: string;
}

/**
 * Formats a week start date (ISO string or YYYY-MM-DD) as "10.3. – 16.3."
 */
export function WeekRangeLabel({ weekStartDate, className }: WeekRangeLabelProps) {
  const start = new Date(weekStartDate);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const formatDay = (d: Date) => `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`;

  return (
    <span className={className}>
      {formatDay(start)} – {formatDay(end)}
    </span>
  );
}
