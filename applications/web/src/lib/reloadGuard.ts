export const RELOAD_COUNT_KEY = 'sideline-reload-count';
export const RELOAD_CAP = 2;

// Key used by sw-recovery to signal that a reset is in progress,
// so that the SW controllerchange handler skips its reload.
// Also exported from sw-recovery.ts for backward compatibility.
export const RESETTING_KEY = 'sideline-resetting';

// Separate counter for SW-update-triggered reloads so they don't consume the
// crash cap and trip the recovery UI after a normal SW update + one hiccup.
export const SW_RELOAD_COUNT_KEY = 'sideline-sw-reload-count';
export const SW_RELOAD_CAP = 1;

// One-shot counter for AUTOMATIC reloads triggered by the crash boundary. On a
// post-mount crash the app silently reloads once before showing the manual crash
// screen. This budget is independent of the manual/pre-mount reloads but is also
// bounded by RELOAD_CAP (see requestAutoReloadOnce) so a pre-mount reload plus a
// crash reload can never chain into a loop. Cleared on healthy mount.
export const AUTO_RELOAD_COUNT_KEY = 'sideline-auto-reload-count';
export const AUTO_RELOAD_CAP = 1;

function getSessionStorage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function readCount(key: string): number {
  const ss = getSessionStorage();
  if (!ss) return 0;
  try {
    const val = ss.getItem(key);
    if (val === null) return 0;
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

export function getReloadCount(): number {
  return readCount(RELOAD_COUNT_KEY);
}

export function requestReload(_reason: string): boolean {
  const count = getReloadCount();
  if (count >= RELOAD_CAP) return false;
  const ss = getSessionStorage();
  if (ss) {
    try {
      ss.setItem(RELOAD_COUNT_KEY, String(count + 1));
    } catch {
      // sessionStorage unavailable — treat as count 0, allow reload
    }
  }
  window.location.reload();
  return true;
}

export function clearReloadGuard(): void {
  const ss = getSessionStorage();
  if (!ss) return;
  try {
    ss.removeItem(RELOAD_COUNT_KEY);
    // Reset the one-shot auto-reload budget too, so a later unrelated crash in
    // this (now healthy) session is again allowed its single automatic reload.
    ss.removeItem(AUTO_RELOAD_COUNT_KEY);
  } catch {
    // no-op
  }
}

/**
 * Pure, side-effect-free check: whether the crash boundary may still auto-reload.
 * True only when BOTH the one-shot auto-reload budget and the shared reload cap are
 * unspent. Safe to call from render / getDerivedStateFromError.
 */
export function canAutoReloadOnce(): boolean {
  return readCount(AUTO_RELOAD_COUNT_KEY) < AUTO_RELOAD_CAP && getReloadCount() < RELOAD_CAP;
}

/**
 * Automatically reload the app a single time after a crash, before falling back to
 * the manual crash screen. Increments the one-shot auto counter and delegates to
 * requestReload (which increments the shared counter and reloads). Returns false
 * without reloading once either the auto budget or the shared cap is spent.
 */
export function requestAutoReloadOnce(reason: string): boolean {
  if (!canAutoReloadOnce()) return false;
  const ss = getSessionStorage();
  // Loop-safety: an AUTOMATIC reload must be able to persist that it happened.
  // Without working sessionStorage we can't remember, so we'd auto-reload on every
  // crash forever — refuse and let the manual crash screen show instead.
  if (!ss) return false;
  try {
    ss.setItem(AUTO_RELOAD_COUNT_KEY, String(readCount(AUTO_RELOAD_COUNT_KEY) + 1));
  } catch {
    return false;
  }
  return requestReload(reason);
}

/**
 * Request a reload for a SW-update controllerchange event.
 * Uses a separate counter so SW updates don't consume the crash cap.
 */
export function requestSwReload(): boolean {
  const count = readCount(SW_RELOAD_COUNT_KEY);
  if (count >= SW_RELOAD_CAP) return false;
  const ss = getSessionStorage();
  if (ss) {
    try {
      ss.setItem(SW_RELOAD_COUNT_KEY, String(count + 1));
    } catch {
      // sessionStorage unavailable — allow reload
    }
  }
  window.location.reload();
  return true;
}
