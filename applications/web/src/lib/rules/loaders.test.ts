/**
 * Drift guard for the web-local loader map.
 *
 * The map exists because the shared `PACKAGE_LOADERS`' relative specifiers do
 * not survive bundling (see `loaders.ts`). Its cost is that package filenames
 * are listed in two places, so a tenth package could be added to
 * `packages/rules` and silently 404 in web. These tests make that a failing
 * test instead.
 */
import { LEVELS } from '@sideline/rules';
import { describe, expect, it } from 'vitest';

const { WEB_PACKAGE_LOADERS } = await import('~/lib/rules/loaders.js');

describe('WEB_PACKAGE_LOADERS', () => {
  it('covers exactly the levels the package declares', () => {
    const mapped = Object.keys(WEB_PACKAGE_LOADERS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(mapped).toEqual([...LEVELS]);
  });

  it('exposes a callable loader for every level', () => {
    for (const level of LEVELS) {
      expect(typeof WEB_PACKAGE_LOADERS[level]).toBe('function');
    }
  });

  it('actually resolves real content for every level, with the level matching', async () => {
    // This is the assertion that would have caught the 404: it exercises the
    // real specifiers rather than a mock. In vitest these resolve through
    // Node, so it verifies the `./packages/*` export and the JSON import
    // attribute, though not the browser's chunk URLs.
    for (const level of LEVELS) {
      const pkg = await WEB_PACKAGE_LOADERS[level]();
      expect(pkg.level).toBe(level);
      expect(pkg.scenarios.length).toBeGreaterThan(0);
    }
  });
});
