import { tr } from '~/lib/translations.js';

/**
 * Terms and privacy, linked wherever the product has a footer — the
 * signed-out landing page and the signed-in sidebar.
 *
 * Kept in one place so the two surfaces cannot drift, and so the routes are
 * stated once. Those routes are plain `<a>` rather than router `<Link>`
 * because the docs are a **separate container**, proxied at `/docs/` by
 * `applications/proxy/nginx.conf` — TanStack Router knows nothing about them
 * and would 404 on a client-side navigation.
 *
 * The trailing slash is required, not cosmetic: the docs site builds with
 * `trailingSlash: 'always'`.
 */
export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-x-3 ${className}`}>
      <a className='underline-offset-4 hover:underline' href='/docs/legal/terms/'>
        {tr('legal_termsOfService')}
      </a>
      <a className='underline-offset-4 hover:underline' href='/docs/legal/privacy/'>
        {tr('legal_privacyPolicy')}
      </a>
    </span>
  );
}
