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
  } catch {
    // no-op
  }
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
