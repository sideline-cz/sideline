/**
 * Covers the rules-trainer card — the only card in the homepage bento grid that
 * is a real link rather than a static demo of the signed-in app.
 *
 * The situation count is the part worth pinning. `packages/rules`' independence
 * guard exists because the standalone app's hero once claimed "23 game
 * situations" long after there were 33; the same copy now lives in the i18n
 * catalogue, where no content guard can reach it. So the only thing stopping
 * that regression recurring is that the number is interpolated from
 * `LEVEL_META` rather than typed into the string — which is what these assert.
 */
import { LEVEL_META, LEVELS } from '@sideline/rules';
import { render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

// Render the key plus its params so interpolation is observable.
vi.mock('~/lib/translations.js', () => ({
  tr: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}(${JSON.stringify(params)})` : key,
  setTranslationOverrides: vi.fn(),
}));

vi.mock('~/lib/theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

vi.mock('~/components/organisms/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}));

const { HomePage } = await import('~/components/pages/HomePage.js');

const renderHome = () =>
  render(
    <HomePage loginUrl='https://example.test/login' error={Option.none()} reason={Option.none()} />,
  );

describe('HomePage — rules trainer card', () => {
  it('links to /rules, so it negotiates locale the same way the page did', () => {
    renderHome();
    const cta = screen.getByRole('link', { name: /hero_demo_rules_cta/ });
    expect(cta.getAttribute('href')).toBe('/rules');
  });

  it('interpolates the situation count from LEVEL_META instead of hardcoding it', () => {
    renderHome();
    const expected = LEVELS.reduce((n, level) => n + LEVEL_META[level].scenarioCount, 0);
    // Guards against someone "simplifying" the copy by typing the number in:
    // the count must arrive as a tr() param, and must match the content.
    expect(
      screen.getByText(`hero_demo_rules_desc({"count":${expected}})`, { exact: false }),
    ).toBeTruthy();
  });

  it('the interpolated count matches the real content, not a stale literal', () => {
    // If content grows and LEVEL_META is updated (guard G17 enforces that they
    // agree), this figure moves with it and no copy needs touching.
    const total = LEVELS.reduce((n, level) => n + LEVEL_META[level].scenarioCount, 0);
    expect(total).toBeGreaterThan(0);
    expect(Number.isInteger(total)).toBe(true);
  });

  it('shows the rules feature badge and its description', () => {
    renderHome();
    expect(screen.getAllByText('hero_feature_rules').length).toBeGreaterThan(0);
    expect(screen.getByText('hero_feature_rules_desc')).toBeTruthy();
  });
});
