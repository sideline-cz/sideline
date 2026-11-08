import type { Route } from '@playwright/test';
import { expect, test } from '../fixtures/api-mocks.js';
import { MEMBER_ID, mockMembers, TEAM_ID } from '../fixtures/mock-data.js';

test.describe('Members', () => {
  test.setTimeout(60000);

  test.describe('Members List', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/teams/${TEAM_ID}/members`);
      // Wait for members table to render
      await expect(page.getByText('Test User').first()).toBeVisible({ timeout: 30000 });
    });

    test('page loads and shows members list', async ({ page }) => {
      await expect(page.getByText('Test User').first()).toBeVisible();
    });

    test('shows member with Admin role', async ({ page }) => {
      const testUserRow = page.getByRole('row').filter({ hasText: 'Test User' });
      await expect(testUserRow).toContainText('Admin');
    });

    test('shows Jane Player with Player role', async ({ page }) => {
      await expect(page.getByText('Jane Player').first()).toBeVisible();
      const janeRow = page.getByRole('row').filter({ hasText: 'Jane Player' });
      await expect(janeRow).toContainText('Player');
    });

    test('can click on member to navigate to detail', async ({ page }) => {
      // Click on the first edit link
      const editLink = page.getByRole('link', { name: /Edit/ }).first();
      await editLink.click();
      await expect(page).toHaveURL(new RegExp(`/teams/${TEAM_ID}/members/`), { timeout: 30000 });
    });
  });

  test.describe('Member Detail', () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/teams/${TEAM_ID}/members/${MEMBER_ID}`);
      // Wait for the member detail page to load
      await expect(page.getByRole('heading', { name: 'Test User' }).first()).toBeVisible({
        timeout: 30000,
      });
    });

    test('page loads and shows member name', async ({ page }) => {
      await expect(page.getByRole('heading', { name: 'Test User' }).first()).toBeVisible();
    });

    test('shows member role', async ({ page }) => {
      await expect(page.getByText('Admin').first()).toBeVisible();
    });

    test('shows activity stats', async ({ page }) => {
      await expect(page.getByText('Activity Stats').first()).toBeVisible({ timeout: 10000 });
    });
  });

  test.describe('Member Detail — other member', () => {
    const OTHER_ID = 'test-member-00000002';

    // Registered after the fixture's mocks, so these win. API calls only: the member URL is also
    // the page URL.
    const json = (body: unknown) => async (route: Route) => {
      const type = route.request().resourceType();
      if (type !== 'fetch' && type !== 'xhr') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    };

    test("another member's page: read-only logs, Danger Zone visible", async ({ page }) => {
      // userId differs from the mocked /auth/me user, so this is not the viewer's own profile,
      // although listLogs succeeds (member:view lets the viewer read it).
      await page.route(`**/teams/*/members/${OTHER_ID}`, json(mockMembers[1]));
      await page.route(
        `**/teams/*/members/${OTHER_ID}/activity-logs`,
        json({
          logs: [
            {
              id: '00000000-0000-0000-0000-0000000000a1',
              activityTypeId: '00000000-0000-0000-0000-0000000000b1',
              activityTypeName: 'Sprint drills',
              activityTypeEmoji: null,
              loggedAt: '2026-11-01T12:00:00Z',
              durationMinutes: 30,
              note: 'private-note',
              source: 'manual',
            },
          ],
          seasons: [],
        }),
      );

      await page.goto(`/teams/${TEAM_ID}/members/${OTHER_ID}`);
      await expect(page.getByRole('heading', { name: 'Jane Player' }).first()).toBeVisible({
        timeout: 30000,
      });

      const logCard = page
        .locator('[data-slot="card"]')
        .filter({ has: page.getByText('Activity Log', { exact: true }) });
      await expect(logCard.getByText('Sprint drills')).toBeVisible();
      await expect(logCard.getByRole('button', { name: 'Edit' })).toHaveCount(0);
      await expect(logCard.getByRole('button', { name: 'Delete' })).toHaveCount(0);
      await expect(page.getByText('private-note')).toHaveCount(0);
      await expect(page.getByText('Danger zone', { exact: true })).toBeVisible();
    });
  });
});
