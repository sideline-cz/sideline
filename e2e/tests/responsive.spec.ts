import { test as authedTest, expect, unauthenticatedTest as test } from '../fixtures/api-mocks.js';
import { TEAM_ID } from '../fixtures/mock-data.js';

test.describe('Responsive Layout', () => {
  test.setTimeout(60000);

  test('mobile viewport renders key content', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await expect(
      page.getByRole('heading', { name: 'Manage your sports team, effortlessly' }),
    ).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('link', { name: /Sign in with Discord/ })).toBeVisible();
    await expect(page.locator('header')).toContainText('Sideline');
    await expect(page.locator('footer')).toContainText('Built for teams that use Discord');
  });

  test('mobile viewport hides workout badge in hero', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    // Team and Events badges are visible
    await expect(page.getByText('Team Management').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Events & RSVP').first()).toBeVisible();

    // Workout badge is hidden on mobile (has 'hidden sm:inline-flex')
    const workoutBadges = page.locator('text=Workout Tracking');
    const heroWorkoutBadge = workoutBadges.first();
    await expect(heroWorkoutBadge).toBeHidden();
  });

  test('desktop viewport shows workout badge', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // All badges visible on desktop
    await expect(page.getByText('Team Management').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Events & RSVP').first()).toBeVisible();
    // The workout badge in the hero section should be visible on desktop
    const workoutBadges = page.locator('text=Workout Tracking');
    await expect(workoutBadges.first()).toBeVisible();
  });

  test('header is visible at all viewport widths', async ({ page }) => {
    const widths = [375, 768, 1280];

    await page.goto('/');

    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });

      const header = page.locator('header');
      await expect(header).toBeVisible({ timeout: 30000 });
      await expect(header).toContainText('Sideline');
    }
  });

  test('footer is visible at all viewport widths', async ({ page }) => {
    const widths = [375, 768, 1280];

    await page.goto('/');

    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });

      const footer = page.locator('footer');
      await expect(footer).toBeVisible({ timeout: 30000 });
    }
  });

  test('demo widgets are visible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');

    await expect(page.getByText('Your Stats')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Next Event')).toBeVisible();
    await expect(page.getByText('Leaderboard').first()).toBeVisible();
    await expect(page.getByText('Awaiting RSVP')).toBeVisible();
  });

  test('demo widgets are visible on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await expect(page.getByText('Your Stats')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Next Event')).toBeVisible();
    await expect(page.getByText('Leaderboard').first()).toBeVisible();
    await expect(page.getByText('Awaiting RSVP')).toBeVisible();
  });
});

// A phone-width page that scrolls sideways is the bug class this guards: a flex/grid row that
// cannot shrink, or a table without a scroll container, pushes the whole document wider than the
// viewport and parks the row's actions off-screen where nothing reveals them.
authedTest.describe('No horizontal overflow on mobile', () => {
  authedTest.setTimeout(120000);

  const PAGES = [
    ['event types', `/teams/${TEAM_ID}/event-types`],
    ['members', `/teams/${TEAM_ID}/members`],
    ['team settings', `/teams/${TEAM_ID}/settings`],
    ['roles', `/teams/${TEAM_ID}/roles`],
    ['groups', `/teams/${TEAM_ID}/groups`],
  ] as const;

  for (const [name, url] of PAGES) {
    authedTest(`${name} fits a 360px viewport`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 780 });
      await page.goto(url);
      await expect(page.locator('h1').first()).toBeVisible({ timeout: 30000 });

      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));

      expect(
        scrollWidth,
        `${name} overflows by ${scrollWidth - clientWidth}px`,
      ).toBeLessThanOrEqual(clientWidth + 1);
    });
  }
});
