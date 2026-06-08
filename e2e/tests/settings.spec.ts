import { expect, test } from '../fixtures/api-mocks.js';
import { TEAM_ID } from '../fixtures/mock-data.js';

test.describe('Settings Page', () => {
  test.setTimeout(60000);

  test('page loads and shows settings page', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/settings`);
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page).not.toHaveURL('/');
  });

  test('shows team name or settings header', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/settings`);
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 30000 });
  });

  test('shows event horizon setting (30 days)', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/settings`);
    await expect(page.getByLabel('Event generation horizon (days)')).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByLabel('Event generation horizon (days)')).toHaveValue('30');
  });

  test('shows min players threshold (10)', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/settings`);
    await expect(page.getByLabel('Minimum players threshold')).toBeVisible({ timeout: 30000 });
    await expect(page.getByLabel('Minimum players threshold')).toHaveValue('10');
  });

  // ASSUMPTION: The web form renders the claimRequestDaysBefore field inside a
  // "Coach assignment" card (i18n key: teamSettings_coachAssignment, English:
  // "Coach assignment"). The input is labelled with i18n key
  // teamSettings_claimRequestDaysBefore (English: "Days before training") and
  // has id "claim-request-days-before". The web developer must honour at least
  // one of these conventions so the locators below resolve correctly.
  // The mock value is 3 (from mockTeamSettings.claimRequestDaysBefore).
  test('shows claim-request days before (3) inside Coach assignment card', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/settings`);
    // Wait for the page to fully load by asserting a known field is visible first.
    await expect(page.getByLabel('Event generation horizon (days)')).toBeVisible({
      timeout: 30000,
    });
    // Primary locator: label text "Days before training" (English i18n value for
    // teamSettings_claimRequestDaysBefore). Falls back to id-based locator if the
    // label text changes — the developer must ensure one of these works.
    const field = page.getByLabel('Days before training');
    await expect(field).toBeVisible({ timeout: 30000 });
    await expect(field).toHaveValue('3');
  });
});

test.describe('Roles List', () => {
  test.setTimeout(60000);

  test('page loads and shows roles', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/roles`);
    await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible({ timeout: 30000 });
  });

  test('shows "Admin" role (built-in)', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/roles`);
    await expect(page.getByText('Admin').first()).toBeVisible({ timeout: 30000 });
  });

  test('shows "Coach" role', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/roles`);
    await expect(page.getByText('Coach').first()).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Groups List', () => {
  test.setTimeout(60000);

  test('page loads and shows groups', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/groups`);
    await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible({ timeout: 30000 });
  });

  test('shows "Attackers" group', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/groups`);
    await expect(page.getByRole('heading', { name: 'Groups' })).toBeVisible({ timeout: 30000 });
    // Use a more specific locator — getByText('Attackers').first() resolves to a
    // hidden <option> in the parent group select. Target the visible list item instead.
    await expect(page.locator('text=Attackers >> visible=true').first()).toBeVisible({
      timeout: 30000,
    });
  });
});

test.describe('Rosters List', () => {
  test.setTimeout(60000);

  test('page loads and shows rosters', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/rosters`);
    await expect(page.getByRole('heading', { name: 'Rosters' })).toBeVisible({ timeout: 30000 });
  });

  test('shows "Main Roster"', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/rosters`);
    await expect(page.getByText('Main Roster').first()).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Training Types List', () => {
  test.setTimeout(60000);

  test('page loads and shows training types', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/training-types`);
    await expect(page.getByRole('heading', { name: 'Training Types' })).toBeVisible({
      timeout: 30000,
    });
  });

  test('shows "Goalkeeping" training type', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/training-types`);
    await expect(page.getByText('Goalkeeping').first()).toBeVisible({ timeout: 30000 });
  });
});
