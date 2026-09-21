#!/usr/bin/env node
/**
 * Asserts every migration id is unique, and that ids added on this branch
 * are above every id already merged to `origin/main`.
 *
 * Effect's `Migrator` aborts with `MigrationError { kind: 'Duplicates' }` when
 * two files share an id — and because migrations run in the integration
 * suite's `globalSetup`, that abort surfaces as:
 *
 *     No test files found, exiting with code 1
 *
 * which names neither migrations nor the colliding id. That cost a red main
 * and a log dig to identify. This turns it into one line at lint time.
 *
 * It happens easily: ids are hand-picked timestamps, so two branches opened
 * around the same time pick the same next number and only collide once both
 * have merged. Nothing in review catches it — each PR is individually fine.
 *
 * A second, quieter failure mode has now also happened in production once:
 * a migration id can fall below the *applied* waterline without ever
 * colliding with another filename. Effect's migrator skips a migration
 * whose id is at or below the highest already-applied id — silently, no
 * error, no log line (`node_modules/effect/dist/unstable/sql/Migrator.js`,
 * `if (currentId <= latestMigrationId) continue;`). A migration id reserved
 * or written on a branch that sits open while `main` accumulates higher ids
 * from other merges can end up below that waterline the moment it lands,
 * and nothing about the merge itself fails — the migration is just never
 * run again. This is exactly what happened to
 * `1791800000_series_time_is_team_local.ts`: it was renumbered to
 * `1792100000` after production had already applied migrations past it.
 * The check below catches this before merge by requiring every id added on
 * a branch to be strictly greater than every id already on `origin/main`.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIRS = ['before', 'after'];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(REPO_ROOT, 'packages/migrations/src');

let failed = false;

/**
 * Filenames (not full paths) already present on `origin/main`, per migration
 * directory — or `null` if `origin/main` could not be resolved (shallow
 * clone, no remote, detached checkout, ...), in which case the monotonicity
 * check is skipped entirely and only uniqueness is enforced.
 */
function getMainBaseline() {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'origin/main'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch {
    return null;
  }

  const baseline = new Map();
  for (const dir of DIRS) {
    let out;
    try {
      out = execFileSync(
        'git',
        ['ls-tree', '-r', '--name-only', 'origin/main', `packages/migrations/src/${dir}`],
        { cwd: REPO_ROOT },
      ).toString();
    } catch {
      return null;
    }
    const files = new Set(
      out
        .split('\n')
        .filter(Boolean)
        .map((p) => p.split('/').pop()),
    );
    baseline.set(dir, files);
  }
  return baseline;
}

const mainBaseline = getMainBaseline();
if (mainBaseline === null) {
  console.log('origin/main not resolvable — skipping migration-id monotonicity check');
}

for (const dir of DIRS) {
  let files;
  try {
    files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.ts'));
  } catch {
    continue; // an optional phase directory that does not exist
  }

  const byId = new Map();
  for (const file of files) {
    const id = file.split('_')[0];
    if (!/^\d+$/.test(id ?? '')) {
      console.error(`${dir}/${file} — filename must start with a numeric id`);
      failed = true;
      continue;
    }
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }

  for (const [id, group] of byId) {
    if (group.length > 1) {
      console.error(`duplicate migration id ${id} in ${dir}/:`);
      for (const f of group.sort()) console.error(`  ${f}`);
      const next = String(Math.max(...[...byId.keys()].map(Number)) + 100000);
      console.error(`  → renumber all but one; the next free id is ${next}`);
      failed = true;
    }
  }

  if (mainBaseline !== null) {
    const baselineFiles = mainBaseline.get(dir) ?? new Set();
    const baselineIds = files
      .filter((f) => baselineFiles.has(f))
      .map((f) => Number(f.split('_')[0]))
      .filter((n) => !Number.isNaN(n));
    const maxBaselineId = baselineIds.length > 0 ? Math.max(...baselineIds) : 0;

    for (const file of files.filter((f) => !baselineFiles.has(f))) {
      const id = Number(file.split('_')[0]);
      if (Number.isNaN(id) || id > maxBaselineId) continue;
      console.error(
        `${dir}/${file} — id ${id} is not above the highest id already on origin/main (${maxBaselineId})`,
      );
      console.error(
        '  → ids at or below the highest already-merged id are skipped silently by the migrator, with no error and no log line',
      );
      console.error(`  → next safe id: ${maxBaselineId + 100000}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log(
  `migration ids OK — every id is unique${mainBaseline === null ? '' : ' and above origin/main'}`,
);
