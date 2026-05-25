import { getLocale } from '@sideline/i18n/runtime';
import { useMemo } from 'react';

export function useFormatDate() {
  const locale = getLocale();

  return useMemo(() => {
    const dateFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const timeFormatter = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });

    const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const relativeFormatter = new Intl.RelativeTimeFormat(locale, {
      numeric: 'auto',
    });

    const dayMonthFormatter = new Intl.DateTimeFormat(locale, {
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    });

    const formatDate = (date: Date) => dateFormatter.format(date);
    const formatDayMonth = (date: Date) => dayMonthFormatter.format(date);
    const formatTime = (date: Date) => timeFormatter.format(date);
    const formatDateTime = (date: Date) => dateTimeFormatter.format(date);

    const formatRelative = (date: Date) => {
      const now = Date.now();
      const diffMs = date.getTime() - now;
      const diffSec = Math.round(diffMs / 1000);
      const diffMin = Math.round(diffSec / 60);
      const diffHour = Math.round(diffMin / 60);
      const diffDay = Math.round(diffHour / 24);

      if (Math.abs(diffSec) < 60) return relativeFormatter.format(diffSec, 'second');
      if (Math.abs(diffMin) < 60) return relativeFormatter.format(diffMin, 'minute');
      if (Math.abs(diffHour) < 24) return relativeFormatter.format(diffHour, 'hour');
      return relativeFormatter.format(diffDay, 'day');
    };

    return { formatDate, formatDayMonth, formatTime, formatDateTime, formatRelative };
  }, [locale]);
}
