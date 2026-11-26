// React #418 on every full load (stable QA, Czech UI): the SSR shell rendered translated text in
// the base locale ('en') because nothing told Paraglide the request's locale on the server, while
// the client resolved 'cs' from localStorage. `src/server.ts` now runs every request through
// `paraglideMiddleware`; these tests pin that the server's locale comes from the request and that
// the SSR markup then hydrates against a Czech client without a mismatch.

import { paraglideMiddleware } from '@sideline/i18n/server';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutePendingComponent } from '~/components/layouts/RoutePendingComponent';

const ssr = (headers: Record<string, string>): Promise<string> =>
  paraglideMiddleware(
    new Request('http://localhost/profile', { headers }),
    async () => new Response(renderToString(<RoutePendingComponent />)),
  ).then((res) => res.text());

const hydrateAsCzechClient = async (html: string) => {
  localStorage.setItem('PARAGLIDE_LOCALE', 'cs');
  const container = document.createElement('div');
  container.innerHTML = html;
  document.body.appendChild(container);
  const onRecoverableError = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => {
    hydrateRoot(container, <RoutePendingComponent />, { onRecoverableError });
  });
  return onRecoverableError;
};

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('SSR locale resolution', () => {
  it('renders Czech for a PARAGLIDE_LOCALE=cs cookie', async () => {
    expect(await ssr({ cookie: 'PARAGLIDE_LOCALE=cs' })).toContain('Načítání');
  });

  it('renders Czech for a Czech Accept-Language with no cookie', async () => {
    expect(await ssr({ 'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8' })).toContain('Načítání');
  });

  it('falls back to English with neither', async () => {
    expect(await ssr({})).toContain('Loading');
  });
});

describe('SSR and client render the same text', () => {
  it('a cs request hydrates on a cs client without a mismatch', async () => {
    const onRecoverableError = await hydrateAsCzechClient(
      await ssr({ cookie: 'PARAGLIDE_LOCALE=cs' }),
    );
    expect(onRecoverableError).not.toHaveBeenCalled();
  });

  // Control: proves the check above can fail — this is the pre-fix situation (server had no
  // locale for the request, so it used the base locale).
  it('an en SSR hydrated on a cs client does mismatch', async () => {
    const onRecoverableError = await hydrateAsCzechClient(await ssr({}));
    expect(onRecoverableError).toHaveBeenCalled();
  });
});
