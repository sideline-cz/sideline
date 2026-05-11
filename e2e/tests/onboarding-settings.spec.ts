// TDD mode — e2e tests for the Discord Native Onboarding card on TeamSettingsPage.
// These tests will FAIL until Phase 5 implements:
//   - The onboarding card component in applications/web/src/components/pages/TeamSettingsPage.tsx
//   - The retryOnboardingSync endpoint
//   - The mockTeamInfo in e2e/fixtures/mock-data.ts extended with onboarding fields
//
// Playwright intercepts mock team info from api-mocks.ts. Tests here override routes
// locally where richer mock data is needed.

import { expect, test } from '../fixtures/api-mocks.js';
import { TEAM_ID } from '../fixtures/mock-data.js';

const SETTINGS_URL = `/teams/${TEAM_ID}/settings`;

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

const mockTeamInfoWithOnboarding = (onboardingOverrides: Record<string, unknown> = {}) => ({
  teamId: TEAM_ID,
  name: 'Test Team',
  description: 'A test team',
  sport: 'Football',
  logoUrl: null,
  guildId: '987654321',
  welcomeChannelId: '111111111111111111',
  systemLogChannelId: null,
  welcomeMessageTemplate: null,
  // New onboarding fields
  rulesChannelId: '222222222222222222',
  onboardingRulesRoleId: '333333333333333333',
  onboardingLocale: 'en',
  onboardingSyncStatus: 'done',
  onboardingSyncedAt: '2024-06-01T10:00:00.000Z',
  onboardingSyncError: null,
  isCommunityEnabled: true,
  ...onboardingOverrides,
});

const mockGuildRoles = [
  { id: '333333333333333333', name: 'Players', color: 0, position: 3, managed: false },
  { id: '444444444444444444', name: 'Coaches', color: 0xff0000, position: 5, managed: false },
  // @everyone (id === guild_id) — should be filtered out in the UI
  { id: '987654321', name: '@everyone', color: 0, position: 0, managed: false },
  // Managed role (e.g. Nitro boost) — should be filtered out in the UI
  { id: '555555555555555555', name: 'Nitro Booster', color: 0xf47fff, position: 10, managed: true },
];

const mockDiscordChannels = [
  { id: '222222222222222222', name: 'rules', type: 0, parentId: null },
  { id: '111111111111111111', name: 'welcome', type: 0, parentId: null },
  { id: '666666666666666666', name: 'training', type: 0, parentId: null },
  // Voice channel — should NOT appear in rules channel select
  { id: '777777777777777777', name: 'General Voice', type: 2, parentId: null },
];

// ---------------------------------------------------------------------------
// Shared route setup helper
// ---------------------------------------------------------------------------

const setupRoutes = async (
  page: import('@playwright/test').Page,
  onboardingOverrides: Record<string, unknown> = {},
  patchResponse?: Record<string, unknown>,
) => {
  await page.route('**/teams/*/discord-channels', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockDiscordChannels),
    });
  });

  await page.route('**/teams/*/discord-roles', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockGuildRoles),
    });
  });

  await page.route('**/teams/*', async (route) => {
    const url = route.request().url();
    const pathAfterTeams = url.split('/teams/')[1];
    const method = route.request().method();

    if (pathAfterTeams && !pathAfterTeams.includes('/')) {
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockTeamInfoWithOnboarding(onboardingOverrides)),
        });
      } else if (method === 'PATCH' && patchResponse) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockTeamInfoWithOnboarding(patchResponse)),
        });
      } else {
        await route.fallback();
      }
    } else {
      await route.fallback();
    }
  });
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Onboarding Settings Card', () => {
  test.setTimeout(60000);

  test('onboarding card renders with all 3 form controls and status section', async ({ page }) => {
    await setupRoutes(page);
    await page.goto(SETTINGS_URL);

    // Card heading (Discord Onboarding or similar)
    await expect(page.getByRole('heading', { name: /onboarding/i }).first()).toBeVisible({
      timeout: 30000,
    });

    // Rules channel select
    await expect(page.getByLabel(/rules channel/i)).toBeVisible({ timeout: 15000 });

    // Entry role select (searchable select for onboarding role)
    await expect(
      page.getByLabel(/entry role/i).or(page.getByLabel(/onboarding role/i)),
    ).toBeVisible({
      timeout: 15000,
    });

    // Locale toggle group (EN / CS) — scope by the fieldset's accessible name (its <legend>).
    await expect(page.getByRole('group', { name: /onboarding language/i })).toBeVisible({
      timeout: 15000,
    });

    // Status section (a badge showing current sync status)
    await expect(page.getByRole('status')).toBeVisible({ timeout: 15000 });
  });

  test('role-select filtering: @everyone and managed roles are NOT visible options', async ({
    page,
  }) => {
    await setupRoutes(page, {}, { onboardingSyncStatus: 'pending' });
    await page.goto(SETTINGS_URL);

    // Wait for the onboarding card to load
    await expect(page.getByRole('heading', { name: /onboarding/i }).first()).toBeVisible({
      timeout: 30000,
    });

    // Open the role select (SearchableSelect)
    const roleSelect = page
      .getByLabel(/entry role/i)
      .or(page.getByLabel(/onboarding role/i))
      .first();
    await roleSelect.click();

    // Managed roles (Nitro Booster, managed:true) must NOT appear
    await expect(page.getByText('Nitro Booster')).not.toBeVisible({ timeout: 5000 });

    // @everyone must NOT appear in the dropdown
    await expect(page.getByText('@everyone')).not.toBeVisible({ timeout: 5000 });

    // Non-managed roles SHOULD appear in the listbox options.
    await expect(page.getByRole('option', { name: /^@(Players|Coaches)$/ }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test('save with changed rulesChannelId flips status badge to "Pending sync" and shows toast', async ({
    page,
  }) => {
    let capturedPatchBody: unknown = null;
    // Track sync status across requests so that the GET after the post-save
    // router.invalidate() reflects the new 'pending' status (mirroring production).
    let currentStatus: 'done' | 'pending' = 'done';

    await page.route('**/teams/*/discord-channels', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDiscordChannels),
      });
    });

    await page.route('**/teams/*/discord-roles', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGuildRoles),
      });
    });

    await page.route('**/teams/*', async (route) => {
      const url = route.request().url();
      const pathAfterTeams = url.split('/teams/')[1];
      const method = route.request().method();

      if (pathAfterTeams && !pathAfterTeams.includes('/')) {
        if (method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              mockTeamInfoWithOnboarding({ onboardingSyncStatus: currentStatus }),
            ),
          });
        } else if (method === 'PATCH') {
          capturedPatchBody = JSON.parse(route.request().postData() ?? '{}');
          currentStatus = 'pending';
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(mockTeamInfoWithOnboarding({ onboardingSyncStatus: 'pending' })),
          });
        } else {
          await route.fallback();
        }
      } else {
        await route.fallback();
      }
    });

    await page.goto(SETTINGS_URL);

    // Wait for the onboarding card to be visible
    await expect(page.getByRole('heading', { name: /onboarding/i }).first()).toBeVisible({
      timeout: 30000,
    });

    // *** Actually change a value before saving ***
    // Open the rules channel select and pick the 'training' channel (id 666666666666666666)
    const rulesChannelSelect = page.getByLabel(/rules channel/i).first();
    await rulesChannelSelect.click();
    // Pick a DIFFERENT channel from the current one ('222...' → 'training' / '666...').
    // Match the listbox option by role to avoid the unrelated "Default channel: Training" label.
    const trainingOption = page.getByRole('option', { name: /# training/i });
    await trainingOption.click();

    // Click save button for the onboarding section (last save button in DOM order).
    const saveButton = page.locator('button').filter({ hasText: /save/i }).last();
    await saveButton.click();

    // Assert the PATCH request body contains the new rulesChannelId
    await page.waitForTimeout(500); // give the request time to fire
    const body = capturedPatchBody as Record<string, unknown> | null;
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).rulesChannelId).toBe('666666666666666666');

    // Status badge should update to "Pending sync" (after invalidation/refetch).
    await expect(page.getByText(/pending sync/i)).toBeVisible({ timeout: 10000 });

    // Toast notification — use project's toast locator (Sonner or shadcn toast)
    await expect(
      page
        .getByRole('alert')
        .or(page.locator('[data-sonner-toast]'))
        .or(page.locator('[role="status"]').filter({ hasText: /saved|syncing/i })),
    ).toBeVisible({ timeout: 10000 });
  });

  test('failed sync with role_deleted error shows actionable copy and Retry button; clicking Retry flips to pending', async ({
    page,
  }) => {
    let callCount = 0;

    await page.route('**/teams/*/onboarding/retry', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          mockTeamInfoWithOnboarding({
            onboardingSyncStatus: 'pending',
            onboardingSyncError: null,
          }),
        ),
      });
    });

    await page.route('**/teams/*', async (route) => {
      const url = route.request().url();
      const pathAfterTeams = url.split('/teams/')[1];
      if (pathAfterTeams && !pathAfterTeams.includes('/') && route.request().method() === 'GET') {
        callCount++;
        const status = callCount === 1 ? 'failed' : 'pending';
        const error =
          callCount === 1
            ? JSON.stringify({ code: 'role_deleted', detail: 'Role no longer exists' })
            : null;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            mockTeamInfoWithOnboarding({
              onboardingSyncStatus: status,
              onboardingSyncError: error,
            }),
          ),
        });
      } else {
        await route.fallback();
      }
    });

    await page.route('**/teams/*/discord-channels', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDiscordChannels),
      });
    });

    await page.route('**/teams/*/discord-roles', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGuildRoles),
      });
    });

    await page.goto(SETTINGS_URL);

    // Should show error copy for role_deleted (target the user-facing <p>, not the debug <pre>).
    const errorMessage = page.locator('#onboarding-error-message');
    await expect(errorMessage).toBeVisible({ timeout: 30000 });
    await expect(errorMessage).toHaveText(/role no longer exists/i);

    // Retry button should be visible
    const retryButton = page.getByRole('button', { name: /retry/i });
    await expect(retryButton).toBeVisible({ timeout: 10000 });

    // Click retry
    await retryButton.click();

    // Status should flip to "Pending sync"
    await expect(page.getByText(/pending/i)).toBeVisible({ timeout: 10000 });
  });

  test('community-disabled state: form is in disabled fieldset, Alert is visible and status section is outside fieldset', async ({
    page,
  }) => {
    await page.route('**/teams/*', async (route) => {
      const url = route.request().url();
      const pathAfterTeams = url.split('/teams/')[1];
      if (pathAfterTeams && !pathAfterTeams.includes('/') && route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            mockTeamInfoWithOnboarding({ isCommunityEnabled: false, onboardingSyncStatus: 'done' }),
          ),
        });
      } else {
        await route.fallback();
      }
    });

    await page.route('**/teams/*/discord-channels', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockDiscordChannels),
      });
    });

    await page.route('**/teams/*/discord-roles', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockGuildRoles),
      });
    });

    await page.goto(SETTINGS_URL);

    // Wait for page to load
    await expect(page.getByRole('heading', { name: /onboarding/i }).first()).toBeVisible({
      timeout: 30000,
    });

    // Community-required Alert should be visible
    await expect(page.getByRole('alert').filter({ hasText: /community/i })).toBeVisible({
      timeout: 15000,
    });

    // Form fields should be wrapped in a disabled fieldset
    const fieldset = page.locator('fieldset[disabled]');
    await expect(fieldset).toBeVisible({ timeout: 10000 });

    // Status section should remain accessible (outside the disabled fieldset)
    const statusSection = page.getByRole('status');
    await expect(statusSection).toBeVisible({ timeout: 10000 });

    // Verify status is NOT inside the disabled fieldset (screen-reader reachable)
    const isInsideDisabledFieldset = await statusSection.evaluate((el) => {
      let parent = el.parentElement;
      while (parent) {
        if (parent.tagName === 'FIELDSET' && (parent as HTMLFieldSetElement).disabled) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    });
    expect(isInsideDisabledFieldset).toBe(false);
  });
});
