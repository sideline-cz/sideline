/**
 * Web-local package loaders.
 *
 * `@sideline/rules` already exports `PACKAGE_LOADERS`, and that is what the
 * server and bot should use. Web cannot, for one specific reason:
 *
 *   **Vite/Rolldown will not rewrite a dynamic `import()` that carries an
 *   import attribute.** The shared map must carry `with { type: 'json' }` or
 *   Node throws `ERR_IMPORT_ATTRIBUTE_MISSING` on boot. Bundled, that same
 *   attribute makes the bundler leave the specifier verbatim, so the browser
 *   resolves it relative to `/assets/` and every request 404s.
 *
 * That failure reached a preview build with `pnpm build`, `pnpm check` and the
 * whole unit suite green — the tests mock the loaders, so only driving the page
 * in a real browser caught it.
 *
 * Verified by elimination: it is the attribute, not the specifier shape. Both
 * the relative `'./packages/01-pull.json'` and the bare
 * `'@sideline/rules/packages/01-pull.json'` are left un-rewritten while the
 * attribute is present; dropping it rewrites correctly. So this map uses bare
 * specifiers (via the package's `./packages/*` export) and **no attribute** —
 * safe here because web is `moduleResolution: "bundler"`, which neither needs
 * nor wants one.
 *
 * Specifiers must stay LITERAL. A computed `` `…/${level}.json` `` is also
 * unfollowable by the bundler, which is why this is nine spelled-out entries
 * rather than a loop.
 *
 * The duplication versus the shared map is real but bounded: only the
 * *filenames* are repeated, never content or logic. `loaders.test.ts` asserts
 * this map's keys are exactly `LEVELS` and that every loader resolves real
 * content, so adding a tenth package without wiring it here fails a test
 * rather than 404ing at runtime.
 */
import { LEVELS, type Level, type RulesPackage } from '@sideline/rules';

const unwrap = (m: { default: unknown }): RulesPackage => m.default as RulesPackage;

export const WEB_PACKAGE_LOADERS: Readonly<Record<Level, () => Promise<RulesPackage>>> = {
  1: () => import('@sideline/rules/packages/01-pull.json').then(unwrap),
  2: () => import('@sideline/rules/packages/02-marking.json').then(unwrap),
  3: () => import('@sideline/rules/packages/03-receiving.json').then(unwrap),
  4: () => import('@sideline/rules/packages/04-thrower-marker.json').then(unwrap),
  5: () => import('@sideline/rules/packages/05-travel.json').then(unwrap),
  6: () => import('@sideline/rules/packages/06-picks.json').then(unwrap),
  7: () => import('@sideline/rules/packages/07-stall-count.json').then(unwrap),
  8: () => import('@sideline/rules/packages/08-out-of-bounds.json').then(unwrap),
  9: () => import('@sideline/rules/packages/09-stoppages.json').then(unwrap),
};

/** Exported for the drift guard in `loaders.test.ts`. */
export const WEB_LOADER_LEVELS = LEVELS;
