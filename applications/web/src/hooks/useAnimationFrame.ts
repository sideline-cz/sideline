import React from 'react';

const MAX_DT_SECONDS = 0.05;

/**
 * Drives a `requestAnimationFrame` loop while `enabled` is true, calling
 * `callback` on every frame with the elapsed time (in seconds) since the
 * previous frame. `dt` is clamped to `MAX_DT_SECONDS`, matching the source
 * trainer's own clamp (`app.js`'s `loop`), so a dropped frame or a tab that
 * was backgrounded never produces a huge single jump in the animation.
 *
 * The loop is cancelled on unmount and whenever `enabled` flips to `false`.
 *
 * `last` starts `null` rather than seeded from a standalone `performance.now()`
 * call: the two are not guaranteed to be the same clock (this genuinely
 * differs between environments — e.g. jsdom's own `requestAnimationFrame`
 * timestamps do not line up with a bare `performance.now()` call), so the
 * only timestamps ever compared here are ones `requestAnimationFrame` itself
 * produced. The first frame after enabling always reports `dt = 0`.
 */
export function useAnimationFrame(callback: (dt: number) => void, enabled: boolean): void {
  const callbackRef = React.useRef(callback);
  callbackRef.current = callback;

  React.useEffect(() => {
    if (!enabled) return;

    let rafId: number;
    let last: number | null = null;

    const tick = (now: number) => {
      const dt = last === null ? 0 : Math.min((now - last) / 1000, MAX_DT_SECONDS);
      last = now;
      callbackRef.current(dt);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [enabled]);
}
