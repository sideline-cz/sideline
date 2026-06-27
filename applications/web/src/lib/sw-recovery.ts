import { RESETTING_KEY, requestReload } from './reloadGuard.js';

// Re-export so callers that import from sw-recovery continue to work.
export { RESETTING_KEY };

export async function resetApp(): Promise<void> {
  // Set the resetting flag so SW controllerchange handler skips its reload
  try {
    sessionStorage.setItem(RESETTING_KEY, '1');
  } catch {
    // sessionStorage unavailable — continue anyway
  }

  try {
    if (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      navigator.serviceWorker
    ) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((reg) => reg.unregister()));
    }

    if (navigator.onLine && typeof window !== 'undefined' && 'caches' in window && window.caches) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch {
    // swallow errors — reload in finally regardless
  } finally {
    requestReload('sw-recovery-reset');
  }
}
