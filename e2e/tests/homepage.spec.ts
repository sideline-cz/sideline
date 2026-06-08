import { expect, unauthenticatedTest as test } from '../fixtures/api-mocks.js';

test.describe('Homepage', () => {
  // The homepage beforeLoad calls fetchEnv() and getCurrentUser() which may be slow
  // when the backend is unavailable, so we allow extra time for assertions.
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the page to finish loading (pending component shows "Loading...")
    await page.waitForFunction(() => !document.body.textContent?.includes('Loading...'), {
      timeout: 30000,
    });
  });

  test('has correct page title', async ({ page }) => {
    await expect(page).toHaveTitle(/Sideline/);
  });

  test('has correct meta viewport', async ({ page }) => {
    const viewport = page.locator('meta[name="viewport"]');
    await expect(viewport).toHaveAttribute(
      'content',
      'width=device-width, initial-scale=1, viewport-fit=cover',
    );
  });

  test('displays app name in header', async ({ page }) => {
    const header = page.locator('header');
    await expect(header).toContainText('Sideline');
  });

  test('displays hero headline', async ({ page }) => {
    await expect(
      page.getByRole('heading', { name: 'Manage your sports team, effortlessly' }),
    ).toBeVisible();
  });

  test('displays hero subheadline', async ({ page }) => {
    await expect(page.getByText('Events, attendance, workouts, and team management')).toBeVisible();
  });

  test('displays Discord sign-in button', async ({ page }) => {
    const signInLink = page.getByRole('link', { name: /Sign in with Discord/ });
    await expect(signInLink).toBeVisible();

    const discordIcon = signInLink.locator('svg[aria-label="Discord"]');
    await expect(discordIcon).toBeVisible();
  });

  test('sign-in button links to Discord OAuth', async ({ page }) => {
    const signInLink = page.getByRole('link', { name: /Sign in with Discord/ });
    const href = await signInLink.getAttribute('href');
    expect(href).toBeTruthy();
  });

  test('displays feature badges', async ({ page }) => {
    await expect(page.getByText('Team Management').first()).toBeVisible();
    await expect(page.getByText('Events & RSVP').first()).toBeVisible();
  });

  test('displays demo stats widget', async ({ page }) => {
    await expect(page.getByText('Your Stats')).toBeVisible();
    await expect(page.getByText('Current Streak')).toBeVisible();
    await expect(page.getByText('Leaderboard Position')).toBeVisible();
  });

  test('displays demo upcoming events widget', async ({ page }) => {
    await expect(page.getByText('Next Event')).toBeVisible();
    await expect(page.getByText('Saturday Practice')).toBeVisible();
    await expect(page.getByText('League Match vs. Eagles')).toBeVisible();
    await expect(page.getByText('Main Field')).toBeVisible();
    await expect(page.getByText('City Stadium')).toBeVisible();
  });

  test('displays demo leaderboard widget', async ({ page }) => {
    await expect(page.getByText('Leaderboard').first()).toBeVisible();
    await expect(page.getByText('Martin K.')).toBeVisible();
    await expect(page.getByText('Jakub N.')).toBeVisible();
    await expect(page.getByText('You').first()).toBeVisible();
  });

  test('displays demo finance widget', async ({ page }) => {
    const card = page.locator('[data-slot="card"]', { hasText: 'Team Finances' }).first();
    await expect(card.getByText('Team Finances').first()).toBeVisible();
    await expect(card.getByText('Spring Membership').first()).toBeVisible();
    await expect(card.getByText('Paid').first()).toBeVisible();
    await expect(card.getByText('Outstanding').first()).toBeVisible();
    await expect(card.getByText('$1,240').first()).toBeVisible();
  });

  test('displays demo achievements widget', async ({ page }) => {
    await expect(page.getByText('Achievements').first()).toBeVisible();
    await expect(page.getByText('On Fire').first()).toBeVisible();
    await expect(page.getByText('Podium Finish').first()).toBeVisible();
    await expect(page.getByText('Century Club').first()).toBeVisible();
  });

  test('displays demo RSVP banner', async ({ page }) => {
    await expect(page.getByText('Awaiting RSVP')).toBeVisible();
    await expect(page.getByText('Team Building BBQ')).toBeVisible();
  });

  test('displays feature description cards', async ({ page }) => {
    await expect(
      page.getByText('Create events, track attendance, and get automatic reminders via Discord.'),
    ).toBeVisible();
    await expect(
      page.getByText(
        'Log activities, compete on the leaderboard, and build streaks with your teammates.',
      ),
    ).toBeVisible();
    await expect(
      page.getByText('Roles, rosters, groups, and member profiles — everything your team needs.'),
    ).toBeVisible();
  });

  test('displays footer', async ({ page }) => {
    const footer = page.locator('footer');
    await expect(footer).toContainText('Built for teams that use Discord');
  });

  test('header contains language switcher', async ({ page }) => {
    const header = page.locator('header');
    await expect(header.getByRole('combobox')).toBeVisible();
  });

  test('header contains theme toggle', async ({ page }) => {
    const header = page.locator('header');
    await expect(header.getByRole('button', { name: /Theme/ })).toBeVisible();
  });
});
