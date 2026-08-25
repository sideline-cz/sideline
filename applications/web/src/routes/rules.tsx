import { getLocale } from '@sideline/i18n/runtime';
import { createFileRoute, redirect } from '@tanstack/react-router';

// Bare `/rules` has no content of its own — it redirects to the negotiated
// locale. `getLocale()` reuses Paraglide's own strategy chain (localStorage →
// cookie → browser `navigator.languages` → English fallback), the same
// negotiation already used everywhere else unauthenticated locale detection
// happens in this app.
export const Route = createFileRoute('/rules')({
  ssr: false,
  component: () => null,
  beforeLoad: () => {
    const locale = getLocale();
    throw redirect({ to: locale === 'cs' ? '/cs/rules' : '/en/rules' });
  },
});
