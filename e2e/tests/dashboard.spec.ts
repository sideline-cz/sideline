import { expect, test } from '../fixtures/api-mocks.js';
import { TEAM_ID } from '../fixtures/mock-data.js';

const DASHBOARD_URL = `/teams/${TEAM_ID}`;

test.describe('Team Dashboard', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto(DASHBOARD_URL);
    // Wait for dashboard content to render (not just networkidle)
    await expect(page.getByText('Test Team').first()).toBeVisible({ timeout: 30000 });
  });

  test('dashboard page loads and shows team name', async ({ page }) => {
    await expect(page.getByText('Test Team').first()).toBeVisible();
  });

  test('shows upcoming events section with Weekly Training', async ({ page }) => {
    await expect(page.getByText('Upcoming Events')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Weekly Training')).toBeVisible();
  });

  test('shows awaiting RSVP section with Friendly Match', async ({ page }) => {
    await expect(page.getByText('Awaiting Your RSVP')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Friendly Match')).toBeVisible();
  });

  test('shows activity summary stats', async ({ page }) => {
    await expect(page.getByText('Activity Summary')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Current Streak')).toBeVisible();
    await expect(page.getByText('5d')).toBeVisible();
    await expect(page.getByText('Total Activities')).toBeVisible();
    await expect(page.getByText('42')).toBeVisible();
  });

  test('navigation sidebar is visible with expected links', async ({ page }) => {
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 10000 });
    await expect(sidebar.getByRole('link', { name: /Dashboard/ })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: /Events/ })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Members', exact: true })).toBeVisible();
  });

  test('can navigate to events page from sidebar', async ({ page }) => {
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    await sidebar.getByRole('link', { name: /Events/ }).click();
    await expect(page).toHaveURL(`/teams/${TEAM_ID}/events`, { timeout: 30000 });
  });

  test('can navigate to members page from sidebar', async ({ page }) => {
    const sidebar = page.locator('[data-sidebar="sidebar"]');
    await sidebar.getByRole('link', { name: 'Members', exact: true }).click();
    await expect(page).toHaveURL(`/teams/${TEAM_ID}/members`, { timeout: 30000 });
  });
});
