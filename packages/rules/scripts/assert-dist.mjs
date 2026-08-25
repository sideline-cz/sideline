#!/usr/bin/env node
/**
 * `postbuild` — hard-fails the build when `tsc -b` trusted a stale
 * `.tsbuildinfo` and skipped re-copying the JSON content into `dist/`.
 *
 * Repro this guards against: delete `dist/content/**\/*.json`, then run
 * `tsc -b tsconfig.build.json && tsc-alias -p tsconfig.build.json` again with
 * nothing else changed — it exits 0 and leaves `dist/content/` empty,
 * because `tsc -b` only re-emits files it thinks changed. Node then throws
 * `ERR_MODULE_NOT_FOUND` the moment anything imports `@sideline/rules/content`
 * or a `PACKAGE_LOADERS` entry — at server boot, not at build time.
 * `tsconfig.base.json` also sets `noEmitOnError: false`, so a real compile
 * error would not have failed `pnpm build` either.
 *
 * This script is the only thing that actually runs the built output: it
 * checks every expected JSON file exists under `dist/content/`, then
 * imports `dist/content.js` for real and counts scenarios — which also
 * smoke-tests the `with { type: 'json' }` import attributes (no compile
 * error catches a missing one; only a real `node` run does, per
 * `packages/rules/AGENTS.md`).
 */
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(scriptDir, '..', 'dist');

const PACKAGE_FILES = [
  '01-pull.json',
  '02-marking.json',
  '03-receiving.json',
  '04-thrower-marker.json',
  '05-travel.json',
  '06-picks.json',
  '07-stall-count.json',
  '08-out-of-bounds.json',
  '09-stoppages.json',
];

const EXPECTED_SCENARIO_COUNT = 109;

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const expectedFiles = [
    ...PACKAGE_FILES.map((f) => path.join(distDir, 'content', 'packages', f)),
    path.join(distDir, 'content', 'rules.json'),
    path.join(distDir, 'content', 'signals.json'),
  ];

  const missing = [];
  for (const file of expectedFiles) {
    if (!(await fileExists(file))) missing.push(path.relative(distDir, file));
  }
  if (missing.length > 0) {
    throw new Error(
      `postbuild: missing from dist/ — ${missing.join(', ')}. ` +
        `'tsc -b' likely trusted a stale .tsbuildinfo and skipped re-copying JSON. ` +
        `Try: find . -name '*.tsbuildinfo' -delete && pnpm build`,
    );
  }

  const contentUrl = new URL('../dist/content.js', import.meta.url).href;
  const { ALL_PACKAGES } = await import(contentUrl);
  const scenarioCount = ALL_PACKAGES.reduce((n, pkg) => n + pkg.scenarios.length, 0);
  if (scenarioCount !== EXPECTED_SCENARIO_COUNT) {
    throw new Error(
      `postbuild: expected ${EXPECTED_SCENARIO_COUNT} scenarios across ALL_PACKAGES in ` +
        `dist/content.js, got ${scenarioCount}.`,
    );
  }

  console.log(
    `postbuild: dist/content verified (${ALL_PACKAGES.length} packages, ${scenarioCount} scenarios)`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
