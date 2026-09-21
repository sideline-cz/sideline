import { Effect, Option } from 'effect';
import React from 'react';
import { getToken } from '~/lib/token.js';
import { useServerUrl } from '~/lib/translation-overrides-context.js';

export type UseQrObjectUrlState = 'loading' | 'ready' | 'error';

export interface UseQrObjectUrlResult {
  readonly url: string | null;
  readonly state: UseQrObjectUrlState;
}

/**
 * Authenticated fetch -> blob -> `URL.createObjectURL` for the per-assignment QR PNG.
 *
 * **Must never be a plain `<img src="…/qr.png">`.** The app's API token lives in
 * `BrowserKeyValueStore.layerLocalStorage` (`~/lib/token.js`), not a cookie, so a
 * browser-issued image request carries no `Authorization` header and would 401 for every
 * player.
 *
 * The effect's shape is load-bearing (design §9.2.1) — three failure modes a naive version
 * gets wrong:
 *
 * 1. StrictMode's double-invoke: cleanup can run before the first `fetch` resolves, so the
 *    `cancelled` flag (captured per effect run, not a ref) is what stops a since-cancelled
 *    run from setting state or leaking its object URL.
 * 2. Out-of-order responses: expanding row A then row B, with A resolving after B, must
 *    never render A's QR under B's heading — a correct amount and account with ANOTHER
 *    member's variable symbol, which then auto-matches to the wrong person. The `cancelled`
 *    check before `setUrl`/`setState` closes this.
 * 3. A revoke racing the render: `objectUrl` is a local `let`, never `url` state, so cleanup
 *    revokes exactly the URL this run created — never the one currently painted.
 *
 * Deps are the three identifiers only — never `url`.
 */
export function useQrObjectUrl(
  teamId: string,
  feeId: string,
  assignmentId: string,
): UseQrObjectUrlResult {
  const serverUrl = useServerUrl();
  const [url, setUrl] = React.useState<string | null>(null);
  const [state, setState] = React.useState<UseQrObjectUrlState>('loading');

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the three ids only, never `url` or `serverUrl` (design §9.2.1)
  React.useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;

    setState('loading');
    setUrl(null);

    void (async () => {
      try {
        const tokenOpt = await Effect.runPromise(getToken);
        const headers: Record<string, string> = {};
        if (Option.isSome(tokenOpt)) {
          headers.Authorization = `Bearer ${tokenOpt.value}`;
        }
        const base = serverUrl.replace(/\/$/, '');
        const requestUrl = `${base}/teams/${teamId}/fees/${feeId}/assignments/${assignmentId}/qr.png`;
        const response = await fetch(requestUrl, { headers });
        if (!response.ok) throw new Error(String(response.status));
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setUrl(objectUrl);
        setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [teamId, feeId, assignmentId]);

  return { url, state };
}
