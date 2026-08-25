import pkg01 from './content/packages/01-pull.json' with { type: 'json' };
import pkg02 from './content/packages/02-marking.json' with { type: 'json' };
import pkg03 from './content/packages/03-receiving.json' with { type: 'json' };
import pkg04 from './content/packages/04-thrower-marker.json' with { type: 'json' };
import pkg05 from './content/packages/05-travel.json' with { type: 'json' };
import pkg06 from './content/packages/06-picks.json' with { type: 'json' };
import pkg07 from './content/packages/07-stall-count.json' with { type: 'json' };
import pkg08 from './content/packages/08-out-of-bounds.json' with { type: 'json' };
import pkg09 from './content/packages/09-stoppages.json' with { type: 'json' };
import type { RulesPackage } from './types.js';

/**
 * All nine packages, eagerly imported (subpath `@sideline/rules/content`).
 *
 * This is the `content` subpath specifically so it can be kept out of the
 * `.` entry point's graph, and out of `applications/web`'s bundle — see the
 * `noRestrictedImports` override in `biome.json` and `packages/rules/AGENTS.md`.
 * Use `PACKAGE_LOADERS` from `@sideline/rules` instead when only one level is
 * needed at a time.
 */
export const ALL_PACKAGES: readonly RulesPackage[] = [
  pkg01 as unknown as RulesPackage,
  pkg02 as unknown as RulesPackage,
  pkg03 as unknown as RulesPackage,
  pkg04 as unknown as RulesPackage,
  pkg05 as unknown as RulesPackage,
  pkg06 as unknown as RulesPackage,
  pkg07 as unknown as RulesPackage,
  pkg08 as unknown as RulesPackage,
  pkg09 as unknown as RulesPackage,
];
