import { expect, test } from '@playwright/test';

/**
 * Google Translate rewrites text nodes into `<font>` wrappers behind React's back.
 * The next reconciliation that removes one — `FormMessage` in `ui/form.tsx` flips
 * between `null` and a `<p>` exactly when validation errors appear on submit —
 * throws `NotFoundError: Failed to execute 'removeChild'`. `AppErrorBoundary` then
 * auto-reloads, discarding whatever the user had typed. That is the "Google Translate
 * ruins form submissions" bug, and it affected every form in the app, not just
 * onboarding.
 *
 * The opt-out is declared in two places that must stay in sync:
 *   - `translate='no'` on <html>                 — `components/layouts/RootDocument.tsx`
 *   - <meta name="google" content="notranslate"> — `routes/__root.tsx` head()
 *
 * Both must be in the document Google sees on first paint, so these assert the served
 * markup and deliberately do not wait for hydration — the opt-out has to be there
 * before React mounts, not after.
 */
test.describe('Google Translate opt-out', () => {
  test('html carries translate="no"', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('translate', 'no');
  });

  test('google notranslate meta tag is present', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('meta[name="google"]')).toHaveAttribute('content', 'notranslate');
  });
});
