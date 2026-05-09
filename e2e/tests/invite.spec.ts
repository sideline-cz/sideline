import { expect, test } from '../fixtures/api-mocks.js';
import { INVITE_CODE, mockLoginUrl } from '../fixtures/mock-data.js';

test.setTimeout(60000);

test.describe('Invite Page', () => {
  test('page loads and shows invite information', async ({ page }) => {
    await page.goto(`/invite/${INVITE_CODE}`);
    await page.waitForFunction(() => !document.body.textContent?.includes('Loading...'), {
      timeout: 30000,
    });
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('shows team name in invite', async ({ page }) => {
    await page.goto(`/invite/${INVITE_CODE}`);
    // The invite page shows "Join Test Team" and "invited to join Test Team"
    await expect(page.getByText('Join Test Team', { exact: true })).toBeVisible({ timeout: 30000 });
  });

  test('Sign in button redirects to the OAuth login URL (no Some(...) wrapping)', async ({
    page,
  }) => {
    // Force the unauthenticated branch
    await page.route('**/auth/me', async (route) => {
      await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
    });
    // Stub the external OAuth target so the browser doesn't actually leave the test
    await page.route('https://discord.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<title>oauth-stub</title>',
      });
    });

    await page.goto(`/invite/${INVITE_CODE}`);
    const signInButton = page.getByRole('button', { name: /sign in/i });
    await expect(signInButton).toBeVisible({ timeout: 30000 });

    await signInButton.click();
    await page.waitForURL(mockLoginUrl, { timeout: 10000 });

    // Regression guard: the URL must NOT contain the previous bug's "/some(" path-append fragment
    expect(page.url()).not.toContain('some(');
    expect(page.url()).toContain('discord.com/oauth2/authorize');
  });
});
