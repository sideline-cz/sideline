import type { Route } from '@playwright/test';
import { expect, test } from '../fixtures/api-mocks.js';
import { EVENT_ID, mockGroups, TEAM_ID } from '../fixtures/mock-data.js';

test.describe('Events List', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/events`);
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible({ timeout: 30000 });
  });

  test('page loads and shows events list', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();
  });

  test('shows "Weekly Training" event', async ({ page }) => {
    await expect(page.getByText('Weekly Training').first()).toBeVisible();
  });

  test('shows "Friendly Match" event', async ({ page }) => {
    await expect(page.getByText('Friendly Match').first()).toBeVisible();
  });

  test('can click on event to navigate to detail', async ({ page }) => {
    await page.getByText('Weekly Training').first().click();
    await expect(page).toHaveURL(new RegExp(`/teams/${TEAM_ID}/events/`), { timeout: 30000 });
  });

  test('New event opens create dialog', async ({ page }) => {
    await page.getByRole('button', { name: 'New event' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Title')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('create dialog fits a 360px screen', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.getByRole('button', { name: 'New event' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Recurring' }).click();
    await expect(dialog.getByRole('button', { name: 'Create Recurring Series' })).toBeAttached();

    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.height).toBeLessThanOrEqual(740);
    // Catches the weekday-toggle row overflowing the dialog's content box.
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  });
});

test.describe('Events List — create dialog group picker', () => {
  test.setTimeout(60000);

  test('group picker scrolls inside the dialog', async ({ page }) => {
    // 15 groups overflow the picker's max-h-60 listbox. Registered after the fixture's routes,
    // so it wins; the resourceType guard keeps the glob off page navigations.
    const groups = Array.from({ length: 15 }, (_, i) => ({
      ...mockGroups[0],
      groupId: `test-group-scroll-${String(i).padStart(4, '0')}`,
      name: `Group ${String(i + 1).padStart(2, '0')}`,
    }));
    await page.route('**/teams/*/groups', async (route: Route) => {
      const type = route.request().resourceType();
      if ((type !== 'fetch' && type !== 'xhr') || route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(groups),
      });
    });

    await page.goto(`/teams/${TEAM_ID}/events`);
    await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible({ timeout: 30000 });

    await page.getByRole('button', { name: 'New event' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox', { name: 'Owner Group' }).click();

    const listbox = page.getByRole('listbox');
    await expect(listbox.getByRole('option', { name: 'Group 01' })).toBeVisible();
    const before = await listbox.evaluate((el) => el.scrollTop);
    expect(before).toBe(0);

    await listbox.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => listbox.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });
});

test.describe('Event Detail', () => {
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/events/${EVENT_ID}`);
    // Wait for the page to show event content (title may be in heading or form)
    await expect(page.getByText('Weekly Training').first()).toBeVisible({ timeout: 30000 });
  });

  test('page loads and shows event title', async ({ page }) => {
    await expect(page.getByText('Weekly Training').first()).toBeVisible();
  });

  test('shows event details', async ({ page }) => {
    // Training type name appears on the page
    await expect(page.getByText('Goalkeeping').first()).toBeVisible({ timeout: 10000 });
  });

  test('shows RSVP section', async ({ page }) => {
    // The RSVP section should be visible
    await expect(page.getByRole('button', { name: /Yes/ }).first()).toBeVisible({ timeout: 10000 });
  });
});
