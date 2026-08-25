import type { Level, RulesPackage } from '../types.js';

/**
 * Lazily loaded package content, one dynamic `import()` per level.
 *
 * The `with { type: 'json' }` import attribute is mandatory: without it Node
 * throws `ERR_IMPORT_ATTRIBUTE_MISSING` at runtime (verified against
 * `module: NodeNext`), which would crash the server on boot the first time
 * anything reached this map. There is no runtime `Schema` decode — content
 * is repo-versioned and reviewed in PRs — so each loader casts the imported
 * JSON's inferred literal type to `RulesPackage` via `as unknown as
 * RulesPackage` (see the Phase 0 plan, decision D2).
 *
 * That cast is load-bearing and cannot become a type annotation:
 * `resolveJsonModule` infers `level: number` (not the `Level` union),
 * `view: number[]` (not a 4-tuple) and `roleTeam`/`team` as `string` (not their
 * literal unions), so the inferred shape genuinely fails to satisfy
 * `RulesPackage` with `TS2322`. `test/guards/` validates the real shape in CI.
 *
 * Importing this module (or `@sideline/rules`, the `.` entry point that
 * re-exports it) pulls in **no** package JSON — `import()` calls are only
 * evaluated when actually invoked.
 */
export const PACKAGE_LOADERS: Readonly<Record<Level, () => Promise<RulesPackage>>> = {
  1: () =>
    import('./packages/01-pull.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  2: () =>
    import('./packages/02-marking.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  3: () =>
    import('./packages/03-receiving.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  4: () =>
    import('./packages/04-thrower-marker.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  5: () =>
    import('./packages/05-travel.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  6: () =>
    import('./packages/06-picks.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  7: () =>
    import('./packages/07-stall-count.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  8: () =>
    import('./packages/08-out-of-bounds.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
  9: () =>
    import('./packages/09-stoppages.json', { with: { type: 'json' } }).then(
      (m) => m.default as unknown as RulesPackage,
    ),
};
