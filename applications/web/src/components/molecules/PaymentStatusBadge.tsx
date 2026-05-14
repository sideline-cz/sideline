import type { FeeAssignment } from '@sideline/domain';
import { AlertTriangle, CheckCircle2, CircleDollarSign, Clock, Slash } from 'lucide-react';
import type React from 'react';
import { tr } from '~/lib/translations.js';

interface PaymentStatusBadgeProps {
  status: FeeAssignment.FeeAssignmentStatus;
  locale?: 'en' | 'cs';
}

type StatusIconComponent = React.ComponentType<{ className?: string }>;

const statusConfig: Record<
  FeeAssignment.FeeAssignmentStatus,
  { className: string; Icon: StatusIconComponent }
> = {
  pending: {
    className:
      'border border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    Icon: Clock,
  },
  partial: {
    className:
      'border border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
    Icon: CircleDollarSign,
  },
  paid: {
    className: 'bg-green-600 text-white',
    Icon: CheckCircle2,
  },
  overdue: {
    className: 'bg-red-600 text-white',
    Icon: AlertTriangle,
  },
  waived: {
    className: 'bg-muted text-muted-foreground',
    Icon: Slash,
  },
};

export function PaymentStatusBadge({ status }: PaymentStatusBadgeProps) {
  const { className, Icon } = statusConfig[status];

  return (
    <span
      data-status={status}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      <Icon className='size-3' />
      {tr(`finance_status_${status}`)}
    </span>
  );
}
