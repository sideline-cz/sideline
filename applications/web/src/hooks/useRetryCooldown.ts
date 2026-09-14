import React from 'react';

/**
 * Counts down from `seconds` to `0` on a 1s interval, resetting whenever `seconds` changes (a
 * fresh 429 carries its own `retryAfterSeconds`). Clears its interval on unmount and once it
 * reaches `0`. The only timer in the assistant slice (design §2.7) — drives the disabled state
 * and countdown label of the rate-limited turn's retry button.
 */
export function useRetryCooldown(seconds: number): number {
  const [remaining, setRemaining] = React.useState(seconds);

  React.useEffect(() => {
    setRemaining(seconds);
    if (seconds <= 0) return;

    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [seconds]);

  return remaining;
}
