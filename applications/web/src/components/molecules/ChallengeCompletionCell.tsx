import { Check, X } from 'lucide-react';
import React from 'react';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

export interface ChallengeCompletionCellProps {
  memberId: string;
  challengeId: string;
  teamId: string;
  isCompleted: boolean;
  /** True if this is the current user's row AND the challenge is for the active (current) week */
  isOwnRowActive: boolean;
  /** Past week that was not completed */
  isPastMissed: boolean;
  /** Future week or no challenge week */
  isFuture: boolean;
  onMarkComplete?: () => Promise<void>;
  onUnmarkComplete?: () => Promise<void>;
  onError?: (message: string) => void;
}

/**
 * ChallengeCompletionCell — shows ✓/✗/— for a member × week intersection.
 *
 * For the current user's own row on an active week, renders a Toggle button
 * with optimistic UI, 400ms debounce, and stale-response protection.
 *
 * Debounce strategy per plan §5.3:
 *  - `inFlightRequestIdRef` — monotonically incremented on each click
 *  - `optimisticStateRef`   — the state the user most recently intended
 *  - `timerRef`             — setTimeout handle
 *  Each click: cancel pending timer, bump request id, set optimistic state,
 *  schedule new timer 400ms out. On resolution, check if request id is still
 *  the latest; only the latest response may roll back state.
 *
 * Known limitation (S9): consecutive toggles within the debounce window
 * are coalesced, but if an in-flight request is already executing when a new
 * click arrives the two requests can still race on the server side. The
 * debounce prevents the common double-click case; true in-flight abort would
 * require AbortController integration. For v1 this is acceptable — the
 * router.invalidate() call after mark/unmark re-syncs server truth and
 * corrects any transient desync without user-visible data loss.
 */
export function ChallengeCompletionCell({
  isCompleted,
  isOwnRowActive,
  isPastMissed,
  isFuture: _isFuture,
  onMarkComplete,
  onUnmarkComplete,
  onError,
}: ChallengeCompletionCellProps) {
  // Optimistic display state — toggled immediately on click
  const [displayCompleted, setDisplayCompleted] = React.useState(isCompleted);

  // Track the most recent request id (monotonic counter)
  const inFlightRequestIdRef = React.useRef(0);
  // Track the optimistic intended state (last click's intention)
  const optimisticStateRef = React.useRef(isCompleted);
  // Track the last server-confirmed state (the `isCompleted` prop value)
  // This is what we revert to on error.
  const serverStateRef = React.useRef(isCompleted);
  // Track the debounce timer
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external prop changes (e.g. after router.invalidate)
  React.useEffect(() => {
    setDisplayCompleted(isCompleted);
    optimisticStateRef.current = isCompleted;
    serverStateRef.current = isCompleted;
  }, [isCompleted]);

  const handleToggle = React.useCallback(() => {
    if (!onMarkComplete || !onUnmarkComplete) return;

    // Cancel any pending debounce timer
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    // Bump request id
    inFlightRequestIdRef.current += 1;
    const requestId = inFlightRequestIdRef.current;

    // Toggle optimistic state
    const nextState = !optimisticStateRef.current;
    optimisticStateRef.current = nextState;
    setDisplayCompleted(nextState);

    // Schedule server call after 400ms debounce
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const capturedRequestId = requestId;
      const capturedNextState = nextState;

      const apiCall = capturedNextState ? onMarkComplete() : onUnmarkComplete();

      apiCall.then(
        () => {
          // Success — only care if this is still the latest request
          if (inFlightRequestIdRef.current !== capturedRequestId) {
            // Stale response: ignore
            return;
          }
          // Update the server-confirmed state
          serverStateRef.current = capturedNextState;
        },
        (_err) => {
          // Error — only roll back if this is still the latest request
          if (inFlightRequestIdRef.current !== capturedRequestId) {
            // Stale response: ignore
            return;
          }
          // Revert to last known server state (not just the pre-click state,
          // but the original `isCompleted` prop — the last server-confirmed truth).
          const revertedState = serverStateRef.current;
          optimisticStateRef.current = revertedState;
          setDisplayCompleted(revertedState);
          onError?.(tr('challenges_error_notActive'));
        },
      );
    }, 400);
  }, [onMarkComplete, onUnmarkComplete, onError]);

  // Cleanup timer on unmount
  React.useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Own active row: render toggle button
  if (isOwnRowActive) {
    return (
      <button
        type='button'
        data-completed={displayCompleted}
        onClick={handleToggle}
        className={cn(
          'flex items-center justify-center w-full h-full min-h-8 px-2 py-1 rounded text-sm font-medium transition-colors',
          displayCompleted
            ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300'
            : 'bg-muted text-muted-foreground hover:bg-muted/80',
        )}
        aria-label={
          displayCompleted ? tr('challenges_grid_unmarkCta') : tr('challenges_grid_markCta')
        }
        aria-pressed={displayCompleted}
      >
        {displayCompleted ? tr('challenges_grid_unmarkCta') : tr('challenges_grid_markCta')}
      </button>
    );
  }

  // Completed (other member's row or non-interactive)
  if (displayCompleted) {
    return (
      <span
        role='img'
        className='flex items-center justify-center w-full h-full text-emerald-600'
        aria-label={tr('challenges_grid_completedAlt')}
      >
        <Check className='size-4' aria-hidden='true' />
      </span>
    );
  }

  // Past missed
  if (isPastMissed) {
    return (
      <span
        role='img'
        className='flex items-center justify-center w-full h-full text-muted-foreground'
        aria-label={tr('challenges_grid_missedAlt')}
      >
        <X className='size-4' aria-hidden='true' />
      </span>
    );
  }

  // Future or no challenge
  return (
    <span
      role='img'
      className='flex items-center justify-center w-full h-full text-muted-foreground/50'
      aria-label={tr('challenges_grid_futureAlt')}
    >
      —
    </span>
  );
}
