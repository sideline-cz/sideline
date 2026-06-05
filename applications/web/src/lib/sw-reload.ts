/**
 * Decides whether a `controllerchange` event should trigger a one-time reload.
 *
 * A new service worker that calls `clients.claim()` fires `controllerchange` in
 * two distinct situations:
 *  - **First install:** the page was never controlled before, so there is no
 *    stale code to escape — reloading would be a pointless, jarring refresh.
 *  - **Update:** the page was already controlled by a previous SW and a new one
 *    just took over — here we reload once so the freshly activated SW (and the
 *    fresh, non-stale assets it serves) take effect immediately.
 *
 * @param hadController whether `navigator.serviceWorker.controller` was non-null
 *   when registration started (i.e. an earlier SW already controlled the page).
 * @param alreadyReloaded whether a reload has already been triggered in this
 *   document lifetime (loop guard).
 */
export const shouldReloadOnControllerChange = (
  hadController: boolean,
  alreadyReloaded: boolean,
): boolean => hadController && !alreadyReloaded;
