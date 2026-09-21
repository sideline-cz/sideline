import type { BankTransaction } from '@sideline/domain';
import { Badge } from '~/components/ui/badge';
import {
  matchReasonDashed,
  matchReasonIcons,
  matchReasonLabels,
} from '~/lib/finance/matchReasons.js';
import { cn } from '~/lib/utils';

interface MatchReasonBadgeProps {
  readonly reason: BankTransaction.BankTransactionMatchReason;
  readonly className?: string;
}

/**
 * "Proč nesedí" — the loudest element on the queue row (design §3.5). Four redundant channels so
 * the reason survives greyscale, forced-colors mode and a screen reader: a distinct glyph, the
 * full text label (never truncated to the icon), a solid-vs-dashed border, and `data-reason` for
 * tests/CSS. Colour is a fifth, purely redundant channel.
 */
export function MatchReasonBadge({ reason, className }: MatchReasonBadgeProps) {
  const Icon = matchReasonIcons[reason];
  const dashed = matchReasonDashed[reason];
  const label = matchReasonLabels[reason]();

  return (
    <Badge
      variant='outline'
      data-reason={reason}
      className={cn('gap-1', dashed && 'border-dashed', className)}
    >
      <Icon className='size-3' aria-hidden='true' />
      <span>{label}</span>
    </Badge>
  );
}
