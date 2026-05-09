import { expect, test } from '../fixtures/api-mocks.js';
import { TEAM_ID } from '../fixtures/mock-data.js';

test.describe('Team Invites Page', () => {
  test.setTimeout(60000);

  test('lists existing invites', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/invites`);
    await expect(page.getByRole('heading', { name: 'Invites' })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByText('test-invite-abc123')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Invite' })).toBeVisible();
  });

  test('creates a new invite via the dialog', async ({ page }) => {
    await page.goto(`/teams/${TEAM_ID}/invites`);
    await expect(page.getByRole('button', { name: 'New Invite' })).toBeVisible({
      timeout: 30000,
    });

    // Capture the POST so we can assert the network call actually happened.
    const createRequest = page.waitForRequest(
      (req) => req.method() === 'POST' && new RegExp(`/teams/${TEAM_ID}/invites$`).test(req.url()),
    );

    await page.getByRole('button', { name: 'New Invite' }).click();
    await expect(page.getByRole('heading', { name: 'New Invite Link' })).toBeVisible();
    await page.getByRole('button', { name: 'Create Invite' }).click();

    const request = await createRequest;
    const body = request.postDataJSON() as { groupId: unknown; expiresAt: unknown };
    expect(body.groupId).toBeNull();
    expect(body.expiresAt).toBeNull();

    // Success state shows the freshly created code.
    await expect(page.getByText('Invite link ready')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('input[readonly]')).toHaveValue(/newly-created-code$/);
  });
});
