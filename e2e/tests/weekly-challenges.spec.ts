// E2E spec for the Weekly Challenges page.
// Pattern: events.spec.ts + api-mocks.ts fixture.
//
// This spec mocks the API at the network level — no real DB needed.
// It will FAIL until applications/web/src/routes/(authenticated)/teams/$teamId/challenges.tsx
// is implemented and the route renders WeeklyChallengesPage.

import { expect, test } from '../fixtures/api-mocks.js';
import { MEMBER_ID, TEAM_ID } from '../fixtures/mock-data.js';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

const CHALLENGE_ID = 'e2e-challenge-00000001';

const CURRENT_MONDAY = (() => {
  // Compute the current Monday (UTC midnight) at spec evaluation time.
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + daysToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.toISOString();
})();

function makeEmptyListResponse() {
  return {
    team: { id: TEAM_ID, timezone: 'Europe/Prague' },
    canCreate: true,
    currentMemberId: MEMBER_ID,
    challenges: [],
  };
}

function makeListResponseWithChallenge(completed: boolean) {
  return {
    team: { id: TEAM_ID, timezone: 'Europe/Prague' },
    canCreate: true,
    currentMemberId: MEMBER_ID,
    challenges: [
      {
        challenge: {
          id: CHALLENGE_ID,
          team_id: TEAM_ID,
          week_start_date: CURRENT_MONDAY,
          kind: 'throwing',
          title: 'E2E test challenge',
          description: null,
          created_by: MEMBER_ID,
          created_at: CURRENT_MONDAY,
          updated_at: CURRENT_MONDAY,
        },
        completedMemberIds: completed ? [MEMBER_ID] : [],
        isActive: true,
      },
    ],
  };
}

function makeCreatedChallenge() {
  return {
    id: CHALLENGE_ID,
    team_id: TEAM_ID,
    week_start_date: CURRENT_MONDAY,
    kind: 'throwing',
    title: 'E2E test challenge',
    description: null,
    created_by: MEMBER_ID,
    created_at: CURRENT_MONDAY,
    updated_at: CURRENT_MONDAY,
  };
}

// ---------------------------------------------------------------------------
// Helper: wrap a route handler to intercept only API fetch/xhr calls
// (page navigations pass through)
// ---------------------------------------------------------------------------

const challengesBaseUrl = `**/teams/${TEAM_ID}/weekly-challenges`;

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe('Weekly Challenges', () => {
  test.setTimeout(90000);

  test('captain creates a challenge, ticks own row, reloads, stays ticked', async ({ page }) => {
    // ---------------------------------------------------------------------------
    // Step 1: Mock GET → empty list; navigate to the challenges page
    // ---------------------------------------------------------------------------

    let getChallengesBody = JSON.stringify(makeEmptyListResponse());

    await page.route(`${challengesBaseUrl}`, async (route) => {
      const type = route.request().resourceType();
      if (type !== 'fetch' && type !== 'xhr') {
        await route.fallback();
        return;
      }
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: getChallengesBody,
        });
      } else if (method === 'POST') {
        // Create challenge
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(makeCreatedChallenge()),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto(`/teams/${TEAM_ID}/challenges`);

    // ---------------------------------------------------------------------------
    // Step 2: Assert page heading is visible
    // ---------------------------------------------------------------------------

    await expect(
      page.getByRole('heading', { name: /Týdenní výzvy|Weekly Challenges/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // ---------------------------------------------------------------------------
    // Step 3: Click "+ Nová výzva", fill in title, submit
    // ---------------------------------------------------------------------------

    const createButton = page.getByText(/\+ Nová výzva|\+ New challenge/i).first();
    await expect(createButton).toBeVisible({ timeout: 10000 });
    await createButton.click();

    // Dialog should open
    await expect(page.getByText(/Nová týdenní výzva|New weekly challenge/i).first()).toBeVisible({
      timeout: 10000,
    });

    // Fill in the title
    const titleInput = page.getByPlaceholder(/Např. 30 bekhendů|30 backhands/i).first();
    await titleInput.fill('E2E test challenge');

    // Submit the form (the default Monday should already be selected + kind defaulted)
    const submitButton = page.getByText(/Vytvořit výzvu|Create challenge/i).last();
    await submitButton.click();

    // ---------------------------------------------------------------------------
    // Step 4: After POST intercepted, update GET mock to return the new challenge; reload
    // ---------------------------------------------------------------------------

    getChallengesBody = JSON.stringify(makeListResponseWithChallenge(false));
    await page.reload();
    await expect(
      page.getByRole('heading', { name: /Týdenní výzvy|Weekly Challenges/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // ---------------------------------------------------------------------------
    // Step 5: Assert new challenge title visible in the grid/list
    // ---------------------------------------------------------------------------

    await expect(page.getByText('E2E test challenge').first()).toBeVisible({ timeout: 15000 });

    // ---------------------------------------------------------------------------
    // Step 6: Mock POST .../complete → 204; click the toggle for the current week
    // ---------------------------------------------------------------------------

    await page.route(`${challengesBaseUrl}/${CHALLENGE_ID}/complete`, async (route) => {
      const type = route.request().resourceType();
      if (type !== 'fetch' && type !== 'xhr') {
        await route.fallback();
        return;
      }
      await route.fulfill({ status: 204 });
    });

    // Find and click the toggle/mark button in the captain's own row
    const markButton = page
      .getByRole('button', { name: /Označit splněno|Mark as completed/i })
      .first();
    await expect(markButton).toBeVisible({ timeout: 10000 });
    await markButton.click();

    // After click (debounce 400ms + propagation), cell should show "Splněno ✓"
    await expect(page.getByText(/Splněno ✓|Completed ✓/i).first()).toBeVisible({
      timeout: 6000,
    });

    // ---------------------------------------------------------------------------
    // Step 7: Reload with GET returning completedMemberIds: [MEMBER_ID]
    // ---------------------------------------------------------------------------

    getChallengesBody = JSON.stringify(makeListResponseWithChallenge(true));
    await page.reload();
    await expect(
      page.getByRole('heading', { name: /Týdenní výzvy|Weekly Challenges/i }).first(),
    ).toBeVisible({ timeout: 30000 });

    // ---------------------------------------------------------------------------
    // Step 8: Assert the cell still shows "Splněno ✓"
    // ---------------------------------------------------------------------------

    await expect(page.getByText(/Splněno ✓|Completed ✓/i).first()).toBeVisible({
      timeout: 10000,
    });
  });
});
