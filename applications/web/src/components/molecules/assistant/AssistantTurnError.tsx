/**
 * A failed turn, rendered inline in place of the assistant answer (design §2.7) — never only a
 * toast, so the transcript is the single place the failure is reported. `forbidden` never gets a
 * retry button: retrying an authorization failure cannot succeed, so offering the button would be
 * a dead click.
 */
import { OctagonX, RotateCcw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert.js';
import { Button } from '~/components/ui/button.js';
import { useRetryCooldown } from '~/hooks/useRetryCooldown.js';
import { tr } from '~/lib/translations.js';

export type AssistantTurnErrorReason = 'rateLimited' | 'forbidden' | 'generic';

interface AssistantTurnErrorProps {
  reason: AssistantTurnErrorReason;
  retryAfterSeconds?: number;
  /** True while another turn is already in flight — retrying now would race it. */
  disabled?: boolean;
  onRetry: () => void;
}

/** Also the `SilentClientError` message `AssistantConversation` raises for the same reason. */
export const turnErrorMessages: Record<AssistantTurnErrorReason, () => string> = {
  rateLimited: () => tr('assistant_turnFailedRateLimited'),
  forbidden: () => tr('assistant_turnFailedForbidden'),
  generic: () => tr('assistant_turnFailedGeneric'),
};

export function AssistantTurnError({
  reason,
  retryAfterSeconds,
  disabled = false,
  onRetry,
}: AssistantTurnErrorProps) {
  const secondsLeft = useRetryCooldown(reason === 'rateLimited' ? (retryAfterSeconds ?? 0) : 0);
  const cooldownActive = reason === 'rateLimited' && secondsLeft > 0;
  const retryDisabled = cooldownActive || disabled;

  return (
    <Alert variant='destructive'>
      <OctagonX className='size-4' aria-hidden='true' />
      <AlertTitle>{tr('assistant_turnFailedTitle')}</AlertTitle>
      <AlertDescription>
        <p>{turnErrorMessages[reason]()}</p>
        {reason !== 'forbidden' && (
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='w-full sm:w-auto'
            onClick={onRetry}
            disabled={retryDisabled}
          >
            <RotateCcw className='size-4' aria-hidden='true' />
            {cooldownActive
              ? tr('assistant_turnFailedRetryIn', { seconds: secondsLeft })
              : tr('common_retry')}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
