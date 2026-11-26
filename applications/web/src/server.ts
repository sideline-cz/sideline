import { paraglideMiddleware } from '@sideline/i18n/server';
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';

// Without this the SSR pass has no request-scoped locale, so `getLocale()` falls through to the
// base locale ('en') while the client resolves the user's locale (localStorage/cookie) — every
// translated string in the SSR shell then mismatches on hydration (React #418). The middleware
// resolves the locale from the PARAGLIDE_LOCALE cookie (which `setLocale` writes alongside
// localStorage) or Accept-Language, the same sources the client uses.
export default createServerEntry({
  fetch: (request) => paraglideMiddleware(request, ({ request }) => handler.fetch(request)),
});
