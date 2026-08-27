#!/usr/bin/env node
/**
 * Every `@sideline/*` package an app imports must be declared in that app's
 * own `package.json`.
 *
 * **This exists because the failure it catches is invisible everywhere else.**
 * In the dev tree Node resolves upward through the monorepo's root
 * `node_modules`, so an undeclared workspace import works locally, in every
 * test, in `pnpm check`, and in the Docker *build* stage (which copies the
 * whole workspace). It only breaks in the production stage, where
 * `pnpm install --prod` symlinks *declared* dependencies and nothing else —
 * so the import throws `ERR_MODULE_NOT_FOUND`, the container dies before
 * binding its health port, and the platform keeps the OLD container serving.
 *
 * The result is a green pipeline and a silently un-deployed release. Observed
 * for real: `applications/server` imported `@sideline/rules` from v0.43.0
 * without declaring it, so production served v0.42.0 for three consecutive
 * releases while ops reported v0.44.0, and the entire rules-trainer API 404'd
 * in production for weeks. `applications/bot` then reproduced it exactly at
 * v0.36.0.
 *
 * Deliberately a source-text scan rather than a resolver: it must model what
 * the pruned image can see, not what the dev tree happens to resolve.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const APPS_DIR = 'applications';
const PACKAGES_DIR = 'packages';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

/** `@sideline/rules`, and also subpath imports like `@sideline/rules/content`. */
const IMPORT_PATTERN = /['"](@sideline\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g;

function sourceFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out = out.concat(sourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const workspaceNames = new Set(
  readdirSync(PACKAGES_DIR)
    .map((name) => {
      try {
        return readJson(join(PACKAGES_DIR, name, 'package.json')).name;
      } catch {
        return undefined;
      }
    })
    .filter((name) => typeof name === 'string'),
);

const problems = [];

for (const app of readdirSync(APPS_DIR)) {
  const manifestPath = join(APPS_DIR, app, 'package.json');
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    continue;
  }

  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);

  // Only runtime `src/` counts. Tests and configs run in the dev tree, which
  // resolves through the root `node_modules` — the pruned image never sees them.
  const imported = new Map();
  for (const file of sourceFiles(join(APPS_DIR, app, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_PATTERN)) {
      const pkg = match[1];
      if (!workspaceNames.has(pkg)) continue;
      if (!imported.has(pkg)) imported.set(pkg, file);
    }
  }

  for (const [pkg, firstUse] of imported) {
    if (!declared.has(pkg)) {
      problems.push({ app, pkg, firstUse, manifestPath });
    }
  }
}

if (problems.length > 0) {
  console.error('\nUndeclared workspace dependencies\n');
  for (const { app, pkg, firstUse, manifestPath } of problems) {
    console.error(`  ${app}: imports ${pkg} but does not declare it`);
    console.error(`    first used in : ${firstUse}`);
    console.error(`    fix           : add "${pkg}": "workspace:^" to ${manifestPath}\n`);
  }
  console.error(
    'This resolves in the dev tree and in the Docker build stage, but NOT in the\n' +
      'pruned production stage — the container would crash on startup and the\n' +
      'platform would silently keep serving the previous image.\n',
  );
  process.exit(1);
}

console.log(`workspace deps OK — every @sideline/* import is declared by its app`);
