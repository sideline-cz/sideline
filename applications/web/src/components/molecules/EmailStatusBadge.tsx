import type { EmailForwarding } from '@sideline/domain';
import { Badge } from '~/components/ui/badge';
import { tr } from '~/lib/translations.js';

interface EmailStatusBadgeProps {
  status: EmailForwarding.EmailStatus;
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success';

const statusVariantMap: Record<EmailForwarding.EmailStatus, BadgeVariant> = {
  received: 'secondary',
  summarizing: 'secondary',
  pending_approval: 'secondary',
  approved: 'success',
  rejected: 'outline',
  posted_summary: 'success',
  posted_original: 'success',
  failed: 'destructive',
};

const statusLabelMap: Record<EmailForwarding.EmailStatus, string> = {
  received: 'email_detail_status_received',
  summarizing: 'email_detail_status_summarizing',
  pending_approval: 'email_detail_status_pending_approval',
  approved: 'email_detail_status_approved',
  rejected: 'email_detail_status_rejected',
  posted_summary: 'email_detail_status_posted_summary',
  posted_original: 'email_detail_status_posted_original',
  failed: 'email_detail_status_failed',
} as const;

export function EmailStatusBadge({ status }: EmailStatusBadgeProps) {
  return <Badge variant={statusVariantMap[status]}>{tr(statusLabelMap[status])}</Badge>;
}
