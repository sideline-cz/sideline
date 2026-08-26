/**
 * Scenario lookup for the Discord quiz.
 *
 * Imports `@sideline/rules/content` — the **eager** subpath — deliberately.
 * That entry point exists precisely so a non-browser consumer can hold all
 * nine packages in memory (see `packages/rules/AGENTS.md`); the lazy
 * `PACKAGE_LOADERS` split exists for `applications/web`'s bundle, which the
 * bot does not have. Content is ~1.1 MiB of JSON loaded once at startup,
 * which is why a quiz interaction needs no I/O at all and comfortably meets
 * Discord's 3-second ack.
 */
import type { Level, Scenario } from '@sideline/rules';
import { ALL_PACKAGES } from '@sideline/rules/content';

/** Every scenario across all nine packages, in authored order. */
export const ALL_SCENARIOS: readonly Scenario[] = ALL_PACKAGES.flatMap((p) => p.scenarios);

const BY_ID: ReadonlyMap<string, Scenario> = new Map(ALL_SCENARIOS.map((s) => [s.id, s] as const));

/** `undefined` for an unknown id — a `custom_id` is untrusted input, and a
 * stale button from a since-renamed scenario must not throw. */
export const scenarioById = (id: string): Scenario | undefined => BY_ID.get(id);

/**
 * A random scenario, optionally restricted to one package.
 *
 * `rng` is injectable so tests are deterministic — the same affordance
 * `shuffle`/`buildPerms` expose in `@sideline/rules`. Returns `undefined`
 * only if the level filter matches nothing, which the caller surfaces
 * rather than silently falling back to a scenario from another package.
 */
export const pickScenario = (
  level: Level | undefined,
  rng: () => number = Math.random,
): Scenario | undefined => {
  const candidates =
    level === undefined ? ALL_SCENARIOS : ALL_SCENARIOS.filter((s) => s.level === level);
  if (candidates.length === 0) return undefined;
  return candidates[Math.floor(rng() * candidates.length)];
};
