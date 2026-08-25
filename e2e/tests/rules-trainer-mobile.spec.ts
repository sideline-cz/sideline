import { expect, unauthenticatedTest as test } from '../fixtures/api-mocks.js';

/**
 * Mobile-viewport smoke pass for `/en/rules`, ported from
 * `~/Projects/frisbee-rules/test/mobile.mjs`'s intent: the field renders
 * without being clipped, option buttons are actually tappable (adequate hit
 * size, not obscured by anything else), and nothing forces horizontal
 * scrolling — the failure mode that test guards against elsewhere in this
 * app (a squeezed flex header) applies equally well to a trainer whose main
 * content is an SVG diagram plus a stack of answer buttons.
 */

const START_BUTTON = /^Practice \(\d+\)$/;
const VIEWPORT = { width: 375, height: 812 };

test.describe('Rules trainer — mobile', () => {
  test.use({ viewport: VIEWPORT });

  test('field SVG renders fully within the viewport, not clipped', async ({ page }) => {
    await page.goto('/en/rules');
    await page.getByRole('button', { name: START_BUTTON }).click();

    const svg = page.locator('svg[role="img"]');
    await expect(svg).toBeVisible({ timeout: 15_000 });

    const box = await svg.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    }
  });

  test('nothing overflows horizontally on the intro or practice screen', async ({ page }) => {
    await page.goto('/en/rules');
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(VIEWPORT.width + 0.5);

    await page.getByRole('button', { name: START_BUTTON }).click();
    await expect(page.locator('svg[role="img"]')).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(VIEWPORT.width + 0.5);
  });

  test('option buttons are tappable: adequate hit size and not obscured', async ({ page }) => {
    await page.goto('/en/rules');
    await page.getByRole('button', { name: START_BUTTON }).click();
    await expect(page.locator('svg[role="img"]')).toBeVisible({ timeout: 15_000 });

    const buttons = page.locator('.rounded-md.border.p-3 button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i);
      // The situation "pips" row above the card pushes the options below
      // the fold on a 375px-tall viewport — scroll to each one first, same
      // as a real user would, rather than asserting everything is
      // simultaneously on-screen without scrolling.
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      if (!box) continue;

      // Comfortable tap target height (not obscured, not shrunk to nothing
      // by a flex layout squeeze — see the module doc for the failure mode
      // this guards against elsewhere in the app).
      expect(box.height).toBeGreaterThanOrEqual(32);
      expect(box.x).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT.width + 0.5);

      const hittable = await button.evaluate((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit === el || (hit !== null && el.contains(hit));
      });
      expect(hittable, `option button ${i} is not hit-testable at its own center`).toBe(true);
    }
  });
});
